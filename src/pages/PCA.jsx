import React, { useState, useCallback, useEffect } from 'react';
import { BarChart3, AlertTriangle } from 'lucide-react';
import Plot from 'react-plotly.js';

export default function PCA({ callApi, datasetInfo, currentProvId, openProvenance, pipelineState }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [npcs, setNpcs] = useState(50);
  const [activeView, setActiveView] = useState('elbow');
  const [hasHydrated, setHasHydrated] = useState(false);

  const runPCA = useCallback(async (isInitial = false) => {
    setRunning(true);
    setError(null);
    const data = await callApi(`/pca?npcs=${npcs}`, {}, {
      operation: 'pca',
      step: 'pca',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: true,
      cacheParams: { type: 'pca', npcs },
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
  }, [callApi, currentProvId, npcs]);

  useEffect(() => {
    if (datasetInfo && pipelineState?.normalize && !result && !running && !hasHydrated) {
      setHasHydrated(true);
      runPCA(true);
    }
  }, [datasetInfo, pipelineState?.normalize, result, running, runPCA, hasHydrated]);

  // Reset hydration flag when callApi identity changes (i.e., when rSessionId loads)
  // so that we can retry if the first attempt was a no-op due to missing session ID.
  useEffect(() => {
    setHasHydrated(false);
  }, [callApi]);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <BarChart3 size={48} className="mx-auto text-slate-600 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  if (!pipelineState?.normalize) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-text mb-2">Normalization Required</h2>
          <p className="text-textMuted">Complete the Normalization step before running PCA. PCA on unnormalized data will produce unreliable components.</p>
        </div>
      </div>
    );
  }

  const stdevs = result?.result?.stdevs || [];
  const loadings = result?.result?.gene_loadings || {};

  const elbowData = [{
    type: 'scatter',
    mode: 'lines+markers',
    x: stdevs.map((_, i) => i + 1),
    y: stdevs,
    marker: { color: '#6366f1', size: 5 },
    line: { color: '#6366f1', width: 2 },
    hovertemplate: '<b>PC%{x}</b><br>Stdev: %{y:.3f}<extra></extra>'
  }];

  const elbowLayout = {
    autosize: true,
    margin: { l: 60, r: 20, t: 10, b: 50 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#94a3b8', size: 11 },
    xaxis: { title: 'Principal Component', gridcolor: '#334155', zeroline: false },
    yaxis: { title: 'Standard Deviation', gridcolor: '#334155', zeroline: false },
    showlegend: false
  };

  const viewTabs = [
    { id: 'elbow', label: 'Elbow Plot' },
    { id: 'loadings', label: 'Gene Loadings' }
  ];

  return (
    <div className="h-full w-full p-8 overflow-y-auto bg-background custom-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-text mb-1 tracking-tight">Principal Component Analysis</h2>
          <p className="text-textMuted">Scale data and compute PCA for dimensionality reduction.</p>
        </div>
        <div className="flex items-center gap-3">
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            >📝 View Step Script</button>
          )}
          <button
            onClick={() => runPCA()}
            disabled={running}
            className={`btn ${result ? 'bg-success/20 text-success border border-success' : 'btn-primary'} flex items-center gap-2`}
          >
            {running && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {result ? 'PCA Complete' : 'Run PCA'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Parameters */}
      {!result && !running && (
        <div className="card p-6 mb-8 border-l-4 border-l-primary">
          <h3 className="font-bold flex items-center gap-2 text-text mb-5">
            <BarChart3 size={18} className="text-primary" /> PCA Parameters
          </h3>
          <div className="max-w-xs">
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Number of PCs</label>
            <input
              type="number" value={npcs} min={5} max={100}
              onChange={e => setNpcs(e.target.value === '' ? '' : parseInt(e.target.value) || 0)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-500 mt-1">Standard: 50. Use elbow plot to determine how many to keep downstream.</p>
          </div>
        </div>
      )}

      {running && (
        <div className="flex flex-col items-center justify-center h-64 space-y-4">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
          </div>
          <p className="text-textMuted font-medium animate-pulse">Computing ScaleData + RunPCA ({npcs} components)...</p>
        </div>
      )}

      {result && (
        <div className="space-y-6">
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="card p-4 bg-black/20 text-center">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Components</div>
              <div className="text-2xl font-black text-text">{stdevs.length}</div>
            </div>
            <div className="card p-4 bg-black/20 text-center">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Top PC Stdev</div>
              <div className="text-2xl font-black text-primary">{stdevs[0]?.toFixed(2) || '—'}</div>
            </div>
            <div className="card p-4 bg-black/20 text-center">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">PC10 Stdev</div>
              <div className="text-2xl font-black text-slate-400">{stdevs[9]?.toFixed(2) || '—'}</div>
            </div>
          </div>

          {/* View tabs */}
          <div className="flex bg-slate-800 rounded-lg p-1 border border-border w-fit">
            {viewTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveView(tab.id)}
                className={`px-5 py-2 rounded-md text-xs font-bold transition-all ${activeView === tab.id ? 'bg-primary text-text shadow' : 'text-slate-500 hover:text-text'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeView === 'elbow' && (
            <div className="card p-6">
              <h3 className="font-semibold text-text mb-4">Elbow Plot — Variance per PC</h3>
              <div className="h-[400px]">
                <Plot
                  data={elbowData}
                  layout={elbowLayout}
                  config={{ displayModeBar: false, responsive: true }}
                  className="w-full h-full"
                  useResizeHandler
                />
              </div>
              <p className="text-xs text-textMuted mt-3 italic">
                Look for the "elbow" where variance drops off — PCs beyond that point capture noise.
              </p>
            </div>
          )}

          {activeView === 'loadings' && (
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-border bg-slate-800/40">
                <h4 className="font-bold text-text text-xs uppercase tracking-widest">Top Gene Loadings per PC</h4>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-black/20 text-textMuted font-bold uppercase border-b border-border">
                    <tr>
                      <th className="p-3">Rank</th>
                      {Object.keys(loadings).map(pc => (
                        <th key={pc} className="p-3 text-center">{pc}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {Array.from({ length: 10 }).map((_, rank) => (
                      <tr key={rank} className="hover:bg-white/5">
                        <td className="p-3 font-mono text-slate-500">{rank + 1}</td>
                        {Object.values(loadings).map((genes, pi) => (
                          <td key={pi} className="p-3 text-center font-mono text-text text-[11px]">
                            {genes[rank] || '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
