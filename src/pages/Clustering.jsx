import React from 'react';
import { Network, AlertTriangle, FileText, ChevronRight, SlidersHorizontal } from 'lucide-react';
import Plot from 'react-plotly.js';
import { useTabParams } from '../hooks/useTabParams';
import { usePipelineStep } from '../hooks/usePipelineStep';

export default function Clustering({ callApi, datasetInfo, currentProvId: _currentProvId, pcaProvId, openProvenance, pipelineState, rSessionId, sessionReady, userEmail, objectId, activeProjectSeed, theme }) {
  // Persisted parameters
  const [params, setParam] = useTabParams('cluster', userEmail, objectId, {
    algorithm: 1,
    resolution: 0.8,
    dims: 15,
    kParam: 20,
    nStart: 10
  });
  const { algorithm, resolution, dims, kParam, nStart } = params;

  const { running, result, error, runStep: runClustering } = usePipelineStep({
    callApi,
    endpoint: `/cluster?dims=${dims}&resolution=${resolution}&algorithm=${algorithm}&seed=${activeProjectSeed || ''}&k_param=${kParam}&n_start=${nStart}`,
    ipcContext: {
      operation: 'cluster',
      step: 'cluster',
      parentIds: pcaProvId ? [pcaProvId] : [],
      useCache: true,
      cacheParams: { type: 'cluster', dims, resolution, algorithm, seed: activeProjectSeed || 'random', kParam, nStart }
    },
    readyToHydrate: !!(datasetInfo && pipelineState?.pca),
    sessionReady,
    rSessionId
  });

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Network size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  if (!pipelineState?.pca) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-text mb-2">PCA Required</h2>
          <p className="text-textMuted">Complete PCA before clustering. The KNN graph is built on principal components.</p>
        </div>
      </div>
    );
  }

  const clusterNames = Array.isArray(result?.result?.cluster_names) ? result.result.cluster_names : 
                      (result?.result?.cluster_names ? [result.result.cluster_names] : []);
  const clusterSizes = Array.isArray(result?.result?.cluster_sizes) ? result.result.cluster_sizes : 
                      (result?.result?.cluster_sizes ? [result.result.cluster_sizes] : []);
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

  const isDark = theme === 'dark';
  const plotText = isDark ? '#94a3b8' : '#475569';
  const plotGrid = isDark ? '#334155' : '#d8e0ea';
  const barLayout = {
    autosize: true,
    margin: { l: 50, r: 20, t: 10, b: 60 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: plotText, size: 11 },
    xaxis: { gridcolor: plotGrid, zeroline: false },
    yaxis: { title: 'Cell Count', gridcolor: plotGrid, zeroline: false },
    showlegend: false
  };

  return (
    <div className="h-full w-full p-8 overflow-y-auto bg-background custom-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-text mb-1 tracking-tight">Clustering</h2>
          <p className="text-textMuted">Build KNN graph and identify cell communities.</p>
        </div>
        <div className="flex items-center gap-3">
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            ><FileText size={15} /> View Step Script</button>
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
        <h3 className="font-bold flex items-center gap-2 text-text mb-5">
          <Network size={18} className="text-primary" /> Clustering Parameters
        </h3>
        <div className="grid grid-cols-3 gap-6">
          <div>
            <label htmlFor="cluster-algo" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Algorithm</label>
            <select
              id="cluster-algo"
              value={algorithm}
              onChange={e => setParam('algorithm', parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary"
            >
              <option value={4}>Leiden</option>
              <option value={1}>Louvain</option>
            </select>
            <p className="text-[10px] text-slate-400 mt-1">Leiden is generally preferred</p>
          </div>
          <div>
            <label htmlFor="cluster-res" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Resolution</label>
            <div className="flex items-center gap-3">
              <input
                id="cluster-res"
                type="range" min="0.1" max="2.0" step="0.05" value={resolution}
                onChange={e => setParam('resolution', parseFloat(e.target.value))}
                className="flex-1 accent-primary"
              />
              <span className="text-sm font-mono text-text font-bold w-10 text-right">{resolution}</span>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">Higher = more clusters. 0.4–1.2 typical range.</p>
          </div>
          <div>
            <label htmlFor="cluster-dims" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">PC Dimensions</label>
            <input
              id="cluster-dims"
              type="number" value={dims} min={5} max={50}
              onChange={e => setParam('dims', parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-400 mt-1">Use elbow plot to determine cutoff</p>
          </div>
        </div>

        <details className="mt-6 border-t border-border/50 pt-4 group">
          <summary className="text-sm font-bold flex items-center gap-2 cursor-pointer text-textMuted hover:text-text transition-colors list-none">
            <ChevronRight size={14} className="text-primary group-open:rotate-90 transition-transform" />
            <SlidersHorizontal size={14} className="text-primary" /> Advanced Options
          </summary>
          <div className="mt-4 p-4 bg-black/10 rounded-lg border border-border/50 grid grid-cols-2 gap-6">
            <div>
              <label htmlFor="cluster-k" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">k Neighbors (KNN)</label>
              <input
                id="cluster-k"
                type="number" value={kParam} min={5} max={100}
                onChange={e => setParam('kParam', parseInt(e.target.value))}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-slate-400 mt-1">Number of nearest neighbors to find (default: 20)</p>
            </div>
            <div>
              <label htmlFor="cluster-nstart" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Number of Starts</label>
              <input
                id="cluster-nstart"
                type="number" value={nStart} min={1} max={100}
                onChange={e => setParam('nStart', parseInt(e.target.value))}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-slate-400 mt-1">Random starts for algorithm optimization (default: 10)</p>
            </div>
          </div>
        </details>
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
            <div className="card p-4 bg-black/5 dark:bg-black/20 text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Clusters</div>
              <div className="text-2xl font-black text-primary">{result.result?.n_clusters}</div>
            </div>
            <div className="card p-4 bg-black/5 dark:bg-black/20 text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Algorithm</div>
              <div className="text-lg font-bold text-text">{result.result?.algorithm}</div>
            </div>
            <div className="card p-4 bg-black/5 dark:bg-black/20 text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Resolution</div>
              <div className="text-2xl font-black text-text">{result.result?.resolution}</div>
            </div>
            <div className="card p-4 bg-black/5 dark:bg-black/20 text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">PCs Used</div>
              <div className="text-lg font-bold text-text">1:{result.result?.dims_used}</div>
            </div>
          </div>

          {/* Cluster size distribution */}
          <div className="card p-6">
            <h3 className="font-semibold text-text mb-4">Cluster Size Distribution</h3>
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
