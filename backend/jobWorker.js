// ── Minimal job worker drain loop ────────────────────────────────────────────
//
// The smallest production-oriented worker that consumes the durable job-worker
// coordination contract shipped in database.js (claim / lease / heartbeat /
// complete / fail / release / reap). It proves a queued job can be claimed,
// heartbeated, completed or failed, protected from duplicate workers, and handled
// safely after cancellation or lease expiry — with durable status + logs.
//
// SCOPE (this branch): NO scientific pipeline execution. The only supported
// handler is a safe, deterministic `generic` noop that appends a log and returns a
// tiny JSON result; it runs NO R/Seurat work, creates NO artifacts/checkpoints,
// and produces NO downloads. Every other (otherwise valid) job type is
// intentionally UNREGISTERED and is failed with UNSUPPORTED_JOB_TYPE — see the
// handler-registry policy below.
//
// HANDLER-REGISTRY POLICY (preferred policy from the contract):
//   The worker only runs job types present in its handler registry. An unknown /
//   unregistered job type is still CLAIMED, then immediately FAILED with a durable
//   `UNSUPPORTED_JOB_TYPE` error. This is deliberate: it prevents an unsupported
//   job from looping forever (claim → release → claim …) and records why it could
//   not run. Because claim consumes an attempt and failJobByWorker is terminal, an
//   unsupported job ends in `failed`, never re-queued.
//
// CANCELLATION (cooperative / status-level only, this branch): canceling a job
//   clears its claim_token + lease and moves it to a terminal status. The worker
//   therefore loses its claim; its next heartbeat/complete/fail throws CLAIM_LOST
//   and the worker stops touching the job (it is NEVER resurrected to completed).
//   This does NOT kill in-flight R work — there is no R handler here to kill.

const crypto = require('crypto');
const database = require('./database');

/** Stable, header-safe worker id (`worker_` + hex). One per worker instance. */
function generateWorkerId() {
  return `worker_${crypto.randomBytes(8).toString('hex')}`;
}

// Error code recorded on a job whose type has no registered handler.
const UNSUPPORTED_JOB_TYPE = 'UNSUPPORTED_JOB_TYPE';

// Documented safe defaults for worker runtime config. These MUST match the values
// documented in .env.example (JOB_WORKER_POLL_MS / JOB_WORKER_LEASE_SECONDS) and the
// createJobWorker() option defaults above.
const JOB_WORKER_DEFAULTS = Object.freeze({ pollIntervalMs: 1000, leaseSeconds: 30 });

/**
 * Parse a value that must be a positive integer (poll ms / lease seconds). Returns
 * the integer, or null for anything invalid: undefined/null, blank, non-numeric,
 * NaN, Infinity, non-integer, zero, or negative. Callers decide the fallback/fail
 * policy. (Zero is rejected: a zero poll interval would busy-loop and a zero lease
 * would expire instantly, so neither is a meaningful runtime value here.)
 */
