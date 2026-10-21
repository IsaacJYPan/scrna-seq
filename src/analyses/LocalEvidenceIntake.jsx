import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { normalizeAnalysisLocalIntake, analysisLocalIntakeAttachmentRequest } from '../../shared/analysisLocalIntake.mjs';
import { prepareArtifactImportRequest, artifactImportRequestSha256, canonicalArtifactImportRequest } from '../artifacts/artifactImportReceipt';
import { importArtifactVersion } from '../artifacts/artifactApi';
import { createAnalysisAttachment, correctAnalysisAttachment, listAnalysisLocalIntakes, createAnalysisLocalIntake, getAnalysisLocalIntake } from './analysisAttachmentApi';
import { validateAttachmentAcceptance, validateAttachmentCorrectionAcceptance } from './analysisAttachmentValidation';
import { validateAnalysisLocalIntakeList, validateAnalysisLocalIntake } from './analysisLocalIntakeValidation';
import { publicErrorMessage } from '../publicError';

const labels = { origin: 'Where this result came from', sourceReference: 'Code or method reference', documentReference: 'Supporting document reference', environmentReference: 'Environment reference' };
const emptyContext = () => Object.fromEntries(Object.keys(labels).map(key => [key, '']));
const targetKey = seed => seed?.attachmentId || 'create';
const accessDenied = failure => [401, 403].includes(failure.status) || failure.status === 404
  && !['ANALYSIS_LOCAL_INTAKE_NOT_FOUND', 'ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE'].includes(failure.code);

