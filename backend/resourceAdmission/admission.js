'use strict';

// Plans, admission, cancellation, results, and acceptance for agent runs of
// approved workflow releases (docs/spec.md 11-13).
//
// Admission is one transaction: recheck authority, check every budget level,
// reserve, create the run receipt, and enqueue the job. A single advisory lock
// serializes agent admissions so concurrent agents cannot both take the last
// unit of any shared budget. Reservations are never refunded.

const crypto = require('crypto');
const { WRITE_ROLES, READ_ROLES, codedError } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('../automation/automationAudit');
const { canonicalJson, sha256, RESULT_ARTIFACT_TYPES } = require('../workflowTrust/catalog');
const { assertSupportedSeuratPipelineDataset } = require('../seuratPipeline');
const { assertSupportedSpatialSeuratDataset } = require('../spatialPipeline');
const { slurmConfig } = require('../executors/slurm');
const { boundedSummary, parseMetadata } = require('./summaries');

const PLAN_TTL_SECONDS = 3600;
const MAX_OPEN_PLANS_PER_DELEGATION = 20;
const NON_TERMINAL = ['created', 'queued', 'running', 'waiting_for_user'];
const PLAN_ID = /^plan_[0-9a-f]{24}$/;
const RUN_ID = /^run_[0-9a-f]{24}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function envLimit(name, fallback, max) {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n >= 0 && n <= max ? n : fallback;
}

function installationLimits() {
  return {
    maxOutstandingRuns: envLimit('AGENT_MAX_OUTSTANDING_RUNS', 4, 100),
    maxOutstandingRunsPerSponsor: envLimit('AGENT_MAX_OUTSTANDING_RUNS_PER_SPONSOR', 2, 100),
  };
}

function budgetError(scope, message) {
  const error = codedError('BUDGET_EXCEEDED', message, 429);
  error.details = { budget: scope };
  return error;
}

function rejectUnknown(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
  }
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function datasetForHandler(row) {
  return {
    projectId: row.project_id, fileType: row.file_type, uploadStatus: row.upload_status,
    validationStatus: row.validation_status, internalStorageKey: row.internal_storage_key,
  };
}

// Server-derived run state. Execution, technical validation, and scientific
// acceptance are separate facts (spec 12.2, 13.3).
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
      if (!(row.result_analysis_object_id || row.result_artifact_id) || cancel || late) return 'quarantined';
      return 'candidate_ready';
    }
    case 'failed': return 'failed';
    case 'canceled': return 'canceled';
    default: return 'unknown';
  }
}

const RUN_SELECT = `
  SELECT ar.*, j.status AS job_status, j.result_analysis_object_id, j.started_at, j.completed_at, j.canceled_at,
         ep.canonical_json, ad.revoked_at AS delegation_revoked_at, ap.display_name AS agent_display_name,
         se.accepted_run_id, se.name AS study_name,
         (SELECT a.id FROM job_artifacts a WHERE a.job_id = j.id AND a.artifact_type = ANY('${'{'}${RESULT_ARTIFACT_TYPES.join(',')}${'}'}'::text[])
           ORDER BY a.created_at, a.id LIMIT 1) AS result_artifact_id,
         EXISTS (SELECT 1 FROM result_acceptances ra WHERE ra.run_id = ar.id) AS ever_accepted
    FROM agent_runs ar
    JOIN jobs j ON j.id = ar.job_id
    JOIN execution_plans ep ON ep.id = ar.plan_id
    JOIN agent_delegations ad ON ad.id = ar.delegation_id
    JOIN agent_principals ap ON ap.id = ar.agent_principal_id
    JOIN study_envelopes se ON se.id = ar.study_id`;

function publicRun(row) {
  const plan = JSON.parse(row.canonical_json);
  const state = runState(row);
  return {
    id: row.id,
    projectId: row.project_id,
    studyId: row.study_id,
    studyName: row.study_name,
    trialNumber: row.trial_number,
    agent: { principalId: row.agent_principal_id, displayName: row.agent_display_name },
    sponsorUserId: Number(row.sponsor_user_id),
    delegationId: row.delegation_id,
    planId: row.plan_id,
    planDigest: row.plan_digest,
    requestId: row.request_id,
    release: plan.release,
    executionTarget: plan.executionTarget || 'local',
    inputs: plan.inputs,
    choices: plan.choices,
    state,
    jobStatus: row.job_status,
    reservation: {
      cpus: row.reserved_cpus, memoryMiB: row.reserved_memory_mib,
      maxWallSeconds: row.max_wall_seconds, cpuSeconds: Number(row.reserved_cpu_seconds),
    },
    resultAnalysisObjectId: state === 'candidate_ready' ? row.result_analysis_object_id || null : null,
    resultArtifactId: state === 'candidate_ready' ? row.result_artifact_id || null : null,
    acceptance: row.accepted_run_id === row.id ? 'accepted' : row.ever_accepted ? 'superseded' : 'none',
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    canceledAt: row.canceled_at,
  };
}

