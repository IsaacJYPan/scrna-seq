import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const { createRunMonitoringService, scrubLogText, projectLogs, projectObservation, summary, LIMITS } = require('./runMonitoring');
const { executorGeneration } = require('./executionTargets');
const db = require('./pgDatabase');
const CLOCK = Date.parse('2030-01-01T00:00:10.000Z');
const checkedAt = new Date(CLOCK).toISOString();
const sample = (changes = {}) => ({ state: 'observed', scope: 'r-container', observedAt: checkedAt,
  memoryBytes: 1024, memoryLimitBytes: 8 * 1024 ** 3, cpuPercent: 135.2, cpuLimit: 2, ...changes });
const target = (changes = {}) => ({ kind: 'service', id: 'svc_' + 'a'.repeat(32), label: 'Research server',
  generation: executorGeneration('monitor-worker'), precision: 'recorded-executor', runtimeKind: 'sandbox-r', runtimeGeneration: null, ...changes });

describe('bounded monitoring projections', () => {
  it.each([
    ['Authorization: Bearer private-value', 'private-value'],
    ['Cookie: session=private-value', 'private-value'],
    ['access_token = "private-value"', 'private-value'],
    ['{"private_key":"private-value"}', 'private-value'],
    ['claimToken: private-value', 'private-value'],
    ['state_key=private-value', 'private-value'],
    ['worker_id=private-value', 'private-value'],
    ['https://user:private-value@example.test/result', 'private-value'],
    ['C:\\research\\private-value\\object.rds', 'private-value'],
    ['/home/research/private-value/object.rds', 'private-value'],
    ['-----BEGIN RSA PRIVATE KEY-----\nprivate-value\n-----END RSA PRIVATE KEY-----', 'private-value'],
    ['A'.repeat(64), 'A'.repeat(64)],
    ['ghp_' + 'a'.repeat(36), 'ghp_' + 'a'.repeat(36)],
  ])('omits sensitive material in %s', (value, privateValue) => {
    const clean = scrubLogText(value);
    expect(clean.redacted).toBe(true); expect(clean.text).not.toContain(privateValue);
  });
  it('scrubs complete spans before truncation and never splits UTF-8 characters', () => {
    const clean = scrubLogText('-----BEGIN OPENSSH PRIVATE KEY-----\n' + 'private'.repeat(2000), 40);
    expect(clean.text).toBe('[Private key omitted]');
    const unicode = scrubLogText('Cells: ' + '🧬'.repeat(1000), 31);
    expect(Buffer.byteLength(unicode.text)).toBeLessThanOrEqual(31);
    expect(unicode.text).not.toContain('\ufffd'); expect(unicode.truncated).toBe(true);
  });
  it('keeps only recent whitelisted log fields within the serialized budget', () => {
    const logs = projectLogs(Array.from({ length: 80 }, (_, index) => ({ ts: checkedAt, level: 'info',
      message: 'Result ' + index + ': ' + '🧬'.repeat(1000), password: 'private-field', containerName: 'private-container' })));
    expect(logs.items.length).toBeLessThanOrEqual(50); expect(logs.omittedCount).toBe(80 - logs.items.length);
    expect(logs.items.at(-1).message).toContain('Result 79'); expect(logs.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(logs.items))).toBeLessThanOrEqual(LIMITS.logBytes);
    expect(JSON.stringify(logs)).not.toMatch(/private-field|private-container/);
  });
  it('withholds PEM blocks split across retained log entries and a short encoded tail before the ending marker', () => {
    const logs = projectLogs(['Scientific work began', '-----BEGIN RSA PRIVATE KEY-----', 'private key body', 'ShortEncoded1234',
      '-----END RSA PRIVATE KEY-----', 'Scientific work finished']);
    expect(logs.items.map(item => item.message)).toEqual(['Scientific work began', ...Array(4).fill('[Private key omitted]'), 'Scientific work finished']);
    expect(logs.redacted).toBe(true);
    const paged = projectLogs([...Array(50).fill('earlier event'), 'ShortEncoded1234', '-----END RSA PRIVATE KEY-----']);
    expect(JSON.stringify(paged)).not.toContain('ShortEncoded1234'); expect(paged.omittedCount).toBe(2);
  });
  it.each([
    { observedAt: '2029-12-31T23:59:54.999Z' }, { observedAt: '2030-01-01T00:00:11.001Z' },
    { observedAt: 'invalid' }, { scope: 'host' }, { memoryBytes: -1 }, { memoryBytes: 8 * 1024 ** 3 + 1 },
    { memoryLimitBytes: 0 }, { cpuPercent: NaN }, { cpuPercent: 6401 }, { cpuLimit: 0 }, { state: 'unknown' },
  ])('withholds unavailable, stale, or invalid telemetry %j', change => {
    expect(projectObservation(sample(change), checkedAt, { dispatchId: 'b'.repeat(64) }).state).toBe('unavailable');
  });
  it('projects observed container use separately from limits and drops daemon internals', () => {
    const limits = { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2 };
    const resources = projectObservation(sample({ containerId: 'private-container', hostPath: '/private' }), checkedAt, { dispatchId: 'b'.repeat(64) }, limits);
    expect(resources).toMatchObject({ state: 'observed', cpuPercent: 135.2, limits, dispatchId: 'b'.repeat(64) });
    expect(resources.note).toContain('multiple cores'); expect(JSON.stringify(resources)).not.toMatch(/private-container|hostPath/);
  });
  it('does not attribute a cached idle observation to a command that began afterward', () => {
    expect(projectObservation(sample({ observedAt: '2030-01-01T00:00:08.000Z' }), checkedAt, {}, null, '2030-01-01T00:00:09.000Z').state).toBe('unavailable');
    expect(projectObservation(sample(), checkedAt, {}, null, '2030-01-01T00:00:09.000Z').state).toBe('observed');
  });
  it.each([
    ['queued', null, null, null, { queueElapsedMs: 10000, runElapsedMs: null, totalElapsedMs: 10000 }],
    ['running', '2030-01-01T00:00:03Z', null, null, { queueElapsedMs: 3000, runElapsedMs: 7000, totalElapsedMs: 10000 }],
    ['completed', '2030-01-01T00:00:03Z', '2030-01-01T00:00:08Z', null, { queueElapsedMs: 3000, runElapsedMs: 5000, totalElapsedMs: 8000 }],
    ['canceled', null, null, '2030-01-01T00:00:04Z', { queueElapsedMs: 4000, runElapsedMs: null, totalElapsedMs: 4000 }],
  ])('reports recorded timing for %s without inventing a remaining time', (status, started_at, completed_at, canceled_at, timing) => {
    expect(summary({ id: 'job_' + 'a'.repeat(16), project_id: 'project', created_at: '2030-01-01T00:00:00Z', status, started_at, completed_at, canceled_at }, checkedAt).timing)
      .toEqual({ ...timing, remainingMs: null });
  });
  it('leaves missing terminal timestamps and invalid time order unknown', () => {
    expect(summary({ id: 'job_' + 'a'.repeat(16), status: 'failed', created_at: '2030-01-01T00:00:00Z' }, checkedAt).timing.totalElapsedMs).toBeNull();
    expect(summary({ id: 'job_' + 'a'.repeat(16), status: 'running', created_at: '2030-01-01T00:00:12Z' }, checkedAt).timing.totalElapsedMs).toBeNull();
  });
});

