import { afterEach, describe, expect, it, vi } from 'vitest';
import { electronAPI } from './api';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('readiness HTTP boundary', () => {
  it('uses authenticated same-server requests with encoded project scope and cancellation', async () => {
    const fetch = vi.fn(async () => ({ ok: true, headers: new Headers(), json: async () => ({ checked: true }) }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    expect(await electronAPI.getRuntimeReadiness('proj_one&projectId=other', { signal: controller.signal })).toEqual({ checked: true });
    expect(fetch.mock.calls[0][0]).toBe('/api/runtime/readiness?projectId=proj_one%26projectId%3Dother');
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('limits streamed responses and cancels an oversized stream', async () => {
    const cancel = vi.fn(async () => {});
    vi.stubGlobal('fetch', async () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({
      read: async () => ({ value: new Uint8Array(32769), done: false }), cancel,
    }) } }));
    await expect(electronAPI.getRuntimeReadiness()).rejects.toThrow('exceeds its limit');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not reflect a failed server response body into a researcher error', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, text: async () => '/secret/password' }));
    await expect(electronAPI.getRuntimeReadiness()).rejects.toMatchObject({ status: 401, message: 'The server did not confirm readiness.' });
  });
  it('aborts a stalled request at the deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = electronAPI.getRuntimeReadiness();
    const assertion = expect(pending).rejects.toMatchObject({ code: 'READINESS_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(8000); await assertion;
  });
  it('does not issue a canceled scope request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(); controller.abort();
    await expect(electronAPI.getRuntimeReadiness(null, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
