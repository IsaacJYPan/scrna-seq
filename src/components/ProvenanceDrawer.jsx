import React from 'react';
import { exportPipeline, downloadSingleScript, buildPipelineScript } from '../provenance';
import { X, Download, FileCode2, Copy } from 'lucide-react';

export default function ProvenanceDrawer({ provId, chain, onClose }) {
  if (!provId || !chain) return null;

  const target = chain.find(p => p.id === provId) || chain[chain.length - 1];
  if (!target) return null;

  const hasAncestors = chain.length > 1;

  // Derive a human-readable step name
  const stepName = target.operation
    ? target.operation.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : 'Computation Step';

  const timestamp = new Date(target.timestamp).toLocaleString();

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-[560px] bg-surface border-l border-border z-50 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-slate-800/50">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <FileCode2 size={20} className="text-primary" />
              {stepName}
            </h3>
            <span className="text-xs text-textMuted">{timestamp}</span>
          </div>
          <button className="text-textMuted hover:text-white transition-colors p-1" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
          
          {/* Environment Context */}
          <div className="grid grid-cols-2 gap-4 bg-black/20 p-4 rounded-lg border border-border">
            <div>
              <span className="block text-[10px] text-textMuted mb-1 font-semibold tracking-wider">ENVIRONMENT</span>
              <span className="text-xs text-slate-300 font-mono">{target.language} {target.languageVersion}</span>
            </div>
            <div>
              <span className="block text-[10px] text-textMuted mb-1 font-semibold tracking-wider">PACKAGES</span>
              <div className="flex flex-wrap gap-1">
                {target.packages?.length > 0 ? (
                  target.packages.map(p => <span key={p} className="text-[10px] bg-slate-700 text-slate-300 px-2 py-0.5 rounded border border-slate-600">{p}</span>)
                ) : <span className="text-xs text-textMuted italic">Base syntax only</span>}
              </div>
            </div>
          </div>

          {/* R Script for this step */}
          <div>
            <span className="block text-[10px] text-textMuted mb-2 font-semibold tracking-wider uppercase">Step Script (R)</span>
            <pre className="bg-slate-900 border border-slate-700/50 rounded-lg p-4 overflow-auto text-xs font-mono text-slate-300 shadow-inner leading-relaxed">
              <code>{target.script}</code>
            </pre>
          </div>

          {/* Hint to go to Lineage for full pipeline */}
          {hasAncestors && (
            <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl text-center">
              <p className="text-xs text-textMuted">
                This step is part of a <span className="text-primary font-bold">{chain.length}-step</span> pipeline.
                Visit <span className="text-white font-bold">Lineage</span> to view and export the full script.
              </p>
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-800/80 border-t border-border flex justify-between items-center shadow-inner">
           <button 
             onClick={() => navigator.clipboard.writeText(target.script)}
             className="btn btn-secondary flex items-center gap-2 hover:bg-slate-700"
           >
             <Copy size={16} /> Copy Script
           </button>
           
           <button 
             onClick={() => downloadSingleScript(target)}
             className="btn btn-primary flex items-center gap-2 shadow-sm"
           >
             <Download size={16} /> Download .R File
           </button>
        </div>
      </div>
    </>
  );
}
