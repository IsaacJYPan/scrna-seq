import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getWorkflowSnapshot } from './researchAnalysisApi';
import { canonicalRetainedWorkflowSnapshot, normalizeWorkflowSnapshotOpen, WORKFLOW_SNAPSHOT_LIMITS, WORKFLOW_SNAPSHOT_SCHEMA } from '../../shared/workflowSnapshot.mjs';
import { publicErrorMessage } from '../publicError';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { validateWorkflowRestoration } from './workflowSnapshotClient';

const RetainedArtifactView = React.lazy(() => import('../components/RetainedArtifactView'));
const hash = async source => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const label = (value, fallback) => typeof value === 'string' ? value : fallback;
const readable = value => JSON.stringify(value, null, 2).slice(0, 20000);
const unavailable = () => new Error('The exact saved workflow could not be verified. Refresh its recorded details before continuing.');
async function checkedSnapshot(result, { projectId, userId, reference }) {
  const value = result?.snapshot;
  if (!value || value.schema !== WORKFLOW_SNAPSHOT_SCHEMA || value.id !== reference.snapshotId
      || value.sha256 !== reference.sha256 || value.projectId !== projectId || value.ownerUserId !== userId
      || !/^ao_[a-f0-9]{16,40}$/.test(value.analysisObjectId) || typeof value.packageDigest !== 'string'
      || typeof value.name !== 'string' || value.visibility !== 'private' || !Object.hasOwn(value, 'package') || !Object.hasOwn(value, 'state')
      || !plain(value.support) || typeof value.support.supported !== 'boolean' || typeof value.canReopen !== 'boolean') throw unavailable();
  if (value.support.supported && (!plain(value.package) || !plain(value.state) || !/^[a-f0-9]{64}$/.test(value.packageDigest))) throw unavailable();
  const canonical = canonicalRetainedWorkflowSnapshot(value);
  if (new TextEncoder().encode(canonical).length > WORKFLOW_SNAPSHOT_LIMITS.sourceBytes || await hash(canonical) !== reference.sha256) throw unavailable();
  const working = value.workingInstance;
  if (working !== null && (!plain(working) || !/^wfi_[a-f0-9]{24}$/.test(working.id)
      || !Number.isSafeInteger(working.generation) || working.generation < 0 || typeof working.active !== 'boolean')) throw unavailable();
  return value;
}

