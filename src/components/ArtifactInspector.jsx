import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getArtifactImportReceipt, importArtifactVersion, listArtifactVersions } from '../artifacts/artifactApi';
import { artifactImportRequestSha256, prepareArtifactImportRequest, validateArtifactImportReceipt } from '../artifacts/artifactImportReceipt';
import { artifactBytesLabel as bytesLabel } from '../artifacts/privateRArtifactPolicy';
import ServerDataImporter from './ServerDataImporter';
import RetainedArtifactView from './RetainedArtifactView';
import useExecutionTarget from '../runtime/useExecutionTarget';

const unknownMessage = 'Import completion is unconfirmed. Keep this inspector open and check the original request. No upload is sent again automatically.';
const missingMessage = 'No accepted receipt is available yet. This does not prove the upload was rejected or did not reach the server. Keep the original file and request.';
const definitiveCodes = new Set(['INVALID_ARTIFACT_IMPORT_REQUEST', 'INVALID_ARTIFACT_NAME', 'INVALID_ARTIFACT_TYPE', 'INVALID_ARTIFACT_FILE',
  'INVALID_ARTIFACT_FORMAT', 'ARTIFACT_PREVIEW_INVALID', 'ARTIFACT_FORMAT_CHANGED', 'ARTIFACT_VERSION_READ_ONLY', 'ARTIFACT_IMPORT_SOURCE_CHANGED']);
const failureMessage = failure => failure?.code === 'INVALID_ARTIFACT_IMPORT_RESPONSE'
  ? 'The original import could not be confirmed. Keep its file and check the same request again.'
  : failure?.code === 'ARTIFACT_IMPORT_REQUEST_CONFLICT' ? 'This request identifies different accepted import settings. Keep the original request and check its receipt.'
    : failure?.status === 401 ? 'Sign in again before checking this import outcome.'
      : failure?.status === 403 ? 'Your current access does not permit this action. The original import remains available for an authorized receipt check.'
        : 'The artifact request could not be confirmed. Keep the original import details and try checking again.';

