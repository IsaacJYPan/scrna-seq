import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const {
  HEALTH_PROBE_PREFIX,
  probeWritableDirectory,
  createWebHealthController,
} = require('./webHealth');

const roots = [];

function tempRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `benchone-${name}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('web storage readiness probe', () => {
  it('performs an exact write/read/remove check without leaving a probe behind', () => {
    const root = tempRoot('web-health');
    expect(probeWritableDirectory(root, { nonce: 'a'.repeat(32) })).toBe(true);
    expect(fs.readdirSync(root).some((name) => name.startsWith(HEALTH_PROBE_PREFIX))).toBe(false);
  });

  it('rejects a file where a storage root is required', () => {
    const root = tempRoot('web-health-file');
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'x');
    expect(() => probeWritableDirectory(file)).toThrow(/unsafe/i);
  });

  it('does not expose the private root path in its stable error', () => {
    const missing = path.join(tempRoot('web-health-missing'), 'secret-project-root');
    let error;
    try { probeWritableDirectory(missing); } catch (caught) { error = caught; }
    expect(error).toBeTruthy();
    expect(String(error.message)).not.toContain(missing);
  });
});

describe('web liveness/readiness policy', () => {
  function controller(overrides = {}) {
    return createWebHealthController({
      db: { checkHealth: vi.fn().mockResolvedValue(true) },
      storageRoot: '/durable/private/path',
      vaultRoot: '/vault/private/path',
      probeWritableDirectory: vi.fn().mockReturnValue(true),
      probeR: vi.fn().mockResolvedValue(true),
      topologyLock: { isHeld: vi.fn().mockReturnValue(true) },
      ...overrides,
    });
  }

  it('keeps process liveness dependency-free', () => {
    const db = { checkHealth: vi.fn() };
    const health = controller({ db });
    expect(health.liveness()).toEqual({
      httpStatus: 200,
      body: { status: 'live', role: 'web' },
    });
    expect(db.checkHealth).not.toHaveBeenCalled();
  });

  it('requires database, both storage roots, and the singleton topology lock', async () => {
    const health = controller({ db: { checkHealth: vi.fn().mockRejectedValue(new Error('/private/db')) } });
    const result = await health.readiness();
    expect(result.httpStatus).toBe(503);
    expect(result.body).toMatchObject({
      status: 'not_ready',
      components: { database: 'unavailable', rCompute: 'ready' },
    });
    expect(JSON.stringify(result.body)).not.toMatch(/\/private\/db|error|stack/i);
  });

  it('reports optional R compute degradation without taking metadata readiness down', async () => {
    const health = controller({ probeR: vi.fn().mockRejectedValue(new Error('R secret URL')) });
    const result = await health.readiness();
    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      status: 'ready',
      computeDegraded: true,
      components: { rCompute: 'unavailable' },
    });
    expect(JSON.stringify(result.body)).not.toContain('R secret URL');
  });

  it('coalesces and briefly caches readiness so probe floods cannot multiply dependency I/O', async () => {
    const db = { checkHealth: vi.fn().mockResolvedValue(true) };
    const probeWritableDirectory = vi.fn().mockReturnValue(true);
    const probeR = vi.fn().mockResolvedValue(true);
    const topologyLock = { isHeld: vi.fn().mockReturnValue(true) };
    const health = controller({ db, probeWritableDirectory, probeR, topologyLock });

    const results = await Promise.all(Array.from({ length: 25 }, () => health.readiness()));
    expect(results.every((result) => result.httpStatus === 200)).toBe(true);
    expect((await health.readiness()).httpStatus).toBe(200);
    expect(db.checkHealth).toHaveBeenCalledOnce();
    expect(probeWritableDirectory).toHaveBeenCalledTimes(2);
    expect(probeR).toHaveBeenCalledOnce();
    expect(topologyLock.isHeld).toHaveBeenCalledOnce();
  });

  it('becomes non-ready before shutdown while remaining live during drain', async () => {
    const health = controller();
    health.markDraining();
    expect(health.liveness().httpStatus).toBe(200);
    expect((await health.readiness()).httpStatus).toBe(503);
    health.markStopped();
    expect(health.liveness().httpStatus).toBe(503);
  });
});
