'use strict';

const { contract, compileStep, transaction, digest, identifier, authorize, lockExecutionAccess, createWorkflowRuntime } = require('./workflowRuntime');
const { validateWorkflowOutput } = require('./workflowOutputs');
const storage = require('./storage');
const { EXPERT_R_RESOURCE_POLICY_VERSION } = require('./expertR');
const { assertEnvironmentMatches, readEnvironmentArtifact } = require('./rEnvironment');

function claimLost() { return Object.assign(new Error('The workflow run no longer owns this workspace.'), { code: 'CLAIM_LOST' }); }

async function runWorkflowJob(db, ctx, workerId, claimToken, provider) {
  const link = await db.query('SELECT instance_id FROM workflow_runs WHERE job_id=$1', [ctx.job.id]);
  if (!link.rows[0]) return null;
  const instance = (await db.query('SELECT * FROM workflow_instances WHERE id=$1', [link.rows[0].instance_id])).rows[0];
  if (!instance || instance.state_json.active?.id !== ctx.job.id) throw claimLost();
  const userId = Number(instance.owner_user_id); const projectId = instance.project_id;
  await authorize(db, userId, projectId, true);
  await ctx.getOwnedAnalysisObject();
  const checkpoint = await ctx.getHydrationCheckpoint();
  if (checkpoint.checkpointArtifactId !== instance.state_json.root.id || checkpoint.checksumSha256 !== instance.state_json.root.sha256
      || checkpoint.sizeBytes !== instance.state_json.root.sizeBytes) throw new Error('The exact workflow input changed. Review its saved source before starting another step.');
  const run = instance.state_json.active;
  const compiled = compileStep(instance.package_json, instance.state_json);
  if (ctx.job.parameters.script !== compiled.script) throw new Error('Workflow source does not match its pinned package.');
  const inputs = [];
  for (const input of Object.values(run.inputs)) {
    if (input.root || inputs.some(item => item.id === input.id)) continue;
    const { rows } = await db.query('SELECT storage_key,descriptor_json FROM workflow_artifacts WHERE id=$1 AND owner_user_id=$2 AND project_id=$3', [input.id, userId, projectId]);
    if (!rows[0] || rows[0].descriptor_json.sha256 !== input.sha256) throw new Error('Required workflow input is no longer available.');
    inputs.push({ id: input.id, originalFilename: `${input.id}.${input.type === 'rds' ? 'rds' : 'json'}`, internalStorageKey: rows[0].storage_key, sizeBytes: input.sizeBytes, checksumSha256: input.sha256 });
  }
  const outputStorageKey = storage.projectStorageFileKey(projectId, 'artifacts', ctx.job.id, 'workflow-output');
  await ctx.heartbeat();
  const result = await ctx.runExpertSandbox({
    jobId: ctx.job.id, projectId, profileId: instance.package_json.runtime.profileId,
    ...(ctx.job.parameters.environment ? { environment: ctx.job.parameters.environment } : {}),
    script: compiled.script, checkpointStorageKey: checkpoint.internalStorageKey,
    checkpointChecksumSha256: checkpoint.checksumSha256, checkpointSizeBytes: checkpoint.sizeBytes,
    privateInputs: inputs, outputStorageKey, workflowOutputs: compiled.outputs,
  });
  const files = result.workflowFiles;
  let environmentArtifact = null;
  if (ctx.job.parameters.environment) {
    assertEnvironmentMatches(ctx.job.parameters.environment, run.environment);
    assertEnvironmentMatches(ctx.job.parameters.environment, result.environment);
    if (result.environment.imageDigest !== result.sandboxImageDigest
        || result.environmentArtifact?.internalStorageKey !== `${outputStorageKey}.environment.json`) throw new Error('Invalid workflow environment response.');
    await readEnvironmentArtifact(provider, result.environmentArtifact, ctx.job.parameters.environment);
    environmentArtifact = { id: identifier('art'), checksumSha256: result.environmentArtifact.checksumSha256, sizeBytes: result.environmentArtifact.sizeBytes };
  }
  if (!result.saved || result.scriptSha256 !== digest(compiled.script) || result.checkpointChecksumSha256 !== checkpoint.checksumSha256
      || result.profileId !== instance.package_json.runtime.profileId || result.resourcePolicyVersion !== EXPERT_R_RESOURCE_POLICY_VERSION
      || !/^sha256:[a-f0-9]{64}$/.test(result.sandboxImageDigest || '') || !Array.isArray(files)
      || files.length !== Object.keys(compiled.outputs).length) throw new Error('Invalid workflow sandbox response.');
  if (files.reduce((total, file) => total + file.sizeBytes, 0) > 200 * 1024 * 1024) throw new Error('Workflow outputs exceed the run storage limit.');
  const outputs = {};
  for (const [port, declaration] of Object.entries(compiled.outputs)) {
    const file = files.find(file => file.name === declaration.name);
    const key = `${outputStorageKey}-${declaration.name}`;
    if (!file || file.storageKey !== key || !/^[a-f0-9]{64}$/.test(file.checksumSha256)
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 200 * 1024 * 1024) throw new Error('Invalid workflow output descriptor.');
    const specification = instance.package_json.steps.find(step => step.id === run.stepId).outputs[port];
    const output = { id: identifier('eri'), type: declaration.type, sha256: file.checksumSha256, sizeBytes: file.sizeBytes, profileId: result.profileId,
      ...(Object.hasOwn(specification, 'semantics') ? { semantics: specification.semantics } : {}) };
    await validateWorkflowOutput(provider, key, output);
    outputs[port] = output;
  }
  const producerKey = digest({ source: instance.package_json.files[instance.package_json.steps.find(step => step.id === run.stepId).entry], parameters: run.parameters, seed: run.seed, image: result.sandboxImageDigest, ...(result.environment ? { environment: result.environment.id } : {}) });
  await transaction(db, async client => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
    await lockExecutionAccess(client, userId, projectId);
    const job = (await client.query("SELECT * FROM jobs WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND status='running' AND lease_expires_at>now() FOR UPDATE", [ctx.job.id, workerId, claimToken])).rows[0];
    if (!job) throw claimLost();
    const current = (await client.query('SELECT * FROM workflow_instances WHERE id=$1 FOR UPDATE', [instance.id])).rows[0];
    await authorize(db, userId, projectId, true);
    const state = (await contract).commitWorkflowRun(instance.package_json, current.state_json, {
      id: ctx.job.id, generation: run.generation, outputs, producerKey,
      runtime: { profileId: result.profileId, imageDigest: result.sandboxImageDigest, resourcePolicyVersion: result.resourcePolicyVersion, scriptSha256: result.scriptSha256,
        ...(environmentArtifact ? { environment: result.environment, environmentArtifact } : {}) },
    });
    for (const [port, output] of Object.entries(outputs)) {
      await client.query('INSERT INTO workflow_artifacts (id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES ($1,$2,$3,$4,$5,$6)', [output.id, userId, projectId, ctx.job.id, output, `${outputStorageKey}-${compiled.outputs[port].name}`]);
    }
    if (environmentArtifact) await client.query(`INSERT INTO job_artifacts
      (id,project_id,job_id,created_by_user_id,analysis_object_id,artifact_type,name,mime_type,storage_kind,storage_uri,checksum_sha256,size_bytes,status,metadata_json)
      VALUES ($1,$2,$3,$4,$5,'expert_r_environment','Exact R environment','application/json','local_internal',$6,$7,$8,'available',$9)`,
    [environmentArtifact.id,projectId,ctx.job.id,userId,instance.analysis_object_id,result.environmentArtifact.internalStorageKey,environmentArtifact.checksumSha256,environmentArtifact.sizeBytes,JSON.stringify({ environment: result.environment })]);
    await client.query('UPDATE workflow_instances SET state_json=$2,updated_at=now() WHERE id=$1', [instance.id, state]);
    await client.query("UPDATE jobs SET status='completed',completed_at=now(),updated_at=now(),heartbeat_at=now(),claim_token=NULL,lease_expires_at=NULL WHERE id=$1", [ctx.job.id]);
  });
  await createWorkflowRuntime(db, provider).cleanup(userId, projectId).catch(() => console.warn('[workflow] Output cleanup will be retried.'));
  return { workflowCommitted: true, result: { handled: 'workflow', instanceId: instance.id } };
}

module.exports = { runWorkflowJob };
