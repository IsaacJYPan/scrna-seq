import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { plotlyReact } = vi.hoisted(() => ({ plotlyReact: vi.fn() }));
// Use the production React/Plotly wrappers and factory; replace only the
// expensive drawing engine so assertions count actual Plotly.react requests.
vi.mock('../components/plotlyRuntime', () => ({ default: {
  react: plotlyReact,
  purge: vi.fn(),
  Plots: { resize: vi.fn(async () => {}) },
} }));
vi.mock('../components/FigureSavePanel', () => ({ default: () => null }));

import FeaturePlot from './FeaturePlot';
import DotPlot from './DotPlot';
import HeatmapPlot from './HeatmapPlot';

beforeEach(() => {
  plotlyReact.mockReset();
  plotlyReact.mockImplementation(async (element, figure) => {
    element.data = figure.data;
    element.layout = figure.layout;
    element.on = vi.fn();
    element.removeListener = vi.fn();
    return element;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settlePlot() {
  // The factory chains drawing promises; flush them before counting renders.
  await act(async () => {});
}

it('keeps the feature plot unchanged while typing or opening export, but redraws its palette and new data', async () => {
  const firstResult = { u1: [1, 2], u2: [3, 4], expression: [0, 5] };
  const secondResult = { u1: [1, 2], u2: [3, 4], expression: [7, 0] };
  const callApi = vi.fn(async path => path === '/genes'
    ? { genes: ['CD3E', 'MS4A1'] }
    : path.includes('MS4A1') ? secondResult : firstResult);
  render(<FeaturePlot datasetInfo={{ id: 'ao_feature' }} pipelineState={{ umap: true }}
    sessionReady callApi={callApi} theme="light" />);
  await waitFor(() => expect(callApi).toHaveBeenCalledWith('/genes', {}, { useCache: false }));
  const input = screen.getByRole('textbox', { name: 'Feature plot gene symbol' });
  fireEvent.change(input, { target: { value: 'CD3E' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plot', exact: true }));
  await waitFor(() => expect(plotlyReact).toHaveBeenCalled());
  await settlePlot();
  const initialDraws = plotlyReact.mock.calls.length;
  const initialFigure = plotlyReact.mock.calls.at(-1)[1];
  expect(initialFigure.data[0]).toEqual(expect.objectContaining({
    type: 'scatter', x: firstResult.u1, y: firstResult.u2,
    marker: expect.objectContaining({ color: firstResult.expression, colorscale: 'Blues', reversescale: true }),
    hovertemplate: '<b>CD3E</b><br>Expression: %{marker.color:.2f}<extra></extra>',
  }));

  fireEvent.change(input, { target: { value: 'MS' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Figure' }));
  await settlePlot();
  expect(plotlyReact).toHaveBeenCalledTimes(initialDraws);

  fireEvent.click(screen.getByRole('button', { name: 'Dark', exact: true }));
  await waitFor(() => expect(plotlyReact).toHaveBeenCalledTimes(initialDraws + 1));
  const darkFigure = plotlyReact.mock.calls.at(-1)[1];
  expect(darkFigure.data[0].marker.color).toBe(firstResult.expression);
  expect(darkFigure.data[0].marker.reversescale).toBe(false);
  expect(darkFigure.layout.paper_bgcolor).toBe('#0e1626');

  // Plotly writes zoom ranges into the supplied layout. Editing the input
  // keeps that view, but requesting a new plot must get fresh autoranged axes.
  for (const axis of [darkFigure.layout.xaxis, darkFigure.layout.yaxis]) {
    axis.range = [1.25, 1.5];
    axis.autorange = false;
  }

  fireEvent.change(input, { target: { value: 'MS4A1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plot', exact: true }));
  await waitFor(() => expect(plotlyReact.mock.calls.at(-1)[1].data[0].marker.color).toBe(secondResult.expression));
  expect(plotlyReact.mock.calls.at(-1)[1].data[0].hovertemplate).toContain('MS4A1');
  const nextLayout = plotlyReact.mock.calls.at(-1)[1].layout;
  expect(nextLayout).not.toBe(darkFigure.layout);
  for (const axis of [nextLayout.xaxis, nextLayout.yaxis]) {
    expect(axis).not.toHaveProperty('range');
    expect(axis).not.toHaveProperty('autorange', false);
  }
  expect(callApi.mock.calls.map(([path]) => path)).toEqual(['/genes', '/feature-values?gene=CD3E', '/feature-values?gene=MS4A1']);
});

it('keeps every dot value unchanged while editing pending genes or opening export, but redraws for new results and theme', async () => {
  const firstResult = { genes: ['CD3E', 'MS4A1'], clusters: ['0', '1'],
    avg_expr: [[1, 2], [3, 0]], pct_expr: [[0.5, 1], [0.25, 0]] };
  const secondResult = { genes: ['CD3E'], clusters: ['0', '1'], avg_expr: [8, 9], pct_expr: [0, 0.75] };
  const callApi = vi.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
  const props = { datasetInfo: { id: 'ao_dot' }, pipelineState: { cluster: true }, callApi, theme: 'light' };
  const { rerender } = render(<DotPlot {...props} />);
  const input = screen.getByRole('textbox', { name: 'Add gene to dot plot' });
  for (const gene of firstResult.genes) {
    fireEvent.change(input, { target: { value: gene } });
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
  }
  fireEvent.click(screen.getByRole('button', { name: 'Plot', exact: true }));
  await waitFor(() => expect(plotlyReact).toHaveBeenCalled());
  await settlePlot();
  const initialDraws = plotlyReact.mock.calls.length;
  const initialFigure = plotlyReact.mock.calls.at(-1)[1];
  expect(initialFigure.data[0]).toEqual(expect.objectContaining({
    type: 'scatter', x: ['0', '1', '0', '1'], y: ['CD3E', 'CD3E', 'MS4A1', 'MS4A1'],
    customdata: [50, 100, 25, 0],
    marker: expect.objectContaining({ color: [1, 2, 3, 0], size: [14, 28, 7, 4] }),
  }));

  fireEvent.change(input, { target: { value: 'LYZ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Figure' }));
  await settlePlot();
  expect(plotlyReact).toHaveBeenCalledTimes(initialDraws);

  rerender(<DotPlot {...props} theme="dark" />);
  await waitFor(() => expect(plotlyReact).toHaveBeenCalledTimes(initialDraws + 1));
  const darkFigure = plotlyReact.mock.calls.at(-1)[1];
  expect(darkFigure.data[0].customdata).toEqual(initialFigure.data[0].customdata);
  expect(darkFigure.data[0].marker.colorbar.tickfont.color).toBe('#94a3b8');
  expect(darkFigure.layout.font.color).toBe('#94a3b8');

  fireEvent.click(screen.getByRole('button', { name: 'Plot', exact: true }));
  await waitFor(() => expect(plotlyReact.mock.calls.at(-1)[1].data[0].marker.color).toEqual([8, 9]));
  expect(plotlyReact.mock.calls.at(-1)[1].data[0].customdata).toEqual([0, 75]);
  expect(callApi).toHaveBeenCalledTimes(2);
});

it('does not redraw a heatmap when opening export, while theme and refresh still update the plot', async () => {
  const firstResult = { genes: ['CD3E', 'MS4A1'], clusters: ['0', '1'], z: [[1.234, 0], [0, 5]] };
  const secondResult = { ...firstResult, z: [[9, 0], [0, 8]] };
  const callApi = vi.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
  const props = { datasetInfo: { id: 'ao_heatmap' }, pipelineState: { cluster: true }, sessionReady: true, callApi, theme: 'light' };
  const { rerender } = render(<HeatmapPlot {...props} />);
  await waitFor(() => expect(plotlyReact).toHaveBeenCalled());
  await settlePlot();
  const initialDraws = plotlyReact.mock.calls.length;
  const initialFigure = plotlyReact.mock.calls.at(-1)[1];
  expect(initialFigure.data[0]).toEqual(expect.objectContaining({
    type: 'heatmap', x: firstResult.clusters, y: firstResult.genes, z: firstResult.z,
    colorscale: 'Viridis',
    hovertemplate: '<b>%{y}</b><br>Cluster: %{x}<br>Average expression: %{z:.2f}<extra></extra>',
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Figure' }));
  await settlePlot();
  expect(plotlyReact).toHaveBeenCalledTimes(initialDraws);

  rerender(<HeatmapPlot {...props} theme="dark" />);
  await waitFor(() => expect(plotlyReact).toHaveBeenCalledTimes(initialDraws + 1));
  const darkFigure = plotlyReact.mock.calls.at(-1)[1];
  expect(darkFigure.data).toBe(initialFigure.data);
  expect(darkFigure.layout.font.color).toBe('#94a3b8');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(plotlyReact.mock.calls.at(-1)[1].data[0].z).toBe(secondResult.z));
  expect(callApi.mock.calls.map(([path]) => path)).toEqual(['/heatmap?top_n=5', '/heatmap?top_n=5']);
});

it.each([['dot', DotPlot], ['heatmap', HeatmapPlot]])('updates the %s plot layout when its container width changes', async (name, Page) => {
  let containerWidth = 1000;
  const observers = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: containerWidth }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() {}
  });
  const result = { genes: ['CD3E'], clusters: ['Long cluster 0', 'Long cluster 1', 'Long cluster 2', 'Long cluster 3'],
    avg_expr: [1, 2, 3, 4], pct_expr: [0, 0.25, 0.5, 1], z: [[1, 2, 3, 4]] };
  const callApi = vi.fn(async () => result);
  render(React.createElement(Page, { datasetInfo: { id: 'ao_geometry' }, pipelineState: { cluster: true },
    sessionReady: name === 'heatmap', callApi, theme: 'light' }));
  if (name === 'dot') {
    fireEvent.change(screen.getByRole('textbox', { name: 'Add gene to dot plot' }), { target: { value: 'CD3E' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Plot', exact: true }));
  }
  await waitFor(() => expect(plotlyReact).toHaveBeenCalled());
  await settlePlot();
  const initialDraws = plotlyReact.mock.calls.length;
  const [graph, figure] = plotlyReact.mock.calls.at(-1);
  expect(figure.layout.xaxis.tickangle).toBe(0);
  const geometryObserver = observers.find(observer => observer.element !== graph && observer.element?.contains(graph));
  expect(geometryObserver).toBeDefined();
  containerWidth = 320;
  act(() => geometryObserver.callback());
  await waitFor(() => expect(plotlyReact).toHaveBeenCalledTimes(initialDraws + 1));
  const resizedFigure = plotlyReact.mock.calls.at(-1)[1];
  expect(resizedFigure.layout.xaxis.tickangle).toBe(-45);
  expect(resizedFigure.data).toBe(figure.data);
  expect(callApi).toHaveBeenCalledTimes(1);
});

it.each([
  ['feature', FeaturePlot, 'umap'],
  ['dot', DotPlot, 'cluster'],
  ['heatmap', HeatmapPlot, 'cluster'],
])('keeps %s prerequisite transitions usable after memoizing the plot', async (name, Page, prerequisite) => {
  const callApi = vi.fn(async path => path === '/genes' ? { genes: ['CD3E'] }
    : { genes: ['CD3E'], clusters: ['0'], avg_expr: [1], pct_expr: [0.5], z: [[1]], u1: [0], u2: [1], expression: [2] });
  const { rerender } = render(<Page datasetInfo={null} pipelineState={{}} callApi={callApi} />);
  expect(screen.getByText('No Dataset Loaded')).toBeInTheDocument();
  const datasetInfo = { id: 'ao_transition' };
  rerender(<Page datasetInfo={datasetInfo} pipelineState={{}} callApi={callApi} />);
  expect(screen.getByText(name === 'feature' ? 'UMAP Required' : 'Clustering Required')).toBeInTheDocument();
  rerender(<Page datasetInfo={datasetInfo} pipelineState={{ [prerequisite]: true }} sessionReady callApi={callApi} />);
  if (name !== 'heatmap') {
    await waitFor(() => expect(callApi).toHaveBeenCalledWith('/genes', {}, { useCache: false }));
    fireEvent.change(screen.getByRole('textbox', { name: name === 'feature' ? 'Feature plot gene symbol' : 'Add gene to dot plot' }),
      { target: { value: 'CD3E' } });
    if (name === 'dot') fireEvent.click(screen.getByRole('button', { name: 'Add', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Plot', exact: true }));
  }
  await waitFor(() => expect(plotlyReact).toHaveBeenCalled());
});
