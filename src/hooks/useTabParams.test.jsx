import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTabParams } from './useTabParams';

describe('useTabParams', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps its field updater stable while state changes', () => {
    const { result, rerender } = renderHook(
      ({ objectId }) => useTabParams('qc', 'owner@example.com', objectId, { threshold: 1 }),
      { initialProps: { objectId: 'ao_one' } }
    );
    const initialUpdater = result.current[1];

    act(() => initialUpdater('threshold', 2));
    expect(result.current[0].threshold).toBe(2);

    rerender({ objectId: 'ao_one' });
    expect(result.current[1]).toBe(initialUpdater);
  });

  it('reloads persisted values when the analysis scope changes', async () => {
    localStorage.setItem(
      'traceomics_params_qc_owner_example_com_ao_two',
      JSON.stringify({ threshold: 7 })
    );
    const { result, rerender } = renderHook(
      ({ objectId }) => useTabParams('qc', 'owner@example.com', objectId, { threshold: 1 }),
      { initialProps: { objectId: 'ao_one' } }
    );

    rerender({ objectId: 'ao_two' });
    await waitFor(() => expect(result.current[0].threshold).toBe(7));
  });
});
