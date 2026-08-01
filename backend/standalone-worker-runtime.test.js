import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const {
  STANDALONE_WORKER_DEFAULTS,
  parseAllowedJobTypes,
  parseStandaloneWorkerConfig,
  ensureStorageProbe,
  removeStorageProbe,
  createStandaloneWorkerRuntime,
} = require('./workerRuntime');
const { STORAGE_PROBE_PREFIX, STORAGE_PROBE_CONTENT } = require('./rRuntime');
const workerEntry = require('../worker.js');

const tempRoots = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrna-worker-runtime-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function runtimeConfig(overrides = {}) {
  return {
    enabled: true,
    pollIntervalMs: 5,
    leaseSeconds: 30,
    concurrency: 1,
    minFreeMemoryMb: 1,
    drainTimeoutMs: 1000,
    startupTimeoutMs: 20,
    startupRetryMs: 1,
    healthHost: '127.0.0.1',
    healthPort: 0,
    allowedJobTypes: null,
    ...overrides,
  };
}

function fakeDb(overrides = {}) {
  const topologyLock = {
    check: vi.fn(async () => true),
    release: vi.fn(async () => {}),
  };
  return {
    initSchema: vi.fn(async () => {}),
    checkHealth: vi.fn(async () => true),
    acquireStandaloneWorkerLock: vi.fn(async () => topologyLock),
    reportStandaloneWorkerRuntimeState: vi.fn(async () => {}),
    topologyLock,
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakeWorker(overrides = {}) {
  let running = false;
  return {
    workerId: 'worker_runtime_test',
    start: vi.fn(() => { running = true; }),
    stop: vi.fn(async () => { running = false; }),
    runOnce: vi.fn(async () => ({ status: 'idle' })),
    isRunning: () => running,
    ...overrides,
  };
}

function request(address, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: address.port, path: route }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
  });
}

function makeRuntime(overrides = {}) {
  const db = overrides.db || fakeDb();
  const worker = overrides.worker || fakeWorker();
  const root = overrides.root || tempRoot();
  const runtime = createStandaloneWorkerRuntime({
    workerConfig: overrides.workerConfig || runtimeConfig(),
    rConfig: {
      mode: 'external', baseUrl: 'http://127.0.0.1:8000', protocol: 'http:',
      hostname: '127.0.0.1', port: 8000, token: 'x'.repeat(32),
    },
    db,
    storageProvider: { root, remove() {} },
    availableMemoryBytes: overrides.availableMemoryBytes || (() => 8 * 1024 * 1024 * 1024),
    probeRReadiness: overrides.probeRReadiness || (async () => ({ status: 'ok', storage_shared: true })),
    createJobWorker: overrides.createJobWorker || (() => worker),
    logger: silentLogger(),
  });
  return { runtime, db, worker, root };
}

describe('standalone worker configuration', () => {
  it('keeps the process single-slot and rejects silent parallelism/resource drift', () => {
    const env = {
      ENABLE_JOB_WORKER: 'true',
      JOB_WORKER_CONCURRENCY: '1',
      JOB_WORKER_MIN_FREE_MEMORY_MB: '2048',
      JOB_WORKER_HEALTH_PORT: '0',
    };
    const parsed = parseStandaloneWorkerConfig(env, { logger: silentLogger() });
    expect(parsed.concurrency).toBe(1);
    expect(parsed.minFreeMemoryMb).toBe(2048);
    expect(STANDALONE_WORKER_DEFAULTS.drainTimeoutMs).toBeGreaterThan(600000);
    expect(() => parseStandaloneWorkerConfig({ ...env, JOB_WORKER_CONCURRENCY: '2' }, { logger: silentLogger() }))
      .toThrow(/between 1 and 1/);
    expect(() => parseStandaloneWorkerConfig({ ...env, JOB_WORKER_MIN_FREE_MEMORY_MB: '0' }, { logger: silentLogger() }))
      .toThrow(/between/);
  });

  it('accepts only registered explicit capabilities; unset means the historical all-types policy', () => {
    expect(parseAllowedJobTypes(undefined)).toBeNull();
    expect(parseAllowedJobTypes('generic,seurat.pipeline.v1')).toEqual(['generic', 'seurat.pipeline.v1']);
    expect(() => parseAllowedJobTypes('generic,evil.dynamic.r')).toThrow(/unregistered/);
  });

  it('worker entrypoint import is side-effect free', () => {
    expect(typeof workerEntry.main).toBe('function');
  });
});

