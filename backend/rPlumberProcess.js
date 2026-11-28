'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');
const rRuntime = require('./rRuntime');

// Locates Rscript, launches the owned R Plumber child process and probes its
// health. The web process runs degraded when R is unavailable.
function createRPlumberRuntime({ rRuntimeConfig, apiToken, plumberPort, supportedTarget, appRoot }) {
  let activeRscriptDiagnostic = null;

  function findRscript(env = process.env) {
    const configured = (env.RSCRIPT_PATH || env.RSCRIPT || '').trim();
    if (configured) {
      return {
        path: configured,
        source: env.RSCRIPT_PATH ? 'RSCRIPT_PATH' : 'RSCRIPT',
        exists: path.isAbsolute(configured) ? fs.existsSync(configured) : null
      };
    }
    return { path: 'Rscript', source: 'PATH', exists: null };
  }

  function normalizeRVersion(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    const versionMatch = text.match(/(\d+\.\d+(?:\.\d+)?)/);
    return versionMatch ? versionMatch[1] : text;
  }

  async function probeRHealth(timeoutMs = 750) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${rRuntimeConfig.baseUrl}/health`, {
        headers: { 'X-API-Token': apiToken, Accept: 'application/json' },
        signal: controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `R health returned ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function buildRuntimeDiagnostics() {
    const detectedRscript = activeRscriptDiagnostic || findRscript();
    const diagnostics = {
      supportedTarget: supportedTarget,
      rscript: detectedRscript,
      runtime: {
        status: 'unavailable',
        mode: null,
        rVersion: null
      },
      packages: {}
    };

    try {
      const health = await probeRHealth();
      diagnostics.runtime = {
        status: health.status || 'ok',
        mode: health.mode || null,
        rVersion: normalizeRVersion(health.r_version || health.rVersion || health.version)
      };
      diagnostics.packages = health.packages || {};
    } catch (err) {
      diagnostics.runtime.error = err.name === 'AbortError' ? 'R runtime health probe timed out.' : 'R runtime health probe unavailable.';
    }

    return diagnostics;
  }

  function toPublicRuntimeDiagnostics(diagnostics) {
    const runtime = diagnostics && typeof diagnostics.runtime === 'object' ? diagnostics.runtime : {};
    const status = ['ok', 'ready'].includes(runtime.status) ? runtime.status : 'unavailable';
    return {
      supportedTarget: typeof diagnostics?.supportedTarget === 'string'
        ? diagnostics.supportedTarget : supportedTarget,
      runtime: {
        status,
        rVersion: normalizeRVersion(runtime.rVersion),
      },
    };
  }

  function startPlumber(options = {}) {
    const logger = options.logger || console;
    const spawnFn = options.spawn || spawn;
    activeRscriptDiagnostic = findRscript();
    const rscript = activeRscriptDiagnostic.path;
    const plumberScript = path.join(appRoot, 'r-backend', 'run.R');

    let readySettled = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const resolveReadyOnce = () => {
      if (readySettled) return;
      readySettled = true;
      resolveReady();
    };
    const rejectReadyOnce = (message) => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(new Error(message));
    };
    
    const rProcess = spawnFn(rscript, [plumberScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: rRuntime.buildRChildEnv(process.env, {
        token: apiToken,
        port: plumberPort,
        storageRoot: config.storageRoot(),
        analysisRoot: appRoot,
      })
    });

    rProcess.ready = ready;
    rProcess.stdout.on('data', d => {
      const text = d.toString().trim();
      if (typeof logger.log === 'function') logger.log(`[R] ${text}`);
      else if (typeof logger.info === 'function') logger.info(`[R] ${text}`);
      if (/Plumber API running/i.test(text)) resolveReadyOnce();
    });
    rProcess.stderr.on('data', d => {
      const text = d.toString().trim();
      if (typeof logger.log === 'function') logger.log(`[R:err] ${text}`);
      else if (typeof logger.warn === 'function') logger.warn(`[R:err] ${text}`);
      if (/address already in use|Failed to create server/i.test(text)) {
        rejectReadyOnce('R backend failed to bind its configured port.');
      }
    });
    rProcess.on('close', code => {
      if (typeof logger.log === 'function') logger.log(`R process exited with code ${code}`);
      else if (typeof logger.info === 'function') logger.info(`R process exited with code ${code}`);
      rejectReadyOnce('R backend exited before it became ready.');
    });

    // If Rscript cannot be spawned at all (e.g. not installed, or a bad
    // RSCRIPT_PATH), the child emits an 'error' event. Without a listener that
    // event is thrown as an uncaught exception and takes down the whole web
    // server. The app is designed to run degraded when R is unavailable (runtime
    // diagnostics report R as unavailable and R suites skip), so log a clear,
    // actionable message and keep the Express server alive instead of crashing.
    rProcess.on('error', (err) => {
      logger.error(
        `[R] Failed to launch R Plumber backend via ${activeRscriptDiagnostic.source} ` +
        `("${rscript}"): ${err.message}`
      );
      logger.error(
        '[R] The web server will keep running, but R-backed analysis and /api/r/* ' +
        'will be unavailable until R is reachable. Install R 4.5.x + Seurat, or set ' +
        'RSCRIPT_PATH to a valid Rscript. Runtime diagnostics will report R as unavailable.'
      );
      rejectReadyOnce('R backend process could not be launched.');
    });

    process.on('exit', () => rProcess.kill());
    // Avoid an unhandled rejection when startPlumber is used in degraded mode without
    // awaiting readiness. Callers that gate worker startup still await rProcess.ready.
    ready.catch(() => {});
    return rProcess;
  }

  function startWebRBackend(options = {}) {
    const logger = options.logger || console;
    if (rRuntimeConfig.mode === 'external') {
      if (typeof logger.info === 'function') {
        logger.info('[R] Using configured private external R runtime; the web process will not spawn R.');
      }
      return null;
    }
    return (options.startPlumber || startPlumber)({ logger });
  }

  async function waitForOwnedRHealth(probe = probeRHealth, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;
    const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 500;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    do {
      try {
        const health = await probe();
        if (health && health.status === 'ok') return health;
        lastError = new Error('R backend health check did not return ok.');
      } catch (err) {
        lastError = err;
      }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    } while (Date.now() < deadline);
    throw lastError || new Error('R backend health check failed.');
  }

  return {
    findRscript, probeRHealth, buildRuntimeDiagnostics, toPublicRuntimeDiagnostics,
    startPlumber, startWebRBackend, waitForOwnedRHealth,
  };
}

module.exports = { createRPlumberRuntime };
