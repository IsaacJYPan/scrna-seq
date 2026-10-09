import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getExecutionEnvironment, getExecutionHistory, listExecutionHistory } from '../executions/executionHistoryApi';
import { artifactImageUrl, getArtifactVersion, previewArtifactVersion } from '../artifacts/artifactApi';
import ExecutionTargetEvidence from './ExecutionTargetEvidence';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { TARGET_DISCONNECTED_MESSAGE } from '../runtime/executionTarget';

const kinds = { all: 'All executions', guided: 'Guided jobs', workflow: 'Recipe steps', 'expert-r': 'Expert R jobs', 'live-r': 'Live R changes', 'r-console':'Private R console', provenance: 'Imported provenance' };
const date = value => value ? new Date(value).toLocaleString() : 'Not recorded';
const precision = value => String(value || 'unavailable').replace(/-/g, ' ');
function ArtifactRows({ items, onInspect }) {
  return <ul className="space-y-2">{items.map((item, index) => <li key={`${item.versionId || item.analysisObjectId || item.datasetId || 'input'}-${index}`} className="rounded border border-border p-2 text-xs space-y-1">
    <div className="font-medium">{item.name} · {precision(item.precision)}</div>
    <div className="break-all">{item.versionId || item.analysisObjectId || item.datasetId || 'Identity unavailable'}</div>
    {item.sha256 && <div className="break-all font-mono">SHA-256 {item.sha256}</div>}
    <div className="text-textMuted">{item.basis}</div>
    {item.reference && item.inspectable !== false && <button type="button" className="btn btn-secondary text-xs" onClick={() => onInspect(item)}>Inspect {item.name}</button>}
  </li>)}</ul>;
}

