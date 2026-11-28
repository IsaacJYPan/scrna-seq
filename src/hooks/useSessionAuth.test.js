import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSessionAuth } from './useSessionAuth';

afterEach(() => {
  delete window.electronAPI;
});

describe('useSessionAuth', () => {
  it('resolves immediately when there is no session to restore', () => {
    const { result } = renderHook(() => useSessionAuth());
    expect(result.current.authResolution).toBe('resolved');
    expect(result.current.user).toBeNull();
  });

  it('checks the server session before resolving the signed-in user', async () => {
    const restored = { id: 3, email: 'a@lab.edu' };
    window.electronAPI = { restoreSession: vi.fn(async () => restored) };
    const { result } = renderHook(() => useSessionAuth());
    expect(result.current.authResolution).toBe('checking');
    await waitFor(() => expect(result.current.authResolution).toBe('resolved'));
    expect(result.current.user).toBe(restored);
  });

  it('reports an outage as retryable without signing the user out', async () => {
    const restored = { id: 4, email: 'b@lab.edu' };
    window.electronAPI = {
      restoreSession: vi.fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(restored),
    };
    const { result } = renderHook(() => useSessionAuth());
    await waitFor(() => expect(result.current.authResolution).toBe('error'));
    expect(result.current.user).toBeNull();

    act(() => result.current.retryAuth());
    await waitFor(() => expect(result.current.authResolution).toBe('resolved'));
    expect(result.current.user).toBe(restored);
    expect(window.electronAPI.restoreSession).toHaveBeenCalledTimes(2);
  });
});
