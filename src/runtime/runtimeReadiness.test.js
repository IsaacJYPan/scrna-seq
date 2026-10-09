import { describe, expect, it, vi } from 'vitest';
import { normalizeRuntimeReadiness, readRuntimeReadiness, readinessFailureMessage, READINESS_SCHEMA } from './runtimeReadiness';
import { readinessFixture } from './_runtimeReadinessFixtures';

describe('bounded readiness client', () => {
  it('preserves observed capabilities and exact immutable identity while stripping server internals', () => {
    const raw = readinessFixture();
    raw.credentials = 'private-secret'; raw.guided.workerId = 'private-worker'; raw.privateR.environment.hostPath = '/private/host'; raw.storage.durable.hostPath = 'C:\\secret';
    const report = normalizeRuntimeReadiness(raw);
    expect(report.privateR.environment.manifestSha256).toBe('a'.repeat(64));
    expect(report.storage.durable.freeBytes).toBe(32 * 1024 ** 3);
    expect(report.workers.capabilities).toEqual({ pathwayEnrichment: true, cellChat: false });
    expect(JSON.stringify(report)).not.toMatch(/private-secret|private-worker|hostPath|C:\\secret/);
  });
  it('keeps unknown capabilities, malformed limits, missing storage and invalid environment explicitly unverified', () => {
    const raw = readinessFixture({ guided: { state: 'future-state', rVersion: '/private/host' }, workers: { capabilities: { cellChat: 'true' } }, privateR: { state: 'ready', accessState: 'true', environment: { id: '/private/host' }, resources: { kernel: { cpuLimit: Infinity, memoryBytes: -1, maxActive: 2.2 } } }, storage: {} });
    const report = normalizeRuntimeReadiness(raw);
    expect(report.guided).toEqual({ state: 'unknown', rVersion: null, packages: [] });
    expect(report.workers.capabilities).toEqual({ cellChat: null, pathwayEnrichment: null });
    expect(report.privateR.environment).toBeNull(); expect(report.privateR.accessState).toBe('unknown');
    expect(Object.values(report.privateR.resources.kernel).every(value => value === null)).toBe(true);
    expect(report.storage.private).toEqual({ state: 'unknown', writable: null, freeBytes: null, minFreeBytes: null, reservedBytes: null });
  });
  it('preserves a valid run duration measured from millisecond precision', () => {
    const raw = readinessFixture(); raw.privateR.resources.oneShot.timeoutSeconds = 123.456;
    expect(normalizeRuntimeReadiness(raw).privateR.resources.oneShot.timeoutSeconds).toBe(123.456);
    raw.privateR.resources.oneShot.timeoutSeconds = 0.001;
    expect(normalizeRuntimeReadiness(raw).privateR.resources.oneShot.timeoutSeconds).toBe(0.001);
  });
  it('allows only fixed packages, issue codes and safe scopes without rendering unexpected diagnostics', () => {
    const raw = readinessFixture({ guided: { state: 'ready', packages: [{ name: 'CellChat', state: 'missing' }, { name: '/private/path', state: 'available' }, { name: 'DatabaseSecret', state: 'available' }] }, issues: [{ code: 'MISSING_PACKAGE', scope: 'guided', package: 'CellChat', error: 'host secret' }, { code: 'PRIVATE_SECRET', scope: 'guided' }, { code: 'STORAGE_UNKNOWN', scope: '/private/path' }] });
    const report = normalizeRuntimeReadiness(raw);
    expect(report.guided.packages).toEqual([{ name: 'CellChat', state: 'missing' }]);
    expect(report.issues).toEqual([{ code: 'MISSING_PACKAGE', scope: 'guided', state: 'unknown', package: 'CellChat' }]);
    expect(JSON.stringify(report)).not.toMatch(/private\/path|DatabaseSecret|host secret/);
  });
  it.each([{ schema: 'future-schema' }, { service: { product: 'Other service' } }, { service: { product: 'TraceOmics', serviceApiVersion: 1, minimumClientApiVersion: 2 } }])('rejects unsupported service reports: %j', overrides => {
    expect(() => normalizeRuntimeReadiness(readinessFixture(overrides))).toThrow(/supported readiness report/);
  });
  it('accepts a newer service that explicitly supports the current client protocol', () => {
    const raw = readinessFixture(); raw.service.serviceApiVersion = 2;
    expect(normalizeRuntimeReadiness(raw).service).toMatchObject({ serviceApiVersion: 2, minimumClientApiVersion: 1 });
  });
  it('sends only a scope and abort signal to the generic bridge', async () => {
    const api = { getRuntimeReadiness: vi.fn(async () => readinessFixture()) }, signal = new AbortController().signal;
    await expect(readRuntimeReadiness(api, 'project_one', { signal })).resolves.toMatchObject({ schema: READINESS_SCHEMA });
    expect(api.getRuntimeReadiness).toHaveBeenCalledExactlyOnceWith('project_one', { signal });
  });
  it.each([[401, /sign-in has expired/], [403, /review your access/], [404, /review your access/], [503, /could not be reached/], [undefined, /could not be reached/]])('sanitizes HTTP %s failures', (status, message) => {
    expect(readinessFailureMessage(Object.assign(new Error('postgres credentials at /private/host'), { status }))).toMatch(message);
  });
});
