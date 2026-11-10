import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { CheckCircle2, Download, FileText, Loader2, MessageSquare } from 'lucide-react';
import { publicErrorMessage } from '../publicError';

// Review screen for reports an agent drafts (docs/spec.md phase 5). Each
// section version is reviewed on its own; a revision by the agent needs a new
// review. Only a person can finalize, and only when every section is approved.

const NO_API = Object.freeze({});
const STATUS = {
  approved: { label: 'Approved', tone: 'border-success/30 bg-success/10 text-success' },
  changes_requested: { label: 'Changes requested', tone: 'border-warning/40 bg-warning/10 text-text' },
  awaiting_review: { label: 'Awaiting review', tone: 'border-border text-textMuted' },
};

// Report text comes from an agent: render Markdown without raw HTML, and only
// allow links and images that stay inside this page.
function safeUrl(url) {
  return /^(https?:|mailto:|#)/i.test(String(url || '')) ? url : '';
}

function Section({ api, projectId, report, section, canWrite, busy, onReview }) {
  const [comment, setComment] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const status = STATUS[section.status] || STATUS.awaiting_review;
  const send = (decision) => onReview(section.id, decision, comment).then((ok) => { if (ok) setComment(''); });
  return (
    <article aria-label={`Section ${section.heading}`} className="space-y-3 rounded-lg border border-border bg-surface p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="font-bold text-text">{section.heading} <span className="ml-1 text-xs font-normal text-textMuted">version {section.version}</span></h5>
        <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${status.tone}`}>{status.label}</span>
      </div>
      <div className="prose prose-sm max-w-none text-text">
        <ReactMarkdown skipHtml urlTransform={safeUrl}>{section.body}</ReactMarkdown>
      </div>
      {section.figures.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {section.figures.map((figure) => (
            <figure key={`${figure.sandboxRunId}:${figure.file}`} className="rounded border border-border bg-background p-2">
              {/\.(png|svg)$/i.test(figure.file)
                ? <img src={api.agentSandboxFileUrl?.(projectId, figure.sandboxRunId, figure.file)} alt={figure.caption || figure.file} className="max-h-80 w-full object-contain" />
                : <a href={api.agentSandboxFileUrl?.(projectId, figure.sandboxRunId, figure.file, { download: true })} className="text-primary underline">{figure.file}</a>}
              <figcaption className="mt-1 text-[11px] text-textMuted">{figure.caption || figure.file} · sandbox run {figure.sandboxRunId}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {section.reviews.length > 0 && (
        <ul className="space-y-1 text-xs">
          {section.reviews.map((review) => (
            <li key={review.id} className="flex gap-2 text-textMuted">
              <MessageSquare size={12} className="mt-0.5 shrink-0" />
              <span><span className="font-bold text-text">{review.reviewer.displayName || 'Reviewer'}</span> {review.decision === 'approved' ? 'approved' : review.decision === 'changes_requested' ? 'requested changes' : 'commented'}{review.comment ? `: ${review.comment}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {section.history.length > 0 && (
        <div className="text-xs">
          <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-primary underline">{showHistory ? 'Hide' : 'Show'} {section.history.length} earlier version{section.history.length === 1 ? '' : 's'}</button>
          {showHistory && section.history.map((older) => (
            <div key={older.id} className="mt-2 rounded border border-border p-2">
              <p className="font-bold text-textMuted">Version {older.version}</p>
              <pre className="whitespace-pre-wrap text-[11px] text-text">{older.body}</pre>
              {older.reviews.map((review) => <p key={review.id} className="text-textMuted">{review.decision}: {review.comment}</p>)}
            </div>
          ))}
        </div>
      )}
      {canWrite && report.status === 'draft' && (
        <div className="space-y-2">
          <textarea aria-label={`Comment on ${section.heading}`} rows={2} maxLength={4000} value={comment} onChange={(e) => setComment(e.target.value)}
            placeholder="What should change? (required to request changes)" className="w-full rounded border border-border bg-background px-2 py-1 text-xs text-text" />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy) || section.status === 'approved'} onClick={() => send('approved')} className="btn btn-primary text-xs">Approve</button>
            <button type="button" disabled={Boolean(busy) || !comment.trim()} onClick={() => send('changes_requested')} className="btn btn-secondary text-xs">Request changes</button>
            <button type="button" disabled={Boolean(busy) || !comment.trim()} onClick={() => send('comment')} className="btn btn-secondary text-xs">Comment</button>
          </div>
        </div>
      )}
    </article>
  );
}

