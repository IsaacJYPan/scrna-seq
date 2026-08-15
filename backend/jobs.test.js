import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const {
  createUser, createAnalysisObjectForUser,
  createJobForUser, getJobForUser, updateJobStatusForUser,
  appendJobLogForUser, validateJobTransition, verifyJobOwner, isValidJobStatus
} = db;
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();

let server;

beforeAll(async () => { if (!CONFIGURED) return; server = await startServer(); });
afterAll(async () => { if (!CONFIGURED) return; if (server) await new Promise((resolve) => server.close(resolve)); await db.close(); });

beforeEach(async () => { if (!CONFIGURED) return; await db.resetSchemaForTests(); });

async function users() {
  const alice = await createUserWithToken({ email: 'alice@example.com', displayName: 'Alice' });
  const bob = await createUserWithToken({ email: 'bob@example.com', displayName: 'Bob' });
  return { alice, bob };
}

async function createObject(token, body = { objectType: 'seurat' }) {
  const res = await api(server, '/api/analysis-objects', { method: 'POST', token, body });
  return res.data.id;
}

async function createJob(token, body = { jobType: 'normalize' }) {
  return api(server, '/api/jobs', { method: 'POST', token, body });
}

// ── HTTP route layer ──────────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('jobs API', () => {
  it('requires auth on every route', async () => {
    expect((await api(server, '/api/jobs')).status).toBe(401);
    expect((await api(server, '/api/jobs', { method: 'POST', body: { jobType: 'normalize' } })).status).toBe(401);
    expect((await api(server, '/api/jobs/job_whatever')).status).toBe(401);
    expect((await api(server, '/api/jobs/job_whatever/logs')).status).toBe(401);
    expect((await api(server, '/api/jobs/job_whatever/cancel', { method: 'POST' })).status).toBe(401);
  });

  it('lets a user create a job with a server-assigned id and queued status', async () => {
    const { alice } = await users();
    const res = await createJob(alice.token, { jobType: 'normalize', parameters: { scaleFactor: 10000 } });
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^job_[0-9a-f]+$/);
    expect(res.data.ownerUserId).toBe(alice.user.id);
    expect(res.data.jobType).toBe('normalize');
    expect(res.data.status).toBe('queued');
    expect(res.data.parameters).toEqual({ scaleFactor: 10000 });
    expect(res.data.logs).toEqual([]);
    expect(res.data.error).toBeNull();
    expect(res.data.createdAt).toBeTruthy();
  });

  it('defaults parameters to an empty object when omitted', async () => {
    const { alice } = await users();
    const res = await createJob(alice.token, { jobType: 'pca' });
    expect(res.status).toBe(201);
    expect(res.data.parameters).toEqual({});
  });

  it('rejects a client-provided job id', async () => {
    const { alice } = await users();
    const res = await createJob(alice.token, { id: 'job_client_chosen', jobType: 'normalize' });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/server-assigned/i);
  });

  it('rejects body-provided owner/user fields', async () => {
    const { alice, bob } = await users();
    for (const field of ['userId', 'user_id', 'ownerUserId', 'owner_user_id']) {
      const res = await createJob(alice.token, { jobType: 'normalize', [field]: bob.user.id });
      expect(res.status, `field ${field}`).toBe(400);
    }
  });

  it('rejects a client-provided status', async () => {
    const { alice } = await users();
    const res = await createJob(alice.token, { jobType: 'normalize', status: 'completed' });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/status is server-managed/i);
  });

  it('rejects an invalid job type', async () => {
    const { alice } = await users();
    const res = await createJob(alice.token, { jobType: 'not-a-real-type' });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/jobType/i);
  });

  it('rejects receipt-backed scientific jobs on the legacy projectless route', async () => {
    const { alice } = await users();
    for (const jobType of [
      'pbmc.pipeline.v1',
      'seurat.pipeline.v1',
      'spatial.seurat.v1',
      'checkpoint.load.v1',
      'checkpoint.fork.v1',
      'deg.find_markers.v1',
      'enrichment.gsea.v1',
      'cellchat.infer.v1',
    ]) {
      const res = await createJob(alice.token, { jobType });
      expect(res.status, jobType).toBe(400);
      expect(res.data.error).toMatch(/project-scoped jobs API/i);
    }
  });

  it('rejects invalid parameters (array, null, scalar)', async () => {
    const { alice } = await users();
    for (const parameters of [[], null, 'string', 42]) {
      const res = await createJob(alice.token, { jobType: 'normalize', parameters });
      expect(res.status, `parameters=${JSON.stringify(parameters)}`).toBe(400);
    }
  });

  it('creates a job against the user own analysis object', async () => {
    const { alice } = await users();
    const objId = await createObject(alice.token);
    const res = await createJob(alice.token, { jobType: 'normalize', analysisObjectId: objId });
    expect(res.status).toBe(201);
    expect(res.data.analysisObjectId).toBe(objId);
  });

  it('rejects creating a job against another user analysis object (404)', async () => {
    const { alice, bob } = await users();
    const bobObj = await createObject(bob.token);
    const res = await createJob(alice.token, { jobType: 'normalize', analysisObjectId: bobObj });
    expect(res.status).toBe(404);
  });

  it('rejects a job against an unknown analysis object (404)', async () => {
    const { alice } = await users();
    const res = await createJob(alice.token, { jobType: 'normalize', analysisObjectId: 'ao_does_not_exist' });
    expect(res.status).toBe(404);
  });

  it('lists only the authenticated user jobs', async () => {
    const { alice, bob } = await users();
    await createJob(alice.token, { jobType: 'normalize' });
    await createJob(alice.token, { jobType: 'pca' });
    await createJob(bob.token, { jobType: 'normalize' });

    const aliceList = await api(server, '/api/jobs', { token: alice.token });
    const bobList = await api(server, '/api/jobs', { token: bob.token });

    expect(aliceList.data).toHaveLength(2);
    expect(aliceList.data.every(j => j.ownerUserId === alice.user.id)).toBe(true);
    expect(bobList.data).toHaveLength(1);
    expect(bobList.data.every(j => j.ownerUserId === bob.user.id)).toBe(true);
  });

  it('supports status / jobType / analysisObjectId filters scoped to the user', async () => {
    const { alice } = await users();
    const objId = await createObject(alice.token);
    const normalize = await createJob(alice.token, { jobType: 'normalize', analysisObjectId: objId });
    await createJob(alice.token, { jobType: 'pca' });

    const byType = await api(server, '/api/jobs?jobType=pca', { token: alice.token });
    expect(byType.data).toHaveLength(1);
    expect(byType.data[0].jobType).toBe('pca');

    const byStatus = await api(server, '/api/jobs?status=queued', { token: alice.token });
    expect(byStatus.data).toHaveLength(2);

    const byObject = await api(server, `/api/jobs?analysisObjectId=${objId}`, { token: alice.token });
    expect(byObject.data).toHaveLength(1);
    expect(byObject.data[0].id).toBe(normalize.data.id);
  });

  it('does not leak another user jobs via filters', async () => {
    const { alice, bob } = await users();
    await createJob(bob.token, { jobType: 'normalize' });
    const filtered = await api(server, '/api/jobs?status=queued', { token: alice.token });
    expect(filtered.data).toHaveLength(0);
  });

  it('lets a user read their own job but not another user job', async () => {
    const { alice, bob } = await users();
    const created = await createJob(alice.token, { jobType: 'normalize' });
    const id = created.data.id;

    const own = await api(server, `/api/jobs/${id}`, { token: alice.token });
    expect(own.status).toBe(200);
    expect(own.data.id).toBe(id);

    const other = await api(server, `/api/jobs/${id}`, { token: bob.token });
    expect(other.status).toBe(404);
  });

  it('returns 404 for an unknown job id', async () => {
    const { alice } = await users();
    const res = await api(server, '/api/jobs/job_unknown', { token: alice.token });
    expect(res.status).toBe(404);
  });

  it('exposes logs for an owned job and 404 for another user job', async () => {
    const { alice, bob } = await users();
    const created = await createJob(alice.token, { jobType: 'normalize' });
    const id = created.data.id;

    const logs = await api(server, `/api/jobs/${id}/logs`, { token: alice.token });
    expect(logs.status).toBe(200);
    expect(logs.data.id).toBe(id);
    expect(Array.isArray(logs.data.logs)).toBe(true);

    const other = await api(server, `/api/jobs/${id}/logs`, { token: bob.token });
    expect(other.status).toBe(404);
  });

  it('cancels an owned queued job and records canceled_at', async () => {
    const { alice } = await users();
    const created = await createJob(alice.token, { jobType: 'normalize' });
    const id = created.data.id;

    const canceled = await api(server, `/api/jobs/${id}/cancel`, { method: 'POST', token: alice.token });
    expect(canceled.status).toBe(200);
    expect(canceled.data.status).toBe('canceled');
    expect(canceled.data.canceledAt).toBeTruthy();
    expect(canceled.data.updatedAt).toBeTruthy();
    // A cancel log entry is recorded.
    expect(canceled.data.logs.some(l => /canceled/i.test(l.message))).toBe(true);
  });

  it('refuses to cancel another user job (404)', async () => {
    const { alice, bob } = await users();
    const created = await createJob(alice.token, { jobType: 'normalize' });
    const res = await api(server, `/api/jobs/${created.data.id}/cancel`, { method: 'POST', token: bob.token });
    expect(res.status).toBe(404);
    // Alice's job is untouched.
    const still = await api(server, `/api/jobs/${created.data.id}`, { token: alice.token });
    expect(still.data.status).toBe('queued');
  });

  it('returns 404 when canceling an unknown job', async () => {
    const { alice } = await users();
    const res = await api(server, '/api/jobs/job_unknown/cancel', { method: 'POST', token: alice.token });
    expect(res.status).toBe(404);
  });

  it('returns 409 when canceling an already-canceled job', async () => {
    const { alice } = await users();
    const created = await createJob(alice.token, { jobType: 'normalize' });
    const id = created.data.id;
    expect((await api(server, `/api/jobs/${id}/cancel`, { method: 'POST', token: alice.token })).status).toBe(200);
    const again = await api(server, `/api/jobs/${id}/cancel`, { method: 'POST', token: alice.token });
    expect(again.status).toBe(409);
  });
});

