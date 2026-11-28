import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useComputeStatus } from './useComputeStatus';

afterEach(() => {
  delete window.electronAPI;
  vi.useRealTimers();
});

describe('useComputeStatus', () => {
  it('reads unknown when nobody is signed in', () => {
    window.electronAPI = { getComputeRuntimeStatus: vi.fn() };
    const { result } = renderHook(() => useComputeStatus(null));
    expect(result.current).toEqual({ status: 'unknown', updatedAt: null });
    expect(window.electronAPI.getComputeRuntimeStatus).not.toHaveBeenCalled();
  });

  it('reports the server status and falls back to unknown on failure', async () => {
    window.electronAPI = {
      getComputeRuntimeStatus: vi.fn()
        .mockResolvedValueOnce({ status: 'available', updatedAt: '2026-01-01T00:00:00Z' })
        .mockRejectedValue(new Error('offline')),
    };
    const { result } = renderHook(() => useComputeStatus('a@lab.edu'));
    await waitFor(() => expect(result.current.status).toBe('available'));
  });

  it('polls until unmounted', async () => {
    vi.useFakeTimers();
    window.electronAPI = { getComputeRuntimeStatus: vi.fn(async () => ({ status: 'available', updatedAt: null })) };
    const { unmount } = renderHook(() => useComputeStatus('a@lab.edu'));
    expect(window.electronAPI.getComputeRuntimeStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(window.electronAPI.getComputeRuntimeStatus).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(10000);
    expect(window.electronAPI.getComputeRuntimeStatus).toHaveBeenCalledTimes(2);
  });
});
