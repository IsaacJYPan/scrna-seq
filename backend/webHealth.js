'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HEALTH_PROBE_PREFIX = '.traceomics-web-health-';
const HEALTH_PROBE_CONTENT = 'traceomics-web-storage-v1\n';

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeComponentStatus(settled) {
  return settled.status === 'fulfilled' ? 'ready' : 'unavailable';
}

function probeWritableDirectory(rootValue, options = {}) {
  const io = options.fs || fs;
  const root = path.resolve(rootValue);
  const nonce = options.nonce || crypto.randomBytes(16).toString('hex');
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    throw codedError('STORAGE_PROBE_INVALID', 'Storage readiness nonce is invalid.');
  }

  let rootStat;
  try {
    rootStat = io.lstatSync(root);
  } catch {
    throw codedError('STORAGE_ROOT_UNAVAILABLE', 'Storage readiness root is unavailable.');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw codedError('STORAGE_ROOT_UNSAFE', 'Storage readiness root is unsafe.');
  }
  try {
    io.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw codedError('STORAGE_ROOT_UNAVAILABLE', 'Storage readiness root is unavailable.');
  }

  const probePath = path.join(root, `${HEALTH_PROBE_PREFIX}${nonce}`);
  try {
    io.writeFileSync(probePath, HEALTH_PROBE_CONTENT, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    const probeStat = io.lstatSync(probePath);
    if (!probeStat.isFile() || probeStat.isSymbolicLink()
        || io.readFileSync(probePath, 'utf8') !== HEALTH_PROBE_CONTENT) {
      throw codedError('STORAGE_PROBE_INVALID', 'Storage readiness probe is unsafe or invalid.');
    }
    return true;
  } finally {
    try {
      if (io.existsSync(probePath)) {
        const finalStat = io.lstatSync(probePath);
        if (finalStat.isFile() && !finalStat.isSymbolicLink()) io.unlinkSync(probePath);
      }
    } catch {
      // The readiness result still fails if the main probe operation failed.
      // Cleanup is deliberately best-effort so no internal path reaches callers.
    }
  }
}

function createWebHealthController(options = {}) {
  const db = options.db;
  const durableRoot = options.storageRoot;
  const privateRoot = options.vaultRoot;
  const probeR = typeof options.probeR === 'function' ? options.probeR : async () => true;
  const getTopologyLock = typeof options.getTopologyLock === 'function'
    ? options.getTopologyLock
    : () => options.topologyLock || null;
  const probeDirectory = options.probeWritableDirectory || probeWritableDirectory;
  const state = { live: true, draining: false };
  const readinessCacheMs = Number.isInteger(Number(options.readinessCacheMs))
      && Number(options.readinessCacheMs) >= 100
    ? Math.min(Number(options.readinessCacheMs), 5000)
    : 1000;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let readinessInFlight = null;
  let cachedReadiness = null;
  let cachedAt = 0;

  function markDraining() {
    state.draining = true;
    cachedReadiness = null;
  }

  function markStopped() {
    state.draining = true;
    state.live = false;
  }

  function liveness() {
    return {
      httpStatus: state.live ? 200 : 503,
      body: { status: state.live ? 'live' : 'stopping', role: 'web' },
    };
  }

  async function computeReadiness() {
    if (state.draining || !state.live) {
      return {
        httpStatus: 503,
        body: {
          status: 'not_ready',
          role: 'web',
          components: {
            database: 'unavailable',
            durableStorage: 'unavailable',
            privateStorage: 'unavailable',
            topology: 'unavailable',
            rCompute: 'unavailable',
          },
        },
      };
    }

    const mandatory = await Promise.allSettled([
      Promise.resolve().then(() => db.checkHealth({ timeoutMs: 1000 })),
      Promise.resolve().then(() => probeDirectory(durableRoot)),
      Promise.resolve().then(() => probeDirectory(privateRoot)),
      Promise.resolve().then(() => {
        const topologyLock = getTopologyLock();
        if (!topologyLock || typeof topologyLock.isHeld !== 'function' || !topologyLock.isHeld()) {
          throw codedError('WEB_TOPOLOGY_LOCK_UNAVAILABLE', 'The web topology lock is unavailable.');
        }
        return true;
      }),
    ]);
    const rResult = await Promise.resolve().then(() => probeR()).then(
      () => 'ready',
      () => 'unavailable'
    );
    const components = {
      database: safeComponentStatus(mandatory[0]),
      durableStorage: safeComponentStatus(mandatory[1]),
      privateStorage: safeComponentStatus(mandatory[2]),
      topology: safeComponentStatus(mandatory[3]),
      rCompute: rResult,
    };
    const ready = mandatory.every((result) => result.status === 'fulfilled');
    return {
      httpStatus: ready ? 200 : 503,
      body: {
        status: ready ? 'ready' : 'not_ready',
        role: 'web',
        components,
        computeDegraded: ready && rResult !== 'ready',
      },
    };
  }

  async function readiness() {
    if (state.draining || !state.live) return computeReadiness();
    const current = now();
    if (cachedReadiness && current - cachedAt < readinessCacheMs) return cachedReadiness;
    if (readinessInFlight) return readinessInFlight;
    readinessInFlight = computeReadiness()
      .then((result) => {
        cachedReadiness = result;
        cachedAt = now();
        return result;
      })
      .finally(() => { readinessInFlight = null; });
    return readinessInFlight;
  }

  function snapshot() {
    return Object.freeze({ live: state.live, draining: state.draining });
  }

  return Object.freeze({ liveness, readiness, markDraining, markStopped, snapshot });
}

module.exports = {
  HEALTH_PROBE_PREFIX,
  HEALTH_PROBE_CONTENT,
  probeWritableDirectory,
  createWebHealthController,
};