export default function LocalEvidenceIntake({ projectId, analysisId, userId, active, canWrite, available, seed, onClose, onDenied, onAuthority, onAttached, onInspect, onPreview }) {
  const initial = useRef(seed), [intent, setIntent] = useState(seed);
  const [file, setFile] = useState(null), [name, setName] = useState('');
  const [caption, setCaption] = useState(seed?.caption || ''), [context, setContext] = useState(seed?.suppliedOrigin || emptyContext);
  const [items, setItems] = useState([]), [cursor, setCursor] = useState(null), [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null), [original, setOriginal] = useState(null), [phase, setPhase] = useState(''), [checked, setChecked] = useState(false);
  const [allowed, setAllowed] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const id = useId(), mounted = useRef(false), listRequest = useRef(null), actionRequest = useRef(null), listGeneration = useRef(0);
  const service = useRef(null), originalRef = useRef(null), selectedRef = useRef(null), allowedRef = useRef(null), drafts = useRef(new Map());
  const liveDraft = useRef(null), callbacks = useRef({ onDenied, onAuthority, onAttached, onInspect, onPreview });
  callbacks.current = { onDenied, onAuthority, onAttached, onInspect, onPreview };
  liveDraft.current = { intent, name, caption, context };
  const busy = !!phase, frozen = original || selected?.recipe;
  const writer = available && active && canWrite && allowed === true;
  const scope = () => ({ projectId, analysisId, userId, ...(service.current ? { serviceId: service.current } : {}) });
  const cancelAction = useCallback(() => { actionRequest.current?.abort(); actionRequest.current = null; setPhase(''); setChecked(false); }, []);
  const deny = useCallback(failure => {
    listGeneration.current += 1; listRequest.current?.abort(); cancelAction();
    selectedRef.current = null; setSelected(null); setItems([]); setCursor(null); setLoaded(false); setLoading(false); setAllowed(false); allowedRef.current = false;
    setNotice(''); callbacks.current.onDenied?.(failure);
  }, [cancelAction]);
  const observe = useCallback((value, source, controller) => {
    if (!value) {
      if (source !== 'list') { listGeneration.current += 1; listRequest.current?.abort(); setLoading(false); }
      if (actionRequest.current !== controller) cancelAction();
      callbacks.current.onAuthority?.(false, 'intake');
    }
    allowedRef.current = value; setAllowed(value);
  }, [cancelAction]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; listRequest.current?.abort(); actionRequest.current?.abort(); };
  }, []);
  const load = useCallback(async (next = null) => {
    if (!available) return;
    listRequest.current?.abort(); const controller = new AbortController(); listRequest.current = controller;
    const generation = ++listGeneration.current; setLoading(true); setError('');
    try {
      const result = validateAnalysisLocalIntakeList(await listAnalysisLocalIntakes(projectId, analysisId, { cursor: next, signal: controller.signal }),
        { projectId, analysisId, userId, ...(service.current ? { serviceId: service.current } : {}) });
      if (!mounted.current || controller.signal.aborted || generation !== listGeneration.current) return;
      service.current = result.serviceId; observe(result.canContinue, 'list');
      setItems(previous => next ? [...new Map([...previous, ...result.items].map(item => [item.requestId, item])).values()] : result.items);
      setCursor(result.nextCursor); setLoaded(true);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || generation !== listGeneration.current) return;
      if (accessDenied(failure)) deny(failure);
      setError(publicErrorMessage(failure, 'Your saved import requests could not be listed. Reconnect to the same workspace and refresh.'));
    } finally { if (mounted.current && generation === listGeneration.current) setLoading(false); }
  }, [available, projectId, analysisId, userId, observe, deny]);
  useEffect(() => { if (available && !loaded && !loading && !error) void load(); }, [available, loaded, loading, error, load]);
  useEffect(() => {
    if (available) return;
    listGeneration.current += 1; listRequest.current?.abort(); cancelAction();
    selectedRef.current = null; setSelected(null); setItems([]); setCursor(null); setLoaded(false); setLoading(false); setAllowed(null); allowedRef.current = null; setNotice('');
  }, [available, cancelAction]);
  useEffect(() => { if (!active || !canWrite) cancelAction(); }, [active, canWrite, cancelAction]);
  const newDraft = useCallback(next => {
    const previous = liveDraft.current;
    drafts.current.set(targetKey(previous.intent), { seedKey: previous.intent?.key, name: previous.name, caption: previous.caption, context: previous.context });
    cancelAction(); setIntent(next); selectedRef.current = null; setSelected(null); originalRef.current = null; setOriginal(null); setFile(null); setError(''); setNotice('');
    const kept = drafts.current.get(targetKey(next));
    const returning = kept && kept.seedKey === next?.key;
    setName(kept?.name || ''); setCaption(returning ? kept.caption : next?.caption ?? kept?.caption ?? '');
    setContext(returning ? kept.context : next?.suppliedOrigin || kept?.context || emptyContext());
  }, [cancelAction]);
  useLayoutEffect(() => {
    if (seed === initial.current) return;
    initial.current = seed; newDraft(seed);
  }, [seed, newDraft]);
  const current = controller => mounted.current && !controller.signal.aborted && actionRequest.current === controller;
  const retain = value => { selectedRef.current = value; setSelected(value); };
  const observeReply = (value, controller) => { observe(value.canContinue, 'detail', controller); retain(value); setChecked(true); };
  const failure = (caught, fallback) => {
    if (accessDenied(caught) || caught.code === 'ANALYSIS_LOCAL_INTAKE_SERVICE_CHANGED') deny(caught);
    setError(caught.code === 'ANALYSIS_LOCAL_INTAKE_NOT_FOUND'
      ? 'The original saved request is unconfirmed. A missing record does not prove rejection. Keep the original request and check again before deliberately retrying it.'
      : caught.code === 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT' ? 'This attachment has a newer saved revision. Your file and original request are kept. Check the original outcome, then use the saved file to prepare a deliberate correction.'
      : publicErrorMessage(caught, fallback));
  };
  const refreshExact = async (requestId, controller, expected) => {
    const result = await validateAnalysisLocalIntake(await getAnalysisLocalIntake(projectId, analysisId, requestId, { signal: controller.signal }), scope(), expected);
    if (!current(controller)) return null;
    if (result.requestId !== requestId) throw new Error('The original saved import request could not be confirmed.');
    observeReply(result, controller); return result;
  };
  const check = async (requestId = frozen?.requestId) => {
    if (!available || actionRequest.current || !requestId) return;
    const controller = new AbortController(); actionRequest.current = controller; setPhase('Checking the original saved request…'); setError(''); setNotice('');
    const expected = originalRef.current?.requestId === requestId ? originalRef.current : undefined;
    try {
      const result = await refreshExact(requestId, controller, expected);
      if (!result) return;
      if (!expected) { originalRef.current = null; setOriginal(null); setFile(null); }
      setNotice('Original request checked. Checking does not upload a file or attach a result.');
    } catch (caught) { if (current(controller)) { setChecked(true); failure(caught, 'This import outcome is unconfirmed. Keep the original request and check again.'); } }
    finally { if (actionRequest.current === controller) { actionRequest.current = null; if (mounted.current) setPhase(''); } }
  };
  const transfer = async (recipe, selectedFile, controller) => {
    if (!current(controller) || !allowedRef.current || !active || !canWrite) return;
    const before = await refreshExact(recipe.requestId, controller, recipe);
    if (!before || !before.canUpload || before.importOutcome.status !== 'unconfirmed') return;
    setPhase('Checking the selected file against the original request…');
    const prepared = await prepareArtifactImportRequest({ file: selectedFile, name: recipe.importRequest.name, artifactType: 'auto', projectId,
      ownerUserId: userId, requestId: recipe.requestId });
    if (!current(controller)) return;
    if (canonicalArtifactImportRequest(prepared) !== canonicalArtifactImportRequest(recipe.importRequest)) throw new Error('Choose the original file with the same filename, size and SHA-256 checksum. No upload was sent.');
    const expectedRequestSha256 = await artifactImportRequestSha256(recipe.importRequest);
    if (!current(controller) || !allowedRef.current || !active || !canWrite) return;
    setPhase('Uploading the exact file…'); setChecked(false);
    await importArtifactVersion(projectId, { file: selectedFile, name: recipe.importRequest.name, artifactType: 'auto', requestId: recipe.requestId,
      expectedRequestSha256, signal: controller.signal });
    if (!current(controller)) return;
    const result = await refreshExact(recipe.requestId, controller, recipe);
    if (!result) return;
    setFile(null); setNotice(result.importOutcome.status === 'accepted' ? 'File import confirmed. Review the saved request, then explicitly attach the result.' : 'The upload outcome remains unconfirmed. Check the original saved request.');
    void load();
  };
  const admit = async event => {
    event?.preventDefault(); if (!writer || actionRequest.current || !file && !originalRef.current || !service.current) return;
    const controller = new AbortController(); actionRequest.current = controller; setError(''); setNotice(''); setPhase('Preparing the private import request…');
    try {
      let recipe = originalRef.current;
      if (!recipe) {
        if (!/\.(csv|tsv|png|jpe?g)$/i.test(file.name)) throw new Error('Choose a CSV, TSV, PNG or JPEG file up to 25 MiB.');
        const importRequest = await prepareArtifactImportRequest({ file, name, projectId, ownerUserId: userId, requestId: crypto.randomUUID() });
        if (!current(controller)) return;
        recipe = normalizeAnalysisLocalIntake({ requestId: importRequest.requestId, serviceId: service.current, importRequest,
          attachment: { requestId: crypto.randomUUID(), action: intent?.attachmentId ? 'correct' : 'create', attachmentId: intent?.attachmentId || null,
            expectedHeadRevisionId: intent?.expectedHeadRevisionId || null, caption, suppliedOrigin: context } });
        originalRef.current = recipe; setOriginal(recipe);
      }
      setPhase('Saving the private import request before uploading…'); setChecked(false);
      const result = await validateAnalysisLocalIntake(await createAnalysisLocalIntake(projectId, analysisId, recipe, { signal: controller.signal }), scope(), recipe);
      if (!current(controller)) return;
      observeReply(result, controller);
      if (result.importOutcome.status === 'unconfirmed' && result.canUpload && file) await transfer(recipe, file, controller);
      else { setNotice('The original request is saved. Review its current outcomes before continuing.'); void load(); }
    } catch (caught) { if (current(controller)) failure(caught, originalRef.current ? 'Completion is unconfirmed. Keep this request and check its outcome before retrying.' : 'The file and attachment details could not be prepared. Review the filename, size, caption and supplied context.'); }
    finally { if (actionRequest.current === controller) { actionRequest.current = null; if (mounted.current) setPhase(''); } }
  };
  const upload = async () => {
    const value = selectedRef.current; if (!writer || !value?.canUpload || !checked || !file || actionRequest.current || value.importOutcome.status !== 'unconfirmed') return;
    const controller = new AbortController(); actionRequest.current = controller; setError(''); setNotice('');
    try { await transfer(value.recipe, file, controller); }
    catch (caught) { if (current(controller)) failure(caught, 'Upload completion is unconfirmed. Check the original saved request before retrying.'); }
    finally { if (actionRequest.current === controller) { actionRequest.current = null; if (mounted.current) setPhase(''); } }
  };
  const attach = async () => {
    const value = selectedRef.current;
    if (!writer || !value?.canAttach || !checked || actionRequest.current || value.importOutcome.status !== 'accepted' || value.importOutcome.receipt.availability !== 'recorded'
        || value.attachmentOutcome.status !== 'unconfirmed') return;
    const controller = new AbortController(); actionRequest.current = controller; setPhase('Saving the original attachment request…'); setError(''); setNotice(''); setChecked(false);
    try {
      const recipe = value.recipe, before = await refreshExact(recipe.requestId, controller, recipe);
      if (!before || !before.canAttach || before.importOutcome.status !== 'accepted' || before.importOutcome.receipt.availability !== 'recorded' || before.attachmentOutcome.status !== 'unconfirmed') return;
      const input = analysisLocalIntakeAttachmentRequest(recipe, before.importOutcome.receipt.acceptance), correction = recipe.attachment.action === 'correct';
      setChecked(false);
      const raw = correction ? await correctAnalysisAttachment(projectId, analysisId, recipe.attachment.attachmentId, input, { signal: controller.signal })
        : await createAnalysisAttachment(projectId, analysisId, input, { signal: controller.signal });
      const result = correction ? await validateAttachmentCorrectionAcceptance(raw, { projectId, analysisId, userId }, recipe.attachment.attachmentId, input)
        : await validateAttachmentAcceptance(raw, { projectId, analysisId, userId }, input);
      if (!current(controller)) return;
      const confirmed = await refreshExact(recipe.requestId, controller, recipe);
      if (!confirmed || confirmed.attachmentOutcome.status !== 'accepted') return;
      callbacks.current.onAttached?.(result); setNotice('Original attachment confirmed. Inspecting it opens the exact accepted revision.'); void load();
    } catch (caught) { if (current(controller)) failure(caught, 'Attachment completion is unconfirmed. Check the original request; the imported file is kept.'); }
    finally { if (actionRequest.current === controller) { actionRequest.current = null; if (mounted.current) setPhase(''); } }
  };
  const importOutcome = selected?.importOutcome, attachmentOutcome = selected?.attachmentOutcome;
  return <section aria-label="Local result intake" className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-5">
    <header className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">Import a table or figure</h3><p className="mt-1 max-w-xl text-xs leading-relaxed text-textMuted">Save a private request, import the file, then attach the result. You can recover saved requests after reopening this workspace.</p></div><button type="button" className="text-xs text-textMuted underline" onClick={onClose}>Close import panel</button></header>
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="rounded border border-border bg-background p-3 text-sm">{notice}</p>}
    {busy && <p role="status" className="text-sm text-textMuted">{phase}</p>}
    {frozen ? <section aria-label="Saved local import request" className="space-y-3 rounded border border-border p-3">
      <p className="text-xs text-textMuted">{frozen.attachment.action === 'correct' ? 'Correct an existing attachment · original expected revision retained' : 'Add a new attached result'} · private request</p>
      <h4 className="break-words text-sm font-semibold">{frozen.importRequest.name}</h4><p className="whitespace-pre-wrap break-words text-sm">{frozen.attachment.caption}</p>
      <dl className="space-y-2 text-xs"><div><dt className="text-textMuted">File import</dt><dd>{importOutcome?.status === 'accepted' ? importOutcome.receipt.availability === 'recorded' ? 'Accepted · saved file recorded' : 'Accepted · original file unavailable' : importOutcome?.status === 'conflict' ? 'Request conflict · original identity kept' : 'Unconfirmed · check before continuing'}</dd></div><div><dt className="text-textMuted">Attachment</dt><dd>{attachmentOutcome?.status === 'accepted' ? `Confirmed · saved revision ${attachmentOutcome.receipt.acceptedRevision.revisionNumber}` : attachmentOutcome?.status === 'conflict' ? 'Request conflict · no result substituted' : 'Unconfirmed · no automatic attachment'}</dd></div></dl>
      <details className="text-xs"><summary className="cursor-pointer text-textMuted">Original file, context and request identities</summary><dl className="mt-3 space-y-2"><div><dt>Original filename</dt><dd className="break-words">{frozen.importRequest.originalFilename}</dd></div><div><dt>SHA-256</dt><dd className="break-all font-mono">{frozen.importRequest.sha256}</dd></div><div><dt>Import request</dt><dd className="break-all font-mono">{frozen.requestId}</dd></div><div><dt>Attachment request</dt><dd className="break-all font-mono">{frozen.attachment.requestId}</dd></div>{Object.entries(labels).map(([key, label]) => <div key={key}><dt>{label}</dt><dd className="whitespace-pre-wrap break-words">{frozen.attachment.suppliedOrigin[key] || 'Unknown / not supplied'}</dd></div>)}</dl></details>
      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-secondary text-xs" disabled={!available || busy} onClick={() => void check()}>Check saved import request</button>
        {!selected && original && checked && writer && <button type="button" className="btn btn-secondary text-xs" disabled={busy} onClick={() => void admit()}>Retry saving original request</button>}
        {importOutcome?.status === 'accepted' && importOutcome.receipt.version && <button type="button" className="btn btn-secondary text-xs" disabled={!available || busy} onClick={() => callbacks.current.onPreview?.(importOutcome.receipt.version)}>Inspect imported file</button>}
        {attachmentOutcome?.status === 'accepted' && <button type="button" className="btn btn-primary text-xs" disabled={!available || busy} onClick={() => callbacks.current.onInspect?.(attachmentOutcome.receipt.acceptedRevision)}>Inspect original attached result</button>}
      </div>
      {attachmentOutcome?.status === 'accepted' && attachmentOutcome.receipt.acceptedRevision.id !== attachmentOutcome.receipt.attachment.headRevisionId && <p className="text-xs text-textMuted">A newer attachment revision is current. This request confirms the original saved revision.</p>}
      {selected && importOutcome.status === 'unconfirmed' && <div className="space-y-3 border-t border-border pt-3"><p className="text-xs leading-relaxed text-textMuted">To continue, explicitly choose the original file. Its filename, size, checksum and settings must match. No file bytes are kept in browser storage.</p><label htmlFor={`${id}-reselect`} className="block text-sm">Original file<input id={`${id}-reselect`} type="file" accept=".csv,.tsv,.png,.jpg,.jpeg" disabled={!writer || busy} onChange={event => setFile(event.target.files?.[0] || null)} className="mt-2 block w-full min-w-0 text-xs" /></label>{file && <p className="break-words text-xs text-textMuted">Selected: {file.name}</p>}<button type="button" className="btn btn-secondary text-xs" disabled={!writer || busy || !file || !checked} onClick={() => void upload()}>Upload original file</button></div>}
      {selected && importOutcome.status === 'accepted' && importOutcome.receipt.availability === 'recorded' && attachmentOutcome.status === 'unconfirmed' && <button type="button" className="btn btn-primary text-sm" disabled={!writer || busy || !checked} onClick={() => void attach()}>{frozen.attachment.action === 'correct' ? 'Save original source correction' : 'Attach imported result'}</button>}
      <p className="text-xs leading-relaxed text-textMuted">Checking and reopening never start a transfer or attach a result. Earlier acceptance stays recorded if the original file becomes unavailable.</p>
      <button type="button" className="text-xs text-textMuted underline" disabled={busy} onClick={() => newDraft({})}>Prepare another import</button>
    </section> : <form aria-label="Import local evidence" onSubmit={admit} className="space-y-3">
      <p className="text-xs text-textMuted">{intent?.attachmentId ? 'This file will correct the chosen attachment. Earlier sources and discussion stay with their saved revisions.' : 'Add existing work without running an analysis. CSV, TSV, PNG and JPEG files up to 25 MiB are supported.'}</p>
      <label htmlFor={`${id}-file`} className="block text-sm">Local result file<input id={`${id}-file`} type="file" accept=".csv,.tsv,.png,.jpg,.jpeg" disabled={!writer || busy} onChange={event => { const value = event.target.files?.[0] || null; setFile(value); if (value && !name) setName(value.name); }} className="mt-2 block w-full min-w-0 text-xs" /></label>
      <label htmlFor={`${id}-name`} className="block text-sm">Saved file name</label><input id={`${id}-name`} value={name} maxLength={160} disabled={!writer || busy} onChange={event => setName(event.target.value)} className="w-full rounded border border-border bg-background p-2 text-sm" />
      <label htmlFor={`${id}-caption`} className="block text-sm">Result caption</label><textarea id={`${id}-caption`} value={caption} rows={3} maxLength={4000} disabled={!writer || busy} onChange={event => setCaption(event.target.value)} className="w-full rounded border border-border bg-background p-3 text-sm" />
      <details className="text-sm"><summary className="cursor-pointer">Supplied origin and references (optional)</summary><p className="mt-2 text-xs text-textMuted">These are unverified notes or citations. Leave unknown information blank.</p><div className="mt-3 space-y-3">{Object.entries(labels).map(([key, label]) => <div key={key}><label htmlFor={`${id}-${key}`} className="block text-sm">{label}</label><textarea id={`${id}-${key}`} value={context[key] || ''} rows={2} maxLength={4000} disabled={!writer || busy} onChange={event => setContext(previous => ({ ...previous, [key]: event.target.value }))} className="mt-1 w-full rounded border border-border bg-background p-2 text-sm" /></div>)}</div></details>
      <p className="text-xs leading-relaxed text-textMuted">The private request is saved before any upload. Caption and context become project-visible when you explicitly attach the result; the source file remains private.</p><button type="submit" className="btn btn-primary text-sm" disabled={!writer || busy || !file || !name.trim() || !caption.trim()}>Import local file</button>
    </form>}
    {!available ? <p className="text-xs text-textMuted">Reconnect to this workspace to recover the original request.</p> : !active || !canWrite || allowed === false ? <p className="text-xs text-textMuted">You can recover your accepted requests with current read access. Continuing imports or attachments requires write access to an active analysis.</p> : null}
    <section aria-label="Your saved local imports" className="space-y-3 border-t border-border pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">Your saved import requests</h4><button type="button" className="text-xs text-textMuted underline" disabled={!available || loading} onClick={() => void load()}>Refresh import requests</button></div>
      <p className="text-xs leading-relaxed text-textMuted">Only your requests in this analysis and workspace appear here. Opening one checks its original outcomes.</p>{loading && <p role="status" className="text-xs text-textMuted">Finding saved import requests…</p>}{loaded && !items.length && <p className="text-xs text-textMuted">No saved import requests are available here.</p>}
      <ul className="space-y-2">{items.map(item => <li key={item.requestId} className="min-w-0 rounded border border-border p-3"><p className="break-words text-sm font-medium">{item.name}</p><p className="mt-1 whitespace-pre-wrap break-words text-xs text-textMuted">{item.caption}</p><p className="mt-2 text-xs text-textMuted">File: {item.importStatus} · attachment: {item.attachmentStatus}</p><button type="button" className="mt-2 text-xs text-primary underline" disabled={!available || busy} onClick={() => void check(item.requestId)}>Open saved import request</button></li>)}</ul>
      {cursor && <button type="button" className="btn btn-secondary text-xs" disabled={!available || loading} onClick={() => void load(cursor)}>Load older import requests</button>}
    </section>
  </section>;
}
