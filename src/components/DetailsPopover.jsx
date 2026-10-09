import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function DetailsPopover({ label, children, className = '', panelClassName = '' }) {
  const ref = useRef(null);
  const panel = useRef(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summaryId = useId();
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      if (!ref.current || !panel.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 32);
      const top = Math.min(anchor.bottom + 8, window.innerHeight - 64);
      Object.assign(panel.current.style, {
        width: `${width}px`, left: `${Math.max(16, Math.min(anchor.right - width, window.innerWidth - width - 16))}px`,
        top: `${top}px`, maxHeight: `${window.innerHeight - top - 16}px`,
      });
    };
    place();
    const closeOutside = event => { if (!ref.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open]);
  const focusSummary = () => ref.current?.querySelector('summary')?.focus();
  const controlsSelector = 'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  const canFocus = element => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (typeof element.checkVisibility === 'function') return element.checkVisibility({ checkVisibilityCSS: true });
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const handleKeys = event => {
    const summary = ref.current?.querySelector('summary');
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); focusSummary(); return; }
    if (event.key !== 'Tab' || !open) return;
    const controls = [...panel.current.querySelectorAll(controlsSelector)].filter(canFocus);
    if (!event.shiftKey && document.activeElement === summary && controls.length) {
      event.preventDefault(); controls[0].focus();
    } else if (event.shiftKey && document.activeElement === controls[0]) {
      event.preventDefault(); focusSummary();
    } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
      event.preventDefault();
      const pageControls = [...document.querySelectorAll(controlsSelector)].filter(element => !panel.current.contains(element) && canFocus(element));
      const next = pageControls[pageControls.indexOf(summary) + 1];
      setOpen(false); (next || summary)?.focus();
    } else if (document.activeElement === summary) setOpen(false);
  };
  // Fixed content inside a native disclosure can remain clipped after closing
  // and reopening it. A portal also keeps the panel above workspace scroll areas.
  return <details ref={ref} open={open} className={`relative ${className}`} onKeyDown={handleKeys}>
    <summary id={summaryId} aria-controls={panelId} onClick={event => { event.preventDefault(); setOpen(value => !value); }} className="btn btn-secondary cursor-pointer list-none select-none">{label}</summary>
    {createPortal(<div id={panelId} aria-labelledby={summaryId} ref={panel} hidden={!open} onClick={event => { if (event.target.closest('[data-close-popover]')) { setOpen(false); focusSummary(); } }} className={`fixed z-50 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-4 text-sm text-text shadow-xl ${panelClassName}`}>{children}</div>, document.body)}
  </details>;
}
