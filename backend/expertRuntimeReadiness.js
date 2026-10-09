'use strict';

const { resourcePolicy } = require('./privateKernelRuntime');

function memoryBytes(value) {
  const match = /^(\d+(?:\.\d+)?)([kmgt]?)b?$/i.exec(String(value || '').trim());
  if (!match) return null;
  const bytes = Number(match[1]) * 1024 ** (match[2] ? 'kmgt'.indexOf(match[2].toLowerCase()) + 1 : 0);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function brokerResourceLimits(env, { timeoutMs, maxConcurrent, persistentKernel }) {
  const cpu = Number(env.EXPERT_R_CPU_LIMIT || 2);
  let kernel = null;
  if (persistentKernel) {
    const policy = resourcePolicy(env);
    kernel = { ...policy.resources, executionSeconds: policy.executionSeconds,
      maxActive: policy.maxActive, maxPerOwner: policy.maxOwner };
  }
  return {
    oneShot: { memoryBytes: memoryBytes(env.EXPERT_R_MEMORY_LIMIT || '8g'),
      cpuLimit: Number.isFinite(cpu) && cpu > 0 ? cpu : null,
      timeoutSeconds: timeoutMs / 1000, maxConcurrent },
    kernel,
  };
}

// Observations are advisory. Reuse one bounded daemon check and one pair of
// storage probes; refreshing never launches a scientific process or a kernel.
function createBrokerReadinessProbe({ image, runProcess, probeStorage, workRoot, durableRoot,
  minFreeBytes, getReservations, sameFilesystem, now = Date.now, cacheMs = 5000, timeoutMs = 900 }) {
  let cached = null;
  let pending = null;
  const inFlight = new Map();
  const unknownStorage = () => ({ state: 'unknown', writable: null, freeBytes: null,
    minFreeBytes, reservedBytes: null });
  function bounded(key, operation, fallback) {
    let work = inFlight.get(key);
    if (!work) {
      work = Promise.resolve().then(operation).catch(() => fallback);
      inFlight.set(key, work);
      work.then(() => { if (inFlight.get(key) === work) inFlight.delete(key); });
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      work.then(value => { clearTimeout(timer); resolve(value); });
    });
  }
  function storageObservation(value, reservation, shared) {
    const reservedBytes = reservation <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reservation) : null;
    const observation = { ...value, minFreeBytes, reservedBytes: shared === null ? null : reservedBytes };
    if (observation.state === 'ready') {
      if (shared === null || reservedBytes === null) observation.state = 'unknown';
      else if (BigInt(observation.freeBytes) < BigInt(minFreeBytes) + reservation) observation.state = 'insufficient-resources';
    }
    return observation;
  }
  return async function inspect() {
    const age = cached ? now() - cached.at : null;
    if (cached && age >= 0 && age < cacheMs) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const checkedAt = new Date(now()).toISOString();
      const [shared, daemon, work, durable] = await Promise.all([
        bounded('topology', sameFilesystem, null),
        bounded('image', () => runProcess('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 800 })
          .then(result => /^sha256:[0-9a-f]{64}$/.test(String(result.stdout || '').trim()))
          .catch(error => error?.code === 'SANDBOX_INTERRUPTED' ? null : false), null),
        bounded('work', () => probeStorage(workRoot), unknownStorage()),
        bounded('durable', () => probeStorage(durableRoot), unknownStorage()),
      ]);
      const reservations = getReservations();
      const combined = reservations.work + reservations.durable;
      const workReservation = shared === true ? combined : reservations.work;
      const durableReservation = shared === true ? combined : reservations.durable;
      const value = { state: daemon === true ? 'ready' : daemon === false ? 'unavailable' : 'unknown', checkedAt,
        storage: { work: storageObservation(work, workReservation, shared),
          durable: storageObservation(durable, durableReservation, shared) } };
      cached = { at: now(), value };
      return value;
    })().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { brokerResourceLimits, createBrokerReadinessProbe };
