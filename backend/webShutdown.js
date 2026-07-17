'use strict';

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function withTimeout(promise, timeoutMs, code) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), Math.max(1, timeoutMs));
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function closeHttpServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

function stopOwnedRProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off?.('exit', onExit);
      child.off?.('error', onError);
    };
    const onExit = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(Object.assign(new Error('R_PROCESS_STOP_FAILED'), { code: 'R_PROCESS_STOP_FAILED' })); };
    child.once('exit', onExit);
    child.once('error', onError);
    try { child.kill('SIGTERM'); } catch { onError(); }
  });
}

async function shutdownWebRuntime(options = {}) {
  const logger = options.logger || console;
  const exit = options.exit || ((code) => process.exit(code));
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 150000;
  const drainDelayMs = Number(options.drainDelayMs) >= 0 ? Number(options.drainDelayMs) : 1000;
  const deadline = Date.now() + timeoutMs;
  let exitCode = Number(options.initialExitCode) === 1 ? 1 : 0;

  options.health?.markDraining?.();
  await wait(Math.min(drainDelayMs, Math.max(0, deadline - Date.now())));

  async function runStep(step, fallbackCode) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      exitCode = 1;
      return;
    }
    try {
      await withTimeout(Promise.resolve().then(step), remaining, fallbackCode);
    } catch {
      exitCode = 1;
      if (typeof logger.error === 'function') logger.error(`[web] shutdown step failed (${fallbackCode}).`);
    }
  }

  await runStep(() => closeHttpServer(options.server), 'HTTP_DRAIN_FAILED');
  if (exitCode !== 0 && typeof options.server?.closeAllConnections === 'function') {
    try { options.server.closeAllConnections(); } catch { /* process exit is the final fence */ }
  }
  await runStep(() => stopOwnedRProcess(options.rProcess), 'R_PROCESS_STOP_FAILED');
  await runStep(() => options.topologyLock?.release?.(), 'WEB_TOPOLOGY_RELEASE_FAILED');
  await runStep(() => options.db?.close?.(), 'DATABASE_CLOSE_FAILED');

  options.health?.markStopped?.();
  exit(exitCode);
  return exitCode;
}

module.exports = {
  withTimeout,
  closeHttpServer,
  stopOwnedRProcess,
  shutdownWebRuntime,
};
