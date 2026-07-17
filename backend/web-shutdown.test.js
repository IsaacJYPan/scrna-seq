import { describe, expect, it, vi } from 'vitest';

const { closeHttpServer, shutdownWebRuntime } = require('./webShutdown');

describe('web shutdown lifecycle', () => {
  it('marks non-ready before draining, then releases runtime dependencies before exit', async () => {
    const events = [];
    const server = {
      listening: true,
      close(callback) { events.push('server.close'); this.listening = false; callback(); },
      closeIdleConnections() { events.push('server.closeIdle'); },
    };
    let exitCode = null;
    const code = await shutdownWebRuntime({
      server,
      health: {
        markDraining: () => events.push('health.draining'),
        markStopped: () => events.push('health.stopped'),
      },
      topologyLock: { release: async () => events.push('lock.release') },
      db: { close: async () => events.push('db.close') },
      drainDelayMs: 0,
      timeoutMs: 1000,
      exit: (value) => { exitCode = value; events.push('exit'); },
      logger: { error: vi.fn() },
    });

    expect(code).toBe(0);
    expect(exitCode).toBe(0);
    expect(events).toEqual([
      'health.draining', 'server.close', 'server.closeIdle',
      'lock.release', 'db.close', 'health.stopped', 'exit',
    ]);
  });

  it('is a no-op for an HTTP server that never started listening', async () => {
    const close = vi.fn();
    await closeHttpServer({ listening: false, close });
    expect(close).not.toHaveBeenCalled();
  });

  it('forces connections closed and exits nonzero when HTTP drain fails', async () => {
    const closeAllConnections = vi.fn();
    let exitCode = null;
    const logger = { error: vi.fn() };
    const code = await shutdownWebRuntime({
      server: {
        listening: true,
        close: () => { throw new Error('/private/socket'); },
        closeAllConnections,
      },
      health: { markDraining: vi.fn(), markStopped: vi.fn() },
      topologyLock: { release: vi.fn().mockResolvedValue() },
      db: { close: vi.fn().mockResolvedValue() },
      drainDelayMs: 0,
      timeoutMs: 1000,
      exit: (value) => { exitCode = value; },
      logger,
    });
    expect(code).toBe(1);
    expect(exitCode).toBe(1);
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith('[web] shutdown step failed (HTTP_DRAIN_FAILED).');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('/private/socket');
  });

  it('preserves a fatal topology-loss exit code through otherwise clean teardown', async () => {
    let exitCode = null;
    const code = await shutdownWebRuntime({
      initialExitCode: 1,
      health: { markDraining: vi.fn(), markStopped: vi.fn() },
      topologyLock: { release: vi.fn().mockResolvedValue() },
      db: { close: vi.fn().mockResolvedValue() },
      drainDelayMs: 0,
      timeoutMs: 1000,
      exit: (value) => { exitCode = value; },
      logger: { error: vi.fn() },
    });
    expect(code).toBe(1);
    expect(exitCode).toBe(1);
  });
});
