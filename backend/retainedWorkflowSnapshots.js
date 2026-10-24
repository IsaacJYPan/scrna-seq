'use strict';

const crypto = require('node:crypto');
const db = require('./pgDatabase');
const storage = require('./storage');
const snapshotContract = import('../shared/workflowSnapshot.mjs');
const packages = import('../shared/recipePackage.mjs');
const workflowPackages = import('../shared/workflowPackage.mjs');
const publicationContext = import('../shared/analysisSnapshotWorkflowContext.mjs');
const typedPublication = import('../shared/analysisSnapshotTypedResult.mjs');
const { EXPERT_R_PROFILE } = require('./expertR');
const { validateEnvironmentReference } = require('./rEnvironment');
const { validateResultSemantics } = require('../shared/resultSemantics.mjs');
const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const WRITE_ROLES = ['owner', 'admin', 'analyst'];
const SOURCE_BYTES = 3 * 1024 * 1024;
const STATE_BYTES = 2 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const identifier = () => `wfi_${crypto.randomBytes(12).toString('hex')}`;
const iso = value => new Date(value).toISOString();
const label = (value, fallback) => [...(typeof value === 'string' && value ? value : fallback)].slice(0, 160)
  .map(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character).join('');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const missing = () => { throw failure('WORKFLOW_SNAPSHOT_NOT_FOUND', 'The saved workflow is unavailable to this account.', 404); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const sourceColumns = `id,owner_user_id,project_id,analysis_object_id,name,package_digest,created_at,
  octet_length(package_json::text)+octet_length(state_json::text) AS source_bytes,
  CASE WHEN octet_length(package_json::text)+octet_length(state_json::text)<=${SOURCE_BYTES} THEN package_json ELSE NULL END AS package_json,
  CASE WHEN octet_length(package_json::text)+octet_length(state_json::text)<=${SOURCE_BYTES} THEN state_json ELSE NULL END AS state_json`;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const descriptor = value => plain(value) && /^(?:art|eri)_[a-f0-9]{16,40}$/.test(value.id || '')
  && /^[a-f0-9]{64}$/.test(value.sha256 || '') && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0
  && ['rds', 'table', 'metrics', 'scatter', 'figure'].includes(value.type) && typeof value.profileId === 'string';

function content(row) {
  return { projectId: row.project_id, ownerUserId: Number(row.owner_user_id), analysisObjectId: row.analysis_object_id,
    packageDigest: row.package_digest, package: row.package_json, state: row.state_json };
}
async function fingerprint(row) {
  if (Number(row.source_bytes) > SOURCE_BYTES) return null;
  try { return hash((await snapshotContract).canonicalRetainedWorkflowSnapshot(content(row))); } catch { return null; }
}
function unsupported(code, message) { return { supported: false, code, message, execution: 'not-checked', integrity: 'recorded' }; }
function working(row) { return row ? { id: row.id, generation: row.state_json.generation, active: !!row.state_json.active } : null; }
function publicInstance(row) {
  return row ? { id: row.id, projectId: row.project_id, analysisObjectId: row.analysis_object_id,
    packageDigest: row.package_digest, package: row.package_json, state: row.state_json } : null;
}
function restored(row) {
  return { schema: 'traceomics.workflow-restoration.v1', requestId: row.request_id, snapshotId: row.snapshot_id,
    sha256: row.snapshot_sha256, analysisObjectId: row.analysis_object_id, packageDigest: row.package_digest,
    instanceId: row.instance_id, generation: Number(row.accepted_generation), createdAt: iso(row.created_at) };
}

async function snapshotRows(client, userId, projectId, ids) {
  return (await client.query(`SELECT ${sourceColumns} FROM workflow_snapshots WHERE owner_user_id=$1 AND project_id=$2 AND id=ANY($3::text[])`,
    [userId, projectId, ids])).rows;
}
async function authorizedWorkflowSnapshotReferences(client, userId, projectId, references) {
  const requested = references.filter(ref => ref.kind === 'workflow-snapshot');
  if (!requested.length) return [];
  const rows = await snapshotRows(client, userId, projectId, [...new Set(requested.map(ref => ref.snapshotId))]);
  const checksums = new Map();
  for (const row of rows) checksums.set(row.id, await fingerprint(row));
  return requested.filter(ref => checksums.get(ref.snapshotId) === ref.sha256);
}
async function snapshotIsReferenced(client, projectId, snapshotId) {
  return (await client.query(`SELECT 1 FROM (
    SELECT jsonb_array_elements(references_json) AS reference FROM research_analyses WHERE project_id=$1
    UNION ALL SELECT jsonb_array_elements(snapshot_json->'references') FROM research_analysis_revisions WHERE project_id=$1
  ) saved WHERE reference->>'kind'='workflow-snapshot' AND reference->>'snapshotId'=$2 LIMIT 1`, [projectId, snapshotId])).rowCount > 0;
}

// Trusted publication callers share their short current-member transaction.
// Return only selected-safe offers and exact output identities, never private
// code/state/inputs or a working instance. Reopening has different requirements.
async function snapshotPublicationOutputs(client, userId, projectId, reference, selectedPorts = null) {
  if (reference?.kind !== 'workflow-snapshot' || !/^wfs_[a-f0-9]{24}$/.test(reference.snapshotId || '') || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')) missing();
  const row = (await snapshotRows(client, userId, projectId, [reference.snapshotId]))[0];
  if (!row || await fingerprint(row) !== reference.sha256) missing();
  let workflow;
  try {
    workflow = (await workflowPackages).validateWorkflowPackage(row.package_json);
    if (digest(workflow) !== row.package_digest || Buffer.byteLength(JSON.stringify(row.state_json)) > STATE_BYTES
        || !plain(row.state_json) || row.state_json.active !== null || !plain(row.state_json.results)) throw new Error();
  } catch { throw failure('WORKFLOW_PUBLICATION_UNSUPPORTED', 'The recorded capture cannot supply an exact selected output projection.', 409); }
  const context = await publicationContext, typed = await typedPublication, items = [];
  const safeNumber = value => Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  for (const step of workflow.steps) {
    const result = row.state_json.results[step.id]; if (!plain(result) || !plain(result.outputs)) continue;
    for (const [port, declared] of Object.entries(step.outputs)) {
      if (selectedPorts && !selectedPorts.some(item => item.stepId === step.id && item.port === port)) continue;
      const output = result.outputs[port];
      if (!plain(output) || typeof output.id !== 'string' || !/^(?:av|art|eri)_[a-f0-9]{16,40}$/.test(output.id)
          || typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(output.sha256)) continue;
      const outputReference = { kind: 'artifact-version', versionId: output.id, sha256: output.sha256 };
      let descriptor = null, consistent = output.type === declared.type && Number.isSafeInteger(output.sizeBytes) && output.sizeBytes >= 0 && output.sizeBytes <= 200 * 1024 * 1024;
      try {
        if (output.profileId != null && output.profileId !== workflow.runtime.profileId) consistent = false;
        if (Object.hasOwn(declared, 'semantics') && digest(validateResultSemantics(declared.semantics, declared.type)) !== digest(validateResultSemantics(output.semantics ?? {}, output.type))) consistent = false;
        if (['table', 'metrics', 'figure'].includes(output.type)) descriptor = typed.normalizeAnalysisSnapshotTypedDescriptor({ schema: typed.ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA,
          id: output.id, type: output.type, sha256: output.sha256, sizeBytes: output.sizeBytes, profileId: output.profileId ?? null, semantics: output.semantics ?? {} });
      } catch { consistent = false; }
      const parameters = [];
      for (const parameter of step.parameters) {
        if (!plain(result.parameters) || !Object.hasOwn(result.parameters, parameter.key)) continue;
        const value = result.parameters[parameter.key];
        const numeric = ['integer', 'number'].includes(parameter.type);
        const allowed = numeric ? typeof value === 'number' && safeNumber(value) && (parameter.type !== 'integer' || Number.isSafeInteger(value))
          && (parameter.min === undefined || value >= parameter.min) && (parameter.max === undefined || value <= parameter.max)
          : parameter.type === 'boolean' ? typeof value === 'boolean'
            : parameter.type === 'choice' && typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,79}$/.test(value) && parameter.options.includes(value);
        if (allowed) parameters.push({ key: parameter.key, type: parameter.type, label: parameter.label, value });
      }
      let environment = null;
      try {
        const runtime = result.runtime, artifact = runtime?.environmentArtifact, recorded = validateEnvironmentReference(runtime?.environment);
        if (!plain(runtime) || !plain(artifact) || !/^art_[a-f0-9]{16,40}$/.test(artifact.id || '') || artifact.checksumSha256 !== recorded.manifestSha256
            || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || artifact.sizeBytes > 256 * 1024
            || recorded.profileId !== workflow.runtime.profileId || runtime.profileId != null && runtime.profileId !== recorded.profileId
            || output.profileId != null && output.profileId !== recorded.profileId) throw new Error();
        environment = { reference: recorded, artifact: { id: artifact.id, checksumSha256: artifact.checksumSha256, sizeBytes: artifact.sizeBytes } };
      } catch { /* Unselected unavailable context never blocks an intact output. */ }
      const offer = context.normalizeAnalysisSnapshotWorkflowContextOffer({ method: { id: workflow.id, name: workflow.name, version: workflow.version, digest: row.package_digest,
        stepLabel: step.label, outputLabel: declared.label }, parameters, seed: Number.isSafeInteger(result.seed) && !Object.is(result.seed, -0) && result.seed >= 0 && result.seed <= 2147483647 ? result.seed : null,
      environment: environment?.reference || null });
      items.push({ stepId: step.id, stepLabel: step.label, port, outputLabel: declared.label, reference: outputReference,
        descriptor, consistent, type: output.type, offer, environment });
    }
  }
  return items;
}

async function inspectSource(client, row) {
  let workflow;
  if (Number(row.source_bytes) > SOURCE_BYTES) return unsupported('WORKFLOW_SOURCE_TOO_LARGE', 'This captured workflow exceeds the supported source preview size. Its original record has been kept.');
  try {
    workflow = (await packages).parseLegacyExecutableWorkflowPackage(row.package_json, { environmentProfiles: [EXPERT_R_PROFILE.id] });
    if (workflow.runtime.profileId !== EXPERT_R_PROFILE.id || digest(workflow) !== row.package_digest) throw new Error();
  } catch { return unsupported('WORKFLOW_SOURCE_UNSUPPORTED', 'The captured method cannot be reopened by this installed workflow adapter. Its saved source is still available for review.'); }
  const state = row.state_json;
  const expected = [];
  try {
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > STATE_BYTES || !plain(state) || state.active !== null
        || !Number.isSafeInteger(state.generation) || state.generation < 0 || state.generation >= 2147483647
        || !plain(state.results) || !descriptor(state.root) || state.root.type !== 'rds' || state.root.root !== true
        || state.root.profileId !== workflow.runtime.profileId) throw new Error();
    if (Object.hasOwn(state, 'environment') && validateEnvironmentReference(state.environment).profileId !== workflow.runtime.profileId) throw new Error();
    for (const [stepId, result] of Object.entries(state.results)) {
      const step = workflow.steps.find(value => value.id === stepId);
      if (!step || !plain(result) || !plain(result.outputs) || !plain(result.inputs)
          || !Number.isSafeInteger(result.seed) || result.seed < 0 || result.seed > 2147483647
          || !/^[a-f0-9]{64}$/.test(result.producerKey || '')
          || Object.keys(result.outputs).length !== Object.keys(step.outputs).length
          || Object.keys(result.inputs).length !== Object.keys(step.inputs).length) throw new Error();
      (await workflowPackages).workflowParameters(step, result.parameters);
      for (const [port, output] of Object.entries(result.outputs)) {
        if (!step.outputs[port] || !descriptor(output) || output.type !== step.outputs[port].type || output.profileId !== workflow.runtime.profileId
            || output.root !== undefined && output.root !== false) throw new Error();
        if (Object.hasOwn(output, 'semantics')) validateResultSemantics(output.semantics, output.type);
        expected.push({ stepId, port, ...output });
      }
      for (const [port, input] of Object.entries(result.inputs)) {
        const binding = step.inputs[port];
        if (!binding || !descriptor(input) || input.type !== binding.type) throw new Error();
        const [parent, output] = binding.from.split('.');
        const original = parent === 'input' ? state.root : state.results[parent]?.outputs[output];
        if (!original || input.id !== original.id || input.sha256 !== original.sha256 || input.sizeBytes !== original.sizeBytes
            || input.profileId !== original.profileId || !!input.root !== !!original.root) throw new Error();
      }
    }
  } catch { return unsupported('WORKFLOW_STATE_UNSUPPORTED', 'The captured working state is incomplete or unsupported. Its source has been kept without creating replacement code or results.'); }
  const object = (await client.query('SELECT id FROM analysis_objects WHERE id=$1 AND project_id=$2 AND owner_user_id=$3',
    [row.analysis_object_id, row.project_id, row.owner_user_id])).rows[0];
  if (!object) return unsupported('WORKFLOW_ROOT_UNAVAILABLE', 'The original owned analysis object is unavailable. The saved workflow has not been changed.');
  let roots = (await client.query(`SELECT a.id,a.checksum_sha256,a.size_bytes,a.storage_uri FROM job_artifacts a JOIN jobs j ON j.id=a.job_id
    WHERE a.result_analysis_object_id=$1 AND a.project_id=$2 AND j.project_id=$2 AND j.status='completed'
      AND a.artifact_type='checkpoint' AND a.storage_kind='local_internal' AND a.status='available' ORDER BY a.created_at,a.id LIMIT 2`,
  [row.analysis_object_id, row.project_id])).rows;
  if (!roots.length) roots = (await client.query(`SELECT a.id,a.checksum_sha256,a.size_bytes,a.storage_uri
    FROM analysis_object_edges e JOIN jobs j ON j.id=e.job_id AND j.job_type='checkpoint.fork.v1'
      AND j.result_analysis_object_id=e.child_analysis_object_id AND j.status='completed'
    JOIN job_artifacts a ON a.id=(e.metadata_json::jsonb->>'checkpointArtifactId') AND a.result_analysis_object_id=e.parent_analysis_object_id
      AND a.artifact_type='checkpoint' AND a.storage_kind='local_internal' AND a.status='available' AND a.project_id=$2
    WHERE e.child_analysis_object_id=$1 AND e.project_id=$2 AND e.edge_type='checkpoint_fork' ORDER BY a.created_at,a.id LIMIT 2`,
  [row.analysis_object_id, row.project_id])).rows;
  if (roots.length !== 1 || roots[0].id !== state.root.id || roots[0].checksum_sha256 !== state.root.sha256
      || Number(roots[0].size_bytes) !== state.root.sizeBytes || !storage.isProjectStorageKey(roots[0].storage_uri, { projectId: row.project_id, kind: 'checkpoints' })) {
    return unsupported('WORKFLOW_ROOT_UNAVAILABLE', 'The exact captured input is unavailable or ambiguous. Reopening will not substitute another checkpoint.');
  }
  const evidence = expected.length ? (await client.query(`SELECT a.id,a.descriptor_json,a.storage_key,a.job_id FROM workflow_artifacts a JOIN jobs j ON j.id=a.job_id
    WHERE a.owner_user_id=$1 AND a.project_id=$2 AND j.project_id=$2 AND j.status='completed' AND a.id=ANY($3::text[])`,
  [row.owner_user_id, row.project_id, expected.map(value => value.id)])).rows : [];
  const byId = new Map(evidence.map(value => [value.id, value]));
  if (expected.some(value => { const original = byId.get(value.id); return !original || original.descriptor_json.sha256 !== value.sha256
    || original.descriptor_json.type !== value.type || original.descriptor_json.sizeBytes !== value.sizeBytes
    || original.descriptor_json.profileId !== value.profileId
    || !storage.isProjectStorageKey(original.storage_key, { projectId: row.project_id, kind: 'artifacts' }); })) {
    return unsupported('WORKFLOW_EVIDENCE_UNAVAILABLE', 'Some captured result evidence is unavailable. The saved source remains intact; reopening will not recreate missing results.');
  }
  return { supported: true, code: null, message: 'The captured method, input and result records can be reopened. Execution availability has not been checked.', execution: 'not-checked', integrity: 'recorded' };
}

