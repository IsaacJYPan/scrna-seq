import React, { useEffect, useRef, useState } from 'react';
import { getServerDataImport, importServerData, listServerDataFiles, listServerDataRoots } from '../artifacts/serverDataApi';
import { artifactBytesLabel } from '../artifacts/privateRArtifactPolicy';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { TARGET_DISCONNECTED_MESSAGE } from '../runtime/executionTarget';

const unconfirmed = 'Import completion is unconfirmed. Reconnect to the same server and check this import request. No import will be submitted again automatically.';
const uncertainCodes = ['SERVER_DATA_IMPORT_UNCONFIRMED', 'TARGET_EXECUTION_UNCONFIRMED'];

export default function ServerDataImporter({ projectId, userId, onImported }) {
  const connection = useExecutionTarget();
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState([]);
  const [limits, setLimits] = useState(null);
  const [rootId, setRootId] = useState('');
  const [directory, setDirectory] = useState('');
  const [files, setFiles] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [listingNotice, setListingNotice] = useState('');
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
  const scope = `${projectId}:${userId || ''}:${connection.identity}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const browseRequest = useRef(null);
  const importRequest = useRef(null);
  const statusRequest = useRef(null);
  const checkStatusRef = useRef(null);
  const requestId = useRef(null);
  const notified = useRef(null);
  const onImportedRef = useRef(onImported); onImportedRef.current = onImported;
  const blocked = connection.blocked;
  const pending = importing || checking || receipt?.status === 'pending' || uncertain;

  function clearPrivate() {
    setRoots([]); setLimits(null); setRootId(''); setDirectory(''); setFiles([]); setNextCursor(null); setListingNotice('');
    setSelected(null); setName(''); setArtifactType('auto'); setSampleMetadata({}); setReceipt(null); setUncertain(false);
    setLoading(false); setImporting(false); setChecking(false); requestId.current = null; notified.current = null;
  }
  function showFailure(failure) {
    setError(failure.message);
    if ([401, 403, 404].includes(failure.status)) clearPrivate();
  }
  function accept(value) {
    setReceipt(value); setUncertain(false);
    if (value.status === 'succeeded' && value.version && notified.current !== value.requestId) {
      notified.current = value.requestId;
      onImportedRef.current?.(value.version);
    }
    if (value.status === 'failed') setError(value.error?.message || 'The server file could not be saved. Refresh the folder before selecting it again.');
  }

  useEffect(() => {
    browseRequest.current?.abort(); importRequest.current?.abort(); statusRequest.current?.abort();
    clearPrivate(); setOpen(false); setError('');
    return () => { browseRequest.current?.abort(); importRequest.current?.abort(); statusRequest.current?.abort(); };
  }, [scope]);

  useEffect(() => {
    if (blocked && requestId.current && (importing || receipt?.status === 'pending')) {
      setUncertain(true); setError(unconfirmed);
    }
  }, [blocked, importing, receipt?.status]);

  async function browse(nextRoot, path = '', cursor) {
    if (blocked) return;
    browseRequest.current?.abort();
    const controller = new AbortController(); browseRequest.current = controller;
    const submittedScope = scope;
    setLoading(true); setError('');
    if (!cursor) { setSelected(null); setFiles([]); setNextCursor(null); setListingNotice(''); setDirectory(path); setRootId(nextRoot); }
    try {
      const value = await listServerDataFiles(projectId, nextRoot, { path, cursor, signal: controller.signal });
      if (controller.signal.aborted || currentScope.current !== submittedScope) return;
      setDirectory(value.path);
      setFiles(current => cursor ? [...current, ...value.items.filter(item => !current.some(existing => existing.relativePath === item.relativePath))] : value.items);
      setNextCursor(value.nextCursor);
      setListingNotice(value.scanLimitReached ? 'This directory exceeds the bounded listing. Organize files into smaller subdirectories to browse the remaining sources.' : '');
    } catch (failure) { if (!controller.signal.aborted && currentScope.current === submittedScope) showFailure(failure); }
    finally { if (!controller.signal.aborted && currentScope.current === submittedScope) setLoading(false); }
  }

  async function openBrowser() {
    if (blocked) return;
    setOpen(true); setLoading(true); setError('');
    browseRequest.current?.abort();
    const controller = new AbortController(); browseRequest.current = controller;
    const submittedScope = scope;
    try {
      const value = await listServerDataRoots(projectId, controller.signal);
      if (controller.signal.aborted || currentScope.current !== submittedScope) return;
      setRoots(value.roots); setLimits(value.limits || null);
      if (value.roots[0]) await browse(value.roots[0].id);
    } catch (failure) { if (!controller.signal.aborted && currentScope.current === submittedScope) showFailure(failure); }
    finally { if (!controller.signal.aborted && currentScope.current === submittedScope) setLoading(false); }
  }

  async function checkStatus() {
    if (blocked || !requestId.current || checking) return;
    statusRequest.current?.abort();
    const controller = new AbortController(); statusRequest.current = controller;
    const submittedScope = scope; const submittedId = requestId.current;
    setChecking(true); setError('');
    try {
      const value = await getServerDataImport(projectId, submittedId, controller.signal);
      if (controller.signal.aborted || currentScope.current !== submittedScope || requestId.current !== submittedId) return;
      accept(value);
    } catch (failure) {
      if (!controller.signal.aborted && currentScope.current === submittedScope) {
        setUncertain(true);
        if (failure.status === 404 && failure.code === 'SERVER_DATA_IMPORT_NOT_FOUND') setError('This import request could not be found on the selected server. Completion remains unconfirmed; no import has been submitted again.');
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
    if (blocked || !selected || pending) return;
    const controller = new AbortController(); importRequest.current = controller;
    const submittedScope = scope; const submittedId = crypto.randomUUID(); requestId.current = submittedId;
    setImporting(true); setError(''); setReceipt(null); setUncertain(false);
    try {
      const annotations = Object.fromEntries(Object.entries(sampleMetadata).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
      const value = await importServerData(projectId, { requestId: submittedId, rootId, relativePath: selected.relativePath, selectionToken: selected.selectionToken, name: name.trim() || selected.name, artifactType, ...(Object.keys(annotations).length ? { sampleMetadata: annotations } : {}) }, controller.signal);
      if (controller.signal.aborted || currentScope.current !== submittedScope) return;
      accept(value);
    } catch (failure) {
      if (!controller.signal.aborted && currentScope.current === submittedScope) {
        if (uncertainCodes.includes(failure.code)) { setUncertain(true); setError(unconfirmed); }
        else { requestId.current = null; showFailure(failure); }
      }
    } finally { if (!controller.signal.aborted && currentScope.current === submittedScope) setImporting(false); }
  }

  return <section aria-label="Import server data" className="rounded-lg border border-border p-3 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="font-medium">Import data already on this server</h4><p className="text-xs text-textMuted">Choose a file from an authorized data folder. The server saves a private, verified snapshot; full file contents stay on the server.</p></div>
      <button type="button" className="btn btn-secondary text-sm" disabled={blocked || loading || pending} onClick={openBrowser}>{open ? 'Reload authorized data roots' : 'Browse server data'}</button>
    </div>
    {blocked && <p role="status" className="text-sm text-textMuted">{TARGET_DISCONNECTED_MESSAGE}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {open && <>
      {roots.length > 0 && <>
        <div className="flex flex-wrap gap-3 items-center"><label className="text-sm">Authorized data root<select aria-label="Authorized data root" className="input ml-2" value={rootId} disabled={blocked || loading || pending} onChange={event => browse(event.target.value)}>{roots.map(root => <option key={root.id} value={root.id}>{root.label}</option>)}</select></label>
          <button type="button" className="btn btn-secondary text-xs" disabled={blocked || loading || pending} onClick={() => browse(rootId, directory)}>Refresh server folder</button>
          <button type="button" className="btn btn-secondary text-xs" disabled={blocked || loading || pending || !directory} onClick={() => browse(rootId, directory.split('/').slice(0, -1).join('/'))}>Parent folder</button>
        </div>
        <p className="text-xs break-all" aria-label="Server folder">Folder: {directory || '/'}</p>
        <div aria-label="Available server files" className="max-h-64 overflow-auto space-y-1">{files.map(file => <button key={file.relativePath} type="button" className={`w-full border rounded p-2 text-left text-sm ${selected?.relativePath === file.relativePath ? 'border-primary bg-primary/5' : 'border-border'}`} disabled={blocked || loading || pending || file.kind === 'file' && !file.selectionToken} onClick={() => {
          if (file.kind === 'directory') browse(rootId, file.relativePath);
          else { setSelected(file); setName(file.name); setArtifactType('auto'); setSampleMetadata({}); setReceipt(null); setError(''); }
        }} aria-label={`${file.kind === 'directory' ? 'Open folder' : 'Select server file'} ${file.name}`}><span className="block break-all">{file.name}{file.kind === 'directory' ? ' /' : ''}</span>{file.kind === 'file' && <span className="text-xs text-textMuted">{artifactBytesLabel(file.sizeBytes)}{file.modifiedAt ? ` · ${new Date(file.modifiedAt).toLocaleString()}` : ''}</span>}</button>)}</div>
        {!loading && files.length === 0 && <p className="text-sm text-textMuted">No supported files or folders are available here.</p>}
        {nextCursor && <button type="button" className="btn btn-secondary text-xs" disabled={blocked || loading || pending} onClick={() => browse(rootId, directory, nextCursor)}>More server files</button>}
        {listingNotice && <p role="status" className="text-sm text-textMuted">{listingNotice}</p>}
      </>}
      {loading && <p role="status" className="text-xs text-textMuted">Loading authorized server files…</p>}
      {!loading && roots.length === 0 && !error && <p className="text-sm text-textMuted">No authorized server data roots are configured for this project. A server administrator can grant access to a data folder.</p>}
      {limits && <p className="text-xs text-textMuted">Server import limit: {artifactBytesLabel(limits.maxFileBytes)} per file · managed artifact quota {artifactBytesLabel(limits.managedQuotaBytes)}.</p>}
      {selected && <form aria-label="Save server file snapshot" onSubmit={submit} className="border-t border-border pt-3 space-y-3">
        <p className="text-xs break-all">Selected source: {roots.find(root => root.id === rootId)?.label} / {selected.relativePath} · {artifactBytesLabel(selected.sizeBytes)}{Number.isSafeInteger(selected.sizeBytes) ? ` · ${selected.sizeBytes.toLocaleString()} bytes` : ''}</p>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Server artifact name<input aria-label="Server artifact name" className="input block w-full mt-1" value={name} maxLength={160} disabled={blocked || pending} onChange={event => setName(event.target.value)} /></label>
          <label className="text-sm">Server artifact purpose<select aria-label="Server artifact purpose" className="input block w-full mt-1" value={artifactType} disabled={blocked || pending} onChange={event => setArtifactType(event.target.value)}><option value="auto">Detect from file</option><option value="sample-sheet">Sample sheet (CSV/TSV)</option></select></label></div>
        <details className="text-sm"><summary className="cursor-pointer">Sample details (optional)</summary><p className="mt-2 text-xs text-textMuted">Retain a sample description with this saved input. These annotations do not alter file contents.</p><div className="mt-2 grid gap-3 sm:grid-cols-2">{[['sampleId', 'Sample ID'], ['condition', 'Condition'], ['tissue', 'Tissue'], ['species', 'Species'], ['replicate', 'Replicate']].map(([key, label]) => <label key={key} className="text-xs">{label}<input aria-label={`Server sample ${label.toLowerCase()}`} className="input block w-full mt-1" value={sampleMetadata[key] || ''} maxLength={120} disabled={blocked || pending} onChange={event => setSampleMetadata(current => ({ ...current, [key]: event.target.value.replace(/[\r\n]/g, '') }))} /></label>)}</div></details>
        <button className="btn btn-primary text-sm" disabled={blocked || pending || !selected.selectionToken}>{importing ? 'Starting server import…' : 'Import selected server file'}</button>
      </form>}
      {(importing || receipt?.status === 'pending') && !uncertain && <div role="status" className="text-sm text-textMuted space-y-1"><p>Copying and verifying an immutable snapshot in server storage…</p>{Number.isSafeInteger(receipt?.bytesCopied) && Number.isSafeInteger(receipt?.totalBytes ?? receipt?.reservedBytes) ? <><progress aria-label="Server snapshot copy progress" className="w-full" value={receipt.bytesCopied} max={Math.max(1, receipt.totalBytes ?? receipt.reservedBytes)} /><p className="text-xs">{artifactBytesLabel(receipt.bytesCopied)} of {artifactBytesLabel(receipt.totalBytes ?? receipt.reservedBytes)} copied.</p></> : receipt?.reservedBytes ? <p className="text-xs">{artifactBytesLabel(receipt.reservedBytes)} reserved.</p> : null}{receipt?.expiresAt && <p className="text-xs">Import deadline: {new Date(receipt.expiresAt).toLocaleString()}</p>}</div>}
      {requestId.current && <div className="text-xs space-y-2"><div className="break-all">Import request: {requestId.current}</div>{(uncertain || receipt?.status === 'pending') && <button type="button" className="btn btn-secondary text-xs" disabled={blocked || checking || importing} onClick={checkStatus}>{checking ? 'Checking server import…' : 'Check server import status'}</button>}</div>}
      {receipt?.status === 'succeeded' && receipt.version && <div role="status" className="rounded border border-success/40 p-3 text-sm space-y-1"><p>Server file saved as an immutable artifact version.</p><p>{receipt.version.name} · {artifactBytesLabel(receipt.version.sizeBytes)}</p><p className="text-xs break-all">Version {receipt.version.versionId}</p><p className="text-xs font-mono break-all">SHA-256 {receipt.version.sha256}</p><p className="text-xs text-textMuted">Refresh status in the R console to select this exact saved input version.</p></div>}
    </>}
  </section>;
}
