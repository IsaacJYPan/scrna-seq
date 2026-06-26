import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { electronAPI, apiUrl } from './api';

describe('apiUrl (VITE_API_BASE_URL resolution)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadApiUrlWith(envValue) {
    if (envValue === undefined) {
      vi.stubEnv('VITE_API_BASE_URL', '');
    } else {
      vi.stubEnv('VITE_API_BASE_URL', envValue);
    }
    vi.resetModules();
    const mod = await import('./api');
    return mod.apiUrl;
  }

  it('returns a same-origin relative path when the env is empty', async () => {
    const url = await loadApiUrlWith('');
    expect(url('/api/auth/login')).toBe('/api/auth/login');
  });

  it('prefixes an absolute base with no trailing slash', async () => {
    const url = await loadApiUrlWith('https://example.com');
    expect(url('/api/auth/login')).toBe('https://example.com/api/auth/login');
  });

  it('strips a trailing slash on the base to avoid double slashes', async () => {
    const url = await loadApiUrlWith('https://example.com/');
    expect(url('/api/auth/login')).toBe('https://example.com/api/auth/login');
  });

  it('normalizes a path that is missing a leading slash', async () => {
    const url = await loadApiUrlWith('https://example.com');
    expect(url('api/db/figures')).toBe('https://example.com/api/db/figures');
  });

  it('is importable as a named export from the live module', () => {
    expect(typeof apiUrl).toBe('function');
  });
});

describe('API Client (electronAPI)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should handle 200 OK JSON responses properly', async () => {
    const mockResponse = { data: 'test-success' };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockResponse,
    });

    const result = await electronAPI.apiRequest('/test-endpoint');
    expect(result).toEqual(mockResponse);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/r/test-endpoint'),
      expect.any(Object)
    );
  });

  it('should handle 400/500 Error JSON responses properly', async () => {
    const mockErrorResponse = { error: 'Backend Exception: file not found' };
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockErrorResponse,
      text: async () => JSON.stringify(mockErrorResponse),
    });

    const result = await electronAPI.apiRequest('/test-error');
    
    // The requirement is that electronAPI returns the parsed error object
    // { error: "Backend Exception: file not found" } instead of throwing an unhandled exception.
    expect(result).toHaveProperty('error');
    expect(result.error).toBe('Backend Exception: file not found');
  });

  it('should handle 400/500 Error text responses properly', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'Plain text error message',
    });

    const result = await electronAPI.apiRequest('/test-error-text');

    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Plain text error message');
  });

  it('routes db methods to their expected endpoint path (same-origin default)', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    });

    await electronAPI.getFigures();
    expect(global.fetch).toHaveBeenCalledWith('/api/db/figures', expect.any(Object));
  });
});
