import { useCallback, useEffect, useRef, useState } from 'react';
import { getNotebook, listNotebooks } from './notebookApi';
import { NOTEBOOK_DOCUMENT_SCHEMA, NOTEBOOK_DOCUMENT_ID, NOTEBOOK_VERSION_ID,
  canonicalNotebookContent, normalizeNotebookContent, normalizeNotebookCreate, normalizeNotebookSave } from '../../shared/notebookDocument.mjs';
import { publicErrorMessage } from '../publicError';
import useNotebookDraftAutosave from './useNotebookDraftAutosave';
import { normalizeNotebookDraft } from '../../shared/notebookDraft.mjs';
import useNotebookPendingSources from './useNotebookPendingSources';
import { notebookRequestHash, pendingResponseError, validateNotebookSubmission } from './notebookPendingClient';

const errorMessage = error => {
  const messages = {
    NOTEBOOK_VERSION_CONFLICT: 'A newer document version is available. Your draft has not replaced it.',
    ANALYSIS_ARCHIVED: 'This analysis is archived. Your draft is kept; restore the analysis before saving new changes.',
    FORBIDDEN: 'Your project role allows reading documents but not editing them.',
    NOTEBOOK_DOCUMENT_TOO_LARGE: 'The document exceeds the saved source size limit. Reduce source or metadata and try again.',
    NOTEBOOK_REQUEST_CONFLICT: 'This request belongs to a different saved draft. Check the original save before starting another request.',
    NOTEBOOK_PENDING_CONFLICT: 'Another window has an unresolved shared submission. Check that original request before sharing more source.',
  };
  return messages[error.code] || publicErrorMessage(error, 'The document request could not be confirmed. Your draft is kept here.');
};
const localErrorMessage = error => ['INVALID_NOTEBOOK_DOCUMENT', 'NOTEBOOK_DOCUMENT_TOO_LARGE', 'INVALID_NOTEBOOK_INTERCHANGE', 'NOTEBOOK_INTERCHANGE_TOO_LARGE'].includes(error.code)
  ? error.message : errorMessage(error);
const draftFor = document => ({ title: document.title, content: document.content, baseVersion: document.version,
  baseVersionId: document.versionId, dirty: false });
const newest = (...values) => values.filter(Boolean).reduce((best, value) => !best || value.version > best.version ? value : best, null);
const unreadable = () => new Error('The document service returned an unreadable response.');
function validHead(value, projectId, analysisId) {
  return value && typeof value.id === 'string' && NOTEBOOK_DOCUMENT_ID.test(value.id)
    && typeof value.versionId === 'string' && NOTEBOOK_VERSION_ID.test(value.versionId)
    && value.projectId === projectId && value.analysisId === analysisId && typeof value.title === 'string'
    && Number.isSafeInteger(value.version) && value.version > 0
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
}
function validateDocumentResult(result, projectId, analysisId, documentId) {
  const saved = result?.document, current = result?.currentHead;
  if (!validHead(saved, projectId, analysisId) || !validHead(current, projectId, analysisId)
      || saved.id !== current.id || documentId && saved.id !== documentId || current.version < saved.version) throw unreadable();
  try { normalizeNotebookContent(saved.content); } catch { throw unreadable(); }
}

