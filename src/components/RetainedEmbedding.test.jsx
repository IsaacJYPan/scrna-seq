import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RetainedEmbedding from './RetainedEmbedding';
import Plot from './Plot';
import { downloadPlotImage } from './PlotlyRenderer';

vi.mock('./Plot', () => ({ default: vi.fn(({ data, layout, style, onInitialized }) => <button style={style} onClick={event => onInitialized({}, event.currentTarget)} data-testid="plot">{JSON.stringify({ data, layout })}</button>), getPlotHoverStyle: theme => ({ theme }) }));
vi.mock('./PlotlyRenderer', () => ({ downloadPlotImage: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { document.documentElement.removeAttribute('data-theme'); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const preview = { source: { versionId: 'eri_example' }, x: [0], y: [1], ids: ['source<id>'], groups: ['group<script>'], sourceIndices: [0],
  semantics: { axes: { x: { label: 'Custom <axis>', unit: 'mm' }, y: { label: null, unit: null } } },
  sampling: { sourceCount: 1, returnedCount: 1, sampled: false, budgetLimited: false } };
it('escapes plot HTML, responds to actual theme changes and offers keyboard-reachable reset/export from retained points', async () => {
  render(<RetainedEmbedding preview={preview} pointLimit={2000} onPointLimitChange={vi.fn()} />);
  expect(screen.getByTestId('plot')).toHaveTextContent('source&lt;id&gt;');
  expect(screen.getByTestId('plot')).toHaveTextContent('Custom &lt;axis&gt; (mm)');
  expect(Plot.mock.calls.at(-1)[0].layout.legend).toMatchObject({ yanchor: 'top', y: -0.30 });
  expect(screen.getByRole('button', { name: 'Export plot PNG' })).toBeDisabled();
  fireEvent.click(screen.getByTestId('plot'));
  const previous = Plot.mock.calls.at(-1)[0].layout.uirevision;
  fireEvent.click(screen.getByRole('button', { name: 'Reset plot view' }));
  expect(Plot.mock.calls.at(-1)[0].layout.uirevision).toBe(previous + 1);
  await act(async () => document.documentElement.setAttribute('data-theme', 'dark'));
  expect(Plot.mock.calls.at(-1)[0].layout.hoverlabel).toEqual({ theme: 'dark' });
  fireEvent.click(screen.getByRole('button', { name: 'Export plot PNG' }));
  await waitFor(() => expect(downloadPlotImage).toHaveBeenCalledWith(screen.getByTestId('plot'), expect.objectContaining({ format: 'png', width: 1000, height: 700 }), expect.any(Function)));
});

it('preserves Plotly data/layout/config and graph identity through ready/export toolbar state changes', async () => {
  let finish;
  downloadPlotImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<RetainedEmbedding preview={preview} pointLimit={2000} onPointLimitChange={vi.fn()} />);
  const initial = Plot.mock.calls.at(-1)[0], graph = screen.getByTestId('plot');
  // Model the mutable layout object retained by the actual renderer.
  initial.layout.xaxis.range = [-10, 15];
  fireEvent.click(graph);
  const ready = Plot.mock.calls.at(-1)[0];
  expect(ready.layout).toBe(initial.layout); expect(ready.data).toBe(initial.data); expect(ready.config).toBe(initial.config);
  expect(ready.layout.xaxis.range).toEqual([-10, 15]); expect(screen.getByTestId('plot')).toBe(graph);
  fireEvent.click(screen.getByRole('button', { name: 'Export plot PNG' }));
  await waitFor(() => expect(downloadPlotImage).toHaveBeenCalled());
  expect(Plot.mock.calls.at(-1)[0].layout).toBe(initial.layout);
  await act(async () => finish());
  expect(Plot.mock.calls.at(-1)[0].layout).toBe(initial.layout); expect(screen.getByTestId('plot')).toBe(graph);
});

it('shows declared entity meaning separately from version-scoped identifiers and leaves unknown entities explicit', () => {
  const view = render(<RetainedEmbedding preview={{ ...preview, semantics: { ...preview.semantics, entityType: 'sample' } }} pointLimit={2000} onPointLimitChange={vi.fn()} />);
  expect(screen.getByText(/Points represent samples/)).toHaveTextContent('Source identifiers belong to this exact saved version.');
  view.rerender(<RetainedEmbedding preview={preview} pointLimit={2000} onPointLimitChange={vi.fn()} />);
  expect(screen.getByText(/Point entity type is not declared/)).toBeVisible();
});

it('keeps local zoom/reset/export over fixed retained points without offering a new source point-limit request', async () => {
  const onPointLimitChange = vi.fn(), points = { ...preview, sampling: { sourceCount: 50, returnedCount: 1, sampled: true, budgetLimited: true } };
  render(<RetainedEmbedding preview={points} fixedView pointLimit={2000} onPointLimitChange={onPointLimitChange} />);
  expect(screen.queryByRole('combobox', { name: 'Maximum points' })).not.toBeInTheDocument();
  expect(screen.getByText('Showing 1 of 50 source points.')).toBeVisible();
  expect(screen.getByText(/Deterministic checksum-bound sample/)).toHaveTextContent('Fewer points fit within the response byte limit.');
  const graph = screen.getByTestId('plot'); fireEvent.click(graph);
  const before = Plot.mock.calls.at(-1)[0], retainedData = before.data; before.layout.xaxis.range = [-10, 10];
  fireEvent.click(screen.getByRole('button', { name: 'Export plot PNG' }));
  await waitFor(() => expect(downloadPlotImage).toHaveBeenCalledExactlyOnceWith(graph, expect.objectContaining({ format: 'png' }), expect.any(Function)));
  expect(Plot.mock.calls.at(-1)[0].data).toBe(retainedData); expect(Plot.mock.calls.at(-1)[0].layout.xaxis.range).toEqual([-10, 10]);
  const revision = Plot.mock.calls.at(-1)[0].layout.uirevision; fireEvent.click(screen.getByRole('button', { name: 'Reset plot view' }));
  expect(Plot.mock.calls.at(-1)[0].layout.uirevision).toBe(revision + 1); expect(Plot.mock.calls.at(-1)[0].data).toBe(retainedData);
  expect(onPointLimitChange).not.toHaveBeenCalled();
});

it('preserves the source point-limit selector by default and removes it when switching to a fixed view', () => {
  const onPointLimitChange = vi.fn(), view = render(<RetainedEmbedding preview={preview} pointLimit={2000} onPointLimitChange={onPointLimitChange} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Maximum points' }), { target: { value: '500' } });
  expect(onPointLimitChange).toHaveBeenCalledExactlyOnceWith(500);
  view.rerender(<RetainedEmbedding preview={preview} fixedView pointLimit={2000} onPointLimitChange={onPointLimitChange} />);
  expect(screen.queryByRole('combobox', { name: 'Maximum points' })).not.toBeInTheDocument();
});

it('discloses the fixed requested bound, byte reduction and non-stratified group limits without offering resampling', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const value = { ...preview, sampling: { sourceCount: 100, returnedCount: 1, requestedLimit: 5, sampled: true, budgetLimited: true } };
  render(<RetainedEmbedding preview={value} fixedView />);
  expect(screen.getByLabelText('Fixed retained point bound')).toHaveTextContent('Maximum included points: 5.');
  expect(screen.getByLabelText('Fixed retained point bound')).toHaveTextContent('PNG export contains only these retained points');
  expect(screen.getByText(/no stratification or aggregation/)).toHaveTextContent('Groups absent from this sample may still exist in the source.');
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument(); expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('keeps absent identifiers as explicit zero-based source positions with unknown axis/entity meaning', () => {
  render(<RetainedEmbedding fixedView preview={{ ...preview, ids: null, groups: undefined, sourceIndices: [9],
    semantics: { entityType: null, axes: { x: { label: null, unit: null }, y: { label: null, unit: null } } } }} />);
  expect(screen.getByTestId('plot')).toHaveTextContent('Source row 9 (zero-based)');
  expect(screen.getByText(/Point entity type is not declared/)).toBeVisible();
  expect(screen.getByText(/not cell identifiers/)).toBeVisible();
  expect(Plot.mock.calls.at(-1)[0].layout.showlegend).toBe(false);
  expect(Plot.mock.calls.at(-1)[0].layout.xaxis.title.text).toBe('Coordinate 1');
});

it.each(['unmounted', 'different retained points', 'theme changed'])('invalidates an in-progress retained export when %s', async change => {
  let finish;
  downloadPlotImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RetainedEmbedding preview={preview} fixedView />); fireEvent.click(screen.getByTestId('plot'));
  fireEvent.click(screen.getByRole('button', { name: 'Export plot PNG' }));
  await waitFor(() => expect(downloadPlotImage).toHaveBeenCalledOnce());
  const current = downloadPlotImage.mock.calls[0][2]; expect(current()).toBe(true);
  if (change === 'unmounted') view.unmount();
  else if (change === 'different retained points') view.rerender(<RetainedEmbedding preview={{ ...preview, x: [99] }} fixedView />);
  else await act(async () => document.documentElement.setAttribute('data-theme', 'dark'));
  expect(current()).toBe(false); await act(async () => finish());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not call the lazy plot export helper after its view unmounts before the import resolves', async () => {
  const view = render(<RetainedEmbedding preview={preview} fixedView />); fireEvent.click(screen.getByTestId('plot'));
  fireEvent.click(screen.getByRole('button', { name: 'Export plot PNG' })); view.unmount();
  await act(async () => {}); expect(downloadPlotImage).not.toHaveBeenCalled();
});

it.each([false, true])('keeps the graph DOM height bounded when autosizing clears Plotly layout height (fixed view: %s)', fixedView => {
  const view = render(<RetainedEmbedding preview={preview} fixedView={fixedView} pointLimit={2000} onPointLimitChange={vi.fn()} />);
  const graph = screen.getByTestId('plot'), initial = Plot.mock.calls.at(-1)[0];
  expect(graph).toHaveStyle({ width: '100%', height: '400px' });
  // Plotly resize clears mutable layout dimensions; its absolute SVG needs a DOM height.
  delete initial.layout.height; fireEvent.click(graph);
  view.rerender(<RetainedEmbedding preview={preview} fixedView={fixedView} pointLimit={2000} onPointLimitChange={vi.fn()} />);
  expect(screen.getByTestId('plot')).toBe(graph); expect(graph).toHaveStyle({ height: '400px' });
  expect(Plot.mock.calls.at(-1)[0].layout).toBe(initial.layout); expect(Plot.mock.calls.at(-1)[0].data).toBe(initial.data);
});
