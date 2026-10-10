import { describe, expect, it, vi } from 'vitest';
const { createContainerObserver, validateObservation, unavailable, quantity } = require('./containerObservation');
const id = 'a'.repeat(64);
const at = Date.parse('2030-01-01T00:00:00.000Z');
const limits = { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2 };
const stats = { stdout: JSON.stringify({ Name: '/private/container', ID: id, MemUsage: '128MiB / 8GiB', CPUPerc: '175.25%' }) };
const sample = { state: 'observed', scope: 'r-container', observedAt: new Date(at).toISOString(), memoryBytes: 128 * 1024 ** 2, memoryLimitBytes: limits.memoryBytes, cpuPercent: 175.25, cpuLimit: 2 };

describe('bounded container observations', () => {
  it('converts documented Docker units and rejects ambiguous or excessive sizes', () => {
    expect(quantity('1.5GiB')).toBe(1.5 * 1024 ** 3);
    expect(quantity('100 kB')).toBe(100000);
    for (const value of ['1 GB extra', '-1B', '99TiB', '1Mi', '', null]) expect(quantity(value)).toBeNull();
  });
  it('samples only the immutable container and excludes private daemon fields', async () => {
    const runProcess = vi.fn(async () => stats);
    const observe = createContainerObserver({ runProcess, now: () => at });
    expect(await observe(id, limits)).toEqual(sample);
    expect(runProcess).toHaveBeenCalledWith('docker', ['stats', '--no-stream', '--format', '{{json .}}', id], { timeoutMs: 2500 });
    expect(JSON.stringify(await observe(id, limits))).not.toContain('private');
    expect(runProcess).toHaveBeenCalledTimes(1);
  });
  it('shares a pending sample, caches briefly, and samples again after expiry', async () => {
    let current = at, release;
    const blocked = new Promise(resolve => { release = resolve; });
    const runProcess = vi.fn(() => blocked);
    const observe = createContainerObserver({ runProcess, now: () => current });
    const first = observe(id, limits), second = observe(id, limits);
    expect(runProcess).toHaveBeenCalledTimes(1); release(stats);
    expect(await first).toEqual(await second);
    current += 4999; await observe(id, limits); expect(runProcess).toHaveBeenCalledTimes(1);
    current += 2; await observe(id, limits); expect(runProcess).toHaveBeenCalledTimes(2);
  });
  it('bounds concurrent probes and rejects names without executing Docker', async () => {
    let release;
    const runProcess = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const observe = createContainerObserver({ runProcess, now: () => at, maxConcurrent: 1 });
    const first = observe(id, limits);
    expect(await observe('b'.repeat(64), limits)).toEqual(unavailable());
    expect(await observe('user-supplied-container', limits)).toEqual(unavailable());
    expect(runProcess).toHaveBeenCalledTimes(1); release(stats); await first;
  });
  it.each([
    { stdout: 'private daemon failure' },
    { stdout: 'x'.repeat(4097) },
    { stdout: JSON.stringify({ MemUsage: '1GiB / 16GiB', CPUPerc: '1%' }) },
    { stdout: JSON.stringify({ MemUsage: '9GiB / 8GiB', CPUPerc: '1%' }) },
    { stdout: JSON.stringify({ MemUsage: '1GiB / 8GiB', CPUPerc: 'NaN%' }) },
  ])('reports malformed or inconsistent telemetry as unavailable', async response => {
    const observe = createContainerObserver({ runProcess: async () => response, now: () => at });
    expect(await observe(id, limits)).toEqual(unavailable());
  });
  it('does not disclose Docker errors or stale samples', async () => {
    const observe = createContainerObserver({ runProcess: async () => { throw new Error('/private/docker Bearer secret'); }, now: () => at });
    expect(await observe(id, limits)).toEqual(unavailable());
    expect(validateObservation(sample, at + 15001)).toEqual(unavailable());
    expect(validateObservation(sample, at - 1001)).toEqual(unavailable());
    expect(validateObservation({ ...sample, memoryBytes: 9 * 1024 ** 3 }, at)).toEqual(unavailable());
  });
});
