import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import { listExistingWork } from './researchAnalysisApi';
import { normalizeResearchAnalysisCreate, validateResearchAnalysisReference } from '../../shared/researchAnalysis.mjs';
import { publicErrorMessage } from '../publicError';

const RetainedArtifactView = React.lazy(() => import('../components/RetainedArtifactView'));
const version = item => item.reference?.versionId || item.reference?.checkpointVersionId;
const time = value => new Date(value).toLocaleDateString();
const unreadable = () => new Error('The saved-work list could not be read. Refresh to try again.');
function validate(result, kind, projectId, userId) {
  if (result?.projectId !== projectId || result.kind !== kind || !Array.isArray(result.items) || result.items.length > 30) throw unreadable();
  for (const item of result.items) {
    if (!item || typeof item.id !== 'string' || !['analysis-object', 'artifact-version'].includes(item.kind)
        || typeof item.label !== 'string' || typeof item.type !== 'string' || !Number.isSafeInteger(item.ownerUserId)
        || !['yours', 'colleague'].includes(item.ownership) || !['recorded', 'not-recorded', 'restricted'].includes(item.savedState)
        || item.ownerUserId < 1 || item.ownership === 'yours' && item.ownerUserId !== userId
        || item.liveState !== 'not-checked' || !Number.isFinite(Date.parse(item.createdAt))
        || (item.savedState === 'recorded') !== !!item.reference || item.ownership === 'colleague' && item.reference) throw unreadable();
    if (item.reference !== null) validateResearchAnalysisReference(item.reference);
  }
  return result;
}

