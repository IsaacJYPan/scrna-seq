import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const db = require('./pgDatabase');
const storage = require('./storage');
const { createWorkflowRuntime, digest } = require('./workflowRuntime');
const { EXPERT_R_PROFILE } = require('./expertR');
const { environmentFixture } = require('./_r-environment-test-utils');
const exactEnvironment = environmentFixture();
const configured = Boolean(process.env.DATABASE_URL);
const keys = ['APP_DEPLOYMENT_MODE', 'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN', 'EXPERT_R_ACCESS_POLICY'];
const source = JSON.stringify({ format: 'traceomics-workflow', schemaVersion: 1, id: 'receipt-test', name: 'Receipt test', version: '1.0.0', description: 'Two independently runnable inspection steps.',
  runtime: { language: 'r', profileId: EXPERT_R_PROFILE.id }, files: { 'inspect.R': 'write_output("summary", list(cells = ncol(inputs$analysis)))' },
  steps: ['inspect', 'review'].map(id => ({ id, label: id === 'inspect' ? 'Inspect' : 'Review', entry: 'inspect.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } },
    parameters: [{ key: 'cells', type: 'integer', label: 'Cells', default: 5, min: 1, max: 20 }], outputs: { summary: { type: 'metrics', label: 'Summary' } } })),
  tabs: [{ id: 'inspect-tab', label: 'Inspect', step: 'inspect', plots: [] }, { id: 'review-tab', label: 'Review', step: 'review', plots: [] }] });
let saved, directory, provider, runtime, user, project, object, instance, server, http, environmentReads;