describe('standalone worker readiness and drain lifecycle', () => {
  it('creates a safe shared-storage marker and rejects substitution', () => {
    const root = tempRoot();
    const nonce = 'a'.repeat(32);
    const probe = ensureStorageProbe(root, { nonce });
    expect(path.basename(probe.path)).toBe(`${STORAGE_PROBE_PREFIX}${nonce}`);
    expect(fs.readFileSync(probe.path, 'utf8')).toBe(STORAGE_PROBE_CONTENT);
    fs.writeFileSync(probe.path, 'tampered\n');
    expect(() => ensureStorageProbe(root, { nonce })).toThrow(/invalid/);
    expect(removeStorageProbe(probe)).toBe(true);
  });

  it('becomes ready only after DB, storage, R, and memory checks pass', async () => {
    const { runtime, db, worker, root } = makeRuntime();
    const started = await runtime.start();
    expect(db.initSchema).toHaveBeenCalledTimes(1);
    expect(db.checkHealth).toHaveBeenCalled();
    expect(worker.start).toHaveBeenCalledTimes(1);
    expect(started.ready).toBe(true);
    const live = await request(started.healthAddress, '/livez');
    const ready = await request(started.healthAddress, '/readyz');
    expect(live).toEqual({ status: 200, body: { status: 'live' } });
    expect(ready).toEqual({ status: 200, body: { status: 'ready' } });
    expect(await runtime.shutdown()).toBe(0);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(db.topologyLock.release).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(root).filter((name) => name.startsWith(STORAGE_PROBE_PREFIX))).toEqual([]);
  });

  it('publishes ready then draining runtime status around the worker lifecycle', async () => {
    const db = fakeDb();
    const { runtime } = makeRuntime({ db });

    await runtime.start();
    expect(db.reportStandaloneWorkerRuntimeState).toHaveBeenCalledWith('ready');

    await runtime.shutdown();
    expect(db.reportStandaloneWorkerRuntimeState).toHaveBeenLastCalledWith('draining');
  });

  it('fails closed and never constructs a worker when R readiness misses the startup deadline', async () => {
    const create = vi.fn(() => fakeWorker());
    const { runtime } = makeRuntime({
      workerConfig: runtimeConfig({ startupTimeoutMs: 5, startupRetryMs: 1 }),
      probeRReadiness: async () => { throw Object.assign(new Error('secret internal URL'), { code: 'R_NOT_READY' }); },
      createJobWorker: create,
    });
    await expect(runtime.start()).rejects.toMatchObject({ code: 'R_NOT_READY' });
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed before claiming when the memory admission reservation is unavailable', async () => {
    const create = vi.fn(() => fakeWorker());
    const { runtime } = makeRuntime({
      workerConfig: runtimeConfig({ startupTimeoutMs: 5, startupRetryMs: 1, minFreeMemoryMb: 1024 }),
      availableMemoryBytes: () => 512 * 1024 * 1024,
      createJobWorker: create,
    });
    await expect(runtime.start()).rejects.toMatchObject({ code: 'MEMORY_ADMISSION_PAUSED' });
    expect(create).not.toHaveBeenCalled();
  });

  it('cleans up a health-port bind failure and permits a safe retry', async () => {
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const blockedPort = blocker.address().port;
    const { runtime } = makeRuntime({
      workerConfig: runtimeConfig({ healthPort: blockedPort }),
    });
    await expect(runtime.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(runtime.snapshot().ready).toBe(false);
    await new Promise((resolve) => blocker.close(resolve));

    await expect(runtime.start({ autoStart: false })).resolves.toMatchObject({ ready: true });
    await runtime.shutdown();
  });

  it('refuses startup when another process owns the global worker slot', async () => {
    const create = vi.fn(() => fakeWorker());
    const db = fakeDb({
      acquireStandaloneWorkerLock: vi.fn(async () => {
        throw Object.assign(new Error('already owned'), { code: 'WORKER_TOPOLOGY_LOCKED' });
      }),
    });
    const { runtime } = makeRuntime({ db, createJobWorker: create });
    await expect(runtime.start()).rejects.toMatchObject({ code: 'WORKER_TOPOLOGY_LOCKED' });
    expect(create).not.toHaveBeenCalled();
  });

  it('treats a post-start topology-lock loss as fatal and drains before exit', async () => {
    let checks = 0;
    const lock = {
      check: vi.fn(async () => {
        checks += 1;
        if (checks > 1) {
          throw Object.assign(new Error('lost'), { code: 'WORKER_TOPOLOGY_LOCK_LOST' });
        }
      }),
      release: vi.fn(async () => {}),
    };
    const db = fakeDb({ acquireStandaloneWorkerLock: vi.fn(async () => lock) });
    const worker = fakeWorker();
    const onFatal = vi.fn();
    // Construct directly so the fatal callback remains an explicit
    // process-boundary seam.
    const root = tempRoot();
    const fatalRuntime = createStandaloneWorkerRuntime({
      workerConfig: runtimeConfig(),
      rConfig: {
        mode: 'external', baseUrl: 'http://127.0.0.1:8000', protocol: 'http:',
        hostname: '127.0.0.1', port: 8000, token: 'x'.repeat(32),
      },
      db,
      storageProvider: { root, remove() {} },
      availableMemoryBytes: () => 8 * 1024 * 1024 * 1024,
      probeRReadiness: async () => ({ status: 'ok', storage_shared: true }),
      createJobWorker: () => worker,
      onFatal,
      logger: silentLogger(),
    });
    await fatalRuntime.start();
    await expect(fatalRuntime.checkDependencies()).resolves.toEqual({
      ready: false, reason: 'WORKER_TOPOLOGY_LOCK_LOST',
    });
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(1));
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(fatalRuntime.snapshot().live).toBe(false);
  });

  it('marks readiness 503 before awaiting an in-flight drain and makes shutdown idempotent', async () => {
    let release;
    const stopped = new Promise((resolve) => { release = resolve; });
    const worker = fakeWorker({ stop: vi.fn(() => stopped) });
    const { runtime, db } = makeRuntime({ worker });
    const started = await runtime.start();
    const first = runtime.shutdown();
    expect((await request(started.healthAddress, '/readyz')).status).toBe(503);
    const second = runtime.shutdown();
    expect(second).toBe(first);
    release();
    expect(await first).toBe(0);
    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it('bounds a stuck drain and exits non-zero without releasing/finalizing work', async () => {
    const worker = fakeWorker({ stop: vi.fn(() => new Promise(() => {})) });
    const { runtime } = makeRuntime({ worker });
    await runtime.start();
    expect(await runtime.shutdown({ timeoutMs: 5 })).toBe(1);
    expect(worker.stop).toHaveBeenCalledTimes(1);
  });
});
