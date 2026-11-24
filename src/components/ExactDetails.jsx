import React, { useState } from 'react';
import { Fingerprint } from 'lucide-react';

// Exact identifiers (checksums, digests, saved-version ids) matter for audit
// but not for reading. They sit behind a small fingerprint icon: hovering or
// focusing it shows them, clicking pins them open, and each can be copied.
export default function ExactDetails({ items, label = 'Exact identifiers', className = '' }) {
  const rows = (items || []).filter((item) => item && item.value);
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState(null);
  if (!rows.length) return null;
  const copy = async (value) => {
    try { await navigator.clipboard?.writeText(value); setCopied(value); } catch { /* clipboard unavailable */ }
  };
  return (
    <span className={`group relative inline-flex align-middle ${className}`}
      onKeyDown={(event) => { if (event.key === 'Escape') setPinned(false); }}>
      <button type="button" aria-label={label} aria-expanded={pinned} title={label}
        onClick={() => setPinned((open) => !open)}
        className="inline-flex items-center rounded p-0.5 text-textMuted hover:bg-primary/10 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
        <Fingerprint size={13} aria-hidden="true" />
      </button>
      <span role="tooltip"
        className={`${pinned ? 'block' : 'hidden'} absolute left-0 top-full z-30 mt-1 w-[24rem] max-w-[80vw] space-y-1.5 rounded-md border border-border bg-surface p-2.5 text-left text-xs font-normal shadow-lg group-hover:block group-focus-within:block`}>
        {rows.map((row) => (
          <span key={row.label} className="block">
            <span className="flex items-center justify-between gap-2 text-textMuted">
              {row.label}
              <button type="button" onClick={() => copy(row.value)} className="text-primary underline">{copied === row.value ? 'Copied' : 'Copy'}</button>
            </span>
            <code className="block break-all font-mono text-[11px] text-text">{row.value}</code>
          </span>
        ))}
      </span>
    </span>
  );
}
