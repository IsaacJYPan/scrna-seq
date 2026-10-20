'use strict';

const crypto = require('node:crypto');
const storage = require('./storage');
const { EXPERT_R_PROFILE, expertRSandboxEnabled, storedExpertRParams } = require('./expertR');
const { expertRAccessSql } = require('./expertRAccess');
const { getExpertREnvironment } = require('./expertSandboxClient');
const { pinExpertREnvironment } = require('./rEnvironment');
const contract = Promise.all([import('../shared/workflowPackage.mjs'), import('../shared/workflowState.mjs'), import('../shared/recipePackage.mjs')])
  .then(([packages, state, recipes]) => ({ ...packages, ...state, ...recipes }));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const identifier = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const extension = type => type === 'rds' ? 'rds' : type === 'figure' ? 'png' : 'json';
const MAX_WORKING_BYTES = 1024 * 1024 * 1024;
const MAX_SUBMISSION_BYTES = 64 * 1024;
const requestIdPattern = /^[a-f0-9-]{16,64}$/;

function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
async function transaction(db, callback) {
  const client = await (await db.connect()).connect();
  try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function authorize(db, userId, projectId, execute = false) {
  await db.requireProjectRole(userId, projectId, ['owner', 'admin', 'analyst']);
  if (execute && (!expertRSandboxEnabled() || !(await db.hasExpertRExecuteCapability(userId, projectId)))) throw error('Custom R execution is unavailable for this account.', 403);
}
async function lockExecutionAccess(client, userId, projectId) {
  const membership = await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId]);
  await client.query('SELECT id FROM users WHERE id=$1 FOR KEY SHARE', [userId]);
  const capability = await client.query(`SELECT 1 WHERE ${expertRAccessSql('$1', '$2')}`, [userId, projectId]);
  if (!['owner', 'admin', 'analyst'].includes(membership.rows[0]?.role) || !capability.rows[0]) throw error('Custom R execution is unavailable for this account.', 403);
}
async function lockedInstance(client, userId, projectId, instanceId) {
  const { rows } = await client.query('SELECT * FROM workflow_instances WHERE id=$1 AND owner_user_id=$2 AND project_id=$3 FOR UPDATE', [instanceId, userId, projectId]);
  if (!rows[0]) throw error('Workflow not found.', 404);
  return rows[0];
}
async function refreshRun(client, row) {
  const state = row.state_json;
  if (state.active) {
    const { rows } = await client.query('SELECT status, error_json FROM jobs WHERE id=$1', [state.active.id]);
    if (!rows[0] || ['failed', 'canceled'].includes(rows[0].status)) {
      row.state_json = (await contract).cancelWorkflowRun(state, state.active.id);
      row.state_json.error = rows[0]?.status === 'canceled' ? 'Run canceled. Previous results were kept.' : 'The step failed. Previous results were kept.';
      await client.query('UPDATE workflow_instances SET state_json=$2 WHERE id=$1', [row.id, row.state_json]);
    }
  }
  return row;
}
function publicInstance(row) {
  return { id: row.id, projectId: row.project_id, analysisObjectId: row.analysis_object_id, packageDigest: row.package_digest, package: row.package_json, state: row.state_json };
}

