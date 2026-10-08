'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const storage = require('./storage');
const environments = require('./rEnvironment');
const { EXPERT_R_PROFILE } = require('./expertR');
const { digest, compileStep } = require('./workflowRuntime');
const { recordLiveRExecution } = require('./liveExecutionJournal');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = (projectId, jobId, name) => storage.projectStorageFileKey(projectId, 'artifacts', jobId, name);

function environmentFixture() {
  return environments.validateEnvironmentManifest({ schema: environments.ENVIRONMENT_SCHEMA, profileId: EXPERT_R_PROFILE.id,
    runtime: { imageReference: 'registry.example.test/research/runtime@sha256:' + 'a'.repeat(64), imageDigest: 'sha256:' + 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), os: 'linux', architecture: 'amd64', distribution: { id: 'ubuntu', version: '24.04' }, snapshotScope: 'container-userspace', kernel: 'worker-host' },
    r: { version: '4.5.1', platform: 'x86_64-pc-linux-gnu', bioconductor: '3.22' },
    packages: [{ name: 'base', version: '4.5.1', source: { kind: 'r-distribution' } }, { name: 'Seurat', version: '5.3.0', source: { kind: 'recorded', repository: 'CRAN', url: 'https://cran.r-project.org/src/contrib/' } }],
    systemPackages: [{ name: 'libc6', version: '2.39', architecture: 'amd64' }], lock: { format: 'installed-package-inventory.v1', sourceArchivesIncluded: false },
  });
}
async function seedExecutionHistory(db, provider, userId, projectId) {
  const object = await db.createProjectAnalysisObject(userId, projectId, { objectType: 'seurat', displayName: 'History input analysis' });
  const guided = await db.createProjectJob(userId, projectId, { jobType: 'generic', analysisObjectId: object.id, parameters: { dims: 10 } });
  await db.query("UPDATE jobs SET job_type='deg.find_markers.v1',status='completed',started_at=now()-interval '2 minutes',completed_at=now() WHERE id=$1", [guided.id]);
  const result = db.genId('art'); const bytes = Buffer.from('gene,score\nGENE_A,2\n'); const resultKey = key(projectId, guided.id, 'markers.csv');
  await fs.writeFile(provider.prepareWrite(resultKey), bytes);
  await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,name,storage_kind,storage_uri,checksum_sha256,size_bytes,status,metadata_json) VALUES($1,$2,$3,$4,'deg_markers','Recorded gene scores','local_internal',$5,$6,$7,'available',$8)", [result, projectId, guided.id, userId, resultKey, sha(bytes), bytes.length, JSON.stringify({ resolvedParams: { dims: 10, minPct: 0.1 }, defaultsApplied: ['minPct'] })]);
  await db.createProjectProvenance(userId, projectId, { jobId: guided.id, analysisObjectId: object.id, language: 'R', languageVersion: '4.5.1', script: 'FindAllMarkers(object, min.pct = 0.1)', parameters: { dims: 10, minPct: 0.1 }, operation: 'markers' });
  const imported = await db.createProjectProvenance(userId, projectId, { analysisObjectId: object.id, language: 'R', languageVersion: '4.5.1', script: 'ncol(object)', parameters: { execution: { generation: 'c'.repeat(64), order: 999 } }, operation: 'imported-count' });
  // These are retained-record fixtures, never scientific deserialization or an executed method.
  const checkpointId = db.genId('art'); const checkpointBytes = Buffer.from('Opaque saved checkpoint fixture.');
  const checkpointKey = storage.projectStorageFileKey(projectId, 'checkpoints', guided.id, 'input.rds');
  await fs.writeFile(provider.prepareWrite(checkpointKey), checkpointBytes);
  await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,name,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES($1,$2,$3,$4,'checkpoint','Recorded saved input',$5,'local_internal',$6,$7,$8,'available')", [checkpointId, projectId, guided.id, userId, object.id, checkpointKey, sha(checkpointBytes), checkpointBytes.length]);
  const live = await recordLiveRExecution({ db, req: { method: 'GET', verifiedObjectId: object.id, user: { id: userId } }, envelope: {
    provenance: { language: 'R', languageVersion: '4.5.1', script: 'object <- RunPCA(object, npcs = 10)', parameters: { npcs: 10 }, operation: 'pca', timestamp: '2026-10-08T10:00:00Z', execution: { generation: 'c'.repeat(64), order: 7, packages: [{ name: 'Seurat', version: '5.3.0' }] } }, live_state: { live_revision: 3 }, result: { nCells: 3 },
  } });
  const manifest = environmentFixture(); const environment = environments.summarizeEnvironmentManifest(manifest);
  const expert = await db.createProjectJob(userId, projectId, { jobType: 'generic', analysisObjectId: object.id });
  const script = 'table <- data.frame(cells = ncol(obj))';
  await db.query("UPDATE jobs SET job_type='expert.r.v1',status='completed',parameters_json=$2,started_at=now()-interval '1 minute',completed_at=now() WHERE id=$1", [expert.id, JSON.stringify({ profileId: EXPERT_R_PROFILE.id, scriptSha256: sha(script), inputIds: [], environment })]);
  const environmentId = db.genId('art'); const environmentBytes = environments.environmentBytes(manifest); const environmentKey = key(projectId, expert.id, 'environment.json');
  await fs.writeFile(provider.prepareWrite(environmentKey), environmentBytes);
  await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,name,storage_kind,storage_uri,checksum_sha256,size_bytes,status,metadata_json) VALUES($1,$2,$3,$4,'expert_r_environment','Private environment manifest','local_internal',$5,$6,$7,'available',$8)", [environmentId, projectId, expert.id, userId, environmentKey, sha(environmentBytes), environmentBytes.length, JSON.stringify({ environment, environmentArtifact: { id: environmentId, checksumSha256: sha(environmentBytes), sizeBytes: environmentBytes.length } })]);
  const recipe = { format: 'traceomics-workflow', schemaVersion: 1, id: 'history-summary', name: 'History summary', version: '1.0.0', description: 'Read the supplied saved object.', runtime: { language: 'r', profileId: EXPERT_R_PROFILE.id }, files: { 'summary.R': 'write_output("summary", list(cells = ncol(inputs$analysis)))' }, steps: [{ id: 'summary', label: 'Summary', entry: 'summary.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } }, parameters: [{ key: 'threshold', label: 'Threshold', type: 'number', default: 1, min: 0, max: 100 }], outputs: { summary: { type: 'metrics', label: 'Cell count' } } }], tabs: [{ id: 'summary', label: 'Summary', step: 'summary', plots: [] }] };
  const workflow = await db.createProjectJob(userId, projectId, { jobType: 'generic', analysisObjectId: object.id });
  const instanceId = 'wfi_' + crypto.randomBytes(12).toString('hex'); const outputId = 'eri_' + crypto.randomBytes(12).toString('hex');
  const input = { id: checkpointId, sha256: sha(checkpointBytes), sizeBytes: checkpointBytes.length, type: 'rds', profileId: EXPERT_R_PROFILE.id, root: true };
  const run = { id: workflow.id, stepId: 'summary', generation: 9, parameters: { threshold: 2 }, seed: 42, inputs: { analysis: input } };
  const compiled = compileStep(recipe, { active: run }); const scriptSha256 = sha(compiled.script);
  const outputBytes = Buffer.from('{"cells":3}'); const outputKey = key(projectId, workflow.id, 'summary.json');
  await fs.writeFile(provider.prepareWrite(outputKey), outputBytes);
  const descriptor = { id: outputId, sha256: sha(outputBytes), sizeBytes: outputBytes.length, type: 'metrics', profileId: EXPERT_R_PROFILE.id };
  const state = { generation: 10, root: input, active: null, results: { summary: { outputs: { summary: descriptor }, inputs: run.inputs, parameters: run.parameters, seed: run.seed, runtime: { profileId: EXPERT_R_PROFILE.id, imageDigest: manifest.runtime.imageDigest, scriptSha256 } } } };
  await db.query('INSERT INTO workflow_instances(id,owner_user_id,project_id,analysis_object_id,package_digest,package_json,state_json) VALUES($1,$2,$3,$4,$5,$6,$7)', [instanceId, userId, projectId, object.id, digest(recipe), recipe, state]);
  await db.query('INSERT INTO workflow_runs(job_id,instance_id,request_id,step_id,generation) VALUES($1,$2,$3,$4,$5)', [workflow.id, instanceId, crypto.randomUUID(), 'summary', 9]);
  await db.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [outputId, userId, projectId, workflow.id, descriptor, outputKey]);
  await db.query("UPDATE jobs SET job_type='expert.r.v1',status='completed',parameters_json=$2,started_at=now()-interval '1 minute',completed_at=now() WHERE id=$1", [workflow.id, JSON.stringify({ profileId: EXPERT_R_PROFILE.id, scriptSha256, inputIds: [] })]);
  return { object, guided, result: { id: result, key: resultKey, bytes, sha256: sha(bytes) }, checkpoint: { id: checkpointId, sha256: sha(checkpointBytes) }, imported, live, expert, environment: { id: environmentId, key: environmentKey, manifest, reference: environment }, workflow: { ...workflow, instanceId, outputId, state, recipe } };
}

async function seedRetainedExpertSource(db, userId, projectId, analysisObjectId, environment) {
  const variables = ['APP_DEPLOYMENT_MODE', 'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN', 'EXPERT_R_ACCESS_POLICY'];
  const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true', EXPERT_R_SANDBOX_URL: 'http://127.0.0.1:8090', EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64), EXPERT_R_ACCESS_POLICY: 'project-roles' });
    const code = 'count <- ncol(obj)\nprint(count)';
    const job = await db.createProjectJob(userId, projectId, { jobType: 'expert.r.v1', analysisObjectId, parameters: { profileId: EXPERT_R_PROFILE.id, script: code, inputIds: [], environment } });
    await db.query("UPDATE jobs SET status='failed',completed_at=now() WHERE id=$1", [job.id]);
    return { ...job, code, sourceVersionId: 'src_' + job.id, sourceSha256: sha(code) };
  } finally { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

module.exports = { seedExecutionHistory, seedRetainedExpertSource, environmentFixture, sha };
