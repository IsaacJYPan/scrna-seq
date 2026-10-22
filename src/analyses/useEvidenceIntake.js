import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { evidenceIntakeTransport, prepareEvidenceIntake, transferEvidenceSource, evidenceAttachmentRequest } from './evidenceIntakeAdapters';
import { createAnalysisAttachment, correctAnalysisAttachment } from './analysisAttachmentApi';
import { validateAttachmentAcceptance, validateAttachmentCorrectionAcceptance } from './analysisAttachmentValidation';
import { publicErrorMessage } from '../publicError';

export const evidenceContextLabels = { origin: 'Where this result came from', sourceReference: 'Code or method reference', documentReference: 'Supporting document reference', environmentReference: 'Environment reference' };
const emptyContext = () => Object.fromEntries(Object.keys(evidenceContextLabels).map(key => [key, '']));
const draftKey = seed => seed?.attachmentId || 'create';
const missingCodes = ['ANALYSIS_LOCAL_INTAKE_NOT_FOUND', 'ANALYSIS_SERVER_INTAKE_NOT_FOUND', 'ANALYSIS_INTAKE_NOT_FOUND'];
const sourceFailure = error => /^SERVER_IMPORT_|^SERVER_INTAKE_SOURCE_/.test(error.code || '');
const accessDenied = error => !sourceFailure(error) && ([401, 403].includes(error.status)
  || error.status === 404 && ![...missingCodes, 'ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE'].includes(error.code));

