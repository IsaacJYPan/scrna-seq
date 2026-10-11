import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { plotSpy } = vi.hoisted(() => ({ plotSpy: vi.fn() }));
vi.mock('../components/Plot', () => ({ default: props => {
  plotSpy(props);
  return <div data-testid="pca-plot" />;
}, getPlotHoverStyle: theme => ({ theme }) }));
import PCA from './PCA';

const savedPca = () => ({ result: { exists: true, restored: true, npcs: 10,
  stdevs: [4, 3, 2, 1], gene_loadings: { PC1: ['GENE1', 'GENE2'] },
  settings: { npcs: 10, seed: 42 },
  trace_data: [{ name: 'Cluster 0', x: [1, 2], y: [3, 4] }] } });
const props = overrides => ({ callApi: vi.fn(async () => savedPca()),
  datasetInfo: { id: 'ao_pca', cells: 100 }, pipelineState: { normalize: true, pca: true },
  rSessionId: 'session-1', sessionReady: true, userEmail: 'pca@example.com', objectId: 'ao_pca',
  openProvenance: vi.fn(), theme: 'light', ...overrides });

describe('PCA restored results', () => {
  beforeEach(() => { localStorage.clear(); plotSpy.mockClear(); });

  it('opens existing PCA statistics and coordinates without running PCA or fabricating provenance', async () => {
    const input = props();
    render(<PCA {...input} />);
    await screen.findByText(/Showing the saved PCA result/);
    expect(screen.getByText('Original computation settings').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Original computation settings'));
    expect(screen.getByText('Original computation settings').parentElement).toHaveTextContent('Components: 10. Seed: 42.');
    expect(screen.getByRole('note')).not.toHaveTextContent('no computation was run');
    expect(input.callApi).toHaveBeenCalledTimes(1);
    expect(input.callApi).toHaveBeenCalledWith('/reduction-results?reduction=pca', expect.any(Object), { useCache: false });
    expect(screen.queryByRole('button', { name: /View recorded analysis/ })).not.toBeInTheDocument();
    expect(plotSpy).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ y: [4, 3, 2, 1] })] }));
    expect(plotSpy.mock.calls.at(-1)[0].data[0].hovertemplate).toBe('<b>Principal component %{x}</b><br>Standard deviation: %{y:.2f}<extra></extra>');
    expect(plotSpy.mock.calls.at(-1)[0].layout.hoverlabel).toEqual({ theme: 'light' });
    expect(screen.getByText('4 principal components computed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /PC1 vs PC2/ }));
    expect(plotSpy).toHaveBeenLastCalledWith(expect.objectContaining({ data: [expect.objectContaining({ x: [1, 2], y: [3, 4], hovertemplate: '<b>%{fullData.name}</b><extra></extra>' })] }));
    fireEvent.click(screen.getByRole('button', { name: /Gene Loadings/ }));
    expect(screen.getByText('GENE1')).toBeInTheDocument();
    expect(input.callApi).toHaveBeenCalledTimes(1);
  });

  it('keeps missing PCA explicit and runs only after the researcher requests it', async () => {
    const callApi = vi.fn(async path => path.startsWith('/reduction-results')
      ? { result: { exists: false } }
      : { result: { stdevs: [1, 0.5], gene_loadings: {} }, provenance: { id: 'pca-run' } });
    render(<PCA {...props({ callApi })} />);
    await screen.findByText(/No PCA reduction is present/);
    expect(callApi).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run PCA' }));
    await screen.findByRole('button', { name: 'Re-compute PCA' });
    expect(callApi.mock.calls[1][0]).toMatch(/^\/pca\?/);
    expect(callApi.mock.calls[1][2]).toEqual(expect.objectContaining({ step: 'pca', onlyIfCached: false }));
  });

  it('keeps PCA input blank and partial while editing, then runs the entered value', async () => {
    const callApi = vi.fn(async path => path.startsWith('/reduction-results')
      ? { result: { exists: false } }
      : { result: { stdevs: [4, 3], gene_loadings: {} } });
    render(<PCA {...props({ callApi })} />);
    await screen.findByText(/No PCA reduction is present/);

    const input = screen.getByLabelText('Number of PCs');
    const run = screen.getByRole('button', { name: 'Run PCA' });
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(run).toBeDisabled();
    fireEvent.change(input, { target: { value: '3' } });
    expect(input.value).toBe('3');
    expect(run).toBeDisabled();
    fireEvent.change(input, { target: { value: '30' } });
    expect(input.value).toBe('30');
    expect(run).toBeEnabled();

    fireEvent.click(run);
    await waitFor(() => expect(callApi.mock.calls.some(([path]) => path.startsWith('/pca?npcs=30'))).toBe(true));
  });

  it('does not expose a slow saved result after the session changes', async () => {
    let resolveOld;
    const old = new Promise(resolve => { resolveOld = resolve; });
    const callApi = vi.fn().mockReturnValueOnce(old).mockResolvedValue({ result: { exists: false } });
    const input = props({ callApi });
    const { rerender } = render(<PCA {...input} />);
    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));
    rerender(<PCA {...input} objectId="ao_other" rSessionId="session-2" />);
    await screen.findByText(/No PCA reduction is present/);
    resolveOld(savedPca());
    await waitFor(() => expect(screen.queryByTestId('pca-plot')).not.toBeInTheDocument());
  });

  it('offers an explicit retry when inspection fails without requesting computation', async () => {
    const callApi = vi.fn().mockResolvedValueOnce({ error: 'The R service is unavailable.' }).mockResolvedValue(savedPca());
    render(<PCA {...props({ callApi })} />);
    fireEvent.click(await screen.findByRole('button', { name: /Retry loading result/ }));
    await screen.findByText(/Showing the saved PCA result/);
    expect(callApi.mock.calls.every(([path]) => path.startsWith('/reduction-results'))).toBe(true);
  });

  it('can inspect an existing PCA without normalized data while disabling recomputation', async () => {
    const input = props({ pipelineState: { normalize: false, pca: true } });
    render(<PCA {...input} />);
    await screen.findByText(/Showing the saved PCA result/);
    expect(screen.getByRole('button', { name: 'Re-compute PCA' })).toBeDisabled();
    expect(input.callApi).toHaveBeenCalledTimes(1);
  });
});
