import React, { useEffect, useRef } from 'react';
import { X, FileCode2, Copy } from 'lucide-react';

export default function ProvenanceDrawer({ provId, chain, onClose }) {
  const panelRef = useRef(null);
  const isOpen = !!provId && !!chain;

  // Close on Escape and move focus into the panel when it opens, so keyboard
  // users can dismiss the drawer and are not left focused behind the backdrop.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

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
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prov-drawer-title"
        className="fixed top-0 right-0 h-full w-[560px] max-w-[95vw] bg-surface border-l border-border z-50 shadow-2xl flex flex-col transform transition-transform duration-300 ease-in-out focus:outline-none"
      >
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-slate-800/50">
          <div>
            <h3 id="prov-drawer-title" className="text-lg font-bold text-white flex items-center gap-2">
              <FileCode2 size={20} className="text-primary" />
              {stepName}
            </h3>
            <span className="text-xs text-textMuted">{timestamp}</span>
          </div>
          <button aria-label="Close provenance panel" className="text-textMuted hover:text-white transition-colors p-1" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
          
          {/* Environment Context */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-black/20 p-4 rounded-lg border border-border">
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

          {/* Legacy live-R script preview for this step */}
          <div>
            <span className="block text-[10px] text-textMuted mb-2 font-semibold tracking-wider uppercase">Legacy step script preview (R)</span>
            <pre className="bg-slate-900 border border-slate-700/50 rounded-lg p-4 overflow-auto text-xs font-mono text-slate-300 shadow-inner leading-relaxed">
              <code>{target.script}</code>
            </pre>
            <p className="mt-2 text-xs text-textMuted">
              This preview is from the live-R provenance path. It is not a supported generated report or complete reproducibility export.
            </p>
          </div>

          {hasAncestors && (
            <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl text-center">
              <p className="text-xs text-textMuted">
                This step is part of a <span className="text-primary font-bold">{chain.length}-step</span> pipeline.
                Visit <span className="text-white font-bold">Session DAG</span> to inspect the transient live-R lineage.
              </p>
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-800/80 border-t border-border flex justify-between items-center shadow-inner">
           <button
             onClick={() => navigator.clipboard.writeText(target.script)}
             className="btn btn-secondary flex items-center gap-2 hover:bg-slate-700"
           >
             <Copy size={16} /> Copy Preview
           </button>
        </div>
      </div>
    </>
  );
}
