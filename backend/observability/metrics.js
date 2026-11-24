'use strict';

// Operational metrics in the Prometheus text format: queue depth, job
// durations, failing job types, storage free space and agent compute
// reservations. Served at GET /metrics only when METRICS_TOKEN is set, to
// callers presenting it (deploy it on the private network). Values are counts
// and durations; no identifiers, names, paths or parameters are exposed.

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const LABEL = /^[a-z0-9_.-]{1,80}$/i;
const safeLabel = (value) => (typeof value === 'string' && LABEL.test(value) ? value : 'other');

function line(name, labels, value) {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}="${safeLabel(String(v))}"`);
  return `${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${Number.isFinite(value) ? value : 0}`;
}

async function storageFree(root) {
  if (!root) return null;
  try {
    const stats = await fsp.statfs(root, { bigint: true });
    return { free: Number(stats.bavail * stats.bsize), total: Number(stats.blocks * stats.bsize) };
  } catch {
    return null;
  }
}

async function collectOperationalMetrics(db, { storageRoot = null, windowHours = 24 } = {}) {
  const queue = await db.query(
    `SELECT job_type, status, count(*)::bigint AS n FROM jobs
      WHERE status IN ('queued', 'running') GROUP BY job_type, status`
  );
  const durations = await db.query(
    `SELECT job_type,
            count(*)::bigint AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - started_at)) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - started_at)) AS p95
       FROM jobs
      WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
        AND completed_at > now() - make_interval(hours => $1)
      GROUP BY job_type`,
    [windowHours]
  );
  const failures = await db.query(
    `SELECT job_type, COALESCE(error_json::jsonb->>'code', 'unknown') AS code, count(*)::bigint AS n
       FROM jobs
      WHERE status = 'failed' AND updated_at > now() - make_interval(hours => $1)
      GROUP BY job_type, code`,
    [windowHours]
  );
  const agent = await db.query(
    `SELECT count(*)::bigint AS runs, COALESCE(sum(ar.reserved_cpu_seconds), 0)::bigint AS cpu_seconds
       FROM agent_runs ar JOIN jobs j ON j.id = ar.job_id
      WHERE j.status IN ('queued', 'running')`
  );
  return {
    queue: queue.rows.map((r) => ({ jobType: r.job_type, status: r.status, count: Number(r.n) })),
    durations: durations.rows.map((r) => ({
      jobType: r.job_type, count: Number(r.n), p50Seconds: Number(r.p50), p95Seconds: Number(r.p95),
    })),
    failures: failures.rows.map((r) => ({ jobType: r.job_type, code: r.code, count: Number(r.n) })),
    agent: { outstandingRuns: Number(agent.rows[0].runs), reservedCpuSeconds: Number(agent.rows[0].cpu_seconds) },
    storage: await storageFree(storageRoot),
    windowHours,
  };
}

function renderPrometheus(metrics) {
  const out = [
    '# HELP traceomics_jobs Jobs waiting or running, by job type and status.',
    '# TYPE traceomics_jobs gauge',
    ...metrics.queue.map((q) => line('traceomics_jobs', { job_type: q.jobType, status: q.status }, q.count)),
    `# HELP traceomics_job_duration_seconds Completed job run time over the last ${metrics.windowHours} h.`,
    '# TYPE traceomics_job_duration_seconds gauge',
    ...metrics.durations.flatMap((d) => [
      line('traceomics_job_duration_seconds', { job_type: d.jobType, quantile: '0.5' }, d.p50Seconds),
      line('traceomics_job_duration_seconds', { job_type: d.jobType, quantile: '0.95' }, d.p95Seconds),
      line('traceomics_jobs_completed', { job_type: d.jobType }, d.count),
    ]),
    `# HELP traceomics_jobs_failed Failed jobs over the last ${metrics.windowHours} h, by job type and error code.`,
    '# TYPE traceomics_jobs_failed gauge',
    ...metrics.failures.map((f) => line('traceomics_jobs_failed', { job_type: f.jobType, code: f.code }, f.count)),
    '# HELP traceomics_agent_outstanding_runs Agent runs queued or running.',
    '# TYPE traceomics_agent_outstanding_runs gauge',
    line('traceomics_agent_outstanding_runs', {}, metrics.agent.outstandingRuns),
    '# HELP traceomics_agent_reserved_cpu_seconds CPU seconds reserved by outstanding agent runs.',
    '# TYPE traceomics_agent_reserved_cpu_seconds gauge',
    line('traceomics_agent_reserved_cpu_seconds', {}, metrics.agent.reservedCpuSeconds),
  ];
  if (metrics.storage) {
    out.push(
      '# HELP traceomics_storage_free_bytes Free bytes on the durable storage volume.',
      '# TYPE traceomics_storage_free_bytes gauge',
      line('traceomics_storage_free_bytes', {}, metrics.storage.free),
      line('traceomics_storage_total_bytes', {}, metrics.storage.total)
    );
  }
  return `${out.join('\n')}\n`;
}

// Constant-time bearer check; the endpoint does not exist without a token.
function metricsAuthorized(token, header) {
  if (!token || token.length < 32 || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function createMetricsHandler({ db, storageRoot, token = process.env.METRICS_TOKEN } = {}) {
  return async (req, res) => {
    if (!token) return res.status(404).end();
    if (!metricsAuthorized(token, req.headers.authorization)) return res.status(401).end();
    try {
      const body = renderPrometheus(await collectOperationalMetrics(db, { storageRoot: storageRoot() }));
      res.setHeader('Cache-Control', 'no-store');
      res.type('text/plain; version=0.0.4').send(body);
    } catch {
      res.status(503).end();
    }
  };
}

module.exports = { collectOperationalMetrics, renderPrometheus, metricsAuthorized, createMetricsHandler };
