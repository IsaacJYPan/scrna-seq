import { describe, expect, it, vi } from 'vitest';
import compatibility from './serviceCompatibility.cjs';

const { checkServiceCompatibility, validateServiceCompatibility } = compatibility;
const descriptor = { product: 'TraceOmics', serviceApiVersion: 1, minimumClientApiVersion: 1 };
const response = (body = descriptor, options = {}) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json' }, ...options,
});

describe('native public service compatibility', () => {
  it('accepts backward compatible protocol ranges and retains only verified public fields', () => {
    expect(validateServiceCompatibility({ ...descriptor, serviceApiVersion: 2, privateToken: 'omit-this' }))
      .toEqual({ ...descriptor, serviceApiVersion: 2 });
    expect(() => validateServiceCompatibility({ ...descriptor, serviceApiVersion: 2, minimumClientApiVersion: 2 }))
      .toThrow(/service API is incompatible/);
  });

  it.each([null, [], {}, { registrationEnabled: false }, { ...descriptor, product: 'AnotherApp' },
    { ...descriptor, serviceApiVersion: '1' }, { ...descriptor, minimumClientApiVersion: true },
    { ...descriptor, serviceApiVersion: 0 }, { ...descriptor, serviceApiVersion: 1001 },
    { ...descriptor, minimumClientApiVersion: 0 }, { ...descriptor, minimumClientApiVersion: 2 }])('rejects an invalid product or protocol descriptor %j', value => {
    expect(() => validateServiceCompatibility(value)).toThrow(/compatible TraceOmics server/);
  });

  it('uses a bounded, unauthenticated request through the provided connection transport', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      expect(url.href).toBe('https://analysis.example.org/api/service/compatibility');
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } });
      return response({ ...descriptor, internalPath: '/private/server/path' });
    });
    await expect(checkServiceCompatibility('https://analysis.example.org', { fetchImpl, now: () => 0 }))
      .resolves.toEqual({ ...descriptor, checkedAt: '1970-01-01T00:00:00.000Z' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit service upgrade for a missing legacy descriptor', async () => {
    await expect(checkServiceCompatibility('https://analysis.example.org', {
      fetchImpl: async () => response({ registrationEnabled: false }, { status: 404 }),
    })).rejects.toMatchObject({ code: 'DESKTOP_SERVICE_UPGRADE_REQUIRED' });
  });

  it.each([401, 403, 500])('does not accept an authenticated or unhealthy response (%i)', async status => {
    await expect(checkServiceCompatibility('https://analysis.example.org', {
      fetchImpl: async () => response(descriptor, { status }),
    })).rejects.toMatchObject({ code: 'DESKTOP_SERVICE_REJECTED' });
  });

  it('rejects an HTML login response and never echoes its contents', async () => {
    const pending = checkServiceCompatibility('https://analysis.example.org', {
      fetchImpl: async () => new Response('<html>private-cookie-or-login</html>', { headers: { 'Content-Type': 'text/html' } }),
    });
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_SERVICE_INVALID' });
    await expect(pending).rejects.not.toThrow(/private-cookie/);
  });

  it('cancels a pending descriptor fetch when connection settings close', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const pending = checkServiceCompatibility('https://analysis.example.org', { fetchImpl, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'DESKTOP_CONNECTION_CANCELLED' });
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('retains the overall deadline even when the transport ignores abort', async () => {
    await expect(checkServiceCompatibility('https://analysis.example.org', {
      timeoutMs: 15, fetchImpl: () => new Promise(() => {}),
    })).rejects.toMatchObject({ code: 'DESKTOP_SERVICE_TIMEOUT' });
  });

  it('keeps TLS rejection separate from service reachability', async () => {
    await expect(checkServiceCompatibility('https://analysis.example.org', {
      fetchImpl: async () => { throw Object.assign(new Error('Certificate rejected.'), { code: 'DESKTOP_TLS_REJECTED' }); },
    })).rejects.toMatchObject({ code: 'DESKTOP_TLS_REJECTED' });
  });
});
