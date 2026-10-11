import React from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const { plotSpy } = vi.hoisted(() => ({ plotSpy: vi.fn() }));
vi.mock('../components/Plot', () => ({ default: props => { plotSpy(props); return <div data-testid="heatmap-plot" />; },
  getPlotHoverStyle: theme => ({ theme }) }));
vi.mock('../components/FigureSavePanel', () => ({ default: () => null }));

import HeatmapPlot from './HeatmapPlot';

it('labels a heatmap cell with its gene, cluster, and average expression', async () => {
  const callApi = vi.fn(async () => ({ genes: ['CD3E'], clusters: ['0'], z: [[1.234]] }));
  render(<HeatmapPlot datasetInfo={{ id: 'ao_heatmap' }} pipelineState={{ cluster: true }} sessionReady callApi={callApi} theme="dark" />);

  await screen.findByTestId('heatmap-plot');
  const plot = plotSpy.mock.calls.at(-1)[0];
  expect(plot.data[0].hovertemplate).toBe('<b>%{y}</b><br>Cluster: %{x}<br>Average expression: %{z:.2f}<extra></extra>');
  expect(plot.layout.hoverlabel).toEqual({ theme: 'dark' });
});
