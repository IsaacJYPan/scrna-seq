import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { publicErrorMessage } from '../publicError';
import AgentRunNotebook from '../components/AgentRunNotebook';

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

const METRIC_LABELS = {
  nCells: 'Cells', nFeatures: 'Features', nClusters: 'Clusters', nVariableFeatures: 'Variable features',
  preFilterCells: 'Cells before QC', postFilterCells: 'Cells after QC', nGroups: 'Groups', nMarkersTotal: 'Markers',
  n_cells: 'Cells', n_features: 'Features', n_clusters: 'Clusters', cells: 'Cells', clusters: 'Clusters',
  resolution: 'Resolution', used_seed: 'Seed', normalization_method: 'Normalization',
};
const METRIC_ORDER = ['nCells', 'n_cells', 'cells', 'nFeatures', 'n_features', 'nClusters', 'n_clusters', 'clusters', 'nGroups', 'nMarkersTotal'];
// Summary fields a selection rule can rank by, per workflow job type.
const RULE_METRICS = {
  'seurat.pipeline.v1': [['nClusters', 'clusters'], ['postFilterCells', 'cells kept after QC'], ['nVariableFeatures', 'variable features']],
  'deg.find_markers.v1': [['nMarkersTotal', 'marker genes'], ['nGroups', 'groups']],
};

// Mirrors the server's selection: best finished trial by the study's rule, earliest on ties.
function pickByRule(rule, runs) {
  if (!rule) return null;
  let best = null;
  for (const r of runs) {
    const v = r.state === 'candidate_ready' ? r.summary?.[rule.metric] : undefined;
    if (typeof v !== 'number') continue;
    if (!best || (rule.goal === 'min' ? v < best.v : v > best.v) || (v === best.v && r.trialNumber < best.trial)) best = { id: r.id, v, trial: r.trialNumber };
  }
  return best?.id || null;
}

function groupByStudy(runs) {
  const groups = new Map();
  for (const r of runs) {
    if (!groups.has(r.studyId)) groups.set(r.studyId, []);
    groups.get(r.studyId).push(r);
  }
  for (const list of groups.values()) list.sort((a, b) => a.trialNumber - b.trialNumber);
  return [...groups.entries()];
}

// Show the summary fields that differ between trials or that are always worth comparing.
function metricColumns(runs) {
  const keys = new Set(runs.flatMap((r) => Object.keys(r.summary || {})));
  const shown = METRIC_ORDER.filter((k) => keys.has(k));
  for (const k of keys) {
    if (shown.includes(k) || shown.length >= 6) continue;
    const values = new Set(runs.filter((r) => r.summary).map((r) => String(r.summary[k])));
    if (values.size > 1) shown.push(k);
  }
  return shown;
}

function formatMetric(value) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(3);
  return String(value);
}

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

