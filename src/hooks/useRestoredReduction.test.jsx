import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRestoredReduction } from './useRestoredReduction';

const busy = { error: 'R service is busy. Please retry shortly.' };

describe('useRestoredReduction', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps retrying a briefly fenced shared R slot for several seconds before reporting busy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    const callApi = vi.fn(async () => {
      calls += 1;
      return calls <= 5 ? busy : { result: { exists: true, n_cells: 10 } };
    });
    const onResult = vi.fn();
    const { result } = renderHook(() => useRestoredReduction({
      callApi, reduction: 'umap', contextKey: 'k', enabled: true, onResult,
    }));
    await vi.advanceTimersByTimeAsync(6000);
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(callApi).toHaveBeenCalledTimes(6);
    expect(result.current.error).toBeNull();
  });

  it('reports busy once the retry window is exhausted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const callApi = vi.fn(async () => busy);
    const { result } = renderHook(() => useRestoredReduction({
      callApi, reduction: 'umap', contextKey: 'k', enabled: true,
    }));
    await vi.advanceTimersByTimeAsync(15000);
    await waitFor(() => expect(result.current.error).toMatch(/busy/i));
    expect(callApi).toHaveBeenCalledTimes(8);
  });
});
