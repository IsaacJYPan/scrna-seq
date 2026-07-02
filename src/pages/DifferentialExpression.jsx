import React, { useState } from 'react';
import { FileText, Play, LayoutGrid, Table } from 'lucide-react';
import Plot from 'react-plotly.js';
import { usePipelineStep } from '../hooks/usePipelineStep';
import { useTabParams } from '../hooks/useTabParams';

export default function DifferentialExpression({ callApi, datasetInfo, clusterProvId, openProvenance, pipelineState, rSessionId, sessionReady, currentWs, userEmail, objectId }) {
  const [viewMode, setViewMode] = useState('table');
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [visibleCount, setVisibleCount] = useState(10);

  const [params, setParam] = useTabParams('deg', userEmail, objectId, {
    testUse: 'wilcox',
    latentVars: ''
  });
  const { testUse, latentVars } = params;

  const { running: computing, result: degResult, error, runStep: runDEGs } = usePipelineStep({
    callApi,
    endpoint: `/deg?test_use=${testUse}${latentVars ? `&latent_vars=${encodeURIComponent(latentVars)}` : ''}`,
    ipcContext: {
      operation: 'deg',
      parentIds: clusterProvId ? [clusterProvId] : [],
      useCache: true,
      cacheParams: { type: 'deg', testUse, latentVars }
    },
    readyToHydrate: !!(datasetInfo && pipelineState?.cluster),
    sessionReady,
    rSessionId,
    onSuccess: () => {
      setSelectedCluster(null);
      setVisibleCount(10);
    }
  });

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background text-center">
        <div className="max-w-sm">
          <FileText size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  const markers = degResult?.result?.markers || degResult?.markers || [];
  const heatmap = degResult?.result?.heatmap || null;

  // Group markers by cluster, sorted numerically
  const clusterMap = {};
  markers.forEach(m => {
    const key = String(m.cluster);
    if (!clusterMap[key]) clusterMap[key] = [];
    clusterMap[key].push(m);
  });
  const clusterKeys = Object.keys(clusterMap).sort((a, b) => Number(a) - Number(b));
  const activeCluster = selectedCluster ?? clusterKeys[0] ?? null;
  const activeMarkers = activeCluster ? (clusterMap[activeCluster] || []) : [];

  const activeAnnotations = currentWs?.annotations || {};

  const heatmapData = heatmap ? [{
    z: heatmap.z,
    x: heatmap.clusters.map(c => activeAnnotations[c] || `Cluster ${c}`),
    y: heatmap.genes,
    type: 'heatmap',
    colorscale: 'YlGnBu',
    showscale: true,
    colorbar: { title: 'Avg Expr', thickness: 15 }
  }] : [];

  const heatmapLayout = {
    autosize: true,
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    xaxis: { title: 'Cell Clusters', gridcolor: '#334155', tickfont: { size: 10 } },
    yaxis: { title: 'Top Marker Genes', gridcolor: '#334155', tickfont: { size: 9 } },
    margin: { l: 80, r: 20, t: 30, b: 50 }
  };

  return (
    <div className="h-full w-full flex flex-col bg-background p-6 overflow-y-auto custom-scrollbar">
      <div className="flex justify-between items-center mb-6">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h2 className="text-2xl font-bold text-white tracking-tight">Markers / Differential Expression</h2>
            <span className="inline-flex rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-400">
              Legacy live-R
            </span>
          </div>
          <p className="text-textMuted text-sm">
            Identify cluster marker genes through the legacy synchronous live-R DEG path. Durable worker-backed DEG exists in the backend but is not UI-wired here.
          </p>
        </div>
        <div className="flex gap-3">
          {degResult && (
            <div className="flex bg-slate-800 rounded-lg p-1 mr-4">
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'table' ? 'bg-primary text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
              >
                <Table size={14} /> Table
              </button>
              <button
                onClick={() => setViewMode('heatmap')}
                className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'heatmap' ? 'bg-primary text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
              >
                <LayoutGrid size={14} /> Heatmap
              </button>
            </div>
          )}
          {degResult && (
            <button
              className="btn btn-ghost border border-primary/50 text-primary text-sm flex items-center gap-2"
              onClick={() => openProvenance(degResult.provenance.id)}
            >
              🔗 View Script
            </button>
          )}
          <button
            onClick={() => runDEGs()}
            disabled={computing || !!degResult}
            className={`btn ${degResult ? 'btn-secondary text-success border-success/30' : 'btn-primary'} flex items-center gap-2 shadow-lg shadow-primary/20`}
          >
            {computing ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span> : <Play size={16} />}
            {degResult ? 'Markers Computed' : 'Find All Markers'}
          </button>
        </div>
      </div>

      {!degResult && !computing && (
        <div className="flex flex-col gap-6 flex-1">
          <details className="card p-6 border-l-4 border-l-primary group">
            <summary className="text-sm font-bold flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white transition-colors list-none">
              <span className="text-primary group-open:rotate-90 transition-transform">▶</span>
              ⚙️ Advanced Options
            </summary>
            <div className="mt-4 p-4 bg-black/10 rounded-lg border border-border/50 grid grid-cols-2 gap-6">
              <div>
                <label htmlFor="deg-test" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Statistical Test</label>
                <select
                  id="deg-test"
                  value={testUse}
                  onChange={e => setParam('testUse', e.target.value)}
                  className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
                >
                  <option value="wilcox">Wilcoxon Rank Sum (Default)</option>
                  <option value="bimod">Likelihood-ratio test</option>
                  <option value="roc">ROC Analysis</option>
                  <option value="t">Student's t-test</option>
                  <option value="poisson">Poisson GLM</option>
                  <option value="negbinom">Negative Binomial GLM</option>
                  <option value="MAST">MAST</option>
                  <option value="DESeq2">DESeq2</option>
                </select>
                <p className="text-[10px] text-slate-400 mt-1">Backend for computing differential expression</p>
              </div>
              <div>
                <label htmlFor="deg-latent" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Latent Vars (Covariates)</label>
                <input
                  id="deg-latent"
                  type="text" 
                  value={latentVars || ''}
                  onChange={e => setParam('latentVars', e.target.value)}
                  placeholder="e.g. batch, age, sex"
                  className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
                />
                <p className="text-[10px] text-slate-400 mt-1">Comma-separated variables to test for regression</p>
              </div>
            </div>
          </details>

          <div className="card p-12 text-center flex flex-col items-center justify-center flex-1">
            {error && (
              <div className="bg-rose-500/10 text-rose-400 p-4 rounded-lg mb-6 max-w-lg border border-rose-500/20">
                <p className="font-bold mb-1">Error</p>
                <p className="text-sm">{error}</p>
              </div>
            )}
            <FileText size={48} className="text-primary opacity-50 mb-4" />
            <p className="text-textMuted max-w-sm text-lg">
              Requires a clustered Seurat object attached to this private live-R session. Computes <code className="text-blue-400 bg-blue-400/10 px-1 rounded">FindAllMarkers()</code> through the legacy live-R route.
            </p>
          </div>
        </div>
      )}

      {computing && (
        <div className="card flex items-center justify-center flex-1 flex-col">
          <div className="text-primary tracking-widest uppercase font-bold text-sm mb-4 animate-pulse">COMPUTING NON-PARAMETRIC WILCOXON TESTS...</div>
          <div className="w-64 h-2 bg-black/50 rounded-full overflow-hidden mx-auto">
            <div className="h-full bg-primary animate-[translate_1s_infinite]"></div>
          </div>
        </div>
      )}

      {degResult && (
        <div className="card flex-1 flex flex-col overflow-hidden relative">
          {degResult._fromCache && <div className="absolute top-4 right-4 text-[10px] bg-primary/20 text-primary px-2 py-0.5 rounded z-10 font-bold">CACHED</div>}

          <div className="p-4 border-b border-border bg-slate-800/50">
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              {viewMode === 'table' ? 'Top Conserved Cluster Markers' : 'Differential Expression Heatmap'}
              <span className="text-xs bg-black/30 text-textMuted px-2 py-0.5 rounded font-mono font-normal">{degResult.result.total_markers} total identified</span>
            </h3>
          </div>

          {viewMode === 'table' ? (
            <div className="flex-1 overflow-auto custom-scrollbar bg-surface/50 flex flex-col">
              {/* Cluster navigator */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-slate-800/60 sticky top-0 z-10">
                <button
                  onClick={() => {
                    const idx = clusterKeys.indexOf(activeCluster);
                    if (idx > 0) { setSelectedCluster(clusterKeys[idx - 1]); setVisibleCount(10); }
                  }}
                  disabled={clusterKeys.indexOf(activeCluster) === 0}
                  className="w-7 h-7 flex items-center justify-center rounded border border-border text-slate-400 hover:text-white hover:border-primary disabled:opacity-30 transition"
                >‹</button>

                <select
                  value={activeCluster ?? ''}
                  onChange={e => { setSelectedCluster(e.target.value); setVisibleCount(10); }}
                  className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-primary"
                >
                  {clusterKeys.map(k => (
                    <option key={k} value={k}>{activeAnnotations[k] || `Cluster ${k}`}</option>
                  ))}
                </select>

                <button
                  onClick={() => {
                    const idx = clusterKeys.indexOf(activeCluster);
                    if (idx < clusterKeys.length - 1) { setSelectedCluster(clusterKeys[idx + 1]); setVisibleCount(10); }
                  }}
                  disabled={clusterKeys.indexOf(activeCluster) === clusterKeys.length - 1}
                  className="w-7 h-7 flex items-center justify-center rounded border border-border text-slate-400 hover:text-white hover:border-primary disabled:opacity-30 transition"
                >›</button>

                <span className="text-xs text-slate-400 ml-2">
                  Showing {Math.min(visibleCount, activeMarkers.length)} of {activeMarkers.length} markers
                </span>
              </div>

              {/* Table */}
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-[49px] bg-slate-800 text-[10px] font-black text-textMuted uppercase tracking-wider shadow z-10 border-b border-border">
                  <tr>
                    <th className="p-4 w-1/5">Gene</th>
                    <th className="p-4 w-1/5">p-Value (adj)</th>
                    <th className="p-4 w-1/5">log2(FoldChange)</th>
                    <th className="p-4 w-1/5">pct.1</th>
                    <th className="p-4 w-1/5">pct.2</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30 text-sm">
                  {activeMarkers.slice(0, visibleCount).map((m, i) => (
                    <tr key={i} className="hover:bg-slate-800/80 transition-colors">
                      <td className="p-4 font-bold text-white tracking-widest">{m.gene}</td>
                      <td className="p-4 font-mono text-slate-400 text-xs">
                        {typeof m.p_val === 'number' ? m.p_val.toExponential(2) : (m.p_val || '0')}
                      </td>
                      <td className={`p-4 font-mono font-bold ${typeof m.log2FC === 'number' && m.log2FC < 0 ? 'text-rose-400' : 'text-success'}`}>
                        {typeof m.log2FC === 'number' ? (m.log2FC > 0 ? `+${m.log2FC.toFixed(2)}` : m.log2FC.toFixed(2)) : (m.log2FC || '0')}
                      </td>
                      <td className="p-4 text-slate-400 font-mono text-[10px]">{m.pct1 || '0'}</td>
                      <td className="p-4 text-slate-400 font-mono text-[10px]">{m.pct2 || '0'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Show more */}
              {visibleCount < activeMarkers.length && (
                <button
                  onClick={() => setVisibleCount(v => v + 10)}
                  className="w-full py-3 text-xs text-primary hover:text-white hover:bg-primary/10 border-t border-border transition font-bold"
                >
                  Show 10 more ({activeMarkers.length - visibleCount} remaining)
                </button>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-hidden p-6 bg-slate-900 shadow-inner">
              <Plot
                data={heatmapData}
                layout={heatmapLayout}
                config={{ responsive: true, displaylogo: false }}
                className="w-full h-full"
                useResizeHandler
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
