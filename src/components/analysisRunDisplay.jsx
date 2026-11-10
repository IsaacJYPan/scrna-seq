import React from 'react';
import { publicErrorMessage } from '../publicError';

// Shared presentation helpers for the job-backed analysis pages (differential
// expression, pathway enrichment, CellChat, workspace runs). Keep these free of
// page-specific copy so every page describes runs the same way.

export function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

const RUN_STATUS_LABELS = {
  queued: 'Waiting for compute',
  running: 'Running',
  completed: 'Complete',
  failed: 'Needs attention',
  canceled: 'Canceled',
};

export function displayRunStatus(status, fallback = 'Unknown') {
  return RUN_STATUS_LABELS[status] || fallback;
}

// Worker log messages can contain internal detail; researchers see a fixed summary.
export function researcherRunNote(entry) {
  if (entry?.level === 'error') return 'This analysis needs attention.';
  const message = String(entry?.message || '');
  if (/completed|finished|published/i.test(message)) return 'Analysis finished.';
  if (/claim|start|running|comput/i.test(message)) return 'Compute started.';
  if (entry?.level === 'warn') return 'Analysis warning recorded.';
  return 'Analysis update recorded.';
}

export function parseErrorMessage(error) {
  const raw = error?.message || String(error || 'Request failed.');
  try {
    const parsed = JSON.parse(raw);
    return publicErrorMessage(parsed?.error || raw);
  } catch {
    return publicErrorMessage(raw);
  }
}

const BADGE_TONES = {
  blue: 'bg-primary/10 text-text border-primary/20',
  green: 'bg-success/10 text-success border-success/30',
  amber: 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-500/30',
  rose: 'bg-danger/10 text-danger border-danger/30',
  slate: 'bg-background text-textMuted border-border',
};

export function StatusBadge({ children, tone = 'slate' }) {
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone] || BADGE_TONES.slate}`}>
      {children}
    </span>
  );
}

export function EmptyNotice({ title, children }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <p className="font-bold text-text">{title}</p>
      <p className="mt-2 text-sm text-textMuted">{children}</p>
    </div>
  );
}

export function runStatusTone(status) {
  if (status === 'completed') return 'green';
  if (status === 'failed' || status === 'canceled') return 'rose';
  if (status === 'running') return 'blue';
  return 'amber';
}

export function Metric({ label, value, detail }) {
  return (
    <div className="rounded border border-border bg-surface/70 p-4">
      <div className="text-2xl font-semibold text-text">{value}</div>
      <div className="mt-1 text-xs font-medium text-textMuted">{label}</div>
      {detail && <div className="mt-2 text-xs text-textMuted">{detail}</div>}
    </div>
  );
}

const MAX_VISIBLE_RUN_NOTES = 100;

// Run notes are summarized by researcherRunNote; raw worker messages never render.
export function JobLogs({ logs }) {
  const rows = Array.isArray(logs) ? logs.slice(0, MAX_VISIBLE_RUN_NOTES) : [];
  if (!rows.length) return <EmptyNotice title="No run notes yet">Run notes appear after compute begins.</EmptyNotice>;
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-black/20 custom-scrollbar">
      {rows.map((entry, index) => (
        <div key={`${entry?.ts || index}-${index}`} className="border-b border-border/40 p-3 text-xs last:border-b-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <StatusBadge tone={entry?.level === 'error' ? 'rose' : entry?.level === 'warn' ? 'amber' : 'slate'}>
              {entry?.level || 'info'}
            </StatusBadge>
            <span className="font-mono text-textMuted">{formatDate(entry?.ts)}</span>
          </div>
          <p className="text-textMuted">{researcherRunNote(entry)}</p>
        </div>
      ))}
    </div>
  );
}
