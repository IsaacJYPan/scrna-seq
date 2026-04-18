import React, { useState, useCallback, useEffect } from 'react';
import { Layers, ListFilter, AlertTriangle } from 'lucide-react';
import Plot from 'react-plotly.js';

const CLUSTER_COLORS = ['#f8766d', '#d89000', '#a3a500', '#39b600', '#00bf7d', '#00bfc4', '#00b0f6', '#9590ff', '#e76bf3', '#ff62bc', '#ff6a6a', '#c49a00'];

function generate2DData(nClusters) {
  const traces = [];
  for (let i = 0; i < nClusters; i++) {
    const n = Math.floor(Math.random() * 180) + 80;
    const cx = (Math.random() - 0.5) * 16;
    const cy = (Math.random() - 0.5) * 16;
    traces.push({
      x: Array.from({ length: n }, () => cx + (Math.random() - 0.5) * 4),
      y: Array.from({ length: n }, () => cy + (Math.random() - 0.5) * 4),
      mode: 'markers',
      type: 'scatter',
      name: `Cluster ${i}`,
      marker: { size: 4, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 0.7 },
      hovertemplate: `<b>Cluster ${i}</b><br>UMAP1: %{x:.2f}<br>UMAP2: %{y:.2f}<extra></extra>`
    });
  }
  return traces;
}

function generate3DData(nClusters) {
  const traces = [];
  for (let i = 0; i < nClusters; i++) {
    const n = Math.floor(Math.random() * 180) + 80;
    const cx = (Math.random() - 0.5) * 16;
    const cy = (Math.random() - 0.5) * 16;
    const cz = (Math.random() - 0.5) * 16;
    traces.push({
      x: Array.from({ length: n }, () => cx + (Math.random() - 0.5) * 4),
      y: Array.from({ length: n }, () => cy + (Math.random() - 0.5) * 4),
      z: Array.from({ length: n }, () => cz + (Math.random() - 0.5) * 4),
      mode: 'markers',
      type: 'scatter3d',
      name: `Cluster ${i}`,
      marker: { size: 3, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 0.7 },
    });
  }
  return traces;
}

