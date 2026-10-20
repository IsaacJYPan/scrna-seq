import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Plot, { getPlotHoverStyle } from './Plot';

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const axisTitle = (axis, fallback) => `${axis.label || fallback}${axis.unit ? ` (${axis.unit})` : ''}`;
function usePlotTheme() {
  const read = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// This component receives a validated bounded projection. It never opens a
// source file or starts a runtime; plots and exports use these retained points.
export default function RetainedEmbedding({ preview, pointLimit, onPointLimitChange, loading }) {
  const theme = usePlotTheme(), dark = theme === 'dark';
  const [revision, setRevision] = useState(0), [ready, setReady] = useState(false), [exporting, setExporting] = useState(false), [error, setError] = useState('');
  const graph = useRef(null), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; graph.current = null; }; }, []);
  const initialized = useCallback((figure, element) => { graph.current = element; setReady(true); }, []);
  const plotFailure = useCallback(() => setError('The retained plot could not be displayed. The exact saved result remains available.'), []);
  const traces = useMemo(() => {
    const groups = new Map();
    preview.x.forEach((x, index) => {
      const group = preview.groups?.[index] ?? 'Source points';
      if (!groups.has(group)) groups.set(group, { name: escape(group), type: 'scatter', mode: 'markers', x: [], y: [], text: [], marker: { size: 5, opacity: 0.8 }, hoverinfo: 'text' });
      const trace = groups.get(group);
      trace.x.push(x); trace.y.push(preview.y[index]);
      trace.text.push(escape(preview.ids?.[index] ?? `Source row ${preview.sourceIndices[index]} (zero-based)`));
    });
    return [...groups.values()];
  }, [preview]);
  const axes = preview.semantics.axes, grouped = Boolean(preview.groups);
  // Plotly mutates its layout objects. Replacing them for a toolbar-only state
  // update can leave the displayed axes and its internal view model out of sync.
  const layout = useMemo(() => ({ autosize: true, height: 400, uirevision: revision, showlegend: grouped,
    margin: { l: 55, r: 20, t: 20, b: grouped ? 95 : 60 }, paper_bgcolor: dark ? '#111827' : '#ffffff', plot_bgcolor: dark ? '#111827' : '#ffffff',
    font: { color: dark ? '#f1f5f9' : '#334155', family: 'Inter, system-ui' }, hoverlabel: getPlotHoverStyle(theme),
    legend: { orientation: 'h', y: -0.30, yanchor: 'top' }, xaxis: { title: { text: escape(axisTitle(axes.x, 'Coordinate 1')) }, autorange: true, gridcolor: dark ? '#34445d' : '#e2e8f0' },
    yaxis: { title: { text: escape(axisTitle(axes.y, 'Coordinate 2')) }, autorange: true, gridcolor: dark ? '#34445d' : '#e2e8f0' } }), [axes, grouped, revision, dark, theme]);
  const config = useMemo(() => ({ responsive: true, displaylogo: false, modeBarButtonsToRemove: ['toImage'] }), []);
  const exportImage = async () => {
    if (!graph.current || exporting) return;
    const element = graph.current; setExporting(true); setError('');
    try {
      const { downloadPlotImage } = await import('./PlotlyRenderer');
      if (active.current && graph.current === element && element.isConnected) await downloadPlotImage(element, { format: 'png', filename: `retained-embedding-${preview.source.versionId}`, width: 1000, height: 700 });
    } catch { if (active.current) setError('The retained plot could not be exported. Try again when the figure is ready.'); }
    finally { if (active.current) setExporting(false); }
  };
  return <div className="min-w-0 space-y-3" aria-label="Retained embedding">
    <p className="text-sm">Showing {preview.sampling.returnedCount.toLocaleString()} of {preview.sampling.sourceCount.toLocaleString()} source points.</p>
    <p className="text-xs text-textMuted">{preview.sampling.sampled ? 'Deterministic checksum-bound sample; no stratification or aggregation.' : 'All source points; no sampling or aggregation.'}
      {preview.sampling.budgetLimited && ' Fewer points fit within the response byte limit.'}
      {preview.ids === null && ' Point identities are positions in this exact source version, not cell identifiers.'}</p>
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <label>Maximum points<select aria-label="Maximum points" className="input ml-2" value={pointLimit} disabled={loading} onChange={event => onPointLimitChange(Number(event.target.value))}>{[500, 1000, 2000, 5000].map(value => <option key={value} value={value}>{value.toLocaleString()}</option>)}</select></label>
      <button type="button" className="btn btn-secondary text-xs" disabled={!ready} onClick={() => setRevision(value => value + 1)}>Reset plot view</button>
      <button type="button" className="btn btn-secondary text-xs" disabled={!ready || exporting} onClick={exportImage}>{exporting ? 'Exporting retained plot…' : 'Export plot PNG'}</button>
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div role="img" aria-label={`Retained coordinate plot with ${preview.sampling.returnedCount} displayed source points`} className="min-w-0 overflow-hidden rounded border border-border">
      <Plot data={traces} layout={layout} config={config} style={{ width: '100%' }} useResizeHandler onInitialized={initialized} onError={plotFailure} />
    </div>
  </div>;
}
