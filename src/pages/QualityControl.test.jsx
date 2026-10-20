import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { plotSpy } = vi.hoisted(() => ({ plotSpy: vi.fn() }));
// The shared plot wrapper is covered separately; keep this page test focused
// on QC behavior without a real canvas in jsdom.
vi.mock('../components/Plot', () => ({
  default: props => { plotSpy(props); return <div data-testid="plot-stub" />; },
  getPlotHoverStyle: theme => ({ theme }),
}));

import QualityControl from './QualityControl';

const datasetInfo = { id: 'ao_abc123', projectId: 'proj_1', name: 'PBMC 3k', ownerUserId: 7 };

function baseProps(overrides = {}) {
  return {
    callApi: vi.fn(async () => ({ error: 'no object loaded' })),
    datasetInfo,
    currentProvId: null,
    openProvenance: vi.fn(),
    pipelineState: {},
    theme: 'dark',
    rSessionId: 'sess-1',
    userEmail: 'user@example.com',
    userId: 7,
    objectId: 'ao_abc123',
    currentWs: {
      selectedProjectId: 'proj_1',
      projects: [{ id: 'proj_1', role: 'owner' }],
    },
    sessionReady: true,
    ...overrides,
  };
}

describe('QualityControl', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the QC screen when a dataset is loaded', async () => {
    render(<QualityControl {...baseProps()} />);
    expect(await screen.findByText('Quality Control')).toBeInTheDocument();
  });

  it('uses the reference QC thresholds only for the PBMC3k tutorial', async () => {
    render(<QualityControl {...baseProps({ objectId:'ao_reference', datasetInfo:{...datasetInfo,source:'pbmc3k_demo'} })} />);
    expect(await screen.findByLabelText('Max Features')).toHaveValue(2500);
    expect(screen.getByLabelText('Min Features')).toHaveValue(200);
  });

  // Regression: hooks (usePipelineStep + the jitter useMemo calls) must run on
  // every render. If datasetInfo becomes null while the page is mounted (logout,
  // project switch, cleared selection) an early return placed before those hooks
  // would change the hook count and throw "Rendered fewer hooks than expected".
  it('does not crash when datasetInfo toggles to null on a mounted page', async () => {
    const { rerender } = render(<QualityControl {...baseProps()} />);
    await screen.findByText('Quality Control');

    expect(() => {
      rerender(<QualityControl {...baseProps({ datasetInfo: null })} />);
    }).not.toThrow();

    expect(screen.getByText('No Dataset Loaded')).toBeInTheDocument();
  });

  it('starts a new distribution request on session change and ignores the old response', async () => {
    let resolveOldSession;
    const oldSession = new Promise(resolve => { resolveOldSession = resolve; });
    const callApi = vi.fn()
      .mockReturnValueOnce(oldSession)
      .mockResolvedValue({ percent_mt: [9], nFeature_RNA: [900], nCount_RNA: [9000] });
    const props = baseProps({ callApi });
    const { rerender } = render(<QualityControl {...props} />);

    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));
    rerender(<QualityControl {...props} rSessionId="sess-2" />);
    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(plotSpy.mock.calls.at(-1)?.[0].data[1].y).toEqual([9]));

    resolveOldSession({ percent_mt: [1], nFeature_RNA: [100], nCount_RNA: [1000] });
    await waitFor(() => expect(plotSpy.mock.calls.at(-1)?.[0].data[1].y).toEqual([9]));
    expect(screen.queryByText(/Computing QC distributions/)).not.toBeInTheDocument();
  });

  it('blocks impossible filter ranges before calling the analysis endpoint', async () => {
    const callApi = vi.fn(async () => ({ percent_mt: [1], nFeature_RNA: [100], nCount_RNA: [200] }));
    render(<QualityControl {...baseProps({ callApi })} />);
    await screen.findByText('Quality Control');
    fireEvent.change(screen.getByLabelText('Min Features'), { target: { value: '6000' } });
    fireEvent.change(screen.getByLabelText('Max Features'), { target: { value: '5000' } });
    expect(screen.getByText(/Max Features must be/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply QC Filters/i })).toBeDisabled();
    expect(callApi).toHaveBeenCalledTimes(1);
  });

  it('presents viewers with read-only filtering controls', async () => {
    const callApi = vi.fn(async () => ({ percent_mt: [1], nFeature_RNA: [100], nCount_RNA: [200] }));
    render(<QualityControl {...baseProps({
      callApi,
      currentWs: { selectedProjectId: 'proj_1', projects: [{ id: 'proj_1', role: 'viewer' }] },
    })} />);

    expect(await screen.findByText(/Read-only project view/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply QC Filters/i })).toBeDisabled();
    expect(screen.getByLabelText('Max MT %')).toBeDisabled();
    expect(screen.getByText(/Detailed distributions and plots stay private/i)).toBeInTheDocument();
    expect(screen.queryByText(/QC distribution data is unavailable/i)).not.toBeInTheDocument();
    expect(callApi).not.toHaveBeenCalled();
  });

  it('hovers the visible QC cells with concise metrics and no invisible helper trace', async () => {
    const callApi = vi.fn(async () => ({ percent_mt: [1.25, 2], nFeature_RNA: [100, 250], nCount_RNA: [500, 750] }));
    render(<QualityControl {...baseProps({ callApi, theme: 'light' })} />);
    await screen.findByText('Quality Control');

    await screen.findByTestId('plot-stub');
    let plot = plotSpy.mock.calls.at(-1)[0];
    expect(plot.data).toHaveLength(2); // violin plus the visible per-cell marks
    expect(plot.data[1].y).toEqual([1.25, 2]);
    expect(plot.data[1].hovertemplate).toBe('<b>Mitochondrial RNA: %{y:.2f}%</b><extra></extra>');
    expect(plot.layout.hoverdistance).toBe(30);
    expect(plot.layout.hoverlabel).toEqual({ theme: 'light' });

    fireEvent.click(screen.getByRole('button', { name: 'Detected genes' }));
    plot = plotSpy.mock.calls.at(-1)[0];
    expect(plot.data[1].hovertemplate).toBe('<b>Genes detected: %{y:,.0f}</b><extra></extra>');

    fireEvent.click(screen.getByRole('button', { name: 'Feature Scatter' }));
    plot = plotSpy.mock.calls.at(-1)[0];
    expect(plot.data[0].hovertemplate).toBe('RNA counts: %{x:,.0f}<br>Mitochondrial RNA: %{y:.2f}%<extra></extra>');
  });

  it('keeps the QC summary compact and explains thresholds in user-facing terms', async () => {
    const callApi = vi.fn(async () => ({ percent_mt: [4.1], nFeature_RNA: [1500], nCount_RNA: [4700] }));
    render(<QualityControl {...baseProps({
      callApi,
      pipelineState: { qc: true, qcSummary: { post_filter_cells: 2300, removed_mt: 100, removed_features: 200, removed_counts: 50, median_mt: 4.2, message: 'Filtering complete.' } },
    })} />);

    expect(await screen.findByText('QC Metrics Applied')).toBeInTheDocument();
    expect(screen.getByText('2,300')).toBeInTheDocument();
    expect(screen.getByText(/Removed 100 mitochondrial · 200 gene range · 50 RNA counts/)).toBeInTheDocument();
    expect(screen.queryByText(/nFeature_RNA lower bound/)).not.toBeInTheDocument();
    expect(screen.getByText('Cells with fewer detected genes are removed')).toBeInTheDocument();
    expect(screen.getByText('Cells with fewer RNA counts are removed')).toBeInTheDocument();
  });
});