function validateReceiptLocator(instanceId, requestId) {
  if (typeof instanceId !== 'string' || !/^wfi_[a-f0-9]{24}$/.test(instanceId)
      || typeof requestId !== 'string' || !requestIdPattern.test(requestId)) throw error('A valid workflow and run request ID are required.');
}
function admittedRequest(row, input, api) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['requestId', 'stepId', 'parameters', 'seed'].includes(key))) throw error('Invalid workflow run request.');
  const step = row.package_json.steps.find(item => item.id === input.stepId);
  if (!step) throw error('Unknown workflow step.');
  const seed = input.seed === undefined ? 1 : input.seed;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw error('Invalid random seed.');
  const request = canonical({ instanceId: row.id, analysisObjectId: row.analysis_object_id, packageDigest: row.package_digest,
    stepId: step.id, parameters: api.workflowParameters(step, input.parameters), seed });
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_SUBMISSION_BYTES) throw error('Workflow run settings exceed 64 KiB.');
  return request;
}
function retainedRequest(row) {
  const request = row.request_json;
  if (!request || typeof request !== 'object' || Array.isArray(request) || !/^[a-f0-9]{64}$/.test(row.request_hash || '')
      || Buffer.byteLength(JSON.stringify(request)) > MAX_SUBMISSION_BYTES || digest(request) !== row.request_hash
      || request.instanceId !== (row.original_instance_id || row.instance_id) || request.stepId !== row.step_id
      || request.analysisObjectId !== row.analysis_object_id || !/^[a-f0-9]{64}$/.test(request.packageDigest || '')
      || !Number.isSafeInteger(request.seed) || request.seed < 0 || request.seed > 2147483647) {
    throw error('The original workflow submission cannot be verified. Inspect its recorded execution before starting a new run.', 409);
  }
  return request;
}
function publicSubmission(row) {
  const request = retainedRequest(row);
  return { schema: 'traceomics.workflow-submission.v1', requestId: row.request_id, requestHash: row.request_hash,
    instanceId: request.instanceId, projectId: row.project_id, jobId: row.job_id, analysisObjectId: request.analysisObjectId,
    stepId: request.stepId, seed: request.seed, packageDigest: request.packageDigest, status: row.status,
    createdAt: new Date(row.created_at).toISOString() };
}
async function submissionRow(client, userId, projectId, instanceId, requestId) {
  const { rows } = await client.query(`SELECT r.job_id,r.instance_id,r.original_instance_id,r.request_id,r.request_hash,r.request_json,r.step_id,
      j.project_id,j.analysis_object_id,j.status,j.created_at
    FROM workflow_runs r JOIN jobs j ON j.id=r.job_id
    WHERE j.owner_user_id=$1 AND j.project_id=$2 AND r.request_id=$3
      AND (r.original_instance_id=$4 OR (r.original_instance_id IS NULL AND r.instance_id=$4)) LIMIT 1`,
  [userId, projectId, requestId, instanceId]);
  return rows[0] || null;
}

function compileStep(workflow, state) {
  const run = state.active; const step = workflow.steps.find(step => step.id === run.stepId);
  const inputs = Object.entries(run.inputs).map(([name, input]) =>
    `inputs[[${JSON.stringify(name)}]] <- ${input.root ? 'obj' : `read_input(${JSON.stringify(input.id)})`}`).join('\n');
  const outputs = Object.fromEntries(Object.entries(step.outputs).map(([port, spec]) => [port, { name: `${port}.${extension(spec.type)}`, type: spec.type }]));
  const script = `# Pipeline: ${workflow.id}@${workflow.version} / ${step.id}
params <- jsonlite::fromJSON(${JSON.stringify(JSON.stringify(canonical(run.parameters)))}, simplifyVector = TRUE)
inputs <- list()
${inputs}
seed <- ${run.seed}
set.seed(seed)
.workflow_outputs <- jsonlite::fromJSON(${JSON.stringify(JSON.stringify(outputs))}, simplifyVector = FALSE)
write_output <- function(name, value, width = 7, height = 5) {
  spec <- .workflow_outputs[[name]]
  if (is.null(spec)) stop("Undeclared workflow output")
  if (spec$type == "figure") save_figure(value, spec$name, width = width, height = height)
  else if (spec$type == "rds") saveRDS(value, file.path("/work/output", spec$name))
  else jsonlite::write_json(value, file.path("/work/output", spec$name), auto_unbox = TRUE, digits = NA, na = "null")
}
${workflow.files[step.entry]}`;
  return { script, outputs };
}

