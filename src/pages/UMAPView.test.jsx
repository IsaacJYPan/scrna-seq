import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { plotRenderSpy, supportsWebGLMock } = vi.hoisted(() => ({
  plotRenderSpy: vi.fn(),
  supportsWebGLMock: vi.fn(),
}));

vi.mock('../components/Plot', () => ({
  default: ({ data = [] }) => {
    plotRenderSpy(data);
    return <div data-testid="plot-stub" />;
  },
  supportsWebGL: supportsWebGLMock,
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
    plotRenderSpy.mockClear();
    supportsWebGLMock.mockReset();
    supportsWebGLMock.mockReturnValue(true);
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

  it('does not invent provenance parents when an attached session has no local history', async () => {
    const callApi = vi.fn(async (_endpoint, _payload, context) => (
      context?.onlyIfCached ? {} : resultPayload()
    ));
    render(<UMAPView {...baseProps({ callApi, pcaProvId: undefined, clusterProvId: undefined })} />);

    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));
    callApi.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Run 2D UMAP/i }));

    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));
    expect(callApi.mock.calls[0][2].parentIds).toEqual([]);
    expect(await screen.findByRole('button', { name: /Re-compute UMAP/i })).toBeInTheDocument();
  });

  it('keeps a renderer without WebGL in the usable 2D mode', async () => {
    supportsWebGLMock.mockReturnValue(false);
    const paramKey = 'traceomics_params_umap_umap_user_example_com_ao_umap123';
    localStorage.setItem(paramKey, JSON.stringify({ nComponents: 3, nNeighbors: 30, minDist: 0.3 }));
    const callApi = vi.fn(async () => resultPayload());

    render(<UMAPView {...baseProps({ callApi })} />);

    expect(screen.getByRole('button', { name: '3D' })).toBeDisabled();
    expect(screen.getByText(/3D UMAP requires WebGL\. This renderer supports the 2D view only\./i)).toBeInTheDocument();

    await waitFor(() => expect(callApi).toHaveBeenCalled());
    expect(callApi.mock.calls.every(([path]) => !String(path).includes('n_components=3'))).toBe(true);
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(paramKey)).nComponents).toBe(2);
    });
    expect(plotRenderSpy.mock.calls.flatMap(([data]) => data).some(trace => trace.type === 'scatter3d')).toBe(false);
  });

  it('keeps the 3D control available when WebGL is supported', () => {
    render(<UMAPView {...baseProps()} />);

    expect(screen.getByRole('button', { name: '3D' })).toBeEnabled();
    expect(screen.queryByText(/This renderer supports the 2D view only/i)).not.toBeInTheDocument();
  });

  it('uses the portable SVG trace for an ordinary-sized 2D UMAP', async () => {
    render(<UMAPView {...baseProps()} />);

    await waitFor(() => {
      expect(plotRenderSpy.mock.calls.flatMap(([data]) => data)
        .some(trace => trace.type === 'scatter' && trace.x?.length === 2)).toBe(true);
    });
    expect(plotRenderSpy.mock.calls.flatMap(([data]) => data)
      .some(trace => trace.type === 'scattergl')).toBe(false);
  });
});
