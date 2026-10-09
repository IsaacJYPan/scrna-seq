import PageHeader from '../components/PageHeader';
import React, { useState, useEffect, useCallback } from 'react';
import { Layers, AlertTriangle, CheckCircle2, RefreshCw, Zap, GitMerge, FileText } from 'lucide-react';
import { useTabParams } from '../hooks/useTabParams';
import { usePipelineStep } from '../hooks/usePipelineStep';
import { publicErrorMessage } from '../publicError';

const METHOD_INFO = {
  harmony: {
    name: 'Harmony',
    label: 'Harmony',
    color: 'from-violet-600 to-purple-700',
    borderColor: 'border-violet-500/50',
    bgColor: 'bg-violet-500/10',
    textColor: 'text-violet-400',
    description: 'Fast, embedding-level integration. Corrects PCA embeddings without altering gene expression data. Ideal for large datasets.',
    pros: ['Fastest method', 'Preserves expression values', 'Works with many batches', 'Low memory footprint'],
    package: 'harmony',
    reduction: 'harmony',
  },
  cca: {
    name: 'CCA integration',
    label: 'CCA / Anchors',
    color: 'from-cyan-600 to-teal-700',
    borderColor: 'border-cyan-500/50',
    bgColor: 'bg-cyan-500/10',
    textColor: 'text-cyan-400',
    description: 'Canonical Correlation Analysis with anchor-based data integration. Creates a fully integrated expression matrix.',
    pros: ['Robust cross-platform integration', 'Creates integrated assay', 'Best for label transfer', 'Reference-based compatible'],
    package: null,
    reduction: 'pca (integrated assay)',
  },
};