export default function ExistingWorkBrowser({ projectId, userId, projectName, canWrite, blocked, isActive, onClose, onAdopt, onOpenOriginal }) {
  const [kind, setKind] = useState('objects'), [items, setItems] = useState([]), [selectedId, setSelectedId] = useState(null);
  const [cursor, setCursor] = useState(null), [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [names, setNames] = useState({}), [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null), [detailOpen, setDetailOpen] = useState(false), [inspecting, setInspecting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [wide, setWide] = useState(false);
  const mounted = useRef(false), generation = useRef(0), request = useRef(null), frozen = useRef(null), inFlight = useRef(false);
  const layout = useRef(null), uncertain = useRef(false);
  const detail = useRef(null), list = useRef(null), listPosition = useRef(0), rows = useRef(new Map()), back = useRef(null);
  const selected = items.find(item => item.id === selectedId);
  useLayoutEffect(() => {
    if (!layout.current) return undefined;
    const resize = () => setWide(layout.current?.getBoundingClientRect().width >= 900);
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(layout.current);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  const load = useCallback(async (nextCursor = null) => {
    if (blocked) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const current = ++generation.current;
    setLoading(true); setError('');
    try {
      const result = validate(await listExistingWork(projectId, { kind, cursor: nextCursor || undefined, signal: controller.signal }), kind, projectId, userId);
      if (!mounted.current || controller.signal.aborted || current !== generation.current) return;
      setItems(previous => nextCursor ? [...new Map([...previous, ...result.items].map(item => [item.id, item])).values()] : result.items);
      setCursor(result.nextCursor || null); setLoaded(true);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && current === generation.current) {
        if ([401, 403, 404].includes(failure.status)) { setItems([]); setSelectedId(null); setDetailOpen(false); setInspecting(false); }
        setError(publicErrorMessage(failure, 'Saved work is unavailable. Refresh to try again.'));
      }
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [projectId, userId, kind, blocked]);
  useEffect(() => {
    generation.current += 1; request.current?.abort(); setLoading(false); setError('');
    setLoaded(false); setItems([]); setSelectedId(null); setDetailOpen(false); setInspecting(false);
  }, [kind]);
  useEffect(() => { if (selectedId && !selected) { setSelectedId(null); setDetailOpen(false); setInspecting(false); } }, [selectedId, selected]);
  useEffect(() => { if (isActive && !blocked && !loaded && !loading && !error) void load(); }, [isActive, blocked, loaded, loading, error, load]);
  useEffect(() => {
    if (!selectedId || !isActive) return;
    if (!wide) {
      if (detailOpen) back.current?.focus();
      else { if (list.current) list.current.scrollTop = listPosition.current; rows.current.get(selectedId)?.focus(); }
    }
  }, [selectedId, detailOpen, isActive, wide]);
  const choose = item => {
    listPosition.current = list.current?.scrollTop || 0;
    setSelectedId(item.id); setDetailOpen(true); setInspecting(false); setError('');
    if (detail.current) detail.current.scrollTop = 0;
  };
  const adopt = async event => {
    event.preventDefault();
    if (blocked || inFlight.current || !selected || !canWrite && !frozen.current) return;
    let input = frozen.current;
    try {
      if (!input) input = normalizeResearchAnalysisCreate({ requestId: crypto.randomUUID(), name: names[selected.id] ?? selected.label,
        references: [selected.reference], description: '' });
    } catch (failure) { setError(failure.message); return; }
    frozen.current = input; setPending(input); inFlight.current = true; setBusy(true); setError('');
    try {
      await onAdopt(input);
      if (mounted.current) { frozen.current = null; uncertain.current = false; setPending(null); }
    } catch (failure) {
      if (!mounted.current) return;
      // A first authoritative rejection has no earlier unknown request to
      // recover. After any uncertain reply, keep the frozen UUID even if a
      // later retry is denied: that cannot rule out the original acceptance.
      const missing = !uncertain.current && failure.status === 404 && failure.code === 'ANALYSIS_REFERENCE_NOT_FOUND';
      const invalid = !uncertain.current && failure.code === 'INVALID_RESEARCH_ANALYSIS';
      if (missing || invalid) {
        frozen.current = null; setPending(null);
      } else uncertain.current = true;
      setError(missing ? 'This saved source is no longer available. Refresh saved work or choose another source.'
        : publicErrorMessage(failure, invalid ? 'The analysis could not be created. Review its name and source before trying again.'
          : 'Creation could not be confirmed. Retry checks the same request.'));
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const original = async () => {
    if (blocked || opening || !selected || !onOpenOriginal) return;
    const objectId = selected.kind === 'analysis-object' ? selected.id : selected.reference?.analysisObjectId || selected.origin?.analysisObjectId;
    if (!objectId) return;
    setOpening(true); setError('');
    try { await onOpenOriginal(objectId); }
    catch (failure) { if (mounted.current) setError(failure.code === 'UNSAVED_LIVE_WORK'
      ? 'Save your current live analysis in Data workspace before switching objects.'
      : publicErrorMessage(failure, 'The original object history could not be opened. Your saved reference is unchanged.')); }
    finally { if (mounted.current) setOpening(false); }
  };
  return <section aria-label="Existing saved work" className="flex h-full min-h-0 flex-col bg-background px-4 py-6 text-text sm:px-8">
    <header className="mx-auto mb-5 w-full max-w-6xl shrink-0">
      <button type="button" className="mb-4 inline-flex items-center gap-2 text-sm text-textMuted underline" onClick={onClose}><ArrowLeft size={14} />Back to analyses</button>
      <p className="mb-1 text-xs text-textMuted">{projectName || 'Current project'}</p><h2 className="text-2xl font-semibold">Bring saved work into an analysis</h2>
      <p className="mt-2 max-w-2xl text-sm text-textMuted">Start from a saved version. Its data stays in place, and its original access rules still apply.</p>
    </header>
    {error && <p role="alert" className="mx-auto mb-4 w-full max-w-6xl shrink-0 rounded border border-danger/30 p-3 text-sm text-danger">{error}</p>}
    {blocked && <p role="status" className="mx-auto mb-4 w-full max-w-6xl text-sm text-textMuted">Reconnect to browse this project's saved work.</p>}
    <div ref={layout} className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 gap-6" style={{ gridTemplateColumns: wide ? 'minmax(230px,0.8fr) minmax(0,1.6fr)' : 'minmax(0,1fr)' }}>
      <div className="min-h-0 flex-col" style={{ display: !wide && detailOpen ? 'none' : 'flex' }}>
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3"><label className="text-sm">Show<select aria-label="Saved work category" className="ml-2 rounded border border-border bg-surface p-2" disabled={!!pending || busy} value={kind} onChange={event => setKind(event.target.value)}><option value="objects">Saved objects</option><option value="results">Saved results and files</option></select></label>
          <button type="button" aria-label="Refresh saved work" className="btn btn-secondary p-2" disabled={blocked || loading || busy || !!pending} onClick={() => void load()}><RefreshCw size={16} /></button></div>
        <ul ref={list} aria-label="Saved work list" tabIndex={0} className={`min-h-0 divide-y divide-border overflow-auto rounded focus-visible:ring-2 focus-visible:ring-primary ${items.length ? 'flex-1' : 'shrink-0'}`}>
          {items.map(item => <li key={item.id}><button ref={element => { if (element) rows.current.set(item.id, element); else rows.current.delete(item.id); }} type="button" aria-pressed={selectedId === item.id} disabled={!!pending || busy} onClick={() => choose(item)}
            className={`w-full rounded px-3 py-4 text-left focus-visible:ring-2 focus-visible:ring-primary ${selectedId === item.id ? 'bg-primary/10' : 'hover:bg-primary/5'}`}>
            <span className="block break-words text-sm font-semibold">{item.label}</span><span className="mt-1.5 block text-xs text-textMuted">{item.type} · {item.ownership === 'yours' ? 'Your source' : 'Colleague source'} · {time(item.createdAt)}</span>
            <span className="mt-1 block text-xs text-textMuted">{item.savedState === 'recorded' ? `Saved version · ${version(item).slice(-8)}` : item.savedState === 'restricted' ? 'Private source access required' : 'No saved version available'}</span>
          </button></li>)}
        </ul>
        {loading && <p role="status" className="py-4 text-sm text-textMuted">Finding saved work…</p>}
        {loaded && !error && !items.length && <div className="py-6 text-sm"><p className="font-medium">No {kind === 'objects' ? 'analysis objects' : 'saved results or files'} yet</p><p className="mt-2 text-textMuted">Save work in Data workspace, or start an analysis and import an ordinary script.</p></div>}
        {cursor && <button type="button" className="btn btn-secondary mt-3 shrink-0 text-sm" disabled={loading || blocked || !!pending} onClick={() => void load(cursor)}>More saved work</button>}
      </div>
      <div ref={detail} className="min-h-0 overflow-auto pb-6 pr-1" style={{ display: !wide && !detailOpen ? 'none' : 'block' }}>
        {!selected ? ((loaded || error) && !items.length ? null : <div className="py-8 text-sm text-textMuted"><FileText size={24} className="mb-4" /><p>Select saved work to review its version and start an analysis.</p></div>) : <div className="space-y-4">
          <button ref={back} type="button" style={{ display: wide ? 'none' : 'inline-flex' }} className="items-center gap-2 text-sm text-textMuted underline" onClick={() => setDetailOpen(false)}><ArrowLeft size={14} />All saved work</button>
          <h3 className="break-words text-xl font-semibold">{selected.label}</h3>
          <p className="text-sm text-textMuted">{selected.ownership === 'yours' ? 'Owned by your account.' : 'Project metadata is visible; the source belongs to a colleague.'} Live compute state has not been checked.</p>
          {selected.reference ? <>
            <p className="text-sm">An exact saved version is recorded. Inspect its metadata and supported previews.</p>
            <p className="text-xs text-textMuted">No notebook source is linked here. Starting an analysis does not recreate code or run this result.</p>
            {selected.origin?.jobId && <details className="text-xs text-textMuted"><summary className="cursor-pointer">Recorded origin</summary><dl className="mt-2 space-y-1 break-all"><dt>Run</dt><dd className="font-mono">{selected.origin.jobId}</dd>{selected.origin.package && <><dt>Method</dt><dd>{selected.origin.package.id} · {selected.origin.package.version}</dd><dt>Package checksum</dt><dd className="font-mono">{selected.origin.package.digest}</dd></>}</dl>{!selected.origin.package && <p className="mt-2">A pinned method package is not available in this source record.</p>}</details>}
            <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-secondary text-sm" disabled={blocked} onClick={() => setInspecting(value => !value)}>{inspecting ? 'Close saved version' : 'Inspect saved version'}</button>
              {onOpenOriginal && (selected.kind === 'analysis-object' || selected.reference.analysisObjectId || selected.origin?.analysisObjectId) && <button type="button" className="text-sm text-primary underline" disabled={blocked || opening} onClick={() => void original()}>{opening ? 'Opening…' : 'Open original object history'}</button>}</div>
            {(canWrite || pending) && <form aria-label="Start from saved work" className="space-y-3 border-t border-border pt-4" onSubmit={adopt}><label className="block text-sm">Analysis name<input aria-label="Adopted analysis name" required maxLength={160} className="input mt-2 w-full" disabled={busy || !!pending} value={pending?.name ?? names[selected.id] ?? selected.label} onChange={event => setNames(previous => ({ ...previous, [selected.id]: event.target.value }))} /></label>
              <button type="submit" className="btn btn-primary" disabled={blocked || busy}>{busy ? 'Creating…' : pending ? 'Retry analysis creation' : 'Start analysis with this saved version'}</button>
              {pending && !busy && <p role="status" className="text-xs text-textMuted">Retry checks the same request. Keep this window open until creation is confirmed.</p>}</form>}
            {inspecting && isActive && !blocked && <React.Suspense fallback={<p role="status" className="text-sm text-textMuted">Opening saved version…</p>}><RetainedArtifactView key={version(selected)} projectId={projectId} userId={userId} reference={selected.reference} /></React.Suspense>}
          </> : <div className="space-y-4 border-t border-border pt-4"><p className="text-sm text-textMuted">{selected.savedState === 'restricted' ? 'Your project role does not grant access to this colleague’s private saved source. Ask its owner to publish the evidence they want to share.' : 'No usable saved version is recorded. Open the original object history to review it, or save a version in Data workspace first.'}</p>
            {onOpenOriginal && selected.kind === 'analysis-object' && <button type="button" className="btn btn-secondary text-sm" disabled={blocked || opening} onClick={() => void original()}>Open original object history</button>}</div>}
        </div>}
      </div>
    </div>
  </section>;
}