describe.skipIf(!configured)('immutable workflow submission receipts', () => {
  beforeAll(async () => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true', EXPERT_R_SANDBOX_URL: 'http://127.0.0.1:8090', EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64) });
    directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-workflow-receipts-'));
    http = require('./_http-test-utils');
    server = await http.startServer();
  });
  beforeEach(async () => {
    delete process.env.EXPERT_R_ACCESS_POLICY;
    await db.resetSchemaForTests();
    provider = storage.createLocalStorageProvider({ root: path.join(directory, crypto.randomUUID()) });
    environmentReads = 0;
    runtime = createWorkflowRuntime(db, provider, { getEnvironment: async () => { environmentReads++; return exactEnvironment.manifest; } });
    user = await db.createUser('workflow-receipts@example.test', 'password123', 'Workflow owner');
    const organization = await db.createOrganizationForUser(user.id, { name: 'Receipt lab' });
    project = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Receipt study' });
    object = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat', displayName: 'Input' });
    await db.setExpertRExecutorByEmail(user.email, true);
    const seed = await db.createProjectJob(user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [seed.id]);
    const key = storage.projectStorageFileKey(project.id, 'checkpoints', seed.id, 'input.rds');
    const input = Buffer.from('receipt-checkpoint');
    await writeFile(provider.prepareWrite(key), input);
    await db.query("INSERT INTO job_artifacts (id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES ($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')",
      [db.genId('art'), project.id, seed.id, user.id, object.id, key, digest(input), input.length]);
    instance = await runtime.open(user.id, project.id, object.id, source);
  });
  afterAll(async () => {
    if (!configured) return;
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const request = (extra = {}) => ({ requestId: crypto.randomUUID(), stepId: 'inspect', ...extra });
  const submit = input => runtime.run(user.id, project.id, instance.id, input);
  const receipt = requestId => runtime.submission(user.id, project.id, instance.id, requestId);
  const receiptUrl = requestId => `/api/workflows/${project.id}/instances/${instance.id}/submissions/${requestId}`;

  it('atomically admits one job and returns one original receipt for eight concurrent identical requests', async () => {
    const input = request();
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(input)));
    expect(new Set(responses.map(result => result.submission.jobId)).size).toBe(1);
    expect(responses.every(result => result.state.active.id === result.submission.jobId)).toBe(true);
    const original = responses[0].submission;
    expect(original).toMatchObject({ schema: 'traceomics.workflow-submission.v1', requestId: input.requestId, instanceId: instance.id,
      projectId: project.id, analysisObjectId: object.id, stepId: 'inspect', seed: 1, packageDigest: instance.packageDigest, status: 'queued' });
    expect(original.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(environmentReads).toBe(1);
    expect((await db.query("SELECT COUNT(*)::int AS count FROM jobs WHERE job_type='expert.r.v1'")).rows[0].count).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_runs')).rows[0].count).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM execution_source_versions WHERE job_id=$1', [original.jobId])).rows[0].count).toBe(1);
  });

  it('compares defaults after normalization and rejects changed step, parameters or seed without another job', async () => {
    const input = request();
    const original = (await submit(input)).submission;
    expect((await submit({ ...input, parameters: { cells: 5 }, seed: 1 })).submission).toEqual(original);
    for (const changed of [{ stepId: 'review' }, { parameters: { cells: 4 } }, { seed: 2 }]) {
      await expect(submit({ ...input, ...changed })).rejects.toMatchObject({ status: 409 });
    }
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_runs')).rows[0].count).toBe(1);
    expect(environmentReads).toBe(1);
  });

  it('recovers a committed request and duplicate response when the worker environment is unavailable', async () => {
    const input = request();
    const admitted = (await submit(input)).submission;
    const restarted = createWorkflowRuntime(db, provider, { getEnvironment: async () => { throw new Error('Broker unavailable'); } });
    expect(await restarted.submission(user.id, project.id, instance.id, input.requestId)).toEqual(admitted);
    expect((await restarted.run(user.id, project.id, instance.id, input)).submission).toEqual(admitted);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_runs')).rows[0].count).toBe(1);
  });

  it('returns the original terminal job while a later instance run is active and leaves current state untouched', async () => {
    const first = request();
    const original = (await submit(first)).submission;
    await db.query("UPDATE jobs SET status='failed' WHERE id=$1", [original.jobId]);
    await runtime.get(user.id, project.id, instance.id);
    const later = await submit(request({ stepId: 'review', seed: 7 }));
    const duplicate = await submit(first);
    expect(duplicate.submission).toEqual({ ...original, status: 'failed' });
    expect(duplicate.state).toEqual(later.state);
    expect(duplicate.state.active.id).not.toBe(duplicate.submission.jobId);
    expect(await receipt(first.requestId)).toEqual(duplicate.submission);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_runs')).rows[0].count).toBe(2);
  });

  it('reads retained original identity after close and does not confuse a newly opened instance using that UUID', async () => {
    const input = request();
    const original = (await submit(input)).submission;
    await runtime.cancel(user.id, project.id, instance.id);
    await runtime.close(user.id, project.id, instance.id);
    expect(await receipt(input.requestId)).toEqual({ ...original, status: 'canceled' });
    const reopened = await runtime.open(user.id, project.id, object.id, source);
    expect(reopened.id).not.toBe(instance.id);
    const next = await runtime.run(user.id, project.id, reopened.id, input);
    expect(next.submission.jobId).not.toBe(original.jobId);
    expect(await receipt(input.requestId)).toEqual({ ...original, status: 'canceled' });
    expect((await db.query('SELECT instance_id,original_instance_id FROM workflow_runs WHERE job_id=$1', [original.jobId])).rows[0]).toEqual({ instance_id: null, original_instance_id: instance.id });
  });

  it('keeps receipt reads side effect free even when abandoned instance cleanup would be due', async () => {
    const input = request();
    const original = (await submit(input)).submission;
    await db.query("UPDATE workflow_instances SET updated_at=now()-interval '8 days' WHERE id=$1", [instance.id]);
    await db.query("UPDATE jobs SET status='failed' WHERE id=$1", [original.jobId]);
    const before = (await db.query('SELECT state_json,updated_at FROM workflow_instances WHERE id=$1', [instance.id])).rows[0];
    expect((await receipt(input.requestId)).status).toBe('failed');
    const after = (await db.query('SELECT state_json,updated_at FROM workflow_instances WHERE id=$1', [instance.id])).rows[0];
    expect(after).toEqual(before);
    expect(environmentReads).toBe(1);
  });

  it('fails honestly for a legacy UUID without original request evidence rather than claiming current state', async () => {
    const input = request();
    const legacy = await db.createProjectJob(user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query('INSERT INTO workflow_runs(job_id,instance_id,request_id,step_id,generation) VALUES($1,$2,$3,$4,0)', [legacy.id, instance.id, input.requestId, 'inspect']);
    await expect(receipt(input.requestId)).rejects.toMatchObject({ status: 409 });
    await expect(submit(input)).rejects.toMatchObject({ status: 409 });
    expect((await db.query("SELECT COUNT(*)::int AS count FROM jobs WHERE job_type='expert.r.v1'")).rows[0].count).toBe(0);
    expect(environmentReads).toBe(0);
  });

  it('requires authentication, restricts original receipts to their owner and project, and returns no scientific bodies', async () => {
    const input = request();
    const original = (await submit(input)).submission;
    const token = http.serverModule.issueSession(user);
    const other = await http.createUserWithToken({ email: 'receipt-other@example.test', displayName: 'Other' });
    await db.addProjectMemberByEmail(project.id, other.user.email, 'analyst', { userId: user.id });
    expect((await http.api(server, receiptUrl(input.requestId))).status).toBe(401);
    expect((await http.api(server, receiptUrl(input.requestId), { token: other.token })).status).toBe(404);
    const org = await db.createOrganizationForUser(user.id, { name: 'Other lab' });
    const different = await db.createProjectForUser(user.id, { organizationId: org.id, name: 'Other study' });
    expect((await http.api(server, `/api/workflows/${different.id}/instances/${instance.id}/submissions/${input.requestId}`, { token })).status).toBe(404);
    const read = await http.api(server, receiptUrl(input.requestId), { token });
    expect(read.status).toBe(200);
    expect(read.data).toEqual(original);
    expect(read.res.headers.get('cache-control')).toBe('private, no-store');
    expect(Object.keys(read.data).sort()).toEqual(['schema', 'requestId', 'requestHash', 'instanceId', 'projectId', 'jobId', 'analysisObjectId', 'stepId', 'seed', 'packageDigest', 'status', 'createdAt'].sort());
    expect(Buffer.byteLength(JSON.stringify(read.data))).toBeLessThan(2048);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id, user.id]);
    expect((await http.api(server, receiptUrl(input.requestId), { token })).status).toBe(403);
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, user.id]);
    expect((await http.api(server, receiptUrl(input.requestId), { token })).status).toBe(404);
  });

  it('reads confirmed history after execute permission is revoked but does not admit a duplicate POST', async () => {
    const input = request();
    const original = (await submit(input)).submission;
    await db.setExpertRExecutorByEmail(user.email, false);
    expect(await receipt(input.requestId)).toEqual(original);
    await expect(submit(input)).rejects.toMatchObject({ status: 403 });
  });

  it('recovers an admitted request through concurrent authenticated HTTP posts and reports payload conflicts', async () => {
    const input = request();
    const original = (await submit(input)).submission;
    const token = http.serverModule.issueSession(user);
    const url = `/api/workflows/${project.id}/instances/${instance.id}/run`;
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => http.api(server, url, { method: 'POST', token, body: input })));
    expect(duplicates.every(result => result.status === 200 && result.data.submission.jobId === original.jobId)).toBe(true);
    for (const changed of [{ stepId: 'review' }, { parameters: { cells: 4 } }, { seed: 2 }]) {
      const refused = await http.api(server, url, { method: 'POST', token, body: { ...input, ...changed } });
      expect(refused.status).toBe(409);
      expect(refused.data.error).toMatch(/different workflow settings/);
    }
    expect((await http.api(server, url, { method: 'POST', token, body: input, headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_runs')).rows[0].count).toBe(1);
    expect(environmentReads).toBe(1);
  });

  it('bounds canonical settings in bytes before admission without truncating scientific parameters', async () => {
    const workflow = JSON.parse(source);
    workflow.steps[0].parameters = Array.from({ length: 24 }, (_, index) => ({ key: `parameter-${index}`, type: 'text', label: `Parameter ${index}`, default: '', maxLength: 2000 }));
    const bounded = await runtime.open(user.id, project.id, object.id, JSON.stringify(workflow));
    const parameters = Object.fromEntries(workflow.steps[0].parameters.map(item => [item.key, '界'.repeat(2000)]));
    await expect(runtime.run(user.id, project.id, bounded.id, request({ parameters }))).rejects.toMatchObject({ status: 400 });
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_runs')).rows[0].count).toBe(0);
    expect(environmentReads).toBe(0);
    expect((await runtime.get(user.id, project.id, bounded.id)).state.active).toBeNull();
  });

  it('protects admitted identity from mutation while keeping output bookkeeping and idempotent schema application usable', async () => {
    const input = request();
    const original = (await submit(input)).submission;
    const replacements = { request_id: crypto.randomUUID(), step_id: 'review', request_hash: 'b'.repeat(64),
      request_json: { seed: 2 }, original_instance_id: 'wfi_' + 'b'.repeat(24) };
    for (const [column, value] of Object.entries(replacements)) {
      await expect(db.query(`UPDATE workflow_runs SET ${column}=$2 WHERE job_id=$1`, [original.jobId, value])).rejects.toMatchObject({ code: '55000' });
    }
    await db.query("UPDATE workflow_runs SET output_names_json='[]'::jsonb WHERE job_id=$1", [original.jobId]);
    await db.initSchema({ force: true });
    await db.initSchema({ force: true });
    expect(await receipt(input.requestId)).toEqual(original);
    await expect(db.query('UPDATE workflow_runs SET request_id=$2 WHERE job_id=$1', [original.jobId, crypto.randomUUID()])).rejects.toMatchObject({ code: '55000' });
  });

  it('rejects missing or oversized locators and never falls back to the latest run', async () => {
    const input = request();
    await submit(input);
    await expect(receipt(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(receipt('a'.repeat(65))).rejects.toMatchObject({ status: 400 });
    await expect(runtime.submission(user.id, project.id, 'wfi_' + 'a'.repeat(25), input.requestId)).rejects.toMatchObject({ status: 400 });
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_runs')).rows[0].count).toBe(1);
  });
});