function createRetainedWorkflowSnapshotService(database = db) {
  async function transaction(userId, projectId, callback, write = false) {
    if (typeof projectId !== 'string' || !/^proj_[a-f0-9]{16,40}$/.test(projectId)) missing();
    const client = await (await database.connect()).connect();
    try {
      await client.query('BEGIN');
      if (!(await client.query(`SELECT id FROM users WHERE id=$1 FOR ${write ? 'UPDATE' : 'KEY SHARE'}`, [userId])).rowCount) missing();
      if (!(await client.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [projectId])).rowCount) missing();
      const member = (await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId])).rows[0];
      if (!member || !READ_ROLES.includes(member.role)) missing();
      const result = await callback(client, member);
      await client.query('COMMIT'); return result;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* Retain an uncertain original outcome. */ } throw error; }
    finally { client.release(); }
  }
  async function source(client, userId, projectId, snapshotId, expectedHash) {
    if (typeof snapshotId !== 'string' || !/^wfs_[a-f0-9]{24}$/.test(snapshotId)) missing();
    if (expectedHash !== undefined && (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))) throw failure('INVALID_WORKFLOW_SNAPSHOT_HASH', 'Choose a valid exact saved workflow checksum.');
    const row = (await snapshotRows(client, userId, projectId, [snapshotId]))[0]; if (!row) missing();
    const sha256 = await fingerprint(row);
    if (!sha256) throw failure('WORKFLOW_SOURCE_TOO_LARGE', 'The captured workflow source exceeds the supported preview size. Its original record has been kept.', 413);
    if (expectedHash !== undefined && expectedHash !== sha256) throw failure('WORKFLOW_SNAPSHOT_CONFLICT', 'This saved workflow does not match the selected exact source. Refresh its details before reopening.', 409);
    return { row, sha256 };
  }
  async function get(userId, projectId, snapshotId, expectedHash) {
    return transaction(userId, projectId, async (client, member) => {
      const { row, sha256 } = await source(client, userId, projectId, snapshotId, expectedHash);
      const current = (await client.query('SELECT * FROM workflow_instances WHERE owner_user_id=$1 AND project_id=$2 AND analysis_object_id=$3 AND package_digest=$4',
        [userId, projectId, row.analysis_object_id, row.package_digest])).rows[0];
      return { snapshot: { schema: 'traceomics.workflow-snapshot.v1', id: row.id, projectId, ownerUserId: Number(row.owner_user_id), visibility: 'private',
        analysisObjectId: row.analysis_object_id, name: row.name, createdAt: iso(row.created_at), sha256, packageDigest: row.package_digest,
        package: row.package_json, state: row.state_json, support: await inspectSource(client, row), workingInstance: working(current),
        canReopen: WRITE_ROLES.includes(member.role) } };
    });
  }
  async function list(userId, projectId, options = {}) {
    const limit = Number(options.limit ?? 30); let cursor;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw failure('INVALID_SAVED_WORK_PAGE', 'Choose a saved-work page size from 1 to 50.');
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 256) throw new Error();
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== 'workflows' || typeof cursor[1] !== 'string'
            || !/^\d{4}-\d\d-\d\dT/.test(cursor[1]) || !Number.isFinite(Date.parse(cursor[1])) || typeof cursor[2] !== 'string' || !/^wfs_[a-f0-9]{24}$/.test(cursor[2])) throw new Error();
      } catch { throw failure('INVALID_SAVED_WORK_PAGE', 'The saved workflow page cursor is invalid.'); }
    }
    return transaction(userId, projectId, async client => {
      const rows = (await client.query(`SELECT ${sourceColumns} FROM workflow_snapshots WHERE owner_user_id=$1 AND project_id=$2
        ${cursor ? "AND (date_trunc('milliseconds',created_at),id)<($4::timestamptz,$5::text)" : ''}
        ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $3`, [userId, projectId, limit + 1, ...(cursor ? cursor.slice(1) : [])])).rows;
      const items = [];
      for (const row of rows.slice(0, limit)) {
        const sha256 = await fingerprint(row), support = await inspectSource(client, row);
        items.push({ id: row.id, kind: 'workflow-snapshot', label: label(row.name, 'Saved workflow'), type: 'Saved workflow', ownerUserId: userId, ownership: 'yours',
          reference: sha256 ? { kind: 'workflow-snapshot', snapshotId: row.id, sha256 } : null,
          savedState: sha256 ? 'recorded' : 'not-recorded', liveState: 'not-checked', notebookSource: 'not-linked',
          createdAt: iso(row.created_at), savedAt: iso(row.created_at), support,
          origin: { analysisObjectId: row.analysis_object_id, jobId: null, package: /^[a-f0-9]{64}$/.test(row.package_digest || '')
            ? { digest: row.package_digest, id: label(row.package_json?.id, 'Recorded method'),
              version: label(row.package_json?.version, 'Unknown version') } : null } });
      }
      const last = rows.slice(0, limit).at(-1);
      return { projectId, kind: 'workflows', items, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify(['workflows', iso(last.created_at), last.id])).toString('base64url') : null };
    });
  }
  async function open(userId, projectId, snapshotId, input) {
    const parsed = (await snapshotContract).normalizeWorkflowSnapshotOpen(input);
    const requestHash = digest({ projectId, snapshotId, ...parsed });
    return transaction(userId, projectId, async (client, member) => {
      // The owner row also serializes legacy run/save/close/cleanup. Receipt
      // recovery precedes writer/source checks; no retry reapplies old state.
      const accepted = (await client.query('SELECT * FROM workflow_restoration_receipts WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3', [projectId, userId, parsed.requestId])).rows[0];
      if (accepted) {
        if (accepted.request_sha256 !== requestHash) throw failure('WORKFLOW_RESTORATION_REQUEST_CONFLICT', 'This request already reopened a different workflow or working revision. Recover its original request before continuing.', 409);
        const current = (await client.query('SELECT * FROM workflow_instances WHERE id=$1 AND owner_user_id=$2 AND project_id=$3', [accepted.instance_id, userId, projectId])).rows[0];
        return { replayed: true, restoration: restored(accepted), currentInstance: publicInstance(current), canEditWorking: WRITE_ROLES.includes(member.role) };
      }
      if (!WRITE_ROLES.includes(member.role)) throw failure('FORBIDDEN', 'Your project role allows reviewing saved workflows but not reopening working copies.', 403);
      const { row, sha256 } = await source(client, userId, projectId, snapshotId, parsed.sha256);
      const support = await inspectSource(client, row);
      if (!support.supported) throw failure(support.code, support.message, 409);
      const current = (await client.query('SELECT * FROM workflow_instances WHERE owner_user_id=$1 AND project_id=$2 AND analysis_object_id=$3 AND package_digest=$4 FOR UPDATE',
        [userId, projectId, row.analysis_object_id, row.package_digest])).rows[0];
      if (current && (!Number.isSafeInteger(current.state_json.generation) || current.state_json.generation < 0 || current.state_json.generation >= 2147483647)
          || current?.state_json.active || current && (!parsed.expectedInstance || current.id !== parsed.expectedInstance.id
          || current.state_json.generation !== parsed.expectedInstance.generation || !parsed.replace)
          || !current && parsed.expectedInstance !== null) {
        throw Object.assign(failure('WORKFLOW_WORKING_CONFLICT', current?.state_json.active
          ? 'A workflow run is active. Wait for it before replacing working results.'
          : 'The working workflow changed. Review its current generation before choosing whether to replace it.', 409), { workingInstance: working(current) });
      }
      const nextGeneration = (current?.state_json.generation ?? row.state_json.generation) + 1;
      if (nextGeneration >= 2147483647) {
        throw failure('WORKFLOW_GENERATION_EXHAUSTED', 'The next workflow revision exceeds the supported limit. Its captured source and current work have been kept for inspection.', 409);
      }
      if (!current && Number((await client.query('SELECT COUNT(*)::int AS count FROM workflow_instances WHERE owner_user_id=$1', [userId])).rows[0].count) >= 20) {
        throw failure('WORKFLOW_WORKSPACE_FULL', 'Close an existing working workflow before opening more than 20.', 409);
      }
      const state = { ...row.state_json, active: null, generation: nextGeneration };
      const instance = current ? (await client.query('UPDATE workflow_instances SET state_json=$2,package_json=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *', [current.id, state, row.package_json])).rows[0]
        : (await client.query('INSERT INTO workflow_instances(id,owner_user_id,project_id,analysis_object_id,package_digest,package_json,state_json) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [identifier(), userId, projectId, row.analysis_object_id, row.package_digest, row.package_json, state])).rows[0];
      const receipt = (await client.query(`INSERT INTO workflow_restoration_receipts
        (project_id,owner_user_id,request_id,request_sha256,snapshot_id,snapshot_sha256,analysis_object_id,package_digest,instance_id,accepted_generation)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [projectId, userId, parsed.requestId, requestHash, row.id, sha256,
        row.analysis_object_id, row.package_digest, instance.id, state.generation])).rows[0];
      return { replayed: false, restoration: restored(receipt), currentInstance: publicInstance(instance), canEditWorking: true };
    }, true);
  }
  return { get, list, open };
}

module.exports = { createRetainedWorkflowSnapshotService, authorizedWorkflowSnapshotReferences, snapshotIsReferenced, fingerprint, inspectSource, snapshotPublicationOutputs };
