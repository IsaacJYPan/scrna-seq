#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_WORKER_DRAIN_MS = 630000;
const DEFAULT_CHILD_STOP_MS = 15000;
// The production worker deliberately keeps its 1 GiB admission default in
// workerRuntime.js. The all-in-one local supervisor needs a smaller fallback so
// contributors can exercise the durable workflow on constrained workstations.
// An explicit environment value always wins.
const DEFAULT_DEV_WORKER_MIN_FREE_MEMORY_MB = 256;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
    };
    const onExit = () => { cleanup(); resolve(); };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('Child did not stop before its deadline.'), { code: 'CHILD_STOP_TIMEOUT' }));
    }, timeoutMs);
  });
}

function requestIpcShutdown(child) {
  if (!child || !child.connected || typeof child.send !== 'function') return false;
  try {
    child.send({ type: 'traceomics:shutdown' }, () => {});
    return true;
  } catch {
    return false;
  }
}

async function stopChild(record, options = {}) {
  if (!record || !record.child || record.child.exitCode !== null || record.child.signalCode !== null) return;
  const child = record.child;
  const graceful = options.graceful === true;
  if (!graceful || !requestIpcShutdown(child)) child.kill('SIGTERM');
  try {
    await waitForExit(child, options.timeoutMs || DEFAULT_CHILD_STOP_MS);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 5000).catch(() => {});
    throw Object.assign(new Error(`${record.label} required forced termination.`), { code: 'CHILD_STOP_TIMEOUT' });
  }
}

