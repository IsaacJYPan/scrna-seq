import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { electronAPI } from './api';

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
});