function createWorkflowRuntime(db, provider = storage.createLocalStorageProvider(), { getEnvironment = getExpertREnvironment } = {}) {
  async function open(userId, projectId, analysisObjectId, source) {
    await authorize(db, userId, projectId);
    const api = await contract; const workflow = api.parseLegacyExecutableWorkflowPackage(source, { environmentProfiles: [EXPERT_R_PROFILE.id] });
    if (workflow.runtime.profileId !== EXPERT_R_PROFILE.id) throw error('This R runtime profile is not installed.');
    const checkpoint = await db.getLoadableCheckpointForAnalysisObject(projectId, analysisObjectId, userId);
    const packageDigest = digest(workflow);
    const root = { id: checkpoint.checkpointArtifactId, sha256: checkpoint.checksumSha256, sizeBytes: checkpoint.sizeBytes, type: 'rds', profileId: workflow.runtime.profileId, root: true };
    return transaction(db, async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const count = await client.query('SELECT COUNT(*)::int AS count FROM workflow_instances WHERE owner_user_id=$1', [userId]);
      const existing = await client.query('SELECT * FROM workflow_instances WHERE owner_user_id=$1 AND project_id=$2 AND analysis_object_id=$3 AND package_digest=$4 FOR UPDATE', [userId, projectId, analysisObjectId, packageDigest]);
      if (existing.rows[0]) {
        await client.query('UPDATE workflow_instances SET updated_at=now() WHERE id=$1', [existing.rows[0].id]);
        return publicInstance(await refreshRun(client, existing.rows[0]));
      }
      if (count.rows[0].count >= 20) throw error('Close an existing working workflow before opening more than 20.', 409);
      const { rows } = await client.query('INSERT INTO workflow_instances (id,owner_user_id,project_id,analysis_object_id,package_digest,package_json,state_json) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [identifier('wfi'), userId, projectId, analysisObjectId, packageDigest, workflow, api.createWorkflowState(root)]);
      return publicInstance(rows[0]);
    });
  }
  async function get(userId, projectId, id) {
    await authorize(db, userId, projectId);
    const result = await transaction(db, async client => {
      const row = await refreshRun(client, await lockedInstance(client, userId, projectId, id));
      await client.query('UPDATE workflow_instances SET updated_at=now() WHERE id=$1', [id]);
      return publicInstance(row);
    });
    if (result.state.error) await cleanup(userId, projectId).catch(() => console.warn('[workflow] Output cleanup will be retried.'));
    return result;
  }
  async function run(userId, projectId, id, input) {
    await authorize(db, userId, projectId, true);
    validateReceiptLocator(id, input?.requestId);
    const api = await contract;
    return transaction(db, async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      await lockExecutionAccess(client, userId, projectId);
      const row = await lockedInstance(client, userId, projectId, id);
      const request = admittedRequest(row, input, api);
      const requestHash = digest(request);
      const duplicate = await submissionRow(client, userId, projectId, id, input.requestId);
      if (duplicate) {
        retainedRequest(duplicate);
        if (duplicate.request_hash !== requestHash) throw error('This run request ID was already used with different workflow settings.', 409);
        return { ...publicInstance(await refreshRun(client, row)), submission: publicSubmission(duplicate) };
      }
      await refreshRun(client, row);
      const queued = await client.query("SELECT COUNT(*)::int AS count FROM jobs WHERE owner_user_id=$1 AND status IN ('queued','running')", [userId]);
      if (queued.rows[0].count >= 3) throw error('Wait for an existing job to finish.', 429);
      const used = await client.query("SELECT COALESCE(SUM((descriptor_json->>'sizeBytes')::bigint),0)::bigint AS bytes FROM workflow_artifacts WHERE owner_user_id=$1", [userId]);
      const reserved = await client.query("SELECT COUNT(*)::int AS count FROM workflow_runs r JOIN jobs j ON j.id=r.job_id WHERE j.owner_user_id=$1 AND j.status IN ('queued','running')", [userId]);
      if (Number(used.rows[0].bytes) + (reserved.rows[0].count + 1) * 200 * 1024 * 1024 > MAX_WORKING_BYTES) throw error('Workflow storage is full. Remove an unused snapshot or close a workflow before running again.', 409);
      const state = api.beginWorkflowRun(row.package_json, row.state_json, { id: identifier('job'), ...request });
      delete state.error;
      const compiled = compileStep(row.package_json, state);
      const environmentManifest = await getEnvironment();
      const parameters = storedExpertRParams(pinExpertREnvironment({ profileId: row.package_json.runtime.profileId, script: compiled.script, inputIds: [],
        ...(row.state_json.environment ? { environment: row.state_json.environment } : {}) }, environmentManifest));
      state.environment = parameters.environment;
      state.active.environment = parameters.environment;
      await db.getLoadableCheckpointForAnalysisObject(projectId, row.analysis_object_id, userId);
      await client.query(`WITH new_job AS (INSERT INTO jobs
        (id,owner_user_id,project_id,analysis_object_id,job_type,status,parameters_json,max_attempts)
        VALUES ($1,$2,$3,$4,'expert.r.v1','queued',$5,1) RETURNING *), retained_source AS (
          INSERT INTO execution_source_versions (id,project_id,owner_user_id,job_id,language,source_code,source_sha256)
          SELECT 'src_' || id,project_id,owner_user_id,id,'R',parameters_json::jsonb->>'script',parameters_json::jsonb->>'scriptSha256'
          FROM new_job RETURNING id
        ) SELECT id FROM new_job`, [state.active.id, userId, projectId, row.analysis_object_id, JSON.stringify(parameters)]);
      await client.query(`INSERT INTO workflow_runs (job_id,instance_id,original_instance_id,request_id,request_hash,request_json,step_id,generation,output_names_json)
        VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8)`, [state.active.id, id, input.requestId, requestHash, request, request.stepId, state.generation, JSON.stringify(Object.values(compiled.outputs).map(output => output.name))]);
      await client.query('UPDATE workflow_instances SET state_json=$2,updated_at=now() WHERE id=$1', [id, state]);
      const receipt = await submissionRow(client, userId, projectId, id, input.requestId);
      return { ...publicInstance({ ...row, state_json: state }), submission: publicSubmission(receipt) };
    });
  }
  async function submission(userId, projectId, instanceId, requestId) {
    await authorize(db, userId, projectId);
    validateReceiptLocator(instanceId, requestId);
    return transaction(db, async client => {
      const membership = await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId]);
      if (!['owner', 'admin', 'analyst'].includes(membership.rows[0]?.role)) throw error('Project access is unavailable.', 403);
      const row = await submissionRow(client, userId, projectId, instanceId, requestId);
      if (!row) throw error('Workflow submission not found.', 404);
      return publicSubmission(row);
    });
  }
  async function cancel(userId, projectId, id) {
    const instance = await get(userId, projectId, id);
    if (instance.state.active) await db.cancelProjectJob(userId, projectId, instance.state.active.id);
    return get(userId, projectId, id);
  }
  async function save(userId, projectId, id, name) {
    await authorize(db, userId, projectId);
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw error('A snapshot name of 1–100 characters is required.');
    return transaction(db, async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const row = await refreshRun(client, await lockedInstance(client, userId, projectId, id));
      const state = (await contract).snapshotWorkflowState(row.state_json);
      const count = await client.query('SELECT COUNT(*)::int AS count FROM workflow_snapshots WHERE owner_user_id=$1', [userId]);
      if (count.rows[0].count >= 40) throw error('Remove an unused workflow snapshot before saving more than 40.', 409);
      const snapshotId = identifier('wfs');
      await client.query('INSERT INTO workflow_snapshots (id,owner_user_id,project_id,analysis_object_id,name,package_digest,package_json,state_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [snapshotId, userId, projectId, row.analysis_object_id, name.trim(), row.package_digest, row.package_json, state]);
      return { id: snapshotId, name: name.trim() };
    });
  }
  async function snapshots(userId, projectId) {
    await authorize(db, userId, projectId);
    return (await db.query('SELECT id,name,analysis_object_id AS "analysisObjectId",created_at AS "createdAt" FROM workflow_snapshots WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC', [userId, projectId])).rows;
  }
  async function restore(userId, projectId, snapshotId) {
    await authorize(db, userId, projectId);
    const restored = await transaction(db, async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const { rows } = await client.query('SELECT * FROM workflow_snapshots WHERE id=$1 AND owner_user_id=$2 AND project_id=$3', [snapshotId, userId, projectId]);
      const saved = rows[0]; if (!saved) throw error('Snapshot not found.', 404);
      const existing = await client.query('SELECT * FROM workflow_instances WHERE owner_user_id=$1 AND project_id=$2 AND analysis_object_id=$3 AND package_digest=$4 FOR UPDATE', [userId, projectId, saved.analysis_object_id, saved.package_digest]);
      if (existing.rows[0]) await refreshRun(client, existing.rows[0]);
      if (existing.rows[0]?.state_json.active) throw error('Wait for the active run before opening a snapshot.', 409);
      if (!existing.rows[0]) {
        const count = await client.query('SELECT COUNT(*)::int AS count FROM workflow_instances WHERE owner_user_id=$1', [userId]);
        if (count.rows[0].count >= 20) throw error('Close an existing working workflow before opening more than 20.', 409);
      }
      const state = { ...saved.state_json, active: null, generation: (existing.rows[0]?.state_json.generation || 0) + 1 };
      const result = await client.query('INSERT INTO workflow_instances (id,owner_user_id,project_id,analysis_object_id,package_digest,package_json,state_json) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (owner_user_id,project_id,analysis_object_id,package_digest) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=now() RETURNING *',
        [identifier('wfi'), userId, projectId, saved.analysis_object_id, saved.package_digest, saved.package_json, state]);
      return publicInstance(result.rows[0]);
    });
    await cleanup(userId, projectId).catch(() => console.warn('[workflow] Output cleanup will be retried.'));
    return restored;
  }
  async function removeSnapshot(userId, projectId, id) {
    await authorize(db, userId, projectId);
    await transaction(db, async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      await client.query('DELETE FROM workflow_snapshots WHERE id=$1 AND owner_user_id=$2 AND project_id=$3', [id, userId, projectId]);
    });
    await cleanup(userId, projectId);
  }
  async function close(userId, projectId, id) {
    await authorize(db, userId, projectId);
    await transaction(db, async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const row = await refreshRun(client, await lockedInstance(client, userId, projectId, id));
      if (row.state_json.active) throw error('Cancel the active run before closing this workflow.', 409);
      await client.query('DELETE FROM workflow_instances WHERE id=$1', [id]);
    });
    await cleanup(userId, projectId);
  }
  async function cleanup(userId, projectId) {
    // Serialize collection with runs, saves, and restores using the owner's row.
    return transaction(db, async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const states = await client.query('SELECT state_json FROM workflow_instances WHERE owner_user_id=$1 AND project_id=$2 UNION ALL SELECT state_json FROM workflow_snapshots WHERE owner_user_id=$1 AND project_id=$2', [userId, projectId]);
      const retained = new Set();
      for (const { state_json: state } of states.rows) {
        for (const result of Object.values(state.results)) for (const output of Object.values(result.outputs)) retained.add(output.id);
        for (const input of Object.values(state.active?.inputs || {})) retained.add(input.id);
      }
      // Scientific analysis versions retain their exact linked evidence even
      // after a working workflow or its legacy snapshot has been closed.
      const analysisReferences = await client.query(`SELECT DISTINCT artifact.id FROM workflow_artifacts artifact JOIN (
        SELECT reference->>'versionId' AS id FROM (
          SELECT jsonb_array_elements(references_json) AS reference FROM research_analyses WHERE project_id=$1
          UNION ALL SELECT jsonb_array_elements(snapshot_json->'references') FROM research_analysis_revisions WHERE project_id=$1
        ) saved WHERE reference->>'kind'='artifact-version'
      ) linked ON linked.id=artifact.id WHERE artifact.project_id=$1 AND artifact.owner_user_id=$2`, [projectId, userId]);
      for (const { id } of analysisReferences.rows) retained.add(id);
      const artifacts = await client.query('SELECT id,storage_key FROM workflow_artifacts WHERE owner_user_id=$1 AND project_id=$2', [userId, projectId]);
      for (const artifact of artifacts.rows) if (!retained.has(artifact.id)) {
        // Delete files before their orphan records so a failed unlink remains retryable.
        await provider.remove(artifact.storage_key);
        await client.query('DELETE FROM workflow_artifacts WHERE id=$1', [artifact.id]);
      }
      const retainedKeys = new Set(artifacts.rows.filter(artifact => retained.has(artifact.id)).map(artifact => artifact.storage_key));
      const finished = await client.query("SELECT r.job_id,r.output_names_json FROM workflow_runs r JOIN jobs j ON j.id=r.job_id WHERE j.owner_user_id=$1 AND j.project_id=$2 AND j.status IN ('completed','failed','canceled')", [userId, projectId]);
      for (const run of finished.rows) for (const name of run.output_names_json) {
        const key = storage.projectStorageFileKey(projectId, 'artifacts', run.job_id, `workflow-output-${name}`);
        if (!retainedKeys.has(key)) await provider.remove(key);
      }
    });
  }
  async function artifact(userId, projectId, id) {
    await authorize(db, userId, projectId);
    const { rows } = await db.query('SELECT * FROM workflow_artifacts WHERE id=$1 AND owner_user_id=$2 AND project_id=$3', [id, userId, projectId]);
    if (!rows[0]) throw error('Output not found.', 404);
    return rows[0];
  }
  async function expire() {
    const candidates = await db.query("SELECT id,owner_user_id,project_id FROM workflow_instances WHERE updated_at < now() - interval '7 days'");
    for (const candidate of candidates.rows) {
      await transaction(db, async client => {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [candidate.owner_user_id]);
        const { rows } = await client.query("SELECT * FROM workflow_instances WHERE id=$1 AND updated_at < now() - interval '7 days' FOR UPDATE", [candidate.id]);
        if (!rows[0]) return;
        const row = await refreshRun(client, rows[0]);
        if (!row.state_json.active) await client.query('DELETE FROM workflow_instances WHERE id=$1', [row.id]);
      });
      await cleanup(candidate.owner_user_id, candidate.project_id);
    }
    const scopes = await db.query('SELECT DISTINCT j.owner_user_id,j.project_id FROM workflow_runs r JOIN jobs j ON j.id=r.job_id');
    for (const scope of scopes.rows) await cleanup(scope.owner_user_id, scope.project_id);
  }
  return { open, get, run, submission, cancel, save, snapshots, restore, removeSnapshot, close, cleanup, artifact, expire };
}

module.exports = { createWorkflowRuntime, compileStep, contract, digest, identifier, extension, transaction, authorize, lockExecutionAccess, publicInstance };
