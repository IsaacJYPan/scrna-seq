import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, FlaskConical, Loader2, ShieldCheck } from 'lucide-react';
import { publicErrorMessage } from '../publicError';

// Human side of approved agent execution (docs/spec.md phase 2): approve exact
// workflow releases, define studies agents may work in, and accept results.
// Every rule is enforced server-side; this panel only displays and requests.

const NO_API = Object.freeze({});
const STATE_TONE = {
  candidate_ready: 'border-success/30 bg-success/10 text-success',
  queued: 'border-border text-textMuted',
  running: 'border-primary/30 bg-primary/10 text-primary',
  quarantined: 'border-warning/40 bg-warning/10 text-text',
  failed: 'border-danger/30 bg-danger/10 text-danger',
};

function parseValues(text, spec) {
  return text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    if (spec?.type === 'enum') {
      const match = spec.values.find((value) => String(value) === part);
      return match === undefined ? part : match;
    }
    if (spec?.type === 'bool') return part === 'true';
    const n = Number(part);
    return Number.isFinite(n) ? n : part;
  });
}

export default function AgentWorkflows({ projectId, role, onChanged }) {
  const api = window.electronAPI || NO_API;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const [releases, setReleases] = useState([]);
  const [canApprove, setCanApprove] = useState(false);
  const [studies, setStudies] = useState([]);
  const [runs, setRuns] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', releaseId: '', datasetIds: [], param: '', values: '', maxTrials: 4, executionTarget: 'local' });
  const [slurm, setSlurm] = useState(null);
  const canWrite = role === 'owner' || role === 'admin' || role === 'analyst';

  const load = useCallback(async () => {
    if (!projectId || !api.listWorkflowReleases) return;
    try {
      const [rel, st, rn, ds] = await Promise.all([
        api.listWorkflowReleases(projectId), api.listStudies(projectId), api.listAgentRuns(projectId),
        api.listDatasets ? api.listDatasets(projectId, { fileType: 'tenx_h5' }) : Promise.resolve([]),
      ]);
      if (!mounted.current) return;
      setReleases(rel?.releases || []);
      setCanApprove(Boolean(rel?.canApprove));
      setStudies(st?.studies || []);
      setRuns(rn?.runs || []);
      setDatasets(Array.isArray(ds) ? ds.filter((d) => d.uploadStatus === 'uploaded') : []);
      if (api.listComputeTargets) {
        const targets = await api.listComputeTargets(projectId).catch(() => null);
        if (mounted.current) setSlurm((targets?.targets || []).find((t) => t.name === 'slurm' && t.available) || null);
      }
    } catch (err) {
      if (mounted.current) setError(publicErrorMessage(err?.message, 'Approved workflows are unavailable.'));
    }
  }, [api, projectId]);

  useEffect(() => { load(); }, [load]);

  const act = async (key, action) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      setError(publicErrorMessage(err?.message, 'The request was rejected.'));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const approved = releases.filter((r) => r.approval);
  const selected = releases.find((r) => r.id === (form.releaseId || approved[0]?.id));
  const createStudy = (event) => {
    event.preventDefault();
    const body = {
      name: form.name, releaseId: selected?.id, datasetIds: form.datasetIds, maxTrials: Number(form.maxTrials),
      ...(form.executionTarget === 'slurm' ? { executionTarget: 'slurm' } : {}),
    };
    if (form.param && form.values.trim()) {
      body.variations = { [form.param]: parseValues(form.values, selected?.parameterSchema?.[form.param]) };
    }
    act('study', async () => {
      await api.createStudy(projectId, body);
      setForm((f) => ({ ...f, name: '', values: '', datasetIds: [] }));
    });
  };

  const acceptedFor = (studyId) => studies.find((s) => s.id === studyId)?.acceptedRunId ?? null;

  return (
    <section className="space-y-5" aria-label="Approved workflows">
      <div>
        <h3 className="flex items-center gap-2 text-lg font-bold text-text"><FlaskConical size={18} className="text-primary" /> Approved workflows and studies</h3>
        <p className="mt-1 text-sm text-textMuted">Agents can only run approved releases inside a study you define: exact inputs, the parameter options they may choose, a trial limit, and a compute budget. Results stay candidates until a person accepts one.</p>
      </div>
      {error && <p role="alert" className="rounded border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}

      <div className="space-y-2">
        <h4 className="text-sm font-bold text-text">Workflow releases</h4>
        {releases.map((r) => (
          <article key={r.id} className="rounded-lg border border-border bg-surface p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold text-text">{r.title} <span className="text-xs text-textMuted">v{r.version}</span></p>
                <p className="mt-1 break-all text-xs text-textMuted">Digest {r.digest}</p>
                <p className="text-xs text-textMuted">Pinned files: {r.handler.map((h) => h.path).join(', ')} · Reserves {r.resources.cpus} CPU, {Math.round(r.resources.memoryMiB / 1024)} GiB, {r.resources.maxWallSeconds / 60} min per run</p>
              </div>
              {r.approval ? (
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-success"><ShieldCheck size={14} /> Approved for this project</span>
                  {canApprove && <button type="button" disabled={Boolean(busy)} onClick={() => act(`revoke:${r.id}`, () => api.revokeWorkflowApproval(projectId, r.approval.id))} className="btn btn-secondary text-sm text-danger">Revoke</button>}
                </div>
              ) : canApprove ? (
                <button type="button" disabled={Boolean(busy)} onClick={() => act(`approve:${r.id}`, () => api.approveWorkflowRelease(projectId, r.id, r.digest))} className="btn btn-primary text-sm">Approve this exact release</button>
              ) : <span className="text-xs text-textMuted">Not approved. Owners and admins can approve.</span>}
            </div>
          </article>
        ))}
      </div>

      {canWrite && approved.length > 0 && (
        <form onSubmit={createStudy} aria-label="Create a study" className="space-y-3 rounded-lg border border-border bg-surface p-4 text-sm">
          <h4 className="font-bold text-text">New study</h4>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs font-bold text-textMuted">Study name
              <input required maxLength={200} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Approved release
              <select value={selected?.id || ''} onChange={(e) => setForm((f) => ({ ...f, releaseId: e.target.value, param: '' }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                {approved.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </label>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-xs font-bold text-textMuted">Input datasets (exact versions are pinned)</legend>
            {datasets.length === 0 && <p className="text-xs text-textMuted">No uploaded 10x HDF5 datasets in this project.</p>}
            {datasets.map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={form.datasetIds.includes(d.id)} onChange={() => setForm((f) => ({
                  ...f, datasetIds: f.datasetIds.includes(d.id) ? f.datasetIds.filter((x) => x !== d.id) : [...f.datasetIds, d.id],
                }))} />
                {d.originalFilename || d.id}
              </label>
            ))}
          </fieldset>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="space-y-1 text-xs font-bold text-textMuted">Parameter the agent may vary
              <select value={form.param} onChange={(e) => setForm((f) => ({ ...f, param: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                <option value="">None (all fixed at defaults)</option>
                {Object.keys(selected?.parameterSchema || {}).map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Allowed values (comma-separated)
              <input value={form.values} disabled={!form.param} onChange={(e) => setForm((f) => ({ ...f, values: e.target.value }))} placeholder="0.5, 0.8, 1.2" className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
            {slurm && (
              <label className="space-y-1 text-xs font-bold text-textMuted">Runs on
                <select value={form.executionTarget} onChange={(e) => setForm((f) => ({ ...f, executionTarget: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                  <option value="local">This installation</option>
                  <option value="slurm">Slurm cluster{slurm.partition ? ` (${slurm.partition})` : ''}</option>
                </select>
              </label>
            )}
            <label className="space-y-1 text-xs font-bold text-textMuted">Max trials
              <input type="number" min={1} max={100} value={form.maxTrials} onChange={(e) => setForm((f) => ({ ...f, maxTrials: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
          </div>
          <p className="text-xs text-textMuted">Every other parameter is fixed. The agent cannot change the inputs, the method, or the study.</p>
          <button type="submit" disabled={Boolean(busy) || !form.name.trim() || form.datasetIds.length === 0} className="btn btn-primary text-sm">
            {busy === 'study' ? <Loader2 size={16} className="animate-spin" /> : null} Create study
          </button>
        </form>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-bold text-text">Studies</h4>
        {studies.length === 0 ? <p className="text-sm text-textMuted">No studies yet.</p> : studies.map((s) => (
          <article key={s.id} className="rounded-lg border border-border bg-surface p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold text-text">{s.name} <span className="ml-1 text-xs uppercase text-textMuted">{s.status}</span></p>
              {s.status === 'open' && canWrite && <button type="button" disabled={Boolean(busy)} onClick={() => act(`close:${s.id}`, () => api.closeStudy(projectId, s.id))} className="btn btn-secondary text-sm">Close study</button>}
            </div>
            <p className="mt-1 text-xs text-textMuted">Varies: {Object.entries(s.variations).map(([k, v]) => `${k} ∈ {${v.join(', ')}}`).join('; ') || 'nothing'} · Max {s.maxTrials} trials · {Math.round(s.maxCpuSeconds / 3600)} CPU-hours · Runs on {s.executionTarget === 'slurm' ? 'Slurm' : 'this installation'}</p>
          </article>
        ))}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-bold text-text">Agent runs</h4>
        {runs.length === 0 ? <p className="text-sm text-textMuted">No agent runs yet.</p> : runs.map((r) => (
          <article key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 text-sm">
            <div className="min-w-0">
              <p className="text-text"><span className="font-bold">{r.studyName}</span> · trial {r.trialNumber} · {r.agent.displayName}</p>
              <p className="text-xs text-textMuted">Choices: {Object.entries(r.choices).map(([k, v]) => `${k}=${v}`).join(', ') || 'defaults'} · Reserved {r.reservation.cpuSeconds / 3600} CPU-h · {r.executionTarget === 'slurm' ? 'Slurm' : 'local'}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${STATE_TONE[r.state] || STATE_TONE.queued}`}>{r.state.replace('_', ' ')}</span>
              {r.acceptance === 'accepted' && <span className="inline-flex items-center gap-1 text-xs font-bold text-success"><CheckCircle2 size={14} /> Accepted</span>}
              {r.state === 'candidate_ready' && r.acceptance !== 'accepted' && canWrite && (
                <button type="button" disabled={Boolean(busy)} onClick={() => act(`accept:${r.id}`, () => api.acceptAgentRun(projectId, r.id, acceptedFor(r.studyId)))} className="btn btn-primary text-sm">Accept this result</button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
