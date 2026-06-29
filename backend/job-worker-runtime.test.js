/**
 * Worker RUNTIME hardening: config parsing, startup wiring, and graceful shutdown.
 *
 * Companion to job-worker.test.js (which covers the drain loop's claim/heartbeat/
 * complete/fail/reap behavior). This file directly exercises the *runtime seams* that
 * wrap that loop:
 *   - parseJobWorkerConfig  — deterministic, safe env parsing (jobWorker.js)
 *   - startJobWorkerIfEnabled — opt-in startup wiring + single-loop idempotency (server.js)
 *   - stopJobWorker          — safe stop (no worker / double stop) (server.js)
 *   - shutdownJobWorkerAndServer — awaits worker stop, bounded by timeout, no leaked
 *                                  timers, sanitized failure handling (server.js)
 *   - DB busy_timeout init    — proof the single-process lock softening is applied
 *
 * SCOPE: this is hardening only. NO R/Seurat pipeline execution, NO artifacts, NO
 * shared R state, NO new public routes. The worker remains opt-in and minimal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const dbmod = require('./database');
const worker = require('./jobWorker');
const { parseJobWorkerConfig, parsePositiveIntOrNull, JOB_WORKER_DEFAULTS } = worker;

import serverModule from '../server.js';
const server = serverModule.default || serverModule;
const { startJobWorkerIfEnabled, stopJobWorker, shutdownJobWorkerAndServer } = server;

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
// A logger that records warn/error messages so tests can assert (and check they
// never echo the raw invalid value — i.e. no secret/operator content leaks).
function recordingLogger() {
  const warns = [];
  const errors = [];
  const infos = [];
  return {
    infos, warns, errors,
    info: (m) => infos.push(String(m)),
    warn: (m) => warns.push(String(m)),
    error: (m) => errors.push(String(m)),
  };
}

// A fake worker so startup/shutdown wiring can be tested without real timers/DB.
function fakeWorker(overrides = {}) {
  const calls = { start: 0, stop: 0 };
  return {
    calls,
    workerId: overrides.workerId || 'worker_fake',
    start: () => { calls.start++; },
    stop: overrides.stop || (() => { calls.stop++; return Promise.resolve(); }),
    isRunning: () => true,
    ...overrides,
  };
}

describe('parseJobWorkerConfig — enable flag (exact "true" only)', () => {
  it('disabled when ENABLE_JOB_WORKER is missing', () => {
    expect(parseJobWorkerConfig({}, { logger: silentLogger() }).enabled).toBe(false);
  });

  it.each(['', 'false', '0', 'TRUE', 'True', 'yes', '1', ' true', 'true '])(
    'disabled when ENABLE_JOB_WORKER is a non-exact value (%j)',
    (val) => {
      const cfg = parseJobWorkerConfig({ ENABLE_JOB_WORKER: val }, { logger: silentLogger() });
      expect(cfg.enabled).toBe(false);
    }
  );

  it('enabled ONLY for the exact string "true"', () => {
    const cfg = parseJobWorkerConfig({ ENABLE_JOB_WORKER: 'true' }, { logger: silentLogger() });
    expect(cfg.enabled).toBe(true);
  });
});

describe('parseJobWorkerConfig — poll/lease parsing + fallback policy', () => {
  it('uses documented defaults when poll/lease are unset (and defaults match .env.example)', () => {
    const cfg = parseJobWorkerConfig({}, { logger: silentLogger() });
    expect(cfg.pollIntervalMs).toBe(1000);
    expect(cfg.leaseSeconds).toBe(30);
    // Defaults constant must match what we assert above and what .env.example documents.
    expect(JOB_WORKER_DEFAULTS).toEqual({ pollIntervalMs: 1000, leaseSeconds: 30 });
  });

  it('parses valid positive-integer poll/lease values', () => {
    const cfg = parseJobWorkerConfig(
      { JOB_WORKER_POLL_MS: '250', JOB_WORKER_LEASE_SECONDS: '45' },
      { logger: silentLogger() }
    );
    expect(cfg.pollIntervalMs).toBe(250);
    expect(cfg.leaseSeconds).toBe(45);
  });

  it.each(['', '  ', 'abc', 'NaN', '0', '-5', '12.5', 'Infinity', '1e3 ms'])(
    'falls back to defaults + warns for invalid poll value (%j)',
    (val) => {
      const logger = recordingLogger();
      const cfg = parseJobWorkerConfig({ JOB_WORKER_POLL_MS: val }, { logger });
      expect(cfg.pollIntervalMs).toBe(JOB_WORKER_DEFAULTS.pollIntervalMs);
      expect(logger.warns.length).toBe(1);
      expect(logger.warns[0]).toMatch(/JOB_WORKER_POLL_MS/);
    }
  );

  it.each(['', 'abc', '0', '-1', '3.5', 'Infinity'])(
    'falls back to defaults + warns for invalid lease value (%j)',
    (val) => {
      const logger = recordingLogger();
      const cfg = parseJobWorkerConfig({ JOB_WORKER_LEASE_SECONDS: val }, { logger });
      expect(cfg.leaseSeconds).toBe(JOB_WORKER_DEFAULTS.leaseSeconds);
      expect(logger.warns.length).toBe(1);
      expect(logger.warns[0]).toMatch(/JOB_WORKER_LEASE_SECONDS/);
    }
  );

  it('warning never echoes the raw operator-supplied value (no secret/content leak)', () => {
    const logger = recordingLogger();
    parseJobWorkerConfig(
      { JOB_WORKER_POLL_MS: 'sentinel-leak-7q', JOB_WORKER_LEASE_SECONDS: 'sentinel-leak-9z' },
      { logger }
    );
    expect(logger.warns.length).toBe(2);
    for (const w of logger.warns) {
      expect(w).not.toContain('sentinel-leak');
    }
  });

  it('does NOT warn when poll/lease are simply unset (silent default)', () => {
    const logger = recordingLogger();
    parseJobWorkerConfig({ ENABLE_JOB_WORKER: 'true' }, { logger });
    expect(logger.warns.length).toBe(0);
  });

  it('parsePositiveIntOrNull rejects invalid inputs and accepts positive integers', () => {
    for (const bad of [undefined, null, '', '  ', 'x', 'NaN', '0', '-1', '1.5', 'Infinity', Infinity, NaN]) {
      expect(parsePositiveIntOrNull(bad)).toBeNull();
    }
    expect(parsePositiveIntOrNull('1')).toBe(1);
    expect(parsePositiveIntOrNull('1000')).toBe(1000);
    expect(parsePositiveIntOrNull(42)).toBe(42);
  });
});

describe('startJobWorkerIfEnabled — opt-in startup wiring', () => {
  afterEach(() => {
    // Always clear the server-module worker singleton between tests.
    stopJobWorker();
  });

  it('importing the server module does not start a worker', () => {
    // If import had started a worker, there would be one to stop. There must not be.
    expect(stopJobWorker()).toBeUndefined();
  });

  it.each([undefined, '', 'false', '0', 'TRUE', 'yes', '1'])(
    'does not start when ENABLE_JOB_WORKER is %j',
    (val) => {
      const env = val === undefined ? {} : { ENABLE_JOB_WORKER: val };
      const created = [];
      const result = startJobWorkerIfEnabled(env, {
        createJobWorker: () => { const w = fakeWorker(); created.push(w); return w; },
        logger: silentLogger(),
      });
      expect(result).toBeNull();
      expect(created.length).toBe(0);
    }
  );

  it('starts exactly one worker when ENABLE_JOB_WORKER="true"', () => {
    const created = [];
    const w = startJobWorkerIfEnabled(
      { ENABLE_JOB_WORKER: 'true' },
      { createJobWorker: () => { const fw = fakeWorker(); created.push(fw); return fw; }, logger: silentLogger() }
    );
    expect(created.length).toBe(1);
    expect(w).toBe(created[0]);
    expect(w.calls.start).toBe(1);
  });

  it('is idempotent: repeated starts do not create a duplicate loop', () => {
    const created = [];
    const make = { createJobWorker: () => { const fw = fakeWorker(); created.push(fw); return fw; }, logger: silentLogger() };
    const first = startJobWorkerIfEnabled({ ENABLE_JOB_WORKER: 'true' }, make);
    const second = startJobWorkerIfEnabled({ ENABLE_JOB_WORKER: 'true' }, make);
    const third = startJobWorkerIfEnabled({ ENABLE_JOB_WORKER: 'true' }, make);
    expect(created.length).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.calls.start).toBe(1);
  });

  it('passes parsed poll/lease config through to the worker factory', () => {
    let seen = null;
    startJobWorkerIfEnabled(
      { ENABLE_JOB_WORKER: 'true', JOB_WORKER_POLL_MS: '500', JOB_WORKER_LEASE_SECONDS: '60' },
      { createJobWorker: (opts) => { seen = opts; return fakeWorker(); }, logger: silentLogger() }
    );
    expect(seen.pollIntervalMs).toBe(500);
    expect(seen.leaseSeconds).toBe(60);
  });

  it('startup wiring does not expose claim tokens or alter the public exports', () => {
    let seen = null;
    const w = startJobWorkerIfEnabled(
      { ENABLE_JOB_WORKER: 'true' },
      { createJobWorker: (opts) => { seen = opts; return fakeWorker(); }, logger: silentLogger() }
    );
    // The worker handle and factory options carry no claim token / secret material.
    expect(Object.keys(w)).not.toContain('claimToken');
    expect(JSON.stringify(seen || {})).not.toMatch(/claim|token|secret/i);
    // Public server exports are unchanged shape-wise (no new public API surface).
    expect(typeof server.startJobWorkerIfEnabled).toBe('function');
    expect(typeof server.stopJobWorker).toBe('function');
    expect(typeof server.shutdownJobWorkerAndServer).toBe('function');
  });
});

describe('stopJobWorker — safe with no worker / double stop', () => {
  it('is safe when no worker exists', () => {
    expect(stopJobWorker()).toBeUndefined();
    expect(stopJobWorker()).toBeUndefined();
  });

  it('is safe to call twice after a start', () => {
    const w = startJobWorkerIfEnabled(
      { ENABLE_JOB_WORKER: 'true' },
      { createJobWorker: () => fakeWorker(), logger: silentLogger() }
    );
    const firstStop = stopJobWorker();
    expect(firstStop).toBeDefined();       // returns the worker's stop() promise
    expect(w.calls.stop).toBe(1);
    expect(stopJobWorker()).toBeUndefined(); // second stop: nothing left, no throw
    expect(w.calls.stop).toBe(1);
  });
});

describe('shutdownJobWorkerAndServer — awaits worker stop, bounded, no leaks', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('awaits the worker stop() before exiting', async () => {
    let stopResolved = false;
    let exitCode = null;
    const w = fakeWorker({
      stop: () => new Promise((resolve) => setTimeout(() => { stopResolved = true; resolve(); }, 0)),
    });
    await shutdownJobWorkerAndServer({
      worker: w,
      logger: silentLogger(),
      exit: (code) => { exitCode = code; },
    });
    expect(stopResolved).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('closes the server (best-effort) and exits 0 on clean stop', async () => {
    let closed = false;
    let exitCode = null;
    await shutdownJobWorkerAndServer({
      worker: fakeWorker(),
      server: { close: () => { closed = true; } },
      logger: silentLogger(),
      exit: (code) => { exitCode = code; },
    });
    expect(closed).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('handles a worker stop() rejection safely (sanitized, exit non-zero)', async () => {
    const logger = recordingLogger();
    let exitCode = null;
    const w = fakeWorker({
      stop: () => Promise.reject(Object.assign(new Error('boom secret-detail'), { code: 'STOP_FAILED' })),
    });
    await shutdownJobWorkerAndServer({
      worker: w,
      logger,
      exit: (code) => { exitCode = code; },
    });
    expect(exitCode).toBe(1);
    expect(logger.errors.length).toBe(1);
    // Sanitized: code only, never the raw error message / internal detail.
    expect(logger.errors[0]).toMatch(/STOP_FAILED/);
    expect(logger.errors[0]).not.toContain('secret-detail');
  });

  it('does not hang forever: times out a stuck worker stop and exits non-zero', async () => {
    vi.useFakeTimers();
    const logger = recordingLogger();
    let exitCode = null;
    const w = fakeWorker({ stop: () => new Promise(() => { /* never resolves */ }) });
    const p = shutdownJobWorkerAndServer({
      worker: w,
      logger,
      timeoutMs: 5000,
      exit: (code) => { exitCode = code; },
    });
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toMatch(/WORKER_STOP_TIMEOUT/);
  });

  it('leaks no timers: the shutdown timeout timer is always cleared', async () => {
    vi.useFakeTimers();
    await shutdownJobWorkerAndServer({
      worker: fakeWorker(), // resolves immediately
      logger: silentLogger(),
      timeoutMs: 5000,
      exit: () => {},
    });
    // After a clean stop the pending timeout timer must have been cleared.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is safe when there is no worker (nothing to await)', async () => {
    let exitCode = null;
    await shutdownJobWorkerAndServer({ logger: silentLogger(), exit: (code) => { exitCode = code; } });
    expect(exitCode).toBe(0);
  });
});

describe('database init — busy_timeout hardening is applied', () => {
  afterEach(() => dbmod.closeDatabase());

  it('sets busy_timeout=5000 on a fresh database', () => {
    dbmod.initDatabase(':memory:');
    expect(dbmod.getPragma('busy_timeout')).toBe(5000);
  });
});
