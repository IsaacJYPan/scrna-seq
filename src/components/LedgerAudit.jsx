import React, { useState } from 'react';
import { AlertTriangle, ClipboardCheck, Eye } from 'lucide-react';

// The audit of an agent's analysis ledger (shared/analysisLedger.mjs), shown
// above the report it supports. A reviewer reads this first: what the agent
// left open, what deserves a second look, and every claim and label next to
// the exact output (run, file, row, value) that supports it. Report text cites
// entries as [F:<id>]; those citations link to the rows here.

export function ledgerAnchor(id) {
  return `ledger-${id}`;
}

// Turns [F:led_…] style citations into in-page links to the audit rows.
export function linkLedgerCitations(markdown) {
  return String(markdown || '').replace(/\[(F|A|D|I|C):([A-Za-z0-9_-]{1,80})\](?!\()/g, (_, kind, id) => `[${kind}:${id}](#${ledgerAnchor(id)})`);
}

function Evidence({ refs, fileUrl }) {
  if (!refs?.length) return <span className="text-textMuted">—</span>;
  return (
    <ul className="space-y-0.5">
      {refs.map((ref, index) => {
        const label = [ref.file, ref.locator && `@ ${ref.locator}`, ref.value && `= ${ref.value}`].filter(Boolean).join(' ');
        const href = ref.sandboxRunId && ref.file ? fileUrl?.(ref.sandboxRunId, ref.file) : null;
        return (
          <li key={index} className="break-words">
            {href ? <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">{label}</a> : <span>{label || ref.runId}</span>}
            <span className="ml-1 text-[10px] text-textMuted">{ref.sandboxRunId || ref.runId}</span>
          </li>
        );
      })}
    </ul>
  );
}

const TONE = {
  blocker: 'border-danger/30 bg-danger/10 text-danger',
  review: 'border-warning/40 bg-warning/10 text-text',
};

function GapList({ gaps, severity, title }) {
  const items = gaps.filter((gap) => gap.severity === severity);
  if (!items.length) return null;
  return (
    <div className={`rounded border p-3 ${TONE[severity]}`}>
      <p className="mb-1 flex items-center gap-1 text-xs font-bold uppercase">{severity === 'blocker' ? <AlertTriangle size={12} /> : <Eye size={12} />} {title} ({items.length})</p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs">
        {items.map((gap, index) => (
          <li key={index}>
            {gap.message}
            {gap.entryIds.map((id) => <a key={id} href={`#${ledgerAnchor(id)}`} className="ml-1 underline">{id}</a>)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Table({ caption, columns, rows }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="mb-1 text-left text-xs font-bold text-text">{caption}</caption>
        <thead><tr>{columns.map((column) => <th key={column} className="border-b border-border px-2 py-1 font-bold text-textMuted">{column}</th>)}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

const td = 'border-b border-border px-2 py-1 align-top text-text';

export default function LedgerAudit({ audit, fileUrl }) {
  const [showChecklist, setShowChecklist] = useState(false);
  if (!audit) return null;
  const { counts } = audit;
  const answered = audit.checklist.filter((item) => item.status !== 'missing').length;
  return (
    <section aria-label="Analysis audit" className="space-y-3 rounded-lg border border-border bg-surface p-4 text-sm">
      <div>
        <h5 className="flex items-center gap-2 font-bold text-text"><ClipboardCheck size={16} className="text-primary" /> Analysis audit</h5>
        <p className="mt-1 text-xs text-textMuted">
          Computed from the agent&apos;s analysis ledger. {counts.blocker} blocking gap{counts.blocker === 1 ? '' : 's'}, {counts.review} item{counts.review === 1 ? '' : 's'} to review, {answered} of {audit.checklist.length} checklist items answered.
          {audit.citations ? ` The report cites ${audit.citations.cited} ledger entr${audit.citations.cited === 1 ? 'y' : 'ies'}.` : ''}
        </p>
      </div>
      <GapList gaps={audit.gaps} severity="blocker" title="Blocking" />
      <GapList gaps={audit.gaps} severity="review" title="Review first" />
      <Table caption="Findings" columns={['ID', 'Finding', 'Confidence', 'Samples', 'Evidence']} rows={audit.findings.map((finding) => (
        <tr key={finding.id} id={ledgerAnchor(finding.id)}>
          <td className={`${td} font-mono text-[10px]`}>{finding.id}</td>
          <td className={td}>{finding.statement}{finding.limitations ? <span className="block text-textMuted">Limits: {finding.limitations}</span> : null}</td>
          <td className={td}>{finding.confidence}</td>
          <td className={td}>{finding.sampleSupport.replace('_', ' ')}</td>
          <td className={td}><Evidence refs={finding.evidence} fileUrl={fileUrl} /></td>
        </tr>
      ))} />
      <Table caption="Cluster labels" columns={['ID', 'Group', 'Label', 'Markers', 'Confidence', 'Alternatives', 'Evidence']} rows={audit.labels.map((label) => (
        <tr key={label.id} id={ledgerAnchor(label.id)}>
          <td className={`${td} font-mono text-[10px]`}>{label.id}</td>
          <td className={td}>{label.grouping} {label.group}{label.cells !== null ? <span className="block text-textMuted">{label.cells} cells</span> : null}</td>
          <td className={td}>{label.label}</td>
          <td className={td}>{label.markers.join(', ')}</td>
          <td className={td}>{label.confidence}</td>
          <td className={td}>{label.alternatives.join(', ') || '—'}</td>
          <td className={td}><Evidence refs={label.evidence} fileUrl={fileUrl} /></td>
        </tr>
      ))} />
      <Table caption="Decisions" columns={['ID', 'Decision', 'Choice', 'Alternatives', 'Impact', 'Tested']} rows={audit.decisions.map((decision) => (
        <tr key={decision.id} id={ledgerAnchor(decision.id)}>
          <td className={`${td} font-mono text-[10px]`}>{decision.id}</td>
          <td className={td}>{decision.title}<span className="block text-textMuted">{decision.rationale}</span></td>
          <td className={td}>{decision.choice}</td>
          <td className={td}>{decision.alternatives.join(', ')}</td>
          <td className={td}>{decision.impact}</td>
          <td className={td}>{decision.sensitivity ? `${decision.sensitivity.checked ? 'Yes' : 'No'}: ${decision.sensitivity.summary}` : 'No'}</td>
        </tr>
      ))} />
      <Table caption="Issues" columns={['ID', 'Observation', 'Status', 'Resolution', 'Evidence']} rows={audit.issues.map((issue) => (
        <tr key={issue.id} id={ledgerAnchor(issue.id)}>
          <td className={`${td} font-mono text-[10px]`}>{issue.id}</td>
          <td className={td}>{issue.title}<span className="block text-textMuted">{issue.observation}</span></td>
          <td className={td}>{issue.status}</td>
          <td className={td}>{issue.resolution || '—'}</td>
          <td className={td}><Evidence refs={issue.evidence} fileUrl={fileUrl} /></td>
        </tr>
      ))} />
      <div className="text-xs">
        <button type="button" onClick={() => setShowChecklist((v) => !v)} aria-expanded={showChecklist} className="text-primary underline">
          {showChecklist ? 'Hide' : 'Show'} the standard checklist
        </button>
        {showChecklist && (
          <ul className="mt-2 space-y-1">
            {audit.checklist.map((item) => (
              <li key={item.key} id={item.entryId ? ledgerAnchor(item.entryId) : undefined}>
                <span className={`mr-2 inline-block w-28 rounded border px-1 text-center text-[10px] font-bold uppercase ${item.status === 'done' ? 'border-success/30 text-success' : item.status === 'missing' ? 'border-danger/30 text-danger' : 'border-border text-textMuted'}`}>{item.status.replace('_', ' ')}</span>
                <span className="text-text">{item.title}</span>
                {item.note ? <span className="text-textMuted"> — {item.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