export default function useEvidenceIntake({ projectId, analysisId, userId, active, canWrite, available, seed, legacyLocal = false,
  onDenied, onAuthority, onAttached, onInspect, onPreview }) {
  const transport = useMemo(() => evidenceIntakeTransport(legacyLocal), [legacyLocal]);
  const initial = useRef(seed), [intent, setIntent] = useState(seed), [sourceKind, setSourceKind] = useState('local');
  const [file, setFile] = useState(null), [serverSelection, setServerSelection] = useState(null), [name, setName] = useState('');
  const [caption, setCaption] = useState(seed?.caption || ''), [context, setContext] = useState(seed?.suppliedOrigin || emptyContext);
  const [items, setItems] = useState([]), [cursor, setCursor] = useState(null), [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null), [original, setOriginal] = useState(null), [phase, setPhase] = useState('');
  const [lastCheck, setLastCheck] = useState('unconfirmed'), [allowed, setAllowed] = useState(null), [sourceAllowed, setSourceAllowed] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), listRequest = useRef(null), actionRequest = useRef(null), actionKind = useRef(null), listGeneration = useRef(0);
  const service = useRef(null), originalRef = useRef(null), selectedRef = useRef(null), allowedRef = useRef(null), sourceAllowedRef = useRef(null);
  const sourceEpoch = useRef(0);
  const drafts = useRef(new Map()), liveDraft = useRef(null), callbacks = useRef(null);
  callbacks.current = { onDenied, onAuthority, onAttached, onInspect, onPreview };
  liveDraft.current = { intent, name, caption, context, sourceKind };
  const scope = useCallback(() => ({ projectId, analysisId, userId, ...(service.current ? { serviceId: service.current } : {}) }), [projectId, analysisId, userId]);
  const busy = !!phase, frozen = original || (selected ? { sourceKind: selected.sourceKind, recipe: selected.recipe } : null);
  const writer = available && active && canWrite && allowed === true;
  const cancelAction = useCallback(() => {
    actionRequest.current?.abort(); actionRequest.current = null; actionKind.current = null; setPhase(''); setLastCheck('unconfirmed');
  }, []);
  const deny = useCallback(caught => {
    listGeneration.current++; listRequest.current?.abort(); cancelAction(); selectedRef.current = null;
    setSelected(null); setItems([]); setCursor(null); setLoaded(false); setLoading(false); setAllowed(false); allowedRef.current = false;
    setServerSelection(null); setNotice(''); callbacks.current.onDenied?.(caught);
  }, [cancelAction]);
  const observeSource = useCallback((value, controller) => {
    if (value === false) sourceEpoch.current++;
    sourceAllowedRef.current = value; setSourceAllowed(value);
    if (value === false && actionKind.current?.stage === 'copy' && actionKind.current.sourceKind === 'server'
        && actionRequest.current !== controller) cancelAction();
  }, [cancelAction]);
  const observe = useCallback((value, controller) => {
    if (!value) {
      if (controller !== listRequest.current) { listGeneration.current++; listRequest.current?.abort(); setLoading(false); }
      if (controller !== actionRequest.current) cancelAction();
      callbacks.current.onAuthority?.(false, 'intake');
    }
    allowedRef.current = value; setAllowed(value);
  }, [cancelAction]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; listRequest.current?.abort(); actionRequest.current?.abort(); }; }, []);
  const load = useCallback(async (next = null) => {
    if (!available) return;
    listRequest.current?.abort(); const controller = new AbortController(); listRequest.current = controller;
    const generation = ++listGeneration.current; setLoading(true); setError('');
    try {
      const result = await transport.list(scope(), { cursor: next, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || generation !== listGeneration.current) return;
      service.current = result.serviceId; observe(result.canContinue, controller);
      const current = result.items.find(item => item.requestId === selectedRef.current?.requestId);
      if (current?.sourceKind === 'server') observeSource(current.canStartImport, controller);
      setItems(previous => next ? [...new Map([...previous, ...result.items].map(item => [item.requestId, item])).values()] : result.items);
      setCursor(result.nextCursor); setLoaded(true);
    } catch (caught) {
      if (!mounted.current || controller.signal.aborted || generation !== listGeneration.current) return;
      if (accessDenied(caught)) deny(caught);
      setError(publicErrorMessage(caught, 'Your saved import requests could not be listed. Reconnect to the same workspace and refresh.'));
    } finally { if (mounted.current && generation === listGeneration.current) setLoading(false); }
  }, [available, transport, scope, observe, observeSource, deny]);
  useEffect(() => { if (available && !loaded && !loading && !error) void load(); }, [available, loaded, loading, error, load]);
  useEffect(() => {
    if (available) return;
    listGeneration.current++; listRequest.current?.abort(); cancelAction(); selectedRef.current = null;
    setSelected(null); setItems([]); setCursor(null); setLoaded(false); setLoading(false); setAllowed(null); allowedRef.current = null;
    setSourceAllowed(null); sourceAllowedRef.current = null; setServerSelection(null); setNotice('');
  }, [available, cancelAction]);
  useEffect(() => { if (!active || !canWrite) cancelAction(); }, [active, canWrite, cancelAction]);
  const newDraft = useCallback(next => {
    const previous = liveDraft.current;
    drafts.current.set(draftKey(previous.intent), { seedKey: previous.intent?.key, name: previous.name, caption: previous.caption, context: previous.context, sourceKind: previous.sourceKind });
    cancelAction(); setIntent(next); selectedRef.current = null; setSelected(null); originalRef.current = null; setOriginal(null);
    setFile(null); setServerSelection(null); setError(''); setNotice('');
    const kept = drafts.current.get(draftKey(next)), returning = kept && kept.seedKey === next?.key;
    setName(kept?.name || ''); setCaption(returning ? kept.caption : next?.caption ?? kept?.caption ?? '');
    setContext(returning ? kept.context : next?.suppliedOrigin || kept?.context || emptyContext());
    setSourceKind(legacyLocal ? 'local' : kept?.sourceKind || 'local');
  }, [cancelAction, legacyLocal]);
  useLayoutEffect(() => { if (seed !== initial.current) { initial.current = seed; newDraft(seed); } }, [seed, newDraft]);
  const current = controller => mounted.current && !controller.signal.aborted && actionRequest.current === controller;
  const retain = value => { selectedRef.current = value; setSelected(value); };
  const observeReply = (value, controller, sourceCurrent = true) => {
    observe(value.canContinue, controller);
    if (value.sourceKind === 'server' && (sourceCurrent || value.canStartImport === false)) observeSource(value.canStartImport, controller);
    retain(value); setLastCheck('confirmed');
  };
  const fail = (caught, fallback) => {
    if (accessDenied(caught) || ['ANALYSIS_LOCAL_INTAKE_SERVICE_CHANGED', 'ANALYSIS_SERVER_INTAKE_SERVICE_CHANGED', 'ANALYSIS_INTAKE_SERVICE_CHANGED'].includes(caught.code)) deny(caught);
    if (sourceFailure(caught)) observeSource(false);
    setError(missingCodes.includes(caught.code)
      ? 'The original saved request is unconfirmed. A missing record does not prove rejection. Keep the original request and check again before deliberately retrying it.'
      : caught.code === 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT'
        ? 'This attachment has a newer saved revision. Your file and original request are kept. Check the original outcome, then use the saved file to prepare a deliberate correction.'
        : publicErrorMessage(caught, fallback));
  };
  const refreshExact = async (requestId, controller, expected) => {
    setLastCheck('unconfirmed');
    const beforeSource = sourceEpoch.current;
    const result = await transport.get(scope(), requestId, controller.signal, expected);
    if (!current(controller)) return null;
    if (result.requestId !== requestId) throw new Error('The original saved import request could not be confirmed.');
    observeReply(result, controller, beforeSource === sourceEpoch.current); return result;
  };
  const check = async (requestId = frozen?.recipe.requestId) => {
    if (!available || actionRequest.current || !requestId || !service.current) return;
    const controller = new AbortController(); actionRequest.current = controller; actionKind.current = { stage: 'read' };
    setPhase('Checking the original saved request…'); setLastCheck('unconfirmed'); setError(''); setNotice('');
    const expected = originalRef.current?.recipe.requestId === requestId ? originalRef.current : undefined;
    try {
      const result = await refreshExact(requestId, controller, expected); if (!result) return;
      if (!expected) { originalRef.current = null; setOriginal(null); setFile(null); setServerSelection(null); }
      setNotice(result.sourceKind === 'server' ? 'Original request checked. Checking does not copy a file or attach a result.' : 'Original request checked. Checking does not upload a file or attach a result.');
    } catch (caught) {
      if (current(controller)) { setLastCheck(missingCodes.includes(caught.code) ? 'missing' : 'unconfirmed'); fail(caught, 'This import outcome is unconfirmed. Keep the original request and check again.'); }
    } finally { if (actionRequest.current === controller) { actionRequest.current = null; actionKind.current = null; if (mounted.current) setPhase(''); } }
  };
  const transfer = async (record, selectedFile, controller) => {
    if (!current(controller) || !allowedRef.current || !active || !canWrite) return;
    const before = await refreshExact(record.recipe.requestId, controller, record);
    if (!before || !before.canStartImport || before.importOutcome.status !== 'unconfirmed' || record.sourceKind === 'server' && sourceAllowedRef.current === false) return;
    actionKind.current = { stage: 'copy', sourceKind: record.sourceKind };
    await transferEvidenceSource(record, selectedFile, scope(), controller.signal, message => { if (current(controller)) setPhase(message); }, () => { if (current(controller)) setLastCheck('unconfirmed'); });
    if (!current(controller)) return;
    const result = await refreshExact(record.recipe.requestId, controller, record); if (!result) return;
    setFile(null); setNotice(result.importOutcome.status === 'accepted' ? 'File import confirmed. Review the saved request, then explicitly attach the result.'
      : result.importOutcome.status === 'pending' ? 'The server copy is pending. You can check this same request without starting another copy.' : 'The import outcome remains unconfirmed. Check the original saved request.');
    void load();
  };
  const admit = async event => {
    event?.preventDefault();
    if (!writer || actionRequest.current || !service.current || !originalRef.current && (sourceKind === 'local' ? !file : !serverSelection || sourceAllowedRef.current === false)) return;
    const controller = new AbortController(); actionRequest.current = controller; actionKind.current = { stage: 'admit', sourceKind };
    setError(''); setNotice(''); setPhase('Preparing the private import request…');
    try {
      let record = originalRef.current;
      if (!record) {
        record = await prepareEvidenceIntake(sourceKind, { file, selection: serverSelection, name, caption, context, intent }, scope());
        if (!current(controller)) return; originalRef.current = record; setOriginal(record);
      }
      setPhase('Saving the private request before importing…'); setLastCheck('unconfirmed');
      const result = await transport.admit(scope(), record, controller.signal); if (!current(controller)) return;
      observeReply(result, controller);
      if (result.importOutcome.status === 'unconfirmed' && result.canStartImport && (record.sourceKind === 'server' || file)) await transfer(record, file, controller);
      else { setNotice('The original request is saved. Review its current outcomes before continuing.'); void load(); }
    } catch (caught) { if (current(controller)) { setLastCheck('unconfirmed'); fail(caught, originalRef.current ? 'Completion is unconfirmed. Keep this request and check its outcome before retrying.' : 'The file and attachment details could not be prepared. Review the source, name, caption and supplied context.'); } }
    finally { if (actionRequest.current === controller) { actionRequest.current = null; actionKind.current = null; if (mounted.current) setPhase(''); } }
  };
  const copy = async () => {
    const value = selectedRef.current;
    if (!writer || !value?.canStartImport || lastCheck !== 'confirmed' || actionRequest.current || value.importOutcome.status !== 'unconfirmed'
        || value.sourceKind === 'local' && !file || value.sourceKind === 'server' && sourceAllowedRef.current === false) return;
    const controller = new AbortController(); actionRequest.current = controller; actionKind.current = { stage: 'copy', sourceKind: value.sourceKind };
    setError(''); setNotice('');
    try { await transfer({ sourceKind: value.sourceKind, recipe: value.recipe }, file, controller); }
    catch (caught) { if (current(controller)) fail(caught, 'Import completion is unconfirmed. Check the original saved request before retrying.'); }
    finally { if (actionRequest.current === controller) { actionRequest.current = null; actionKind.current = null; if (mounted.current) setPhase(''); } }
  };
  const attach = async () => {
    const value = selectedRef.current;
    if (!writer || !value?.canAttach || lastCheck !== 'confirmed' || actionRequest.current || value.importOutcome.status !== 'accepted'
        || value.importOutcome.receipt.availability !== 'recorded' || value.attachmentOutcome.status !== 'unconfirmed') return;
    const controller = new AbortController(); actionRequest.current = controller; actionKind.current = { stage: 'attach', sourceKind: value.sourceKind };
    setPhase('Saving the original attachment request…'); setError(''); setNotice(''); setLastCheck('unconfirmed');
    try {
      const record = { sourceKind: value.sourceKind, recipe: value.recipe }, before = await refreshExact(value.requestId, controller, record);
      if (!before || !before.canAttach || before.importOutcome.status !== 'accepted' || before.importOutcome.receipt.availability !== 'recorded' || before.attachmentOutcome.status !== 'unconfirmed') return;
      const input = evidenceAttachmentRequest(record, before.importOutcome.receipt.acceptance), correction = record.recipe.attachment.action === 'correct';
      setLastCheck('unconfirmed');
      const raw = correction ? await correctAnalysisAttachment(projectId, analysisId, record.recipe.attachment.attachmentId, input, { signal: controller.signal })
        : await createAnalysisAttachment(projectId, analysisId, input, { signal: controller.signal });
      const result = correction ? await validateAttachmentCorrectionAcceptance(raw, { projectId, analysisId, userId }, record.recipe.attachment.attachmentId, input)
        : await validateAttachmentAcceptance(raw, { projectId, analysisId, userId }, input);
      if (!current(controller)) return;
      const confirmed = await refreshExact(value.requestId, controller, record); if (!confirmed || confirmed.attachmentOutcome.status !== 'accepted') return;
      callbacks.current.onAttached?.(result); setNotice('Original attachment confirmed. Inspecting it opens the exact accepted revision.'); void load();
    } catch (caught) { if (current(controller)) { setLastCheck('unconfirmed'); fail(caught, 'Attachment completion is unconfirmed. Check the original request; the imported file is kept.'); } }
    finally { if (actionRequest.current === controller) { actionRequest.current = null; actionKind.current = null; if (mounted.current) setPhase(''); } }
  };
  return { legacyLocal, intent, sourceKind, setSourceKind, file, setFile, serverSelection, setServerSelection, name, setName, caption, setCaption, context, setContext,
    items, cursor, loaded, loading, selected, original, frozen, phase, busy, lastCheck, error, setError, notice, allowed, sourceAllowed, serviceId: service.current,
    writer, load, newDraft, check, admit, copy, attach, observeSource, deny, callbacks, available, active, canWrite };
}
