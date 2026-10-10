import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const db = require('./pgDatabase');
const config = require('./config');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { projectSubmissionHash } = require('./submissionIdentity');
const configured = config.hasPostgresConnection();
let server, alice, bob, project, object;

describe.skipIf(!configured)('immutable project submission receipts', () => {
  beforeAll(async () => { server = await startServer(); });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    alice = await createUserWithToken({ email: 'submission-owner@example.test' });
    bob = await createUserWithToken({ email: 'submission-colleague@example.test' });
    const organization = await db.createOrganizationForUser(alice.user.id, { name: 'Submission lab' });
    project = await db.createProjectForUser(alice.user.id, { organizationId: organization.id, name: 'Submission study' });
    await db.addProjectMember(project.id, bob.user.id, 'analyst');
    object = await db.createProjectAnalysisObject(alice.user.id, project.id, { objectType: 'seurat' });
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); });
  const body = (extra = {}) => ({ requestId: randomUUID(), jobType: 'generic', analysisObjectId: object.id,
    parameters: { nested: { cutoff: 3, selected: ['A', 'B'] } }, ...extra });
  const post = (payload, token = alice.token) => api(server, `/api/projects/${project.id}/jobs`, { method: 'POST', token, body: payload });
  const receipt = (requestId, token = alice.token) => api(server, `/api/projects/${project.id}/job-submissions/${requestId}`, { token });

  it('admits exactly one job for eight concurrent authenticated identical submissions', async () => {
    const input = body();
    const responses = await Promise.all(Array.from({ length: 8 }, () => post(input)));
    expect(responses.filter(item => item.status === 201)).toHaveLength(1);
    expect(responses.filter(item => item.status === 200)).toHaveLength(7);
    expect(new Set(responses.map(item => item.data.id)).size).toBe(1);
    expect(responses[0].data.submission.requestHash).toBe(projectSubmissionHash(input));
    expect(responses.every(item => item.data.submissionCreated === undefined)).toBe(true);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM project_job_submissions')).rows[0].n).toBe(1);
  });
  it('recovers the exact original run after a lost acknowledgement, completion and newer work', async () => {
    const input = body();
    const accepted = await post(input);
    await db.query("UPDATE jobs SET status='completed',completed_at=now() WHERE id=$1", [accepted.data.id]);
    const newer = await post(body());
    const recovered = await receipt(input.requestId);
    expect(recovered.status).toBe(200);
    expect(recovered.res.headers.get('cache-control')).toBe('no-store');
    expect(recovered.data).toMatchObject({ schema: 'traceomics.job-submission.v1', requestId: input.requestId,
      jobId: accepted.data.id, projectId: project.id, job: { id: accepted.data.id, status: 'completed', attempts: 0 } });
    expect(recovered.data.job.finishedAt).toBeTruthy();
    expect((await post(input)).data.id).toBe(accepted.data.id);
    expect(newer.data.id).not.toBe(accepted.data.id);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(2);
  });
  it('canonicalizes nested key order and rejects changed scientific settings or input bindings', async () => {
    const input = body();
    const accepted = await post(input);
    expect((await post({ ...input, parameters: { nested: { selected: ['A', 'B'], cutoff: 3 } } })).data.id).toBe(accepted.data.id);
    const other = await db.createProjectAnalysisObject(alice.user.id, project.id, { objectType: 'seurat' });
    for (const change of [ { parameters: { nested: { cutoff: 4, selected: ['A', 'B'] } } },
      { analysisObjectId: other.id }, { jobType: 'checkpoint.noop' }, { datasetId: db.genId('ds') } ]) {
      const response = await post({ ...input, ...change });
      expect(response.status).toBe(409);
      expect(response.data.code).toBe('SUBMISSION_REQUEST_CONFLICT');
    }
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
  });
  it('retains only bounded receipt metadata and never returns source, credentials, logs or internal paths', async () => {
    const input = body({ parameters: { script: 'PRIVATE_SOURCE_7', path: '/private/research/data', token: 'PRIVATE_TOKEN_7' } });
    const accepted = await post(input);
    await db.query("UPDATE jobs SET logs_json=$2,claim_token='PRIVATE_CLAIM_7',worker_id='PRIVATE_WORKER_7' WHERE id=$1",
      [accepted.data.id, JSON.stringify([{ message: 'PRIVATE_LOG_7', level: 'info' }])]);
    const response = await receipt(input.requestId);
    const encoded = JSON.stringify(response.data);
    expect(Buffer.byteLength(encoded)).toBeLessThan(4096);
    for (const value of ['PRIVATE_', '/private/', 'parameters', 'logs', 'claim_token', 'worker_id']) expect(encoded).not.toContain(value);
    expect(response.data.requestHash).toBe(projectSubmissionHash(input));
  });
  it('isolates receipt ownership while allowing the same UUID for a different account', async () => {
    const input = body();
    const original = await post(input);
    expect((await receipt(input.requestId, bob.token)).status).toBe(404);
    const other = await post(input, bob.token);
    expect(other.status).toBe(201);
    expect(other.data.id).not.toBe(original.data.id);
    expect((await receipt(input.requestId, bob.token)).data.jobId).toBe(other.data.id);
    expect((await receipt(input.requestId)).data.jobId).toBe(original.data.id);
  });
  it('requires authentication, rejects missing scope, and rechecks revoked or downgraded membership', async () => {
    const input = body(); await post(input);
    expect((await api(server, `/api/projects/${project.id}/job-submissions/${input.requestId}`)).status).toBe(401);
    expect((await receipt(randomUUID())).status).toBe(404);
    await db.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [project.id,alice.user.id]);
    expect((await receipt(input.requestId)).status).toBe(200);
    expect((await post(input)).status).toBe(403);
    await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id,alice.user.id]);
    expect((await receipt(input.requestId)).status).toBe(404);
  });
  it('rejects invalid request IDs and failed admissions without creating receipts', async () => {
    for (const requestId of [null, '', 'client-picked-job', [], 2]) expect((await post(body({ requestId }))).status).toBe(400);
    expect((await receipt('invalid')).status).toBe(400);
    expect((await post(body({ jobType: 'unknown.type' }))).status).toBe(400);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM project_job_submissions')).rows[0].n).toBe(0);
  });
  it('rolls back job insertion if publication of its receipt fails', async () => {
    await db.query("CREATE FUNCTION refuse_test_submission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt unavailable'; END $$");
    await db.query('CREATE TRIGGER refuse_test_submission BEFORE INSERT ON project_job_submissions FOR EACH ROW EXECUTE FUNCTION refuse_test_submission()');
    try { await expect(db.createProjectJob(alice.user.id, project.id, body())).rejects.toThrow('test receipt unavailable'); }
    finally { await db.query('DROP TRIGGER refuse_test_submission ON project_job_submissions'); await db.query('DROP FUNCTION refuse_test_submission()'); }
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM project_job_submissions')).rows[0].n).toBe(0);
  });
  it('keeps receipt evidence immutable across schema reapplication', async () => {
    const input = body(); const accepted = await post(input);
    await expect(db.query('UPDATE project_job_submissions SET request_hash=$1', ['a'.repeat(64)])).rejects.toMatchObject({ code: '55000' });
    await db.initSchema({ force: true });
    expect((await receipt(input.requestId)).data.jobId).toBe(accepted.data.id);
    expect((await receipt(input.requestId)).data.requestHash).toBe(projectSubmissionHash(input));
  });
  it('preserves intentional separate submissions and clients without request IDs', async () => {
    const input = body(); delete input.requestId;
    const first = await post(input); const second = await post(input);
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect(second.data.id).not.toBe(first.data.id);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM project_job_submissions')).rows[0].n).toBe(0);
  });
  it('exposes an authenticated stable database installation identity without an endpoint or runtime details', async () => {
    expect((await api(server, '/api/auth/installation')).status).toBe(401);
    const first = await api(server, '/api/auth/installation', { token: alice.token });
    const other = await api(server, '/api/auth/installation', { token: bob.token });
    expect(first.data).toEqual({ schema: 'traceomics.installation.v1', installationId: expect.stringMatching(/^svc_[a-f0-9]{32}$/), userId: alice.user.id });
    expect(other.data.installationId).toBe(first.data.installationId);
    expect(first.res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('bounded submission identity', () => {
  it('preserves ordered arrays and explicit values while ignoring JSON key order', () => {
    const input = { jobType: 'generic', parameters: { a: 1, b: [2, 3] } };
    expect(projectSubmissionHash(input)).toBe(projectSubmissionHash({ ...input, parameters: { b: [2, 3], a: 1 } }));
    expect(projectSubmissionHash(input)).not.toBe(projectSubmissionHash({ ...input, parameters: { a: 1, b: [3, 2] } }));
  });
  it('rejects oversized or non-JSON inputs before hashing', () => {
    expect(() => projectSubmissionHash({ jobType: 'generic', parameters: { value: 'x'.repeat(256 * 1024) } })).toThrow(/byte limit/);
    expect(() => projectSubmissionHash({ jobType: 'generic', parameters: { value: Infinity } })).toThrow(/JSON/);
    const cyclic = {}; cyclic.next = cyclic;
    expect(() => projectSubmissionHash({ jobType: 'generic', parameters: cyclic })).toThrow(/complexity/);
  });
});
