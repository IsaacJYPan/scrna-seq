'use strict';

// Agent sandboxes (docs/spec.md phase 4, isolated development).
//
// A person defines a sandbox: which of their analysis objects an agent may read
// (pinned by checkpoint digest), plus run and compute budgets. The agent then
// submits its own R scripts. Each script runs once as an Expert R job in the
// ephemeral container: no network, a read-only copy of the pinned input, no
// project storage mount, bounded outputs. The outputs become a new draft
// result; nothing that already exists is changed. A person reviews each draft
// and promotes or discards it.

const crypto = require('crypto');
const { READ_ROLES, WRITE_ROLES, MANAGE_ROLES, codedError } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('../automation/automationAudit');
const { validateExpertRParams, expertRSandboxEnabled, EXPERT_R_PROFILE } = require('../expertR');
const { expertRAccessSql } = require('../expertRAccess');
const { installationLimits } = require('../resourceAdmission/admission');
const { readBundleFile, fileKind } = require('./bundleFiles');
const { readableSteps } = require('../../shared/readableR.mjs');

const SANDBOX_ID = /^sbx_[0-9a-f]{24}$/;
const RUN_ID = /^sbr_[0-9a-f]{24}$/;
const OBJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_INPUTS = 10;
// The Expert R container's default limits: 2 CPUs for at most 15 minutes.
const RUN_CPU_SECONDS = 2 * 900;
const NON_TERMINAL = ['created', 'queued', 'running', 'waiting_for_user'];
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function requireHuman(actor) {
  if (actor?.kind !== 'human') throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
}

function rejectUnknown(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
  }
}

function intInRange(value, field, min, max, fallback) {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw codedError('INVALID_INPUT', `${field} must be an integer from ${min} to ${max}.`, 400);
  }
  return n;
}

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function runState(row) {
  const cancel = Boolean(row.cancel_requested_at);
  switch (row.job_status) {
    case 'created':
    case 'queued': return cancel ? 'cancel_requested' : 'queued';
    case 'running':
    case 'waiting_for_user': return cancel ? 'cancel_requested' : 'running';
    case 'completed': {
      const late = row.delegation_revoked_at && row.completed_at
        && new Date(row.delegation_revoked_at) < new Date(row.completed_at);
      if (!row.bundle_id || cancel || late) return 'quarantined';
      return 'draft_ready';
    }
    case 'failed': return 'failed';
    case 'canceled': return 'canceled';
    default: return 'unknown';
  }
}

const RUN_SELECT = `
  SELECT sr.*, j.status AS job_status, j.started_at, j.completed_at, j.canceled_at, j.result_analysis_object_id,
         j.parameters_json, j.logs_json, j.error_json, ad.revoked_at AS delegation_revoked_at,
         ap.display_name AS agent_display_name, sb.name AS sandbox_name, sb.created_by_user_id AS sandbox_owner_id,
         b.id AS bundle_id, b.storage_uri AS bundle_storage_uri, b.checksum_sha256 AS bundle_checksum,
         b.size_bytes AS bundle_size, b.metadata_json AS bundle_metadata
    FROM agent_sandbox_runs sr
    JOIN jobs j ON j.id = sr.job_id
    JOIN agent_delegations ad ON ad.id = sr.delegation_id
    JOIN agent_principals ap ON ap.id = sr.agent_principal_id
    JOIN agent_sandboxes sb ON sb.id = sr.sandbox_id
    LEFT JOIN LATERAL (SELECT a.* FROM job_artifacts a WHERE a.job_id = j.id AND a.artifact_type = 'expert_r_bundle'
                        AND a.status = 'available' ORDER BY a.created_at, a.id LIMIT 1) b ON TRUE`;

function bundleOf(row) {
  if (!row.bundle_id) return null;
  const metadata = parseJson(row.bundle_metadata, {});
  return {
    id: row.bundle_id,
    internalStorageKey: row.bundle_storage_uri,
    checksumSha256: row.bundle_checksum,
    sizeBytes: Number(row.bundle_size),
    files: Array.isArray(metadata.files) ? metadata.files : [],
  };
}

