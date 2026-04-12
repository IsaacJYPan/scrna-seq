import React, { useState, useCallback, useEffect } from 'react';
import { Network, AlertTriangle } from 'lucide-react';
import Plot from 'react-plotly.js';

export default function Clustering({ callApi, datasetInfo, currentProvId, openProvenance, pipelineState }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Parameters
  const [algorithm, setAlgorithm] = useState(1); // 4=Leiden, 1=Louvain
  const [resolution, setResolution] = useState(0.8);
  const [dims, setDims] = useState(15);
  const [hasHydrated, setHasHydrated] = useState(false);

  const runClustering = useCallback(async (isInitial = false) => {
    setRunning(true);
    setError(null);
    const data = await callApi(`/cluster?dims=${dims}&resolution=${resolution}&algorithm=${algorithm}`, {}, {
      operation: 'cluster',
      step: 'cluster',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: true,
      cacheParams: { type: 'cluster', dims, resolution, algorithm },
      onlyIfCached: isInitial
    });

    if (data && data.result) {
      setResult(data);
    } else if (data && data.error && !isInitial) {
      setError(data.error);
    } else if (!data && !isInitial) {
      setError('R backend error. Check the console for details.');
    }
    setRunning(false);
  }, [callApi, currentProvId, dims, resolution, algorithm]);

  useEffect(() => {
    if (datasetInfo && pipelineState?.pca && !result && !running && !hasHydrated) {
      setHasHydrated(true);
      runClustering(true);
    }
  }, [datasetInfo, pipelineState?.pca, result, running, runClustering, hasHydrated]);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Network size={48} className="mx-auto text-slate-600 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  if (!pipelineState?.pca) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">PCA Required</h2>
          <p className="text-textMuted">Complete PCA before clustering. The KNN graph is built on principal components.</p>
        </div>
      </div>
    );
  }

  const clusterNames = result?.result?.cluster_names || [];
  const clusterSizes = result?.result?.cluster_sizes || [];
  const algoName = algorithm === 4 ? 'Leiden' : 'Louvain';

  const barData = [{
    type: 'bar',
    x: clusterNames,
    y: clusterSizes,
    marker: {
      color: clusterSizes.map((_, i) => {
        const colors = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'];
        return colors[i % colors.length];
      })
    },
    hovertemplate: '<b>%{x}</b><br>Cells: %{y}<extra></extra>'
  }];

  const barLayout = {
    autosize: true,
    margin: { l: 50, r: 20, t: 10, b: 60 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#94a3b8', size: 11 },
    xaxis: { gridcolor: '#334155', zeroline: false },
    yaxis: { title: 'Cell Count', gridcolor: '#334155', zeroline: false },
    showlegend: false
  };

  return (
    <div className="h-full w-full p-8 overflow-y-auto bg-background custom-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">Clustering</h2>
          <p className="text-textMuted">Build KNN graph and identify cell communities.</p>
        </div>
        <div className="flex items-center gap-3">
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            >📝 View Step Script</button>
          )}
          <button
            onClick={() => runClustering()}
            disabled={running}
            className={`btn ${result ? 'btn-secondary border-primary text-primary' : 'btn-primary'} flex items-center gap-2`}
          >
            {running && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {result ? 'Re-Cluster' : 'Run Clustering'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Parameters — always visible so user can re-cluster */}
      <div className="card p-6 mb-8 border-l-4 border-l-primary">
        <h3 className="font-bold flex items-center gap-2 text-white mb-5">
          <Network size={18} className="text-primary" /> Clustering Parameters
        </h3>
        <div className="grid grid-cols-3 gap-6">
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Algorithm</label>
            <select
              value={algorithm}
              onChange={e => setAlgorithm(parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
            >
              <option value={4}>Leiden</option>
              <option value={1}>Louvain</option>
            </select>
            <p className="text-[10px] text-slate-500 mt-1">Leiden is generally preferred</p>
          </div>
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Resolution</label>
            <div className="flex items-center gap-3">
              <input
                type="range" min="0.1" max="2.0" step="0.05" value={resolution}
                onChange={e => setResolution(parseFloat(e.target.value))}
                className="flex-1 accent-primary"
              />
              <span className="text-sm font-mono text-primary font-bold w-10 text-right">{resolution}</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-1">Higher = more clusters. 0.4–1.2 typical range.</p>
          </div>
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">PC Dimensions</label>
            <input
              type="number" value={dims} min={5} max={50}
              onChange={e => setDims(parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-500 mt-1">Use elbow plot to determine cutoff</p>
          </div>
        </div>
      </div>

      {running && (
        <div className="flex flex-col items-center justify-center h-48 space-y-4">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
          </div>
          <p className="text-textMuted font-medium animate-pulse">FindNeighbors + FindClusters ({algoName}, res={resolution})...</p>
        </div>
      )}

      {result && (
        <div className="space-y-6">
          {/* Summary */}
          <div className="grid grid-cols-4 gap-4">
            <div className="card p-4 bg-black/20 text-center">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Clusters</div>
              <div className="text-2xl font-black text-primary">{result.result?.n_clusters}</div>
            </div>
            <div className="card p-4 bg-black/20 text-center">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Algorithm</div>
              <div className="text-lg font-bold text-white">{result.result?.algorithm}</div>
            </div>
            <div className="card p-4 bg-black/20 text-center">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Resolution</div>
              <div className="text-2xl font-black text-white">{result.result?.resolution}</div>
            </div>
            <div className="card p-4 bg-black/20 text-center">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">PCs Used</div>
              <div className="text-lg font-bold text-white">1:{result.result?.dims_used}</div>
            </div>
          </div>

          {/* Cluster size distribution */}
          <div className="card p-6">
            <h3 className="font-semibold text-white mb-4">Cluster Size Distribution</h3>
            <div className="h-[300px]">
              <Plot
                data={barData}
                layout={barLayout}
                config={{ displayModeBar: false, responsive: true }}
                className="w-full h-full"
                useResizeHandler
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
