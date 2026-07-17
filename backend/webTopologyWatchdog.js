'use strict';

function startTopologyLockWatchdog(options = {}) {
  const lock = options.lock;
  const onLost = typeof options.onLost === 'function' ? options.onLost : () => {};
  const intervalMs = Number.isInteger(Number(options.intervalMs)) && Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : 5000;
  const schedule = options.setInterval || setInterval;
  const cancel = options.clearInterval || clearInterval;
  const maxConsecutiveFailures = Number.isInteger(Number(options.maxConsecutiveFailures))
      && Number(options.maxConsecutiveFailures) >= 2
    ? Number(options.maxConsecutiveFailures)
    : 2;
  let stopped = false;
  let checking = false;
  let notified = false;
  let timer = null;
  let consecutiveFailures = 0;

  async function checkNow() {
    if (stopped || checking || notified) return true;
    checking = true;
    try {
      if (!lock || typeof lock.check !== 'function') throw new Error('TOPOLOGY_LOCK_MISSING');
      await lock.check();
      consecutiveFailures = 0;
      return true;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures < maxConsecutiveFailures) return false;
      if (!notified) {
        notified = true;
        stopped = true;
        if (timer) cancel(timer);
        // The caller owns sanitized logging and process shutdown. Never expose
        // a driver error or connection detail from this boundary.
        await Promise.resolve(onLost());
      }
      return false;
    } finally {
      checking = false;
    }
  }

  timer = schedule(() => { void checkNow(); }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return Object.freeze({
    checkNow,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) cancel(timer);
    },
  });
}

module.exports = { startTopologyLockWatchdog };
