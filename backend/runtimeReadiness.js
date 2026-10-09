'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { requestRJson } = require('./rRuntime');
const { validateEnvironmentReference } = require('./rEnvironment');

const SCHEMA = 'traceomics.runtime-readiness.v1';
const SERVICE_COMPATIBILITY = Object.freeze({ product: 'TraceOmics', serviceApiVersion: 1, minimumClientApiVersion: 1 });
const PACKAGE_KEYS = Object.freeze({ Seurat: 'Seurat', dplyr: 'dplyr', harmony: 'harmony', CellChat: 'CellChat', clusterProfiler: 'clusterProfiler', fgsea: 'fgsea', AnnotationDbi: 'AnnotationDbi', 'org.Hs.eg.db': 'org_Hs_eg_db', 'org.Mm.eg.db': 'org_Mm_eg_db', 'GO.db': 'GO_db', plumber: 'plumber', jsonlite: 'jsonlite', ggplot2: 'ggplot2' });
const CORE_PACKAGES = new Set(['Seurat', 'dplyr', 'plumber', 'jsonlite', 'ggplot2']);
const PRIVATE_STATES = new Set(['ready', 'unknown', 'unreachable', 'authentication-failed', 'incompatible', 'not-configured', 'unavailable', 'insufficient-resources']);
const STORAGE_STATES = new Set(['ready', 'unknown', 'missing', 'not-writable', 'insufficient-resources']);
const STORAGE_CONTENT = Buffer.from('traceomics-storage-readiness-v1\n');
const WORKER_MAX_AGE_MS = 15000;

function finiteBytes(value) {
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function unknownStorage() { return { state: 'unknown', writable: null, freeBytes: null, minFreeBytes: null, reservedBytes: null }; }
function storageState(raw) {
  if (!raw || typeof raw !== 'object') return unknownStorage();
  const writable = typeof raw.writable === 'boolean' ? raw.writable : null;
  const freeBytes = finiteBytes(raw.freeBytes);
  const minFreeBytes = finiteBytes(raw.minFreeBytes);
  const reservedBytes = finiteBytes(raw.reservedBytes);
  let state = STORAGE_STATES.has(raw.state) ? raw.state : 'unknown';
  if (state === 'ready' && (raw.minFreeBytes != null && minFreeBytes === null || raw.reservedBytes != null && reservedBytes === null)) state = 'unknown';
  if (state === 'ready' && (writable !== true || freeBytes === null)) state = 'unknown';
  if (state === 'ready' && freeBytes < (minFreeBytes || 0) + (reservedBytes || 0)) state = 'insufficient-resources';
  if (state === 'ready' && freeBytes === 0) state = 'insufficient-resources';
  return { state, writable, freeBytes, minFreeBytes, reservedBytes };
}

// A tiny owned write/read/remove and statfs observation. No recursive scans,
// directory creation, scientific execution, paths, or OS errors reach callers.
async function probeStorageReadiness(directory, { minFreeBytes = null, reservedBytes = null, io = fs, nonce } = {}) {
  const result = { ...unknownStorage(), minFreeBytes: finiteBytes(minFreeBytes), reservedBytes: finiteBytes(reservedBytes) };
  if (typeof directory !== 'string' || !directory) return result;
  let rootStat;
  try { rootStat = await io.lstat(directory); }
  catch (error) { return { ...result, state: error?.code === 'ENOENT' ? 'missing' : 'unknown', writable: error?.code === 'ENOENT' ? false : null }; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ...result, state: 'not-writable', writable: false };

  const suffix = nonce || crypto.randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(suffix)) return result;
  const probePath = path.join(directory, '.traceomics-readiness-' + suffix);
  let handle = null;
  let ownedStat = null;
  let writeError = null;
  try {
    handle = await io.open(probePath, 'wx+', 0o600);
    ownedStat = await handle.stat({ bigint: true });
    await handle.writeFile(STORAGE_CONTENT);
    const bytes = Buffer.alloc(STORAGE_CONTENT.length + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== STORAGE_CONTENT.length || !bytes.subarray(0, read.bytesRead).equals(STORAGE_CONTENT)) throw new Error('Storage check failed.');
    result.writable = true;
  } catch (error) { writeError = error; }
  finally {
    if (handle) {
      try { await handle.close(); } catch (error) { writeError ||= error; }
      try {
        const entry = await io.lstat(probePath, { bigint: true });
        if (!ownedStat || !entry.isFile() || entry.isSymbolicLink() || entry.ino !== ownedStat.ino || entry.dev !== ownedStat.dev) writeError ||= new Error('Storage cleanup could not be verified.');
        else await io.unlink(probePath);
      } catch (error) { writeError ||= error; }
    }
  }
  try {
    const stat = await io.statfs(directory, { bigint: true });
    if (typeof stat.bavail === 'bigint' && typeof stat.bsize === 'bigint') result.freeBytes = finiteBytes(stat.bavail * stat.bsize);
  } catch { /* A platform without a space observation remains unknown. */ }
  if (writeError) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(writeError.code)) return { ...result, state: 'not-writable', writable: false };
    if (writeError.code === 'ENOSPC') return { ...result, state: 'insufficient-resources', writable: false };
    return { ...result, state: 'unknown' };
  }
  result.state = result.freeBytes === null ? 'unknown' : 'ready';
  return storageState(result);
}

