import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, FileImage, Plus, RefreshCw } from 'lucide-react';
import { normalizeAnalysisAttachmentCreate, ANALYSIS_ATTACHMENT_LIMITS } from '../../shared/analysisAttachment.mjs';
import { createAnalysisAttachment, getAnalysisAttachmentRequest, listAnalysisAttachments, listAnalysisAttachmentOptions } from './analysisAttachmentApi';
import { validateAttachmentAcceptance, validateAttachmentList, validateAttachmentOptions } from './analysisAttachmentValidation';
import { publicErrorMessage } from '../publicError';

const RetainedArtifactView = React.lazy(() => import('../components/RetainedArtifactView'));
const noteLabels = { origin: 'Where this result came from', sourceReference: 'Code or method reference', documentReference: 'Supporting document reference', environmentReference: 'Environment reference' };
const blankContext = () => Object.fromEntries(Object.keys(noteLabels).map(key => [key, '']));
const denied = failure => [401, 403].includes(failure.status) || failure.status === 404
  && !['ANALYSIS_ATTACHMENT_REQUEST_NOT_FOUND', 'ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE'].includes(failure.code);
const compactId = reference => reference.versionId.slice(-8);
const formatName = format => ({ 'org.ietf.csv': 'CSV table', 'org.iana.tsv': 'TSV table', 'org.w3.png': 'PNG figure', 'org.iso.jpeg': 'JPEG figure' })[format.id] || 'Saved file';

function SuppliedContext({ revision }) {
  return <details className="mt-3 text-sm"><summary className="cursor-pointer text-textMuted">Supplied context and exact version</summary>
    <p className="mt-3 text-xs leading-relaxed text-textMuted">These notes were supplied by a researcher. Execution evidence for this attachment is unknown; these notes do not verify how the result was produced.</p>
    <dl className="mt-3 space-y-3">{Object.entries(noteLabels).map(([key, label]) => <div key={key}><dt className="text-xs text-textMuted">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{revision.suppliedOrigin[key] || 'Unknown / not supplied'}</dd></div>)}
      <div><dt className="text-xs text-textMuted">Exact saved version</dt><dd className="mt-1 break-all font-mono text-xs">{revision.reference.versionId}</dd></div>
      <div><dt className="text-xs text-textMuted">SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{revision.reference.sha256}</dd></div>
      <div><dt className="text-xs text-textMuted">Attachment revision</dt><dd className="mt-1 break-all font-mono text-xs">{revision.id}</dd></div>
    </dl>
  </details>;
}

