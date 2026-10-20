import { usePlotGeometry, categoryTickAngle, categoryPlotWidth } from '../hooks/usePlotGeometry';
import PageHeader from '../components/PageHeader';
import React, { useState, useEffect, useCallback } from 'react';
import Plot, { getPlotHoverStyle } from '../components/Plot';
import { Grid3x3, AlertTriangle, ImageDown } from 'lucide-react';
import FigureSavePanel from '../components/FigureSavePanel';
import { publicErrorMessage } from '../publicError';

// Removed API constant
export default function HeatmapPlot({ datasetInfo, pipelineState, sessionReady, userEmail, objectId, callApi, theme, deploymentPolicy }) {
  const [heatmapData, setHeatmapData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [topN, setTopN] = useState(5);
  const chart = usePlotGeometry();
  const [savePanelOpen, setSavePanelOpen] = useState(false);
  const plotConfig = React.useMemo(() => ({ responsive: true, displayModeBar: true, displaylogo: false }), []);

  const hasDeg = pipelineState?.cluster;

  const fetchHeatmap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callApi(`/heatmap?top_n=${topN}`, {}, { useCache: false });
      if (data.error) throw new Error(data.error);
      setHeatmapData(data);
    } catch (e) {
      setError(publicErrorMessage(e, 'The marker heatmap could not be prepared. Please try again.'));
    }
    setLoading(false);
  }, [callApi, topN]);

  useEffect(() => {
    if (sessionReady && hasDeg) fetchHeatmap();
  }, [sessionReady, hasDeg, fetchHeatmap]);

  const trace = React.useMemo(() => heatmapData ? [{
    type: 'heatmap',
    z: heatmapData.z,
    x: heatmapData.clusters,
    y: heatmapData.genes,
    colorscale: 'Viridis',
    hovertemplate: '<b>%{y}</b><br>Cluster: %{x}<br>Average expression: %{z:.2f}<extra></extra>',
    colorbar: { thickness: 14, orientation: 'h', yref: 'container', y: 0.015, xref: 'container', x: 0.5, xanchor: 'center', yanchor: 'bottom', len: 0.7, title: { text: 'Average expression', side: 'bottom' } },
  }] : [], [heatmapData]);

  const isDark = theme === 'dark';
  const plotText = isDark ? '#94a3b8' : '#475569';
  const plotGrid = isDark ? '#1e293b' : '#d8e0ea';
  const layout = React.useMemo(() => ({
    autosize: true,
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: plotText, size: 12, family: 'Inter, system-ui' },
    hoverlabel: getPlotHoverStyle(theme),
    margin: { l: 58, r: 12, t: 24, b: 120 },
    xaxis: { title: { text: 'Cluster' }, automargin: true, type: 'category', tickangle: categoryTickAngle(heatmapData?.clusters || [], Math.max(chart.width, categoryPlotWidth(heatmapData?.genes, heatmapData?.clusters)) - 100), gridcolor: plotGrid },
    yaxis: { title: { text: 'Gene' }, automargin: true, gridcolor: plotGrid },
  }), [plotText, plotGrid, theme, heatmapData, chart.width]);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <Grid3x3 size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted">Load a dataset in the Workspace first.</p>
        </div>
      </div>
    );
  }

  if (!hasDeg) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-text mb-2">Clustering Required</h2>
          <p className="text-textMuted">Run Clustering first to generate marker gene heatmaps.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-y-auto custom-scrollbar">
      <PageHeader title="Marker Heatmap" description="Average expression of top marker genes per cluster." className="px-4 sm:px-8 pt-6 pb-4 border-b border-border" actions={
<div className="flex flex-wrap items-center gap-3">
          <label htmlFor="heatmap-top-n" className="text-xs text-textMuted font-bold uppercase tracking-wide">Top N per cluster</label>
          <input
            id="heatmap-top-n"
            type="number"
            min={1} max={20}
            value={topN}
            onChange={e => setTopN(parseInt(e.target.value) || 5)}
            className="w-16 bg-surface border border-border text-text text-sm px-2 py-1.5 rounded focus:outline-none focus:border-primary"
          />
          <button onClick={fetchHeatmap} disabled={loading} className="btn btn-primary text-sm px-4 py-2">
            {loading ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4 inline-block" /> : 'Refresh'}
          </button>
          {heatmapData && (
            <button onClick={() => setSavePanelOpen(true)} className="btn btn-ghost border border-border text-sm px-3 py-2 text-primary hover:bg-primary/10 flex items-center gap-1.5">
              <ImageDown size={14} /> Save Figure
            </button>
          )}
        </div>
      } />

      {error && (
        <div className="mx-8 mt-4 p-3 bg-danger/10 border border-danger/30 rounded-lg text-danger text-sm flex items-center gap-2 shrink-0">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {heatmapData && categoryPlotWidth(heatmapData.genes, heatmapData.clusters) > chart.width - 48 && <p role="note" className="mx-4 sm:mx-6 mt-3 text-xs text-textMuted">Scroll horizontally to inspect all clusters; hover a cell for its values.</p>}

      <div ref={chart.ref} className="min-w-0 p-3 sm:p-6 overflow-x-auto" style={{ flex: '1 0 auto', minHeight: Math.max(380, Math.min(1000, (Array.isArray(heatmapData?.genes) ? heatmapData.genes.length : heatmapData?.genes ? 1 : 3) * 28 + (chart.compact ? 180 : 120))) }}>
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-slate-400">
              <span className="animate-spin border-2 border-primary border-t-transparent rounded-full w-8 h-8 inline-block mb-3" />
              <p className="text-sm">Computing marker genes…</p>
            </div>
          </div>
        ) : heatmapData ? (
          <Plot
            data={trace}
            layout={layout}
            config={plotConfig}
            style={{ width: '100%', minWidth: categoryPlotWidth(heatmapData?.genes, heatmapData?.clusters), height: '100%' }}
            useResizeHandler
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-slate-400">
              <Grid3x3 size={48} className="mx-auto mb-4 opacity-30" />
              <p className="text-sm">Click Refresh to generate the heatmap.</p>
            </div>
          </div>
        )}
      </div>
      <FigureSavePanel
        isOpen={savePanelOpen}
        onClose={() => setSavePanelOpen(false)}
        plotType="Heatmap"
        baseParams={{ features: [], groupBy: 'seurat_clusters', top_n: topN }}
        userEmail={userEmail || ''}
        objectId={objectId || ''}
        deploymentPolicy={deploymentPolicy}
      />
    </div>
  );
}
