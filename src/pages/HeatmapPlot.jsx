import React, { useState, useEffect, useCallback } from 'react';
import Plot from '../components/Plot';
import { Grid3x3, AlertTriangle, ImageDown } from 'lucide-react';
import FigureSavePanel from '../components/FigureSavePanel';
import { publicErrorMessage } from '../publicError';

// Removed API constant
export default function HeatmapPlot({ datasetInfo, pipelineState, sessionReady, userEmail, objectId, callApi, theme, deploymentPolicy }) {
  const [heatmapData, setHeatmapData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [topN, setTopN] = useState(5);
  const [savePanelOpen, setSavePanelOpen] = useState(false);

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

  const trace = heatmapData ? [{
    type: 'heatmap',
    z: heatmapData.z,
    x: heatmapData.clusters,
    y: heatmapData.genes,
    colorscale: 'Viridis',
    hovertemplate: '<b>Gene:</b> %{y}<br><b>Cluster:</b> %{x}<br><b>Avg Expr:</b> %{z:.3f}<extra></extra>',
    colorbar: { thickness: 14, len: 0.8, title: { text: 'Avg Expr', side: 'right' } },
  }] : [];

  const isDark = theme === 'dark';
  const plotText = isDark ? '#94a3b8' : '#475569';
  const plotGrid = isDark ? '#1e293b' : '#d8e0ea';
  const layout = {
    autosize: true,
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: plotText, size: 10, family: 'Inter, system-ui' },
    margin: { l: 100, r: 60, t: 30, b: 80 },
    xaxis: { title: 'Cluster', type: 'category', tickangle: -45, gridcolor: plotGrid },
    yaxis: { title: 'Gene', automargin: true, gridcolor: plotGrid },
  };

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-y-auto custom-scrollbar">
      <div className="px-4 sm:px-8 pt-6 pb-4 border-b border-border flex flex-wrap gap-4 items-center justify-between shrink-0">
        <div>
          <h2 className="text-2xl font-bold text-text tracking-tight">Marker Heatmap</h2>
          <p className="text-textMuted text-sm">Average expression of top marker genes per cluster.</p>
        </div>
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
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 bg-danger/10 border border-danger/30 rounded-lg text-danger text-sm flex items-center gap-2 shrink-0">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      <div className="flex-1 min-h-60 min-w-0 p-3 sm:p-6 overflow-hidden">
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
            config={{ responsive: true, displayModeBar: true, displaylogo: false }}
            style={{ width: '100%', height: '100%' }}
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
