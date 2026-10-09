import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createRuntimeReadinessController, probeStorageReadiness, SERVICE_COMPATIBILITY, PACKAGE_KEYS } = require('./runtimeReadiness');
const { environmentFixture } = require('./_r-environment-test-utils');
const roots = [];
const checkedAt = '2026-10-08T20:00:00.000Z';
const observation = { state: 'ready', writable: true, freeBytes: 4 * 1024 ** 3, minFreeBytes: null, reservedBytes: null };

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-readiness-'));
  roots.push(root);
  return root;
}
function guidedHealth(overrides = {}) { return { status: 'ok', r_version: '4.5.2', packages: Object.fromEntries(Object.values(PACKAGE_KEYS).map(key => [key, true])), ...overrides }; }
function privateRuntime(overrides = {}) {
  return { state: 'ready', environment: environmentFixture().reference, persistentKernel: true, persistentKernelInterrupt: true, persistentKernelPublications: true, readiness: { resources: { oneShot: { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2, timeoutSeconds: 600, maxConcurrent: 2 }, kernel: { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2, pidsLimit: 256, idleTimeoutSeconds: 900, maxLifetimeSeconds: 14400, executionSeconds: 300, maxActive: 2, maxPerOwner: 1 } }, storage: { work: observation, durable: observation } }, ...overrides };
}
function dependencies(overrides = {}) {
  return { now: () => Date.parse(checkedAt), storageRoot: '/private/durable', vaultRoot: '/private/vault', probeGuided: vi.fn().mockResolvedValue(guidedHealth()), probeWorkers: vi.fn().mockResolvedValue({ status: 'ready', updatedAt: checkedAt, capabilities: { pathwayEnrichment: true, cellChat: false } }), probePrivateR: vi.fn().mockResolvedValue(privateRuntime()), probeStorage: vi.fn().mockResolvedValue(observation), workerMode: 'standalone', ...overrides };
}

afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('authenticated runtime readiness projection', () => {
  it('reports actual bounded evidence without private paths, credentials, worker identity or arbitrary probe fields', async () => {
    const deps = dependencies({ probeGuided: vi.fn().mockResolvedValue({ ...guidedHealth(), r_home: '/secret/R', token: 'hidden-token', packages: { ...guidedHealth().packages, '/untrusted': true } }), probeWorkers: vi.fn().mockResolvedValue({ status: 'ready', updatedAt: checkedAt, workerId: 'private-worker', capabilities: { pathwayEnrichment: true, cellChat: false, command: 'secret-source' } }), probePrivateR: vi.fn().mockResolvedValue({ ...privateRuntime(), token: 'hidden-token', host: 'private-host', source: 'secret-source' }) });
    const result = await createRuntimeReadinessController(deps).inspect({ canExecuteExpertR: true });
    expect(result).toMatchObject({ schema: 'traceomics.runtime-readiness.v1', checkedAt, staleAfterMs: 5000, service: { ...SERVICE_COMPATIBILITY, state: 'ready', supportedTarget: 'R 4.5.x' }, guided: { state: 'ready', rVersion: '4.5.2' }, workers: { state: 'ready', mode: 'standalone', updatedAt: checkedAt, capabilities: { pathwayEnrichment: true, cellChat: false } }, privateR: { state: 'ready', accessState: 'allowed', environment: environmentFixture().reference }, scheduler: { state: 'unsupported', kind: null }, issues: [] });
    expect(result.guided.packages.map(item => item.name)).toEqual(Object.keys(PACKAGE_KEYS));
    const encoded = JSON.stringify(result);
    expect(Buffer.byteLength(encoded)).toBeLessThan(16384);
    expect(encoded).not.toMatch(/hidden-token|private-worker|private-host|secret-source|\/secret\/R|\/private\/|\/untrusted/);
  });

  it('keeps core analysis ready when an optional method package is missing and names that method dependency', async () => {
    const health = guidedHealth(); health.packages.CellChat = false; health.packages.harmony = false;
    const result = await createRuntimeReadinessController(dependencies({ probeGuided: () => health })).inspect({ canExecuteExpertR: true });
    expect(result.guided.state).toBe('ready');
    expect(result.issues).toContainEqual({ code: 'MISSING_PACKAGE', scope: 'guided', state: 'missing-packages', package: 'CellChat' });
    expect(result.guided.packages.find(pkg => pkg.name === 'harmony').state).toBe('missing');
  });

  it.each([[false, 'missing-packages'], ['true', 'unknown'], [undefined, 'unknown']])('does not infer a required package from %s', async (value, state) => {
    const health = guidedHealth(); health.packages.Seurat = value;
    const result = await createRuntimeReadinessController(dependencies({ probeGuided: () => health })).inspect();
    expect(result.guided.state).toBe(state);
  });

  it.each(['4.4.3', 'R version 4.5.2 /secret/R', '5.0.0', null])('marks incompatible or malformed guided R version %s without leaking source text', async rVersion => {
    const result = await createRuntimeReadinessController(dependencies({ probeGuided: () => guidedHealth({ r_version: rVersion }) })).inspect();
    expect(result.guided.state).toBe('incompatible');
    expect(JSON.stringify(result)).not.toContain('/secret/R');
  });

  it.each([
    [{ code: 'R_NOT_READY', httpStatus: 401 }, 'authentication-failed'],
    [{ code: 'R_NOT_READY', httpStatus: 403 }, 'authentication-failed'],
    [{ code: 'R_NOT_READY', httpStatus: 503 }, 'unavailable'],
    [{ code: 'R_UNREACHABLE' }, 'unreachable'],
    [{ code: 'R_TIMEOUT' }, 'unknown'],
    [{ code: 'R_INVALID_RESPONSE' }, 'incompatible'],
    [{ code: 'R_RESPONSE_TOO_LARGE' }, 'incompatible'],
  ])('classifies bounded guided probe failure %j safely', async (error, state) => {
    const result = await createRuntimeReadinessController(dependencies({ probeGuided: vi.fn().mockRejectedValue({ ...error, message: '/secret/token' }) })).inspect();
    expect(result.guided.state).toBe(state);
    expect(JSON.stringify(result)).not.toContain('/secret/token');
    expect(result.workers.state).toBe('ready');
  });

  it('keeps configured workers unknown until a valid current heartbeat is observed', async () => {
    for (const worker of [{ status: 'unknown', updatedAt: null }, { status: 'ready', updatedAt: 'malformed', capabilities: { pathwayEnrichment: true } }]) {
      const result = await createRuntimeReadinessController(dependencies({ probeWorkers: () => worker, workerMode: () => 'standalone' })).inspect();
      expect(result.workers).toMatchObject({ state: 'unknown', updatedAt: null, capabilities: { pathwayEnrichment: null, cellChat: null } });
    }
    const result = await createRuntimeReadinessController(dependencies({ probeWorkers: () => ({ status: 'unavailable', updatedAt: checkedAt, capabilities: { cellChat: true } }) })).inspect();
    expect(result.workers).toMatchObject({ state: 'unavailable', capabilities: { pathwayEnrichment: null, cellChat: null } });
  });

  it('normalizes the real database UTC wire format and keeps stale observations distinct from fresh unavailability', async () => {
    const canonical = checkedAt.slice(0, 19).replace('T', ' ');
    const observed = await createRuntimeReadinessController(dependencies({ probeWorkers: () => ({ status: 'ready', updatedAt: canonical, capabilities: { cellChat: true } }) })).inspect();
    expect(observed.workers).toMatchObject({ state: 'ready', updatedAt: checkedAt, capabilities: { cellChat: true } });
    for (const status of ['ready', 'unavailable']) {
      const old = new Date(Date.parse(checkedAt) - 16000).toISOString().slice(0, 19).replace('T', ' ');
      const stale = await createRuntimeReadinessController(dependencies({ probeWorkers: () => ({ status, updatedAt: old }) })).inspect();
      expect(stale.workers).toMatchObject({ state: 'unknown', updatedAt: new Date(Date.parse(checkedAt) - 16000).toISOString() });
      expect(stale.issues).toContainEqual({ code: 'WORKER_UNKNOWN', scope: 'workers', state: 'unknown' });
    }
    const unavailable = await createRuntimeReadinessController(dependencies({ probeWorkers: () => ({ status: 'unavailable', updatedAt: canonical }) })).inspect();
    expect(unavailable.workers.state).toBe('unavailable');
  });

  it('does not treat invalid calendar dates or future worker clocks as current observations', async () => {
    for (const value of ['2026-02-30 20:00:00', '2026-10-08 20:00:03']) {
      const result = await createRuntimeReadinessController(dependencies({ probeWorkers: () => ({ status: 'ready', updatedAt: value }) })).inspect();
      expect(result.workers.state).toBe('unknown');
    }
  });

  it('retains the exact fractional one-shot timeout from a valid millisecond policy', async () => {
    const raw = privateRuntime(); raw.readiness.resources.oneShot.timeoutSeconds = 123.456;
    const result = await createRuntimeReadinessController(dependencies({ probePrivateR: () => raw })).inspect({ canExecuteExpertR: true });
    expect(result.privateR.resources.oneShot.timeoutSeconds).toBe(123.456);
    expect(result.issues).not.toContainEqual({ code: 'RESOURCE_POLICY_UNKNOWN', scope: 'private-r', state: 'unknown' });
  });

  it('distinguishes an older available private runtime from unobserved limits and support flags', async () => {
    const result = await createRuntimeReadinessController(dependencies({ probePrivateR: () => ({ state: 'ready', environment: environmentFixture().reference, persistentKernel: true, persistentKernelInterrupt: 'true' }) })).inspect({ canExecuteExpertR: true });
    expect(result.privateR).toMatchObject({ state: 'ready', capabilities: { persistentKernel: true, persistentKernelInterrupt: null, persistentKernelPublications: null }, resources: { oneShot: null, kernel: null }, storage: { work: { state: 'unknown' } } });
    expect(result.issues).toContainEqual({ code: 'RESOURCE_POLICY_UNKNOWN', scope: 'private-r', state: 'unknown' });
  });

  it('rejects inconsistent exact environment identity and malformed resource numbers', async () => {
    const raw = privateRuntime(); raw.environment = { ...raw.environment, id: 'renv_' + 'a'.repeat(64), host: '/secret/host' }; raw.readiness.resources.kernel.cpuLimit = Infinity;
    const result = await createRuntimeReadinessController(dependencies({ probePrivateR: () => raw })).inspect({ canExecuteExpertR: true });
    expect(result.privateR).toMatchObject({ state: 'incompatible', environment: null, resources: { kernel: null } });
    expect(JSON.stringify(result)).not.toContain('/secret/host');
  });

  it('rechecks access for each caller and cannot cache another user\'s permission or mutated result', async () => {
    const deps = dependencies(); const controller = createRuntimeReadinessController(deps);
    const allowed = await controller.inspect({ canExecuteExpertR: true });
    allowed.privateR.environment.id = 'mutated'; allowed.guided.packages[0].state = 'missing'; allowed.storage.durable.freeBytes = 0;
    for (const [access, state] of [[{ canExecuteExpertR: false }, 'access-required'], [{ canExecuteExpertR: true, revoked: true }, 'access-revoked'], [{ canExecuteExpertR: true, demoMode: true }, 'demo-disabled'], [{}, 'unknown']]) {
      const denied = await controller.inspect(access);
      expect(denied.privateR).toMatchObject({ state: 'ready', accessState: state, environment: null, resources: { oneShot: null, kernel: null }, storage: { work: { state: 'unknown' } } });
      expect(denied.guided.packages[0].state).toBe('available');
      expect(denied.storage.durable.freeBytes).toBe(observation.freeBytes);
    }
    expect((await controller.inspect({ canExecuteExpertR: true })).privateR.environment.id).toBe(environmentFixture().reference.id);
    expect(deps.probePrivateR).toHaveBeenCalledOnce();
  });

  it('evaluates fresh access only after slow shared probes complete and for every cached view', async () => {
    let complete;
    const pending = new Promise(resolve => { complete = resolve; });
    const deps = dependencies({ probePrivateR: () => pending }); const controller = createRuntimeReadinessController(deps);
    const resolveAccess = vi.fn().mockResolvedValue({ canExecuteExpertR: true, revoked: true });
    const check = controller.inspect({ canExecuteExpertR: true, resolveAccess });
    await Promise.resolve(); expect(resolveAccess).not.toHaveBeenCalled();
    complete(privateRuntime());
    const revoked = await check;
    expect(revoked.privateR).toMatchObject({ accessState: 'access-revoked', environment: null });
    resolveAccess.mockResolvedValue({ canExecuteExpertR: false });
    expect((await controller.inspect({ resolveAccess })).privateR.accessState).toBe('access-required');
    expect(resolveAccess).toHaveBeenCalledTimes(2);
    await expect(controller.inspect({ resolveAccess: () => Promise.reject(Object.assign(new Error('Project not found.'), { status: 404 })) })).rejects.toMatchObject({ status: 404 });
  });

  it('single-flights concurrent views and caches only a short observation', async () => {
    let now = Date.parse(checkedAt); const deps = dependencies({ now: () => now }); const controller = createRuntimeReadinessController(deps);
    await Promise.all(Array.from({ length: 30 }, () => controller.inspect({ canExecuteExpertR: true })));
    expect(deps.probeGuided).toHaveBeenCalledOnce(); expect(deps.probeWorkers).toHaveBeenCalledOnce(); expect(deps.probeStorage).toHaveBeenCalledTimes(2);
    now += 5001;
    const refreshed = await controller.inspect({ canExecuteExpertR: true });
    expect(refreshed.checkedAt).toBe(new Date(now).toISOString());
    expect(deps.probeGuided).toHaveBeenCalledTimes(2); expect(deps.probeStorage).toHaveBeenCalledTimes(4);
  });

  it('preserves the older broker observation time instead of refreshing its apparent age', async () => {
    const old = new Date(Date.parse(checkedAt) - 6000).toISOString();
    const raw = privateRuntime(); raw.readiness.checkedAt = old;
    const result = await createRuntimeReadinessController(dependencies({ probePrivateR: () => raw })).inspect({ canExecuteExpertR: true });
    expect(result.checkedAt).toBe(old);
    raw.readiness.checkedAt = new Date(Date.parse(checkedAt) + 6000).toISOString();
    const future = await createRuntimeReadinessController(dependencies({ probePrivateR: () => raw })).inspect({ canExecuteExpertR: true });
    expect(future.checkedAt).toBe(checkedAt);
  });

  it('bounds a stalled dependency while retaining its single flight across repeated refreshes', async () => {
    let now = Date.parse(checkedAt); let finish; const pending = new Promise(resolve => { finish = resolve; });
    const deps = dependencies({ now: () => now, timeoutMs: 15, probeGuided: vi.fn().mockReturnValue(pending) });
    const controller = createRuntimeReadinessController(deps);
    for (let index = 0; index < 3; index++) {
      const result = await controller.inspect(); expect(result.guided.state).toBe('unknown'); expect(result.workers.state).toBe('ready'); now += 5001;
    }
    expect(deps.probeGuided).toHaveBeenCalledOnce();
    finish(guidedHealth()); await pending; await Promise.resolve(); await Promise.resolve();
    deps.probeGuided.mockResolvedValue(guidedHealth());
    const recovered = await controller.inspect();
    expect(recovered.guided.state).toBe('ready'); expect(deps.probeGuided).toHaveBeenCalledTimes(2);
  });

  it('never relabels zero, read-only, missing, or unmeasured storage as ready', async () => {
    for (const [raw, state] of [[{ ...observation, freeBytes: 0 }, 'insufficient-resources'], [{ ...observation, writable: false }, 'unknown'], [{ ...observation, freeBytes: undefined }, 'unknown'], [{ ...observation, state: 'missing', writable: false }, 'missing'], [{ ...observation, state: 'not-writable', writable: false }, 'not-writable']]) {
      const result = await createRuntimeReadinessController(dependencies({ probeStorage: () => raw })).inspect();
      expect(result.storage.durable.state).toBe(state);
    }
  });
});

