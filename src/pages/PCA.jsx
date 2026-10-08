import React, { useState } from 'react';
import { BarChart3, AlertTriangle, FileText } from 'lucide-react';
import Plot from '../components/Plot';
import { useTabParams } from '../hooks/useTabParams';
import { usePipelineStep } from '../hooks/usePipelineStep';
import { useRestoredReduction } from '../hooks/useRestoredReduction';

export default function PCA({ callApi, datasetInfo, currentProvId: _currentProvId, normProvId, openProvenance, pipelineState, rSessionId, sessionReady, userEmail, objectId, activeProjectSeed, theme }) {
  const isPbmcTutorial = datasetInfo?.source === 'pbmc3k_demo' || datasetInfo?.metadata?.sourceType === 'pbmc3k_demo';
  const pcaSeed = activeProjectSeed || (isPbmcTutorial ? 42 : '');
  const [params, setParam] = useTabParams('pca', userEmail, objectId, { npcs: 50 });
  const npcs = params.npcs;
  const setNpcs = (v) => setParam('npcs', v);
  // Separate local state for the input so every keystroke doesn't change ipcContext/endpoint
  const [inputNpcs, setInputNpcs] = React.useState(npcs);
  const parsedNpcs = Number(inputNpcs);
  const pcaValidationError = !Number.isInteger(parsedNpcs) || parsedNpcs < 5 || parsedNpcs > 100
    ? 'Number of PCs must be a whole number from 5 to 100.'
    : null;
  const [activeView, setActiveView] = useState('elbow');

  const { running, result, error, setResult, runStep } = usePipelineStep({
    callApi,
    endpoint: `/pca?npcs=${npcs}&seed=${pcaSeed}`,
    ipcContext: {
      operation: 'pca',
      step: 'pca',
      parentIds: normProvId ? [normProvId] : [],
      useCache: true,
      cacheParams: { type: 'pca', npcs, seed: pcaSeed || 'random' }
    },
    readyToHydrate: !!(datasetInfo && pipelineState?.normalize),
    sessionReady,
    rSessionId,
    autoHydrate: false
  });

  const contextKey = JSON.stringify([userEmail, objectId, rSessionId, sessionReady]);
  const restored = useRestoredReduction({
    callApi, reduction: 'pca', contextKey,
    enabled: !!(datasetInfo && (pipelineState?.normalize || pipelineState?.pca) && sessionReady),
    onReset: () => setResult(null),
    onResult: (data) => {
      setResult(data);
      const actualNpcs = Number(data.result.npcs);
      if (actualNpcs >= 5 && actualNpcs <= 100) {
        setNpcs(actualNpcs); setInputNpcs(actualNpcs);
      }
    }
  });
  const runPCA = () => { restored.invalidate(); runStep(); };

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <BarChart3 size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  if (!pipelineState?.normalize && !pipelineState?.pca) {
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
    type: 'scattergl',
    mode: 'lines+markers',
    x: stdevs.map((_, i) => i + 1),
    y: stdevs,
    marker: { color: '#6366f1', size: 5 },
    line: { color: '#6366f1', width: 2 },
    hovertemplate: '<b>PC%{x}</b><br>Stdev: %{y:.3f}<extra></extra>'
  }];

  const isDark = theme === 'dark';
  const plotText = isDark ? '#94a3b8' : '#475569';
  const plotGrid = isDark ? '#334155' : '#d8e0ea';
  const elbowLayout = {
    autosize: true,
    margin: { l: 60, r: 20, t: 10, b: 50 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: plotText, size: 11 },
    xaxis: { title: { text: 'Principal Component' }, gridcolor: plotGrid, zeroline: false },
    yaxis: { title: { text: 'Standard Deviation' }, gridcolor: plotGrid, zeroline: false },
    showlegend: false
  };

  const viewTabs = [
    { id: 'elbow', label: 'Elbow Plot' },
    { id: 'loadings', label: 'Gene Loadings' },
    ...(result?.result?.trace_data?.length ? [{ id: 'embedding', label: 'PC1 vs PC2' }] : [])
  ];

  return (
    <div className="h-full w-full p-8 overflow-y-auto bg-background custom-scrollbar">
      <div className="flex flex-wrap gap-y-3 justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-text mb-1 tracking-tight">Principal Component Analysis</h2>
          <p className="text-textMuted">Scale data and compute PCA for dimensionality reduction.</p>
        </div>
        <div className="flex items-center gap-3">
          {result?.provenance?.id && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            ><FileText size={15} /> View recorded analysis</button>
          )}
          <button
            onClick={() => runPCA()}
            disabled={running || restored.loading || !pipelineState?.normalize || Boolean(pcaValidationError)}
            className="btn btn-primary flex items-center gap-2"
          >
            {running && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {result ? 'Re-compute PCA' : 'Run PCA'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}
      {pcaValidationError && <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger text-sm" role="alert">{pcaValidationError}</div>}
      {restored.loading && <p role="status" className="text-sm text-textMuted mb-4">Loading the existing PCA result...</p>}
      {!pipelineState?.normalize && <p role="status" className="text-sm text-textMuted mb-4">
        The existing PCA can be inspected. Normalization is required to compute PCA again.
      </p>}
      {restored.error && <div role="alert" className="card p-4 mb-4 text-danger">
        {restored.error} <button onClick={restored.retry} className="underline">Retry loading result</button>
      </div>}
      {restored.missing && !result && <p role="status" className="text-sm text-textMuted mb-4">
        No PCA reduction is present in this analysis. Run PCA to create one.
      </p>}
      {result?.result?.restored && <p role="note" className="text-sm text-textMuted mb-4">
        Showing the existing PCA from this analysis; no computation was run.
        {result.result.settings?.seed != null && ` Seed: ${result.result.settings.seed}.`}
        {!Object.keys(result.result.settings || {}).length && ' Original calculation settings are unavailable.'}
      </p>}

      {/* Parameters */}
      {!result && !running && (
        <div className="card p-6 mb-8 border-l-4 border-l-primary">
          <h3 className="font-bold flex items-center gap-2 text-text mb-5">
            <BarChart3 size={18} className="text-primary" /> PCA Parameters
          </h3>
          <div className="max-w-xs">
            <label htmlFor="pca-npcs" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Number of PCs</label>
            <input
              id="pca-npcs"
              type="number" value={inputNpcs} min={5} max={100}
              onChange={e => {
                const value = e.target.value === '' ? '' : Number(e.target.value);
                setInputNpcs(value);
                if (Number.isInteger(value) && value >= 5 && value <= 100) setNpcs(value);
              }}
              onBlur={e => {
                const v = parseInt(e.target.value) || 50;
                setInputNpcs(v);
                setNpcs(v);
              }}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary"
              aria-invalid={Boolean(pcaValidationError)}
            />
            <p className="text-[10px] text-textMuted mt-1">Standard: 50. Use elbow plot to determine how many to keep downstream.</p>
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
            <div className="card p-4 bg-black/5 dark:bg-black/20 text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Components</div>
              <div className="text-2xl font-black text-text">{stdevs.length}</div>
            </div>
            <div className="card p-4 bg-black/5 dark:bg-black/20 text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Top PC Stdev</div>
              <div className="text-2xl font-black text-primary">{stdevs[0]?.toFixed(2) || '—'}</div>
            </div>
            <div className="card p-4 bg-black/5 dark:bg-black/20 text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase font-bold mb-1">PC10 Stdev</div>
              <div className="text-2xl font-black text-slate-400">{stdevs[9]?.toFixed(2) || '—'}</div>
            </div>
          </div>

          {/* View tabs */}
          <div className="flex bg-black/5 dark:bg-slate-800 rounded-lg p-1 border border-border w-fit">
            {viewTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveView(tab.id)}
                className={`px-5 py-2 rounded-md text-xs font-bold transition-all ${activeView === tab.id ? 'bg-primary text-white shadow' : 'text-textMuted hover:text-text'}`}
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
                  preferSvg
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

          {activeView === 'embedding' && (
            <div className="card p-6">
              <h3 className="font-semibold text-text mb-4">Existing PCA coordinates</h3>
              <div className="h-[400px]">
                <Plot preferSvg useResizeHandler className="w-full h-full"
                  data={result.result.trace_data.map(trace => ({ ...trace, type: 'scatter', mode: 'markers',
                    marker: { size: 4 }, hovertemplate: '%{x:.2f}, %{y:.2f}<extra>%{fullData.name}</extra>' }))}
                  layout={{ ...elbowLayout,
                    xaxis: { ...elbowLayout.xaxis, title: { text: 'PC 1' } },
                    yaxis: { ...elbowLayout.yaxis, title: { text: 'PC 2' }, scaleanchor: 'x', scaleratio: 1 } }}
                  config={{ displayModeBar: false, responsive: true }} />
              </div>
              {result.result.sampled && <p role="note" className="text-xs text-textMuted mt-3">
                Preview shows {result.result.n_points?.toLocaleString()} of {result.result.n_cells?.toLocaleString()} cells.
                {result.result.clusters_truncated && ' Some cell groups are omitted by the preview limit.'}
              </p>}
            </div>
          )}

          {activeView === 'loadings' && (
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-border bg-black/5 dark:bg-slate-800/40">
                <h4 className="font-bold text-text text-xs uppercase tracking-widest">Top Gene Loadings per PC</h4>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-black/5 dark:bg-black/20 text-textMuted font-bold uppercase border-b border-border">
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
                        <td className="p-3 font-mono text-slate-400">{rank + 1}</td>
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
