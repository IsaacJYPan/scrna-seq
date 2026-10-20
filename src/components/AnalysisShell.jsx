import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';

const OUTLINE_WIDTH = 700;
const INSPECTOR_WIDTH = 1000;

/** A layout only: document state, source, results and compute belong to its caller. */
export default function AnalysisShell({
  projectName, analysisName, documentTitle, status, outline, toolbar, children,
  onOpenOverview, inspector, inspectorTitle = 'Inspection', onCloseInspector,
}) {
  const shell = useRef(null);
  const disclosure = useRef(null);
  const summary = useRef(null);
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const workArea = useRef(null);
  const outlineFrame = useRef(null);
  const [width, setWidth] = useState(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineId = useId(), inspectorId = useId(), headingId = useId();
  const wideOutline = width >= OUTLINE_WIDTH;
  const wideInspector = width >= INSPECTOR_WIDTH;
  const visible = width > 0;
  const hasInspector = inspector !== null && inspector !== undefined && inspector !== false && inspector !== '';

  useLayoutEffect(() => {
    const element = shell.current;
    const measure = () => setWidth(Math.max(0, element.getBoundingClientRect().width));
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      const entry = entries.find(item => item.target === element);
      if (entry) setWidth(Math.max(0, entry.contentRect.width));
    }) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect(); window.removeEventListener('resize', measure);
      if (outlineFrame.current !== null) cancelAnimationFrame(outlineFrame.current);
    };
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    // A hidden/inactive workspace has no width and must not make the app inert.
    if (!hasInspector || !visible || !element) return undefined;
    const previousFocus = document.activeElement;
    const outlineElement = disclosure.current, workElement = workArea.current;
    if (wideInspector) element.setAttribute('open', '');
    else {
      element.showModal();
      closeButton.current?.focus();
    }
    return () => {
      if (element.open) element.close();
      if (!wideInspector && previousFocus?.isConnected) {
        const hiddenOpener = outlineElement?.contains(previousFocus) && !outlineElement.open;
        (hiddenOpener || previousFocus === document.body ? workElement : previousFocus)?.focus({ preventScroll: true });
      }
    };
  }, [hasInspector, visible, wideInspector]);

  const closeInspector = () => {
    if (dialog.current?.open) dialog.current.close();
    onCloseInspector?.();
  };
  const inspectorStyle = wideInspector ? {
    position: 'relative', inset: 'auto', margin: 0, width: '19rem', maxWidth: '19rem',
    maxHeight: '100%', height: '100%', flex: '0 0 19rem', borderWidth: '0 0 0 1px', borderRadius: 0,
  } : {
    position: 'fixed', inset: 0, margin: 'auto', width: 'min(34rem, calc(100vw - 2rem))',
    maxWidth: 'calc(100vw - 2rem)', maxHeight: 'calc(100dvh - 2rem)', borderRadius: '12px',
  };

  return <section ref={shell} aria-labelledby={headingId} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-text">
    <header className="shrink-0 border-b border-border bg-surface px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div aria-label="Analysis context" className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-textMuted">
            {projectName && <span className="break-words">{projectName}</span>}
            {projectName && analysisName && <span aria-hidden="true">/</span>}
            {analysisName && <span className="break-words">{analysisName}</span>}
          </div>
          <h2 id={headingId} className="break-words text-lg font-semibold leading-7">{documentTitle || analysisName || 'Analysis'}</h2>
        </div>
        {onOpenOverview && <button type="button" className="btn btn-secondary shrink-0 text-xs" onClick={onOpenOverview}><ArrowLeft size={14} aria-hidden="true" />Analysis overview</button>}
      </div>
      {status && <div className="mt-2 text-xs text-textMuted">{status}</div>}
      {toolbar && <div aria-label="Document actions" className="mt-3 flex flex-wrap items-center gap-2">{toolbar}</div>}
    </header>
    <div className="flex min-h-0 min-w-0 flex-1" style={{ flexDirection: wideOutline ? 'row' : 'column' }}>
      {outline && <details ref={disclosure} open={wideOutline || outlineOpen}
        onToggle={event => { if (!wideOutline) setOutlineOpen(event.currentTarget.open); }}
        onKeyDown={event => {
          if (event.key === 'Escape' && !wideOutline && disclosure.current.open) {
            event.preventDefault(); setOutlineOpen(false); summary.current?.focus();
          }
        }}
        className="min-h-0 shrink-0 border-border bg-surface"
        style={wideOutline ? { width: '176px', height: '100%', borderRightWidth: '1px' } : { borderBottomWidth: '1px' }}>
        <summary ref={summary} aria-controls={outlineId} className="cursor-pointer px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary" style={wideOutline ? { display: 'none' } : undefined}>Documents and sections</summary>
        <nav id={outlineId} aria-label="Documents and sections" className="overflow-auto p-3"
          onClick={event => {
            const action = event.target.closest('button, a[href]');
            if (wideOutline || !action || action.matches(':disabled, [aria-disabled="true"]')) return;
            setOutlineOpen(false);
            if (workArea.current) workArea.current.scrollTop = 0;
            if (outlineFrame.current !== null) cancelAnimationFrame(outlineFrame.current);
            outlineFrame.current = requestAnimationFrame(() => {
              outlineFrame.current = null;
              const focused = document.activeElement;
              // A new form's autofocus or an opened modal owns focus. Only move
              // it when it was left in the now-closed disclosure (or nowhere).
              if (focused === document.body || focused === summary.current || disclosure.current?.contains(focused)) workArea.current?.focus({ preventScroll: true });
            });
          }} style={{ height: wideOutline ? '100%' : 'auto', maxHeight: wideOutline ? '100%' : 'min(14rem, 35vh)' }}>{outline}</nav>
      </details>}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <section ref={workArea} aria-label="Document work area" tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-auto p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:p-5">{children}</section>
        {hasInspector && <dialog ref={dialog} aria-labelledby={inspectorId} role={wideInspector ? 'complementary' : undefined}
          aria-modal={wideInspector ? undefined : 'true'} onCancel={event => { event.preventDefault(); closeInspector(); }}
          className="min-h-0 min-w-0 flex-col overflow-hidden border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/50 open:flex"
          style={inspectorStyle}>
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
            <h2 id={inspectorId} className="min-w-0 break-words text-sm font-semibold">{inspectorTitle}</h2>
            <button ref={closeButton} type="button" aria-label="Close inspector" className="btn btn-ghost shrink-0 px-2" onClick={closeInspector}><X size={18} aria-hidden="true" /></button>
          </div>
          <div className="min-h-0 overflow-auto p-4">{inspector}</div>
        </dialog>}
      </div>
    </div>
  </section>;
}