function ArtifactInspectorScope({ projectId, canWrite = false, userId }) {
  const [items, setItems] = useState([]), [nextCursor, setNextCursor] = useState(null), [selected, setSelected] = useState(null);
  const [error, setError] = useState(''), [importError, setImportError] = useState('');
  const [loading, setLoading] = useState(false), [importing, setImporting] = useState(false);
  const [file, setFile] = useState(null), [name, setName] = useState(''), [artifactType, setArtifactType] = useState('auto');
  const [replacement, setReplacement] = useState(false), [inspection, setInspection] = useState(0);
  const [pending, setPending] = useState(null), [confirmation, setConfirmation] = useState(null), [learnedReadOnly, setLearnedReadOnly] = useState(false);
  const [serverImported, setServerImported] = useState(null);
  const listRequest = useRef(null), importRequest = useRef(null), mounted = useRef(false), inFlight = useRef(false);
  const pendingRef = useRef(null), selectionGeneration = useRef(0), projectRef = useRef(projectId), fileInput = useRef(null);
  projectRef.current = projectId;
  const writer = canWrite && !learnedReadOnly;

  const revokeView = useCallback(() => {
    selectionGeneration.current++;
    setItems([]); setSelected(null); setNextCursor(null); setLearnedReadOnly(true);
    setConfirmation(current => current ? { ...current, availability: 'unavailable', version: null } : null);
    setServerImported(null);
  }, []);
  const refresh = useCallback(async before => {
    if (!projectId || !mounted.current) return false;
    listRequest.current?.abort();
    const controller = new AbortController(); listRequest.current = controller;
    setLoading(true); setError('');
    try {
      const response = await listArtifactVersions(projectId, { signal: controller.signal, before });
      if (!mounted.current || controller.signal.aborted || projectRef.current !== projectId) return false;
      if (!Array.isArray(response?.items)) throw new Error('Unreadable artifact list');
      setItems(current => before ? [...current, ...response.items.filter(item => !current.some(existing => existing.versionId === item.versionId))] : response.items);
      setNextCursor(response.nextCursor);
      return true;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && projectRef.current === projectId) {
        setError('Saved artifact versions could not be refreshed. Check your current project access and try again.');
        if ([401, 403, 404].includes(failure.status)) revokeView();
      }
      return false;
    } finally { if (mounted.current && !controller.signal.aborted && projectRef.current === projectId) setLoading(false); }
  }, [projectId, revokeView]);
  useEffect(() => {
    mounted.current = true; refresh();
    return () => { mounted.current = false; listRequest.current?.abort(); importRequest.current?.abort(); };
  }, [refresh]);

  const inspect = version => {
    selectionGeneration.current++;
    setSelected(version); setInspection(value => value + 1); setError('');
    if (!pendingRef.current) setReplacement(false);
  };
  const currentAttempt = (attempt, controller) => mounted.current && !controller.signal.aborted
    && projectRef.current === projectId && pendingRef.current?.requestId === attempt.requestId;
  const keepPending = attempt => { pendingRef.current = attempt; setPending(attempt); };
  const confirm = async (receipt, attempt, controller, firstConfirmation = true) => {
    if (!mounted.current || controller.signal.aborted || projectRef.current !== projectId) return;
    if (firstConfirmation && pendingRef.current?.requestId !== attempt.requestId) return;
    if (!receipt.canImport) setLearnedReadOnly(true);
    setConfirmation(receipt); setImportError('');
    if (firstConfirmation) {
      pendingRef.current = null; setPending(null); setFile(null); setName(''); setReplacement(false);
      if (fileInput.current) fileInput.current.value = '';
    }
    const unchangedSelection = selectionGeneration.current === attempt.selectionGeneration;
    const refreshed = await refresh();
    if (!mounted.current || controller.signal.aborted || projectRef.current !== projectId) return;
    if (firstConfirmation && receipt.version && refreshed && unchangedSelection && selectionGeneration.current === attempt.selectionGeneration) inspect(receipt.version);
  };
  const upload = async (attempt, controller) => {
    const prepared = { ...attempt, phase: 'uploading' }; keepPending(prepared);
    try {
      const result = await importArtifactVersion(projectId, { file: prepared.file, name: prepared.request.name,
        artifactType: prepared.request.artifactType, previousVersionId: prepared.request.previousVersionId || undefined,
        requestId: prepared.request.requestId, expectedRequestSha256: prepared.requestSha256, signal: controller.signal });
      if (!currentAttempt(prepared, controller)) return;
      const receipt = await validateArtifactImportReceipt(result, prepared.request, { post: true });
      if (currentAttempt(prepared, controller)) await confirm(receipt, prepared, controller);
    } catch (failure) {
      if (!currentAttempt(prepared, controller)) return;
      if (!prepared.uncertain && definitiveCodes.has(failure.code)) {
        pendingRef.current = null; setPending(null);
        setImportError('This upload was rejected before acceptance. Review the file format, size, purpose and name before starting another request.');
      } else {
        keepPending({ ...prepared, phase: 'unknown', uncertain: true }); setImportError(failureMessage(failure));
        if ([401, 403].includes(failure.status)) setLearnedReadOnly(true);
      }
    }
  };
  const submit = async event => {
    event.preventDefault();
    if (!file || !writer || !projectId || pendingRef.current || inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController(); importRequest.current = controller;
    const attempt = { requestId: globalThis.crypto.randomUUID(), file, originalName: name, artifactType,
      previousVersionId: replacement ? selected?.versionId || null : null, previousName: replacement ? selected?.name : null,
      selectionGeneration: selectionGeneration.current, phase: 'preparing', uncertain: false, checked: false };
    keepPending(attempt); setImporting(true); setImportError(''); setConfirmation(null);
    try {
      const request = await prepareArtifactImportRequest({ file, name, artifactType, previousVersionId: attempt.previousVersionId,
        projectId, ownerUserId: userId, requestId: attempt.requestId });
      if (!currentAttempt(attempt, controller)) return;
      const requestSha256 = await artifactImportRequestSha256(request);
      if (currentAttempt(attempt, controller)) await upload({ ...attempt, request, requestSha256 }, controller);
    } catch (failure) {
      if (currentAttempt(attempt, controller)) {
        pendingRef.current = null; setPending(null);
        setImportError(failure.code === 'INVALID_ARTIFACT_IMPORT_INPUT' ? failure.message : 'The exact file could not be prepared. Keep it and try again before uploading.');
      }
    } finally { inFlight.current = false; if (mounted.current && !controller.signal.aborted) setImporting(false); }
  };
  const check = async () => {
    const attempt = pendingRef.current || confirmation && { requestId: confirmation.requestId, request: confirmation.request, selectionGeneration: selectionGeneration.current };
    if (!attempt?.request || inFlight.current) return;
    const recoveringPending = !!pendingRef.current;
    inFlight.current = true; setImporting(true); setImportError('');
    const controller = new AbortController(); importRequest.current = controller;
    if (recoveringPending) keepPending({ ...attempt, phase: 'checking' });
    try {
      const value = await getArtifactImportReceipt(projectId, attempt.requestId, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || recoveringPending && !currentAttempt(attempt, controller)) return;
      const receipt = await validateArtifactImportReceipt(value, attempt.request);
      if (!mounted.current || controller.signal.aborted || recoveringPending && !currentAttempt(attempt, controller)) return;
      await confirm(receipt, attempt, controller, recoveringPending);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || recoveringPending && !currentAttempt(attempt, controller)) return;
      if (recoveringPending) keepPending({ ...attempt, phase: 'unknown', uncertain: true, checked: true });
      setImportError(failure.code === 'ARTIFACT_IMPORT_NOT_FOUND' ? missingMessage : failureMessage(failure));
      if ([401, 403].includes(failure.status) || failure.status === 404 && failure.code !== 'ARTIFACT_IMPORT_NOT_FOUND') revokeView();
    } finally { inFlight.current = false; if (mounted.current && !controller.signal.aborted) setImporting(false); }
  };
  const retry = async () => {
    const attempt = pendingRef.current;
    if (!attempt?.request || !attempt.checked || !writer || inFlight.current) return;
    inFlight.current = true; setImporting(true); setImportError('');
    const controller = new AbortController(); importRequest.current = controller;
    try { await upload({ ...attempt, uncertain: true }, controller); }
    finally { inFlight.current = false; if (mounted.current && !controller.signal.aborted) setImporting(false); }
  };

  if (!projectId) return null;
  const canReplace = writer && selected?.canReplace && (!userId || selected.ownerId === String(userId));
  const frozen = !!pending;
  return <section aria-label="Artifact versions" className="rounded-xl border border-border bg-surface/50 p-5 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-semibold">Artifact versions</h3><p className="text-sm text-textMuted">Inspect exact saved files, analysis versions, and private workflow outputs. Full analysis objects stay in storage.</p></div>
      <button type="button" className="btn btn-secondary text-sm" disabled={loading} onClick={() => refresh()}>{loading ? 'Refreshing artifacts…' : 'Refresh artifacts'}</button>
    </div>
    {(writer || frozen) && <form onSubmit={submit} className="rounded-lg border border-border p-3 space-y-3" aria-label="Import artifact version">
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Artifact file<input ref={fileInput} aria-label="Artifact file" className="block w-full mt-1 text-sm" type="file" onChange={event => { if (!pendingRef.current) setFile(event.target.files?.[0] || null); }} disabled={frozen || importing || !writer} /></label>
        <label className="text-sm">Artifact name<input className="input mt-1 w-full" value={name} maxLength={160} placeholder="Use the file name" onChange={event => { if (!pendingRef.current) setName(event.target.value); }} disabled={frozen || importing || !writer} /></label>
      </div>
      <div className="flex flex-wrap items-center gap-3"><label className="text-sm">Artifact purpose<select aria-label="Artifact purpose" className="input ml-2" value={artifactType} onChange={event => { if (!pendingRef.current) setArtifactType(event.target.value); }} disabled={frozen || importing || !writer}><option value="auto">Detect from file</option><option value="sample-sheet">Sample sheet (CSV/TSV)</option></select></label>
        {(canReplace || pending?.previousVersionId) && <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={frozen ? !!pending.previousVersionId : replacement} onChange={event => { if (!pendingRef.current) setReplacement(event.target.checked); }} disabled={frozen || importing || !writer} />New version of selected artifact</label>}
        {!frozen && <button className="btn btn-primary text-sm" disabled={!file || importing || !writer}>{replacement ? 'Save new artifact version' : 'Import artifact'}</button>}
      </div>
      <p className="text-xs text-textMuted">Imports stay private. Replacing a managed file saves a new version and retains earlier contents. RDS files open only in an appropriate private runtime.</p>
    </form>}
    {(pending || confirmation) && <section aria-label="Artifact import recovery" className="space-y-3 rounded-lg border border-border p-3 text-sm">
      {pending ? <>
        <p role="status">{pending.phase === 'preparing' ? 'Preparing exact file…' : pending.phase === 'uploading' ? 'Importing artifact…' : pending.phase === 'checking' ? 'Checking import outcome…' : unknownMessage}</p>
        <p className="break-words text-xs text-textMuted">{pending.file.name} · {pending.request?.name || pending.originalName || pending.file.name} · {pending.artifactType === 'sample-sheet' ? 'Sample sheet' : 'Detect from file'}</p>
        {pending.previousVersionId && <p className="break-words text-xs text-textMuted">Original replacement target: {pending.previousName} · {pending.previousVersionId}. Selecting another artifact does not change this request.</p>}
        <p className="text-xs leading-relaxed text-textMuted">File and settings stay fixed while this request is unconfirmed. Recovery is kept only while this inspector remains open in this window; it is not restored after closing it or changing account, project or server. Your original laptop file is unchanged.</p>
      </> : <>
        <p role="status">The original import was accepted{confirmation.availability === 'unavailable' ? ', but its saved file is currently unavailable.' : '.'} No additional version was created by checking its outcome.</p>
        <p className="break-words text-xs text-textMuted">{confirmation.request.name} · version {confirmation.acceptance.versionNumber} · {bytesLabel(confirmation.acceptance.sizeBytes)}</p>
        {confirmation.version && selected?.versionId !== confirmation.version.versionId && <p className="text-xs text-textMuted">Your current artifact selection was kept. Inspect the confirmed imported version when ready.</p>}
      </>}
      {importError && <p role="alert" className="text-sm text-danger">{importError}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-secondary text-sm" disabled={importing || pending && !pending.request} onClick={() => void check()}>Check import outcome</button>
        {pending?.checked && writer && <button type="button" className="btn btn-secondary text-sm" disabled={importing} onClick={() => void retry()}>Retry original upload</button>}
        {confirmation?.version && <button type="button" className="btn btn-secondary text-sm" disabled={importing} onClick={() => inspect(confirmation.version)}>Inspect imported version</button>}
      </div>
      {!writer && <p className="text-xs text-textMuted">Receipt checks require current project read access. Starting or retrying uploads requires current write access.</p>}
      <details className="break-all text-xs text-textMuted"><summary className="cursor-pointer">Original import identity</summary><p className="mt-2">{pending?.requestId || confirmation.requestId}</p>
        {(pending?.request?.sha256 || confirmation?.request.sha256) && <p className="mt-1 font-mono">SHA-256: {pending?.request?.sha256 || confirmation.request.sha256}</p>}
      </details>
    </section>}
    {!pending && !confirmation && importError && <p role="alert" className="text-danger text-sm">{importError}</p>}
    {writer && <ServerDataImporter projectId={projectId} userId={userId} onImported={async version => {
      const refreshed = await refresh();
      if (refreshed && mounted.current && projectRef.current === projectId) setServerImported(version);
    }} />}
    {serverImported && <div role="status" className="space-y-2 rounded border border-border p-3 text-sm">
      <p>Server file imported. Your current artifact selection was kept.</p>
      <button type="button" className="text-primary underline" onClick={() => inspect(serverImported)}>Inspect imported server version</button>
    </div>}
    {error && <p role="alert" className="text-danger text-sm">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
      <div className="space-y-2 max-h-[600px] overflow-y-auto" aria-label="Available artifact versions">{items.map(item => <button key={item.versionId} type="button" className={`w-full rounded-lg border p-3 text-left ${selected?.versionId === item.versionId ? 'border-primary bg-primary/5' : 'border-border bg-surface'}`} onClick={() => inspect(item)}>
        <span className="block font-medium text-sm break-words">{item.name}{item.versionNumber ? ` · v${item.versionNumber}` : ''}</span>
        <span className="block text-xs text-textMuted">{item.type} · {bytesLabel(item.sizeBytes)}</span><span className="block text-xs text-textMuted break-all">{item.versionId}</span>
      </button>)}
        {!loading && items.length === 0 && <p className="text-sm text-textMuted">No saved artifact files are available for your workspace yet.</p>}
        {nextCursor && <button className="btn btn-secondary text-sm" disabled={loading} onClick={() => refresh(nextCursor)}>More artifact versions</button>}
      </div>
      <div className="min-w-0 space-y-3">{selected ? <RetainedArtifactView key={`${selected.versionId}:${inspection}`} projectId={projectId} userId={userId}
        reference={{ kind: 'artifact-version', versionId: selected.versionId, sha256: selected.sha256 }} /> : <p className="text-sm text-textMuted">Select an exact artifact version to inspect its metadata and preview.</p>}</div>
    </div>
  </section>;
}

export default function ArtifactInspector(props) {
  const connection = useExecutionTarget();
  if (connection.blocked) return <p role="status" className="text-sm text-textMuted">Reconnect to this workspace to inspect saved artifact versions.</p>;
  return <ArtifactInspectorScope key={JSON.stringify([props.userId ?? null, connection.identity, connection.epoch, props.projectId])} {...props} />;
}
