import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
const { probeExpertRReadiness } = require('./expertRAccess');
const { brokerResourceLimits, createBrokerReadinessProbe } = require('./expertRuntimeReadiness');
const { EXPERT_R_RESOURCE_POLICY_VERSION } = require('./expertR');
const { environmentFixture } = require('./_r-environment-test-utils');
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
async function broker(handler) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true',
    EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64), EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${server.address().port}` };
}
function descriptor(state = 'ready') {
  const { reference } = environmentFixture();
  return { status: 'ok', profileId: reference.profileId, sandboxImageDigest: reference.imageDigest,
    resourcePolicyVersion: EXPERT_R_RESOURCE_POLICY_VERSION, environment: reference,
    persistentKernel: state === 'ready', persistentKernelInterrupt: true,
    readiness: { state, resources: brokerResourceLimits({}, { timeoutMs: 600000, maxConcurrent: 2, persistentKernel: true }),
      storage: { work: { state: 'ready', writable: true, freeBytes: 2 ** 32, minFreeBytes: 2 ** 30, reservedBytes: 0 } } } };
}
describe('observed private R readiness', () => {
  it('uses the authenticated readiness route and reports current daemon failure independently of a verified environment', async () => {
    let state = 'ready';
    const env = await broker((req, res) => {
      expect(req.url).toBe('/readiness');
      expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`);
      res.end(JSON.stringify(descriptor(state)));
    });
    const ready = await probeExpertRReadiness(env);
    expect(ready).toMatchObject({ state: 'ready', persistentKernel: true,
      readiness: { resources: { kernel: { memoryBytes: 8 * 1024 ** 3, executionSeconds: 300 } } } });
    state = 'unavailable';
    expect(await probeExpertRReadiness(env)).toMatchObject({ state: 'unavailable', persistentKernel: false,
      environment: ready.environment });
  });
  it.each([[401, 'authentication-failed'], [403, 'authentication-failed'], [503, 'unavailable'], [404, 'incompatible']])(
    'distinguishes broker HTTP %s without reflecting raw diagnostics', async (status, state) => {
      const env = await broker((_req, res) => { res.statusCode = status; res.end('secret /home/private token'); });
      expect(await probeExpertRReadiness(env)).toEqual({ state });
    });
  it('rejects oversized and stalled broker responses within the request deadline', async () => {
    const oversized = await broker((_req, res) => res.end('x'.repeat(16385)));
    expect(await probeExpertRReadiness(oversized)).toEqual({ state: 'incompatible' });
    const stalled = await broker((_req, res) => { res.writeHead(200); res.write('{'); });
    const start = Date.now();
    expect(await probeExpertRReadiness(stalled, { timeoutMs: 60 })).toEqual({ state: 'unreachable' });
    expect(Date.now() - start).toBeLessThan(600);
  });
  it('does not treat an older static capability reply as a current observation', async () => {
    const env = await broker((_req, res) => { const value = descriptor(); delete value.readiness; res.end(JSON.stringify(value)); });
    expect(await probeExpertRReadiness(env)).toMatchObject({ state: 'unavailable' });
  });
  it('reports the actual separate one-shot and persistent kernel ceilings', () => {
    const limits = brokerResourceLimits({ EXPERT_R_MEMORY_LIMIT: '6g', EXPERT_R_CPU_LIMIT: '3',
      PRIVATE_R_KERNEL_MEMORY_LIMIT: '2g', PRIVATE_R_KERNEL_CPU_LIMIT: '0.5', PRIVATE_R_KERNEL_MAX_PER_OWNER: '2' },
    { timeoutMs: 125000, maxConcurrent: 1, persistentKernel: true });
    expect(limits.oneShot).toEqual({ memoryBytes: 6 * 1024 ** 3, cpuLimit: 3, timeoutSeconds: 125, maxConcurrent: 1 });
    expect(limits.kernel).toMatchObject({ memoryBytes: 2 * 1024 ** 3, cpuLimit: 0.5, maxPerOwner: 2 });
    expect(brokerResourceLimits({}, { timeoutMs: 600000, maxConcurrent: 2, persistentKernel: false }).kernel).toBeNull();
  });
  it('shares only a bounded observational image check and accounts for storage reservations on the same filesystem', async () => {
    let now = 0;
    let healthy = true;
    const runProcess = vi.fn(async (_command, args, options) => {
      expect(args[0]).toBe('image'); expect(options.timeoutMs).toBe(800);
      if (!healthy) throw new Error('daemon socket unavailable');
      return { stdout: `sha256:${'b'.repeat(64)}` };
    });
    const probeStorage = vi.fn(async () => ({ state: 'ready', writable: true, freeBytes: 4000 }));
    const inspect = createBrokerReadinessProbe({ image: `sha256:${'b'.repeat(64)}`, runProcess, probeStorage,
      workRoot: '/work', durableRoot: '/durable', minFreeBytes: 1000,
      getReservations: () => ({ work: 100n, durable: 200n }), sameFilesystem: async () => true, now: () => now });
    const [one, two] = await Promise.all([inspect(), inspect()]);
    expect(one).toEqual(two); expect(runProcess).toHaveBeenCalledTimes(1);
    expect(one.storage.work).toMatchObject({ minFreeBytes: 1000, reservedBytes: 300 });
    expect(one.storage.durable).toMatchObject({ reservedBytes: 300 });
    healthy = false; now = 5001;
    expect(await inspect()).toMatchObject({ state: 'unavailable' });
    expect(runProcess).toHaveBeenCalledTimes(2);
  });
  it('returns daemon availability even when filesystem I/O stalls and never multiplies the stuck probes', async () => {
    const never = () => new Promise(() => {});
    const sameFilesystem = vi.fn(never), probeStorage = vi.fn(never);
    const runProcess = vi.fn(async () => ({ stdout: `sha256:${'b'.repeat(64)}` }));
    let now = 0;
    const inspect = createBrokerReadinessProbe({ image: `sha256:${'b'.repeat(64)}`, runProcess, probeStorage,
      workRoot: '/work', durableRoot: '/durable', minFreeBytes: 1000, timeoutMs: 30,
      getReservations: () => ({ work: 0n, durable: 0n }), sameFilesystem, now: () => now });
    const start = Date.now();
    expect(await inspect()).toMatchObject({ state: 'ready', storage: { work: { state: 'unknown', freeBytes: null } } });
    expect(Date.now() - start).toBeLessThan(600);
    now = 5001;
    expect(await inspect()).toMatchObject({ state: 'ready' });
    expect(sameFilesystem).toHaveBeenCalledOnce(); expect(probeStorage).toHaveBeenCalledTimes(2);
    expect(runProcess).toHaveBeenCalledTimes(2);
  });
  it('keeps a timed-out daemon check unknown rather than declaring its image unavailable', async () => {
    const inspect = createBrokerReadinessProbe({ image: `sha256:${'b'.repeat(64)}`,
      runProcess: async () => { throw Object.assign(new Error('Timed out'), { code: 'SANDBOX_INTERRUPTED' }); },
      probeStorage: async () => ({ state: 'ready', writable: true, freeBytes: 4000 }),
      workRoot: '/work', durableRoot: '/durable', minFreeBytes: 1000,
      getReservations: () => ({ work: 0n, durable: 0n }), sameFilesystem: async () => true });
    expect(await inspect()).toMatchObject({ state: 'unknown', storage: { work: { state: 'ready' } } });
  });
});
