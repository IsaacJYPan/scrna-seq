import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

// Shows an R script as numbered steps. By default each step hides defensive
// code (checks, guard clauses, tryCatch wrappers) so a researcher can read the
// analysis; "Exact code" shows what actually ran.
export default function ReadableSteps({ steps, label = 'Code steps' }) {
  const [exact, setExact] = useState(false);
  const [open, setOpen] = useState(() => new Set((steps || []).map((s) => s.number)));
  if (!Array.isArray(steps) || steps.length === 0) return <p className="text-xs text-textMuted">No code.</p>;
  const hidden = steps.reduce((n, s) => n + (s.hiddenLines || 0), 0);
  const toggle = (number) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(number)) next.delete(number); else next.add(number);
    return next;
  });
  return (
    <div className="space-y-2" aria-label={label}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-textMuted">
        <span>{steps.length} step{steps.length === 1 ? '' : 's'}{!exact && hidden > 0 ? ` · ${hidden} line${hidden === 1 ? '' : 's'} of error handling hidden` : ''}</span>
        <span role="group" aria-label="Code view" className="inline-flex overflow-hidden rounded border border-border">
          <button type="button" aria-pressed={!exact} onClick={() => setExact(false)} className={`px-2 py-1 ${!exact ? 'bg-primary/10 font-bold text-primary' : ''}`}>Readable</button>
          <button type="button" aria-pressed={exact} onClick={() => setExact(true)} className={`border-l border-border px-2 py-1 ${exact ? 'bg-primary/10 font-bold text-primary' : ''}`}>Exact code</button>
        </span>
      </div>
      <ol className="space-y-2">
        {steps.map((step) => (
          <li key={step.number} className="rounded border border-border bg-background">
            <button type="button" onClick={() => toggle(step.number)} aria-expanded={open.has(step.number)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold text-text">
              {open.has(step.number) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Step {step.number}: {step.title}
            </button>
            {open.has(step.number) && (
              <pre className="max-h-96 overflow-auto border-t border-border px-3 py-2 text-[11px] leading-relaxed text-text"><code>{(exact ? step.code : step.readable) || '(only error handling)'}</code></pre>
            )}
          </li>
        ))}
      </ol>
      {!exact && <p className="text-[11px] text-textMuted">The readable view is for reading. The exact code is what ran.</p>}
    </div>
  );
}
