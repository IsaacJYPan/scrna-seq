import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const { plotSpy } = vi.hoisted(() => ({ plotSpy: vi.fn() }));
vi.mock('../components/Plot', () => ({ default: props => { plotSpy(props); return <div data-testid="plot-stub" />; },
  getPlotHoverStyle: theme => ({ theme }) }));
vi.mock('../components/FigureSavePanel', () => ({ default: () => null }));
import GeneViewer from './GeneViewer';

it('uses the shared UMAP prerequisite instead of rendering blank FeaturePlot axes', async () => {
  const callApi = vi.fn(async () => ({
    gene: 'CD3E', expression: [1, 2], clusters: ['0', '1'],
  }));
  render(<GeneViewer datasetInfo={{ id: 'ao_1' }} pipelineState={{ umap: false }} callApi={callApi} />);

  fireEvent.click(screen.getByRole('button', { name: 'CD3E' }));
  fireEvent.click(await screen.findByRole('button', { name: /FeaturePlot/i }));

  expect(screen.getByText('UMAP Required')).toBeInTheDocument();
  expect(screen.getByText(/Run UMAP in the Standard scRNA-seq workflow/i)).toBeInTheDocument();
  expect(screen.queryByTestId('plot-stub')).not.toBeInTheDocument();
});

it('offers UMAP navigation without losing the selected gene or requesting a computation', async () => {
  const onNavigateToUmap = vi.fn();
  const callApi = vi.fn(async () => ({ gene: 'CD3E', expression: [1, 2], clusters: ['0', '1'] }));
  render(<GeneViewer datasetInfo={{ id: 'ao_1' }} pipelineState={{ umap: false }} callApi={callApi} onNavigateToUmap={onNavigateToUmap} />);
  fireEvent.click(screen.getByRole('button', { name: 'CD3E' }));
  fireEvent.click(await screen.findByRole('button', { name: /FeaturePlot/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Go to UMAP' }));
  expect(onNavigateToUmap).toHaveBeenCalledOnce();
  expect(screen.getByRole('textbox', { name: 'Search gene by symbol' })).toHaveValue('CD3E');
  expect(callApi).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /VlnPlot/i }));
  expect(screen.getByTestId('plot-stub')).toBeInTheDocument();
});

it('can collapse and reopen marker browsing without clearing the search', () => {
  render(<GeneViewer datasetInfo={{ id: 'ao_1' }} pipelineState={{}} callApi={vi.fn()} />);
  const search = screen.getByRole('textbox', { name: 'Search gene by symbol' });
  fireEvent.change(search, { target: { value: 'LYZ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Browse categories' }));
  expect(screen.getByRole('button', { name: 'Hide categories' })).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Hide categories' }));
  expect(search).toHaveValue('LYZ');
});

it('uses concise expression tooltips for violin and UMAP feature views', async () => {
  const callApi = vi.fn(async () => ({
    gene: 'CD3E', expression: [1.25, 2], clusters: ['0', '1'],
    u1: [0.2, 0.4], u2: [0.5, 0.7],
  }));
  render(<GeneViewer datasetInfo={{ id: 'ao_1' }} pipelineState={{ umap: true }} callApi={callApi} theme="dark" />);
  fireEvent.click(screen.getByRole('button', { name: 'CD3E' }));
  await screen.findByRole('button', { name: /FeaturePlot/i });

  expect(plotSpy.mock.calls.at(-1)[0].data[0].hovertemplate).toBe('<b>Cluster 0</b><br>Expression: %{y:.2f}<extra></extra>');
  expect(plotSpy.mock.calls.at(-1)[0].layout.hoverlabel).toEqual({ theme: 'dark' });

  fireEvent.click(screen.getByRole('button', { name: /FeaturePlot/i }));
  expect(plotSpy.mock.calls.at(-1)[0].data[0].hovertemplate).toBe('<b>CD3E</b><br>Expression: %{marker.color:.2f}<extra></extra>');
});