export default function UMAPView({ callApi, datasetInfo, currentProvId, openProvenance, pipelineState }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [plotData, setPlotData] = useState([]);
  const [error, setError] = useState(null);
  const [hasHydrated, setHasHydrated] = useState(false);

  // Parameters
  const [nComponents, setNComponents] = useState(2);
  const [nNeighbors, setNNeighbors] = useState(30);
  const [minDist, setMinDist] = useState(0.3);
  const [dims, setDims] = useState(15);

  const runUMAP = useCallback(async (isInitial = false) => {
    setRunning(true);
    setError(null);
    const data = await callApi(`/umap?dims=${dims}&n_components=${nComponents}&n_neighbors=${nNeighbors}&min_dist=${minDist}`, {}, {
      operation: 'umap',
      step: 'umap',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: true,
      cacheParams: { type: 'umap', dims, nComponents, nNeighbors, minDist },
      onlyIfCached: isInitial
    });

    if (data && data.result) {
      const traces = data.result.trace_data.map((trace, i) => ({
        x: trace.x,
        y: trace.y,
        z: trace.z,
        mode: 'markers',
        type: nComponents === 2 ? 'scatter' : 'scatter3d',
        name: trace.name,
        marker: { size: nComponents === 2 ? 4 : 3, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 1 },
        hovertemplate: `<b>${trace.name}</b><br>UMAP1: %{x:.2f}<br>UMAP2: %{y:.2f}<extra></extra>`
      }));
      setPlotData(traces);
      setResult(data);
    } else if (data && data.error && !isInitial) {
      setError(data.error);
    } else if (!data && !isInitial) {
      setError('R backend error. Check the console for details.');
    }
    setRunning(false);
  }, [callApi, currentProvId, dims, nComponents, nNeighbors, minDist, pipelineState?.clusterCount]);

  useEffect(() => {
    if (datasetInfo && pipelineState?.cluster && !result && !running && !hasHydrated) {
      setHasHydrated(true);
      runUMAP(true);
    }
  }, [datasetInfo, pipelineState?.cluster, result, running, runUMAP, hasHydrated]);

  // Reset hydration flag when callApi identity changes (i.e., when rSessionId loads)
  // so that we can retry if the first attempt was a no-op due to missing session ID.
  useEffect(() => {
    setHasHydrated(false);
  }, [callApi]);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Layers size={48} className="mx-auto text-slate-600 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  if (!pipelineState?.cluster) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Clustering Required</h2>
          <p className="text-textMuted">Complete the Clustering step before computing UMAP. UMAP colors cells by cluster identity.</p>
        </div>
      </div>
    );
  }

  const is2D = nComponents === 2;

  const layout2D = {
    autosize: true,
    margin: { l: 50, r: 20, t: 10, b: 50 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    xaxis: { title: 'UMAP 1', showgrid: false, zeroline: false },
    yaxis: { title: 'UMAP 2', showgrid: false, zeroline: false },
    showlegend: false,
    hovermode: 'closest'
  };

  const layout3D = {
    autosize: true,
    margin: { l: 0, r: 0, b: 0, t: 0 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    scene: {
      xaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      yaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      zaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      bgcolor: 'transparent'
    },
    showlegend: false
  };

  return (
    <div className="h-full w-full flex flex-col bg-background p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">UMAP Embedding</h2>
          <p className="text-textMuted">Uniform Manifold Approximation and Projection for visualization.</p>
        </div>
        <div className="flex gap-3">
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            >📝 View Step Script</button>
          )}
          <button
            onClick={() => runUMAP()}
            disabled={running}
            className={`btn ${result ? 'btn-secondary border-primary text-primary' : 'btn-primary'} flex items-center gap-2`}
          >
            {running && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {result ? 'Re-compute UMAP' : 'Run UMAP'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-4 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Parameters */}
      <div className="card p-5 mb-6 border-l-4 border-l-primary">
        <div className="grid grid-cols-4 gap-5">
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Dimensions</label>
            <div className="flex bg-slate-800 rounded-lg p-0.5 border border-border">
              <button
                onClick={() => setNComponents(2)}
                className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${nComponents === 2 ? 'bg-primary text-white shadow' : 'text-slate-500'}`}
              >2D</button>
              <button
                onClick={() => setNComponents(3)}
                className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${nComponents === 3 ? 'bg-primary text-white shadow' : 'text-slate-500'}`}
              >3D</button>
            </div>
            <p className="text-[10px] text-slate-500 mt-1">2D for publications</p>
          </div>
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">n_neighbors</label>
            <input
              type="number" value={nNeighbors} min={5} max={100}
              onChange={e => setNNeighbors(parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-500 mt-1">Local vs global structure</p>
          </div>
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">min_dist</label>
            <input
              type="number" value={minDist} min={0.01} max={1} step={0.05}
              onChange={e => setMinDist(parseFloat(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-500 mt-1">Packing density</p>
          </div>
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">PC Dims</label>
            <input
              type="number" value={dims} min={5} max={50}
              onChange={e => setDims(parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-500 mt-1">From PCA</p>
          </div>
        </div>
      </div>

      {/* Plot area */}
      <div className="flex-1 flex gap-5 min-h-0">
        <div className="flex-1 bg-surface border border-border rounded-lg relative overflow-hidden flex items-center justify-center">
          {!result && !running && (
            <div className="text-center p-8 opacity-40">
              <Layers size={48} className="mx-auto mb-4" />
              <p className="text-slate-400">Configure parameters and click "Run UMAP".</p>
            </div>
          )}

          {running && (
            <div className="text-center p-8">
              <div className="flex gap-2 justify-center mb-4">
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
              <p className="text-textMuted animate-pulse">Computing {nComponents}D UMAP...</p>
            </div>
          )}

          {result && (
            <Plot
              data={plotData}
              layout={is2D ? layout2D : layout3D}
              useResizeHandler
              className="w-full h-full"
              config={{ displayModeBar: true, displaylogo: false, responsive: true }}
            />
          )}
        </div>

        {/* Cluster legend sidebar */}
        {result && (
          <div className="w-64 flex flex-col gap-4 flex-shrink-0">
            <div className="card p-4 flex-1 flex flex-col">
              <h4 className="font-semibold border-b border-border pb-2 mb-3 text-white text-sm">
                <ListFilter size={14} className="inline text-primary mr-2" />Clusters
              </h4>
              <div className="space-y-1.5 overflow-y-auto flex-1 custom-scrollbar">
                {plotData.map((trace, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-white/5">
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: trace.marker?.color || CLUSTER_COLORS[i] }}></div>
                    <span className="text-slate-300">{trace.name}</span>
                    <span className="ml-auto text-slate-500 font-mono">{trace.x?.length}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