function parsePositiveIntOrNull(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Parse worker runtime config from an environment-like object, deterministically and
 * safely. Policy (documented in docs/architecture.md + .env.example):
 *   - `enabled` is true ONLY for the exact string "true" on ENABLE_JOB_WORKER. Any
 *     other value ("TRUE", "1", "yes", blank, unset, …) means disabled.
 *   - JOB_WORKER_POLL_MS must be a positive integer; otherwise fall back to the
 *     documented default and warn (only if the var was present but invalid).
 *   - JOB_WORKER_LEASE_SECONDS must be a positive integer; otherwise fall back to the
 *     documented default and warn (only if present but invalid).
 * Warnings name the variable and the default used — never the raw value — so no
 * secret or operator-supplied content is echoed. Returns
 * { enabled, pollIntervalMs, leaseSeconds }.
 */
function parseJobWorkerConfig(env = {}, opts = {}) {
  const defaults = opts.defaults || JOB_WORKER_DEFAULTS;
  const logger = opts.logger || console;
  const warn = (m) => { if (logger && typeof logger.warn === 'function') logger.warn(m); };

  const enabled = env.ENABLE_JOB_WORKER === 'true';

  const pollRaw = env.JOB_WORKER_POLL_MS;
  let pollIntervalMs = parsePositiveIntOrNull(pollRaw);
  if (pollIntervalMs === null) {
    if (pollRaw !== undefined) {
      warn(`[worker] JOB_WORKER_POLL_MS is not a positive integer; using default ${defaults.pollIntervalMs}ms.`);
    }
    pollIntervalMs = defaults.pollIntervalMs;
  }

  const leaseRaw = env.JOB_WORKER_LEASE_SECONDS;
  let leaseSeconds = parsePositiveIntOrNull(leaseRaw);
  if (leaseSeconds === null) {
    if (leaseRaw !== undefined) {
      warn(`[worker] JOB_WORKER_LEASE_SECONDS is not a positive integer; using default ${defaults.leaseSeconds}s.`);
    }
    leaseSeconds = defaults.leaseSeconds;
  }

  return { enabled, pollIntervalMs, leaseSeconds };
}

/**
 * The only supported handler in this branch. A safe, deterministic noop: it
 * heartbeats once (proving the cooperative heartbeat seam works), writes a durable
 * log line, and returns a tiny JSON result. It runs NO R/Seurat work and touches
 * NO shared state. Handlers receive a `ctx` with:
 *   - ctx.job       the claimed worker-job (includes jobType, parameters)
 *   - ctx.workerId  this worker's id
 *   - ctx.heartbeat()  extend the lease mid-run (throws CLAIM_LOST if claim is gone)
 *   - ctx.log(entry)   append a durable, claim-guarded progress log (best-effort)
 *   - ctx.logger    the process logger (non-durable)
 * A handler returns `{ result?, resultAnalysisObjectId? }` (or nothing). It must
 * NOT put secrets, tokens, or filesystem paths into thrown error messages or logs.
 */
async function genericNoopHandler(ctx) {
  ctx.heartbeat();
  ctx.log({ level: 'info', message: 'noop handler: no pipeline execution in this branch.' });
  return { result: { ok: true, handled: 'generic', noop: true } };
}

// Default registry: ONLY `generic` is supported. (Job types are a fixed server-side
// allow-list in database.js — normalize/qc_filter/pca/cluster/umap/find_markers/
// integrate/generic — and the real analytical types are deliberately left
// unregistered here so the worker fails them instead of pretending to run them.)
const DEFAULT_HANDLERS = Object.freeze({ generic: genericNoopHandler });

/**
 * Create a job worker. Returns a runner with `runOnce()`, `start()`, `stop()`,
 * `isRunning()`, and `workerId`. Nothing starts automatically — `start()` must be
 * called explicitly (server startup does this only when ENABLE_JOB_WORKER=true).
 *
 * Options:
 *   - db                 coordination helpers (defaults to ./database); injectable for tests
 *   - workerId           this worker's id (defaults to a fresh generated id)
 *   - pollIntervalMs     delay between idle ticks in start() (default 1000)
 *   - leaseSeconds       claim lease length passed to claim/heartbeat (default 30)
 *   - heartbeatIntervalMs advisory; handlers heartbeat cooperatively via ctx.heartbeat()
 *   - handlers           job_type → async handler registry (default DEFAULT_HANDLERS)
 *   - logger             { info, warn, error } (default console)
 *   - now                optional clock: a function (or string) returning a SQLite
 *                        'YYYY-MM-DD HH:MM:SS' timestamp, so tests drive lease timing
 *                        deterministically. Omit in production to use the DB clock.
 */
function createJobWorker(options = {}) {
  const {
    db = database,
    workerId = generateWorkerId(),
    pollIntervalMs = 1000,
    leaseSeconds = 30,
    heartbeatIntervalMs = Math.max(1000, Math.floor((30 * 1000) / 3)),
    handlers = DEFAULT_HANDLERS,
    logger = console,
    now,
  } = options;

  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('pollIntervalMs must be a non-negative integer.');
  }

  let running = false;
  let timer = null;
  let tickInFlight = null;

  const log = {
    info: (m) => { if (logger && typeof logger.info === 'function') logger.info(m); },
    warn: (m) => { if (logger && typeof logger.warn === 'function') logger.warn(m); },
    error: (m) => { if (logger && typeof logger.error === 'function') logger.error(m); },
  };

  function resolveNowTs() {
    if (typeof now === 'function') return now();
    if (typeof now === 'string') return now;
    return undefined;
  }

  /** Best-effort durable progress log; swallows CLAIM_LOST so logging never crashes
   *  a tick (the job may have been canceled/reaped between claim and log). */
  function safeWorkerLog(jobId, claimToken, entry, nowTs) {
    try {
      db.appendJobLogByWorker(jobId, workerId, claimToken, entry, withNow({}, nowTs));
      return true;
    } catch (err) {
      if (err && (err.code === 'CLAIM_LOST' || err.code === 'JOB_NOT_FOUND')) return false;
      log.warn(`[worker ${workerId}] could not append log to ${jobId}: ${err && err.code ? err.code : 'error'}`);
      return false;
    }
  }

  function withNow(extra, nowTs) {
    return nowTs === undefined ? { ...extra } : { ...extra, now: nowTs };
  }

  // A CLAIM_LOST / JOB_NOT_FOUND while completing/failing means the job was
  // canceled or reaped out from under us: do NOT resurrect it. Re-throw anything
  // else so genuine bugs surface.
  function asClaimLoss(err, phase, jobId, jobType, reaped) {
    if (err && (err.code === 'CLAIM_LOST' || err.code === 'JOB_NOT_FOUND')) {
      log.warn(`[worker ${workerId}] claim lost before ${phase} of ${jobId}; not resurrecting.`);
      return { status: 'claim_lost', jobId, jobType, phase, reaped };
    }
    throw err;
  }

  /**
   * One drain tick: reap expired leases, claim one eligible job, run its handler
   * (or fail it as unsupported), and complete/fail it through the contract. Returns
   * a small result object describing what happened — never throws for the normal
   * idle/claim-loss/handler-failure paths.
   */
  async function runOnce() {
    const nowTs = resolveNowTs();

    // 1. Recover expired leases FIRST so a crashed worker's job becomes claimable.
    let reaped = { requeued: [], failed: [] };
    try {
      reaped = db.reapExpiredJobs(withNow({}, nowTs));
    } catch (err) {
      log.error(`[worker ${workerId}] reap failed: ${err && err.code ? err.code : err.message}`);
    }

    // 2. Claim one eligible queued job (single-winner; null if none available).
    let job;
    try {
      job = db.claimNextJob(workerId, withNow({ leaseSeconds }, nowTs));
    } catch (err) {
      log.error(`[worker ${workerId}] claim failed: ${err && err.code ? err.code : err.message}`);
      return { status: 'error', phase: 'claim', reaped };
    }
    if (!job) return { status: 'idle', reaped };

    const { id: jobId, jobType, claimToken } = job;
    safeWorkerLog(jobId, claimToken, { level: 'info', message: `Claimed by worker (type=${jobType}).` }, nowTs);
    log.info(`[worker ${workerId}] claimed ${jobId} (${jobType})`);

    const handler = handlers[jobType];
    if (typeof handler !== 'function') {
      return failUnsupported(jobId, jobType, claimToken, nowTs, reaped);
    }

    // Heartbeat once up front so the lease covers the handler's run. If the claim is
    // already gone (canceled/reaped between claim and now), bail without resurrecting.
    try {
      db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, nowTs));
    } catch (err) {
      return asClaimLoss(err, 'pre-handler-heartbeat', jobId, jobType, reaped);
    }

    safeWorkerLog(jobId, claimToken, { level: 'info', message: 'Handler started.' }, nowTs);

    const ctx = {
      job,
      workerId,
      heartbeat: () => db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, resolveNowTs())),
      log: (entry) => safeWorkerLog(jobId, claimToken, entry, resolveNowTs()),
      logger: log,
    };

    let outcome;
    try {
      outcome = await handler(ctx);
    } catch (handlerErr) {
      return failHandlerError(jobId, jobType, claimToken, handlerErr, resolveNowTs(), reaped);
    }

    // 3. Success → complete through the contract (guarded UPDATE; will not resurrect
    //    a job canceled mid-run — that surfaces as CLAIM_LOST).
    const completeNow = resolveNowTs();
    const completeOpts = withNow({ log: { level: 'info', message: 'Handler completed.' } }, completeNow);
    if (outcome && typeof outcome === 'object' && outcome.resultAnalysisObjectId) {
      completeOpts.resultAnalysisObjectId = outcome.resultAnalysisObjectId;
    }
    try {
      db.completeJobByWorker(jobId, workerId, claimToken, completeOpts);
    } catch (err) {
      return asClaimLoss(err, 'complete', jobId, jobType, reaped);
    }
    log.info(`[worker ${workerId}] completed ${jobId} (${jobType})`);
    return { status: 'completed', jobId, jobType, result: outcome && outcome.result, reaped };
  }

  function failUnsupported(jobId, jobType, claimToken, nowTs, reaped) {
    log.warn(`[worker ${workerId}] unsupported job type '${jobType}' for ${jobId}; failing.`);
    const opts = withNow({ log: { level: 'error', message: `Unsupported job type '${jobType}'.` } }, nowTs);
    try {
      db.failJobByWorker(
        jobId, workerId, claimToken,
        { code: UNSUPPORTED_JOB_TYPE, message: `No handler registered for job type '${jobType}'.` },
        opts
      );
    } catch (err) {
      return asClaimLoss(err, 'fail-unsupported', jobId, jobType, reaped);
    }
    return { status: 'unsupported', jobId, jobType, reaped };
  }

  function failHandlerError(jobId, jobType, claimToken, handlerErr, nowTs, reaped) {
    // If the handler failed BECAUSE the claim was lost (e.g. a cooperative
    // ctx.heartbeat() detected cancellation), do not try to fail the job — it is no
    // longer ours.
    if (handlerErr && (handlerErr.code === 'CLAIM_LOST' || handlerErr.code === 'JOB_NOT_FOUND')) {
      log.warn(`[worker ${workerId}] claim lost during handler for ${jobId}; not resurrecting.`);
      return { status: 'claim_lost', jobId, jobType, phase: 'handler', reaped };
    }
    // Record a sanitized message only — never a stack/path. Handlers are responsible
    // for not embedding secrets in their error messages.
    const message = handlerErr && handlerErr.message ? String(handlerErr.message) : 'Handler error.';
    log.error(`[worker ${workerId}] handler error for ${jobId}: ${message}`);
    const opts = withNow({ log: { level: 'error', message: 'Handler failed.' } }, nowTs);
    try {
      db.failJobByWorker(jobId, workerId, claimToken, { code: 'HANDLER_ERROR', message }, opts);
    } catch (err) {
      return asClaimLoss(err, 'fail-handler', jobId, jobType, reaped);
    }
    return { status: 'failed', jobId, jobType, error: { code: 'HANDLER_ERROR', message }, reaped };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  // start() runs a self-rescheduling setTimeout loop (NOT setInterval) so a slow
  // tick never overlaps itself and stop() can deterministically clear the single
  // pending timer — no leaked timers.
  async function tick() {
    timer = null;
    if (!running) return;
    tickInFlight = runOnce()
      .catch((err) => log.error(`[worker ${workerId}] tick error: ${err && err.message ? err.message : err}`))
      .finally(() => { tickInFlight = null; });
    await tickInFlight;
    if (running) timer = setTimeout(tick, pollIntervalMs);
  }

  function start() {
    if (running) return;
    running = true;
    timer = setTimeout(tick, 0);
  }

  async function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    // Let any in-flight tick settle so we never leave a half-finished claim behind.
    if (tickInFlight) { try { await tickInFlight; } catch { /* already logged */ } }
  }

  function isRunning() {
    return running;
  }

  return { runOnce, start, stop, isRunning, workerId, leaseSeconds };
}

module.exports = {
  createJobWorker,
  generateWorkerId,
  genericNoopHandler,
  DEFAULT_HANDLERS,
  UNSUPPORTED_JOB_TYPE,
  JOB_WORKER_DEFAULTS,
  parseJobWorkerConfig,
  parsePositiveIntOrNull,
};
