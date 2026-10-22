import React, { useEffect, useRef, useState } from 'react';
import { getServerDataImport, importServerData, listServerDataImports } from '../artifacts/serverDataApi';
import { normalizeServerDataImportRequest } from '../../shared/serverDataImport.mjs';
import { artifactBytesLabel } from '../artifacts/privateRArtifactPolicy';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { TARGET_DISCONNECTED_MESSAGE } from '../runtime/executionTarget';
import ServerDataFilePicker from './ServerDataFilePicker';

const unconfirmed = 'Import completion is unconfirmed. Reconnect to the same server and check this import request. No import will be submitted again automatically.';
const uncertainCodes = ['SERVER_DATA_IMPORT_UNCONFIRMED', 'TARGET_EXECUTION_UNCONFIRMED'];

export default function ServerDataImporter({ projectId, userId, canWrite = false, onImported, onOutcome }) {
  const connection = useExecutionTarget();
  const [open, setOpen] = useState(false);
  const [rootId, setRootId] = useState('');
  const [rootLabel, setRootLabel] = useState('');
  const [pickerRefresh, setPickerRefresh] = useState(0);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState('');
  const [artifactType, setArtifactType] = useState('auto');
  const [sampleMetadata, setSampleMetadata] = useState({});
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedItems, setSavedItems] = useState([]);
  const [savedCursor, setSavedCursor] = useState(null);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedLoaded, setSavedLoaded] = useState(false);
  const [importAllowed, setImportAllowed] = useState(true);
  const [missingChecked, setMissingChecked] = useState(false);
  const scope = `${projectId}:${userId || ''}:${connection.identity}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const importRequest = useRef(null);
  const postStarted = useRef(false);
  const statusRequest = useRef(null);
  const savedRequest = useRef(null);
  const checkStatusRef = useRef(null);
  const requestId = useRef(null);
  const originalRequest = useRef(null);
  const wasUnconfirmed = useRef(false);
  const serviceId = useRef(null);
  const writeEpoch = useRef(0);
  const readEpoch = useRef(0);
  const writerRef = useRef(canWrite); writerRef.current = canWrite;
  const notified = useRef(null);
  const onImportedRef = useRef(onImported); onImportedRef.current = onImported;
  const onOutcomeRef = useRef(onOutcome); onOutcomeRef.current = onOutcome;
  const blocked = connection.blocked;
  const writer = canWrite && importAllowed;
  const pending = importing || checking || receipt?.status === 'pending' || uncertain;
  const pendingRef = useRef(pending); pendingRef.current = pending;

  function clearPrivate() {
    setOpen(false); setRootId(''); setRootLabel('');
    setSelected(null); setName(''); setArtifactType('auto'); setSampleMetadata({}); setReceipt(null); setUncertain(false);
    setLoading(false); setImporting(false); setChecking(false); requestId.current = null; notified.current = null;
    setSavedItems([]); setSavedCursor(null); setSavedLoaded(false); setSavedLoading(false); setMissingChecked(false);
    originalRequest.current = null;
    wasUnconfirmed.current = false;
  }
  function showFailure(failure) {
    setError(failure.message);
    if ([401, 403, 404].includes(failure.status)) {
      readEpoch.current++; writeEpoch.current++;
      importRequest.current?.abort(); statusRequest.current?.abort(); savedRequest.current?.abort();
      clearPrivate();
      onOutcomeRef.current?.(null);
    }
  }
  function authority(value, controller) {
    if (value.serviceId) serviceId.current = value.serviceId;
    setImportAllowed(value.canImport);
    if (value.canImport === false) {
      readEpoch.current++;
      if (statusRequest.current !== controller) { statusRequest.current?.abort(); setChecking(false); }
      if (savedRequest.current !== controller) { savedRequest.current?.abort(); setSavedLoading(false); }
      fenceWrites();
    }
  }
  function fenceWrites() {
    const inFlight = postStarted.current && importRequest.current && !importRequest.current.signal.aborted && requestId.current;
    writeEpoch.current++;
    importRequest.current?.abort();
    setOpen(false); setSelected(null); setLoading(false); setImporting(false);
    if (inFlight) { wasUnconfirmed.current = true; setUncertain(true); setError(unconfirmed); }
  }
  function accept(value, controller) {
    authority(value, controller); setReceipt(value); setUncertain(false); setMissingChecked(false);
    onOutcomeRef.current?.(value);
    if (value.status === 'succeeded' && value.version && notified.current !== value.requestId) {
      notified.current = value.requestId;
      onImportedRef.current?.(value.version);
    }
    if (value.status === 'failed') setError(value.error?.message || 'The server file could not be saved. Refresh the folder before selecting it again.');
  }

  useEffect(() => {
    readEpoch.current++; writeEpoch.current++;
    importRequest.current?.abort(); statusRequest.current?.abort(); savedRequest.current?.abort();
    clearPrivate(); setOpen(false); setSavedOpen(false); setImportAllowed(true); setError(''); serviceId.current = null;
    return () => { importRequest.current?.abort(); statusRequest.current?.abort(); savedRequest.current?.abort(); };
  }, [scope]);

  useEffect(() => { if (!canWrite) fenceWrites(); }, [canWrite]);

  useEffect(() => {
    if (blocked) {
      readEpoch.current++; writeEpoch.current++;
      setOpen(false); importRequest.current?.abort(); statusRequest.current?.abort(); savedRequest.current?.abort();
      setLoading(false); setImporting(false); setChecking(false); setSavedLoading(false);
      if (requestId.current && pendingRef.current) { wasUnconfirmed.current = true; setUncertain(true); setError(unconfirmed); }
    }
  }, [blocked]);

  function openBrowser() {
    if (blocked || !writer || pending) return;
    setOpen(true); setError(''); setPickerRefresh(value => value + 1);
  }

  async function loadSaved(cursor) {
    if (blocked || savedLoading) return;
    setSavedOpen(true); setSavedLoading(true); setError('');
    savedRequest.current?.abort();
    const controller = new AbortController(); savedRequest.current = controller;
    const submittedScope = scope, epoch = readEpoch.current;
    try {
      const value = await listServerDataImports(projectId, { cursor, userId, serviceId: serviceId.current || undefined, signal: controller.signal });
      if (controller.signal.aborted || currentScope.current !== submittedScope || readEpoch.current !== epoch) return;
      authority(value, controller);
      setSavedItems(current => cursor ? [...current, ...value.items.filter(item => !current.some(existing => existing.requestId === item.requestId))] : value.items);
      setSavedCursor(value.nextCursor); setSavedLoaded(true);
    } catch (failure) { if (!controller.signal.aborted && currentScope.current === submittedScope && readEpoch.current === epoch) showFailure(failure); }
    finally { if (!controller.signal.aborted && currentScope.current === submittedScope && savedRequest.current === controller) setSavedLoading(false); }
  }

  async function checkStatus(selectedId = requestId.current) {
    if (blocked || !selectedId || checking || importing) return;
    statusRequest.current?.abort();
    const controller = new AbortController(); statusRequest.current = controller;
    const submittedScope = scope; const submittedId = selectedId, epoch = readEpoch.current;
    if (requestId.current !== selectedId) { originalRequest.current = null; wasUnconfirmed.current = false; setReceipt(null); }
    requestId.current = selectedId;
    setChecking(true); setError(''); setMissingChecked(false);
    try {
      const value = await getServerDataImport(projectId, submittedId, controller.signal, { userId, serviceId: serviceId.current || undefined });
      if (controller.signal.aborted || currentScope.current !== submittedScope || requestId.current !== submittedId || readEpoch.current !== epoch) return;
      accept(value, controller);
    } catch (failure) {
      if (!controller.signal.aborted && currentScope.current === submittedScope) {
        setUncertain(true);
        if (failure.status === 404 && failure.code === 'SERVER_DATA_IMPORT_NOT_FOUND') { setMissingChecked(true); setError('This import request could not be found on the selected server. Completion remains unconfirmed; no import has been submitted again.'); }
        else showFailure(failure);
      }
    } finally { if (!controller.signal.aborted && currentScope.current === submittedScope) setChecking(false); }
  }
  checkStatusRef.current = checkStatus;

  useEffect(() => {
    if (receipt?.status !== 'pending' || blocked || uncertain || checking) return undefined;
    const timer = setTimeout(() => checkStatusRef.current(), 1500);
    return () => clearTimeout(timer);
  }, [receipt, blocked, uncertain, checking]);

  async function submit(event) {
    event.preventDefault();
    if (blocked || !writer || !selected || pending) return;
    try {
      const annotations = Object.fromEntries(Object.entries(sampleMetadata).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
      const input = normalizeServerDataImportRequest({ requestId: crypto.randomUUID(), rootId, relativePath: selected.relativePath, selectionToken: selected.selectionToken, name: name.trim() || selected.name, artifactType, ...(Object.keys(annotations).length ? { sampleMetadata: annotations } : {}) });
      originalRequest.current = input; wasUnconfirmed.current = false;
      await send(input);
    } catch (failure) { setError(failure.message); }
  }

  async function send(input) {
    if (blocked || !writerRef.current || !importAllowed) return;
    const controller = new AbortController(); importRequest.current = controller;
    postStarted.current = false;
    const submittedScope = scope, epoch = writeEpoch.current; requestId.current = input.requestId;
    setImporting(true); setError(''); setReceipt(null); setUncertain(wasUnconfirmed.current); setMissingChecked(false);
    try {
      const discovery = await listServerDataImports(projectId, { userId, serviceId: serviceId.current || undefined, signal: controller.signal });
      if (controller.signal.aborted || currentScope.current !== submittedScope || writeEpoch.current !== epoch || !writerRef.current) return;
      authority(discovery, controller);
      if (!discovery.canImport) return;
      postStarted.current = true;
      const value = await importServerData(projectId, input, controller.signal, { userId, serviceId: serviceId.current || undefined });
      if (controller.signal.aborted || currentScope.current !== submittedScope || writeEpoch.current !== epoch || !writerRef.current) return;
      accept(value, controller);
    } catch (failure) {
      if (!controller.signal.aborted && currentScope.current === submittedScope) {
        if (uncertainCodes.includes(failure.code)) { wasUnconfirmed.current = true; setUncertain(true); setError(unconfirmed); }
        else if (wasUnconfirmed.current) { setUncertain(true); setError(`${failure.message} Check the original import request again before choosing a different source.`); }
        else { requestId.current = null; originalRequest.current = null; showFailure(failure); }
      }
    } finally { if (importRequest.current === controller) { importRequest.current = null; postStarted.current = false; } if (!controller.signal.aborted && currentScope.current === submittedScope) setImporting(false); }
  }

  return <section aria-label="Import server data" className="rounded-lg border border-border p-3 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h4 className="font-medium">Import data already on this server</h4><p className="text-xs text-textMuted">Choose a file from an authorized data folder. The server saves a private, verified snapshot; full file contents stay on the server.</p></div>
      <div className="flex flex-wrap gap-2">{writer && <button type="button" className="btn btn-secondary text-sm" disabled={blocked || loading || pending} onClick={openBrowser}>{open ? 'Reload authorized data roots' : 'Browse server data'}</button>}
        <button type="button" className="btn btn-secondary text-sm" disabled={blocked || savedLoading} onClick={() => savedOpen ? setSavedOpen(false) : loadSaved()} aria-expanded={savedOpen}>Saved server imports</button></div>
    </div>
    {blocked && <p role="status" className="text-sm text-textMuted">{TARGET_DISCONNECTED_MESSAGE}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!writer && <p className="text-xs text-textMuted">You can check your saved imports with current project read access. Starting a new copy requires write access and an authorized data folder.</p>}
    {savedOpen && <section aria-label="Saved server imports" className="rounded border border-border p-3 space-y-3 min-w-0">
      <div className="flex flex-wrap justify-between gap-2"><p className="text-sm font-medium">Your import requests on this server</p><button type="button" className="btn btn-secondary text-xs" disabled={blocked || savedLoading} onClick={() => loadSaved()}>Refresh saved imports</button></div>
      <p className="text-xs text-textMuted">Open a request to check its original outcome. This list never starts a copy or attaches a result.</p>
      <ul aria-label="Saved server import requests" className="space-y-2 max-h-72 overflow-y-auto">{savedItems.map(item => <li key={item.requestId}><button type="button" disabled={blocked || checking || importing} onClick={() => checkStatus(item.requestId)} className="w-full rounded border border-border p-2 text-left text-sm space-y-1">
        <span className="block font-medium break-words [overflow-wrap:anywhere]">{item.name}</span><span className="block text-xs text-textMuted">{item.status === 'succeeded' ? item.acceptanceState === 'legacy-unrecorded' ? 'Completed · historical details incomplete' : 'Completed · check saved file availability' : item.status === 'failed' ? 'Failed · source was not replayed' : 'Copy pending'} · {new Date(item.createdAt).toLocaleString()}</span>
        <span className="block text-xs font-mono break-all">{item.requestId}</span>
      </button></li>)}</ul>
      {savedLoading && <p role="status" className="text-xs text-textMuted">Loading saved server imports…</p>}
      {savedLoaded && !savedLoading && savedItems.length === 0 && <p className="text-sm text-textMuted">You have no saved server import requests in this project.</p>}
      {savedCursor && <button type="button" className="btn btn-secondary text-xs" disabled={blocked || savedLoading} onClick={() => loadSaved(savedCursor)}>More saved imports</button>}
    </section>}
    {open && <>
      <ServerDataFilePicker projectId={projectId} userId={userId} serviceId={serviceId.current || undefined} available={!blocked && canWrite} disabled={pending} refreshKey={pickerRefresh}
        onLoading={setLoading} onError={failure => setError(failure?.message || '')} onDenied={showFailure}
        onAuthority={(allowed, info) => authority({ ...info, canImport: allowed })} onSelect={value => {
          setSelected(value?.file || null); setRootId(value?.rootId || ''); setRootLabel(value?.rootLabel || '');
          if (!value) return;
          serviceId.current = value.serviceId;
          setName(value.file.name); setArtifactType('auto'); setSampleMetadata({}); setReceipt(null); setError('');
          requestId.current = null; originalRequest.current = null; wasUnconfirmed.current = false;
        }} />
      {selected && writer && <form aria-label="Save server file snapshot" onSubmit={submit} className="border-t border-border pt-3 space-y-3">
        <p className="text-xs break-all">Selected source: {rootLabel} / {selected.relativePath} · {artifactBytesLabel(selected.sizeBytes)}{selected.sizeBytes >= 1024 ? ` · ${selected.sizeBytes.toLocaleString()} bytes` : ''}</p>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Server artifact name<input aria-label="Server artifact name" className="input block w-full mt-1" value={name} maxLength={160} disabled={blocked || pending} onChange={event => setName(event.target.value)} /></label>
          <label className="text-sm">Server artifact purpose<select aria-label="Server artifact purpose" className="input block w-full mt-1" value={artifactType} disabled={blocked || pending} onChange={event => setArtifactType(event.target.value)}><option value="auto">Detect from file</option><option value="sample-sheet">Sample sheet (CSV/TSV)</option></select></label></div>
        <details className="text-sm"><summary className="cursor-pointer">Sample details (optional)</summary><p className="mt-2 text-xs text-textMuted">Retain a sample description with this saved input. These annotations do not alter file contents.</p><div className="mt-2 grid gap-3 sm:grid-cols-2">{[['sampleId', 'Sample ID'], ['condition', 'Condition'], ['tissue', 'Tissue'], ['species', 'Species'], ['replicate', 'Replicate']].map(([key, label]) => <label key={key} className="text-xs">{label}<input aria-label={`Server sample ${label.toLowerCase()}`} className="input block w-full mt-1" value={sampleMetadata[key] || ''} maxLength={120} disabled={blocked || pending} onChange={event => setSampleMetadata(current => ({ ...current, [key]: event.target.value.replace(/[\r\n]/g, '') }))} /></label>)}</div></details>
        <button className="btn btn-primary text-sm" disabled={blocked || pending || !selected.selectionToken}>{importing ? 'Starting server import…' : 'Import selected server file'}</button>
      </form>}
    </>}
    {(importing || receipt?.status === 'pending') && !uncertain && <div role="status" className="text-sm text-textMuted space-y-1"><p>Copying and verifying an immutable snapshot in server storage…</p>{Number.isSafeInteger(receipt?.bytesCopied) && Number.isSafeInteger(receipt?.reservedBytes) && <><progress aria-label="Server snapshot copy progress" className="w-full" value={receipt.bytesCopied} max={Math.max(1, receipt.reservedBytes)} /><p className="text-xs">{artifactBytesLabel(receipt.bytesCopied)} of {artifactBytesLabel(receipt.reservedBytes)} copied.</p></>}{receipt?.expiresAt && <p className="text-xs">Import deadline: {new Date(receipt.expiresAt).toLocaleString()}</p>}</div>}
    {requestId.current && <div className="text-xs space-y-2"><div className="break-all">Import request: {requestId.current}</div><button type="button" className="btn btn-secondary text-xs" disabled={blocked || checking || importing} onClick={() => checkStatus()}>{checking ? 'Checking server import…' : 'Check server import status'}</button>
      {uncertain && missingChecked && originalRequest.current && writer && <button type="button" className="btn btn-secondary text-xs ml-2" disabled={blocked || checking || importing} onClick={() => send(originalRequest.current)}>Retry original server import</button>}
    </div>}
    {receipt?.status === 'succeeded' && <section aria-label="Server import outcome" className="rounded border border-success/40 p-3 text-sm space-y-2 min-w-0">
      <p role="status">{receipt.acceptanceState === 'legacy-unrecorded' ? 'This historical import completed, but its exact acceptance was not retained.' : receipt.availability === 'unavailable' ? 'The server import was accepted. Its saved file is currently unavailable.' : 'Server file saved as an immutable artifact version.'}</p>
      <p className="break-words [overflow-wrap:anywhere]">{receipt.name || receipt.version?.name}{receipt.acceptance && ` · ${artifactBytesLabel(receipt.acceptance.sizeBytes)}`}</p>
      {receipt.acceptance && <><p className="text-xs break-all">Version {receipt.acceptance.versionId} · v{receipt.acceptance.versionNumber}</p><p className="text-xs font-mono break-all">SHA-256 {receipt.acceptance.sha256}</p></>}
      <p className="text-xs text-textMuted">{receipt.acceptanceState === 'legacy-unrecorded' ? 'No checksum or exact version is inferred. Select the source again to create a new, independently verified import.' : receipt.availability === 'unavailable' ? 'The original acceptance remains recorded. Checking it does not recopy the source or restore missing bytes.' : 'Your current inspection stays selected. Open the imported version deliberately to inspect it.'}</p>
      <details className="text-xs break-all"><summary className="cursor-pointer">Original server source</summary><p className="mt-2">{receipt.source?.serviceLabel} · {receipt.source?.rootId} / {receipt.source?.relativePath}</p></details>
    </section>}
  </section>;
}
