import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Boxes, CheckCircle2, Download, Loader2, XCircle } from 'lucide-react';
import { publicErrorMessage } from '../publicError';
import ReadableSteps from '../components/ReadableSteps';

// Human side of isolated agent development (docs/spec.md phase 4). A person
// picks which of their saved analyses an agent may read and how many runs it
// gets. The agent's R scripts run with no network on a read-only copy; every
// output is a draft here until a person promotes or discards it.

const NO_API = Object.freeze({});
const STATE_TONE = {
  draft_ready: 'border-success/30 bg-success/10 text-success',
  running: 'border-primary/30 bg-primary/10 text-primary',
  failed: 'border-danger/30 bg-danger/10 text-danger',
  quarantined: 'border-warning/40 bg-warning/10 text-text',
};
const STATE_LABEL = { draft_ready: 'draft ready', cancel_requested: 'canceling' };

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function TablePreview({ api, projectId, runId, name }) {
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.readAgentSandboxText?.(projectId, runId, name).then((t) => { if (live) setText(t); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, projectId, runId, name]);
  if (failed) return <p className="text-xs text-textMuted">Preview unavailable.</p>;
  if (text === null) return <Loader2 size={14} className="animate-spin text-textMuted" />;
  const lines = text.split(/\r?\n/).slice(0, 21);
  return <pre className="max-h-64 overflow-auto rounded border border-border bg-background p-2 text-[11px] text-text">{lines.join('\n')}{text.split(/\r?\n/).length > 21 ? '\n…' : ''}</pre>;
}

