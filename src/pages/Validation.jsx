import React, { useState } from 'react';
import { ShieldCheck, Database, Table, Info, CheckCircle, Activity, Clipboard as ClipboardList, RefreshCw, AlertTriangle } from 'lucide-react';
import { publicErrorMessage } from '../publicError';
import PageHeader from '../components/PageHeader';

export default function Validation({ callApi, datasetInfo, currentWs: _currentWs }) {
  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState(null);

  if (!datasetInfo) return (
     <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center opacity-40 max-w-sm">
           <ShieldCheck size={64} className="mx-auto text-slate-400 mb-6" />
           <p className="text-lg font-bold text-white mb-2 tracking-tighter uppercase">Validation Offline</p>
           <p className="text-xs text-textMuted uppercase font-black tracking-widest leading-loose">Load a dataset to validate pipeline state.</p>
        </div>
     </div>
  );

  const performSanityCheck = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await callApi('/validate', {}, {
        operation: 'validation',
        useCache: false
      });

      if (data?.error || !data?.result) {
        setError(publicErrorMessage(data?.error, 'Validation could not be completed. Try again.'));
        return;
      }
      setMetrics(data.result);
    } catch (err) {
      setError(publicErrorMessage(err, 'Validation could not be completed. Try again.'));
    } finally {
      setLoading(false);
    }
  };

  const pipelineCheck = (has) => (
    <span className={`shrink-0 whitespace-nowrap px-2 py-0.5 rounded text-[8px] font-black tracking-widest border ${has ? 'bg-success/10 text-success border-success/30' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
      {has ? '✓ DONE' : 'PENDING'}
    </span>
  );

  return (
    <div className="h-full w-full flex flex-col bg-background p-4 sm:p-6 lg:p-8 overflow-y-auto custom-scrollbar">
      <PageHeader title="Validation" description="Review key measurements from the selected analysis." className="mb-6 border-b border-border pb-5" actions={<button
          onClick={performSanityCheck}
          disabled={loading}
          className="btn btn-primary shrink-0 whitespace-nowrap"
        >
          {loading ? <RefreshCw className="animate-spin" size={18} /> : <ClipboardList size={18} />}
          {loading ? (metrics ? 'Refreshing Metrics…' : 'Validating…') : (metrics ? 'Refresh Metrics' : 'Run Validation')}
        </button>} />

      {error && (
        <div role="alert" className="shrink-0 rounded-xl border p-4 mb-6 bg-danger/10 border-danger text-danger flex items-start gap-3">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-start gap-3">
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium break-words">{error}</p>
              {metrics && (
                <p className="mt-1">Showing measurements from the last successful validation. This refresh did not update them.</p>
              )}
            </div>
            <button onClick={performSanityCheck} disabled={loading} className="btn btn-secondary shrink-0 self-start whitespace-nowrap">
              Retry validation
            </button>
          </div>
        </div>
      )}

      {loading && (
        <p role="status" className="shrink-0 text-sm text-textMuted mb-6">
          {metrics ? 'Refreshing measurements. Previously validated values remain visible below.' : 'Validating the selected analysis…'}
        </p>
      )}

      {metrics ? (
        <div aria-busy={loading} className="shrink-0 space-y-10 animate-in fade-in slide-in-from-bottom-6 duration-500">
           {/* Top summary cards */}
           <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 sm:gap-6">
              {[
                { label: 'Cells', value: metrics.cell_count?.toLocaleString(), icon: Database },
                { label: 'Features', value: metrics.feature_count?.toLocaleString(), icon: Table },
                { label: 'Median Genes/Cell', value: metrics.median_genes?.toLocaleString(), icon: Info },
                { label: 'Sparsity', value: metrics.sparsity, icon: CheckCircle }
              ].map((stat, i) => (
                <div key={i} className="card min-w-0 p-4 sm:p-6 border-l-4 border-l-primary bg-slate-800/30">
                   <stat.icon className="text-primary mb-3 opacity-60" size={24} />
                   <div className="min-w-0 break-words text-xl sm:text-2xl font-black text-white mb-1 tracking-tight">{stat.value ?? '—'}</div>
                   <div className="break-words text-[10px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</div>
                </div>
              ))}
           </div>

           {/* Detailed metrics table */}
           <div className="card">
              <div className="p-4 border-b border-border bg-slate-800/40">
                 <h3 className="text-xs font-black text-white uppercase tracking-widest">Analysis measurements</h3>
              </div>
              <div className="overflow-x-auto">
                 <table className="w-full text-left text-xs">
                    <thead className="bg-background text-textMuted font-semibold border-b border-border">
                       <tr>
                          <th className="p-4">Metric</th>
                          <th className="p-4">Value</th>
                       </tr>
                    </thead>
                    <tbody className="divide-y divide-border/20">
                       {[
                          { metric: 'Cell Count', value: metrics.cell_count?.toLocaleString() },
                          { metric: 'Feature Count', value: metrics.feature_count?.toLocaleString() },
                          { metric: 'Median genes per cell', value: metrics.median_genes },
                          { metric: 'Median counts per cell', value: metrics.median_counts?.toLocaleString() },
                          { metric: 'Mean mitochondrial percentage', value: metrics.mito_mean },
                          { metric: 'Matrix Sparsity', value: metrics.sparsity },
                          { metric: 'First component variance explained', value: metrics.pca_top_variance },
                          { metric: 'Cluster Count', value: metrics.n_clusters },
                       ].map((row, i) => (
                         <tr key={i} className="hover:bg-primary/5 transition-all">
                            <td className="p-4 font-bold text-slate-300">{row.metric}</td>
                            <td className="p-4 font-mono text-primary font-bold">{row.value ?? '—'}</td>
                         </tr>
                       ))}
                    </tbody>
                 </table>
              </div>
           </div>

           {/* Pipeline state */}
           <div className="card p-6">
               <h3 className="text-xs font-black text-white uppercase tracking-widest mb-4">Analysis progress</h3>
              <div className="flex flex-wrap gap-x-5 gap-y-3">
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   <span className="font-mono text-primary font-bold">load</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   {pipelineCheck(metrics.has_normalized, 'normalize')}
                   <span className="font-mono">normalize</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   {pipelineCheck(metrics.has_pca, 'pca')}
                   <span className="font-mono">pca</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   {pipelineCheck(metrics.has_clusters, 'cluster')}
                   <span className="font-mono">cluster</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   {pipelineCheck(metrics.has_umap, 'umap')}
                   <span className="font-mono">umap</span>
                </div>
              </div>
              <p className="break-words text-xs text-slate-400 mt-3">Completed steps: <span className="text-primary font-mono">{metrics.pipeline_steps}</span></p>
           </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center  select-none pointer-events-none">
           <ClipboardList size={48} className="mb-4 text-textMuted" />
            <p className="text-base font-medium text-textMuted text-center">Run validation to inspect measurements and preprocessing progress.</p>
        </div>
      )}
    </div>
  );
}
