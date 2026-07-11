import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-plotly.js', () => ({
  default: () => <div data-testid="plot-stub" />,
}));

vi.mock('../components/FigureSavePanel', () => ({
  default: () => null,
}));

import UMAPView from './UMAPView';

function resultPayload() {
  return {
    result: {
      trace_data: [
        { name: 'Cluster 0', x: [1, 2], y: [3, 4] },
      ],
    },
    provenance: { id: 'prov_umap' },
  };
}

function baseProps(overrides = {}) {
  return {
    callApi: vi.fn(async () => resultPayload()),
    datasetInfo: { id: 'ao_umap123', name: 'PBMC 3k', cells: 2700 },
    pcaProvId: 'prov_pca',
    clusterProvId: 'prov_cluster',
    openProvenance: vi.fn(),
    pipelineState: { pca: true, cluster: true },
    rSessionId: 'sess-1',
    sessionReady: true,
    userEmail: 'umap-user@example.com',
    objectId: 'ao_umap123',
    currentWs: { annotations: {} },
    activeProjectSeed: 'seed-1',
    theme: 'light',
    ...overrides,
  };
}

describe('UMAPView', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses edited UMAP parameters and marks a successful run as recomputable', async () => {
    const callApi = vi.fn(async (_endpoint, _payload, context) => (
      context?.onlyIfCached ? {} : resultPayload()
    ));
    render(<UMAPView {...baseProps({ callApi })} />);

    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));
    callApi.mockClear();

    fireEvent.change(screen.getByLabelText(/Number of Neighbors/i), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText(/Minimum Distance/i), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Run 2D UMAP/i }));

    await waitFor(() => {
      expect(callApi).toHaveBeenCalledWith(
        expect.stringContaining('n_neighbors=42'),
        expect.any(Object),
        expect.any(Object),
      );
    });
    expect(callApi.mock.calls[0][0]).toContain('min_dist=0.5');

    expect(await screen.findByRole('button', { name: /Re-compute UMAP/i })).toBeInTheDocument();
    expect(screen.getByText('Cluster 0')).toBeInTheDocument();
  });

  it('does not offer figure saving before a UMAP result exists', async () => {
    const callApi = vi.fn(async () => ({}));
    render(<UMAPView {...baseProps({ callApi })} />);
    await waitFor(() => expect(callApi).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Save Figure/i })).not.toBeInTheDocument();
  });
});
