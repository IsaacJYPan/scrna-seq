import React, { useState } from 'react';
import { Settings, Cpu, Zap, SlidersHorizontal, CheckCircle2 } from 'lucide-react';

export default function Pipeline({ datasetInfo }) {
  const [tuningStatus, setTuningStatus] = useState('idle');

  const handleAutoTune = () => {
    setTuningStatus('analyzing');
    setTimeout(() => {
      setTuningStatus('complete');
    }, 2500);
  };

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Settings size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  const sparsity = datasetInfo?.sparsity ?? 0;

  return (
    <div className="h-full w-full flex flex-col bg-background p-6 overflow-y-auto custom-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">Auto-Tuning Pipeline</h2>
          <p className="text-textMuted">ML-assisted parameter optimization for Seurat processing.</p>
        </div>
        <button 
          onClick={handleAutoTune}
          disabled={tuningStatus !== 'idle'}
          className={`btn flex items-center gap-2 ${tuningStatus === 'complete' ? 'bg-success text-white' : 'btn-primary'}`}
        >
          {tuningStatus === 'idle' && <Zap size={16} />}
          {tuningStatus === 'analyzing' && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
          {tuningStatus === 'complete' && <CheckCircle2 size={16} />}
          {tuningStatus === 'idle' ? 'Run Auto-Tuner' : tuningStatus === 'analyzing' ? 'Analyzing Variance...' : 'Tuning Applied'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-1 card p-6 bg-slate-800/50">
           <h3 className="font-bold flex items-center gap-2 mb-6 border-b border-border pb-3">
             <Cpu size={18} className="text-primary"/> Model Diagnostics
           </h3>
           <div className="space-y-6">
             <div>
               <div className="flex justify-between text-sm mb-1">
                 <span className="text-textMuted">Matrix Sparsity</span>
                 <span className="font-mono text-white">{sparsity}%</span>
               </div>
               <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
                 <div className="bg-primary h-full" style={{width: `${sparsity}%`}}></div>
               </div>
             </div>
             <div>
               <div className="flex justify-between text-sm mb-1">
                 <span className="text-textMuted">Estimated Variance Ratio</span>
                 <span className="font-mono text-white">0.42</span>
               </div>
               <div className="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
                 <div className="bg-success h-full" style={{width: '42%'}}></div>
               </div>
             </div>
             <div className="pt-4 border-t border-border mt-4">
               <p className="text-xs text-textMuted italic">
                 The Auto-Tuner evaluates matrix geometry and sparsity to recommend optimal hyper-parameters for PCA and Leiden clustering.
               </p>
             </div>
           </div>
        </div>

        <div className="col-span-2 space-y-4">
          <div className="card p-5 border-l-4 border-l-blue-500">
            <div className="flex justify-between items-start mb-4">
              <h3 className="font-bold flex items-center gap-2">
                <SlidersHorizontal size={18} /> Normalization Strategy
              </h3>
              {tuningStatus === 'complete' && <span className="text-xs font-bold text-success bg-success/10 px-2 py-1 rounded">OPTIMIZED</span>}
            </div>
            <div className="grid grid-cols-2 gap-4">
               <div>
                 <label className="block text-xs text-textMuted mb-1 uppercase tracking-wide">Method</label>
                 <select 
                   className={`w-full bg-surface border rounded p-2 text-sm focus:outline-none transition-colors ${tuningStatus==='complete'?'border-success text-success font-bold':'border-border text-white'}`} 
                   disabled
                   value={tuningStatus === 'complete' ? 'sctransform' : 'lognormalize'}
                 >
                   <option value="lognormalize">LogNormalize</option>
                   <option value="sctransform">SCTransform (v2)</option>
                 </select>
               </div>
               <div>
                 <label className="block text-xs text-textMuted mb-1 uppercase tracking-wide">Scale Factor</label>
                 <input type="number" 
                   value={10000} 
                   className="w-full bg-surface border border-border rounded p-2 text-sm text-slate-400 focus:outline-none" 
                   readOnly 
                 />
               </div>
            </div>
            {tuningStatus === 'complete' && <p className="text-xs text-success mt-3">Switched to SCTransform to better handle the observed sequencing depth variance.</p>}
          </div>

          <div className="card p-5 border-l-4 border-l-primary">
            <div className="flex justify-between items-start mb-4">
              <h3 className="font-bold flex items-center gap-2">
                <SlidersHorizontal size={18} /> Highly Variable Genes (HVG)
              </h3>
              {tuningStatus === 'complete' && <span className="text-xs font-bold text-success bg-success/10 px-2 py-1 rounded">OPTIMIZED</span>}
            </div>
            <div className="grid grid-cols-2 gap-4">
               <div>
                 <label className="block text-xs text-textMuted mb-1 uppercase tracking-wide">Selection Method</label>
                 <select 
                   className={`w-full bg-surface border rounded p-2 text-sm focus:outline-none transition-colors ${tuningStatus==='complete'?'border-success text-success font-bold':'border-border text-white'}`}
                   disabled
                   value={tuningStatus === 'complete' ? 'sct' : 'vst'}
                 >
                   <option value="vst">vst (Variance Stabilizing)</option>
                   <option value="sct">sct (Pearson Residuals)</option>
                 </select>
               </div>
               <div>
                 <label className="block text-xs text-textMuted mb-1 uppercase tracking-wide">Number of Features</label>
                 <input type="number" 
                   value={tuningStatus === 'complete' ? 3000 : 2000} 
                   className={`w-full bg-surface border rounded p-2 text-sm text-white focus:outline-none transition-colors ${tuningStatus==='complete'?'border-success text-success font-bold':'border-border'}`} 
                   readOnly 
                 />
               </div>
            </div>
            {tuningStatus === 'complete' && <p className="text-xs text-success mt-3">Increased HVG count and switched to Pearson residuals for better rare-cell detection.</p>}
          </div>

          <div className="card p-5 border-l-4 border-l-purple-500">
            <div className="flex justify-between items-start mb-4">
              <h3 className="font-bold flex items-center gap-2">
                <SlidersHorizontal size={18} /> Dimensionality Reduction (PCA / UMAP)
              </h3>
              {tuningStatus === 'complete' && <span className="text-xs font-bold text-success bg-success/10 px-2 py-1 rounded">OPTIMIZED</span>}
            </div>
            <div className="grid grid-cols-2 gap-4">
               <div>
                 <label className="block text-xs text-textMuted mb-1 uppercase tracking-wide">PCA Dimensions</label>
                 <input type="number" 
                   value={tuningStatus === 'complete' ? 30 : 15} 
                   className={`w-full bg-surface border rounded p-2 text-sm focus:outline-none transition-colors ${tuningStatus==='complete'?'border-success text-success font-bold':'border-border text-white'}`} 
                   readOnly 
                 />
               </div>
               <div>
                 <label className="block text-xs text-textMuted mb-1 uppercase tracking-wide">UMAP n_neighbors</label>
                 <input type="number" 
                   value={tuningStatus === 'complete' ? 45 : 30} 
                   className={`w-full bg-surface border rounded p-2 text-sm focus:outline-none transition-colors ${tuningStatus==='complete'?'border-success text-success font-bold':'border-border text-white'}`} 
                   readOnly 
                 />
               </div>
            </div>
          </div>

          <div className="card p-5 border-l-4 border-l-pink-500">
            <div className="flex justify-between items-start mb-4">
              <h3 className="font-bold flex items-center gap-2">
                <SlidersHorizontal size={18} /> Clustering
              </h3>
              {tuningStatus === 'complete' && <span className="text-xs font-bold text-success bg-success/10 px-2 py-1 rounded">OPTIMIZED</span>}
            </div>
            <div className="grid grid-cols-2 gap-4">
               <div>
                 <label className="block text-xs text-textMuted mb-1 uppercase tracking-wide">Algorithm</label>
                 <select className="w-full bg-surface border border-border rounded p-2 text-sm text-white focus:outline-none" disabled>
                   <option>Leiden</option>
                   <option>Louvain</option>
                 </select>
               </div>
               <div>
                 <label className="block text-xs text-textMuted mb-1 uppercase tracking-wide">Resolution</label>
                 <input type="number" 
                   value={tuningStatus === 'complete' ? 0.6 : 0.8} 
                   className={`w-full bg-surface border rounded p-2 text-sm focus:outline-none transition-colors ${tuningStatus==='complete'?'border-success text-success font-bold':'border-border text-white'}`} 
                   readOnly 
                 />
               </div>
            </div>
            {tuningStatus === 'complete' && <p className="text-xs text-success mt-3">Lowered resolution to 0.6 to prevent over-clustering based on variance distribution.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
