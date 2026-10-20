import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RetainedEmbedding from './RetainedEmbedding';
import Plot from './Plot';
import { downloadPlotImage } from './PlotlyRenderer';

vi.mock('./Plot', () => ({ default: vi.fn(({ data, layout, onInitialized }) => <button onClick={event => onInitialized({}, event.currentTarget)} data-testid="plot">{JSON.stringify({ data, layout })}</button>), getPlotHoverStyle: theme => ({ theme }) }));
vi.mock('./PlotlyRenderer', () => ({ downloadPlotImage: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { document.documentElement.removeAttribute('data-theme'); vi.clearAllMocks(); });
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
  await waitFor(() => expect(downloadPlotImage).toHaveBeenCalledWith(screen.getByTestId('plot'), expect.objectContaining({ format: 'png', width: 1000, height: 700 })));
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
