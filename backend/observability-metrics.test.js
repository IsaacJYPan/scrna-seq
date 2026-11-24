import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';

const config = require('./config');
const db = require('./pgDatabase');
const { collectOperationalMetrics, renderPrometheus, metricsAuthorized, createMetricsHandler } = require('./observability/metrics');

const CONFIGURED = config.hasPostgresConnection();
const TOKEN = 'm'.repeat(40);

function response() {
  const res = { statusCode: 200, headers: {}, body: '' };
  res.status = (code) => { res.statusCode = code; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.type = (t) => { res.headers['Content-Type'] = t; return res; };
  res.send = (body) => { res.body = body; return res; };
  return res;
}

describe('metrics access', () => {
  it('requires a configured token of adequate length, compared in constant time', () => {
    expect(metricsAuthorized(TOKEN, `Bearer ${TOKEN}`)).toBe(true);
    expect(metricsAuthorized(TOKEN, `Bearer ${'x'.repeat(40)}`)).toBe(false);
    expect(metricsAuthorized(TOKEN, undefined)).toBe(false);
    expect(metricsAuthorized('short', 'Bearer short')).toBe(false);
  });

  it('does not exist without a token and refuses callers without it', async () => {
    const off = response();
    await createMetricsHandler({ db: {}, storageRoot: () => null, token: '' })({ headers: {} }, off);
    expect(off.statusCode).toBe(404);
    const denied = response();
    await createMetricsHandler({ db: {}, storageRoot: () => null, token: TOKEN })({ headers: {} }, denied);
    expect(denied.statusCode).toBe(401);
  });

  it('renders only bounded labels, never identifiers or free text', () => {
    const text = renderPrometheus({
      queue: [{ jobType: 'seurat.pipeline.v1', status: 'queued', count: 3 }],
      durations: [], failures: [{ jobType: 'x"} injected{', code: 'R_FAILED', count: 1 }],
      agent: { outstandingRuns: 1, reservedCpuSeconds: 3600 }, storage: { free: 10, total: 20 }, windowHours: 24,
    });
    expect(text).toContain('traceomics_jobs{job_type="seurat.pipeline.v1",status="queued"} 3');
    expect(text).toContain('traceomics_jobs_failed{job_type="other",code="R_FAILED"} 1');
    expect(text).toContain('traceomics_storage_free_bytes 10');
  });
});

describe.skipIf(!CONFIGURED)('structured job events', () => {
  beforeEach(async () => { await db.resetSchemaForTests(); await db.initSchema(); });

  it('logs one JSON line per finished job without identifiers', async () => {
    const { createJobWorker } = require('./jobWorker');
    const user = await db.createUser('events@example.com', 'password123', 'Events');
    await db.createJobForUser(user.id, { jobType: 'r.runtime.check' });
    const lines = [];
    const logger = { info: (text) => lines.push(text), warn() {}, error() {}, log() {} };
    const worker = createJobWorker({ db, logger, callR: async () => ({ status: 503, body: {} }) });
    const outcome = await worker.runOnce();
    const event = lines.map((text) => { try { return JSON.parse(text); } catch { return null; } })
      .find((entry) => entry && entry.event === 'job.finished');
    expect(event).toMatchObject({ event: 'job.finished', jobType: 'r.runtime.check', status: outcome.status });
    expect(typeof event.durationMs).toBe('number');
    expect(JSON.stringify(event)).not.toContain(outcome.jobId);
  });
});

describe.skipIf(!CONFIGURED)('metrics collection', () => {
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.resetSchemaForTests(); await db.initSchema(); });

  it('reports queue depth, failures and storage from the database', async () => {
    const user = await db.createUser('metrics@example.com', 'password123', 'Metrics');
    const queued = await db.createJobForUser(user.id, { jobType: 'r.runtime.check' });
    await db.query("UPDATE jobs SET status = 'failed', error_json = $2 WHERE id = $1",
      [queued.id, JSON.stringify({ code: 'R_RUNTIME_UNAVAILABLE' })]);
    await db.createJobForUser(user.id, { jobType: 'r.runtime.check' });
    const metrics = await collectOperationalMetrics(db, { storageRoot: os.tmpdir() });
    expect(metrics.queue).toEqual([{ jobType: 'r.runtime.check', status: 'queued', count: 1 }]);
    expect(metrics.failures).toEqual([{ jobType: 'r.runtime.check', code: 'R_RUNTIME_UNAVAILABLE', count: 1 }]);
    expect(metrics.storage.free).toBeGreaterThan(0);
    expect(metrics.agent).toEqual({ outstandingRuns: 0, reservedCpuSeconds: 0 });
    const res = response();
    await createMetricsHandler({ db, storageRoot: () => os.tmpdir(), token: TOKEN })(
      { headers: { authorization: `Bearer ${TOKEN}` } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('traceomics_jobs{job_type="r.runtime.check",status="queued"} 1');
  });
});
