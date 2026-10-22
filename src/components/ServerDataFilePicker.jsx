import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listServerDataFiles, listServerDataImports, listServerDataRoots } from '../artifacts/serverDataApi';
import { artifactBytesLabel } from '../artifacts/privateRArtifactPolicy';
import { normalizeServerDataImportPath, SERVER_DATA_IMPORT_ROOT_ID } from '../../shared/serverDataImport.mjs';
import useExecutionTarget from '../runtime/useExecutionTarget';

const invalid = () => Object.assign(new Error('The server folder response could not be confirmed. Refresh the folder before choosing a file.'), { code: 'SERVER_DATA_SELECTION_INVALID' });
const ordinary = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = (value, maximum) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
function rootResponse(value) {
  if (!ordinary(value) || !Array.isArray(value.roots) || value.roots.length > 32 || !ordinary(value.limits)
      || !Number.isSafeInteger(value.limits.maxFileBytes) || value.limits.maxFileBytes < 1
      || !Number.isSafeInteger(value.limits.managedQuotaBytes) || value.limits.managedQuotaBytes < 1
      || value.roots.some(item => !ordinary(item) || typeof item.id !== 'string' || !SERVER_DATA_IMPORT_ROOT_ID.test(item.id) || !text(item.label, 80))
      || new Set(value.roots.map(item => item.id)).size !== value.roots.length) throw invalid();
  return { roots: value.roots.map(item => ({ id: item.id, label: item.label })), limits: { ...value.limits } };
}
function folderResponse(value, selectedRoot, directory) {
  if (!ordinary(value) || !ordinary(value.root) || value.root.id !== selectedRoot.id || value.root.label !== selectedRoot.label
      || value.path !== directory || !Array.isArray(value.items) || value.items.length > 100
      || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 1600 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value.nextCursor))
      || value.scanLimitReached !== undefined && value.scanLimitReached !== true) throw invalid();
  const items = value.items.map(item => {
    if (!ordinary(item) || !['file', 'directory'].includes(item.kind) || !text(item.name, 240)
        || normalizeServerDataImportPath(item.relativePath) !== [directory, item.name].filter(Boolean).join('/')) throw invalid();
    if (item.kind === 'directory') return { kind: item.kind, name: item.name, relativePath: item.relativePath };
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || typeof item.selectionToken !== 'string' || !/^[a-f0-9]{64}$/.test(item.selectionToken)
        || typeof item.modifiedAt !== 'string' || item.modifiedAt.length > 40 || !Number.isFinite(Date.parse(item.modifiedAt))) throw invalid();
    return { kind: item.kind, name: item.name, relativePath: item.relativePath, sizeBytes: item.sizeBytes, selectionToken: item.selectionToken, modifiedAt: item.modifiedAt };
  });
  if (new Set(items.map(item => item.relativePath)).size !== items.length) throw invalid();
  return { items, nextCursor: value.nextCursor, scanLimitReached: value.scanLimitReached === true };
}

