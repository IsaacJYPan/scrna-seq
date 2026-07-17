import { describe, expect, it, vi } from 'vitest';

const { startTopologyLockWatchdog } = require('./webTopologyWatchdog');

describe('web topology lock watchdog', () => {
  it('calls the fatal handler exactly once when the reserved lock session is lost', async () => {
    const privateError = new Error('postgres://secret@private-db/topology');
    const lock = { check: vi.fn().mockRejectedValue(privateError) };
    const onLost = vi.fn();
    const clearInterval = vi.fn();
    const watchdog = startTopologyLockWatchdog({
      lock,
      onLost,
      intervalMs: 10,
      setInterval: vi.fn(() => ({ unref: vi.fn() })),
      clearInterval,
    });

    await expect(watchdog.checkNow()).resolves.toBe(false);
    expect(onLost).not.toHaveBeenCalled();
    await expect(watchdog.checkNow()).resolves.toBe(false);
    await expect(watchdog.checkNow()).resolves.toBe(true);
    expect(onLost).toHaveBeenCalledOnce();
    expect(JSON.stringify(onLost.mock.calls)).not.toContain('private-db');
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it('resets the failure count after a successful transient retry', async () => {
    const check = vi.fn()
      .mockRejectedValueOnce(new Error('temporary timeout'))
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('temporary timeout'))
      .mockResolvedValueOnce(true);
    const onLost = vi.fn();
    const watchdog = startTopologyLockWatchdog({
      lock: { check },
      onLost,
      setInterval: vi.fn(() => ({ unref: vi.fn() })),
      clearInterval: vi.fn(),
    });

    await expect(watchdog.checkNow()).resolves.toBe(false);
    await expect(watchdog.checkNow()).resolves.toBe(true);
    await expect(watchdog.checkNow()).resolves.toBe(false);
    await expect(watchdog.checkNow()).resolves.toBe(true);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('stops cleanly without checking again', async () => {
    const check = vi.fn().mockResolvedValue(true);
    const watchdog = startTopologyLockWatchdog({
      lock: { check },
      setInterval: vi.fn(() => ({ unref: vi.fn() })),
      clearInterval: vi.fn(),
    });
    watchdog.stop();
    await expect(watchdog.checkNow()).resolves.toBe(true);
    expect(check).not.toHaveBeenCalled();
  });
});