let http, server, owner, colleague, outsider, project, service;
describe.skipIf(!process.env.DATABASE_URL)('owner scoped monitoring through authenticated HTTP and PostgreSQL', () => {
  beforeAll(async () => { http = require('./_http-test-utils'); server = await http.startServer(); });
  beforeEach(async () => {
    vi.restoreAllMocks(); await db.resetSchemaForTests();
    owner = await http.createUserWithToken({ email: 'monitor-owner@example.test' });
    colleague = await http.createUserWithToken({ email: 'monitor-colleague@example.test' });
    outsider = await http.createUserWithToken({ email: 'monitor-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Monitoring lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Monitored science' });
    await db.addProjectMemberByEmail(project.id, colleague.user.email, 'analyst', { userId: owner.user.id });
    service = createRunMonitoringService(db, { now: () => CLOCK });
  });
  afterAll(async () => { vi.restoreAllMocks(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await db.close(); });
  const base = () => '/api/run-monitoring/' + project.id;
  const get = (suffix = '', token = owner.token) => http.api(server, base() + suffix, { token });
  async function createJob(user = owner, changes = {}) {
    const job = await db.createProjectJob(user.user.id, project.id, { jobType: 'generic' });
    if (Object.keys(changes).length) {
      const keys = Object.keys(changes);
      await db.query('UPDATE jobs SET ' + keys.map((key, index) => key + '=$' + (index + 2)).join(',') + ' WHERE id=$1', [job.id, ...keys.map(key => changes[key])]);
    }
    return job;
  }
  async function receipt(job, changes = {}) {
    const dispatchId = changes.dispatchId || 'b'.repeat(64);
    await db.query(`INSERT INTO job_execution_receipts(job_id,dispatch_id,attempt,owner_user_id,project_id,operation,target_json,environment_json,dispatch_at)
      VALUES($1,$2,$3,$4,$5,'expert.r.v1',$6,$7,$8)`, [job.id, dispatchId, changes.attempt || 1, owner.user.id, project.id,
      changes.target || target(), { precision: 'unavailable', reference: null }, changes.dispatchAt || '2030-01-01T00:00:03.000Z']);
    return dispatchId;
  }
  const runningJob = () => createJob(owner, { status: 'running', attempts: 1, worker_id: 'monitor-worker', claim_token: 'private-claim',
    created_at: '2030-01-01T00:00:00Z', started_at: '2030-01-01T00:00:03Z', locked_at: '2030-01-01T00:00:02Z',
    heartbeat_at: '2030-01-01T00:00:00Z', lease_expires_at: '2030-01-01T00:02:00Z' });
  async function command({ status = 'running', generation = 'c'.repeat(64), runtimeGeneration = generation, result = null } = {}) {
    const kernelId = 'pk_' + 'd'.repeat(24), id = 'pex_' + 'e'.repeat(24);
    await db.query(`INSERT INTO private_r_kernels(id,project_id,owner_user_id,workspace_id,request_id,start_sha256,status,runtime_generation,environment_json,environment_manifest_json,inputs_json,resources_json,target_json,next_order,active_execution_id,expires_at)
      VALUES($1,$2,$3,'monitor-workspace',$4,$5,'running',$6,'{}','{}','[]',$7,$8,1,$9,'2030-01-01T01:00:00Z')`,
    [kernelId, project.id, owner.user.id, randomUUID(), 'f'.repeat(64), runtimeGeneration,
      { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2, pidsLimit: 256, idleTimeoutSeconds: 600, maxLifetimeSeconds: 14400 },
      { kind: 'service', id: 'private-r-kernel', generation: '1'.repeat(64), serviceId: target().id, serviceLabel: 'Research server', runtimeKind: 'private-r' }, id]);
    await db.query(`INSERT INTO private_r_executions(id,kernel_id,project_id,owner_user_id,request_id,kernel_generation,execution_order,status,source_code,source_sha256,result_json,created_at,started_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,'private source code',$8,$9,'2030-01-01T00:00:00Z','2030-01-01T00:00:03Z',$10)`,
    [id, kernelId, project.id, owner.user.id, randomUUID(), generation, status, '2'.repeat(64), result, ['completed', 'failed'].includes(status) ? '2030-01-01T00:00:08Z' : null]);
    return { id, kernelId, generation };
  }

  it('requires authentication and independently hides all colleagues’ guided jobs and console records', async () => {
    const own = await createJob(), theirs = await createJob(colleague); const execution = await command();
    expect((await get('', null)).status).toBe(401); expect((await get('', outsider.token)).status).toBe(404);
    expect((await get()).data.items.map(item => item.id)).toEqual(expect.arrayContaining([own.id, execution.id]));
    expect((await get()).data.items.map(item => item.id)).not.toContain(theirs.id);
    for (const id of [own.id, execution.id]) expect((await get('/' + id, colleague.token)).status).toBe(404);
    expect((await get('/' + theirs.id)).status).toBe(404);
    expect((await get()).res.headers.get('cache-control')).toBe('private, no-store');
  });
  it('paginates tied millisecond timestamps across both kinds without duplicates or leaked records', async () => {
    const execution = await command(); const jobs = [];
    for (let index = 0; index < 6; index++) jobs.push(await createJob(owner, { created_at: '2030-01-01T00:00:00.000' + index + 'Z' }));
    await createJob(colleague, { created_at: '2030-01-01T00:00:00Z' });
    const ids = [], cursors = []; let before;
    do { const page = await service.list(owner.user.id, project.id, { limit: '2', ...(before ? { before } : {}) });
      ids.push(...page.items.map(item => item.id)); before = page.nextCursor; cursors.push(before);
    } while (before);
    expect(ids).toHaveLength(7); expect(new Set(ids).size).toBe(7); expect(ids).toEqual(expect.arrayContaining([...jobs.map(job => job.id), execution.id]));
    expect(cursors.at(-1)).toBeNull();
  });
  it.each(['?limit=26', '?limit=0', '?limit=1&limit=2', '?before=bad', '?before=%7B%7D', '?status=running'])('rejects unsupported or unbounded monitoring page %s', async suffix => {
    expect((await get(suffix)).status).toBe(400);
  });
  it('retains elapsed, unknown progress, current worker lease and the recorded executor separately', async () => {
    const job = await runningJob(); const dispatchId = await receipt(job);
    const monitoring = createRunMonitoringService(db, { now: () => CLOCK, observeJob: vi.fn(async () => sample()) });
    const detail = await monitoring.get(owner.user.id, project.id, job.id);
    expect(detail.timing).toEqual({ queueElapsedMs: 3000, runElapsedMs: 7000, totalElapsedMs: 10000, remainingMs: null });
    expect(detail.worker).toMatchObject({ state: 'lease-current', heartbeatAt: '2030-01-01T00:00:00.000Z', leaseExpiresAt: '2030-01-01T00:02:00.000Z' });
    expect(detail.progress).toMatchObject({ state: 'unknown', percent: null, remainingMs: null });
    expect(detail.resources).toMatchObject({ state: 'observed', scope: 'r-container', dispatchId, cpuPercent: 135.2 });
    expect(detail.target).toEqual(target()); expect(detail.execution).toMatchObject({ dispatchId, attempt: 1 });
    expect(JSON.stringify(detail)).not.toMatch(/private-claim|monitor-worker|worker_id|claim_token/);
    await db.query("UPDATE jobs SET lease_expires_at='2030-01-01T00:00:09Z' WHERE id=$1", [job.id]);
    expect((await monitoring.get(owner.user.id, project.id, job.id)).worker.state).toBe('lease-expired');
  });
  it('reads only the newest receipt and never substitutes an earlier valid target', async () => {
    const job = await runningJob(); await receipt(job);
    await receipt(job, { dispatchId: 'c'.repeat(64), target: target({ id: 'https://private-address', secret: 'private-value' }) });
    const observeJob = vi.fn(async () => sample());
    const detail = await createRunMonitoringService(db, { now: () => CLOCK, observeJob }).get(owner.user.id, project.id, job.id);
    expect(detail.target.kind).toBe('unknown'); expect(detail.execution).toBeNull(); expect(detail.resources.state).toBe('unavailable');
    expect(observeJob).not.toHaveBeenCalled(); expect(JSON.stringify(detail)).not.toMatch(/private-address|private-value/);
  });
  it.each([
    { attempts: 2 }, { worker_id: 'different-worker' }, { locked_at: '2030-01-01T00:00:04Z' }, { status: 'queued' },
  ])('does not observe an older dispatch after current claim changes %j', async changes => {
    const job = await runningJob(); await receipt(job);
    const keys = Object.keys(changes); await db.query('UPDATE jobs SET ' + keys.map((key, index) => key + '=$' + (index + 2)).join(',') + ' WHERE id=$1', [job.id, ...keys.map(key => changes[key])]);
    const observeJob = vi.fn(async () => sample());
    const detail = await createRunMonitoringService(db, { now: () => CLOCK, observeJob }).get(owner.user.id, project.id, job.id);
    expect(observeJob).not.toHaveBeenCalled(); expect(detail.resources.state).toBe('unavailable');
  });
  it('drops an observation when a new dispatch appears during the probe', async () => {
    const job = await runningJob(); await receipt(job);
    const dispatchId = 'c'.repeat(64);
    const monitoring = createRunMonitoringService(db, { now: () => CLOCK, observeJob: async () => { await receipt(job, { dispatchId }); return sample(); } });
    const detail = await monitoring.get(owner.user.id, project.id, job.id);
    expect(detail.execution.dispatchId).toBe(dispatchId); expect(detail.resources.state).toBe('unavailable');
  });
  it('drops an observation when the job completes during the probe', async () => {
    const job = await runningJob(); await receipt(job);
    const monitoring = createRunMonitoringService(db, { now: () => CLOCK, observeJob: async () => {
      await db.query("UPDATE jobs SET status='completed',completed_at='2030-01-01T00:00:08Z' WHERE id=$1", [job.id]); return sample();
    } });
    const detail = await monitoring.get(owner.user.id, project.id, job.id);
    expect(detail.status).toBe('completed'); expect(detail.timing.totalElapsedMs).toBe(8000); expect(detail.resources.state).toBe('unavailable');
    expect(detail.progress).toMatchObject({ state: 'complete', percent: 100 });
  });
  it('rechecks current membership after telemetry before returning any retained logs', async () => {
    const job = await runningJob(); await receipt(job);
    const monitoring = createRunMonitoringService(db, { now: () => CLOCK, observeJob: async () => {
      await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]); return sample();
    } });
    await expect(monitoring.get(owner.user.id, project.id, job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rechecks job ownership after telemetry instead of returning the previously loaded private state', async () => {
    const job = await runningJob(); await receipt(job);
    const monitoring = createRunMonitoringService(db, { now: () => CLOCK, observeJob: async () => {
      await db.query('UPDATE jobs SET owner_user_id=$2 WHERE id=$1', [job.id, colleague.user.id]); return sample();
    } });
    await expect(monitoring.get(owner.user.id, project.id, job.id)).rejects.toMatchObject({ status: 404 });
  });
  it('keeps absent or failed telemetry advisory and never submits or mutates a job', async () => {
    const job = await runningJob(); await receipt(job);
    const original = (await db.query('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0];
    const monitoring = createRunMonitoringService(db, { now: () => CLOCK, observeJob: async () => { throw new Error('Bearer private-value'); } });
    for (let index = 0; index < 3; index++) expect((await monitoring.get(owner.user.id, project.id, job.id)).resources.state).toBe('unavailable');
    expect((await db.query('SELECT * FROM jobs WHERE id=$1', [job.id])).rows[0]).toEqual(original);
    const rejected = await http.api(server, base() + '/' + job.id, { token: owner.token, method: 'POST', body: {} });
    expect(rejected.status).toBe(404); expect((await db.query('SELECT COUNT(*)::int AS count FROM jobs')).rows[0].count).toBe(1);
  });
  it('scrubs bounded recent job logs and error text without exposing nested private fields', async () => {
    const messages = Array.from({ length: 80 }, (_, index) => ({ ts: checkedAt, level: 'info', message: 'Scientific event ' + index }));
    messages.push({ ts: checkedAt, level: 'warn', message: 'Authorization: Bearer private-value', private_path: 'private-nested' });
    messages.push({ ts: checkedAt, level: 'warn', message: 'Prefix ' + 'a'.repeat(8200) + '\n-----BEGIN RSA PRIVATE KEY-----\nprivate-key-body' });
    const job = await createJob(owner, { logs_json: JSON.stringify(messages), error_json: JSON.stringify({ code: 'R_ERROR', message: 'password=private-error', storagePath: 'private-path' }) });
    const detail = await service.get(owner.user.id, project.id, job.id);
    expect(detail.logs.items).toHaveLength(50); expect(detail.logs.omittedCount).toBe(32); expect(detail.logs.truncated).toBe(true); expect(detail.logs.redacted).toBe(true);
    expect(detail.logs.items.at(-1).message).toBe('[Oversized log message omitted]');
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(LIMITS.detailBytes);
    expect(JSON.stringify(detail)).not.toMatch(/private-value|private-key-body|private-error|private-path|private-nested/);
  });
  it('binds private R telemetry to the selected active command and keeps policy limits separate', async () => {
    const entry = await command(); const observeKernel = vi.fn(async () => sample());
    const monitoring = createRunMonitoringService(db, { now: () => CLOCK, observeKernel });
    const detail = await monitoring.get(owner.user.id, project.id, entry.id);
    expect(observeKernel).toHaveBeenCalledWith(expect.objectContaining({ id: entry.kernelId, owner_user_id: String(owner.user.id), runtime_generation: entry.generation }));
    expect(detail.resources).toMatchObject({ state: 'observed', kernelGeneration: entry.generation, dispatchId: null, limits: { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2 } });
    expect(detail.worker.state).toBe('unknown'); expect(detail.logs.note).toContain('streaming output is unavailable');
    expect(JSON.stringify(detail)).not.toMatch(/private source code|source_code|workspace_id/);
  });
  it('withholds a private R sample when another command becomes active during observation', async () => {
    const entry = await command();
    const monitoring = createRunMonitoringService(db, { now: () => CLOCK, observeKernel: async () => {
      await db.query('UPDATE private_r_kernels SET active_execution_id=$2 WHERE id=$1', [entry.kernelId, 'pex_' + 'f'.repeat(24)]); return sample();
    } });
    expect((await monitoring.get(owner.user.id, project.id, entry.id)).resources.state).toBe('unavailable');
  });
  it('does not observe historical commands from a different kernel generation', async () => {
    const entry = await command({ runtimeGeneration: 'f'.repeat(64) }); const observeKernel = vi.fn(async () => sample());
    const detail = await createRunMonitoringService(db, { now: () => CLOCK, observeKernel }).get(owner.user.id, project.id, entry.id);
    expect(observeKernel).not.toHaveBeenCalled(); expect(detail.resources.state).toBe('unavailable'); expect(detail.resources.limits).toBeNull(); expect(detail.target.kind).toBe('unknown');
  });
  it('scrubs complete multiline console output before splitting it into recent logs', async () => {
    const entry = await command({ status: 'completed', result: { stdout: 'Cell count: 12\n-----BEGIN RSA PRIVATE KEY-----\nprivate-key-body\n-----END RSA PRIVATE KEY-----\nDone', warnings: ['password=private-warning'], error: { message: 'file:///private-error' }, tables: [{ secret: 'private-table' }], figures: [{ data: 'private-figure' }] } });
    const detail = await service.get(owner.user.id, project.id, entry.id);
    expect(detail.logs.items.map(item => item.message).join('\n')).toContain('Cell count: 12'); expect(detail.logs.redacted).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/private-key-body|private-warning|private-error|private-table|private-figure/);
    expect(detail.resources.state).toBe('unavailable'); expect(detail.resources.limits).toBeTruthy();
  });
  it('omits oversized console spans entirely rather than returning a partial secret', async () => {
    const entry = await command({ status: 'completed', result: { stdout: '-----BEGIN RSA PRIVATE KEY-----\n' + 'private-key-body'.repeat(5000), warnings: ['private-warning'.repeat(3000)] } });
    const detail = await service.get(owner.user.id, project.id, entry.id);
    expect(detail.logs.items).toEqual([]); expect(detail.logs.truncated).toBe(true); expect(detail.logs.available).toBe(false);
    expect(JSON.stringify(detail)).not.toMatch(/private-key-body|private-warning/);
  });
  it('labels recovery without inventing scientific progress or remaining time', async () => {
    const job = await runningJob(); await db.query('UPDATE jobs SET last_worker_error=$2 WHERE id=$1', [job.id, JSON.stringify({ code: 'R_TIMEOUT_INDETERMINATE', message: 'private recovery token' })]);
    const detail = await service.get(owner.user.id, project.id, job.id);
    expect(detail.progress.note).toContain('reconciling'); expect(detail.progress.percent).toBeNull(); expect(detail.timing.remainingMs).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('private recovery token');
  });
});