function publicRun(row, { includeScript = true } = {}) {
  const state = runState(row);
  const parameters = parseJson(row.parameters_json, {});
  const bundle = state === 'draft_ready' ? bundleOf(row) : null;
  const logs = require('../runMonitoring').projectLogs(parseJson(row.logs_json, [])).items;
  const failure = parseJson(row.error_json, null);
  const { safeError } = require('../runMonitoring');
  return {
    id: row.id,
    projectId: row.project_id,
    sandboxId: row.sandbox_id,
    sandboxName: row.sandbox_name,
    runNumber: row.run_number,
    title: row.title,
    agent: { principalId: row.agent_principal_id, displayName: row.agent_display_name },
    sponsorUserId: Number(row.sponsor_user_id),
    delegationId: row.delegation_id,
    requestId: row.request_id,
    inputAnalysisObjectId: row.input_analysis_object_id,
    scriptSha256: row.script_sha256,
    ...(includeScript && typeof parameters.script === 'string' ? {
      script: parameters.script,
      steps: readableSteps(parameters.script),
    } : {}),
    state,
    jobStatus: row.job_status,
    reservedCpuSeconds: Number(row.reserved_cpu_seconds),
    files: bundle ? bundle.files.map((file) => ({
      name: file.name, sizeBytes: file.sizeBytes, checksumSha256: file.checksumSha256,
      kind: fileKind(file.name)?.kind || 'other',
    })) : [],
    resultAnalysisObjectId: state === 'draft_ready' ? row.result_analysis_object_id || null : null,
    console: logs.filter((entry) => entry.message.startsWith('R console')).map((entry) => entry.message).slice(-2),
    error: state === 'failed' && failure ? safeError(failure) : null,
    review: { state: row.review_state, reviewedAt: row.reviewed_at, note: row.review_note, branchId: row.promoted_branch_id || null },
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function publicSandbox(row, runs = null) {
  return {
    id: row.id,
    projectId: row.project_id,
    createdByUserId: Number(row.created_by_user_id),
    name: row.name,
    objective: row.objective,
    inputs: row.inputs_json,
    maxRuns: row.max_runs,
    maxOutstandingRuns: row.max_outstanding_runs,
    maxCpuSeconds: Number(row.max_cpu_seconds),
    cpuSecondsPerRun: RUN_CPU_SECONDS,
    status: row.status,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    runtime: {
      profileId: EXPERT_R_PROFILE.id,
      packages: [...EXPERT_R_PROFILE.packages],
      network: 'none',
      input: 'read-only copy of the pinned analysis object, available as `obj` (a Seurat object)',
      helpers: ['write_table(df, "name.csv")', 'save_figure(plot, "name.png")', 'save_workspace(value, "name.rds")',
        'read_input(name)'],
      outputLimits: { files: 50, totalBytes: 200 * 1024 * 1024 },
      style: 'Split the script into steps with "# ---- Step name ----" lines. The review screen shows each step, with error handling hidden.',
    },
    ...(runs ? { runs } : {}),
  };
}

function createSandboxService({ db, withTransaction, provider, getEnvironment }) {
  const resolveEnvironment = getEnvironment || (() => require('../expertSandboxClient').getExpertREnvironment());

  async function create(actor, projectId, body = {}) {
    requireHuman(actor);
    rejectUnknown(body, ['name', 'objective', 'analysisObjectIds', 'maxRuns', 'maxOutstandingRuns', 'maxCpuSeconds']);
    await db.requireProjectRole(actor.userId, projectId, WRITE_ROLES);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 200) throw codedError('INVALID_INPUT', 'name must be 1-200 characters.', 400);
    const objective = body.objective === undefined ? '' : String(body.objective).slice(0, 4000);
    const ids = body.analysisObjectIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_INPUTS || new Set(ids).size !== ids.length
        || !ids.every((id) => typeof id === 'string' && OBJECT_ID.test(id))) {
      throw codedError('INVALID_INPUT', `Choose 1-${MAX_INPUTS} distinct analyses for the sandbox.`, 400);
    }
    const maxRuns = intInRange(body.maxRuns, 'maxRuns', 1, 500, 20);
    const maxOutstandingRuns = intInRange(body.maxOutstandingRuns, 'maxOutstandingRuns', 1, 5, 1);
    const maxCpuSeconds = intInRange(body.maxCpuSeconds, 'maxCpuSeconds', RUN_CPU_SECONDS, 100000000, maxRuns * RUN_CPU_SECONDS);
    const inputs = [];
    for (const id of ids) {
      const { rows } = await db.query(
        'SELECT id, owner_user_id, display_name, object_type FROM analysis_objects WHERE id = $1 AND project_id = $2',
        [id, String(projectId)]);
      // Expert R reads only the runner's own objects; the sandbox runs as its creator.
      if (!rows[0] || Number(rows[0].owner_user_id) !== Number(actor.userId)) {
        throw codedError('NOT_FOUND', 'Analysis not found among your analyses in this project.', 404);
      }
      let checkpoint;
      try { checkpoint = await db.resolveCheckpointArtifact(id, String(projectId)); } catch {
        throw codedError('INPUT_NOT_APPLICABLE', 'That analysis has no saved version the sandbox can read. Save it first.', 409);
      }
      inputs.push({
        analysisObjectId: id,
        displayName: rows[0].display_name || null,
        checkpointArtifactId: checkpoint.checkpointArtifactId,
        checkpointSha256: checkpoint.checksumSha256,
      });
    }
    const id = `sbx_${crypto.randomBytes(12).toString('hex')}`;
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO agent_sandboxes (id, project_id, created_by_user_id, name, objective, inputs_json, max_runs,
           max_outstanding_runs, max_cpu_seconds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, String(projectId), actor.userId, name, objective, JSON.stringify(inputs), maxRuns, maxOutstandingRuns, maxCpuSeconds]);
      await recordAutomationEvent(client, {
        projectId, actor, action: 'sandbox.created', decision: 'allowed', targetType: 'sandbox', targetId: id,
      });
    });
    return getForHuman(actor, projectId, id);
  }

  async function sandboxRow(runner, projectId, sandboxId, { lock = false } = {}) {
    if (!SANDBOX_ID.test(String(sandboxId))) return null;
    const { rows } = await runner.query(
      `SELECT * FROM agent_sandboxes WHERE id = $1 AND project_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [sandboxId, String(projectId)]);
    return rows[0] || null;
  }

  async function listForHuman(actor, projectId) {
    requireHuman(actor);
    await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const { rows } = await db.query(
      `SELECT sb.*, (SELECT COUNT(*)::int FROM agent_sandbox_runs sr WHERE sr.sandbox_id = sb.id) AS run_count,
              (SELECT COUNT(*)::int FROM agent_sandbox_runs sr JOIN jobs j ON j.id = sr.job_id
                WHERE sr.sandbox_id = sb.id AND sr.review_state = 'draft' AND j.status = 'completed') AS drafts
         FROM agent_sandboxes sb WHERE sb.project_id = $1 ORDER BY sb.created_at DESC, sb.id DESC LIMIT 200`,
      [String(projectId)]);
    return {
      schema: 'traceomics.agent-sandboxes.v1',
      sandboxes: rows.map((row) => ({ ...publicSandbox(row), runCount: row.run_count, draftsAwaitingReview: row.drafts })),
    };
  }

  // Sandbox runs execute as the sandbox's creator, so their outputs are that
  // person's private Expert R results. The creator and project owners/admins
  // review them.
  async function requireReviewer(actor, projectId, sandbox, roles = READ_ROLES) {
    const membership = await db.requireProjectRole(actor.userId, projectId, roles);
    if (Number(sandbox.created_by_user_id) !== Number(actor.userId) && !MANAGE_ROLES.includes(membership.role)) {
      throw codedError('NOT_FOUND', 'Sandbox not found.', 404);
    }
    return membership;
  }

  async function getForHuman(actor, projectId, sandboxId) {
    requireHuman(actor);
    const sandbox = await sandboxRow(db, projectId, sandboxId);
    if (!sandbox) throw codedError('NOT_FOUND', 'Sandbox not found.', 404);
    await requireReviewer(actor, projectId, sandbox);
    const { rows } = await db.query(`${RUN_SELECT} WHERE sr.sandbox_id = $1 ORDER BY sr.run_number DESC LIMIT 500`, [sandbox.id]);
    return { schema: 'traceomics.agent-sandbox.v1', sandbox: publicSandbox(sandbox, rows.map((row) => publicRun(row))) };
  }

  async function close(actor, projectId, sandboxId) {
    requireHuman(actor);
    return withTransaction(async (client) => {
      const sandbox = await sandboxRow(client, projectId, sandboxId, { lock: true });
      if (!sandbox) throw codedError('NOT_FOUND', 'Sandbox not found.', 404);
      await requireReviewer(actor, projectId, sandbox, WRITE_ROLES);
      if (sandbox.status === 'open') {
        await client.query(
          "UPDATE agent_sandboxes SET status = 'closed', closed_at = now(), closed_by_user_id = $2 WHERE id = $1",
          [sandbox.id, actor.userId]);
        await recordAutomationEvent(client, {
          projectId, actor, action: 'sandbox.closed', decision: 'allowed', targetType: 'sandbox', targetId: sandbox.id,
        });
      }
      const { rows } = await client.query('SELECT * FROM agent_sandboxes WHERE id = $1', [sandbox.id]);
      return { schema: 'traceomics.agent-sandbox.v1', sandbox: publicSandbox(rows[0]) };
    });
  }

  async function runForHuman(actor, projectId, runId) {
    requireHuman(actor);
    if (!RUN_ID.test(String(runId))) throw codedError('NOT_FOUND', 'Run not found.', 404);
    const { rows } = await db.query(`${RUN_SELECT} WHERE sr.id = $1 AND sr.project_id = $2`, [runId, String(projectId)]);
    if (!rows[0]) throw codedError('NOT_FOUND', 'Run not found.', 404);
    const sandbox = await sandboxRow(db, projectId, rows[0].sandbox_id);
    const membership = await requireReviewer(actor, projectId, sandbox);
    return { row: rows[0], sandbox, membership };
  }

  async function reviewRun(actor, projectId, runId, body = {}) {
    rejectUnknown(body, ['decision', 'note']);
    if (!['promoted', 'discarded'].includes(body.decision)) {
      throw codedError('INVALID_INPUT', 'decision must be promoted or discarded.', 400);
    }
    const note = body.note === undefined ? null : String(body.note).slice(0, 2000);
    const { row } = await runForHuman(actor, projectId, runId);
    await db.requireProjectRole(actor.userId, projectId, WRITE_ROLES);
    const state = runState(row);
    if (body.decision === 'promoted' && state !== 'draft_ready') {
      throw codedError('RESULT_NOT_ACCEPTABLE', `A ${state} run cannot be promoted.`, 409);
    }
    if (row.review_state !== 'draft') throw codedError('ALREADY_REVIEWED', `This run was already ${row.review_state}.`, 409);
    // Promoting publishes the draft result as a project branch, which is how
    // a private Expert R result becomes visible to the rest of the project.
    // The branch belongs to the sponsor, who owns the result.
    let branchId = null;
    if (body.decision === 'promoted') {
      const branches = require('../analysisBranches');
      // eslint-disable-next-line no-control-regex -- deliberately strips control characters
      const name = `Agent run ${row.run_number}: ${row.title}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80).trim();
      const branch = await branches.createBranch(Number(row.sponsor_user_id), projectId, {
        name, baseAnalysisObjectId: row.result_analysis_object_id,
        description: `Promoted from sandbox ${row.sandbox_name} (run ${row.id}).`.slice(0, 1000),
      });
      await branches.publishBranch(Number(row.sponsor_user_id), projectId, branch.id);
      branchId = branch.id;
    }
    return withTransaction(async (client) => {
      const { rows } = await client.query('SELECT review_state FROM agent_sandbox_runs WHERE id = $1 FOR UPDATE', [row.id]);
      if (rows[0].review_state !== 'draft') {
        throw codedError('ALREADY_REVIEWED', `This run was already ${rows[0].review_state}.`, 409);
      }
      await client.query(
        `UPDATE agent_sandbox_runs SET review_state = $2, reviewed_at = now(), reviewed_by_user_id = $3, review_note = $4,
           promoted_branch_id = $5 WHERE id = $1`, [row.id, body.decision, actor.userId, note, branchId]);
      await recordAutomationEvent(client, {
        projectId, actor, action: `sandbox-run.${body.decision}`, decision: 'allowed', targetType: 'sandbox_run', targetId: row.id,
      });
      const { rows: updated } = await client.query(`${RUN_SELECT} WHERE sr.id = $1`, [row.id]);
      return { schema: 'traceomics.agent-sandbox-run.v1', run: publicRun(updated[0]) };
    });
  }

  async function readFile(row, name, { maxBytes }) {
    if (runState(row) !== 'draft_ready') throw codedError('NOT_FOUND', 'File not found.', 404);
    const bundle = bundleOf(row);
    if (!bundle || !provider) throw codedError('NOT_FOUND', 'File not found.', 404);
    return readBundleFile(provider, bundle, String(name), { maxBytes });
  }

  async function fileForHuman(actor, projectId, runId, name) {
    const { row } = await runForHuman(actor, projectId, runId);
    return readFile(row, name, { maxBytes: 20 * 1024 * 1024 });
  }

  // ── Agent side ────────────────────────────────────────────────────────────
  async function agentSandboxRow(runner, actor, sandboxId, { lock = false } = {}) {
    const sandbox = await sandboxRow(runner, actor.delegation.projectId, sandboxId, { lock });
    if (!sandbox || Number(sandbox.created_by_user_id) !== Number(actor.sponsorUserId)) {
      throw codedError('NOT_FOUND', 'Sandbox not found.', 404);
    }
    return sandbox;
  }

  async function listForAgent(actor) {
    const { rows } = await db.query(
      `SELECT * FROM agent_sandboxes WHERE project_id = $1 AND created_by_user_id = $2 AND status = 'open'
        ORDER BY created_at DESC LIMIT 100`, [actor.delegation.projectId, actor.sponsorUserId]);
    return rows.map((row) => publicSandbox(row));
  }

  async function getForAgent(actor, sandboxId) {
    const sandbox = await agentSandboxRow(db, actor, sandboxId);
    const { rows } = await db.query(
      `${RUN_SELECT} WHERE sr.sandbox_id = $1 AND sr.delegation_id = $2 ORDER BY sr.run_number DESC LIMIT 200`,
      [sandbox.id, actor.delegation.id]);
    return publicSandbox(sandbox, rows.map((row) => publicRun(row, { includeScript: false })));
  }

  async function submitRun(actor, sandboxId, body = {}) {
    rejectUnknown(body, ['requestId', 'title', 'script', 'inputAnalysisObjectId']);
    if (!REQUEST_ID.test(String(body.requestId))) {
      throw codedError('INVALID_REQUEST_ID', 'requestId must be 8-80 letters, digits, "-" or "_".', 400);
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 200) throw codedError('INVALID_INPUT', 'title must be 1-200 characters.', 400);
    let validated;
    try {
      validated = validateExpertRParams({ profileId: EXPERT_R_PROFILE.id, script: body.script, inputIds: [] });
    } catch (error) {
      throw codedError('INVALID_SCRIPT', error.message, 400);
    }
    const requestSha256 = crypto.createHash('sha256')
      .update(JSON.stringify([String(sandboxId), title, validated.scriptSha256, body.inputAnalysisObjectId ?? null])).digest('hex');

    // Replays return the original run before any other check.
    const prior = await db.query(
      'SELECT id, request_sha256 FROM agent_sandbox_runs WHERE delegation_id = $1 AND request_id = $2',
      [actor.delegation.id, body.requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== requestSha256) {
        throw codedError('IDEMPOTENCY_CONFLICT', 'This requestId was already used for a different submission.', 409);
      }
      const { rows } = await db.query(`${RUN_SELECT} WHERE sr.id = $1`, [prior.rows[0].id]);
      return { run: publicRun(rows[0]), replayed: true };
    }

    if (!expertRSandboxEnabled() || require('../config').demoMode()) {
      throw codedError('TARGET_UNQUALIFIED', 'The isolated R sandbox is not enabled on this installation.', 409);
    }
    let parameters;
    try {
      const manifest = await resolveEnvironment();
      parameters = require('../rEnvironment').pinExpertREnvironment(validated.params, manifest);
    } catch {
      throw codedError('SERVICE_UNAVAILABLE', 'The isolated R environment could not be verified. Retry later.', 503);
    }
    const stored = { ...parameters, scriptSha256: validated.scriptSha256 };

    return withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('traceomics-agent-admission'))");
      const { rows: live } = await client.query(
        `SELECT d.id FROM agent_delegations d JOIN agent_principals p ON p.id = d.agent_principal_id
          WHERE d.id = $1 AND d.revoked_at IS NULL AND d.expires_at > now() AND p.status = 'active' FOR UPDATE OF d`,
        [actor.delegation.id]);
      if (!live[0]) throw codedError('AGENT_CREDENTIAL_INVALID', 'The agent credential is not valid.', 401);
      const again = await client.query(
        'SELECT id, request_sha256 FROM agent_sandbox_runs WHERE delegation_id = $1 AND request_id = $2',
        [actor.delegation.id, body.requestId]);
      if (again.rows[0]) {
        if (again.rows[0].request_sha256 !== requestSha256) {
          throw codedError('IDEMPOTENCY_CONFLICT', 'This requestId was already used for a different submission.', 409);
        }
        const { rows } = await client.query(`${RUN_SELECT} WHERE sr.id = $1`, [again.rows[0].id]);
        return { run: publicRun(rows[0]), replayed: true };
      }
      const sandbox = await agentSandboxRow(client, actor, sandboxId, { lock: true });
      if (sandbox.status !== 'open') throw codedError('SANDBOX_CLOSED', 'This sandbox is closed.', 409);
      const inputs = sandbox.inputs_json;
      const inputId = body.inputAnalysisObjectId === undefined ? inputs[0].analysisObjectId : body.inputAnalysisObjectId;
      const input = inputs.find((entry) => entry.analysisObjectId === inputId);
      if (!input) throw codedError('STUDY_AMENDMENT_REQUIRED', 'That analysis is not an input of this sandbox.', 409);

      const { rows: member } = await client.query(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR SHARE',
        [actor.delegation.projectId, actor.sponsorUserId]);
      if (!member[0] || !WRITE_ROLES.includes(member[0].role)) {
        throw codedError('SCOPE_DENIED', 'The sponsor can no longer run analyses in this project.', 403);
      }
      const { rows: access } = await client.query(`SELECT 1 WHERE ${expertRAccessSql('$1', '$2')}`,
        [actor.sponsorUserId, actor.delegation.projectId]);
      if (!access[0]) throw codedError('SCOPE_DENIED', "The sponsor's account is not approved for isolated R.", 403);
      const { rows: objects } = await client.query(
        'SELECT owner_user_id FROM analysis_objects WHERE id = $1 AND project_id = $2', [input.analysisObjectId, sandbox.project_id]);
      let checkpoint = null;
      if (objects[0] && Number(objects[0].owner_user_id) === Number(actor.sponsorUserId)) {
        checkpoint = await db.resolveCheckpointArtifact(input.analysisObjectId, sandbox.project_id).catch(() => null);
      }
      if (!checkpoint || checkpoint.checksumSha256 !== input.checkpointSha256) {
        throw codedError('INPUT_CHANGED', 'The pinned input version is no longer available.', 409);
      }

      const limits = installationLimits();
      const policy = actor.delegation.policy;
      const outstandingJob = 'job_id IN (SELECT id FROM jobs WHERE status = ANY($2::text[]))';
      const { rows: [counts] } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM agent_runs WHERE ${outstandingJob})
             + (SELECT COUNT(*)::int FROM agent_sandbox_runs WHERE ${outstandingJob}) AS installation_outstanding,
           (SELECT COUNT(*)::int FROM agent_runs WHERE sponsor_user_id = $3 AND ${outstandingJob})
             + (SELECT COUNT(*)::int FROM agent_sandbox_runs WHERE sponsor_user_id = $3 AND ${outstandingJob}) AS sponsor_outstanding,
           (SELECT COUNT(*)::int FROM agent_runs WHERE delegation_id = $1 AND ${outstandingJob})
             + (SELECT COUNT(*)::int FROM agent_sandbox_runs WHERE delegation_id = $1 AND ${outstandingJob}) AS delegation_outstanding,
           (SELECT COALESCE(SUM(reserved_cpu_seconds), 0)::bigint FROM agent_runs WHERE delegation_id = $1)
             + (SELECT COALESCE(SUM(reserved_cpu_seconds), 0)::bigint FROM agent_sandbox_runs WHERE delegation_id = $1) AS delegation_cpu,
           (SELECT COUNT(*)::int FROM agent_sandbox_runs WHERE sandbox_id = $4) AS sandbox_runs,
           (SELECT COUNT(*)::int FROM agent_sandbox_runs WHERE sandbox_id = $4 AND ${outstandingJob}) AS sandbox_outstanding,
           (SELECT COALESCE(SUM(reserved_cpu_seconds), 0)::bigint FROM agent_sandbox_runs WHERE sandbox_id = $4) AS sandbox_cpu`,
        [actor.delegation.id, NON_TERMINAL, actor.sponsorUserId, sandbox.id]);
      const over = (scope, message) => {
        const error = codedError('BUDGET_EXCEEDED', message, 429);
        error.details = { budget: scope };
        return error;
      };
      if (counts.installation_outstanding >= limits.maxOutstandingRuns) throw over('installation', 'The installation is at its limit of active agent runs.');
      if (counts.sponsor_outstanding >= limits.maxOutstandingRunsPerSponsor) throw over('sponsor', "The sponsor's agents are at their limit of active runs.");
      if (counts.delegation_outstanding >= policy.maxOutstandingRuns) throw over('delegation', 'This agent is at its limit of active runs.');
      if (Number(counts.delegation_cpu) + RUN_CPU_SECONDS > policy.maxReservedCpuSeconds) throw over('delegation-compute', "This agent's compute budget is exhausted.");
      if (counts.sandbox_runs >= sandbox.max_runs) throw over('sandbox-runs', 'This sandbox has used all of its runs.');
      if (counts.sandbox_outstanding >= sandbox.max_outstanding_runs) throw over('sandbox-outstanding', 'This sandbox is at its limit of active runs.');
      if (Number(counts.sandbox_cpu) + RUN_CPU_SECONDS > Number(sandbox.max_cpu_seconds)) throw over('sandbox-compute', "This sandbox's compute budget is exhausted.");

      const jobId = db.genId('job');
      await client.query(
        `INSERT INTO jobs (id, owner_user_id, project_id, analysis_object_id, job_type, status, parameters_json, max_attempts)
         VALUES ($1, $2, $3, $4, 'expert.r.v1', $5, $6, 1)`,
        [jobId, actor.sponsorUserId, sandbox.project_id, input.analysisObjectId, db.INITIAL_JOB_STATUS, JSON.stringify(stored)]);
      await client.query(
        `INSERT INTO execution_source_versions (id, project_id, owner_user_id, job_id, language, source_code, source_sha256)
         VALUES ($1, $2, $3, $4, 'R', $5, $6)`,
        [`src_${jobId}`, sandbox.project_id, actor.sponsorUserId, jobId, stored.script, stored.scriptSha256]);
      const runId = `sbr_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO agent_sandbox_runs (id, project_id, sandbox_id, delegation_id, agent_principal_id, sponsor_user_id,
           credential_id, request_id, request_sha256, job_id, run_number, title, script_sha256, input_analysis_object_id,
           reserved_cpu_seconds) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [runId, sandbox.project_id, sandbox.id, actor.delegation.id, actor.principalId, actor.sponsorUserId,
          actor.credentialId, body.requestId, requestSha256, jobId, counts.sandbox_runs + 1, title,
          stored.scriptSha256, input.analysisObjectId, RUN_CPU_SECONDS]);
      await recordAutomationEvent(client, {
        projectId: sandbox.project_id, actor, action: 'sandbox-run.admitted', decision: 'allowed',
        targetType: 'sandbox_run', targetId: runId, requestId: body.requestId,
      });
      const { rows } = await client.query(`${RUN_SELECT} WHERE sr.id = $1`, [runId]);
      return { run: publicRun(rows[0]), replayed: false };
    });
  }

  async function agentRunRow(actor, runId) {
    if (!RUN_ID.test(String(runId))) throw codedError('NOT_FOUND', 'Run not found.', 404);
    const { rows } = await db.query(`${RUN_SELECT} WHERE sr.id = $1 AND sr.delegation_id = $2`, [runId, actor.delegation.id]);
    if (!rows[0]) throw codedError('NOT_FOUND', 'Run not found.', 404);
    return rows[0];
  }

  async function getRunForAgent(actor, runId) {
    return publicRun(await agentRunRow(actor, runId));
  }

  async function fileForAgent(actor, runId, name) {
    const row = await agentRunRow(actor, runId);
    const kind = fileKind(String(name));
    return readFile(row, name, { maxBytes: kind?.kind === 'image' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES });
  }

  async function cancelForAgent(actor, runId) {
    const row = await agentRunRow(actor, runId);
    await withTransaction(async (client) => {
      const { rows: jobs } = await client.query('SELECT status FROM jobs WHERE id = $1 FOR UPDATE', [row.job_id]);
      if (!NON_TERMINAL.includes(jobs[0]?.status)) return;
      const { rows } = await client.query('SELECT cancel_requested_at FROM agent_sandbox_runs WHERE id = $1 FOR UPDATE', [row.id]);
      if (!rows[0].cancel_requested_at) {
        await client.query('UPDATE agent_sandbox_runs SET cancel_requested_at = now() WHERE id = $1', [row.id]);
        await recordAutomationEvent(client, {
          projectId: row.project_id, actor, action: 'sandbox-run.cancel-requested', decision: 'allowed',
          targetType: 'sandbox_run', targetId: row.id,
        });
      }
      await client.query(
        `UPDATE jobs SET status = 'canceled', canceled_at = now(), updated_at = now(), claim_token = NULL,
           lease_expires_at = NULL,
           logs_json = (logs_json::jsonb || '[{"level":"info","message":"Canceled by the delegated agent."}]'::jsonb)::text
         WHERE id = $1 AND status IN ('created', 'queued')`, [row.job_id]);
    });
    return getRunForAgent(actor, runId);
  }

  return {
    create, listForHuman, getForHuman, close, reviewRun, fileForHuman,
    listForAgent, getForAgent, submitRun, getRunForAgent, fileForAgent, cancelForAgent,
    runForHuman,
  };
}

module.exports = { createSandboxService, runState, RUN_CPU_SECONDS };