export default function BatchIntegration({
  callApi, datasetInfo, pipelineState, normProvId, integrateProvId: _integrateProvId,
  openProvenance, rSessionId, sessionReady, userEmail, objectId, activeProjectSeed
}) {
  const [params, setParam] = useTabParams('integrate', userEmail, objectId, {
    method: 'harmony',
    batchCol: '',
  });
  const { method, batchCol } = params;

  // Available metadata columns from the object
  const [metaCols, setMetaCols] = useState([]);
  const [colsLoading, setColsLoading] = useState(false);
  const [colsError, setColsError] = useState(null);
  const [batchPreview, setBatchPreview] = useState(null); // { n_unique, values }

  const { running, result, error, runStep, hasHydrated, setHasHydrated } = usePipelineStep({
    callApi,
    endpoint: `/integrate?method=${method}&batch_col=${encodeURIComponent(batchCol)}&seed=${activeProjectSeed || ''}`,
    ipcContext: {
      operation: 'integrate',
      step: 'integrate',
      parentIds: normProvId ? [normProvId] : [],
      useCache: true,
      cacheParams: { type: 'integrate', method, batch_col: batchCol, seed: activeProjectSeed || 'random' },
    },
    readyToHydrate: !!(datasetInfo && pipelineState?.normalize && batchCol),
    sessionReady,
    rSessionId,
    autoHydrate: false, // manual only — integration is optional
  });

  // Fetch metadata columns when the dataset is loaded
  const fetchMetaCols = useCallback(async () => {
    if (!datasetInfo || !sessionReady) return;
    setColsLoading(true);
    setColsError(null);
    try {
      const data = await callApi('/object-info');
      if (data.error) throw new Error(data.error);

      // Filter to categorical/factor columns with ≥2 unique values
      const categorical = (data.meta_cols || []).filter(
        col => (col.type === 'factor' || col.type === 'character') && col.n_unique >= 2
      );
      setMetaCols(categorical);

      // Auto-select batch col: prefer orig.ident, else first categorical col
      if (!batchCol) {
        const preferred = categorical.find(c => c.name === 'orig.ident') || categorical[0];
        if (preferred) setParam('batchCol', preferred.name);
      }
    } catch (e) {
      setColsError(publicErrorMessage(e, 'Batch information could not be loaded. Please try again.'));
    } finally {
      setColsLoading(false);
    }
  }, [callApi, datasetInfo, sessionReady, batchCol, setParam]);

  useEffect(() => {
    if (datasetInfo && sessionReady && pipelineState?.normalize) {
      fetchMetaCols();
    }
  }, [datasetInfo, sessionReady, pipelineState?.normalize, fetchMetaCols]);

  // Fetch preview for the selected batch column
  const fetchBatchPreview = useCallback(async (col) => {
    if (!col || !sessionReady) return;
    try {
      const data = await callApi(`/meta-values?column=${encodeURIComponent(col)}`);
      if (data.error) throw new Error(data.error);
      setBatchPreview(data);
    } catch {}
  }, [callApi, sessionReady]);

  useEffect(() => {
    if (batchCol) fetchBatchPreview(batchCol);
  }, [batchCol, fetchBatchPreview]);

  // Hydrate cached result on mount
  useEffect(() => {
    if (datasetInfo && pipelineState?.normalize && batchCol && !result && !running && !hasHydrated && sessionReady) {
      setHasHydrated(true);
      runStep(true); // cache-only probe
    }
  }, [datasetInfo, pipelineState?.normalize, batchCol, result, running, hasHydrated, sessionReady, runStep, setHasHydrated]);

  // ── Guard: no data ──────────────────────────────────────────────
  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Layers size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted text-sm">Load a dataset from the Workspace tab to begin.</p>
        </div>
      </div>
    );
  }

  // ── Guard: normalization required ───────────────────────────────
  if (!pipelineState?.normalize) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Normalization Required</h2>
          <p className="text-textMuted text-sm">Complete the Normalization step before running batch integration.</p>
        </div>
      </div>
    );
  }

  const selectedMethod = METHOD_INFO[method] || METHOD_INFO.harmony;
  const canRun = batchCol && !running;
  const isComplete = !!result;

  return (
    <div className="h-full w-full flex flex-col bg-background p-4 sm:p-6 overflow-y-auto custom-scrollbar">
      {/* Header */}
      <PageHeader title="Batch Integration" description="Correct technical variation across samples, donors, or sequencing runs." className="mb-6" actions={<>
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            ><FileText size={15} /> View recorded analysis</button>
          )}
          <button
            onClick={() => runStep(false)}
            disabled={!canRun}
            className={`btn flex items-center gap-2 ${
              !canRun ? 'opacity-40 cursor-not-allowed btn-primary' :
              isComplete ? 'btn-secondary border-primary text-primary' : 'btn-primary'
            }`}
          >
            {running
              ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4" />
              : <GitMerge size={16} />
            }
            {running ? 'Integrating...' : isComplete ? 'Re-Integrate' : 'Run Integration'}
          </button>
        </>} >
        {pipelineState?.integrate && <span className="inline-flex items-center gap-1 text-success text-xs font-bold"><CheckCircle2 size={12} /> Integrated</span>}
      </PageHeader>

      {/* Error banner */}
      {error && (
        <div className="card p-4 mb-5 bg-danger/10 border-danger text-danger flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
          <div>
            <span className="text-sm font-semibold">Integration Failed</span>
            <p className="text-xs mt-0.5 text-danger/80 whitespace-pre-wrap">{error}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* Left config panel */}
        <div className="lg:col-span-2 space-y-5">

          {/* Method selector */}
          <div className="card p-5 border-l-4 border-l-primary">
            <h3 className="font-bold text-white mb-4 text-sm uppercase tracking-wider flex items-center gap-2">
              <Zap size={14} className="text-primary" /> Integration Method
            </h3>
            <div className="space-y-2.5">
              {Object.entries(METHOD_INFO).map(([key, info]) => (
                <button
                  key={key}
                  onClick={() => setParam('method', key)}
                  className={`w-full text-left p-3 rounded-lg border transition-all ${
                    method === key
                      ? `${info.borderColor} ${info.bgColor} shadow-md`
                      : 'border-border hover:border-slate-600 bg-black/10'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`font-bold text-sm ${method === key ? info.textColor : 'text-slate-300'}`}>
                      {info.label}
                    </span>
                    {method === key && (
                      <div className={`w-2 h-2 rounded-full ${info.textColor.replace('text-', 'bg-')}`} />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">{info.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Batch column selector */}
          <div className="card p-5 border-l-4 border-l-violet-500">
            <h3 className="font-bold text-white mb-3 text-sm uppercase tracking-wider flex items-center gap-2">
              <Layers size={14} className="text-violet-400" /> Batch Variable
            </h3>
            {colsError ? (
              <p className="text-danger text-xs">{colsError}</p>
            ) : colsLoading ? (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-2">
                <span className="animate-spin border-2 border-slate-600 border-t-slate-400 rounded-full w-4 h-4" />
                Loading columns...
              </div>
            ) : (
              <>
                <select
                  id="batch-col-select"
                  aria-label="Batch Variable"
                  value={batchCol}
                  onChange={e => setParam('batchCol', e.target.value)}
                  className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary mb-2"
                >
                  <option value="">— Select metadata column —</option>
                  {metaCols.map(col => (
                    <option key={col.name} value={col.name}>
                      {col.name} ({col.n_unique} groups)
                    </option>
                  ))}
                </select>
                {metaCols.length === 0 && (
                  <p className="text-xs text-amber-400 mt-1">
                    No categorical columns with ≥2 unique values found.
                    Add batch metadata via Inspect → Metadata Import.
                  </p>
                )}
                <button
                  onClick={fetchMetaCols}
                  className="text-xs text-slate-400 hover:text-slate-300 flex items-center gap-1 transition mt-1"
                >
                  <RefreshCw size={10} /> Refresh columns
                </button>
              </>
            )}

            {/* Batch preview */}
            {batchPreview && batchCol && (
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-[10px] text-slate-400 uppercase font-bold mb-2">
                  Batch Groups ({batchPreview.n_unique})
                </p>
                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto custom-scrollbar">
                  {(batchPreview.values || []).slice(0, 20).map(v => (
                    <span
                      key={v.value}
                      className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-[11px] text-slate-300 font-mono"
                      title={`${v.count} cells`}
                    >
                      {v.value}
                      <span className="text-slate-400 ml-1">({v.count})</span>
                    </span>
                  ))}
                  {batchPreview.n_unique > 20 && (
                    <span className="text-[11px] text-slate-400 self-center">
                      +{batchPreview.n_unique - 20} more
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Method pros */}
          <div className={`card p-4 ${selectedMethod.bgColor} border ${selectedMethod.borderColor}`}>
            <p className={`text-xs font-bold uppercase tracking-wider mb-2 ${selectedMethod.textColor}`}>
              {selectedMethod.name} Advantages
            </p>
            <ul className="space-y-1">
              {selectedMethod.pros.map(pro => (
                <li key={pro} className="text-xs text-slate-400 flex items-start gap-1.5">
                  <CheckCircle2 size={10} className={`${selectedMethod.textColor} mt-0.5 flex-shrink-0`} />
                  {pro}
                </li>
              ))}
            </ul>
            {selectedMethod.package && (
              <p className="text-[10px] text-slate-400 mt-2">
                Requires: <code className={`${selectedMethod.textColor} bg-black/20 px-1 rounded`}>{selectedMethod.package}</code>
              </p>
            )}
          </div>
        </div>

        {/* Right: result / instructions */}
        <div className="lg:col-span-3 space-y-5">
          {/* Loading state */}
          {running && (
            <div className="card p-8 flex flex-col items-center justify-center gap-4 min-h-[300px]">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <p className="text-textMuted animate-pulse font-medium">
                Running {selectedMethod.name} integration on <span className="text-white font-bold">{batchCol}</span>...
              </p>
              {method === 'cca' && (
                <p className="text-xs text-slate-400 text-center max-w-xs">
                  CCA integration may take several minutes. It splits data by batch, finds integration anchors, and creates a merged assay.
                </p>
              )}
            </div>
          )}

          {/* Success result */}
          {!running && result && (
            <div className="space-y-4">
              <div className={`card p-5 bg-success/5 border border-success/30`}>
                <div className="flex items-start gap-3">
                  <CheckCircle2 size={22} className="text-success flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold text-success text-sm mb-0.5">Integration Successful</p>
                    <p className="text-xs text-slate-400">{result.result?.message}</p>
                  </div>
                </div>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="card p-4 bg-black/20 text-center">
                  <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Method</div>
                  <div className="text-lg font-bold text-white">{(result.result?.method || '').toUpperCase()}</div>
                </div>
                <div className="card p-4 bg-black/20 text-center">
                  <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Batch Column</div>
                  <div className="text-lg font-bold text-white font-mono truncate" title={result.result?.batch_col}>
                    {result.result?.batch_col}
                  </div>
                </div>
                <div className="card p-4 bg-black/20 text-center">
                  <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Batches</div>
                  <div className="text-2xl font-black text-primary">
                    {(result.result?.batches || []).length}
                  </div>
                </div>
              </div>

              {/* Batch list */}
              {result.result?.batches?.length > 0 && (
                <div className="card p-4">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                    Integrated Batches
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {result.result.batches.map((b, i) => {
                      const colors = ['bg-violet-500/20 text-violet-300 border-violet-500/30',
                                      'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
                                      'bg-pink-500/20 text-pink-300 border-pink-500/30',
                                      'bg-amber-500/20 text-amber-300 border-amber-500/30'];
                      return (
                        <span key={b} className={`px-3 py-1 border rounded-full text-xs font-medium ${colors[i % colors.length]}`}>
                          {b}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Next steps */}
              <div className="card p-4 bg-black/10 border border-border/50">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Next Steps</h4>
                <div className="space-y-2">
                  {[
                    { step: 'PCA', desc: method === 'harmony' ? 'Harmony uses integrated embeddings; run PCA anyway for consistency' : 'PCA was already re-run on the integrated assay' },
                    { step: 'Clustering', desc: `Will automatically use the ${method === 'harmony' ? 'harmony' : 'pca (integrated)'} reduction` },
                    { step: 'UMAP / DimPlot', desc: `Colored by batch to verify integration, then by cluster` },
                  ].map(({ step, desc }) => (
                    <div key={step} className="flex items-start gap-2">
                      <span className="text-primary text-xs font-bold mt-0.5 w-20 flex-shrink-0">{step}</span>
                      <span className="text-xs text-slate-400">{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Empty state / instructions */}
          {!running && !result && (
            <div className="card p-8 flex flex-col items-center text-center min-h-[300px] justify-center gap-4">
              <div className={`p-5 rounded-2xl bg-gradient-to-br ${selectedMethod.color} opacity-80`}>
                <GitMerge size={36} className="text-white" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white mb-2">{selectedMethod.name} Integration</h3>
                <p className="text-slate-400 text-sm max-w-sm leading-relaxed">
                  {selectedMethod.description}
                </p>
              </div>
              {!batchCol ? (
                <div className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/20 rounded-full text-xs font-bold text-amber-400">
                  Select a batch variable on the left to continue
                </div>
              ) : (
                <div className="space-y-2 text-left w-full max-w-sm">
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <CheckCircle2 size={12} className="text-success" />
                    Normalization complete
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <CheckCircle2 size={12} className="text-success" />
                    Batch column selected: <span className="text-white font-mono">{batchCol}</span>
                    {batchPreview && <span className="text-slate-400">({batchPreview.n_unique} groups)</span>}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <CheckCircle2 size={12} className="text-success" />
                    Method: <span className="text-white">{selectedMethod.name}</span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-2 pl-4">
                    Click <strong className="text-white">Run Integration</strong> to begin.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