// ── DB helper layer (status machine, logs, result ownership) ───────────────
// Status transitions are intentionally NOT exposed as a client route (clients
// may not set arbitrary statuses), so the transition machine and result-object
// ownership are exercised directly against the owner-scoped helpers.
describe.skipIf(!CONFIGURED)('jobs status machine & helpers', () => {
  async function setup() {
    const alice = await createUser('alice@example.com', 'password123', 'Alice');
    const bob = await createUser('bob@example.com', 'password123', 'Bob');
    return { alice, bob };
  }

  it('allows the documented valid transitions', () => {
    expect(validateJobTransition('created', 'queued')).toBe(true);
    expect(validateJobTransition('queued', 'running')).toBe(true);
    expect(validateJobTransition('running', 'completed')).toBe(true);
    expect(validateJobTransition('running', 'failed')).toBe(true);
    expect(validateJobTransition('running', 'waiting_for_user')).toBe(true);
    expect(validateJobTransition('waiting_for_user', 'queued')).toBe(true);
    expect(validateJobTransition('waiting_for_user', 'running')).toBe(true);
    for (const from of ['created', 'queued', 'running', 'waiting_for_user']) {
      expect(validateJobTransition(from, 'canceled')).toBe(true);
    }
  });

  it('rejects invalid or terminal transitions', () => {
    expect(validateJobTransition('queued', 'completed')).toBe(false); // must run first
    expect(validateJobTransition('completed', 'running')).toBe(false); // terminal
    expect(validateJobTransition('failed', 'queued')).toBe(false); // terminal
    expect(validateJobTransition('canceled', 'running')).toBe(false); // terminal
    expect(validateJobTransition('created', 'running')).toBe(false); // must queue first
    expect(validateJobTransition('queued', 'bogus')).toBe(false); // unknown target
    expect(isValidJobStatus('bogus')).toBe(false);
  });

  it('drives a job through queued → running → completed with timestamps', async () => {
    const { alice } = await setup();
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    expect(job.status).toBe('queued');
    expect(job.startedAt).toBeNull();

    const running = await updateJobStatusForUser(alice.id, job.id, 'running', { log: 'started' });
    expect(running.status).toBe('running');
    expect(running.startedAt).toBeTruthy();
    expect(running.logs.map(l => l.message)).toContain('started');

    const done = await updateJobStatusForUser(alice.id, job.id, 'completed', { log: 'done' });
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBeTruthy();
  });

  it('rejects an invalid transition through the helper', async () => {
    const { alice } = await setup();
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    // queued -> completed is not allowed (must go through running).
    await expect(updateJobStatusForUser(alice.id, job.id, 'completed')).rejects.toThrow(/transition/i);
  });

  it('refuses to update a job the user does not own', async () => {
    const { alice, bob } = await setup();
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    await expect(updateJobStatusForUser(bob.id, job.id, 'running')).rejects.toThrow(/not found/i);
    expect(await verifyJobOwner(bob.id, job.id)).toBe(false);
    expect(await verifyJobOwner(alice.id, job.id)).toBe(true);
  });

  it('stores a structured error on failure and returns it consistently', async () => {
    const { alice } = await setup();
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    await updateJobStatusForUser(alice.id, job.id, 'running');
    const failed = await updateJobStatusForUser(alice.id, job.id, 'failed', {
      error: { message: 'Seurat normalization failed', code: 'R_ERROR' },
      log: 'crashed'
    });
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ message: 'Seurat normalization failed', code: 'R_ERROR' });
    // Round-trips on re-read.
    const reread = await getJobForUser(job.id, alice.id);
    expect(reread.error.code).toBe('R_ERROR');
  });

  it('links a result analysis object the user owns on completion', async () => {
    const { alice } = await setup();
    const resultObj = await createAnalysisObjectForUser(alice.id, { objectType: 'seurat' });
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    await updateJobStatusForUser(alice.id, job.id, 'running');
    const done = await updateJobStatusForUser(alice.id, job.id, 'completed', {
      resultAnalysisObjectId: resultObj.id
    });
    expect(done.resultAnalysisObjectId).toBe(resultObj.id);
  });

  it('rejects linking a result object owned by another user', async () => {
    const { alice, bob } = await setup();
    const bobObj = await createAnalysisObjectForUser(bob.id, { objectType: 'seurat' });
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    await updateJobStatusForUser(alice.id, job.id, 'running');
    await expect(updateJobStatusForUser(alice.id, job.id, 'completed', {
      resultAnalysisObjectId: bobObj.id
    })).rejects.toThrow(/result analysis object not found/i);
  });

  it('appends log entries without changing status', async () => {
    const { alice } = await setup();
    const job = await createJobForUser(alice.id, { jobType: 'normalize' });
    const after = await appendJobLogForUser(alice.id, job.id, { level: 'warn', message: 'low cell count' });
    expect(after.status).toBe('queued');
    expect(after.logs).toHaveLength(1);
    expect(after.logs[0]).toMatchObject({ level: 'warn', message: 'low cell count' });
    expect(after.logs[0].ts).toBeTruthy();
  });
});
