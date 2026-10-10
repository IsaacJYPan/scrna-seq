import { afterEach, expect, it, vi } from 'vitest';
import { getRunMonitoring, listRunMonitoring } from './runMonitoringApi';

afterEach(() => { vi.unstubAllGlobals(); delete window.desktopShell; vi.useRealTimers(); });

it('only reads bounded monitoring pages and one existing durable record', async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ items: [], nextCursor: null }) }));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await listRunMonitoring('project/a', { before: 'cursor+value', signal: controller.signal });
  await getRunMonitoring('project/a', 'job/id', controller.signal);
  expect(fetch).toHaveBeenNthCalledWith(1, '/api/run-monitoring/project%2Fa?limit=25&before=cursor%2Bvalue', { credentials: 'include', signal: expect.any(AbortSignal) });
  expect(fetch).toHaveBeenNthCalledWith(2, '/api/run-monitoring/project%2Fa/job%2Fid', { credentials: 'include', signal: expect.any(AbortSignal) });
  expect(fetch.mock.calls.every(([, options]) => !options.method && !options.body)).toBe(true);
});

it('keeps transport details out of researcher errors and preserves access status', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'private server credential', code: 'FORBIDDEN' }) })));
  await expect(getRunMonitoring('project', 'job')).rejects.toMatchObject({ status: 403, message: 'This run is no longer available to your account.' });
});

it.each([[1000, 25], [0, 25], [-1, 25], [1.5, 25]])('keeps requested page size %i bounded to %i', async (limit, bounded) => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ items: [], nextCursor: null }) }));
  vi.stubGlobal('fetch', fetch);
  await listRunMonitoring('project', { limit });
  expect(fetch.mock.calls[0][0]).toBe(`/api/run-monitoring/project?limit=${bounded}`);
});

it.each([401, 403, 404])('preserves access denial for HTTP %i even when the response body is invalid', async status => {
  const json = vi.fn(async () => { throw new Error('private proxy path'); });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json })));
  await expect(getRunMonitoring('project', 'job')).rejects.toMatchObject({ status, message: 'This run is no longer available to your account.' });
  expect(json).not.toHaveBeenCalled();
});

it('aborts a stalled read after ten seconds without replaying it', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn((_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('private connection address'), { name: 'AbortError' })), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  const check = expect(getRunMonitoring('project', 'job')).rejects.toThrow('Run monitoring could not be reached.');
  await vi.advanceTimersByTimeAsync(10000);
  await check;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  vi.useRealTimers();
});

it('propagates caller cancellation to the bounded read', async () => {
  const fetch = vi.fn((_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('The read was aborted.'), { name: 'AbortError' })), { once: true });
  }));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const request = getRunMonitoring('project', 'job', controller.signal);
  const check = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await check;
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
});

it('does not dispatch while the native server is disconnected', async () => {
  window.desktopShell = { getCurrentTarget: async () => ({ id: 'server', status: 'disconnected' }) };
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(getRunMonitoring('project', 'job')).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
  expect(fetch).not.toHaveBeenCalled();
});
