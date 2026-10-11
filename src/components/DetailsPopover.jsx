import React, { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function DetailsPopover({ label, children, className = '', panelClassName = '', summaryClassName = 'btn btn-secondary cursor-pointer list-none select-none', preferredWidth = 320, onOpenChange }) {
  const ref = useRef(null);
  const panel = useRef(null);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summaryId = useId();
  const changeOpen = useCallback(next => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      if (!ref.current || !panel.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width || window.innerWidth;
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const width = Math.max(0, Math.min(preferredWidth, viewportWidth - 32));
      panel.current.style.maxHeight = 'none';
      Object.assign(panel.current.style, {
        width: `${width}px`, left: `${Math.max(16, Math.min(anchor.right - width, viewportWidth - width - 16))}px`,
      });
      const contentHeight = panel.current.scrollHeight;
      const spaceBelow = Math.max(0, viewportHeight - anchor.bottom - 24);
      const spaceAbove = Math.max(0, anchor.top - 24);
      const placeBelow = contentHeight <= spaceBelow || spaceBelow >= spaceAbove;
      const availableHeight = placeBelow ? spaceBelow : spaceAbove;
      const height = Math.min(contentHeight, availableHeight);
      const desiredTop = placeBelow ? anchor.bottom + 8 : anchor.top - 8 - height;
      const top = Math.max(16, Math.min(desiredTop, viewportHeight - height - 16));
      Object.assign(panel.current.style, {
        top: `${top}px`, maxHeight: `${Math.max(0, availableHeight)}px`,
      });
    };
    place();
    const closeOutside = event => { if (!ref.current?.contains(event.target) && !panel.current?.contains(event.target)) changeOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (resizeObserver) {
      if (panel.current) resizeObserver.observe(panel.current);
      if (ref.current) resizeObserver.observe(ref.current);
    }
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      resizeObserver?.disconnect();
    };
  }, [open, changeOpen, preferredWidth]);
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
    if (event.key === 'Escape') { event.preventDefault(); changeOpen(false); focusSummary(); return; }
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
      changeOpen(false); (next || summary)?.focus();
    } else if (document.activeElement === summary) changeOpen(false);
  };
  // Fixed content inside a native disclosure can remain clipped after closing
  // and reopening it. A portal also keeps the panel above workspace scroll areas.
  return <details ref={ref} open={open} className={`relative ${className}`} onKeyDown={handleKeys}>
    <summary id={summaryId} role="button" aria-expanded={open} aria-controls={panelId} onClick={event => { event.preventDefault(); changeOpen(!open); }} className={summaryClassName}>{label}</summary>
    {createPortal(<div id={panelId} aria-labelledby={summaryId} ref={panel} hidden={!open} onClick={event => { if (event.target.closest('[data-close-popover]')) { changeOpen(false); focusSummary(); } }} className={`fixed z-50 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-4 text-sm text-text shadow-xl ${panelClassName}`}>{children}</div>, document.body)}
  </details>;
}