export default function ExecutionHistory({ projectId, userId }) {
  const connection = useExecutionTarget();
  const scope = `${projectId}:${userId}:${connection.identity}`;
  const [kind, setKind] = useState('all'); const [items, setItems] = useState([]); const [cursor, setCursor] = useState(null);
  const [selected, setSelected] = useState(null); const [detail, setDetail] = useState(null); const [error, setError] = useState('');
  const [loading, setLoading] = useState(false); const [opening, setOpening] = useState(false);
  const [inspection, setInspection] = useState(null); const [manifest, setManifest] = useState(null); const [inspecting, setInspecting] = useState(false);
  const listRequest = useRef(null); const detailRequest = useRef(null); const inspectionRequest = useRef(null); const project = useRef(scope); project.current = scope;
  const clearPrivateDetails = () => { setDetail(null); setSelected(null); setInspection(null); setManifest(null); };
  const refresh = useCallback(async before => {
    if (!projectId) return;
    listRequest.current?.abort(); const controller = new AbortController(); listRequest.current = controller;
    setLoading(true); setError('');
    try {
      const result = await listExecutionHistory(projectId, { before, kind, signal: controller.signal });
      if (controller.signal.aborted || project.current !== scope) return;
      setItems(current => before ? [...current, ...result.items.filter(item => !current.some(old => old.id === item.id))] : result.items); setCursor(result.nextCursor);
    } catch (failure) { if (!controller.signal.aborted) { setError(failure.message); if ([403, 404].includes(failure.status)) { setItems([]); setCursor(null); clearPrivateDetails(); } } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [projectId, kind, scope]);
  useEffect(() => {
    setItems([]); setCursor(null); clearPrivateDetails(); setError(''); setOpening(false); setInspecting(false); refresh();
    return () => { listRequest.current?.abort(); detailRequest.current?.abort(); inspectionRequest.current?.abort(); };
  }, [refresh]);
  const open = async item => {
    if (connection.blocked) { setError(TARGET_DISCONNECTED_MESSAGE); return; }
    detailRequest.current?.abort(); inspectionRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    setSelected(item); setDetail(null); setInspection(null); setManifest(null); setError(''); setOpening(true); setInspecting(false);
    if (!item.detailAvailable) { setOpening(false); return; }
    try {
      const result = await getExecutionHistory(projectId, item.id, controller.signal);
      if (!controller.signal.aborted && project.current === scope) setDetail(result);
    } catch (failure) { if (!controller.signal.aborted) { setError(failure.message); if ([403, 404].includes(failure.status)) clearPrivateDetails(); } }
    finally { if (!controller.signal.aborted) setOpening(false); }
  };
  const inspect = async artifact => {
    inspectionRequest.current?.abort(); const controller = new AbortController(); inspectionRequest.current = controller;
    setInspection(null); setManifest(null); setInspecting(true); setError('');
    try {
      const current = await getArtifactVersion(projectId, artifact.reference.versionId, controller.signal);
      if (current.sha256 !== artifact.reference.sha256 || current.projectId !== artifact.reference.projectId) throw new Error('The saved artifact reference no longer matches this execution.');
      const result = await previewArtifactVersion(projectId, artifact.reference.versionId, { signal: controller.signal, limit: 10 });
      if (result.version.sha256 !== artifact.reference.sha256) throw new Error('The saved artifact reference no longer matches this execution.');
      if (!controller.signal.aborted && project.current === scope) setInspection({ ...result, name: artifact.name });
    } catch (failure) { if (!controller.signal.aborted) { setError(failure.message); if ([403, 404].includes(failure.status)) clearPrivateDetails(); } }
    finally { if (!controller.signal.aborted) setInspecting(false); }
  };
  const inspectEnvironment = async () => {
    inspectionRequest.current?.abort(); const controller = new AbortController(); inspectionRequest.current = controller;
    setInspection(null); setManifest(null); setInspecting(true); setError('');
    try { const result = await getExecutionEnvironment(projectId, detail.id, controller.signal); if (!controller.signal.aborted && project.current === scope) setManifest(result); }
    catch (failure) { if (!controller.signal.aborted) { setError(failure.message); if ([403, 404].includes(failure.status)) clearPrivateDetails(); } }
    finally { if (!controller.signal.aborted) setInspecting(false); }
  };
  if (!projectId) return null;
  const preview = inspection?.preview;
  return <section aria-label="Execution history" className="rounded-xl border border-border bg-surface/50 p-5 space-y-4">
    {connection.blocked && <p role="status" className="rounded border border-amber-300 p-3 text-sm">{TARGET_DISCONNECTED_MESSAGE} Previously loaded evidence remains visible. Reconnect and refresh to inspect current status.</p>}
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-semibold">Execution history</h3><p className="text-sm text-textMuted">Review recorded inputs, methods, environments, and results. Missing replay evidence is shown explicitly.</p></div><button className="btn btn-secondary text-sm" disabled={loading} onClick={() => refresh()}>{loading ? 'Refreshing executions…' : 'Refresh executions'}</button></div>
    <label className="text-sm">Execution category<select aria-label="Execution category" className="input ml-2" value={kind} onChange={event => setKind(event.target.value)}>{Object.entries(kinds).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    {error && <p role="alert" className="text-danger text-sm">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
      <div className="space-y-2 max-h-[650px] overflow-auto" aria-label="Recorded executions">{items.map(item => <button key={item.id} type="button" className={`w-full rounded border p-3 text-left ${selected?.id === item.id ? 'border-primary bg-primary/5' : 'border-border'}`} onClick={() => open(item)}>
        <span className="block text-sm font-medium break-words">{item.operation}</span><span className="block text-xs text-textMuted">{kinds[item.kind]} · {item.outcome||item.status} · {date(item.createdAt)}</span><span className="block text-xs text-textMuted">{String(item.owner.id) === String(userId) ? 'You' : item.owner.displayName}{!item.detailAvailable ? ' · private details' : ''}</span><span className="block break-all text-xs">{item.id}</span>
      </button>)}{!loading && !items.length && <p className="text-sm text-textMuted">No execution records are available for this category.</p>}{cursor && <button className="btn btn-secondary text-xs" disabled={loading} onClick={() => refresh(cursor)}>More executions</button>}</div>
      <div className="min-w-0 space-y-3">
        {opening && <p role="status" className="text-sm">Loading execution evidence…</p>}
        {selected && !selected.detailAvailable && <p className="text-sm text-textMuted">This collaborator’s run is visible as project activity. Its source, parameters, private inputs, and outputs require separate sharing authorization.</p>}
        {detail && <>
          <h4 className="font-semibold break-words">{detail.operation} · {detail.outcome||detail.status}</h4>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs"><dt>Record</dt><dd className="break-all">{detail.id}</dd><dt>Evidence</dt><dd>{precision(detail.origin)}</dd><dt>Queued/recorded</dt><dd>{date(detail.timestamps.createdAt)}</dd><dt>R event time</dt><dd>{date(detail.timestamps.recordedAt)}</dd><dt>Started</dt><dd>{date(detail.timestamps.startedAt)}</dd><dt>Finished</dt><dd>{date(detail.timestamps.completedAt)}</dd><dt>Target</dt><dd>{detail.target.id || 'Not recorded'} · {precision(detail.target.precision)}</dd></dl>
          {detail.target.note && <p className="text-xs text-textMuted">{detail.target.note}</p>}
          <ExecutionTargetEvidence target={detail.target}/>
          {detail.executionAttempts?.length > 0 && <details className="text-xs"><summary>Retained dispatches · {detail.executionAttempts.length}</summary><ul className="space-y-3 mt-2">{detail.executionAttempts.map(attempt => <li key={attempt.dispatchId} className="space-y-2"><p>Attempt {attempt.attempt} · {date(attempt.dispatchAt)} · {attempt.operation}</p><p className="break-all font-mono">Dispatch {attempt.dispatchId}</p><ExecutionTargetEvidence target={attempt.target}/><p>Environment · {precision(attempt.environment?.precision)}</p>{attempt.environment?.reference && <pre className="whitespace-pre-wrap break-all">{JSON.stringify(attempt.environment.reference, null, 2)}</pre>}</li>)}</ul></details>}
          <div className="rounded border border-amber-500/30 p-3 text-xs"><p className="font-medium">Replay evidence incomplete</p><ul className="list-disc pl-4 mt-2 space-y-1">{detail.replay.issues.map(issue => <li key={issue.code}>{issue.message}</li>)}</ul></div>
          <details className="text-xs"><summary>Executed source · {precision(detail.source.precision)}</summary><div className="mt-2 space-y-2">{detail.source.versionId && <p className="break-all">Private source version {detail.source.versionId}</p>}{detail.source.sha256 && <p className="break-all font-mono">SHA-256 {detail.source.sha256}</p>}{detail.source.package && <p className="break-all">Recipe {detail.source.package.id}@{detail.source.package.version} · step {detail.source.package.stepId} · package SHA-256 {detail.source.package.sha256}</p>}{detail.source.note && <p className="text-textMuted">{detail.source.note}</p>}{detail.source.code && <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3">{detail.source.code}</pre>}</div></details>
          <details className="text-xs"><summary>Parameters · {precision(detail.parameters.precision)}</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ values: detail.parameters.values, seed: detail.parameters.seed }, null, 2)}</pre></details>
          <details className="text-xs"><summary>Inputs · {detail.inputs.length} recorded</summary><div className="mt-2"><ArtifactRows items={detail.inputs} onInspect={inspect} /></div></details>
          <details className="text-xs"><summary>Outputs · {detail.outputs.length} available descriptors</summary><div className="mt-2"><ArtifactRows items={detail.outputs} onInspect={inspect} /></div></details>
          <details className="text-xs"><summary>Environment · {precision(detail.environment.precision)}</summary><div className="mt-2 space-y-2"><p className="text-textMuted">{detail.environment.note}</p>{detail.environment.reference && <pre className="whitespace-pre-wrap break-all">{JSON.stringify(detail.environment.reference, null, 2)}</pre>}{detail.environment.observed && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(detail.environment.observed, null, 2)}</pre>}{detail.environment.manifestAvailable && <button type="button" className="btn btn-secondary text-xs" disabled={inspecting} onClick={inspectEnvironment}>Verify environment manifest</button>}</div></details>
          <details className="text-xs"><summary>Kernel generation and order · {detail.kernel.available ? 'recorded' : 'unavailable'}</summary><div className="mt-2 space-y-1">{detail.kernel.available ? <><p className="break-all">Generation {detail.kernel.generation}</p><p>Execution order {detail.kernel.order}</p>{detail.kernel.restartedFromKernelId&&<p className="break-all">Restarted from {detail.kernel.restartedFromKernelId} · earlier unsaved memory was discarded</p>}<p>Result live revision {detail.kernel.resultLiveRevision ?? 'Not recorded'}</p><p className="text-textMuted">{detail.kernel.scope}</p></> : <p>{detail.kernel.reason}</p>}</div></details>
        </>}
        {!selected && !opening && <p className="text-sm text-textMuted">Select an execution to inspect its retained evidence.</p>}
        {inspecting && <p role="status" className="text-xs">Verifying retained bytes before inspection…</p>}
        {manifest && <div className="rounded border border-success/30 p-3 text-xs space-y-2"><p className="font-medium">Environment manifest checksum verified</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(manifest.manifest, null, 2)}</pre></div>}
        {inspection && <div className="rounded border border-border p-3 text-xs space-y-2"><p className="font-medium">{inspection.name} · recorded version checksum verified</p>{preview.family === 'metadata' && <p>{preview.message}</p>}{preview.family === 'text' && <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words">{preview.text}</pre>}{preview.family === 'image' && <img className="max-h-56 max-w-full bg-white" src={artifactImageUrl(projectId, inspection.version.versionId)} alt={`Execution artifact ${inspection.name}`} onError={() => { setInspection(null); setError('The image preview is unavailable or its integrity check failed.'); }} />}{preview.family === 'table' && <div className="max-h-56 overflow-auto"><table className="text-left"><thead><tr>{preview.columns.map(column => <th className="p-2" key={column}>{column}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td className="border-t border-border p-2" key={column}>{cell}</td>)}</tr>)}</tbody></table></div>}<p className="text-textMuted">Bounded inspection of this exact recorded version; additional data stays in storage.</p></div>}
      </div>
    </div>
  </section>;
}
