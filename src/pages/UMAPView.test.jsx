import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { plotRenderSpy, supportsWebGLMock } = vi.hoisted(() => ({
  plotRenderSpy: vi.fn(),
  supportsWebGLMock: vi.fn(),
}));

vi.mock('../components/Plot', () => ({
  default: ({ data = [], layout }) => {
    plotRenderSpy(data, layout);
    return <div data-testid="plot-stub" />;
  },
  supportsWebGL: supportsWebGLMock,
  getPlotHoverStyle: theme => ({ theme }),
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

  it('shows the cluster identity without coordinates or Plotly trace boxes', async () => {
    render(<UMAPView {...baseProps()} />);
    await screen.findByRole('button', { name: /Re-compute UMAP/i });

    const [trace] = plotRenderSpy.mock.calls.at(-1)[0];
    expect(trace.hovertemplate).toBe('<b>%{fullData.name}</b><extra></extra>');
    expect(trace.hovertemplate).not.toMatch(/%\{[xyz]\}/i);
    expect(trace.hoverlabel).toEqual({ theme: 'light' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('uses edited UMAP parameters and marks a successful run as recomputable', async () => {
    const callApi = vi.fn(async (_endpoint, _payload) => (
      _endpoint.startsWith('/reduction-results') ? { result: { exists: false } } : resultPayload()
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

  it('preserves an in-progress decimal minimum distance while it is edited', async () => {
    const callApi = vi.fn(async () => resultPayload());
    render(<UMAPView {...baseProps({ callApi })} />);
    await screen.findByRole('button', { name: /Re-compute UMAP/i });
    callApi.mockClear();

    const minDist = screen.getByLabelText(/Minimum Distance/i);
    const run = screen.getByRole('button', { name: /Re-compute UMAP/i });
    fireEvent.change(minDist, { target: { value: '' } });
    expect(minDist.value).toBe('');
    expect(minDist).toHaveAttribute('aria-invalid', 'true');
    expect(run).toBeDisabled();

    fireEvent.change(minDist, { target: { value: '0' } });
    expect(minDist.value).toBe('0');
    expect(run).toBeEnabled();
    fireEvent.change(minDist, { target: { value: '0.3' } });
    expect(minDist.value).toBe('0.3');
    fireEvent.change(minDist, { target: { value: '0.35' } });
    expect(minDist.value).toBe('0.35');
    expect(run).toBeEnabled();

    fireEvent.click(run);
    await waitFor(() => expect(callApi.mock.calls.some(([path]) => path.includes('min_dist=0.35'))).toBe(true));
  });

  it.each([1, 2])('runs UMAP with %i input PCs, two neighbors, and zero minimum distance', async dims => {
    const callApi = vi.fn(async path => path.startsWith('/reduction-results')
      ? { result: { exists: false } } : resultPayload());
    render(<UMAPView {...baseProps({ callApi })} />);
    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));
    callApi.mockClear();
    fireEvent.change(screen.getByLabelText(/Input Dimensions/), { target: { value: String(dims) } });
    fireEvent.change(screen.getByLabelText(/Number of Neighbors/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/Minimum Distance/), { target: { value: '0' } });
    const run = screen.getByRole('button', { name: /Run 2D UMAP/i });
    expect(run).toBeEnabled();
    fireEvent.click(run);
    await waitFor(() => expect(callApi).toHaveBeenCalledWith(
      `/umap?dims=${dims}&n_components=2&n_neighbors=2&min_dist=0&seed=seed-1`,
      expect.any(Object), expect.objectContaining({
        cacheParams: expect.objectContaining({ dims, n_neighbors: 2, min_dist: 0 }),
      }),
    ));
  });

  it('keeps restored two-PC, two-neighbor, zero-distance settings valid and unchanged', async () => {
    const callApi = vi.fn(async () => ({ result: { ...resultPayload().result, exists: true,
      restored: true, n_components: 2, settings: { dims: 2, n_neighbors: 2, min_dist: 0, seed: 42 } } }));
    render(<UMAPView {...baseProps({ callApi })} />);
    await screen.findByText(/Showing the saved UMAP result/);
    expect(screen.getByLabelText(/Minimum Distance/)).toHaveValue(0);
    expect(screen.getByLabelText(/Minimum Distance/)).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('button', { name: /Re-compute UMAP/i })).toBeEnabled();
    expect(screen.queryByText(/Showing a previous calculation/)).not.toBeInTheDocument();
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('does not offer figure saving before a UMAP result exists', async () => {
    const callApi = vi.fn(async () => ({}));
    render(<UMAPView {...baseProps({ callApi })} />);
    await waitFor(() => expect(callApi).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Save Figure/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('plot-stub')).not.toBeInTheDocument();
  });

  it('retries short shared-compute contention and then renders the result', async () => {
    const callApi = vi.fn(async (_endpoint, _payload) => {
      if (_endpoint.startsWith('/reduction-results')) return { result: { exists: false } };
      const explicitCalls = callApi.mock.calls.filter(([endpoint]) => !endpoint.startsWith('/reduction-results')).length;
      return explicitCalls === 1
        ? { error: 'Analysis compute is busy. Wait a moment and try again.' }
        : resultPayload();
    });
    render(<UMAPView {...baseProps({ callApi })} />);
    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));

    const run = screen.getByRole('button', { name: /Run 2D UMAP/i });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    await waitFor(() => {
      const explicitCalls = callApi.mock.calls.filter(([endpoint]) => !endpoint.startsWith('/reduction-results'));
      expect(explicitCalls).toHaveLength(2);
    }, { timeout: 2_000 });
    expect(await screen.findByRole('button', { name: /Re-compute UMAP/i })).toBeInTheDocument();
  });

  it('does not invent provenance parents when an attached session has no local history', async () => {
    const callApi = vi.fn(async (_endpoint, _payload) => (
      _endpoint.startsWith('/reduction-results') ? { result: { exists: false } } : resultPayload()
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

  it('keeps the 3D control available when WebGL is supported', async () => {
    const props = baseProps();
    render(<UMAPView {...props} />);

    expect(screen.getByRole('button', { name: '3D' })).toBeEnabled();
    expect(screen.queryByText(/This renderer supports the 2D view only/i)).not.toBeInTheDocument();
    await waitFor(() => expect(props.callApi).toHaveBeenCalled());
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

  it('preserves returned coordinates and uses equal axis units', async () => {
    render(<UMAPView {...baseProps()} />);
    await waitFor(() => expect(plotRenderSpy).toHaveBeenCalledWith(
      [expect.objectContaining({ x: [1, 2], y: [3, 4] })],
      expect.objectContaining({ yaxis: expect.objectContaining({ scaleanchor: 'x', scaleratio: 1 }) }),
    ));
    expect(screen.getByText('Cell groups')).toBeInTheDocument();
  });

  it('uses the public PBMC tutorial defaults and does not describe it as synthetic', async () => {
    const callApi = vi.fn(async () => resultPayload());
    render(<UMAPView {...baseProps({ callApi, activeProjectSeed: '',
      datasetInfo: { cells:2638, source:'pbmc3k_demo' }, deploymentPolicy:{demoMode:true} })} />);
    expect(screen.getByRole('note')).toHaveTextContent('measured gene expression');
    expect(screen.getByRole('note')).not.toHaveTextContent('simulated');
    await waitFor(() => expect(callApi).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Re-compute UMAP/i }));
    await waitFor(() => expect(callApi.mock.calls.some(([path]) => path.includes('dims=10') && path.includes('seed=42'))).toBe(true));
  });

  it('discloses simulated input and distinguishes edited settings from the plotted calculation', async () => {
    render(<UMAPView {...baseProps({ deploymentPolicy: { demoMode: true } })} />);
    expect(screen.getByRole('note')).toHaveTextContent('800 simulated cells');
    await screen.findByRole('button', { name: /Re-compute UMAP/i });
    fireEvent.change(screen.getByLabelText(/Number of Neighbors/i), { target: { value: '42' } });
    expect(screen.getByRole('status')).toHaveTextContent('Showing a previous calculation');
    expect(screen.queryByRole('button', { name: /Save Figure/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Re-compute UMAP/i }));
    await waitFor(() => expect(screen.queryByText(/Showing a previous calculation/)).not.toBeInTheDocument());
  });
  it('reads an existing reduction in a new browser session without a computation or invented provenance', async () => {
    const callApi = vi.fn(async () => ({ result: { ...resultPayload().result, exists: true,
      restored: true, n_components: 2, settings: { dims: 10, n_neighbors: 20, min_dist: 0.25, seed: 42 } } }));
    render(<UMAPView {...baseProps({ callApi })} />);
    await screen.findByText(/Showing the saved UMAP result/);
    expect(screen.getByText('Original computation settings').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Original computation settings'));
    expect(screen.getByText('Original computation settings').parentElement).toHaveTextContent('Input PCs: 10. Neighbors: 20. Minimum distance: 0.25. Seed: 42.');
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi).toHaveBeenCalledWith('/reduction-results?reduction=umap', expect.any(Object), { useCache: false });
    expect(screen.getByLabelText(/Input Dimensions/)).toHaveValue(10);
    expect(screen.getByLabelText(/Number of Neighbors/)).toHaveValue(20);
    expect(screen.getByLabelText(/Minimum Distance/)).toHaveValue(0.25);
    expect(screen.queryByRole('button', { name: /View recorded analysis/ })).not.toBeInTheDocument();
    expect(plotRenderSpy.mock.calls.flatMap(([data]) => data).some(trace => trace.x?.[0] === 1)).toBe(true);
    expect(screen.queryByText(/Showing a previous calculation/)).not.toBeInTheDocument();
  });

  it('reports a missing reduction without computing a replacement', async () => {
    const callApi = vi.fn(async () => ({ result: { exists: false } }));
    render(<UMAPView {...baseProps({ callApi })} />);
    await screen.findByText(/No UMAP reduction is present/);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('plot-stub')).not.toBeInTheDocument();
  });

  it('discards a slow reduction response after switching objects', async () => {
    let resolveOld;
    const oldRequest = new Promise(resolve => { resolveOld = resolve; });
    const callApi = vi.fn().mockReturnValueOnce(oldRequest).mockResolvedValue({ result: { exists: false } });
    const props = baseProps({ callApi });
    const { rerender } = render(<UMAPView {...props} />);
    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));
    rerender(<UMAPView {...props} objectId="ao_other" rSessionId="sess-2" />);
    await screen.findByText(/No UMAP reduction is present/);
    resolveOld(resultPayload());
    await waitFor(() => expect(screen.queryByText('Cluster 0')).not.toBeInTheDocument());
    expect(screen.queryByTestId('plot-stub')).not.toBeInTheDocument();
  });

  it('preserves a saved 3D embedding as an explicit 2D projection without WebGL', async () => {
    supportsWebGLMock.mockReturnValue(false);
    const callApi = vi.fn(async () => ({ result: { exists: true, restored: true, n_components: 3,
      trace_data: [{ name: 'Cluster 0', x: [1], y: [2], z: [3] }], settings: {} } }));
    render(<UMAPView {...baseProps({ callApi })} />);
    await screen.findByText(/first two coordinates of the saved 3D embedding/);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(plotRenderSpy.mock.calls.flatMap(([data]) => data).some(trace => trace.type === 'scatter3d')).toBe(false);
  });

  it('can inspect an existing UMAP after its input PCA is absent', async () => {
    const callApi = vi.fn(async () => ({ result: { ...resultPayload().result, exists: true,
      restored: true, n_components: 2, settings: {} } }));
    render(<UMAPView {...baseProps({ callApi, pipelineState: { pca: false, umap: true } })} />);
    await screen.findByText(/Showing the saved UMAP result/);
    expect(screen.getByRole('button', { name: /Re-compute UMAP/ })).toBeDisabled();
    expect(callApi).toHaveBeenCalledTimes(1);
  });

});
