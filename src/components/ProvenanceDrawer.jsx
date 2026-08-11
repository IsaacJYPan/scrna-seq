import React, { useEffect, useRef } from 'react';
import { X, FileCode2 } from 'lucide-react';

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
          
          <div className="rounded-lg border border-border bg-black/20 p-4">
            <span className="block text-[10px] text-textMuted mb-2 font-semibold tracking-wider uppercase">Recorded analysis</span>
            <p className="text-sm text-slate-300">This record summarizes an approved analysis step. Technical implementation details and source text are not shown here.</p>
          </div>

          {hasAncestors && (
            <div className="p-4 bg-primary/5 border border-primary/20 rounded-xl text-center">
              <p className="text-xs text-textMuted">
                This step is part of a <span className="text-primary font-bold">{chain.length}-step</span> recorded analysis history.
                Open <span className="text-white font-bold">Analysis lineage</span> to inspect its saved relationships.
              </p>
            </div>
          )}
        </div>

      </div>
    </>
  );
}