function RunOutputs({ api, projectId, run }) {
  const [preview, setPreview] = useState(null);
  if (!run.files.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-bold text-textMuted">Outputs (draft)</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {run.files.filter((f) => f.kind === 'image').map((f) => (
          <figure key={f.name} className="rounded border border-border bg-background p-2">
            <img src={api.agentSandboxFileUrl?.(projectId, run.id, f.name)} alt={f.name} className="max-h-80 w-full object-contain" />
            <figcaption className="mt-1 text-[11px] text-textMuted">{f.name}</figcaption>
          </figure>
        ))}
      </div>
      <ul className="space-y-1 text-xs">
        {run.files.filter((f) => f.kind !== 'image').map((f) => (
          <li key={f.name} className="space-y-1">
            <span className="flex flex-wrap items-center gap-2">
              <code className="text-text">{f.name}</code>
              <span className="text-textMuted">{formatBytes(f.sizeBytes)}</span>
              {f.kind === 'text' && <button type="button" onClick={() => setPreview(preview === f.name ? null : f.name)} className="text-primary underline">{preview === f.name ? 'Hide' : 'Preview'}</button>}
              <a href={api.agentSandboxFileUrl?.(projectId, run.id, f.name, { download: true })} className="inline-flex items-center gap-1 text-primary underline"><Download size={12} /> Download</a>
            </span>
            {preview === f.name && <TablePreview api={api} projectId={projectId} runId={run.id} name={f.name} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AgentSandboxes({ projectId, role, userId, onChanged, onOpenResult }) {
  const api = window.electronAPI || NO_API;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const [sandboxes, setSandboxes] = useState([]);
  const [objects, setObjects] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState({});
  const [form, setForm] = useState({ name: '', objective: '', objectIds: [], maxRuns: 20 });
  const canWrite = role === 'owner' || role === 'admin' || role === 'analyst';

  const load = useCallback(async () => {
    if (!projectId || !api.listAgentSandboxes) return;
    try {
      const [list, objs] = await Promise.all([
        api.listAgentSandboxes(projectId),
        api.listProjectAnalysisObjects ? api.listProjectAnalysisObjects(projectId).catch(() => []) : Promise.resolve([]),
      ]);
      if (!mounted.current) return;
      setSandboxes(list?.sandboxes || []);
      const all = Array.isArray(objs) ? objs : objs?.analysisObjects || objs?.objects || [];
      setObjects(all.filter((o) => userId === undefined || o.ownerUserId === undefined || Number(o.ownerUserId) === Number(userId)));
    } catch (err) {
      if (mounted.current) setError(publicErrorMessage(err?.message, 'Agent sandboxes are unavailable.'));
    }
  }, [api, projectId, userId]);

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return; }
    try {
      const res = await api.getAgentSandbox(projectId, id);
      if (mounted.current) setDetail(res?.sandbox || null);
    } catch (err) {
      if (mounted.current) setError(publicErrorMessage(err?.message, 'The sandbox could not be loaded.'));
    }
  }, [api, projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDetail(openId); }, [loadDetail, openId]);

  const act = async (key, action) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
      if (openId) await loadDetail(openId);
      onChanged?.();
    } catch (err) {
      setError(publicErrorMessage(err?.message, 'The request was rejected.'));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const create = (event) => {
    event.preventDefault();
    act('create', async () => {
      const res = await api.createAgentSandbox(projectId, {
        name: form.name, objective: form.objective, analysisObjectIds: form.objectIds, maxRuns: Number(form.maxRuns),
      });
      setForm({ name: '', objective: '', objectIds: [], maxRuns: 20 });
      if (res?.sandbox?.id) setOpenId(res.sandbox.id);
    });
  };

  if (!api.listAgentSandboxes) return null;
  return (
    <section className="space-y-4" aria-label="Agent sandboxes">
      <div>
        <h3 className="flex items-center gap-2 text-lg font-bold text-text"><Boxes size={18} className="text-primary" /> Sandboxes for the agent's own code</h3>
        <p className="mt-1 text-sm text-textMuted">An agent with the sandbox capability can write and run its own R scripts here. Each run gets a read-only copy of the analysis you pick, no network, and fixed CPU, memory, time, and output limits. Nothing it produces changes existing work: outputs stay drafts until you promote one, which publishes it to the project as a branch.</p>
      </div>
      {error && <p role="alert" className="rounded border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}

      {canWrite && (
        <form onSubmit={create} aria-label="Create a sandbox" className="space-y-3 rounded-lg border border-border bg-surface p-4 text-sm">
          <h4 className="font-bold text-text">New sandbox</h4>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs font-bold text-textMuted">Name
              <input required maxLength={200} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Max runs
              <input type="number" min={1} max={500} value={form.maxRuns} onChange={(e) => setForm((f) => ({ ...f, maxRuns: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted md:col-span-2">What should the agent investigate?
              <textarea maxLength={4000} rows={2} value={form.objective} onChange={(e) => setForm((f) => ({ ...f, objective: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-xs font-bold text-textMuted">Analyses the agent may read (saved versions only)</legend>
            {objects.length === 0 ? <p className="text-xs text-textMuted">You have no saved analyses in this project yet.</p> : (
              <div className="max-h-40 space-y-1 overflow-auto">
                {objects.map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-xs text-text">
                    <input type="checkbox" checked={form.objectIds.includes(o.id)} onChange={(e) => setForm((f) => ({
                      ...f, objectIds: e.target.checked ? [...f.objectIds, o.id].slice(0, 10) : f.objectIds.filter((x) => x !== o.id),
                    }))} />
                    {o.displayName || o.name || o.id}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <button type="submit" disabled={Boolean(busy) || !form.name.trim() || form.objectIds.length === 0} className="btn btn-primary text-sm">
            {busy === 'create' ? <Loader2 size={16} className="animate-spin" /> : null} Create sandbox
          </button>
        </form>
      )}

      {sandboxes.length === 0 ? <p className="text-sm text-textMuted">No sandboxes yet.</p> : (
        <ul className="space-y-2">
          {sandboxes.map((s) => (
            <li key={s.id} className="rounded-lg border border-border bg-surface p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => setOpenId(openId === s.id ? null : s.id)} aria-expanded={openId === s.id} className="text-left font-bold text-text underline-offset-2 hover:underline">
                  {s.name} <span className="ml-1 text-xs font-normal uppercase text-textMuted">{s.status}</span>
                </button>
                <span className="text-xs text-textMuted">{s.runCount} of {s.maxRuns} runs{s.draftsAwaitingReview ? ` · ${s.draftsAwaitingReview} draft${s.draftsAwaitingReview === 1 ? '' : 's'} to review` : ''}</span>
              </div>
              {s.objective && <p className="mt-1 text-xs text-textMuted">{s.objective}</p>}
              {openId === s.id && detail?.id === s.id && (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-textMuted">Reads: {detail.inputs.map((i) => i.displayName || i.analysisObjectId).join(', ')} · {detail.runtime.network === 'none' ? 'no network' : detail.runtime.network}</p>
                  {s.status === 'open' && canWrite && (
                    <button type="button" disabled={Boolean(busy)} onClick={() => act(`close:${s.id}`, () => api.closeAgentSandbox(projectId, s.id))} className="btn btn-secondary text-xs">Close sandbox</button>
                  )}
                  {detail.runs.length === 0 ? <p className="text-xs text-textMuted">The agent has not run anything here yet.</p> : detail.runs.map((run) => (
                    <article key={run.id} aria-label={`Run ${run.runNumber}`} className="space-y-3 rounded border border-border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-bold text-text">Run {run.runNumber}: {run.title} <span className="font-normal text-textMuted">by {run.agent.displayName}</span></p>
                        <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${STATE_TONE[run.state] || 'border-border text-textMuted'}`}>{STATE_LABEL[run.state] || run.state}</span>
                      </div>
                      {run.error && <p className="text-xs text-danger">{run.error.message}</p>}
                      {run.steps && <ReadableSteps steps={run.steps} label={`Code for run ${run.runNumber}`} />}
                      {run.console?.length > 0 && (
                        <details className="text-xs"><summary className="cursor-pointer text-textMuted">R console</summary>
                          <pre className="mt-1 max-h-48 overflow-auto rounded border border-border bg-background p-2 text-[11px] text-text">{run.console.join('\n')}</pre>
                        </details>
                      )}
                      <RunOutputs api={api} projectId={projectId} run={run} />
                      {run.review.state !== 'draft' ? (
                        <p className={`inline-flex items-center gap-1 text-xs font-bold ${run.review.state === 'promoted' ? 'text-success' : 'text-textMuted'}`}>
                          {run.review.state === 'promoted' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                          {run.review.state === 'promoted' ? 'Promoted to the project' : 'Discarded'}{run.review.note ? `: ${run.review.note}` : ''}
                        </p>
                      ) : run.state === 'draft_ready' && canWrite ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input aria-label={`Review note for run ${run.runNumber}`} placeholder="Note (optional)" maxLength={2000} value={notes[run.id] || ''}
                            onChange={(e) => setNotes((n) => ({ ...n, [run.id]: e.target.value }))} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-text" />
                          <button type="button" disabled={Boolean(busy)} onClick={() => act(`promote:${run.id}`, () => api.reviewAgentSandboxRun(projectId, run.id, 'promoted', notes[run.id]))} className="btn btn-primary text-xs">Promote</button>
                          <button type="button" disabled={Boolean(busy)} onClick={() => act(`discard:${run.id}`, () => api.reviewAgentSandboxRun(projectId, run.id, 'discarded', notes[run.id]))} className="btn btn-secondary text-xs">Discard</button>
                          {run.resultAnalysisObjectId && onOpenResult && <button type="button" onClick={() => onOpenResult(run.resultAnalysisObjectId)} className="btn btn-secondary text-xs">Open in workspace</button>}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
