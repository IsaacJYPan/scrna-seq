import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { packWorkflow } from '../scripts/pack-workflow.mjs';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createWorkflowRuntime, compileStep, digest } = require('./workflowRuntime');
const { createJobWorker } = require('./jobWorker');
const { EXPERT_R_RESOURCE_POLICY_VERSION } = require('./expertR');
const { environmentFixture } = require('./_r-environment-test-utils');
const { environmentBytes } = require('./rEnvironment');
const exactEnvironment = environmentFixture();
const configured = Boolean(process.env.DATABASE_URL);
const environment = ['APP_DEPLOYMENT_MODE', 'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN', 'EXPERT_R_ACCESS_POLICY'];
let savedEnvironment, directory, provider, runtime, source, user, project, object, instance;
let server, http;
let replacement = 'first';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');

describe.skipIf(!configured)('workflow runtime', () => {
  beforeAll(async () => {
    savedEnvironment = Object.fromEntries(environment.map(key => [key, process.env[key]]));
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true', EXPERT_R_SANDBOX_URL: 'http://127.0.0.1:8090', EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64) });
    directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-workflow-test-'));
    await packWorkflow(path.resolve('examples/pipelines/scrna-workflow'), path.join(directory, 'pipeline.json'));
    source = await readFile(path.join(directory, 'pipeline.json'), 'utf8');
    http = require('./_http-test-utils');
    server = await http.startServer();
  });
  beforeEach(async () => {
    delete process.env.EXPERT_R_ACCESS_POLICY;
    await db.resetSchemaForTests();
    provider = storage.createLocalStorageProvider({ root: path.join(directory, Math.random().toString(16).slice(2)) });
    runtime = createWorkflowRuntime(db, provider, { getEnvironment: async () => exactEnvironment.manifest });
    user = await db.createUser('workflow@example.test', 'password123', 'Workflow owner');
    const organization = await db.createOrganizationForUser(user.id, { name: 'Lab' });
    project = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Study' });
    object = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat', displayName: 'Input' });
    await db.setExpertRExecutorByEmail(user.email, true);
    const seed = await db.createProjectJob(user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [seed.id]);
    const key = storage.projectStorageFileKey(project.id, 'checkpoints', seed.id, 'input.rds');
    const input = Buffer.from('test-checkpoint');
    await writeFile(provider.prepareWrite(key), input);
    await db.query("INSERT INTO job_artifacts (id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES ($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')", [db.genId('art'), project.id, seed.id, user.id, object.id, key, digest(input), input.length]);
    instance = await runtime.open(user.id, project.id, object.id, source);
    replacement = 'first';
  });
  afterAll(async () => {
    if (!configured) return;
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(savedEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function fakeSandbox(input) {
    const environmentKey = `${input.outputStorageKey}.environment.json`;
    const bytes = environmentBytes(exactEnvironment.manifest);
    await writeFile(provider.prepareWrite(environmentKey), bytes, { flag: 'wx' });
    const workflowFiles = [];
    for (const declaration of Object.values(input.workflowOutputs)) {
      const bytes = declaration.type === 'rds' ? Buffer.from(replacement)
        : declaration.type === 'figure' ? png : Buffer.from(JSON.stringify(declaration.type === 'metrics' ? { cells: 80, features: 1000 }
          : declaration.type === 'scatter' ? { x: [1], y: [2], ids: ['cell-1'] } : [{ cell: 'cell-1', cluster: '0' }]));
      const storageKey = `${input.outputStorageKey}-${declaration.name}`;
      await writeFile(provider.prepareWrite(storageKey), bytes, { flag: 'wx' });
      workflowFiles.push({ name: declaration.name, storageKey, sizeBytes: bytes.length, checksumSha256: digest(bytes) });
    }
    return { saved: true, workflowFiles, scriptSha256: digest(input.script), checkpointChecksumSha256: input.checkpointChecksumSha256, profileId: input.profileId, sandboxImageDigest: `sha256:${'a'.repeat(64)}`, resourcePolicyVersion: EXPERT_R_RESOURCE_POLICY_VERSION,
      environment: exactEnvironment.reference, environmentArtifact: { internalStorageKey: environmentKey, checksumSha256: digest(bytes), sizeBytes: bytes.length } };
  }
  async function execute(stepId, sandbox = fakeSandbox) {
    instance = await runtime.run(user.id, project.id, instance.id, { requestId: crypto.randomUUID(), stepId });
    const worker = createJobWorker({ db, storageProvider: provider, allowedJobTypes: ['expert.r.v1'], runExpertSandbox: sandbox, logger: { info() {}, warn() {}, error() {} } });
    const result = await worker.runOnce();
    instance = await runtime.get(user.id, project.id, instance.id);
    return result;
  }

  it('runs through the existing queue without saving an analysis object for every step', async () => {
    expect(await execute('qc')).toMatchObject({ status: 'completed' });
    expect((await execute('normalize')).status).toBe('completed');
    expect((await execute('pca')).status).toBe('completed');
    expect((await execute('umap')).status).toBe('completed');
    expect(Object.keys(instance.state.results).sort()).toEqual(['normalize', 'pca', 'qc', 'umap']);
    expect((await db.listProjectAnalysisObjects(user.id, project.id)).length).toBe(1);
    expect(JSON.stringify(instance)).not.toContain('storage_key');
    const jobs = await db.query("SELECT parameters_json FROM jobs WHERE job_type='expert.r.v1'");
    expect(jobs.rows.every(row => !Object.hasOwn(JSON.parse(row.parameters_json), 'script'))).toBe(true);
    const output = instance.state.results.qc.outputs.summary;
    expect(output.semantics).toEqual(instance.package.steps.find(step => step.id === 'qc').outputs.summary.semantics);
    expect((await runtime.artifact(user.id, project.id, output.id)).descriptor_json.semantics).toEqual(output.semantics);
    const { createArtifactVersionService } = require('./artifactVersions');
    const preview = await createArtifactVersionService(db, provider).preview(user.id, project.id, output.id);
    expect(preview.preview).toMatchObject({ semantics: { role: 'diagnostic', title: 'Dataset after quality filters' },
      items: [{ key: 'cells', value: 80, label: 'Retained cells', unit: 'cells' }, { key: 'features', value: 1000, label: 'Measured features', unit: 'features' }] });
  });
  it('runs a role-authorized workflow without an individual grant and enforces explicit denial', async () => {
    process.env.EXPERT_R_ACCESS_POLICY = 'project-roles';
    await db.query("DELETE FROM platform_capabilities WHERE user_id=$1 AND capability='expert_r.execute'", [user.id]);
    expect((await execute('qc')).status).toBe('completed');
    instance = await runtime.run(user.id, project.id, instance.id, { requestId: crypto.randomUUID(), stepId: 'normalize' });
    const queuedId = instance.state.active.id;
    await db.setExpertRExecutorByEmail(user.email, false);
    expect(await db.claimNextJob('role-revoked-workflow', { allowedJobTypes: ['expert.r.v1'], leaseSeconds: 30 })).toBeNull();
    expect((await db.getProjectJob(user.id, project.id, queuedId)).status).toBe('canceled');
    await expect(runtime.run(user.id, project.id, instance.id, { requestId: crypto.randomUUID(), stepId: 'normalize' })).rejects.toMatchObject({ status: 403 });
    expect((await runtime.get(user.id, project.id, instance.id)).state.results.qc).toBeTruthy();
  });
  it('keeps working data on failure, then clears dependent output after a changed rerun', async () => {
    await execute('qc'); await execute('normalize');
    const before = instance.state.results;
    expect((await execute('qc', async () => { throw new Error('Script failed'); })).status).toBe('failed');
    expect(instance.state.results).toEqual(before);
    replacement = 'changed';
    expect((await execute('qc')).status).toBe('completed');
    expect(Object.keys(instance.state.results)).toEqual(['qc']);
  });
  it('retains downstream results for unchanged output and cleans duplicate temporary files', async () => {
    await execute('qc'); await execute('normalize');
    const before = instance.state.results;
    await execute('qc');
    expect(instance.state.results.normalize).toEqual(before.normalize);
    expect(instance.state.results.qc.outputs).toEqual(before.qc.outputs);
    expect(instance.state.results.qc.producerKey).toEqual(before.qc.producerKey);
    expect(instance.state.results.qc.runtime.environment).toEqual(before.qc.runtime.environment);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_artifacts')).rows[0].count).toBe(4);
  });
  it('pins saved files across resets and restores one consistent workflow', async () => {
    await execute('qc'); await execute('normalize');
    const saved = await runtime.save(user.id, project.id, instance.id, 'Before filtering');
    const state = instance.state;
    replacement = 'changed'; await execute('qc');
    const restored = await runtime.restore(user.id, project.id, saved.id);
    expect(restored.state.results).toEqual(state.results);
    await runtime.cleanup(user.id, project.id);
    const output = restored.state.results.normalize.outputs.analysis;
    expect((await runtime.artifact(user.id, project.id, output.id)).descriptor_json.sha256).toBe(output.sha256);
  });
  it('retains a snapshot environment and refuses execution on a changed worker without replacing it',async()=>{
    await execute('qc');
    expect(instance.state.environment).toEqual(exactEnvironment.reference);
    const saved=await runtime.save(user.id,project.id,instance.id,'Exact environment');
    await runtime.close(user.id,project.id,instance.id);
    const changed=createWorkflowRuntime(db,provider,{getEnvironment:async()=>environmentFixture('b').manifest});
    const restored=await changed.restore(user.id,project.id,saved.id);
    expect(restored.state.environment).toEqual(exactEnvironment.reference);
    await expect(changed.run(user.id,project.id,restored.id,{requestId:crypto.randomUUID(),stepId:'qc'})).rejects.toMatchObject({code:'R_ENVIRONMENT_MISMATCH'});
    expect((await changed.get(user.id,project.id,restored.id)).state.results).toEqual(restored.state.results);
    expect((await db.query("SELECT COUNT(*)::int AS count FROM jobs WHERE status='queued'")).rows[0].count).toBe(0);
  });
  it('atomically retains exact compiled source privately after terminal parameter redaction',async()=>{
    instance=await runtime.run(user.id,project.id,instance.id,{requestId:crypto.randomUUID(),stepId:'qc'});
    const jobId=instance.state.active.id;const source=compileStep(instance.package,instance.state).script;
    const worker=createJobWorker({db,storageProvider:provider,allowedJobTypes:['expert.r.v1'],runExpertSandbox:fakeSandbox,logger:{info(){},warn(){},error(){}}});
    expect((await worker.runOnce()).status).toBe('completed');
    const retained=(await db.query('SELECT * FROM execution_source_versions WHERE job_id=$1',[jobId])).rows[0];
    expect(retained).toMatchObject({id:`src_${jobId}`,owner_user_id:String(user.id),project_id:project.id,language:'R',source_code:source,source_sha256:digest(source)});
    const params=JSON.parse((await db.query('SELECT parameters_json FROM jobs WHERE id=$1',[jobId])).rows[0].parameters_json);
    expect(params.script).toBeUndefined();expect(params.environment).toEqual(exactEnvironment.reference);
  });
  it('serializes competing run submissions and makes a retried request idempotent', async () => {
    const request = { requestId: crypto.randomUUID(), stepId: 'qc' };
    const responses = await Promise.all([runtime.run(user.id, project.id, instance.id, request), runtime.run(user.id, project.id, instance.id, request)]);
    expect(responses[0].state.active.id).toBe(responses[1].state.active.id);
    await expect(runtime.run(user.id, project.id, instance.id, { ...request, requestId: crypto.randomUUID() })).rejects.toThrow(/already running/);
    await runtime.cancel(user.id, project.id, instance.id);
    expect((await runtime.get(user.id, project.id, instance.id)).state.active).toBeNull();
  });
  it('rejects missing dependencies, collaborator access, and revoked execution permission', async () => {
    await expect(runtime.run(user.id, project.id, instance.id, { requestId: crypto.randomUUID(), stepId: 'pca' })).rejects.toThrow(/missing/);
    const other = await db.createUser('other@example.test', 'password123', 'Other');
    await db.addProjectMemberByEmail(project.id, other.email, 'analyst', { userId: user.id });
    await expect(runtime.get(other.id, project.id, instance.id)).rejects.toMatchObject({ status: 404 });
    await db.setExpertRExecutorByEmail(user.email, false);
    await expect(runtime.run(user.id, project.id, instance.id, { requestId: crypto.randomUUID(), stepId: 'qc' })).rejects.toMatchObject({ status: 403 });
  });
  it('requires authentication and a trusted origin at the HTTP boundary', async () => {
    const token = http.serverModule.issueSession(user);
    const url = `/api/workflows/${project.id}/open`;
    expect((await http.api(server, `/api/workflows/${project.id}/snapshots`)).status).toBe(401);
    expect((await http.api(server, url, { method: 'POST', token, headers: { Origin: 'https://untrusted.example' }, body: { source, analysisObjectId: object.id } })).status).toBe(403);
    const opened = await http.api(server, url, { method: 'POST', token, body: { source, analysisObjectId: object.id } });
    expect(opened.status).toBe(200);
    expect(opened.data.id).toBe(instance.id);
    expect((await db.query("SELECT COUNT(*)::int AS count FROM jobs WHERE job_type='expert.r.v1'")).rows[0].count).toBe(0);
  });
  it('keeps workflow state and output routes private even from another project analyst', async () => {
    await execute('qc');
    const other = await http.createUserWithToken({ email: 'http-other@example.test', displayName: 'Other' });
    await db.addProjectMemberByEmail(project.id, other.user.email, 'analyst', { userId: user.id });
    const root = `/api/workflows/${project.id}`;
    expect((await http.api(server, `${root}/instances/${instance.id}`, { token: other.token })).status).toBe(404);
    expect((await http.api(server, `${root}/artifacts/${instance.state.results.qc.outputs.summary.id}`, { token: other.token })).status).toBe(404);
  });
  it('does not publish results if permission is revoked during execution', async () => {
    expect((await execute('qc', async input => {
      const result = await fakeSandbox(input);
      await db.setExpertRExecutorByEmail(user.email, false);
      return result;
    })).status).toBe('failed');
    expect(instance.state.results).toEqual({});
  });
  it('rejects a late sandbox completion after cancellation and removes its unreferenced files', async () => {
    await execute('qc');
    const previous = instance.state.results;
    replacement = 'canceled replacement';
    await execute('qc', async input => {
      const result = await fakeSandbox(input);
      await runtime.cancel(user.id, project.id, instance.id);
      return result;
    });
    expect(instance.state.results).toEqual(previous);
    await runtime.cleanup(user.id, project.id);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_artifacts')).rows[0].count).toBe(3);
  });
  it('reserves room for a replacement before admitting a job and leaves current results intact on refusal', async () => {
    await execute('qc');
    const previous = instance.state.results;
    await db.query("UPDATE workflow_artifacts SET descriptor_json=jsonb_set(descriptor_json,'{sizeBytes}','900000000') WHERE id=$1", [previous.qc.outputs.analysis.id]);
    await expect(runtime.run(user.id, project.id, instance.id, { requestId: crypto.randomUUID(), stepId: 'normalize' })).rejects.toMatchObject({ status: 409 });
    expect((await runtime.get(user.id, project.id, instance.id)).state.results).toEqual(previous);
  });
  it('reopens persisted working state through a new runtime without creating a duplicate instance', async () => {
    await execute('qc');
    const restarted = createWorkflowRuntime(db, provider);
    const reopened = await restarted.open(user.id, project.id, object.id, source);
    expect(reopened.id).toBe(instance.id);
    expect(reopened.state).toEqual(instance.state);
    await restarted.close(user.id, project.id, reopened.id);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_artifacts')).rows[0].count).toBe(0);
  });
  it('expires abandoned working data while preserving explicitly saved snapshots', async () => {
    await execute('qc');
    const saved = await runtime.save(user.id, project.id, instance.id, 'Kept');
    await db.query("UPDATE workflow_instances SET updated_at=now()-interval '8 days'");
    await runtime.expire();
    await expect(runtime.get(user.id, project.id, instance.id)).rejects.toMatchObject({ status: 404 });
    expect((await runtime.restore(user.id, project.id, saved.id)).state.results.qc).toBeTruthy();
  });
});