export default function RetainedWorkflowSnapshotView({ projectId, userId, reference: inputReference, canWrite = false, onOpenWorkflow, initialSnapshot }) {
  const referenceKey = JSON.stringify(inputReference);
  const reference = useMemo(() => JSON.parse(referenceKey), [referenceKey]);
  const connection = useExecutionTarget();
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0), [output, setOutput] = useState(null), [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState(null), [notice, setNotice] = useState('');
  const [observedCurrent, setObservedCurrent] = useState(null);
  const mounted = useRef(false), frozen = useRef(null), uncertain = useRef(false), inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (connection.blocked) return undefined;
    const controller = new AbortController();
    setLoading(true); setError(''); setOutput(null); setReplace(false); setObservedCurrent(null);
    (initialSnapshot && refresh === 0 ? Promise.resolve({ snapshot: initialSnapshot }) : getWorkflowSnapshot(projectId, reference.snapshotId, { sha256: reference.sha256, signal: controller.signal }))
      .then(result => checkedSnapshot(result, { projectId, userId, reference }))
      .then(value => { if (!controller.signal.aborted) setSnapshot(value); })
      .catch(failure => { if (!controller.signal.aborted) { setSnapshot(null); setError(publicErrorMessage(failure, 'This saved workflow is unavailable. Refresh to check its exact source.')); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, userId, reference, initialSnapshot, refresh, connection.blocked]);
  const open = async () => {
    if (!snapshot || connection.blocked || inFlight.current || !onOpenWorkflow || !canWrite && !frozen.current) return;
    let request = frozen.current;
    if (!request) {
      try { request = normalizeWorkflowSnapshotOpen({ requestId: crypto.randomUUID(), sha256: reference.sha256,
        expectedInstance: snapshot.workingInstance ? { id: snapshot.workingInstance.id, generation: snapshot.workingInstance.generation } : null,
        replace: snapshot.workingInstance ? replace : false }); }
      catch (failure) { setError(failure.message); return; }
    }
    frozen.current = request; setPending(request); inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = validateWorkflowRestoration(await onOpenWorkflow({ snapshot, request, retry: uncertain.current, isCurrent: () => mounted.current }), snapshot, request);
      if (!mounted.current) return;
      frozen.current = null; uncertain.current = false; setPending(null); setReplace(false);
      setObservedCurrent(result.currentInstance && result.currentInstance.state.generation !== result.restoration.generation ? result.currentInstance : null);
      setNotice(result.navigationNote || (!result.canEditWorking ? 'The original open is confirmed. Your current project role allows inspection only; the working workflow was kept.'
        : !result.currentInstance ? 'The saved workflow was opened previously, but that working copy has since closed. Refresh before opening a new copy.'
        : result.currentInstance.state.generation !== result.restoration.generation
          ? 'The original open is confirmed. A newer working state is kept; the saved snapshot was not reapplied.'
          : 'The exact saved workflow is open. No analysis step was run.'));
      setSnapshot(previous => ({ ...previous, canReopen: result.canEditWorking, workingInstance: result.currentInstance ? { id: result.currentInstance.id,
        generation: result.currentInstance.state.generation, active: !!result.currentInstance.state.active } : previous.workingInstance }));
    } catch (failure) {
      if (!mounted.current) return;
      const freshRejection = !uncertain.current && ['UNSAVED_LIVE_WORK', 'TARGET_CHANGED', 'WORKFLOW_WORKING_CONFLICT',
        'WORKFLOW_SOURCE_UNSUPPORTED', 'WORKFLOW_STATE_UNSUPPORTED', 'WORKFLOW_ROOT_UNAVAILABLE',
        'WORKFLOW_EVIDENCE_UNAVAILABLE', 'WORKFLOW_WORKSPACE_FULL', 'WORKFLOW_GENERATION_EXHAUSTED', 'WORKFLOW_SNAPSHOT_NOT_FOUND', 'FORBIDDEN'].includes(failure.code);
      if (freshRejection) { frozen.current = null; setPending(null); }
      else uncertain.current = true;
      setError(failure.code === 'UNSAVED_LIVE_WORK' ? 'Save your current live analysis in Data workspace before opening another workflow.'
        : freshRejection && failure.code === 'FORBIDDEN' ? 'Your current project role cannot reopen a working workflow. Its saved source remains available if you still have read access.'
          : freshRejection && failure.code === 'WORKFLOW_WORKSPACE_FULL' ? 'Close an unused working workflow in Pipelines, then refresh these details before opening another.'
            : freshRejection && failure.code === 'WORKFLOW_GENERATION_EXHAUSTED' ? 'This working workflow has reached its supported revision limit. Its saved source remains available for inspection.'
            : freshRejection ? 'The working context changed or cannot be replaced. Refresh the saved workflow details before opening it.'
          : publicErrorMessage(failure, 'Opening could not be confirmed. Check the original open request before replacing more work.'));
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const results = snapshot && plain(snapshot.state?.results) ? Object.entries(snapshot.state.results).filter(([, result]) => plain(result)) : [];
  const files = snapshot && plain(snapshot.package?.files) ? Object.entries(snapshot.package.files) : [];
  return <section aria-label="Retained workflow snapshot" className="min-w-0 space-y-4 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-3"><h4 className="font-semibold">{snapshot?.name || 'Saved workflow'}</h4>
      <button type="button" className="text-xs text-primary underline" disabled={connection.blocked || loading || busy || !!pending} onClick={() => setRefresh(value => value + 1)}>Refresh workflow details</button></div>
    {connection.blocked && <p role="status" className="text-xs text-textMuted">Reconnect to inspect the saved workflow or check an earlier open request.</p>}
    {loading && <p role="status" className="text-xs text-textMuted">Reading captured workflow source…</p>}
    {error && <p role="alert" className="rounded border border-danger/30 p-3 text-danger">{error}</p>}
    {notice && <p role="status" className="text-xs text-success">{notice}</p>}
    {snapshot && !connection.blocked && <>
      <p className="text-xs text-success">Captured source checksum verified</p>
      <p className="text-xs text-textMuted">This private record retains method code and saved settings. Result bytes are checked by their own inspectors. No notebook source or new execution is inferred.</p>
      {!snapshot.support.supported && <p role="status" className="rounded border border-border p-3 text-xs text-textMuted">{snapshot.support.message || 'This captured workflow cannot currently be reopened. Its retained source is available for inspection.'}</p>}
      <details className="text-xs"><summary className="cursor-pointer">Saved workflow identity</summary><dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 break-all">
        <dt>Snapshot</dt><dd>{snapshot.id}</dd><dt>SHA-256</dt><dd className="font-mono">{snapshot.sha256}</dd>
        <dt>Original object</dt><dd>{snapshot.analysisObjectId}</dd><dt>Method</dt><dd>{label(snapshot.package?.name, label(snapshot.package?.id, 'Captured method'))} · {label(snapshot.package?.version, 'Version not recorded')}</dd>
        <dt>Package checksum</dt><dd className="font-mono">{snapshot.packageDigest}</dd><dt>Root checkpoint</dt><dd>{label(snapshot.state?.root?.id, 'Not recorded')}</dd>
      </dl></details>
      <details className="text-xs"><summary className="cursor-pointer">Captured method source</summary><div className="mt-3 space-y-3">{files.length ? files.map(([name, source]) => <details key={name}><summary className="cursor-pointer break-all">{name}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono">{typeof source === 'string' ? source : 'This source entry cannot be displayed.'}</pre></details>) : <p>No readable method files were captured.</p>}</div></details>
      {!snapshot.support.supported && <details className="text-xs"><summary className="cursor-pointer">Captured source JSON</summary><p className="my-2 text-textMuted">This is an inert, bounded preview of the original source record. Unsupported fields have not been converted into executable work.</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border border-border p-3">{readable({ package: snapshot.package, state: snapshot.state })}</pre></details>}
      <details className="text-xs"><summary className="cursor-pointer">Saved settings and results</summary><div className="mt-3 space-y-3">{results.length ? results.map(([step, result]) => <div key={step} className="space-y-2 rounded border border-border p-3"><p className="font-medium">{label(Array.isArray(snapshot.package?.steps) ? snapshot.package.steps.find(item => item?.id === step)?.label : null, step)}</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{readable({ parameters: result.parameters, seed: result.seed })}</pre>
        {plain(result.outputs) && Object.entries(result.outputs).map(([port, artifact]) => artifact && /^(?:av|art|eri)_[a-f0-9]{16,40}$/.test(artifact.id) && /^[a-f0-9]{64}$/.test(artifact.sha256)
          ? <button type="button" key={port} className="block text-xs text-primary underline" onClick={() => setOutput({ kind: 'artifact-version', versionId: artifact.id, sha256: artifact.sha256 })}>Inspect saved {port}</button>
          : <p key={port} className="text-textMuted">Saved {port}: an exact readable output reference is unavailable.</p>)}
      </div>) : <p>No completed step results were captured.</p>}</div></details>
      {observedCurrent && <details className="text-xs"><summary className="cursor-pointer">Newer working state kept</summary><div className="mt-3 space-y-3">
        <p className="text-textMuted">Working generation {observedCurrent.state.generation} was observed when the original open was confirmed. It is separate from this saved snapshot and is shown here for inspection.</p>
        {plain(observedCurrent.state.results) && Object.entries(observedCurrent.state.results).filter(([, result]) => plain(result)).map(([step, result]) => <div key={step} className="space-y-2 rounded border border-border p-3"><p className="font-medium">{step}</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{readable({ parameters: result.parameters, seed: result.seed })}</pre>
          {plain(result.outputs) && Object.entries(result.outputs).map(([port, artifact]) => artifact && /^(?:av|art|eri)_[a-f0-9]{16,40}$/.test(artifact.id) && /^[a-f0-9]{64}$/.test(artifact.sha256)
            ? <button type="button" key={port} className="block text-primary underline" onClick={() => setOutput({ kind: 'artifact-version', versionId: artifact.id, sha256: artifact.sha256 })}>Inspect current saved {port}</button>
            : <p key={port} className="text-textMuted">Current {port}: an exact readable output reference is unavailable.</p>)}
        </div>)}
      </div></details>}
      {output && <React.Suspense fallback={<p role="status" className="text-xs">Reading retained output…</p>}><RetainedArtifactView key={output.versionId} projectId={projectId} userId={userId} reference={output} compact /></React.Suspense>}
      {onOpenWorkflow && (canWrite && snapshot.canReopen || pending) && snapshot.support.supported && <div className="space-y-3 border-t border-border pt-4">
        {snapshot.workingInstance && <><p className="text-xs text-textMuted">A working workflow already exists at generation {snapshot.workingInstance.generation}. Opening this snapshot replaces those working results; saved versions remain available.</p>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={replace} disabled={!!pending || busy || snapshot.workingInstance.active} onChange={event => setReplace(event.target.checked)} />Replace this identified working workflow</label></>}
        {snapshot.workingInstance?.active && <p role="status" className="text-xs text-textMuted">Wait for the active run before replacing this workflow.</p>}
        <button type="button" className="btn btn-secondary text-sm" disabled={connection.blocked || busy || !pending && (snapshot.workingInstance?.active || snapshot.workingInstance && !replace)} onClick={() => void open()}>{busy ? 'Checking saved workflow…' : pending ? 'Check original open request' : 'Open saved workflow'}</button>
        {pending && <p className="text-xs text-textMuted">The original request is frozen. Keep this view open until its outcome is confirmed.</p>}
      </div>}
    </>}
  </section>;
}
