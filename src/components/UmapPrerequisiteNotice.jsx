import React from 'react';
import { AlertTriangle } from 'lucide-react';

export function hasUmapResult(pipelineState) {
  return pipelineState?.umap === true;
}

export default function UmapPrerequisiteNotice({ compact = false }) {
  return (
    <div className={`flex items-center justify-center text-center ${compact ? 'min-h-[360px] p-8' : 'h-full bg-background p-8'}`} role="status">
      <div className="max-w-sm">
        <AlertTriangle size={compact ? 40 : 48} className="mx-auto mb-4 text-amber-500" />
        <h2 className="mb-2 text-xl font-bold text-text">UMAP Required</h2>
        <p className="text-textMuted">Run the UMAP step in Core Preprocessing before generating feature plots.</p>
      </div>
    </div>
  );
}