export default function AgentWorkflows({ projectId, role, onChanged, onOpenResult }) {
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
  const [form, setForm] = useState({ name: '', releaseId: '', datasetIds: [], sourceStudyId: '', param: '', values: '', fixed: {}, sheet: {}, maxTrials: 4, executionTarget: 'local', ruleMetric: '', ruleGoal: 'max' });
  const [slurm, setSlurm] = useState(null);
  const [steps, setSteps] = useState({});
  const toggleSteps = async (releaseId) => {
    if (steps[releaseId]) { setSteps(({ [releaseId]: _gone, ...rest }) => rest); return; }
    try {
      const res = await api.getWorkflowReleaseSteps(projectId, releaseId);
      if (mounted.current) setSteps((s) => ({ ...s, [releaseId]: res }));
    } catch (err) {
      if (mounted.current) setError(publicErrorMessage(err?.message, 'The analysis steps could not be loaded.'));
    }
  };
  const canWrite = role === 'owner' || role === 'admin' || role === 'analyst';

  const load = useCallback(async () => {
    if (!projectId || !api.listWorkflowReleases) return;
    try {
      const [rel, st, rn, ds] = await Promise.all([
        api.listWorkflowReleases(projectId), api.listStudies(projectId), api.listAgentRuns(projectId),
        api.listDatasets ? api.listDatasets(projectId) : Promise.resolve([]),
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
  // A follow-on release runs on the accepted result of a study of another release.
  const composedInput = selected?.inputs?.[0]?.kind === 'analysis_object' ? selected.inputs[0] : null;
  const composedFrom = composedInput ? (Array.isArray(composedInput.fromReleases) ? composedInput.fromReleases : []) : null;
  const releaseKey = (id) => releases.find((r) => r.id === id)?.key;
  const sourceStudies = composedFrom ? studies.filter((s) => s.acceptedRunId && composedFrom.includes(releaseKey(s.releaseId))) : [];
  const studyName = (id) => studies.find((s) => s.id === id)?.name || id;
  const slurmAllowed = slurm && selected?.jobType === 'seurat.pipeline.v1';
  const inputFileTypes = selected?.inputs?.[0]?.fileTypes || ['tenx_h5'];
  const inputDatasets = datasets.filter((d) => !d.fileType || inputFileTypes.includes(d.fileType));
  const schemaEntries = Object.entries(selected?.parameterSchema || {});
  // Design choices (columns, gene lists, label maps) are fixed by a person.
  const designParams = schemaEntries.filter(([, spec]) => spec.role === 'design');
  const variableParams = schemaEntries.filter(([, spec]) => spec.role !== 'design').map(([name]) => name);
  const ruleMetrics = RULE_METRICS[selected?.jobType]
    || (selected?.method?.metrics || []).map((m) => [m.key, m.label]);
  const createStudy = (event) => {
    event.preventDefault();
    const body = {
      name: form.name, releaseId: selected?.id, maxTrials: Number(form.maxTrials),
      ...(composedFrom ? { sourceStudyId: form.sourceStudyId } : { datasetIds: form.datasetIds }),
      ...(slurmAllowed && form.executionTarget === 'slurm' ? { executionTarget: 'slurm' } : {}),
      ...(form.ruleMetric ? { selectionRule: { metric: form.ruleMetric, goal: form.ruleGoal } } : {}),
    };
    if (form.param && form.values.trim()) {
      body.variations = { [form.param]: parseValues(form.values, selected?.parameterSchema?.[form.param]) };
    }
    const fixed = {};
    for (const [name, spec] of designParams) {
      if (spec.type === 'sampleSheet') {
        fixed[name] = form.datasetIds.map((id) => {
          const row = form.sheet[id] || {};
          const entry = { datasetId: id, sampleName: row.sampleName || '', conditionName: row.conditionName || '' };
          if (row.donorCode) entry.donorCode = row.donorCode;
          if (row.batch) entry.batch = row.batch;
          return entry;
        });
        continue;
      }
      const raw = form.fixed[name];
      if (raw === undefined || raw === '') continue;
      if (spec.type === 'enum') fixed[name] = spec.values.find((v) => String(v) === raw) ?? raw;
      else if (['int', 'intOrNull', 'number'].includes(spec.type)) fixed[name] = Number(raw);
      else if (spec.type === 'bool') fixed[name] = raw === 'true';
      else fixed[name] = raw;
    }
    if (Object.keys(fixed).length) body.fixedParameters = fixed;
    act('study', async () => {
      await api.createStudy(projectId, body);
      setForm((f) => ({ ...f, name: '', values: '', fixed: {}, sheet: {}, datasetIds: [], sourceStudyId: '' }));
    });
  };

  const acceptedFor = (studyId) => studies.find((s) => s.id === studyId)?.acceptedRunId ?? null;

  return (
    <section className="space-y-5" aria-label="Approved workflows">
      <div>
        <h3 className="flex items-center gap-2 text-lg font-bold text-text">Approved workflows and studies</h3>
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
                {r.readableSource && api.getWorkflowReleaseSteps && (
                  <button type="button" onClick={() => toggleSteps(r.id)} aria-expanded={Boolean(steps[r.id])} className="mt-1 text-xs text-primary underline">
                    {steps[r.id] ? 'Hide the analysis steps' : 'Read the analysis steps'}
                  </button>
                )}
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
            {steps[r.id] && (
              <div className="mt-3">
                <p className="mb-1 text-xs text-textMuted">{steps[r.id].source?.path} · SHA-256 {steps[r.id].source?.sha256?.slice(0, 12)}…</p>
                <AgentRunNotebook run={{ id: r.id, runNumber: 0, title: r.title, steps: steps[r.id].steps, files: [], scriptSha256: steps[r.id].source?.sha256 }}
                  projectId={projectId} label={`Analysis steps of ${r.title}`} />
              </div>
            )}
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
              <select value={selected?.id || ''} onChange={(e) => setForm((f) => ({ ...f, releaseId: e.target.value, param: '', fixed: {}, ruleMetric: '' }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                {approved.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </label>
          </div>
          {selected?.method?.provenance && (
            <div className="rounded border border-border bg-background px-3 py-2 text-xs text-textMuted">
              <p>Follows <a className="underline" href={selected.method.provenance.url} target="_blank" rel="noreferrer">{selected.method.provenance.title}</a> ({selected.method.provenance.reviewedAgainst}). {selected.method.provenance.citation}</p>
              {selected.method.deviations?.length > 0 && (
                <ul className="mt-1 list-disc pl-4">{selected.method.deviations.map((d) => <li key={d}>{d}</li>)}</ul>
              )}
            </div>
          )}
          {composedFrom ? (
            <label className="block space-y-1 text-xs font-bold text-textMuted">Builds on the accepted result of
              <select value={form.sourceStudyId} onChange={(e) => setForm((f) => ({ ...f, sourceStudyId: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                <option value="">Choose a study…</option>
                {sourceStudies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {sourceStudies.length === 0 && <span className="block font-normal">No study of {composedFrom.map((key) => releases.find((r) => r.key === key)?.title || key).join(', ')} has an accepted result yet.</span>}
            </label>
          ) : (
          <fieldset className="space-y-1">
            <legend className="text-xs font-bold text-textMuted">Input datasets (exact versions are pinned)</legend>
            {inputDatasets.length === 0 && <p className="text-xs text-textMuted">No uploaded {inputFileTypes.includes('visium_zip') ? 'Visium bundles' : '10x HDF5 files'} in this project.</p>}
            {inputDatasets.map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={form.datasetIds.includes(d.id)} onChange={() => setForm((f) => ({
                  ...f, datasetIds: f.datasetIds.includes(d.id) ? f.datasetIds.filter((x) => x !== d.id) : [...f.datasetIds, d.id],
                }))} />
                {d.originalFilename || d.id}
              </label>
            ))}
          </fieldset>
          )}
          {designParams.length > 0 && (
            <fieldset className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <legend className="text-xs font-bold text-textMuted">Study design (fixed for every trial)</legend>
              {designParams.filter(([, spec]) => spec.type === 'sampleSheet').map(([name]) => (
                <div key={name} className="space-y-1 md:col-span-2">
                  <p className="text-xs text-textMuted">Sample sheet: one row per selected dataset, in order. The first is the primary sample.</p>
                  {form.datasetIds.map((id) => {
                    const row = form.sheet[id] || {};
                    const set = (field) => (e) => setForm((f) => ({ ...f, sheet: { ...f.sheet, [id]: { ...(f.sheet[id] || {}), [field]: e.target.value } } }));
                    const label = datasets.find((d) => d.id === id)?.originalFilename || id;
                    return (
                      <div key={id} className="grid grid-cols-1 gap-2 md:grid-cols-5">
                        <span className="self-center text-xs text-text">{label}</span>
                        <input aria-label={`Sample name for ${label}`} placeholder="Sample" value={row.sampleName || ''} onChange={set('sampleName')} className="rounded border border-border bg-background px-2 py-1 text-sm" />
                        <input aria-label={`Condition for ${label}`} placeholder="Condition" value={row.conditionName || ''} onChange={set('conditionName')} className="rounded border border-border bg-background px-2 py-1 text-sm" />
                        <input aria-label={`Donor for ${label}`} placeholder="Donor (optional)" value={row.donorCode || ''} onChange={set('donorCode')} className="rounded border border-border bg-background px-2 py-1 text-sm" />
                        <input aria-label={`Batch for ${label}`} placeholder="Batch (optional)" value={row.batch || ''} onChange={set('batch')} className="rounded border border-border bg-background px-2 py-1 text-sm" />
                      </div>
                    );
                  })}
                </div>
              ))}
              {designParams.filter(([, spec]) => spec.type !== 'sampleSheet').map(([name, spec]) => (
                <label key={name} className="space-y-1 text-xs font-bold text-textMuted">{spec.label || name}
                  {spec.type === 'enum' ? (
                    <select value={form.fixed[name] ?? (spec.default === undefined ? '' : String(spec.default))} onChange={(e) => setForm((f) => ({ ...f, fixed: { ...f.fixed, [name]: e.target.value } }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                      {spec.default === undefined && <option value="">Choose…</option>}
                      {spec.values.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                    </select>
                  ) : (
                    <input value={form.fixed[name] ?? ''} maxLength={spec.maxLength || 200} placeholder={String(spec.default ?? '')} onChange={(e) => setForm((f) => ({ ...f, fixed: { ...f.fixed, [name]: e.target.value } }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
                  )}
                </label>
              ))}
            </fieldset>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <label className="space-y-1 text-xs font-bold text-textMuted">Parameter the agent may vary
              <select value={form.param} onChange={(e) => setForm((f) => ({ ...f, param: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                <option value="">None (all fixed at defaults)</option>
                {variableParams.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Allowed values (comma-separated)
              <input value={form.values} disabled={!form.param} onChange={(e) => setForm((f) => ({ ...f, values: e.target.value }))} placeholder="0.5, 0.8, 1.2" className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
            {slurmAllowed && (
              <label className="space-y-1 text-xs font-bold text-textMuted">Runs on
                <select value={form.executionTarget} onChange={(e) => setForm((f) => ({ ...f, executionTarget: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text">
                  <option value="local">This installation</option>
                  <option value="slurm">Slurm cluster{slurm.partition ? ` (${slurm.partition})` : ''}</option>
                </select>
              </label>
            )}
            <label className="space-y-1 text-xs font-bold text-textMuted">Recommend the trial with
              <span className="flex gap-2">
                <select aria-label="Selection goal" value={form.ruleGoal} disabled={!form.ruleMetric} onChange={(e) => setForm((f) => ({ ...f, ruleGoal: e.target.value }))} className="rounded border border-border bg-background px-2 py-2 text-sm font-normal text-text">
                  <option value="max">most</option>
                  <option value="min">fewest</option>
                </select>
                <select aria-label="Selection metric" value={form.ruleMetric} onChange={(e) => setForm((f) => ({ ...f, ruleMetric: e.target.value }))} className="w-full rounded border border-border bg-background px-2 py-2 text-sm font-normal text-text">
                  <option value="">No rule</option>
                  {ruleMetrics.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </span>
            </label>
            <label className="space-y-1 text-xs font-bold text-textMuted">Max trials
              <input type="number" min={1} max={100} value={form.maxTrials} onChange={(e) => setForm((f) => ({ ...f, maxTrials: e.target.value }))} className="w-full rounded border border-border bg-background px-3 py-2 text-sm font-normal text-text" />
            </label>
          </div>
          <p className="text-xs text-textMuted">Every other parameter is fixed. The agent cannot change the inputs, the method, or the study.</p>
          <button type="submit" disabled={Boolean(busy) || !form.name.trim() || (composedFrom ? !form.sourceStudyId : form.datasetIds.length === 0)} className="btn btn-primary text-sm">
            {busy === 'study' ? <Loader2 size={16} className="animate-spin" /> : null} Create study
          </button>
        </form>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-bold text-text">Studies</h4>
        {studies.length === 0 ? <p className="text-sm text-textMuted">No studies yet.</p> : studies.map((s) => (
          <article key={s.id} className="rounded-lg border border-border bg-surface p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold text-text">{s.name} <span className="ml-1 text-xs text-textMuted">{s.status}</span></p>
              {s.status === 'open' && canWrite && <button type="button" disabled={Boolean(busy)} onClick={() => act(`close:${s.id}`, () => api.closeStudy(projectId, s.id))} className="btn btn-secondary text-sm">Close study</button>}
            </div>
            <p className="mt-1 text-xs text-textMuted">Varies: {Object.entries(s.variations).map(([k, v]) => `${k} ∈ {${v.join(', ')}}`).join('; ') || 'nothing'} · Max {s.maxTrials} trials · {Math.round(s.maxCpuSeconds / 3600)} CPU-hours · Runs on {s.executionTarget === 'slurm' ? 'Slurm' : 'this installation'}{s.sourceStudyId ? ` · Builds on ${studyName(s.sourceStudyId)}` : ''}</p>
          </article>
        ))}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-bold text-text">Agent runs</h4>
        {runs.length === 0 ? <p className="text-sm text-textMuted">No agent runs yet.</p> : groupByStudy(runs).map(([studyId, studyRuns]) => {
          const study = studies.find((x) => x.id === studyId);
          const rule = study?.selectionRule || null;
          const metrics = metricColumns(studyRuns);
          if (rule && !metrics.includes(rule.metric)) metrics.unshift(rule.metric);
          const recommended = pickByRule(rule, studyRuns);
          const choiceKeys = [...new Set(studyRuns.flatMap((r) => Object.keys(r.choices || {})))];
          return (
            <article key={studyId} className="overflow-x-auto rounded-lg border border-border bg-surface p-4 text-sm">
              <p className="mb-2 font-bold text-text">{studyRuns[0].studyName} <span className="ml-1 text-xs font-normal text-textMuted">{studyRuns.length} trial{studyRuns.length === 1 ? '' : 's'}{rule ? ` · rule: ${rule.goal === 'min' ? 'fewest' : 'most'} ${METRIC_LABELS[rule.metric] || rule.metric}` : ''}</span></p>
              <table className="w-full min-w-[480px] text-left text-xs" aria-label={`Trials for ${studyRuns[0].studyName}`}>
                <thead className="text-textMuted">
                  <tr>
                    <th className="py-1 pr-3">Trial</th>
                    {choiceKeys.map((k) => <th key={k} className="py-1 pr-3">{k}</th>)}
                    {metrics.map((k) => <th key={k} className="py-1 pr-3">{METRIC_LABELS[k] || k}</th>)}
                    <th className="py-1 pr-3">Agent</th>
                    <th className="py-1 pr-3">State</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {studyRuns.map((r) => (
                    <tr key={r.id} className={`border-t border-border ${r.acceptance === 'accepted' ? 'bg-success/5' : ''}`}>
                      <td className="py-2 pr-3 font-bold text-text">{r.trialNumber}<span className="ml-1 font-normal text-textMuted">{r.executionTarget === 'slurm' ? 'Slurm' : 'local'}</span></td>
                      {choiceKeys.map((k) => <td key={k} className="py-2 pr-3 text-text">{r.choices?.[k] === undefined ? 'default' : String(r.choices[k])}</td>)}
                      {metrics.map((k) => <td key={k} className="py-2 pr-3 text-text">{formatMetric(r.summary?.[k])}</td>)}
                      <td className="py-2 pr-3 text-textMuted">{r.agent.displayName}</td>
                      <td className="py-2 pr-3"><span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATE_TONE[r.state] || STATE_TONE.queued}`}>{r.state.replace('_', ' ')}</span></td>
                      <td className="space-x-2 whitespace-nowrap py-2 text-right">
                        {recommended === r.id && <span className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Best by rule</span>}
                        {r.resultAnalysisObjectId && onOpenResult && (
                          <button type="button" onClick={() => onOpenResult(r.resultAnalysisObjectId)} className="btn btn-secondary text-xs">Open in workspace</button>
                        )}
                        {r.acceptance === 'accepted' && <span className="inline-flex items-center gap-1 font-bold text-success"><CheckCircle2 size={14} /> Accepted</span>}
                        {r.state === 'candidate_ready' && r.acceptance !== 'accepted' && canWrite && (
                          <button type="button" disabled={Boolean(busy)} onClick={() => act(`accept:${r.id}`, () => api.acceptAgentRun(projectId, r.id, acceptedFor(r.studyId)))} className="btn btn-primary text-xs">Accept this result</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          );
        })}
      </div>
    </section>
  );
}
