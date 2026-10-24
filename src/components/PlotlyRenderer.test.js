import { afterEach, expect, it, vi } from 'vitest';
import Plotly from './plotlyRuntime';
import { downloadPlotImage } from './PlotlyRenderer';

vi.mock('./plotlyRuntime', () => ({ default: { downloadImage: vi.fn(), toImage: vi.fn() } }));
vi.mock('react-plotly.js/factory', () => ({ default: vi.fn(() => () => null) }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

it('preserves the existing unguarded Plotly export contract', async () => {
  const graph = {}, options = { format: 'png', filename: 'original', width: 1000 };
  Plotly.downloadImage.mockResolvedValueOnce('original export');
  expect(await downloadPlotImage(graph, options)).toBe('original export');
  expect(Plotly.downloadImage).toHaveBeenCalledExactlyOnceWith(graph, options);
  expect(Plotly.toImage).not.toHaveBeenCalled();
});

it('does not even render an export when current retained-view access was already lost', async () => {
  await downloadPlotImage({}, { format: 'png' }, () => false);
  expect(Plotly.toImage).not.toHaveBeenCalled();
});

it('does not start a download when access is lost during Plotly image conversion', async () => {
  let finish, allowed = true;
  Plotly.toImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const exporting = downloadPlotImage({}, { format: 'png', filename: 'retained' }, () => allowed);
  expect(Plotly.toImage).toHaveBeenCalledOnce(); allowed = false; finish('data:image/png;base64,aGVsbG8='); await exporting;
  expect(click).not.toHaveBeenCalled(); expect(document.querySelector('a[download]')).toBeNull();
  expect(Plotly.downloadImage).not.toHaveBeenCalled();
});

it('downloads only the completed current retained image and removes its temporary anchor', async () => {
  Plotly.toImage.mockResolvedValueOnce('data:image/png;base64,aGVsbG8=');
  let downloaded;
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloaded = { href: this.href, name: this.download, connected: this.isConnected }; });
  const graph = {};
  await downloadPlotImage(graph, { format: 'png', filename: 'retained-points', width: 1000, height: 700 }, () => true);
  expect(Plotly.toImage).toHaveBeenCalledExactlyOnceWith(graph, { format: 'png', width: 1000, height: 700 });
  expect(click).toHaveBeenCalledOnce(); expect(downloaded).toEqual({ href: 'data:image/png;base64,aGVsbG8=', name: 'retained-points.png', connected: true });
  expect(document.querySelector('a[download]')).toBeNull();
});