// Private working copies are independent from immutable shared saved source.
export default function useNotebookDocuments({ projectId, analysisId, userId, isActive, blocked, canWrite }) {
  const [indexes, setIndexes] = useState({});
  const [records, setRecords] = useState({});
  const [drafts, setDrafts] = useState({});
  const [selections, setSelections] = useState({});
  const [busy, setBusy] = useState({});
  const [problems, setProblems] = useState({});
  const [notices, setNotices] = useState({});
  const [heads, setHeads] = useState({});
  const mounted = useRef(false);
  const listGenerations = useRef(new Map());
  const documentGenerations = useRef(new Map());
  const pending = useRef(new Map());
  const pendingDraftVersions = useRef(new Map());
  const inFlight = useRef(new Set());
  const knownHeads = useRef({});
  const selectionGenerations = useRef(new Map());
  const projectScope = useRef(projectId);
  projectScope.current = projectId;
  const live = useRef(null);
  live.current = { indexes, records, drafts, selections, busy, heads };
  const index = indexes[analysisId];
  const selectedId = selections[analysisId] || null;
  const selected = records[selectedId] || null;
  const draft = selected && (drafts[selectedId] || draftFor(selected));
  const createKey = `new:${analysisId}`;
  const journal = useNotebookPendingSources({ projectId, userId, pending, pendingDraftVersions });
  const { read: readJournal, send: sendJournal, complete: completeJournal, replay: replayJournal } = journal;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const changeIndex = useCallback((id, change) => setIndexes(previous => ({
    ...previous, [id]: { ...(previous[id] || { items: [], loaded: false }), ...change },
  })), []);
  const generation = (map, id) => {
    const next = (map.current.get(id) || 0) + 1; map.current.set(id, next); return next;
  };
  const rememberHead = useCallback(value => {
    const head = newest(knownHeads.current[value.id], live.current.heads[value.id], value);
    knownHeads.current[value.id] = head;
    setHeads(previous => ({ ...previous, [value.id]: newest(previous[value.id], head) }));
    return head;
  }, []);
  const autosave = useNotebookDraftAutosave({ projectId, analysisId, userId, blocked, canWrite, records, drafts,
    setDrafts, rememberHead, sharedPending: pending, sharedInFlight: inFlight });
  const { read: readPrivateDraft, edited: editedPrivateDraft, ensure: ensurePrivateDraft, clearPublished: clearPublishedDraft } = autosave;
  const loadList = useCallback(async (id, cursor = null) => {
    if (!id || !projectId) return;
    const request = generation(listGenerations, id);
    changeIndex(id, { loading: true, error: '' });
    try {
      const result = await listNotebooks(projectId, id, { cursor });
      if (!mounted.current || projectScope.current !== projectId || listGenerations.current.get(id) !== request) return;
      if (!Array.isArray(result?.documents) || result.documents.some(item => !validHead(item, projectId, id))) throw unreadable();
      const incoming = result.documents.map(rememberHead);
      setIndexes(previous => {
        const entry = previous[id] || {};
        // There is no destructive document removal/filter in NB-01. Keep
        // already loaded rows through page refresh, using confirmed newer heads.
        const items = [...new Map([...incoming, ...(entry.items || [])].map(item => [item.id,
          newest(knownHeads.current[item.id], item)])).values()];
        return { ...previous, [id]: { ...entry, loaded: true, loading: false, error: '', nextCursor: result.nextCursor,
          items: cursor ? [...new Map([...(entry.items || []), ...items].map(item => [item.id, newest(knownHeads.current[item.id], item)])).values()] : items } };
      });
    } catch (error) {
      if (mounted.current && projectScope.current === projectId && listGenerations.current.get(id) === request) {
        changeIndex(id, { loading: false, error: errorMessage(error) });
      }
    }
  }, [projectId, changeIndex, rememberHead]);

  useEffect(() => {
    if (isActive && analysisId && !blocked && !index?.loaded && !index?.loading && !index?.error) void loadList(analysisId);
  }, [isActive, analysisId, blocked, index?.loaded, index?.loading, index?.error, loadList]);
  useEffect(() => {
    if (isActive && analysisId && !blocked && !journal.states[createKey]?.loaded
        && !journal.states[createKey]?.checking && !journal.states[createKey]?.error) void readJournal(analysisId, null);
  }, [isActive, analysisId, blocked, createKey, journal.states, readJournal]);

  const open = useCallback(async (id, scope = analysisId, select = true) => {
    if (select) {
      generation(selectionGenerations, scope);
      setSelections(previous => ({ ...previous, [scope]: id }));
    }
    const request = generation(documentGenerations, id);
    setProblems(previous => ({ ...previous, [id]: null }));
    try {
      const result = await getNotebook(projectId, scope, id);
      if (!mounted.current || projectScope.current !== projectId || documentGenerations.current.get(id) !== request) return;
      validateDocumentResult(result, projectId, scope, id);
      setRecords(previous => ({ ...previous, [id]: previous[id]?.version > result.document.version ? previous[id] : result.document }));
      const current = rememberHead(result.currentHead);
      if (current.version > result.document.version) setNotices(previous => ({ ...previous, [id]: `Showing saved version ${result.document.version}. A newer saved version is available.` }));
      await readJournal(scope, id);
      await readPrivateDraft(id, scope);
    } catch (error) {
      if (mounted.current && projectScope.current === projectId && documentGenerations.current.get(id) === request) {
        setProblems(previous => ({ ...previous, [id]: { message: errorMessage(error), inaccessible: [403, 404].includes(error.status) } }));
        if ([403, 404].includes(error.status)) setRecords(previous => { const next = { ...previous }; delete next[id]; return next; });
      }
    }
  }, [projectId, analysisId, rememberHead, readPrivateDraft, readJournal]);

  const edit = useCallback((id, change) => {
    if (!canWrite || blocked || pending.current.has(id) || inFlight.current.has(id) || journal.known.current[id]?.checking) return;
    setDrafts(previous => {
      const base = previous[id] || (live.current.records[id] && draftFor(live.current.records[id]));
      if (!base) return previous;
      const next = typeof change === 'function' ? change(base) : { ...base, ...change };
      const uiState = next.uiState?.activeCellId && !next.content.cells.some(cell => cell.id === next.uiState.activeCellId)
        ? { ...next.uiState, activeCellId: null } : next.uiState;
      return { ...previous, [id]: { ...next, ...(uiState ? { uiState } : {}), dirty: true } };
    });
    editedPrivateDraft(id);
    setNotices(previous => ({ ...previous, [id]: '' }));
  }, [canWrite, blocked, editedPrivateDraft, journal.known]);

  const editUiState = useCallback((id, change) => {
    if (!canWrite || blocked || pending.current.has(id) || inFlight.current.has(id) || journal.known.current[id]?.checking) return false;
    const base = live.current.drafts[id] || (live.current.records[id] && draftFor(live.current.records[id]));
    if (!base) return false;
    let uiState;
    try {
      uiState = normalizeNotebookDraft({ requestId: '550e8400-e29b-41d4-a716-446655440000', expectedDraftVersion: 0,
        baseVersion: base.baseVersion, baseVersionId: base.baseVersionId, title: base.title, content: base.content,
        uiState: { ...base.uiState, ...change } }).uiState;
    } catch { return false; }
    if (JSON.stringify(base.uiState || { activeCellId: null, scrollTop: 0 }) === JSON.stringify(uiState)) return true;
    setDrafts(previous => ({ ...previous, [id]: { ...(previous[id] || base), uiState, privateDirty: true } }));
    editedPrivateDraft(id);
    return true;
  }, [canWrite, blocked, editedPrivateDraft, journal.known]);

  const applySaved = useCallback((scope, result, submittedPayload) => {
    const saved = result.document;
    const current = rememberHead(result.currentHead);
    generation(documentGenerations, saved.id);
    generation(listGenerations, scope);
    setRecords(previous => ({ ...previous, [saved.id]: previous[saved.id]?.version > saved.version ? previous[saved.id] : saved }));
    setDrafts(previous => {
      const existing = previous[saved.id];
      // Resolving an older admitted save must not erase later source that was
      // already present locally before the pending operation was discovered.
      let matchesSubmission = false;
      try { matchesSubmission = !!submittedPayload && existing?.title === submittedPayload.title
        && canonicalNotebookContent(existing.content) === canonicalNotebookContent(submittedPayload.content); }
      catch { /* Newer incomplete local source must remain recoverable. */ }
      if (existing?.dirty && !matchesSubmission) return previous;
      const next = { ...previous }; delete next[saved.id]; return next;
    });
    setProblems(previous => ({ ...previous, [saved.id]: null }));
    setIndexes(previous => {
      const entry = previous[scope] || {};
      return { ...previous, [scope]: { ...entry, loading: false,
        items: [current, ...(entry.items || []).filter(item => item.id !== saved.id)] } };
    });
    setNotices(previous => ({ ...previous, [saved.id]: current.version > saved.version
      ? `Your save is retained as version ${saved.version}. A newer saved version is available.`
      : `Saved version ${saved.version}.` }));
    void loadList(scope);
    return current;
  }, [loadList, rememberHead]);

  const create = useCallback(async (title, language, contentOverride) => {
    const scope = analysisId, key = `new:${scope}`;
    let input = pending.current.get(key);
    if (!scope || !projectId || !canWrite && !input || blocked || inFlight.current.has(key)) return null;
    const selection = selectionGenerations.current.get(scope) || 0;
    try {
      if (!input) input = normalizeNotebookCreate({ requestId: crypto.randomUUID(), title,
        content: contentOverride ?? { schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: language, metadata: {},
          cells: [{ id: crypto.randomUUID(), type: 'code', language, source: '', metadata: {}, collapsed: false }] } });
    } catch (error) { setProblems(previous => ({ ...previous, [key]: { message: localErrorMessage(error) } })); return null; }
    pending.current.set(key, input);
    inFlight.current.add(key);
    setBusy(previous => ({ ...previous, [key]: true }));
    setProblems(previous => ({ ...previous, [key]: null }));
    try {
      const response = await sendJournal(scope, null, input);
      if (!mounted.current || projectScope.current !== projectId) return null;
      if (!response) return null;
      const result = response.result;
      validateDocumentResult(result, projectId, scope);
      await validateNotebookSubmission(result, { projectId, analysisId: scope, documentId: null, action: 'create' }, response.operation);
      if (!mounted.current || projectScope.current !== projectId) return null;
      completeJournal(scope, null, response.operation.payload.requestId); const current = applySaved(scope, result, response.operation.payload);
      if ((selectionGenerations.current.get(scope) || 0) === selection) setSelections(previous => ({ ...previous, [scope]: result.document.id }));
      if (current.version > result.document.version) void open(result.document.id, scope, false);
      return result.document;
    } catch (error) {
      if (mounted.current && projectScope.current === projectId) {
        setProblems(previous => ({ ...previous, [key]: { message: errorMessage(error) } }));
      }
      return null;
    } finally {
      inFlight.current.delete(key);
      if (mounted.current && projectScope.current === projectId) setBusy(previous => ({ ...previous, [key]: false }));
    }
  }, [projectId, analysisId, canWrite, blocked, applySaved, open, sendJournal, completeJournal]);

  const save = useCallback(async () => {
    if (!selected || !draft || blocked || inFlight.current.has(selected.id)) return;
    const id = selected.id, scope = analysisId;
    inFlight.current.add(id);
    setBusy(previous => ({ ...previous, [id]: true }));
    setProblems(previous => ({ ...previous, [id]: null }));
    try {
      if (!journal.known.current[id]?.loaded && !await readJournal(scope, id)) throw pendingResponseError();
      let input = pending.current.get(id);
      if (!input && (!canWrite || !draft.dirty)) return;
      const existingPending = !!input;
      if (!input) input = normalizeNotebookSave({ requestId: crypto.randomUUID(), expectedVersion: draft.baseVersion,
        title: draft.title, content: draft.content });
      if (!existingPending) {
        const confirmed = await ensurePrivateDraft(id, scope, draft);
        if (!confirmed) {
          setProblems(previous => ({ ...previous, [id]: { message: 'Confirm your private draft before saving shared source. Your current edits are kept here.' } }));
          return;
        }
        pendingDraftVersions.current.set(id, confirmed.draftVersion);
      }
      pending.current.set(id, input);
      const response = await sendJournal(scope, id, input, pendingDraftVersions.current.get(id) ?? null);
      if (!mounted.current || projectScope.current !== projectId) return;
      if (!response) return;
      if (response.admission?.state === 'rejected') {
        completeJournal(scope, id, response.operation.payload.requestId);
        const failure = response.journal?.requestId === input.requestId ? response.journal.failure : response.admission.failure;
        const currentHead = failure?.currentHead ? rememberHead(failure.currentHead) : undefined;
        setProblems(previous => ({ ...previous, [id]: {
          message: 'The submitted source did not replace a newer saved version.', currentHead, submissionRejected: true,
        } }));
        return;
      }
      const result = response.result;
      validateDocumentResult(result, projectId, scope, id);
      await validateNotebookSubmission(result, { projectId, analysisId: scope, documentId: id, action: 'save' }, response.operation);
      if (!mounted.current || projectScope.current !== projectId) return;
      completeJournal(scope, id, response.operation.payload.requestId); const current = applySaved(scope, result, response.operation.payload);
      const privateVersion = response.operation.confirmedDraftVersion;
      if (!pending.current.has(id)) pendingDraftVersions.current.delete(id);
      if (privateVersion !== null) await clearPublishedDraft(id, scope, privateVersion);
      if (current.version > result.document.version) void open(id, scope, false);
    } catch (error) {
      if (mounted.current && projectScope.current === projectId) {
        const currentHead = error.currentHead ? rememberHead(error.currentHead) : undefined;
        setProblems(previous => ({ ...previous, [id]: { message: localErrorMessage(error), currentHead } }));
      }
    } finally {
      inFlight.current.delete(id);
      if (mounted.current && projectScope.current === projectId) setBusy(previous => ({ ...previous, [id]: false }));
    }
  }, [selected, draft, projectId, analysisId, canWrite, blocked, applySaved, open, rememberHead, ensurePrivateDraft, clearPublishedDraft, sendJournal, completeJournal, journal.known, readJournal]);

  const reviewSubmission = useCallback(async (documentId = null) => {
    const scope = analysisId, key = documentId || `new:${scope}`;
    if (blocked || inFlight.current.has(key)) return null;
    inFlight.current.add(key); setBusy(previous => ({ ...previous, [key]: true }));
    try {
      const response = await replayJournal(scope, documentId);
      if (!mounted.current || projectScope.current !== projectId || !response?.result) return null;
      const result = response.result, outcome = response.originalJournal.outcome;
      validateDocumentResult(result, projectId, scope, documentId);
      if (!outcome || result.document.id !== outcome.documentId || result.document.versionId !== outcome.versionId
          || result.document.sha256 !== outcome.sha256 || result.document.version !== outcome.version
          || result.submission?.requestId !== response.originalJournal.requestId) throw pendingResponseError();
      const sourceScope = { projectId, analysisId: scope, documentId, action: documentId ? 'save' : 'create' };
      const originalPayload = { requestId: response.originalJournal.requestId, title: result.document.title, content: result.document.content,
        ...(documentId ? { expectedVersion: result.document.version - 1 } : {}) };
      if (await notebookRequestHash(sourceScope, originalPayload) !== response.originalJournal.requestSha256) throw pendingResponseError();
      await validateNotebookSubmission(result, sourceScope, { payload: originalPayload });
      if (!mounted.current || projectScope.current !== projectId) return null;
      const current = applySaved(scope, result);
      if (!documentId) setSelections(previous => ({ ...previous, [scope]: result.document.id }));
      const privateVersion = response.originalJournal.confirmedDraftVersion;
      if (documentId && privateVersion !== null) await clearPublishedDraft(documentId, scope, privateVersion);
      completeJournal(scope, documentId, response.originalJournal.requestId);
      if (current.version > result.document.version) void open(result.document.id, scope, false);
      return result.document;
    } catch (error) {
      if (mounted.current && projectScope.current === projectId) setProblems(previous => ({ ...previous, [key]: { message: errorMessage(error) } }));
      return null;
    } finally {
      inFlight.current.delete(key);
      if (mounted.current && projectScope.current === projectId) setBusy(previous => ({ ...previous, [key]: false }));
    }
  }, [analysisId, projectId, blocked, replayJournal, applySaved, clearPublishedDraft, completeJournal, open]);

  return { index: index || { items: [] }, selectedId, selected, draft, heads, drafts,
    problem: problems[selectedId], creationProblem: problems[createKey], notice: notices[selectedId],
    busy: !!busy[selectedId], creating: !!busy[createKey], pendingSave: pending.current.has(selectedId),
    pendingCreate: pending.current.has(createKey),
    pendingCreateInfo: pending.current.has(createKey) ? { title: pending.current.get(createKey).title,
      language: pending.current.get(createKey).content.defaultLanguage,
      content: structuredClone(pending.current.get(createKey).content) } : null,
    pendingSaveInfo: pending.current.has(selectedId) ? structuredClone(pending.current.get(selectedId)) : null,
    sharedRecovery: journal.states[selectedId], creationRecovery: journal.states[createKey],
    clearUnsubmitted: (id, requestId) => journal.clearUnsubmitted(analysisId, id, requestId),
    reviewSubmission, refreshSubmission: id => readJournal(analysisId, id),
    autosave: autosave.copies[selectedId] || { state: 'idle', message: '', confirmedDraftVersion: 0, updatedAt: null },
    recoverableDraft: autosave.copies[selectedId]?.recovery || null,
    recoverDraft: () => autosave.recover(selectedId),
    discardDraft: () => autosave.discard(selectedId, analysisId, autosave.copies[selectedId]?.confirmedDraftVersion),
    retryAutosave: () => autosave.retry(selectedId, analysisId),
    open, edit, editUiState, save, create,
    refresh: () => loadList(analysisId), loadMore: () => loadList(analysisId, index?.nextCursor) };
}
