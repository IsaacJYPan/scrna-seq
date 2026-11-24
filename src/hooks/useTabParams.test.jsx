import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTabParams, carryTabParams } from './useTabParams';

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

describe('carryTabParams', () => {
  it('copies every step setting to the saved version without overwriting its own', () => {
    localStorage.clear();
    localStorage.setItem('traceomics_params_deg_a_b_c_ao_1', JSON.stringify({ minPct: 0.25 }));
    localStorage.setItem('traceomics_params_cluster_a_b_c_ao_1', JSON.stringify({ resolution: 0.5 }));
    localStorage.setItem('traceomics_params_cluster_a_b_c_ao_2', JSON.stringify({ resolution: 1.2 }));
    localStorage.setItem('traceomics_params_cluster_other_ao_1', JSON.stringify({ resolution: 9 }));
    expect(carryTabParams('a.b@c', 'ao_1', 'ao_2')).toBe(1);
    expect(JSON.parse(localStorage.getItem('traceomics_params_deg_a_b_c_ao_2'))).toEqual({ minPct: 0.25 });
    expect(JSON.parse(localStorage.getItem('traceomics_params_cluster_a_b_c_ao_2'))).toEqual({ resolution: 1.2 });
    expect(carryTabParams('a.b@c', 'ao_1', 'ao_1')).toBe(0);
  });
});
