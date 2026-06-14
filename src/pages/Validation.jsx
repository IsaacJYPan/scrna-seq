import React, { useState } from 'react';
import { ShieldCheck, Database, Table, Info, CheckCircle, Activity, Clipboard as ClipboardList, RefreshCw, AlertTriangle } from 'lucide-react';

export default function Validation({ callApi, datasetInfo, currentWs }) {
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
    const data = await callApi('/validate', {}, {
      operation: 'validation',
      useCache: false
    });
    
    if (!data) {
      setError('R backend error. Check the console for details.');
      setLoading(false);
      return;
    }
    if (data.error) {
      setError(data.error);
      setLoading(false);
      return;
    }
    if (data.result) {
      setMetrics(data.result);
    }
    setLoading(false);
  };

  const pipelineCheck = (has, label) => (
    <span className={`px-2 py-0.5 rounded text-[8px] font-black tracking-widest border ${has ? 'bg-success/10 text-success border-success/30' : 'bg-slate-800 text-slate-400 border-slate-700'}`}>
      {has ? '✓ DONE' : 'PENDING'}
    </span>
  );

  return (
    <div className="h-full w-full flex flex-col bg-background p-8 overflow-y-auto custom-scrollbar">
      <div className="flex justify-between items-center mb-8 border-b border-border pb-6">
        <div>
           <h2 className="text-3xl font-black text-white mb-2 tracking-tighter">Validation</h2>
           <p className="text-slate-400 text-lg">Extract real metrics from the current Seurat object to verify pipeline state.</p>
        </div>
        <button 
          onClick={performSanityCheck}
          disabled={loading}
          className="btn btn-primary px-8 py-4 font-bold flex items-center gap-3 shadow-xl transition-all active:scale-95"
        >
          {loading ? <RefreshCw className="animate-spin" size={22} /> : <ClipboardList size={22} />}
          {metrics ? 'Refresh Metrics' : 'Run Validation'}
        </button>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {metrics ? (
        <div className="space-y-10 animate-in fade-in slide-in-from-bottom-6 duration-500">
           {/* Top summary cards */}
           <div className="grid grid-cols-4 gap-6">
              {[
                { label: 'Cells', value: metrics.cell_count?.toLocaleString(), icon: Database },
                { label: 'Features', value: metrics.feature_count?.toLocaleString(), icon: Table },
                { label: 'Median Genes/Cell', value: metrics.median_genes?.toLocaleString(), icon: Info },
                { label: 'Sparsity', value: metrics.sparsity, icon: CheckCircle }
              ].map((stat, i) => (
                <div key={i} className="card p-6 border-l-4 border-l-primary bg-slate-800/30">
                   <stat.icon className="text-primary mb-3 opacity-60" size={24} />
                   <div className="text-2xl font-black text-white mb-1 tracking-tight">{stat.value ?? '—'}</div>
                   <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</div>
                </div>
              ))}
           </div>

           {/* Detailed metrics table */}
           <div className="card">
              <div className="p-4 border-b border-border bg-slate-800/40">
                 <h3 className="text-xs font-black text-white uppercase tracking-widest">Seurat Object State</h3>
              </div>
              <div className="overflow-x-auto">
                 <table className="w-full text-left text-xs">
                    <thead className="bg-black/40 text-textMuted font-bold uppercase tracking-wider border-b border-border">
                       <tr>
                          <th className="p-4">Metric</th>
                          <th className="p-4">Value</th>
                          <th className="p-4">Source</th>
                       </tr>
                    </thead>
                    <tbody className="divide-y divide-border/20">
                       {[
                         { metric: 'Cell Count', value: metrics.cell_count?.toLocaleString(), source: 'ncol(obj)' },
                         { metric: 'Feature Count', value: metrics.feature_count?.toLocaleString(), source: 'nrow(obj)' },
                         { metric: 'Median nFeature_RNA', value: metrics.median_genes, source: 'median(obj$nFeature_RNA)' },
                         { metric: 'Median nCount_RNA', value: metrics.median_counts?.toLocaleString(), source: 'median(obj$nCount_RNA)' },
                         { metric: 'Mean percent.mt', value: metrics.mito_mean, source: 'mean(obj$percent.mt)' },
                         { metric: 'Matrix Sparsity', value: metrics.sparsity, source: '1 - nnz/total' },
                         { metric: 'PC1 Variance Explained', value: metrics.pca_top_variance, source: 'Stdevs(obj)' },
                         { metric: 'Cluster Count', value: metrics.n_clusters, source: 'FindClusters()' },
                       ].map((row, i) => (
                         <tr key={i} className="hover:bg-primary/5 transition-all">
                            <td className="p-4 font-bold text-slate-300">{row.metric}</td>
                            <td className="p-4 font-mono text-primary font-bold">{row.value ?? '—'}</td>
                            <td className="p-4 text-slate-400 font-mono text-[10px]">{row.source}</td>
                         </tr>
                       ))}
                    </tbody>
                 </table>
              </div>
           </div>

           {/* Pipeline state */}
           <div className="card p-6">
              <h3 className="text-xs font-black text-white uppercase tracking-widest mb-4">Pipeline State</h3>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   <span className="font-mono text-primary font-bold">load</span>
                   <span className="text-slate-400">→</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   {pipelineCheck(metrics.has_normalized, 'normalize')}
                   <span className="font-mono">normalize</span>
                   <span className="text-slate-400">→</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   {pipelineCheck(metrics.has_pca, 'pca')}
                   <span className="font-mono">pca</span>
                   <span className="text-slate-400">→</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   {pipelineCheck(metrics.has_clusters, 'cluster')}
                   <span className="font-mono">cluster</span>
                   <span className="text-slate-400">→</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-400">
                   {pipelineCheck(metrics.has_umap, 'umap')}
                   <span className="font-mono">umap</span>
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-3">Completed steps: <span className="text-primary font-mono">{metrics.pipeline_steps}</span></p>
           </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center  select-none pointer-events-none">
           <ClipboardList size={128} className="mb-8" />
           <p className="text-2xl font-black text-slate-300 tracking-tighter">Click "Run Validation" to inspect Seurat state</p>
        </div>
      )}
    </div>
  );
}
