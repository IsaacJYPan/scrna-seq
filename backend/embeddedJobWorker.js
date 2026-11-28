'use strict';

const { parseJobWorkerConfig } = require('./jobWorker');

// The opt-in in-process job worker and its shutdown sequence. At most one
// worker loop exists per process.
function createEmbeddedJobWorker({
  db, plumberPort, apiToken, deriveRObjectStateKey, startPlumber, probeRHealth, waitForOwnedRHealth,
}) {
  // ── Job worker (conservative, opt-in) ────────────────────────────────────────
  // Disabled by default. The minimal drain loop only runs when ENABLE_JOB_WORKER is
  // explicitly the string "true", so local/dev and tests stay worker-free unless they
  // ask for it. It processes only registered handlers; arbitrary job types fail
  // terminally instead of becoming dynamic R execution. See backend/jobWorker.js.
  //
  // Config parsing (parseJobWorkerConfig) is deterministic: invalid poll/lease values
  // fall back to documented defaults with a sanitized warning, and any ENABLE_JOB_WORKER
  // value other than exact "true" means disabled.

  // How long shutdown waits for an in-flight worker tick to settle before giving up.
  // Small + bounded so process shutdown never hangs forever on a stuck worker.
  const WORKER_SHUTDOWN_TIMEOUT_MS = 10000;

  let jobWorker = null;

  /**
   * Start the opt-in worker if (and only if) the environment enables it. Idempotent:
   * at most one worker loop exists at a time — a second call while a worker is live
   * returns the existing worker instead of spawning a duplicate loop. Returns the
   * worker, or null when disabled.
   *
   * @param {object} env   environment-like object (defaults to process.env)
   * @param {object} deps  test seams: { createJobWorker, db, logger }
   */
  function startJobWorkerIfEnabled(env = process.env, deps = {}) {
    if (jobWorker) return jobWorker; // never create a duplicate loop
    const logger = deps.logger || console;
    const config = parseJobWorkerConfig(env, { logger });
    if (!config.enabled) return null;
    const { createLanedJobWorker, createJobWorker } = require('./jobWorker');
    const baseCreate = deps.createJobWorker || createJobWorker;
    // Slurm jobs run on their own worker loops so a cluster wait never blocks local work.
    const create = (options) => createLanedJobWorker(options, { env, create: baseCreate });
    // Wire the in-process worker to the local R backend so the r.runtime.check bridge
    // handler can reach it. We build the narrow R caller HERE and pass it as a function
    // (a closure over the secret), so the API token is NEVER placed as a plain field on
    // the worker options object — a function value carries no serializable secret. The
    // worker still runs ONLY the allowlisted, metadata-only R operation through it.
    const callR = require('./rWorkerBridge').createDefaultRCaller({ port: plumberPort, token: apiToken });
    const worker = create({
      db: deps.db || db,
      pollIntervalMs: config.pollIntervalMs,
      leaseSeconds: config.leaseSeconds,
      callR,
      // Inject the canonical, server-only R state-key deriver so the read-only
      // r.object.inspect handler derives the SAME X-Object-ID the /api/r/* proxy would.
      // The client never controls this key (the user-prefix is server-derived).
      deriveRObjectStateKey,
      logger,
    });
    worker.start();
    jobWorker = worker;
    if (typeof logger.info === 'function') {
      logger.info(`[worker] Job worker started (id=${worker.workerId}).`);
    }
    return worker;
  }

  /** Stop the active worker (if any) and clear the singleton. Safe to call with no
   *  worker present and safe to call twice. Returns the worker's stop() promise, or
   *  undefined when there was nothing to stop. */
  function stopJobWorker() {
    if (jobWorker) {
      const stopping = jobWorker.stop();
      jobWorker = null;
      return stopping;
    }
    return undefined;
  }

  /**
   * Graceful shutdown: await the worker's stop()/cleanup (bounded by a timeout so we
   * never hang forever), then stop accepting new connections, then exit. Used by the
   * SIGINT/SIGTERM handlers. Extracted + dependency-injected so the shutdown ordering
   * is directly testable without real signals.
   *
   * @param {object}   args
   * @param {object}   [args.server]    http.Server to close (best-effort; preserves the
   *                                    prior exit-driven teardown — exit still tears it
   *                                    down even if close() is slow).
   * @param {object}   [args.worker]    worker with an async stop(); if omitted, no wait.
   * @param {object}   [args.logger]    { warn, error, … } (default console).
   * @param {number}   [args.timeoutMs] max ms to wait for worker stop (default above).
   * @param {function} [args.exit]      process.exit seam (default process.exit).
   * @returns {Promise<number>} the exit code used (0 ok, 1 if worker stop failed/timed out).
   */
  async function shutdownJobWorkerAndServer(args = {}) {
    const { server, worker } = args;
    const logger = args.logger || console;
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : WORKER_SHUTDOWN_TIMEOUT_MS;
    const exit = typeof args.exit === 'function' ? args.exit : (code) => process.exit(code);
    let exitCode = 0;

    // 1. Wait for the worker to stop, bounded by a timeout so a stuck tick cannot wedge
    //    shutdown. The timer is always cleared (finally) so no timer is leaked.
    if (worker && typeof worker.stop === 'function') {
      let timer = null;
      try {
        const stopped = Promise.resolve().then(() => worker.stop());
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error('Worker stop timed out.'), { code: 'WORKER_STOP_TIMEOUT' })),
            timeoutMs
          );
        });
        await Promise.race([stopped, timeout]);
      } catch (err) {
        // Sanitized: code only, never a stack/message that could carry internals.
        const code = err && err.code ? err.code : 'error';
        if (typeof logger.error === 'function') {
          logger.error(`[worker] shutdown: worker stop failed (${code}); exiting non-zero.`);
        }
        exitCode = 1;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // 2. Stop accepting new connections (best-effort; exit finishes teardown).
    if (server && typeof server.close === 'function') {
      try { server.close(); } catch { /* best-effort; exit tears it down */ }
    }

    exit(exitCode);
    return exitCode;
  }

  async function startRBackendAndJobWorkerIfEnabled(env = process.env, deps = {}) {
    const logger = deps.logger || console;
    const rProcess = (deps.startPlumber || startPlumber)({ logger });
    const config = parseJobWorkerConfig(env, { logger });
    if (!config.enabled) {
      if (typeof logger.info === 'function') {
        logger.info('[worker] Job worker disabled. Set ENABLE_JOB_WORKER=true to drain durable jobs.');
      }
      return { rProcess, worker: null };
    }

    try {
      if (!rProcess || !rProcess.ready || typeof rProcess.ready.then !== 'function') {
        throw new Error('R backend readiness signal is unavailable.');
      }
      await rProcess.ready;
      await waitForOwnedRHealth(deps.probeRHealth || probeRHealth, {
        logger,
        timeoutMs: deps.rHealthTimeoutMs,
        intervalMs: deps.rHealthIntervalMs,
      });
    } catch {
      if (typeof logger.error === 'function') {
        logger.error('[worker] Job worker not started because the owned R backend is not ready. Check plumberPort conflicts and R startup logs.');
      }
      return { rProcess, worker: null };
    }

    return { rProcess, worker: startJobWorkerIfEnabled(env, deps) };
  }

  return { startJobWorkerIfEnabled, stopJobWorker, shutdownJobWorkerAndServer, startRBackendAndJobWorkerIfEnabled };
}

module.exports = { createEmbeddedJobWorker };