export default function AgentReports({ projectId, role }) {
  const api = window.electronAPI || NO_API;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const [reports, setReports] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const canWrite = role === 'owner' || role === 'admin' || role === 'analyst';

  const load = useCallback(async () => {
    if (!projectId || !api.listAgentReports) return;
    try {
      const res = await api.listAgentReports(projectId);
      if (mounted.current) setReports(res?.reports || []);
    } catch (err) {
      if (mounted.current) setError(publicErrorMessage(err?.message, 'Agent reports are unavailable.'));
    }
  }, [api, projectId]);
  const loadReport = useCallback(async (id) => {
    if (!id) { setReport(null); return; }
    try {
      const res = await api.getAgentReport(projectId, id);
      if (mounted.current) setReport(res?.report || null);
    } catch (err) {
      if (mounted.current) setError(publicErrorMessage(err?.message, 'The report could not be loaded.'));
    }
  }, [api, projectId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadReport(openId); }, [loadReport, openId]);

  const act = async (key, action) => {
    setBusy(key);
    setError(null);
    try {
      const res = await action();
      if (res?.report && mounted.current) setReport(res.report);
      await load();
      return true;
    } catch (err) {
      setError(publicErrorMessage(err?.message, 'The request was rejected.'));
      return false;
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  if (!api.listAgentReports) return null;
  const ready = report && report.sections.length > 0 && report.sections.every((s) => s.status === 'approved');
  return (
    <section className="space-y-4" aria-label="Agent reports">
      <div>
        <h3 className="flex items-center gap-2 text-lg font-bold text-text"><FileText size={18} className="text-primary" /> Reports drafted by agents</h3>
        <p className="mt-1 text-sm text-textMuted">Review each section. When the agent revises a section, the new version needs its own review; earlier versions and comments are kept. A report can be finalized once every section is approved.</p>
      </div>
      {error && <p role="alert" className="rounded border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
      {reports.length === 0 ? <p className="text-sm text-textMuted">No reports yet.</p> : (
        <ul className="space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)} aria-expanded={openId === r.id} className="text-left font-bold text-text hover:underline">
                  {r.title}
                </button>
                <span className="text-xs text-textMuted">{r.status === 'finalized' ? 'Finalized' : `${r.approvedSections} of ${r.sectionCount} sections approved`} · {r.agent.displayName}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {report && openId === report.id && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-base font-bold text-text">{report.title}</h4>
            <div className="flex flex-wrap items-center gap-2">
              <a href={api.agentReportExportUrl?.(projectId, report.id)} className="btn btn-secondary text-xs"><Download size={14} /> Download Markdown</a>
              {report.status === 'finalized'
                ? <span className="inline-flex items-center gap-1 text-xs font-bold text-success"><CheckCircle2 size={14} /> Finalized</span>
                : canWrite && <button type="button" disabled={Boolean(busy) || !ready} onClick={() => act('finalize', () => api.finalizeAgentReport(projectId, report.id))} className="btn btn-primary text-xs">
                  {busy === 'finalize' ? <Loader2 size={14} className="animate-spin" /> : null} Finalize report
                </button>}
            </div>
          </div>
          {report.sections.length === 0 ? <p className="text-sm text-textMuted">The agent has not written any sections yet.</p> : report.sections.map((section) => (
            <Section key={section.id} api={api} projectId={projectId} report={report} section={section} canWrite={canWrite} busy={busy}
              onReview={(sectionId, decision, comment) => act(`review:${sectionId}`, () => api.reviewAgentReportSection(projectId, report.id, sectionId, decision, comment))} />
          ))}
        </div>
      )}
    </section>
  );
}
