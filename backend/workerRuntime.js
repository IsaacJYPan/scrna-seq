'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const config = require('./config');
const database = require('./pgDatabase');
const storage = require('./storage');
const rBridge = require('./rWorkerBridge');
const rRuntime = require('./rRuntime');
const { expertRSandboxEnabled } = require('./expertR');
const { createExpertSandboxClient } = require('./expertSandboxClient');
const { deriveRObjectStateKey } = require('./rStateKeys');
const {
  createJobWorker,
  DEFAULT_HANDLERS,
  parseJobWorkerConfig,
} = require('./jobWorker');

const STANDALONE_WORKER_DEFAULTS = Object.freeze({
  concurrency: 1,
  poolSize: 1,
  poolSlot: 1,
  minFreeMemoryMb: 1024,
  drainTimeoutMs: 630000,
  startupTimeoutMs: 30000,
  startupRetryMs: 500,
  healthHost: '127.0.0.1',
  healthPort: 3101,
});
const RUNTIME_STATUS_INTERVAL_MS = 5000;

function strictInteger(raw, name, options = {}) {
  const value = raw === undefined || raw === null || String(raw).trim() === ''
    ? options.defaultValue
    : Number(String(raw).trim());
  const min = options.min === undefined ? 1 : options.min;
  const max = options.max === undefined ? Number.MAX_SAFE_INTEGER : options.max;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function parseAllowedJobTypes(raw, handlers = DEFAULT_HANDLERS) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const values = [...new Set(String(raw).split(',').map((value) => value.trim()).filter(Boolean))];
  if (values.length === 0) throw new Error('JOB_WORKER_ALLOWED_JOB_TYPES must contain at least one job type.');
  const unknown = values.filter((value) => typeof handlers[value] !== 'function');
  if (unknown.length > 0) {
    throw new Error('JOB_WORKER_ALLOWED_JOB_TYPES contains an unregistered job type.');
  }
  return values;
}

function parseStandaloneWorkerConfig(env = process.env, options = {}) {
  const logger = options.logger || console;
  const loop = parseJobWorkerConfig(env, { logger });
  const concurrency = strictInteger(env.JOB_WORKER_CONCURRENCY, 'JOB_WORKER_CONCURRENCY', {
    defaultValue: STANDALONE_WORKER_DEFAULTS.concurrency,
    min: 1,
    max: 1,
  });
  const poolSize = strictInteger(env.JOB_WORKER_POOL_SIZE, 'JOB_WORKER_POOL_SIZE', {
    defaultValue: STANDALONE_WORKER_DEFAULTS.poolSize,
    min: 1,
    max: 8,
  });
  const poolSlot = strictInteger(env.JOB_WORKER_POOL_SLOT, 'JOB_WORKER_POOL_SLOT', {
    defaultValue: STANDALONE_WORKER_DEFAULTS.poolSlot,
    min: 1,
    max: poolSize,
  });
  const minFreeMemoryMb = strictInteger(env.JOB_WORKER_MIN_FREE_MEMORY_MB, 'JOB_WORKER_MIN_FREE_MEMORY_MB', {
    defaultValue: STANDALONE_WORKER_DEFAULTS.minFreeMemoryMb,
    min: 1,
    max: 1024 * 1024,
  });
  const drainTimeoutMs = strictInteger(env.JOB_WORKER_DRAIN_TIMEOUT_MS, 'JOB_WORKER_DRAIN_TIMEOUT_MS', {
    defaultValue: STANDALONE_WORKER_DEFAULTS.drainTimeoutMs,
    min: 1000,
    max: 24 * 60 * 60 * 1000,
  });
  const startupTimeoutMs = strictInteger(env.JOB_WORKER_STARTUP_TIMEOUT_MS, 'JOB_WORKER_STARTUP_TIMEOUT_MS', {
    defaultValue: STANDALONE_WORKER_DEFAULTS.startupTimeoutMs,
    min: 100,
    max: 60 * 60 * 1000,
  });
  const healthPort = strictInteger(env.JOB_WORKER_HEALTH_PORT, 'JOB_WORKER_HEALTH_PORT', {
    defaultValue: STANDALONE_WORKER_DEFAULTS.healthPort,
    min: 0,
    max: 65535,
  });
  const healthHost = env.JOB_WORKER_HEALTH_HOST === undefined
    ? STANDALONE_WORKER_DEFAULTS.healthHost
    : String(env.JOB_WORKER_HEALTH_HOST).trim();
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(healthHost)) {
    throw new Error('JOB_WORKER_HEALTH_HOST must be 127.0.0.1, ::1, or 0.0.0.0.');
  }
  const reportReadiness = env.JOB_WORKER_REPORT_READINESS !== 'false';
  return Object.freeze({
    enabled: loop.enabled,
    pollIntervalMs: loop.pollIntervalMs,
    leaseSeconds: loop.leaseSeconds,
    concurrency,
    poolSize,
    poolSlot,
    minFreeMemoryMb,
    drainTimeoutMs,
    startupTimeoutMs,
    startupRetryMs: STANDALONE_WORKER_DEFAULTS.startupRetryMs,
    healthHost,
    healthPort,
    reportReadiness,
    allowedJobTypes: parseAllowedJobTypes(env.JOB_WORKER_ALLOWED_JOB_TYPES, options.handlers),
  });
}

