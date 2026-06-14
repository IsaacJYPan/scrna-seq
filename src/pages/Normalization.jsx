import { Sparkles, AlertTriangle } from 'lucide-react';
import { useTabParams } from '../hooks/useTabParams';
import { usePipelineStep } from '../hooks/usePipelineStep';

export default function Normalization({ callApi, datasetInfo, currentProvId, qcProvId, openProvenance, pipelineState, rSessionId, sessionReady, userEmail, objectId }) {
  // Persisted parameters
  const [params, setParam] = useTabParams('normalize', userEmail, objectId, {
    method: 'LogNormalize',
    scaleFactor: 10000,
    nFeatures: 2000,
  });
  const { method, scaleFactor, nFeatures, varsToRegress } = params;
  const endpoint = `/normalize?method=${method}&scale_factor=${scaleFactor}&nfeatures=${nFeatures}${varsToRegress ? `&vars_to_regress=${encodeURIComponent(varsToRegress)}` : ''}`;

  const { running, result, error, runStep: runNormalization } = usePipelineStep({
    callApi,
    endpoint,
    ipcContext: {
      operation: 'normalize',
      step: 'normalize',
      parentIds: qcProvId ? [qcProvId] : [],
      useCache: true,
      cacheParams: { type: 'normalize', method, scale_factor: scaleFactor, nfeatures: nFeatures, varsToRegress }
    },
    readyToHydrate: !!(datasetInfo && (pipelineState?.qc || pipelineState?.isSubset)),
    sessionReady,
    rSessionId
  });

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Sparkles size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted">Load a dataset in the Workspace first.</p>
        </div>
      </div>
    );
  }

  if (!pipelineState?.qc && !pipelineState?.isSubset) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">QC Required</h2>
          <p className="text-textMuted">Complete the Quality Control step before normalization. Running normalization on unfiltered data may produce unreliable results.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full p-8 overflow-y-auto bg-background custom-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">Normalization</h2>
          <p className="text-textMuted">Normalize counts and identify highly variable features.</p>
        </div>
        <div className="flex items-center gap-3">
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            >📝 View Step Script</button>
          )}
          <button
            onClick={() => runNormalization(false)}
            disabled={running}
            className={`btn ${result ? 'bg-success/20 text-success border border-success' : 'btn-primary'} flex items-center gap-2`}
          >
            {running && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {!running && result && <Sparkles size={16} />}
            {result ? 'Normalization Complete' : 'Run Normalization'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {pipelineState?.isSubset && !pipelineState?.qc && (
        <div className="card p-4 mb-6 bg-sky-500/10 border border-sky-500/30 text-sky-300 flex items-center gap-3">
          <span className="text-lg">ℹ️</span>
          <span className="text-sm">
            <strong>Subset detected.</strong> QC metrics from the parent object are preserved in this subset — you can normalize directly, or run QC first to apply additional filters.
          </span>
        </div>
      )}

      {/* Parameters */}
      {!result && (
        <div className="card p-6 mb-8 border-l-4 border-l-primary">
          <h3 className="font-bold flex items-center gap-2 text-white mb-5">
            <Sparkles size={18} className="text-primary" /> Normalization Parameters
          </h3>
          <div className="grid grid-cols-3 gap-6">
            <div>
              <label htmlFor="norm-method" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Method</label>
              <select
                id="norm-method"
                value={method}
                onChange={e => setParam('method', e.target.value)}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
              >
                <option value="LogNormalize">LogNormalize</option>
                <option value="SCTransform">SCTransform (v2)</option>
              </select>
              <p className="text-[10px] text-slate-400 mt-1">SCTransform handles depth variance better</p>
            </div>
            <div>
              <label htmlFor="norm-scale-factor" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Scale Factor</label>
              <input
                id="norm-scale-factor"
                type="number" value={scaleFactor}
                onChange={e => setParam('scaleFactor', e.target.value === '' ? '' : parseInt(e.target.value) || 0)}
                disabled={method === 'SCTransform'}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary disabled:opacity-40"
              />
              <p className="text-[10px] text-slate-400 mt-1">{method === 'SCTransform' ? 'Not used with SCTransform' : 'Global scaling factor'}</p>
            </div>
            <div>
              <label htmlFor="norm-n-features" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Variable Features</label>
              <input
                id="norm-n-features"
                type="number" value={nFeatures}
                onChange={e => setParam('nFeatures', e.target.value === '' ? '' : parseInt(e.target.value) || 0)}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-slate-400 mt-1">Number of HVGs to select</p>
            </div>
          </div>

          <details className="mt-6 border-t border-border/50 pt-4 group">
            <summary className="text-sm font-bold flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white transition-colors list-none">
              <span className="text-primary group-open:rotate-90 transition-transform">▶</span>
              ⚙️ Advanced Options
            </summary>
            <div className="mt-4 p-4 bg-black/10 rounded-lg border border-border/50 grid grid-cols-2 gap-6">
              <div>
                <label htmlFor="norm-regress" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Vars to Regress</label>
                <input
                  id="norm-regress"
                  type="text" 
                  value={params.varsToRegress || ''}
                  onChange={e => setParam('varsToRegress', e.target.value)}
                  placeholder="e.g. percent.mt, percent.rb, nCount_RNA"
                  className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
                />
                <p className="text-[10px] text-slate-400 mt-1">Comma-separated metadata columns to regress out</p>
              </div>
            </div>
          </details>
        </div>
      )}

      {running && (
        <div className="flex flex-col items-center justify-center h-64 space-y-4">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
          </div>
          <p className="text-textMuted font-medium animate-pulse">Running {method} normalization...</p>
        </div>
      )}

      {result && (
        <div className="card p-6 border-t-4 border-t-success bg-success/5 animate-in fade-in slide-in-from-bottom-2">
          <div className="flex items-center gap-3 border-b border-border/50 pb-3 mb-5">
            <div className="w-8 h-8 rounded-full bg-success/20 flex items-center justify-center text-success">
              <Sparkles size={16} />
            </div>
            <h3 className="font-semibold text-lg text-text">Normalization Complete</h3>
          </div>
          <div className="grid grid-cols-3 gap-4 font-mono text-sm">
            <div className="p-4 bg-black/5 dark:bg-black/20 border border-border/50 rounded text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase tracking-wider mb-1">Method</div>
              <div className="text-primary font-bold">{result.result?.method || method}</div>
            </div>
            <div className="p-4 bg-black/5 dark:bg-black/20 border border-border/50 rounded text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase tracking-wider mb-1">Scale Factor</div>
              <div className="text-text font-bold">{result.result?.scale_factor?.toLocaleString() || scaleFactor}</div>
            </div>
            <div className="p-4 bg-black/5 dark:bg-black/20 border border-border/50 rounded text-center shadow-inner">
              <div className="text-[10px] text-textMuted uppercase tracking-wider mb-1">Variable Features</div>
              <div className="text-success font-bold">{result.result?.n_variable_features?.toLocaleString() || nFeatures}</div>
            </div>
          </div>
          <p className="text-xs text-textMuted mt-4 italic">{result.result?.message}</p>
        </div>
      )}
    </div>
  );
}
