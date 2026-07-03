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

  it('clears auth and session localStorage so a reload remains logged out', async () => {
    localStorage.setItem('benchone_auth_token', 'token-123');
    localStorage.setItem('benchone_auth_user', JSON.stringify({ email: 'user@example.com' }));
    localStorage.setItem('benchone_auth_extra', 'stale');
    localStorage.setItem('benchone_session_id', 'session-123');
    localStorage.setItem('client_id', 'client-123');
    localStorage.setItem('benchone_ws_user@example.com', 'workspace-state');

    expect(electronAPI.getCurrentUser()).toEqual({ email: 'user@example.com' });

    await electronAPI.logout();

    expect(localStorage.getItem('benchone_auth_token')).toBeNull();
    expect(localStorage.getItem('benchone_auth_user')).toBeNull();
    expect(localStorage.getItem('benchone_auth_extra')).toBeNull();
    expect(localStorage.getItem('benchone_session_id')).toBeNull();
    expect(localStorage.getItem('client_id')).toBeNull();
    expect(localStorage.getItem('benchone_ws_user@example.com')).toBe('workspace-state');

    vi.resetModules();
    const reloaded = await import('./api');
    expect(reloaded.electronAPI.getCurrentUser()).toBeNull();
  });

  it('restores auth state from the HttpOnly cookie session (not localStorage bearer)', async () => {
    const sessionUser = { id: 7, email: 'restored@example.com', displayName: 'Restored' };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ user: sessionUser, authVia: 'cookie' }),
    });

    const result = await electronAPI.restoreSession();

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(result).toEqual(sessionUser);
    // Cached for the next synchronous bootstrap.
    expect(electronAPI.getCurrentUser()).toEqual(sessionUser);
  });

  it('sends the legacy bearer during restore for compatibility while cookies remain preferred by the backend', async () => {
    localStorage.setItem('benchone_auth_token', 'legacy-token');
    const sessionUser = { id: 8, email: 'cookie@example.com', displayName: 'Cookie' };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ user: sessionUser, authVia: 'cookie' }),
    });

    const result = await electronAPI.restoreSession();

    expect(result).toEqual(sessionUser);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ Authorization: 'Bearer legacy-token' })
      })
    );
  });

  it('clears stale auth keys when the server rejects restore (401)', async () => {
    localStorage.setItem('benchone_auth_token', 'stale-token');
    localStorage.setItem('benchone_auth_user', JSON.stringify({ email: 'stale@example.com' }));
    localStorage.setItem('benchone_auth_extra', 'stale-extra');
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'Authentication required' }),
    });

    const result = await electronAPI.restoreSession();

    expect(result).toBeNull();
    expect(localStorage.getItem('benchone_auth_token')).toBeNull();
    expect(localStorage.getItem('benchone_auth_user')).toBeNull();
    expect(localStorage.getItem('benchone_auth_extra')).toBeNull();
  });

  it('does not treat cached localStorage auth as truth when session restore cannot reach the backend', async () => {
    localStorage.setItem('benchone_auth_token', 'stale-token');
    localStorage.setItem('benchone_auth_user', JSON.stringify({ email: 'offline@example.com' }));
    global.fetch.mockRejectedValue(new Error('network down'));

    const result = await electronAPI.restoreSession();

    expect(result).toBeNull();
    expect(localStorage.getItem('benchone_auth_token')).toBe('stale-token');
    expect(electronAPI.getCurrentUser()).toEqual({ email: 'offline@example.com' });
  });

  it('reads runtime diagnostics from the backend instead of hardcoded R strings', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        supportedTarget: 'R 4.5.x',
        rscript: { path: 'Rscript', source: 'PATH' },
        runtime: { status: 'ok', rVersion: '4.6.0' },
        packages: { Seurat: true, CellChat: false }
      }),
    });

    const result = await electronAPI.checkREnv();

    expect(global.fetch).toHaveBeenCalledWith('/api/runtime/diagnostics', expect.any(Object));
    expect(result.version).toBe('R 4.6.0');
    expect(result.version).not.toBe('R 4.5.1');
    expect(result.supportedTarget).toBe('R 4.5.x');
    expect(result.rscriptPath).toBe('Rscript');
    expect(result.rscriptSource).toBe('PATH');
    expect(result.packages).toMatchObject({ Seurat: true, CellChat: false });
  });
});
