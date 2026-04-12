import React from 'react';
import { LayoutPanelTop } from 'lucide-react';

export default function Publication({ datasetInfo }) {
  return (
    <div className="h-full flex items-center justify-center p-8 bg-background">
      <div className="text-center max-w-md">
        <div className="inline-flex p-5 rounded-2xl bg-slate-800/50 border border-slate-700/50 mb-6">
          <LayoutPanelTop size={48} className="text-slate-500" />
        </div>
        <h2 className="text-2xl font-black text-white mb-3 tracking-tight">Publication Figures</h2>
        <p className="text-slate-400 text-sm leading-relaxed mb-6">
          Generate high-fidelity dot plots, chord diagrams, and heatmaps for manuscripts. 
          Will pull real DEG and cluster data from your completed pipeline.
        </p>
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/20 rounded-full text-[10px] font-black text-amber-400 uppercase tracking-widest">
          Not Yet Implemented
        </div>
        <p className="text-xs text-slate-600 mt-4">This module will be available in a future release.</p>
      </div>
    </div>
  );
}