describe('bounded asynchronous storage observation', () => {
  it('writes, reads and removes its exact owned probe and measures available filesystem bytes', async () => {
    const root = directory(); const result = await probeStorageReadiness(root);
    expect(result).toMatchObject({ state: 'ready', writable: true, minFreeBytes: null, reservedBytes: null });
    expect(result.freeBytes).toBeGreaterThan(0); expect(fs.readdirSync(root)).toEqual([]);
  });
  it('distinguishes a missing root from an unsafe non-directory without creating either', async () => {
    const root = directory(); const missing = path.join(root, 'missing');
    expect(await probeStorageReadiness(missing)).toMatchObject({ state: 'missing', writable: false, freeBytes: null }); expect(fs.existsSync(missing)).toBe(false);
    const file = path.join(root, 'file'); fs.writeFileSync(file, 'x');
    expect(await probeStorageReadiness(file)).toMatchObject({ state: 'not-writable', writable: false });
  });
  it('reports writable storage with unknown free space when statfs is unsupported', async () => {
    const root = directory(); const io = { ...fs.promises, statfs: async () => { throw Object.assign(new Error('/secret/space'), { code: 'ENOSYS' }); } };
    expect(await probeStorageReadiness(root, { io })).toEqual({ state: 'unknown', writable: true, freeBytes: null, minFreeBytes: null, reservedBytes: null }); expect(fs.readdirSync(root)).toEqual([]);
  });
  it('classifies the actual reserve plus in-flight reservations against available space', async () => {
    const root = directory(); const io = { ...fs.promises, statfs: async () => ({ bavail: 10n, bsize: 1024n }) };
    expect(await probeStorageReadiness(root, { io, minFreeBytes: 8192, reservedBytes: 4096 })).toEqual({ state: 'insufficient-resources', writable: true, freeBytes: 10240, minFreeBytes: 8192, reservedBytes: 4096 }); expect(fs.readdirSync(root)).toEqual([]);
  });
  it.each([['EACCES', 'not-writable'], ['EROFS', 'not-writable'], ['ENOSPC', 'insufficient-resources'], ['EIO', 'unknown']])('projects write failure %s without the host error or path', async (code, state) => {
    const root = directory(); const io = { ...fs.promises, open: async () => { throw Object.assign(new Error('/secret/credentials'), { code }); } };
    const result = await probeStorageReadiness(root, { io }); expect(result.state).toBe(state); expect(JSON.stringify(result)).not.toContain('/secret/credentials'); expect(fs.readdirSync(root)).toEqual([]);
  });
  it('does not delete a probe path whose identity was replaced before cleanup', async () => {
    const root = directory(); const io = { ...fs.promises, lstat: async (value, options) => {
      const stat = await fs.promises.lstat(value, options);
      return value === root ? stat : Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: typeof stat.ino === 'bigint' ? stat.ino + 1n : stat.ino + 1 });
    }, unlink: vi.fn() };
    const result = await probeStorageReadiness(root, { io, nonce: 'a'.repeat(32) });
    expect(result.state).toBe('unknown'); expect(io.unlink).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toHaveLength(1);
  });
});