function version(value) { return typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value : null; }
function timestamp(value) {
  if (value instanceof Date) { if (!Number.isFinite(value.getTime())) return null; value = value.toISOString(); }
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  const normalized = new Date(value).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}
function workerTimestamp(value) {
  // The database's established wire format is UTC with a space separator.
  // Normalize only that known format; Date.parse must not guess local time.
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) value = value.replace(' ', 'T') + 'Z';
  return timestamp(value);
}
function boolean(value) { return typeof value === 'boolean' ? value : null; }
function numberIn(value, minimum, maximum, integer = true) { return typeof value === 'number' && Number.isFinite(value) && (!integer || Number.isSafeInteger(value)) && value >= minimum && value <= maximum; }
function resources(raw) {
  const oneShot = raw?.oneShot;
  const kernel = raw?.kernel;
  return {
    oneShot: oneShot && numberIn(oneShot.memoryBytes, 512 * 1024 ** 2, 64 * 1024 ** 3) && numberIn(oneShot.cpuLimit, 0.25, 64, false) && numberIn(oneShot.timeoutSeconds, Number.MIN_VALUE, 86400, false) && numberIn(oneShot.maxConcurrent, 1, 32)
      ? { memoryBytes: oneShot.memoryBytes, cpuLimit: oneShot.cpuLimit, timeoutSeconds: oneShot.timeoutSeconds, maxConcurrent: oneShot.maxConcurrent } : null,
    kernel: kernel && numberIn(kernel.memoryBytes, 512 * 1024 ** 2, 8 * 1024 ** 3) && numberIn(kernel.cpuLimit, 0.25, 8, false) && numberIn(kernel.pidsLimit, 64, 1024) && numberIn(kernel.idleTimeoutSeconds, 1, 3600) && numberIn(kernel.maxLifetimeSeconds, 1, 14400) && numberIn(kernel.executionSeconds, 1, 600) && numberIn(kernel.maxActive, 1, 32) && numberIn(kernel.maxPerOwner, 1, 4)
      ? { memoryBytes: kernel.memoryBytes, cpuLimit: kernel.cpuLimit, pidsLimit: kernel.pidsLimit, idleTimeoutSeconds: kernel.idleTimeoutSeconds, maxLifetimeSeconds: kernel.maxLifetimeSeconds, executionSeconds: kernel.executionSeconds, maxActive: kernel.maxActive, maxPerOwner: kernel.maxPerOwner } : null,
  };
}
function rejectedState(error) {
  if ([401, 403].includes(error?.httpStatus)) return 'authentication-failed';
  if (['R_UNREACHABLE', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(error?.code)) return 'unreachable';
  if (['R_INVALID_RESPONSE', 'R_RESPONSE_TOO_LARGE'].includes(error?.code)) return 'incompatible';
  if (error?.code === 'R_NOT_READY') return 'unavailable';
  return 'unknown';
}
function projectGuided(settled) {
  const raw = settled.status === 'fulfilled' ? settled.value : null;
  const packages = Object.entries(PACKAGE_KEYS).map(([name, key]) => ({ name, state: raw?.packages?.[key] === true ? 'available' : raw?.packages?.[key] === false ? 'missing' : 'unknown' }));
  const rVersion = version(raw?.r_version || raw?.rVersion);
  let state = settled.status === 'rejected' ? rejectedState(settled.reason) : raw?.status === 'ok' ? 'ready' : 'incompatible';
  if (state === 'ready') {
    if (!rVersion || !/^4\.5\.\d+$/.test(rVersion)) state = 'incompatible';
    else if (packages.some(pkg => CORE_PACKAGES.has(pkg.name) && pkg.state === 'missing')) state = 'missing-packages';
    else if (packages.some(pkg => CORE_PACKAGES.has(pkg.name) && pkg.state === 'unknown')) state = 'unknown';
  }
  return { state, rVersion, packages };
}
function projectWorkers(settled, mode, observedAt) {
  const raw = settled.status === 'fulfilled' ? settled.value : null;
  const updatedAt = workerTimestamp(raw?.updatedAt);
  const age = updatedAt ? observedAt - Date.parse(updatedAt) : null;
  const observed = age !== null && age >= -1000 && age <= WORKER_MAX_AGE_MS;
  const state = ['ready', 'unavailable', 'unknown'].includes(raw?.status) && observed ? raw.status : 'unknown';
  return { state, mode: ['standalone', 'embedded'].includes(mode) ? mode : 'unknown', updatedAt, capabilities: { pathwayEnrichment: state === 'ready' ? boolean(raw?.capabilities?.pathwayEnrichment) : null, cellChat: state === 'ready' ? boolean(raw?.capabilities?.cellChat) : null } };
}
function projectPrivateR(settled) {
  const raw = settled.status === 'fulfilled' ? settled.value : { state: rejectedState(settled.reason) };
  let state = PRIVATE_STATES.has(raw?.state) ? raw.state : 'unknown';
  let environment = null;
  try {
    if (raw?.environment) {
      if (Buffer.byteLength(JSON.stringify(raw.environment)) > 2048) throw new Error('Environment reference exceeds its bound.');
      environment = validateEnvironmentReference(raw.environment);
    }
  } catch { state = 'incompatible'; }
  if (state === 'ready' && !environment) state = 'incompatible';
  const capabilities = { persistentKernel: boolean(raw?.persistentKernel), persistentKernelInterrupt: boolean(raw?.persistentKernelInterrupt), persistentKernelPublications: boolean(raw?.persistentKernelPublications) };
  if (capabilities.persistentKernel !== true) {
    if (capabilities.persistentKernelInterrupt === true) capabilities.persistentKernelInterrupt = null;
    if (capabilities.persistentKernelPublications === true) capabilities.persistentKernelPublications = null;
  }
  return { state, environment, capabilities, resources: resources(raw?.readiness?.resources), storage: { work: storageState(raw?.readiness?.storage?.work), durable: storageState(raw?.readiness?.storage?.durable) } };
}
function applyAccess(runtime, access) {
  const accessState = access.demoMode === true ? 'demo-disabled' : access.revoked === true ? 'access-revoked' : access.canExecuteExpertR === true ? 'allowed' : access.canExecuteExpertR === false ? 'access-required' : 'unknown';
  const allowed = accessState === 'allowed';
  return { ...runtime, accessState, environment: allowed ? runtime.environment : null, resources: allowed ? runtime.resources : { oneShot: null, kernel: null }, storage: allowed ? runtime.storage : { work: unknownStorage(), durable: unknownStorage() } };
}
function issuesFor(snapshot) {
  const issues = [];
  const add = (code, scope, state, extra = {}) => issues.push({ code, scope, state, ...extra });
  if (snapshot.guided.state !== 'ready' && snapshot.guided.state !== 'missing-packages') add('GUIDED_R_' + snapshot.guided.state.toUpperCase().replaceAll('-', '_'), 'guided', snapshot.guided.state);
  for (const pkg of snapshot.guided.packages) if (pkg.state === 'missing') add('MISSING_PACKAGE', 'guided', 'missing-packages', { package: pkg.name });
  if (snapshot.workers.state !== 'ready') add(snapshot.workers.state === 'unavailable' ? 'WORKER_UNAVAILABLE' : 'WORKER_UNKNOWN', 'workers', snapshot.workers.state);
  if (snapshot.privateR.state !== 'ready') add('PRIVATE_R_' + snapshot.privateR.state.toUpperCase().replaceAll('-', '_'), 'private-r', snapshot.privateR.state);
  if (snapshot.privateR.accessState !== 'allowed' && snapshot.privateR.accessState !== 'unknown') add('PRIVATE_R_' + snapshot.privateR.accessState.toUpperCase().replaceAll('-', '_'), 'private-r', snapshot.privateR.accessState);
  if (snapshot.privateR.state === 'ready' && snapshot.privateR.accessState === 'allowed' && (!snapshot.privateR.resources.oneShot || snapshot.privateR.capabilities.persistentKernel === true && !snapshot.privateR.resources.kernel)) add('RESOURCE_POLICY_UNKNOWN', 'private-r', 'unknown');
  for (const [scope, value] of [['durable-storage', snapshot.storage.durable], ['private-storage', snapshot.storage.private], ...(snapshot.privateR.accessState === 'allowed' ? [['private-r-work', snapshot.privateR.storage.work], ['private-r-storage', snapshot.privateR.storage.durable]] : [])]) {
    if (value.state !== 'ready') add(value.state === 'missing' ? 'STORAGE_MISSING' : value.state === 'not-writable' ? 'STORAGE_NOT_WRITABLE' : value.state === 'insufficient-resources' ? 'STORAGE_PRESSURE' : 'STORAGE_UNKNOWN', scope, value.state);
  }
  return issues.slice(0, 32);
}

function createRuntimeReadinessController(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const cacheMs = numberIn(options.cacheMs, 100, 10000) ? options.cacheMs : 5000;
  const timeoutMs = numberIn(options.timeoutMs, 10, 5000) ? options.timeoutMs : 1500;
  const probes = {
    guided: options.probeGuided || (() => requestRJson(options.rRuntime, '/health', { timeoutMs, maxResponseBytes: 16384 })),
    workers: options.probeWorkers || (() => options.db.getStandaloneWorkerRuntimeStatus()),
    privateR: options.probePrivateR || (() => ({ state: 'not-configured' })),
    durable: () => (options.probeStorage || probeStorageReadiness)(options.storageRoot),
    private: () => (options.probeStorage || probeStorageReadiness)(options.vaultRoot),
  };
  const inFlight = new Map();
  let snapshotInFlight = null;
  let cached = null;
  let cachedAt = 0;

  function boundedProbe(key) {
    let operation = inFlight.get(key);
    if (!operation) {
      operation = Promise.resolve().then(probes[key]).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
      inFlight.set(key, operation);
      operation.then(() => { if (inFlight.get(key) === operation) inFlight.delete(key); });
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ status: 'rejected', reason: { code: 'READINESS_TIMEOUT' } }), timeoutMs);
      timer.unref?.();
      operation.then(result => { clearTimeout(timer); resolve(result); });
    });
  }
  async function sharedSnapshot() {
    const current = now();
    if (cached && current - cachedAt >= 0 && current - cachedAt < cacheMs) return cached;
    if (snapshotInFlight) return snapshotInFlight;
    snapshotInFlight = Promise.all(Object.keys(probes).map(boundedProbe)).then(([guided, workers, privateR, durable, privateStorage]) => {
      const privateCheckedAt = privateR.status === 'fulfilled' ? timestamp(privateR.value?.readiness?.checkedAt) : null;
      const observedAt = privateCheckedAt ? Math.min(current, Date.parse(privateCheckedAt)) : current;
      cached = { checkedAt: new Date(observedAt).toISOString(), guided: projectGuided(guided), workers: projectWorkers(workers, typeof options.workerMode === 'function' ? options.workerMode() : options.workerMode, now()), privateR: projectPrivateR(privateR), storage: { durable: durable.status === 'fulfilled' ? storageState(durable.value) : unknownStorage(), private: privateStorage.status === 'fulfilled' ? storageState(privateStorage.value) : unknownStorage() } };
      cachedAt = now();
      return cached;
    }).finally(() => { snapshotInFlight = null; });
    return snapshotInFlight;
  }
  async function inspect(access = {}) {
    const shared = await sharedSnapshot();
    const currentAccess = typeof access.resolveAccess === 'function' ? await access.resolveAccess() : access;
    const snapshot = { schema: SCHEMA, checkedAt: shared.checkedAt, staleAfterMs: cacheMs, service: { ...SERVICE_COMPATIBILITY, state: 'ready', supportedTarget: 'R 4.5.x' }, guided: shared.guided, workers: shared.workers, privateR: applyAccess(shared.privateR, currentAccess), storage: shared.storage, scheduler: { state: 'unsupported', kind: null } };
    snapshot.issues = issuesFor(snapshot);
    // Each caller receives its own projection; mutation cannot poison a cache or
    // allow one user's private environment to reach a later access-denied view.
    return JSON.parse(JSON.stringify(snapshot));
  }
  return Object.freeze({ inspect });
}

module.exports = { SCHEMA, SERVICE_COMPATIBILITY, PACKAGE_KEYS, probeStorageReadiness, createRuntimeReadinessController };