function availableMemoryBytes() {
  if (typeof process.availableMemory === 'function') return process.availableMemory();
  return os.freemem();
}

function ensureStorageProbe(storageRoot, options = {}) {
  const root = path.resolve(storageRoot);
  fs.mkdirSync(root, { recursive: true });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw Object.assign(new Error('Worker durable storage root is not a safe directory.'), { code: 'STORAGE_ROOT_UNSAFE' });
  }
  fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  const nonce = options.nonce || crypto.randomBytes(16).toString('hex');
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    throw Object.assign(new Error('Worker durable storage challenge is invalid.'), { code: 'STORAGE_PROBE_INVALID' });
  }
  const fileName = `${rRuntime.STORAGE_PROBE_PREFIX}${nonce}`;
  const probePath = path.join(root, fileName);
  try {
    fs.writeFileSync(probePath, rRuntime.STORAGE_PROBE_CONTENT, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const probeStat = fs.lstatSync(probePath);
  if (!probeStat.isFile() || probeStat.isSymbolicLink()
      || fs.readFileSync(probePath, 'utf8') !== rRuntime.STORAGE_PROBE_CONTENT) {
    throw Object.assign(new Error('Worker durable storage probe is unsafe or invalid.'), { code: 'STORAGE_PROBE_INVALID' });
  }
  return Object.freeze({ path: probePath, fileName, nonce });
}

function removeStorageProbe(probe) {
  if (!probe || typeof probe.path !== 'string' || !fs.existsSync(probe.path)) return false;
  const stat = fs.lstatSync(probe.path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('Worker durable storage probe was replaced unsafely.'), { code: 'STORAGE_PROBE_INVALID' });
  }
  fs.unlinkSync(probe.path);
  return true;
}

function safeErrorCode(error, fallback = 'NOT_READY') {
  const code = error && typeof error.code === 'string' ? error.code : fallback;
  return code.replace(/[^A-Z0-9_]/gi, '').slice(0, 64) || fallback;
}

function closeHttpServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function createHealthServer(state) {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/livez') {
      res.statusCode = state.live ? 200 : 503;
      res.end(JSON.stringify({ status: state.live ? 'live' : 'stopping' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      const ready = state.ready && state.acceptingClaims && !state.draining;
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStandaloneWorkerRuntime(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const handlers = options.handlers || DEFAULT_HANDLERS;
  const runtimeConfig = options.workerConfig || parseStandaloneWorkerConfig(env, { logger, handlers });
  const rConfig = options.rConfig || rRuntime.resolveRRuntimeConfig(env, { role: 'worker' });
  const db = options.db || database;
  const storageProvider = options.storageProvider || storage.createLocalStorageProvider({ root: config.storageRoot() });
  const memoryProbe = options.availableMemoryBytes || availableMemoryBytes;
  const probeR = options.probeRReadiness
    || ((cfg, probeOptions) => rRuntime.probeWorkerRReadiness(cfg, probeOptions));
  const createWorker = options.createJobWorker || createJobWorker;
  const createServer = options.createHealthServer || createHealthServer;
  const onFatal = typeof options.onFatal === 'function' ? options.onFatal : () => {};

  const state = {
    live: true,
    ready: false,
    acceptingClaims: false,
    draining: false,
    lastReadinessCode: 'STARTING',
  };
  let worker = null;
  let healthServer = null;
  let storageProbe = null;
  let topologyLock = null;
  let runtimeStatusTimer = null;
  let started = false;
  let startPromise = null;
  let shutdownPromise = null;
  let fatalPromise = null;

  function snapshot() {
    return Object.freeze({
      live: state.live,
      ready: state.ready,
      acceptingClaims: state.acceptingClaims,
      draining: state.draining,
      lastReadinessCode: state.lastReadinessCode,
      workerId: worker ? worker.workerId : null,
      healthAddress: healthServer && healthServer.listening ? healthServer.address() : null,
    });
  }

  async function publishRuntimeStatus() {
    if (!runtimeConfig.reportReadiness || typeof db.reportStandaloneWorkerRuntimeState !== 'function') return;
    const status = state.draining
      ? 'draining'
      : state.ready && state.acceptingClaims
        ? 'ready'
        : 'unavailable';
    try {
      await db.reportStandaloneWorkerRuntimeState(status, { slot: runtimeConfig.poolSlot });
    } catch (error) {
      // Status reporting must never weaken the worker's admission and claim
      // gates. A failed heartbeat naturally becomes unavailable after its TTL.
      if (typeof logger.warn === 'function') {
        logger.warn(`[worker] Runtime status heartbeat failed (${safeErrorCode(error, 'STATUS_HEARTBEAT_FAILED')}).`);
      }
    }
  }

  function startRuntimeStatusHeartbeat() {
    if (runtimeStatusTimer || typeof db.reportStandaloneWorkerRuntimeState !== 'function') return;
    runtimeStatusTimer = setInterval(() => { void publishRuntimeStatus(); }, RUNTIME_STATUS_INTERVAL_MS);
    if (typeof runtimeStatusTimer.unref === 'function') runtimeStatusTimer.unref();
  }

  function stopRuntimeStatusHeartbeat() {
    if (!runtimeStatusTimer) return;
    clearInterval(runtimeStatusTimer);
    runtimeStatusTimer = null;
  }

  async function checkDependencies() {
    if (state.draining) return { ready: false, reason: 'DRAINING' };
    try {
      if (!topologyLock || typeof topologyLock.check !== 'function') {
        throw Object.assign(new Error('Worker topology lock is unavailable.'), {
          code: 'WORKER_TOPOLOGY_LOCK_LOST',
        });
      }
      await topologyLock.check();
      const free = Number(memoryProbe());
      if (!Number.isFinite(free) || free < runtimeConfig.minFreeMemoryMb * 1024 * 1024) {
        throw Object.assign(new Error('Insufficient available memory for another heavy R job.'), { code: 'MEMORY_ADMISSION_PAUSED' });
      }
      if (typeof db.checkHealth === 'function') await db.checkHealth();
      const rReady = await probeR(rConfig, { storageProbeNonce: storageProbe && storageProbe.nonce });
      state.ready = true;
      state.lastReadinessCode = 'READY';
      return {
        ready: true,
        recoveryBarrierSafe: runtimeConfig.poolSize === 1,
        rRuntimeInstanceHash: rReady && typeof rReady.runtime_session_id === 'string'
          ? crypto.createHash('sha256').update(rReady.runtime_session_id).digest('hex')
          : null,
      };
    } catch (error) {
      state.ready = false;
      state.lastReadinessCode = safeErrorCode(error);
      if (state.lastReadinessCode === 'WORKER_TOPOLOGY_LOCK_LOST' && started && !state.draining) {
        state.acceptingClaims = false;
        fatalPromise = fatalPromise || Promise.resolve()
          .then(() => shutdown())
          .finally(() => onFatal(1))
          .catch(() => {});
      }
      return { ready: false, reason: state.lastReadinessCode };
    }
  }

  async function waitUntilReady() {
    const deadline = Date.now() + runtimeConfig.startupTimeoutMs;
    do {
      const result = await checkDependencies();
      if (result.ready) return;
      if (Date.now() >= deadline) break;
      await wait(Math.min(runtimeConfig.startupRetryMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw Object.assign(new Error('Worker dependencies did not become ready before the startup deadline.'), {
      code: state.lastReadinessCode || 'STARTUP_NOT_READY',
    });
  }

  async function listenHealth() {
    healthServer = createServer(state);
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        healthServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        healthServer.off('error', onError);
        resolve();
      };
      healthServer.once('error', onError);
      healthServer.once('listening', onListening);
      healthServer.listen(runtimeConfig.healthPort, runtimeConfig.healthHost);
    });
  }

  async function performStart(startOptions = {}) {
    if (!runtimeConfig.enabled) {
      throw Object.assign(new Error('Standalone worker is disabled. Set ENABLE_JOB_WORKER=true.'), { code: 'WORKER_DISABLED' });
    }
    started = true;
    try {
      await listenHealth();
      storageProbe = ensureStorageProbe(storageProvider.root);
      await db.initSchema();
      if (typeof db.acquireStandaloneWorkerLock !== 'function') {
        throw Object.assign(new Error('Database worker topology lock is unavailable.'), {
          code: 'WORKER_TOPOLOGY_LOCK_UNAVAILABLE',
        });
      }
      topologyLock = await db.acquireStandaloneWorkerLock({
        slot: runtimeConfig.poolSlot,
        poolSize: runtimeConfig.poolSize,
      });
      await waitUntilReady();
      const callR = rBridge.createDefaultRCaller({ baseUrl: rConfig.baseUrl, token: rConfig.token });
      const runExpertSandbox = expertRSandboxEnabled()
        ? createExpertSandboxClient({
          baseUrl: process.env.EXPERT_R_SANDBOX_URL,
          token: process.env.EXPERT_R_SANDBOX_TOKEN,
          timeoutMs: Number(process.env.EXPERT_R_CLIENT_TIMEOUT_MS || 780000),
        }) : undefined;
      worker = createWorker({
        db,
        workerId: `pool-${runtimeConfig.poolSlot}:${crypto.randomUUID()}`,
        handlers,
        pollIntervalMs: runtimeConfig.pollIntervalMs,
        leaseSeconds: runtimeConfig.leaseSeconds,
        allowedJobTypes: runtimeConfig.allowedJobTypes,
        maxConcurrentClaims: runtimeConfig.poolSize,
        claimGate: checkDependencies,
        callR,
        deriveRObjectStateKey,
        runExpertSandbox,
        storageProvider,
        logger,
      });
      state.acceptingClaims = true;
      state.ready = true;
      await publishRuntimeStatus();
      startRuntimeStatusHeartbeat();
      if (startOptions.autoStart !== false) worker.start();
      if (typeof logger.info === 'function') {
        logger.info(`[worker] Worker-pool slot ${runtimeConfig.poolSlot}/${runtimeConfig.poolSize} ready (id=${worker.workerId}, concurrency=1).`);
      }
      return snapshot();
    } catch (error) {
      state.ready = false;
      state.acceptingClaims = false;
      stopRuntimeStatusHeartbeat();
      await closeHttpServer(healthServer);
      if (storageProbe) {
        try { removeStorageProbe(storageProbe); } catch { /* startup is already failing */ }
        storageProbe = null;
      }
      if (topologyLock) {
        try { await topologyLock.release(); } catch { /* startup is already failing */ }
        topologyLock = null;
      }
      if (typeof db.close === 'function') await Promise.resolve(db.close()).catch(() => {});
      healthServer = null;
      started = false;
      throw error;
    }
  }

  function start(startOptions = {}) {
    if (started && state.ready) return Promise.resolve(snapshot());
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        return await performStart(startOptions);
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  function shutdown(shutdownOptions = {}) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      state.draining = true;
      state.ready = false;
      state.acceptingClaims = false;
      await publishRuntimeStatus();
      stopRuntimeStatusHeartbeat();
      const timeoutMs = shutdownOptions.timeoutMs === undefined
        ? runtimeConfig.drainTimeoutMs
        : Number(shutdownOptions.timeoutMs);
      let exitCode = 0;
      let timer = null;
      if (worker) {
        try {
          const drain = Promise.resolve().then(() => worker.stop());
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Worker drain timed out.'), {
              code: 'WORKER_DRAIN_TIMEOUT',
            })), timeoutMs);
          });
          await Promise.race([drain, timeout]);
        } catch (error) {
          exitCode = 1;
          if (typeof logger.error === 'function') {
            logger.error(`[worker] shutdown failed (${safeErrorCode(error, 'SHUTDOWN_FAILED')}).`);
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      await closeHttpServer(healthServer);
      if (storageProbe) {
        try { removeStorageProbe(storageProbe); } catch { exitCode = 1; }
        storageProbe = null;
      }
      if (topologyLock) {
        try { await topologyLock.release(); } catch { exitCode = 1; }
        topologyLock = null;
      }
      if (typeof db.close === 'function') {
        try { await db.close(); } catch { exitCode = 1; }
      }
      state.live = false;
      return exitCode;
    })();
    return shutdownPromise;
  }

  return Object.freeze({
    start,
    shutdown,
    checkDependencies,
    snapshot,
    get worker() { return worker; },
    get config() { return runtimeConfig; },
  });
}

module.exports = {
  STANDALONE_WORKER_DEFAULTS,
  RUNTIME_STATUS_INTERVAL_MS,
  strictInteger,
  parseAllowedJobTypes,
  parseStandaloneWorkerConfig,
  availableMemoryBytes,
  ensureStorageProbe,
  removeStorageProbe,
  createHealthServer,
  createStandaloneWorkerRuntime,
};