function createDevRuntime(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const env = options.env || process.env;
  const spawnFn = options.spawn || spawn;
  const logger = options.logger || console;
  const exit = options.exit || ((code) => process.exit(code));
  const explicitExternalR = env.R_RUNTIME_MODE === 'external'
    || (env.R_BACKEND_URL && env.R_RUNTIME_MODE !== 'owned');
  const sharedToken = env.R_API_TOKEN
    || (explicitExternalR ? '' : crypto.randomBytes(32).toString('hex'));
  const plumberPort = env.PLUMBER_PORT || '8000';
  const rBaseUrl = env.R_BACKEND_URL || `http://127.0.0.1:${plumberPort}`;
  // Agent sandboxes and Expert R run in a fresh no-network container per run.
  // Setting EXPERT_R_SANDBOX_IMAGE (an image pinned by sha256) starts the
  // sandbox broker beside the stack and points the web service and worker at it.
  const sandboxImage = String(env.EXPERT_R_SANDBOX_IMAGE || '').trim();
  const sandbox = sandboxImage ? {
    image: sandboxImage,
    token: /^[0-9a-f]{64}$/.test(String(env.EXPERT_R_SANDBOX_TOKEN || '')) ? env.EXPERT_R_SANDBOX_TOKEN : crypto.randomBytes(32).toString('hex'),
    port: String(positiveInt(env.EXPERT_R_SANDBOX_PORT, 8090)),
    workRoot: env.EXPERT_R_SANDBOX_WORK_ROOT || path.join(root, '.expert-r-work'),
  } : null;
  const sandboxEnv = sandbox ? {
    APP_DEPLOYMENT_MODE: env.APP_DEPLOYMENT_MODE || 'private',
    EXPERT_R_ENABLED: 'true',
    // On one researcher's machine, project writers may use the sandbox without a
    // separate operator approval. A deployment sets its own policy.
    EXPERT_R_ACCESS_POLICY: env.EXPERT_R_ACCESS_POLICY || 'project-roles',
    EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${sandbox.port}`,
    EXPERT_R_SANDBOX_TOKEN: sandbox.token,
  } : {};
  const common = { ...env, R_API_TOKEN: sharedToken, ...sandboxEnv };
  const configuredWorkerMinFreeMemoryMb = env.JOB_WORKER_MIN_FREE_MEMORY_MB;
  const devWorkerMinFreeMemoryMb = configuredWorkerMinFreeMemoryMb === undefined
    || configuredWorkerMinFreeMemoryMb === null
    || String(configuredWorkerMinFreeMemoryMb).trim() === ''
    ? String(DEFAULT_DEV_WORKER_MIN_FREE_MEMORY_MB)
    : String(configuredWorkerMinFreeMemoryMb).trim();
  const children = new Map();
  let stopping = false;
  let stopPromise = null;

  function launch(label, script, args, childEnv, ipc = false) {
    const child = spawnFn(process.execPath, [script, ...args], {
      cwd: root,
      env: childEnv,
      stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      windowsHide: true,
    });
    const record = { label, child };
    children.set(label, record);
    child.on('error', () => { void stop(1, `${label} could not start`); });
    child.on('exit', (code, signal) => {
      if (!stopping) void stop(code === 0 && !signal ? 0 : 1, `${label} exited`);
    });
    return record;
  }

  function start() {
    if (!sharedToken) {
      throw Object.assign(new Error('R_API_TOKEN is required when using an external R runtime.'), {
        code: 'R_API_TOKEN_REQUIRED',
      });
    }
    if (sandbox) {
      launch('sandbox', path.join(root, 'backend', 'expertSandboxBroker.js'), [], {
        ...common,
        EXPERT_R_SANDBOX_IMAGE: sandbox.image,
        EXPERT_R_SANDBOX_HOST: '127.0.0.1',
        EXPERT_R_SANDBOX_PORT: sandbox.port,
        EXPERT_R_SANDBOX_WORK_ROOT: sandbox.workRoot,
      }, true);
    }
    const viteScript = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    launch('vite', viteScript, [], common, false);
    launch('web', path.join(root, 'server.js'), [], {
      ...common,
      ENABLE_JOB_WORKER: 'false',
      R_RUNTIME_MODE: explicitExternalR ? 'external' : 'owned',
      R_BACKEND_URL: explicitExternalR ? rBaseUrl : '',
    }, true);
    launch('worker', path.join(root, 'worker.js'), [], {
      ...common,
      ENABLE_JOB_WORKER: 'true',
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: rBaseUrl,
      JOB_WORKER_MIN_FREE_MEMORY_MB: devWorkerMinFreeMemoryMb,
    }, true);
    return api;
  }

  function stop(code = 0, reason = '') {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      if (reason && typeof logger.log === 'function') {
        logger.log(`[dev] ${reason}; draining the split stack.`);
      }
      let exitCode = code;
      const workerDrainMs = positiveInt(env.JOB_WORKER_DRAIN_TIMEOUT_MS, DEFAULT_WORKER_DRAIN_MS) + 10000;
      try { await stopChild(children.get('worker'), { graceful: true, timeoutMs: workerDrainMs }); }
      catch { exitCode = 1; }
      // The web process owns local R, so it must remain alive until the worker's
      // current R request has drained. Only then stop web/R and finally Vite.
      try { await stopChild(children.get('web'), { graceful: true, timeoutMs: DEFAULT_CHILD_STOP_MS }); }
      catch { exitCode = 1; }
      try { await stopChild(children.get('vite'), { graceful: false, timeoutMs: DEFAULT_CHILD_STOP_MS }); }
      catch { exitCode = 1; }
      try { await stopChild(children.get('sandbox'), { graceful: true, timeoutMs: DEFAULT_CHILD_STOP_MS }); }
      catch { exitCode = 1; }
      exit(exitCode);
      return exitCode;
    })();
    return stopPromise;
  }

  function forceStop(code = 1) {
    stopping = true;
    for (const { child } of children.values()) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
      }
    }
    exit(code);
  }

  const api = Object.freeze({ start, stop, forceStop, children });
  return api;
}

function main() {
  const runtime = createDevRuntime();
  try {
    runtime.start();
  } catch (error) {
    const code = error && error.code ? error.code : 'DEV_RUNTIME_START_FAILED';
    console.error(`[dev] refusing to start (${code}).`);
    process.exit(1);
  }
  let signalCount = 0;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      signalCount += 1;
      if (signalCount > 1) runtime.forceStop(1);
      else void runtime.stop(0, signal);
    });
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_WORKER_DRAIN_MS,
  DEFAULT_DEV_WORKER_MIN_FREE_MEMORY_MB,
  waitForExit,
  stopChild,
  createDevRuntime,
  main,
};
