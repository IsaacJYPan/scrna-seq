import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('../components/Plot', async () => {
  const React = await import('react');
  return { default: ({ layout }) => React.createElement('div', {
    'data-testid': 'plot-stub',
    'data-paper-background': layout.paper_bgcolor,
    'data-plot-background': layout.plot_bgcolor,
    'data-axis-text': layout.xaxis.tickfont.color,
    'data-hover-text': layout.hoverlabel.font.color,
    'data-hover-background': layout.hoverlabel.bgcolor,
  }) };
});
vi.mock('../components/FigureSavePanel', () => ({ default: () => null }));
import FeaturePlot from './FeaturePlot';

it('plots an exact typed gene and reports an unknown gene', async () => {
  const callApi = vi.fn(async path => path === '/genes'
    ? { genes: ['CD3E'] }
    : { u1: [1], u2: [2], expression: [3] });
  render(<FeaturePlot datasetInfo={{ id: 'ao_1' }} pipelineState={{ umap: true }} sessionReady userEmail="u@example.com" objectId="ao_1" callApi={callApi} />);
  await waitFor(() => expect(callApi).toHaveBeenCalledWith('/genes', expect.anything(), expect.anything()));
  const input = screen.getByPlaceholderText(/Gene symbol/i);
  fireEvent.change(input, { target: { value: 'CD3E' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plot' }));
  await waitFor(() => expect(callApi).toHaveBeenCalledWith('/feature-values?gene=CD3E', expect.anything(), expect.anything()));
  fireEvent.change(input, { target: { value: 'NOT_A_GENE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plot' }));
  expect(screen.getByText(/NOT_A_GENE.*not found/i)).toBeInTheDocument();
});

it('keeps the chart palette readable when its local dark mode is selected', async () => {
  const callApi = vi.fn(async path => path === '/genes'
    ? { genes: ['CD3E'] }
    : { u1: [1], u2: [2], expression: [3] });
  render(<FeaturePlot datasetInfo={{ id: 'ao_1' }} pipelineState={{ umap: true }} sessionReady userEmail="u@example.com" objectId="ao_1" callApi={callApi} theme="dark" />);
  await waitFor(() => expect(callApi).toHaveBeenCalledWith('/genes', expect.anything(), expect.anything()));
  fireEvent.change(screen.getByPlaceholderText(/Gene symbol/i), { target: { value: 'CD3E' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plot' }));

  const plot = await screen.findByTestId('plot-stub');
  expect(plot).toHaveAttribute('data-paper-background', '#0e1626');
  expect(plot).toHaveAttribute('data-plot-background', '#0e1626');
  expect(plot).toHaveAttribute('data-axis-text', '#9fb0c9');
  expect(plot).toHaveAttribute('data-hover-text', '#f1f5f9');
  expect(plot).toHaveAttribute('data-hover-background', '#182236');

  fireEvent.click(screen.getByRole('button', { name: 'Light' }));
  expect(plot).toHaveAttribute('data-paper-background', '#ffffff');
  expect(plot).toHaveAttribute('data-axis-text', '#475569');
});

it('keeps page context and navigates to UMAP while enforcing the prerequisite', () => {
  const callApi = vi.fn();
  const onNavigateToUmap = vi.fn();
  render(<FeaturePlot datasetInfo={{ id: 'ao_1' }} pipelineState={{ umap: false }} callApi={callApi} onNavigateToUmap={onNavigateToUmap} />);
  expect(screen.getByRole('heading', { name: 'Feature Plot' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Go to UMAP' }));
  expect(onNavigateToUmap).toHaveBeenCalledOnce();
  expect(callApi).not.toHaveBeenCalled();
  expect(screen.queryByTestId('plot-stub')).not.toBeInTheDocument();
});