function AttachmentCollection({ projectId, projectName, analysis, userId, role, connection, isActive, onClose }) {
  const scope = { projectId, analysisId: analysis.id, userId };
  const [items, setItems] = useState([]), [cursor, setCursor] = useState(null), [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false), [authority, setAuthority] = useState(null), [error, setError] = useState('');
  const [readDenied, setReadDenied] = useState(false);
  const [formOpen, setFormOpen] = useState(false), [options, setOptions] = useState([]), [optionCursor, setOptionCursor] = useState(null);
  const [optionsLoading, setOptionsLoading] = useState(false), [optionsLoaded, setOptionsLoaded] = useState(false);
  const [chosen, setChosen] = useState(null), [caption, setCaption] = useState(''), [context, setContext] = useState(blankContext);
  const [pending, setPending] = useState(null), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(null), [selection, setSelection] = useState(null), [wide, setWide] = useState(false);
  const mounted = useRef(false), listRequest = useRef(null), optionRequest = useRef(null), actionRequest = useRef(null);
  const listGeneration = useRef(0), optionGeneration = useRef(0), pendingRef = useRef(null), uncertain = useRef(false), inFlight = useRef(false);
  const layout = useRef(null), back = useRef(null), formButton = useRef(null), list = useRef(null), listPosition = useRef(0);
  const inspectTrigger = useRef(null), overviewBack = useRef(null);
  const canWrite = ['owner', 'admin', 'analyst'].includes(role) && analysis.status === 'active' && authority !== false;
  const available = isActive && !connection.blocked;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; listRequest.current?.abort(); optionRequest.current?.abort(); actionRequest.current?.abort(); }; }, []);
  useLayoutEffect(() => {
    if (!layout.current) return undefined;
    const resize = () => setWide(layout.current?.getBoundingClientRect().width >= 900);
    resize(); const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(layout.current); return () => observer?.disconnect();
  }, []);
  const clearAccess = () => {
    listGeneration.current += 1; optionGeneration.current += 1;
    listRequest.current?.abort(); optionRequest.current?.abort(); setLoading(false); setOptionsLoading(false);
    actionRequest.current?.abort(); actionRequest.current = null; inFlight.current = false; setBusy(false);
    if (pendingRef.current) uncertain.current = true;
    setItems([]); setOptions([]); setSelection(null); setChosen(null); setConfirmation(null); setAuthority(false); setReadDenied(true); setLoaded(false);
    if (list.current) list.current.scrollTop = 0;
  };
  const load = useCallback(async (next = null) => {
    if (connection.blocked) return;
    listRequest.current?.abort(); const controller = new AbortController(); listRequest.current = controller;
    const generation = ++listGeneration.current; setLoading(true); setError('');
    try {
      const result = validateAttachmentList(await listAnalysisAttachments(projectId, analysis.id, { cursor: next, signal: controller.signal }), { projectId, analysisId: analysis.id, userId });
      if (!mounted.current || controller.signal.aborted || generation !== listGeneration.current) return;
      setItems(previous => next ? [...new Map([...previous, ...result.attachments].map(item => [item.id, item])).values()] : result.attachments);
      setCursor(result.nextCursor); setAuthority(result.canWrite); setReadDenied(false); setLoaded(true);
      setSelection(previous => previous?.kind === 'attached' ? result.attachments.find(item => item.id === previous.item.id) ? { kind: 'attached', item: result.attachments.find(item => item.id === previous.item.id) } : previous : previous);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || generation !== listGeneration.current) return;
      if (denied(failure)) clearAccess();
      setError(publicErrorMessage(failure, 'Outside results could not be loaded. Your attachment draft is kept here.'));
    } finally { if (mounted.current && generation === listGeneration.current) setLoading(false); }
  }, [projectId, analysis.id, userId, connection.blocked]);
  useEffect(() => { if (available && !loaded && !loading && !error) void load(); }, [available, loaded, loading, error, load]);
  useEffect(() => {
    if (!available) return undefined;
    const frame = requestAnimationFrame(() => overviewBack.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [available]);
  useEffect(() => {
    if (available) return;
    listGeneration.current += 1; optionGeneration.current += 1; listRequest.current?.abort(); optionRequest.current?.abort();
    actionRequest.current?.abort(); actionRequest.current = null; inFlight.current = false; setBusy(false);
    if (pendingRef.current) uncertain.current = true;
    setLoading(false); setOptionsLoading(false); setLoaded(false); setSelection(null);
  }, [available]);
  useEffect(() => { if (selection && !wide && available) back.current?.focus({ preventScroll: true }); }, [selection, wide, available]);
  const findOptions = async (next = null) => {
    if (connection.blocked || inFlight.current) return;
    optionRequest.current?.abort(); const controller = new AbortController(); optionRequest.current = controller;
    const generation = ++optionGeneration.current; setOptionsLoading(true); setError('');
    try {
      const result = validateAttachmentOptions(await listAnalysisAttachmentOptions(projectId, analysis.id, { cursor: next, signal: controller.signal }), scope);
      if (!mounted.current || controller.signal.aborted || generation !== optionGeneration.current) return;
      setOptions(previous => next ? [...new Map([...previous, ...result.items].map(item => [item.reference.versionId, item])).values()] : result.items);
      setOptionCursor(result.nextCursor); setAuthority(result.canWrite); setOptionsLoaded(true);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || generation !== optionGeneration.current) return;
      if (denied(failure)) clearAccess();
      setError(publicErrorMessage(failure, 'Saved files could not be listed. Your caption and context are kept here.'));
    } finally { if (mounted.current && generation === optionGeneration.current) setOptionsLoading(false); }
  };
  const accept = async (input, lookup) => {
    if (inFlight.current || connection.blocked || !lookup && !canWrite) return;
    inFlight.current = true; setBusy(true); setError('');
    const controller = new AbortController(); actionRequest.current = controller;
    try {
      const raw = lookup ? await getAnalysisAttachmentRequest(projectId, analysis.id, input.requestId, { signal: controller.signal })
        : await createAnalysisAttachment(projectId, analysis.id, input, { signal: controller.signal });
      const result = await validateAttachmentAcceptance(raw, scope, input);
      if (!mounted.current || controller.signal.aborted || actionRequest.current !== controller || pendingRef.current !== input) return;
      optionGeneration.current += 1; optionRequest.current?.abort(); setOptionsLoading(false);
      setAuthority(result.canWrite); setReadDenied(false); setConfirmation(result); setPending(null); pendingRef.current = null; uncertain.current = false;
      setChecked(false); setFormOpen(false); setCaption(''); setContext(blankContext()); setChosen(null);
      void load();
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || actionRequest.current !== controller || pendingRef.current !== input) return;
      const missingReceipt = lookup && failure.status === 404 && failure.code === 'ANALYSIS_ATTACHMENT_REQUEST_NOT_FOUND';
      if (denied(failure)) clearAccess();
      if (lookup) setChecked(true);
      const certain = !lookup && !uncertain.current && ['INVALID_ANALYSIS_ATTACHMENT', 'ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE', 'ANALYSIS_ARCHIVED', 'ANALYSIS_ATTACHMENT_LIMIT'].includes(failure.code);
      if (certain) {
        setPending(null); pendingRef.current = null;
        if (failure.code === 'ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE') {
          setChosen(null); setOptions(previous => previous.filter(option => option.reference.versionId !== input.reference.versionId));
          setSelection(previous => previous?.kind === 'candidate' && previous.item.reference.versionId === input.reference.versionId ? null : previous);
        }
      }
      else uncertain.current = true;
      setError(missingReceipt ? 'No accepted attachment receipt is available yet. This does not prove the original request was rejected. Keep the original request and check again.'
        : publicErrorMessage(failure, certain ? 'This result was not attached. Your caption and supplied context are kept here.' : 'Attachment completion is unconfirmed. Check the original request before retrying.'));
    } finally { if (actionRequest.current === controller) { inFlight.current = false; if (mounted.current) setBusy(false); } }
  };
  const submit = event => {
    event.preventDefault();
    if (pendingRef.current || !chosen || !canWrite || connection.blocked || inFlight.current) return;
    let input;
    try { input = normalizeAnalysisAttachmentCreate({ requestId: crypto.randomUUID(), reference: chosen.reference, caption, suppliedOrigin: context }); }
    catch (failure) { setError(failure.message); return; }
    pendingRef.current = input; setPending(input); setChecked(false); setConfirmation(null); void accept(input, false);
  };
  const inspect = value => { inspectTrigger.current = document.activeElement; listPosition.current = list.current?.scrollTop || 0; setSelection(value); };
  const selectedRevision = selection?.kind === 'attached' ? selection.item.revision : null;
  const selectedReference = selectedRevision?.reference || selection?.item.reference;
  const sourceAllowed = selection?.kind === 'candidate' || selection?.item.sourceAccess === 'available';
  return <section aria-label="Outside results" className="flex h-full min-h-0 flex-col overflow-hidden bg-background px-4 py-6 text-text sm:px-8">
    <header className="mx-auto mb-5 w-full max-w-6xl shrink-0">
      <button ref={overviewBack} type="button" className="mb-4 inline-flex items-center gap-2 text-sm text-textMuted underline" onClick={onClose}><ArrowLeft size={14} />Back to analysis</button>
      <p className="text-xs text-textMuted">{projectName || 'Current project'}</p><h2 className="mt-1 break-words text-2xl font-semibold">Outside results</h2>
      <p className="mt-2 break-words text-sm text-textMuted">{analysis.name} · Keep an existing result with its caption and context.</p>
    </header>
    {error && <p role="alert" className="mx-auto mb-4 w-full max-w-6xl shrink-0 rounded border border-danger/30 p-3 text-sm text-danger">{error}</p>}
    {connection.blocked && <p role="status" className="mx-auto mb-4 w-full max-w-6xl text-sm text-textMuted">Reconnect to this workspace to read or attach results. Your caption and supplied context are kept here.</p>}
    <div ref={layout} className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 gap-6" style={{ gridTemplateColumns: wide && selection ? 'minmax(260px,0.9fr) minmax(0,1.3fr)' : 'minmax(0,1fr)' }}>
      <div hidden={!wide && !!selection} className="min-h-0 min-w-0 flex-col" style={{ display: !wide && selection ? 'none' : 'flex' }}>
        <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Attached results</h3><div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary text-xs" disabled={loading || connection.blocked} onClick={() => void load()}><RefreshCw size={14} className="mr-1 inline" />Refresh results</button>
            {canWrite && <button ref={formButton} type="button" className="btn btn-primary text-xs" disabled={busy || !!pending || connection.blocked} onClick={() => { setFormOpen(value => !value); setError(''); }}><Plus size={14} className="mr-1 inline" />{formOpen ? 'Close attachment form' : 'Attach outside result'}</button>}
          </div>
        </div>
        <div ref={list} tabIndex={0} aria-label="Outside results and attachment form" className="min-h-0 min-w-0 flex-1 space-y-4 overflow-auto rounded focus-visible:ring-2 focus-visible:ring-primary">
          {pending && <section aria-label="Attachment recovery" className="space-y-3 rounded-lg border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold">{busy ? 'Checking the original attachment request…' : 'Attachment completion is unconfirmed'}</h3>
            <p className="whitespace-pre-wrap break-words text-sm">{pending.caption}</p>
            <p className="text-xs leading-relaxed text-textMuted">The exact file reference, caption and context are fixed while this request is unconfirmed. Nothing is retried automatically. Keep this page open to check this request.</p>
            <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-secondary text-xs" disabled={busy || connection.blocked} onClick={() => void accept(pendingRef.current, true)}>Check attachment outcome</button>
              {checked && canWrite && <button type="button" className="btn btn-secondary text-xs" disabled={busy || connection.blocked} onClick={() => void accept(pendingRef.current, false)}>Retry original attachment</button>}</div>
            <details className="text-xs text-textMuted"><summary className="cursor-pointer">Original attachment identity</summary><p className="mt-2 break-all font-mono">{pending.requestId}</p><p className="mt-2 break-all font-mono">{pending.reference.versionId}</p></details>
          </section>}
          {confirmation && <section aria-label="Attachment confirmed" className="space-y-3 rounded-lg border border-border bg-surface p-4">
            <p role="status" className="text-sm font-medium">Result attached. Checking this request does not create another attachment.</p>
            <p className="whitespace-pre-wrap break-words text-sm text-textMuted">{confirmation.acceptedRevision.caption}</p>
            <button type="button" className="btn btn-secondary text-xs" onClick={() => inspect({ kind: 'attached', item: confirmation.attachment })}>Inspect attached result</button>
          </section>}
          {formOpen && <form aria-label="Attach outside result" onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-5">
            <h3 className="font-semibold">Attach a saved table or figure</h3><p className="text-xs leading-relaxed text-textMuted">Choose one of your managed CSV, TSV, PNG or JPEG versions. The file stays in place and keeps its current source access.</p>
            <button type="button" className="btn btn-secondary text-xs" disabled={optionsLoading || !!pending || busy || !canWrite || connection.blocked} onClick={() => void findOptions()}>Choose saved file</button>
            {optionsLoading && <p role="status" className="text-xs text-textMuted">Finding your saved files…</p>}
            {optionsLoaded && !options.length && <p className="text-sm text-textMuted">No supported files are available to your account. Import a table or figure in Runs &amp; Results first.</p>}
            {!!options.length && <fieldset disabled={!!pending || busy || !canWrite || connection.blocked} className="min-w-0"><legend className="mb-2 text-sm">Your saved files</legend><div tabIndex={0} aria-label="Saved files for attachment" className="max-h-60 space-y-2 overflow-auto rounded border border-border p-2 focus-visible:ring-2 focus-visible:ring-primary">{options.map(option => <div key={option.reference.versionId} className="flex min-w-0 items-start gap-2 rounded border border-border p-3">
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-sm"><input type="radio" name={`attachment-source-${analysis.id}`} checked={chosen?.reference.versionId === option.reference.versionId} onChange={() => setChosen(option)} className="mt-1" /><span className="min-w-0 break-words">{option.name}<span className="mt-1 block text-xs text-textMuted">{formatName(option.format)} · {compactId(option.reference)}</span></span></label>
              <button type="button" className="shrink-0 text-xs text-primary underline" aria-label={`Preview ${option.name}`} onClick={() => inspect({ kind: 'candidate', item: option })}>Preview</button>
            </div>)}</div>{optionCursor && <button type="button" className="btn btn-secondary mt-2 text-xs" disabled={optionsLoading} onClick={() => void findOptions(optionCursor)}>Load more saved files</button>}</fieldset>}
            {chosen && <p className="break-words text-xs text-textMuted">Selected: {chosen.name} · exact version {compactId(chosen.reference)}</p>}
            <label className="block text-sm">Caption<textarea aria-label="Result caption" required maxLength={ANALYSIS_ATTACHMENT_LIMITS.caption} value={caption} rows={3} disabled={!!pending || busy || !canWrite} onChange={event => setCaption(event.target.value)} className="mt-2 w-full rounded border border-border bg-background p-3" placeholder="What should a colleague notice in this result?" /></label>
            <details className="text-sm"><summary className="cursor-pointer">Add supplied origin and references (optional)</summary><p className="mt-3 text-xs leading-relaxed text-textMuted">Plain notes or citations only. Leave unknown information blank. These references are not verified execution evidence.</p><div className="mt-4 space-y-4">{Object.entries(noteLabels).map(([key, label]) => <label key={key} className="block text-sm">{label}<textarea aria-label={label} maxLength={ANALYSIS_ATTACHMENT_LIMITS.origin} value={context[key]} rows={2} disabled={!!pending || busy || !canWrite} onChange={event => setContext(previous => ({ ...previous, [key]: event.target.value }))} className="mt-2 w-full rounded border border-border bg-background p-3" /></label>)}</div></details>
            <p className="text-xs leading-relaxed text-textMuted">The caption and context are visible to this project's readers. Attaching the file does not grant access to its private contents.</p>
            <button type="submit" className="btn btn-primary text-sm" disabled={!!pending || busy || !canWrite || connection.blocked || !chosen || !caption.trim()}>Attach result</button>
          </form>}
          {loading && <p role="status" className="text-sm text-textMuted">Loading attached results…</p>}
          {loaded && !items.length && <div className="rounded-lg border border-dashed border-border p-6"><FileImage size={22} className="mb-3 text-textMuted" /><h3 className="text-sm font-semibold">No outside results attached</h3><p className="mt-2 max-w-xl text-sm leading-relaxed text-textMuted">Keep a table or figure from existing work beside this analysis, with a caption that explains why it matters.</p></div>}
          {readDenied ? <p className="text-xs text-textMuted">Access to this analysis could not be confirmed. Your original request and unsaved caption are kept here. Reconnect or ask a project owner to restore access.</p>
            : authority === false && <p className="text-xs text-textMuted">You can read retained attachment context. New attachments require current write access to an active analysis.</p>}
          <ul aria-label="Attached outside results" className="space-y-3">{items.map(item => <li key={item.id} className="min-w-0 rounded-lg border border-border bg-surface p-4"><span className="text-xs text-textMuted">Imported result · revision {item.revision.revisionNumber}</span><p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium">{item.revision.caption}</p><p className="mt-2 text-xs text-textMuted">{item.sourceAccess === 'available' ? 'Exact source version · private source access applies' : item.sourceAccess === 'restricted' ? 'Source access is restricted' : 'Original source is unavailable; context is retained'}</p><button type="button" className="btn btn-secondary mt-3 text-xs" onClick={() => inspect({ kind: 'attached', item })}>Inspect result and context</button></li>)}</ul>
          {cursor && <button type="button" className="btn btn-secondary text-xs" disabled={loading || connection.blocked} onClick={() => void load(cursor)}>Load more attached results</button>}
        </div>
      </div>
      {selection && <section aria-label="Outside result details" className="min-h-0 min-w-0 space-y-4 overflow-auto rounded border border-border bg-surface p-4 sm:p-5">
        <button ref={back} type="button" className="inline-flex items-center gap-2 text-sm text-textMuted underline" onClick={() => { setSelection(null); requestAnimationFrame(() => { if (list.current) list.current.scrollTop = listPosition.current; const target = inspectTrigger.current?.isConnected ? inspectTrigger.current : formButton.current || list.current; target?.focus({ preventScroll: true }); }); }}><ArrowLeft size={14} />{wide ? 'Close details' : 'Back to outside results'}</button>
        {selectedRevision ? <><p className="text-xs text-textMuted">Imported result · supplied context</p><h3 className="whitespace-pre-wrap break-words font-semibold">{selectedRevision.caption}</h3><SuppliedContext revision={selectedRevision} /></> : <><p className="text-xs text-textMuted">Saved file preview · not attached yet</p><h3 className="break-words font-semibold">{selection.item.name}</h3></>}
        {available && sourceAllowed ? <React.Suspense fallback={<p role="status" className="text-sm text-textMuted">Opening the saved result…</p>}><RetainedArtifactView key={`${selectedReference.versionId}:${selectedReference.sha256}`} projectId={projectId} userId={userId} reference={selectedReference} compact /></React.Suspense>
          : <p className="text-sm leading-relaxed text-textMuted">{connection.blocked ? 'Reconnect to inspect this saved source.' : selection.item.sourceAccess === 'restricted' ? 'This source remains private to its owner. The attachment has not granted access to the file.' : 'The original source is unavailable. Its exact identity, caption and supplied context are retained.'}</p>}
      </section>}
    </div>
  </section>;
}

// Keep each visited analysis's caption and pending request while navigating
// within this workspace. Source previews mount only for the active collection.
export default function AnalysisAttachments(props) {
  const [visited, setVisited] = useState(() => [props.analysis]);
  useEffect(() => { setVisited(previous => previous.some(item => item.id === props.analysis.id) ? previous : [...previous, props.analysis]); }, [props.analysis]);
  const entries = visited.some(item => item.id === props.analysis.id) ? visited : [...visited, props.analysis];
  return <>{entries.map(item => <div key={item.id} hidden={!props.isActive || item.id !== props.analysis.id} className="h-full min-h-0">
    <AttachmentCollection {...props} analysis={item.id === props.analysis.id ? props.analysis : item} isActive={props.isActive && item.id === props.analysis.id} />
  </div>)}</>;
}