function createAdmissionService({ db, withTransaction, approvals }) {
  async function liveDelegation(client, actor, { lock = false } = {}) {
    const { rows } = await client.query(
      `SELECT d.id FROM agent_delegations d JOIN agent_principals p ON p.id = d.agent_principal_id
        WHERE d.id = $1 AND d.revoked_at IS NULL AND d.expires_at > now() AND p.status = 'active'
        ${lock ? 'FOR UPDATE OF d' : ''}`,
      [actor.delegation.id]
    );
    if (!rows[0]) throw codedError('AGENT_CREDENTIAL_INVALID', 'The agent credential is not valid.', 401);
  }

  async function studyForAgent(client, actor, studyId, { lock = false } = {}) {
    const { rows } = await client.query(
      `SELECT * FROM study_envelopes WHERE id = $1 AND project_id = $2 AND created_by_user_id = $3 ${lock ? 'FOR UPDATE' : ''}`,
      [String(studyId), actor.delegation.projectId, actor.sponsorUserId]
    );
    if (!rows[0]) throw codedError('NOT_FOUND', 'Study not found.', 404);
    if (rows[0].status !== 'open') throw codedError('STUDY_CLOSED', 'This study is closed.', 409);
    return rows[0];
  }

  async function approvedRelease(client, study) {
    const releases = await approvals.ensureCatalog();
    const release = releases.find((r) => r.id === study.release_id);
    const { rows } = await client.query(
      `SELECT wa.id FROM workflow_approvals wa JOIN workflow_releases wr ON wr.id = wa.release_id
        WHERE wa.id = $1 AND wa.revoked_at IS NULL AND wr.status = 'current' AND wa.release_digest = wr.digest`,
      [study.approval_id]
    );
    if (!release || !rows[0]) {
      throw codedError('RELEASE_NOT_APPROVED', 'The study workflow release is not currently approved.', 409);
    }
    return release;
  }

  async function pinnedInput(client, study, datasetId, release) {
    const input = study.inputs_json.find((entry) => entry.datasetId === datasetId);
    if (!input) throw codedError('STUDY_AMENDMENT_REQUIRED', 'That dataset is not an input of this study.', 409);
    const { rows } = await client.query('SELECT * FROM datasets WHERE id = $1 AND project_id = $2', [datasetId, study.project_id]);
    if (!rows[0] || rows[0].sha256 !== input.datasetSha256) {
      throw codedError('INPUT_CHANGED', 'The pinned input version is no longer available.', 409);
    }
    if (input.sourceRunId) {
      const { rows: objects } = await client.query(
        'SELECT 1 FROM analysis_objects WHERE id = $1 AND project_id = $2', [input.analysisObjectId, study.project_id]);
      if (!objects[0]) throw codedError('INPUT_CHANGED', 'The pinned source result is no longer available.', 409);
    }
    if (release.jobType === 'seurat.multisample.v1') {
      // The job reads every dataset in the sample sheet: all must be unchanged,
      // and the plan's dataset must be the sheet's primary (first) sample.
      const sheet = study.protected_json.samples || [];
      if (sheet[0]?.datasetId !== datasetId) {
        throw codedError('STUDY_AMENDMENT_REQUIRED', 'Plan multi-sample runs on the first dataset of the sample sheet.', 409);
      }
      for (const entry of study.inputs_json) {
        const { rows: pinned } = await client.query('SELECT * FROM datasets WHERE id = $1 AND project_id = $2', [entry.datasetId, study.project_id]);
        if (!pinned[0] || pinned[0].sha256 !== entry.datasetSha256) {
          throw codedError('INPUT_CHANGED', 'A pinned sample is no longer available in its exact version.', 409);
        }
        try { assertSupportedSeuratPipelineDataset(datasetForHandler(pinned[0])); } catch (error) {
          throw codedError('INPUT_NOT_APPLICABLE', error.message, 409);
        }
      }
    }
    if (release.jobType === 'seurat.pipeline.v1' || release.jobType === 'spatial.seurat.v1') {
      const check = release.jobType === 'seurat.pipeline.v1' ? assertSupportedSeuratPipelineDataset : assertSupportedSpatialSeuratDataset;
      try { check(datasetForHandler(rows[0])); } catch (error) {
        throw codedError('INPUT_NOT_APPLICABLE', error.message, 409);
      }
    }
    return { input, dataset: rows[0] };
  }

  function resolveChoices(study, choices = {}) {
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) {
      throw codedError('INVALID_INPUT', 'choices must be an object.', 400);
    }
    const variations = study.variations_json;
    const resolved = {};
    for (const key of Object.keys(choices)) {
      if (!Object.prototype.hasOwnProperty.call(variations, key)) {
        throw codedError('STUDY_AMENDMENT_REQUIRED', `'${key.slice(0, 64)}' is not a permitted variation in this study.`, 409);
      }
    }
    for (const [key, allowed] of Object.entries(variations)) {
      const value = Object.prototype.hasOwnProperty.call(choices, key) ? choices[key] : allowed[0];
      if (!allowed.some((candidate) => sameValue(candidate, value))) {
        throw codedError('STUDY_AMENDMENT_REQUIRED', `That value of '${key}' is outside the study's permitted options.`, 409);
      }
      resolved[key] = value;
    }
    return resolved;
  }

  async function createPlan(actor, body = {}) {
    rejectUnknown(body, ['studyId', 'datasetId', 'choices']);
    return withTransaction(async (client) => {
      await liveDelegation(client, actor);
      const study = await studyForAgent(client, actor, body.studyId);
      const release = await approvedRelease(client, study);
      if (typeof body.datasetId !== 'string') throw codedError('INVALID_INPUT', 'datasetId is required.', 400);
      const { input } = await pinnedInput(client, study, body.datasetId, release);
      const choices = resolveChoices(study, body.choices);
      let parameters;
      try {
        parameters = release.validateParameters({ ...study.protected_json, ...choices });
      } catch (error) {
        // Individually permitted values can still violate a joint constraint.
        throw codedError('STUDY_CONSTRAINT_VIOLATION', error.message, 409);
      }
      const { rows: open } = await client.query(
        `SELECT COUNT(*)::int AS n FROM execution_plans ep
          WHERE ep.delegation_id = $1 AND ep.expires_at > now()
            AND NOT EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.plan_id = ep.id)`,
        [actor.delegation.id]
      );
      if (open[0].n >= MAX_OPEN_PLANS_PER_DELEGATION) {
        throw codedError('RATE_LIMITED', 'Too many unsubmitted plans. Let some expire or submit them.', 429);
      }
      const { rows: clock } = await client.query(`SELECT now() + ($1 || ' seconds')::interval AS expires_at`, [String(PLAN_TTL_SECONDS)]);
      const expiresAt = new Date(clock[0].expires_at).toISOString();
      const spec = {
        schema: 'traceomics.execution-plan.v1',
        projectId: actor.delegation.projectId,
        actor: {
          kind: 'agent', principalId: actor.principalId, sponsorUserId: actor.sponsorUserId,
          delegationId: actor.delegation.id, delegationVersion: actor.delegation.version,
          policySchema: actor.delegation.policy.schema,
        },
        release: { id: release.id, key: release.key, version: release.version, digest: release.digest, jobType: release.jobType },
        approvalId: study.approval_id,
        study: { id: study.id },
        inputs: { datasetId: input.datasetId, datasetSha256: input.datasetSha256, analysisObjectId: input.analysisObjectId },
        choices,
        parameters,
        resources: release.definition.resources,
        executionTarget: study.execution_target || 'local',
        outputs: release.definition.outputs,
        validation: release.definition.validation,
        expiresAt,
      };
      const canonical = canonicalJson(spec);
      const digest = sha256(canonical);
      const id = `plan_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO execution_plans (id, project_id, delegation_id, agent_principal_id, sponsor_user_id, study_id,
           release_id, approval_id, canonical_json, digest, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, actor.delegation.projectId, actor.delegation.id, actor.principalId, actor.sponsorUserId, study.id,
          release.id, study.approval_id, canonical, digest, expiresAt]
      );
      await recordAutomationEvent(client, {
        projectId: actor.delegation.projectId, actor, action: 'plan.created', decision: 'allowed',
        targetType: 'plan', targetId: id,
      });
      return { id, digest, plan: spec };
    });
  }

  async function getPlan(actor, planId) {
    if (!PLAN_ID.test(String(planId))) throw codedError('NOT_FOUND', 'Plan not found.', 404);
    const { rows } = await db.query(
      `SELECT ep.*, ar.id AS run_id FROM execution_plans ep LEFT JOIN agent_runs ar ON ar.plan_id = ep.id
        WHERE ep.id = $1 AND ep.delegation_id = $2`,
      [planId, actor.delegation.id]
    );
    if (!rows[0]) throw codedError('NOT_FOUND', 'Plan not found.', 404);
    return { id: rows[0].id, digest: rows[0].digest, runId: rows[0].run_id, plan: JSON.parse(rows[0].canonical_json) };
  }

  async function runRow(runner, runId, extra = '', params = []) {
    const { rows } = await runner.query(`${RUN_SELECT} WHERE ar.id = $1 ${extra}`, [runId, ...params]);
    return rows[0] || null;
  }

  async function submitRun(actor, body = {}) {
    rejectUnknown(body, ['planId', 'planDigest', 'requestId']);
    if (!PLAN_ID.test(String(body.planId))) throw codedError('INVALID_INPUT', 'planId is required.', 400);
    if (!DIGEST.test(String(body.planDigest))) throw codedError('INVALID_INPUT', 'planDigest is required.', 400);
    if (!REQUEST_ID.test(String(body.requestId))) {
      throw codedError('INVALID_REQUEST_ID', 'requestId must be 8-80 letters, digits, "-" or "_".', 400);
    }
    return withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('traceomics-agent-admission'))");
      await liveDelegation(client, actor, { lock: true });

      const { rows: prior } = await client.query(
        'SELECT id, plan_id, plan_digest FROM agent_runs WHERE delegation_id = $1 AND request_id = $2',
        [actor.delegation.id, body.requestId]
      );
      if (prior[0]) {
        if (prior[0].plan_id !== body.planId || prior[0].plan_digest !== body.planDigest) {
          throw codedError('IDEMPOTENCY_CONFLICT', 'This requestId was already used for a different submission.', 409);
        }
        return { run: publicRun(await runRow(client, prior[0].id)), replayed: true };
      }

      const { rows: plans } = await client.query(
        `SELECT ep.*, (ep.expires_at <= now()) AS expired, ar.id AS run_id
           FROM execution_plans ep LEFT JOIN agent_runs ar ON ar.plan_id = ep.id
          WHERE ep.id = $1 AND ep.delegation_id = $2`,
        [body.planId, actor.delegation.id]
      );
      const planRow = plans[0];
      if (!planRow) throw codedError('NOT_FOUND', 'Plan not found.', 404);
      if (planRow.digest !== body.planDigest) throw codedError('PLAN_DIGEST_MISMATCH', 'The plan digest does not match.', 409);
      if (planRow.run_id) {
        const error = codedError('PLAN_ALREADY_SUBMITTED', 'This plan was already submitted under another requestId.', 409);
        error.details = { runId: planRow.run_id };
        throw error;
      }
      if (planRow.expired) throw codedError('PLAN_STALE', 'This plan has expired. Create a new plan.', 409);
      const plan = JSON.parse(planRow.canonical_json);

      // Recheck everything the plan relied on: authority can change after planning.
      const { rows: member } = await client.query(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR SHARE',
        [actor.delegation.projectId, actor.sponsorUserId]
      );
      if (!member[0] || !WRITE_ROLES.includes(member[0].role)) {
        throw codedError('SCOPE_DENIED', 'The sponsor can no longer run project workflows.', 403);
      }
      const study = await studyForAgent(client, actor, plan.study.id, { lock: true });
      const release = await approvedRelease(client, study);
      if (release.digest !== plan.release.digest || study.approval_id !== plan.approvalId) {
        throw codedError('PLAN_STALE', 'The approved release changed after planning. Create a new plan.', 409);
      }
      const { dataset } = await pinnedInput(client, study, plan.inputs.datasetId, release);

      const executionTarget = plan.executionTarget || 'local';
      if (executionTarget === 'slurm' && !slurmConfig().enabled) {
        throw codedError('TARGET_UNQUALIFIED', 'The Slurm target is not available on this installation.', 409);
      }
      const cpuSeconds = plan.resources.cpus * plan.resources.maxWallSeconds;
      const limits = installationLimits();
      const policy = actor.delegation.policy;
      const outstanding = `ar.job_id IN (SELECT id FROM jobs WHERE status = ANY($2::text[]))`;
      const { rows: [counts] } = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM agent_runs ar WHERE ${outstanding}) AS installation_outstanding,
           (SELECT COUNT(*)::int FROM agent_runs ar WHERE ar.sponsor_user_id = $3 AND ${outstanding}) AS sponsor_outstanding,
           (SELECT COUNT(*)::int FROM agent_runs ar WHERE ar.delegation_id = $1 AND ${outstanding}) AS delegation_outstanding,
           (SELECT COALESCE(SUM(reserved_cpu_seconds), 0)::bigint FROM agent_runs WHERE delegation_id = $1) AS delegation_cpu,
           (SELECT COUNT(*)::int FROM agent_runs WHERE study_id = $4) AS study_trials,
           (SELECT COUNT(*)::int FROM agent_runs ar WHERE ar.study_id = $4 AND ${outstanding}) AS study_outstanding,
           (SELECT COALESCE(SUM(reserved_cpu_seconds), 0)::bigint FROM agent_runs WHERE study_id = $4) AS study_cpu`,
        [actor.delegation.id, NON_TERMINAL, actor.sponsorUserId, study.id]
      );
      if (counts.installation_outstanding >= limits.maxOutstandingRuns) {
        throw budgetError('installation', 'The installation is at its limit of active agent runs.');
      }
      if (counts.sponsor_outstanding >= limits.maxOutstandingRunsPerSponsor) {
        throw budgetError('sponsor', "The sponsor's agents are at their limit of active runs.");
      }
      if (counts.delegation_outstanding >= policy.maxOutstandingRuns) {
        throw budgetError('delegation', 'This agent is at its limit of active runs.');
      }
      if (Number(counts.delegation_cpu) + cpuSeconds > policy.maxReservedCpuSeconds) {
        throw budgetError('delegation-compute', "This agent's compute budget is exhausted.");
      }
      if (counts.study_trials >= study.max_trials) {
        throw budgetError('study-trials', 'This study has used all of its trials.');
      }
      if (counts.study_outstanding >= study.max_outstanding_runs) {
        throw budgetError('study-outstanding', 'This study is at its limit of active runs.');
      }
      if (Number(counts.study_cpu) + cpuSeconds > Number(study.max_cpu_seconds)) {
        throw budgetError('study-compute', "This study's compute budget is exhausted.");
      }

      // Enqueue exactly the planned job. Owner is the sponsor (workspace owner);
      // the agent run record names the actual actor and delegation.
      const jobId = db.genId('job');
      const maxAttempts = db.RETRYABLE_DURABLE_JOB_TYPES.has(plan.release.jobType) ? 2 : 1;
      await client.query(
        `INSERT INTO jobs (id, owner_user_id, project_id, analysis_object_id, dataset_id, job_type, status,
           parameters_json, max_attempts, execution_target)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [jobId, actor.sponsorUserId, actor.delegation.projectId, plan.inputs.analysisObjectId, dataset.id,
          plan.release.jobType, db.INITIAL_JOB_STATUS, JSON.stringify(plan.parameters), maxAttempts, executionTarget]
      );
      const runId = `run_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO agent_runs (id, project_id, delegation_id, agent_principal_id, sponsor_user_id, credential_id,
           study_id, plan_id, plan_digest, request_id, job_id, trial_number, reserved_cpus, reserved_memory_mib,
           max_wall_seconds, reserved_cpu_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [runId, actor.delegation.projectId, actor.delegation.id, actor.principalId, actor.sponsorUserId, actor.credentialId,
          study.id, planRow.id, planRow.digest, body.requestId, jobId, counts.study_trials + 1, plan.resources.cpus,
          plan.resources.memoryMiB, plan.resources.maxWallSeconds, cpuSeconds]
      );
      await recordAutomationEvent(client, {
        projectId: actor.delegation.projectId, actor, action: 'run.admitted', decision: 'allowed',
        targetType: 'run', targetId: runId, requestId: body.requestId,
      });
      return { run: publicRun(await runRow(client, runId)), replayed: false };
    });
  }

  async function getRunForAgent(actor, runId) {
    if (!RUN_ID.test(String(runId))) throw codedError('NOT_FOUND', 'Run not found.', 404);
    const row = await runRow(db, runId, 'AND ar.delegation_id = $2', [actor.delegation.id]);
    if (!row) throw codedError('NOT_FOUND', 'Run not found.', 404);
    return publicRun(row);
  }

  async function listRunsForAgent(actor, { limit } = {}) {
    const bounded = Math.min(100, Math.max(1, Number(limit) || 50));
    const { rows } = await db.query(
      `${RUN_SELECT} WHERE ar.delegation_id = $1 ORDER BY ar.created_at DESC, ar.id DESC LIMIT $2`,
      [actor.delegation.id, bounded]
    );
    return rows.map(publicRun);
  }

  async function resultsForAgent(actor, runId) {
    const run = await getRunForAgent(actor, runId);
    if (run.state !== 'candidate_ready') {
      return { run, result: null, reason: `Results are not available while the run is ${run.state}.` };
    }
    if (run.resultArtifactId) {
      const { rows } = await db.query(
        'SELECT id, artifact_type, created_at, metadata_json FROM job_artifacts WHERE id = $1 AND project_id = $2',
        [run.resultArtifactId, actor.delegation.projectId]
      );
      if (!rows[0]) return { run, result: null, reason: 'The result artifact is unavailable.' };
      return {
        run,
        result: {
          artifactId: rows[0].id,
          artifactType: rows[0].artifact_type,
          createdAt: rows[0].created_at,
          summary: boundedSummary(parseMetadata(rows[0].metadata_json)),
          technicalValidation: 'passed',
          scientificAcceptance: run.acceptance,
        },
      };
    }
    const { rows } = await db.query(
      'SELECT id, object_type, created_at, metadata_json FROM analysis_objects WHERE id = $1 AND project_id = $2',
      [run.resultAnalysisObjectId, actor.delegation.projectId]
    );
    if (!rows[0]) return { run, result: null, reason: 'The result object is unavailable.' };
    const metadata = parseMetadata(rows[0].metadata_json);
    return {
      run,
      result: {
        analysisObjectId: rows[0].id,
        objectType: rows[0].object_type,
        createdAt: rows[0].created_at,
        summary: boundedSummary(metadata),
        technicalValidation: 'passed',
        scientificAcceptance: run.acceptance,
      },
    };
  }

  async function cancelForAgent(actor, runId) {
    if (!RUN_ID.test(String(runId))) throw codedError('NOT_FOUND', 'Run not found.', 404);
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM agent_runs WHERE id = $1 AND delegation_id = $2 FOR UPDATE', [runId, actor.delegation.id]);
      const run = rows[0];
      if (!run) throw codedError('NOT_FOUND', 'Run not found.', 404);
      const { rows: jobs } = await client.query('SELECT status FROM jobs WHERE id = $1 FOR UPDATE', [run.job_id]);
      const status = jobs[0]?.status;
      if (NON_TERMINAL.includes(status)) {
        if (!run.cancel_requested_at) {
          await client.query('UPDATE agent_runs SET cancel_requested_at = now() WHERE id = $1', [runId]);
          await recordAutomationEvent(client, {
            projectId: actor.delegation.projectId, actor, action: 'run.cancel-requested', decision: 'allowed',
            targetType: 'run', targetId: runId,
          });
        }
        // A queued job has not started: cancel it now. A running job is stopped
        // at its next claim boundary and any late output is quarantined; the
        // reservation is retained either way.
        await client.query(
          `UPDATE jobs SET status = 'canceled', canceled_at = now(), updated_at = now(), claim_token = NULL,
             lease_expires_at = NULL,
             logs_json = (logs_json::jsonb || '[{"level":"info","message":"Canceled by the delegated agent."}]'::jsonb)::text
           WHERE id = $1 AND status IN ('created', 'queued') AND result_analysis_object_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = $1)`,
          [run.job_id]
        );
      }
      return publicRun(await runRow(client, runId));
    });
  }

  async function listRunsForHuman(actor, projectId, { studyId } = {}) {
    await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const params = [String(projectId)];
    let filter = '';
    if (studyId !== undefined) { params.push(String(studyId)); filter = ' AND ar.study_id = $2'; }
    const { rows } = await db.query(
      `${RUN_SELECT} WHERE ar.project_id = $1${filter} ORDER BY ar.created_at DESC, ar.id DESC LIMIT 200`, params);
    const runs = rows.map(publicRun);
    const objectIds = runs.map((r) => r.resultAnalysisObjectId).filter(Boolean);
    const artifactIds = runs.map((r) => r.resultArtifactId).filter(Boolean);
    const summaries = new Map();
    if (objectIds.length) {
      const { rows: objects } = await db.query(
        'SELECT id, metadata_json FROM analysis_objects WHERE project_id = $1 AND id = ANY($2::text[])',
        [String(projectId), objectIds]);
      for (const o of objects) summaries.set(o.id, boundedSummary(parseMetadata(o.metadata_json)));
    }
    if (artifactIds.length) {
      const { rows: artifacts } = await db.query(
        'SELECT id, metadata_json FROM job_artifacts WHERE project_id = $1 AND id = ANY($2::text[])',
        [String(projectId), artifactIds]);
      for (const a of artifacts) summaries.set(a.id, boundedSummary(parseMetadata(a.metadata_json)));
    }
    for (const r of runs) r.summary = summaries.get(r.resultAnalysisObjectId || r.resultArtifactId) || null;
    return { schema: 'traceomics.agent-runs.v1', runs };
  }

  // Human acceptance: compare-and-swap on the study's accepted-result pointer,
  // so an old decision cannot overwrite a newer one.
  async function acceptByHuman(actor, projectId, runId, body = {}) {
    if (actor?.kind !== 'human') throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
    rejectUnknown(body, ['expectedAcceptedRunId', 'note']);
    if (!Object.prototype.hasOwnProperty.call(body, 'expectedAcceptedRunId')
        || (body.expectedAcceptedRunId !== null && !RUN_ID.test(String(body.expectedAcceptedRunId)))) {
      throw codedError('INVALID_INPUT', 'expectedAcceptedRunId is required (a run id or null).', 400);
    }
    if (!RUN_ID.test(String(runId))) throw codedError('NOT_FOUND', 'Run not found.', 404);
    const note = body.note === undefined ? null : String(body.note).slice(0, 2000);
    return withTransaction(async (client) => {
      await db.requireProjectRole(actor.userId, projectId, WRITE_ROLES);
      const { rows: base } = await client.query(
        'SELECT study_id FROM agent_runs WHERE id = $1 AND project_id = $2', [runId, String(projectId)]);
      if (!base[0]) throw codedError('NOT_FOUND', 'Run not found.', 404);
      const { rows: studies } = await client.query('SELECT * FROM study_envelopes WHERE id = $1 FOR UPDATE', [base[0].study_id]);
      const study = studies[0];
      const row = await runRow(client, runId);
      const run = publicRun(row);
      if (run.state !== 'candidate_ready') {
        throw codedError('RESULT_NOT_ACCEPTABLE', `A ${run.state} run cannot be accepted.`, 409);
      }
      if ((study.accepted_run_id || null) !== body.expectedAcceptedRunId) {
        const error = codedError('BASELINE_CHANGED', 'The accepted result changed since you reviewed it.', 409);
        error.details = { acceptedRunId: study.accepted_run_id || null };
        throw error;
      }
      if (study.accepted_run_id === runId) return run;
      const version = study.accepted_version + 1;
      await client.query(
        'UPDATE study_envelopes SET accepted_run_id = $2, accepted_version = $3 WHERE id = $1',
        [study.id, runId, version]
      );
      await client.query(
        `INSERT INTO result_acceptances (id, project_id, study_id, run_id, result_analysis_object_id, result_artifact_id,
           accepted_by_user_id, previous_run_id, accepted_version, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [`acc_${crypto.randomBytes(12).toString('hex')}`, String(projectId), study.id, runId,
          run.resultAnalysisObjectId, run.resultAnalysisObjectId ? null : run.resultArtifactId,
          actor.userId, study.accepted_run_id, version, note]
      );
      await recordAutomationEvent(client, {
        projectId, actor, action: 'result.accepted', decision: 'allowed', targetType: 'run', targetId: runId,
      });
      return publicRun(await runRow(client, runId));
    });
  }

  return {
    createPlan, getPlan, submitRun, getRunForAgent, listRunsForAgent, resultsForAgent, cancelForAgent,
    listRunsForHuman, acceptByHuman,
  };
}

module.exports = { createAdmissionService, runState, installationLimits };
