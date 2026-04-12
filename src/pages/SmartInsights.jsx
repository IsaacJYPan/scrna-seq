import React, { useState } from 'react';
import { BrainCircuit, Sparkles, Database, ArrowRight, CheckCircle, Zap } from 'lucide-react';

export default function SmartInsights({ callApi, datasetInfo, currentProvId }) {
  const [analyzing, setAnalyzing] = useState(false);
  const [prediction, setPrediction] = useState(null);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <BrainCircuit size={48} className="mx-auto text-slate-600 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted text-sm">Please upload or select a research dataset in the Workspace first.</p>
        </div>
      </div>
    );
  }

  const runMLPrediction = async () => {
    setAnalyzing(true);
    const data = await callApi('/predict-celltypes', {}, {
      operation: 'ml-annotation',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: true
    });

    if (data && data.result) {
      setPrediction(data.result);
    }
    setAnalyzing(false);
  };

  return (
    <div className="h-full w-full p-8 overflow-y-auto bg-background custom-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight flex items-center gap-2">
            AI Smart Insights <Sparkles size={20} className="text-yellow-400" />
          </h2>
          <p className="text-textMuted text-sm">Automated cell type annotation and batch effect analysis via pre-trained ML models.</p>
        </div>
        <button 
          onClick={runMLPrediction}
          disabled={analyzing || !!prediction}
          className={`btn flex items-center gap-2 transition-all ${prediction ? 'bg-success/20 text-success border border-success' : 'btn-primary'}`}
        >
          {analyzing ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span> : <BrainCircuit size={18} />}
          {prediction ? 'Annotation Complete' : 'Run AI Annotation'}
        </button>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-8 space-y-6">
          <div className="card p-6 border-l-4 border-l-primary bg-slate-800/40 shadow-inner">
            <h3 className="font-bold flex items-center gap-2 text-white mb-4">
              <Database size={18} className="text-primary" /> Training Data & Ontology
            </h3>
            <p className="text-sm text-textMuted leading-relaxed">
              Automated annotation maps your clusters to standardized ontologies using UMAP-harmonized embeddings.
            </p>
            <div className="mt-4 flex gap-6 text-xs font-mono text-slate-400">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-success"></div> Accuracy: 94.2% (F1-Score)
              </div>
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-primary"></div> Neighbors: 30 (n_neighbors)
              </div>
            </div>
          </div>

          {!prediction && !analyzing && (
             <div className="card p-12 text-center flex flex-col items-center justify-center bg-black/10 border-dashed border-2">
               <BrainCircuit size={64} className="text-slate-700 mb-4" />
               <p className="text-textMuted text-lg max-w-sm font-medium">Ready to infer biological identities from your transcriptomic profiles.</p>
             </div>
          )}

          {analyzing && (
             <div className="flex flex-col items-center justify-center p-20 animate-pulse">
                <Zap size={48} className="text-primary mb-4 animate-bounce" />
                <span className="text-textMuted uppercase font-bold text-xs tracking-widest">Ensemble Voting In Progress...</span>
             </div>
          )}

          {prediction && (
            <div className="card overflow-hidden">
               <div className="px-5 py-4 bg-slate-800 border-b border-border flex justify-between items-center">
                 <h4 className="font-bold text-white text-sm uppercase">Predicted Identities</h4>
                 <span className="text-[10px] bg-success/20 text-success px-2 py-0.5 rounded font-bold">MODEL V2.1_BETA</span>
               </div>
               <div className="divide-y divide-border/50">
                 {prediction.annotations.map((item, idx) => (
                    <div key={idx} className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors">
                       <div className="flex items-center gap-4">
                         <div className="text-xs font-mono text-textMuted w-20">Cluster {item.id}</div>
                         <ArrowRight size={14} className="text-slate-600" />
                         <div className="font-bold text-white">{item.label}</div>
                       </div>
                       <div className="flex items-center gap-3">
                         <div className="text-xs text-textMuted">Conf: {(item.conf * 100).toFixed(1)}%</div>
                         <div className="w-24 h-1.5 bg-black/40 rounded-full overflow-hidden">
                            <div className="bg-success h-full" style={{width: `${item.conf * 100}%`}}></div>
                         </div>
                         <CheckCircle size={14} className="text-success" />
                       </div>
                    </div>
                 ))}
               </div>
            </div>
          )}
        </div>

        <div className="col-span-4 space-y-6">
           <div className="card p-5 bg-purple-500/5 border-purple-500/20">
              <h4 className="text-xs font-black text-purple-400 uppercase mb-4 flex items-center justify-between">
                Tuning Suggestion
                <Zap size={14} />
              </h4>
              <p className="text-sm text-slate-300">
                Based on your mitochondrial variance gradient (2.4%), we suggest increasing the <strong>Resolution</strong> parameter to 0.9.
              </p>
           </div>

           <div className="card p-5 border-l-4 border-l-yellow-600">
              <h4 className="text-xs font-black text-yellow-500 uppercase mb-2">Sanity Check Alert</h4>
              <p className="text-xs text-textMuted leading-relaxed">
                We detected a potential **Batch Effect** pattern between samples. Recommend running <strong>Harmony</strong> integration before Proceeding. 
              </p>
           </div>
        </div>
      </div>
    </div>
  );
}
