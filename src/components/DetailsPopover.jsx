import React, { useEffect, useRef } from 'react';

export default function DetailsPopover({ label, children, className = '', panelClassName = '' }) {
  const ref = useRef(null);
  const panel = useRef(null);
  useEffect(() => {
    const place = () => {
      if (!ref.current?.open || !panel.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 32);
      const top = Math.min(anchor.bottom + 8, window.innerHeight - 64);
      Object.assign(panel.current.style, {
        width: `${width}px`, left: `${Math.max(16, Math.min(anchor.right - width, window.innerWidth - width - 16))}px`,
        top: `${top}px`, maxHeight: `${window.innerHeight - top - 16}px`,
      });
    };
    const closeOutside = event => { if (ref.current && !ref.current.contains(event.target)) ref.current.open = false; };
    document.addEventListener('pointerdown', closeOutside);
    const details = ref.current;
    details.addEventListener('toggle', place);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      details.removeEventListener('toggle', place);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, []);
  return <details ref={ref} className={`relative ${className}`} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); ref.current.open = false; ref.current.querySelector('summary')?.focus(); }
  }}>
    <summary className="btn btn-secondary cursor-pointer list-none select-none">{label}</summary>
    <div ref={panel} onClick={event => { if (event.target.closest('[data-close-popover]')) ref.current.open = false; }} className={`fixed z-50 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-4 text-sm text-text shadow-xl ${panelClassName}`}>{children}</div>
  </details>;
}
