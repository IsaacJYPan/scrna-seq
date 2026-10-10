import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const db = require('./pgDatabase');
const config = require('./config');
const { EXPERT_R_PROFILE } = require('./expertR');
const { DENIED_CAPABILITY } = require('./expertRAccess');
const { environmentFixture } = require('./_r-environment-test-utils');
const { projectSubmissionHash } = require('./submissionIdentity');
const { startServer, createUserWithToken, api, serverModule } = require('./_http-test-utils');
const configured = config.hasPostgresConnection();
const environmentKeys = ['APP_DEPLOYMENT_MODE', 'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN', 'EXPERT_R_ACCESS_POLICY', 'DEMO_MAX_GLOBAL_HEAVY_JOBS'];
let saved, server, broker, brokerMode, brokerReads, manifest, owner, project, object;

describe.skipIf(!configured)('project submission recovery across runtime and admission changes', () => {
  beforeAll(async () => {
    saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    broker = createServer((req, res) => {
      if (req.url !== '/environment' || req.headers.authorization !== `Bearer ${'a'.repeat(64)}`) { res.statusCode = 404; res.end(); return; }
      brokerReads++;
      if (brokerMode === 'unavailable') { res.statusCode = 503; res.end('{}'); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(manifest));
    });
    await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
    server = await startServer();
  });
  beforeEach(async () => {
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'approved-accounts',
      EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${broker.address().port}`, EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64) });
    await db.resetSchemaForTests();
    brokerMode = 'ready'; brokerReads = 0; manifest = environmentFixture('a').manifest;
    owner = await createUserWithToken({ email: 'submission-recovery@example.test', displayName: 'Recovery owner' });
    const org = await db.createOrganizationForUser(owner.user.id, { name: 'Recovery lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: org.id, name: 'Recovery study' });
    object = await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat', displayName: 'Saved input' });
    await db.setExpertRExecutorByEmail(owner.user.email, true);
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (broker) { broker.closeAllConnections(); await new Promise(resolve => broker.close(resolve)); }
    for (const [key, value] of Object.entries(saved || {})) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.close();
  });

  const expert = (extra = {}) => ({ requestId: randomUUID(), jobType: 'expert.r.v1', analysisObjectId: object.id,
    parameters: { profileId: EXPERT_R_PROFILE.id, script: 'write_table(data.frame(cells=ncol(obj)), "cells.csv")' }, ...extra });
  const post = input => api(server, `/api/projects/${project.id}/jobs`, { method: 'POST', token: owner.token, body: input });
  const receipt = requestId => api(server, `/api/projects/${project.id}/job-submissions/${requestId}`, { token: owner.token });

  async function waitForBlocked(lockerPid, minimum = 1) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await db.query('SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [lockerPid]);
      if (result.rows[0].count >= minimum) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The test admission did not reach its transaction lock.');
  }

  it('keeps raw request identity across server environment pinning, terminal parameter redaction and an unavailable broker', async () => {
    const input = expert();
    const accepted = await post(input);
    expect(accepted.status).toBe(201);
    expect(accepted.data.parameters.environment).toEqual(environmentFixture('a').reference);
    expect(accepted.data.submission.requestHash).toBe(projectSubmissionHash(input));
    expect(accepted.data.submission.requestHash).not.toBe(projectSubmissionHash({ ...input, parameters: accepted.data.parameters }));
    await db.query("UPDATE jobs SET status='completed',completed_at=now() WHERE id=$1", [accepted.data.id]);
    const stored = JSON.parse((await db.query('SELECT parameters_json FROM jobs WHERE id=$1', [accepted.data.id])).rows[0].parameters_json);
    expect(stored.script).toBeUndefined();
    expect(stored.environment).toEqual(environmentFixture('a').reference);
    brokerMode = 'unavailable';
    const recovered = await post(input);
    expect(recovered.status).toBe(200);
    expect(recovered.data.id).toBe(accepted.data.id);
    expect(recovered.data.status).toBe('completed');
    expect(recovered.data.parameters.script).toBeUndefined();
    expect((await receipt(input.requestId)).data.jobId).toBe(accepted.data.id);
    expect(brokerReads).toBe(1);
    expect((await post({ ...input, requestId: randomUUID() })).status).toBe(503);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM project_job_submissions')).rows[0].count).toBe(1);
  });

  it('returns the original pinned job on a changed worker and conflicts on changed source or selected environment', async () => {
    const input = expert();
    const accepted = await post(input);
    expect(accepted.status).toBe(201);
    manifest = environmentFixture('b').manifest;
    const duplicate = await post(input);
    expect(duplicate.status).toBe(200);
    expect(duplicate.data.id).toBe(accepted.data.id);
    expect(duplicate.data.parameters.environment).toEqual(environmentFixture('a').reference);
    for (const parameters of [{ ...input.parameters, script: `${input.parameters.script}\nprint(2)` },
      { ...input.parameters, environment: environmentFixture('b').reference }]) {
      expect((await post({ ...input, parameters })).status).toBe(409);
    }
    expect(brokerReads).toBe(1);
    const intentional = await post({ ...input, requestId: randomUUID() });
    expect(intentional.status).toBe(201);
    expect(intentional.data.id).not.toBe(accepted.data.id);
    expect(intentional.data.parameters.environment).toEqual(environmentFixture('b').reference);
    expect((await receipt(input.requestId)).data.jobId).toBe(accepted.data.id);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM jobs')).rows[0].count).toBe(2);
  });

  it('treats a duplicate as confirmed history after execute revocation while refusing new scientific work', async () => {
    const input = expert();
    const accepted = await post(input);
    expect(accepted.status).toBe(201);
    await db.setExpertRExecutorByEmail(owner.user.email, false);
    expect((await receipt(input.requestId)).status).toBe(200);
    const duplicate = await post(input);
    expect(duplicate.status).toBe(200);
    expect(duplicate.data.id).toBe(accepted.data.id);
    expect((await post({ ...input, requestId: randomUUID() })).status).toBe(403);
    expect(brokerReads).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM project_job_submissions')).rows[0].count).toBe(1);
  });

  it('rechecks execute revocation at the atomic admission boundary after earlier validation succeeded', async () => {
    const input = expert({ parameters: { profileId: EXPERT_R_PROFILE.id, script: 'print(1)', environment: environmentFixture('a').reference } });
    const locker = await (await db.connect()).connect();
    let result;
    try {
      await locker.query('BEGIN');
      const lockerPid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await locker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.user.id]);
      result = db.createProjectJob(owner.user.id, project.id, input).then(value => ({ value }), error => ({ error }));
      await waitForBlocked(lockerPid);
      await locker.query('INSERT INTO platform_capabilities(user_id,capability) VALUES($1,$2) ON CONFLICT DO NOTHING', [owner.user.id, DENIED_CAPABILITY]);
      await locker.query("DELETE FROM platform_capabilities WHERE user_id=$1 AND capability='expert_r.execute'", [owner.user.id]);
      await locker.query('COMMIT');
      expect((await result).error).toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await locker.query('ROLLBACK'); locker.release();
      if (result) await result;
    }
    expect((await db.query('SELECT COUNT(*)::int AS count FROM jobs')).rows[0].count).toBe(0);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM project_job_submissions')).rows[0].count).toBe(0);
  });

  it('recovers concurrent demo UUIDs when the original commits after route lookup and fills the compute pool', async () => {
    process.env.APP_DEPLOYMENT_MODE = 'demo'; process.env.DEMO_MAX_GLOBAL_HEAVY_JOBS = '1';
    const guest = await db.createDemoGuest('submission-demo@example.test', 'password123', new Date(Date.now() + 7200000).toISOString());
    const guestObject = await db.createProjectAnalysisObject(guest.user.id, guest.project.id, { objectType: 'seurat' });
    const token = serverModule.issueSession(guest.user);
    const input = { requestId: randomUUID(), jobType: 'explore.summarize.v1', analysisObjectId: guestObject.id, parameters: { recipe: 'overview' } };
    const url = `/api/projects/${guest.project.id}/jobs`;
    const locker = await (await db.connect()).connect();
    const jobId = db.genId('job');
    let pending;
    try {
      await locker.query('BEGIN');
      const lockerPid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`project-submission:${guest.user.id}:${guest.project.id}:${input.requestId}`]);
      pending = Promise.all(Array.from({ length: 3 }, () => api(server, url, { method: 'POST', token, body: input })));
      await waitForBlocked(lockerPid, 3);
      await locker.query("INSERT INTO jobs(id,owner_user_id,project_id,analysis_object_id,job_type,status,parameters_json) VALUES($1,$2,$3,$4,$5,'queued',$6)",
        [jobId,guest.user.id,guest.project.id,guestObject.id,input.jobType,JSON.stringify(input.parameters)]);
      await locker.query('INSERT INTO project_job_submissions(project_id,owner_user_id,request_id,request_hash,job_id) VALUES($1,$2,$3,$4,$5)',
        [guest.project.id,guest.user.id,input.requestId,projectSubmissionHash(input),jobId]);
      await locker.query('COMMIT');
      const recovered = await pending;
      expect(recovered.every(response => response.status === 200 && response.data.id === jobId)).toBe(true);
    } finally {
      await locker.query('ROLLBACK'); locker.release();
      if (pending) await pending;
    }
    expect((await api(server, url, { method: 'POST', token, body: { ...input, requestId: randomUUID() } })).status).toBe(429);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM jobs')).rows[0].count).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM project_job_submissions')).rows[0].count).toBe(1);
  });
});
