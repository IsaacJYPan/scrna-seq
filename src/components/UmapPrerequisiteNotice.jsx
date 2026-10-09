import React from 'react';
import { AlertTriangle, ArrowRight } from 'lucide-react';

export function hasUmapResult(pipelineState) {
  return pipelineState?.umap === true;
}

export default function UmapPrerequisiteNotice({ compact = false, onNavigateToUmap }) {
  return (
    <div className={`p-4 sm:p-6 ${compact ? '' : 'bg-background'}`} role="status">
      <div className="card p-5 max-w-xl flex items-start gap-3">
        <AlertTriangle size={24} className="shrink-0 mt-0.5 text-amber-500" />
        <div className="min-w-0">
          <h3 className="mb-2 text-lg font-bold text-text">UMAP Required</h3>
          <p className="text-sm text-textMuted">Run UMAP in the Standard scRNA-seq workflow before overlaying gene expression on its coordinates. Expression distributions can be viewed without UMAP.</p>
          {onNavigateToUmap && <button type="button" onClick={onNavigateToUmap} className="btn btn-primary mt-4 inline-flex items-center gap-2">Go to UMAP <ArrowRight size={16} /></button>}
        </div>
      </div>
    </div>
  );
}