// A source selector only: every request is GET metadata. Copying, request
// admission, attachment intent and retained outcomes belong to the caller.
export default function ServerDataFilePicker({ projectId, userId, serviceId, available = true, disabled = false, refreshKey = 0,
  onSelect, onAuthority, onDenied, onError, onLimits, onLoading, allowedExtensions, maxFileBytes }) {
  const connection = useExecutionTarget();
  const [roots, setRoots] = useState([]), [limits, setLimits] = useState(null), [rootId, setRootId] = useState('');
  const [directory, setDirectory] = useState(''), [items, setItems] = useState([]), [cursor, setCursor] = useState(null);
  const [selectedPath, setSelectedPath] = useState(null), [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false), [scanLimit, setScanLimit] = useState(false);
  const mounted = useRef(false), request = useRef(null), boundService = useRef(null), loadedRef = useRef(false), inFlight = useRef(false);
  const scope = JSON.stringify([projectId, userId, connection.identity, connection.epoch]);
  const usable = available && !connection.blocked;
  const live = useRef(null), lifecycle = useRef(null);
  live.current = { projectId, userId, serviceId, scope, usable, disabled, onSelect, onAuthority, onDenied, onError, onLimits, onLoading };
  const callbacks = () => live.current;
  const cancel = useCallback(() => { request.current?.abort(); request.current = null; }, []);
  const current = (controller, submittedScope) => mounted.current && !controller.signal.aborted && request.current === controller
    && live.current.scope === submittedScope && live.current.usable && !live.current.disabled;
  const working = useCallback(value => { inFlight.current = value; setLoading(value); live.current.onLoading?.(value); }, []);
  const clear = useCallback(() => {
    setRoots([]); setLimits(null); setRootId(''); setDirectory(''); setItems([]); setCursor(null); setSelectedPath(null);
    setLoaded(false); loadedRef.current = false; inFlight.current = false; setFailed(false); setScanLimit(false); setLoading(false);
    live.current.onSelect?.(null); live.current.onLimits?.(null); live.current.onLoading?.(false);
  }, []);
  function failure(error) {
    setFailed(true);
    const sourceDenied = error.code === 'SERVER_IMPORT_UNAVAILABLE' || error.code === 'SERVER_IMPORT_NOT_FOUND';
    if (sourceDenied) { clear(); setFailed(true); callbacks().onAuthority?.(false, { serviceId: boundService.current, code: error.code }); }
    else if ([401, 403, 404].includes(error.status)) { clear(); setFailed(true); callbacks().onDenied?.(error); }
    callbacks().onError?.(error);
  }
  async function folder(selectedRoot, path, next, controller, submittedScope) {
    const value = folderResponse(await listServerDataFiles(live.current.projectId, selectedRoot.id, { path, cursor: next, signal: controller.signal }), selectedRoot, path);
    if (!current(controller, submittedScope)) return;
    setRootId(selectedRoot.id); setDirectory(path);
    setItems(previous => next ? [...previous, ...value.items.filter(item => !previous.some(old => old.relativePath === item.relativePath))] : value.items);
    setCursor(value.nextCursor); setScanLimit(value.scanLimitReached); setLoaded(true); loadedRef.current = true;
  }
  const discover = useRef(null);
  discover.current = async () => {
    cancel();
    const controller = new AbortController(); request.current = controller;
    const source = live.current, submittedScope = source.scope;
    if (!source.usable || source.disabled) return;
    setFailed(false); working(true); source.onError?.(null);
    try {
      const discovery = await listServerDataImports(source.projectId, { userId: source.userId,
        serviceId: source.serviceId || boundService.current || undefined, signal: controller.signal });
      if (!current(controller, submittedScope)) return;
      if (discovery.projectId !== String(source.projectId) || discovery.ownerUserId !== Number(source.userId)
          || typeof discovery.serviceId !== 'string' || !/^svc_[a-f0-9]{32}$/.test(discovery.serviceId)
          || (source.serviceId || boundService.current) && discovery.serviceId !== (source.serviceId || boundService.current)
          || typeof discovery.canImport !== 'boolean') throw invalid();
      boundService.current = discovery.serviceId;
      source.onAuthority?.(discovery.canImport, { serviceId: discovery.serviceId });
      if (!discovery.canImport) { clear(); setFailed(true); return; }
      const value = rootResponse(await listServerDataRoots(source.projectId, controller.signal));
      if (!current(controller, submittedScope)) return;
      setRoots(value.roots); setLimits(value.limits); source.onLimits?.(value.limits);
      setItems([]); setCursor(null); setSelectedPath(null); source.onSelect?.(null);
      if (value.roots[0]) await folder(value.roots[0], '', null, controller, submittedScope);
      else { setRootId(''); setDirectory(''); setLoaded(true); loadedRef.current = true; }
    } catch (error) { if (current(controller, submittedScope)) failure(error); }
    finally { if (mounted.current && request.current === controller && !controller.signal.aborted) working(false); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancel(); }; }, [cancel]);
  useEffect(() => {
    const previous = lifecycle.current;
    const changedScope = previous?.scope !== scope;
    const changedService = !!serviceId && serviceId !== (boundService.current || previous?.serviceId);
    const refresh = previous?.refreshKey !== refreshKey;
    const resumed = !previous?.usable && usable;
    lifecycle.current = { scope, refreshKey, usable, serviceId };
    if (changedScope || changedService) { cancel(); boundService.current = serviceId || null; clear(); }
    if (!usable) { cancel(); clear(); return; }
    if (disabled) { cancel(); working(false); return; }
    if (changedScope || changedService || refresh || resumed || !loadedRef.current && !failed && !inFlight.current) void discover.current();
  }, [scope, serviceId, refreshKey, usable, disabled, failed, cancel, clear, working]);
  async function browse(selectedRoot, path = '', next) {
    if (!usable || disabled || loading) return;
    normalizeServerDataImportPath(path, { directory: true });
    cancel(); const controller = new AbortController(); request.current = controller; const submittedScope = scope;
    working(true); setFailed(false); callbacks().onError?.(null);
    if (!next) { setSelectedPath(null); callbacks().onSelect?.(null); setItems([]); setCursor(null); setScanLimit(false); }
    try { await folder(selectedRoot, path, next, controller, submittedScope); }
    catch (error) { if (current(controller, submittedScope)) failure(error); }
    finally { if (mounted.current && request.current === controller && !controller.signal.aborted) working(false); }
  }
  const extensions = allowedExtensions?.map(value => value.toLowerCase().replace(/^\./, ''));
  const maximum = Math.min(limits?.maxFileBytes ?? Infinity, maxFileBytes ?? Infinity);
  const unsupported = file => file.sizeBytes < 1 ? 'Empty file' : file.sizeBytes > maximum ? 'Exceeds the import limit'
    : extensions && !extensions.includes(file.name.split('.').at(-1).toLowerCase()) ? 'Choose a supported table or figure' : null;
  const chosenRoot = roots.find(value => value.id === rootId);
  return <section aria-label="Server file selection" className="space-y-3 min-w-0">
    {roots.length > 0 && <>
      <div className="flex flex-wrap gap-2 items-end"><label className="block min-w-0 text-sm">Server folder<select aria-label="Server folder" className="input block mt-1 max-w-full" value={rootId} disabled={!usable || disabled || loading} onChange={event => void browse(roots.find(value => value.id === event.target.value))}>{roots.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
        <button type="button" className="btn btn-secondary text-xs" disabled={!usable || disabled || loading} onClick={() => void browse(chosenRoot, directory)}>Refresh server folder</button>
        <button type="button" className="btn btn-secondary text-xs" disabled={!usable || disabled || loading || !directory} onClick={() => void browse(chosenRoot, directory.split('/').slice(0, -1).join('/'))}>Parent folder</button></div>
      <p className="text-xs break-all" aria-label="Server folder path">Folder: {directory || '/'}</p>
      <div aria-label="Available server files" className="max-h-64 overflow-auto space-y-1">{items.map(file => {
        const reason = file.kind === 'file' ? unsupported(file) : null;
        return <button key={file.relativePath} type="button" className={`w-full border rounded p-2 text-left text-sm ${selectedPath === file.relativePath ? 'border-primary bg-primary/5' : 'border-border'}`} disabled={!usable || disabled || loading || !!reason}
          onClick={() => file.kind === 'directory' ? void browse(chosenRoot, file.relativePath) : (() => { setSelectedPath(file.relativePath); callbacks().onSelect?.({ rootId, rootLabel: chosenRoot.label, file: { ...file }, limits: { ...limits }, serviceId: boundService.current }); })()}
          aria-label={`${file.kind === 'directory' ? 'Open folder' : 'Select server file'} ${file.name}`}><span className="block break-all">{file.name}{file.kind === 'directory' ? ' /' : ''}</span>{file.kind === 'file' && <span className="text-xs text-textMuted">{artifactBytesLabel(file.sizeBytes)} · {reason || new Date(file.modifiedAt).toLocaleString()}</span>}</button>;
      })}</div>
      {loaded && !loading && !failed && items.length === 0 && <p className="text-sm text-textMuted">No supported files or folders are available here.</p>}
      {cursor && <button type="button" className="btn btn-secondary text-xs" disabled={!usable || disabled || loading} onClick={() => void browse(chosenRoot, directory, cursor)}>More server files</button>}
      {scanLimit && <p role="status" className="text-xs text-textMuted">This folder exceeds the bounded listing. Organize files into smaller folders to browse the remaining sources.</p>}
    </>}
    {usable && !disabled && !loading && (failed || loaded) && roots.length === 0 && <div className="space-y-2">
      <p className="text-xs leading-relaxed text-textMuted">{failed
        ? 'Server folders could not be opened. Check your connection or ask for access to a data folder, then refresh. Your saved files and import requests are kept.'
        : 'No allowed server folders are configured for this project. Ask the server administrator to grant access to a data folder.'}</p>
      <button type="button" className="btn btn-secondary text-xs" disabled={loading} onClick={() => void discover.current()}>Refresh server folders</button>
    </div>}
    {loading && <p role="status" className="text-xs text-textMuted">Loading server folders…</p>}
    {limits && <p className="text-xs text-textMuted">Server import limit: {artifactBytesLabel(maximum)} per file · managed artifact quota {artifactBytesLabel(limits.managedQuotaBytes)}.</p>}
  </section>;
}
