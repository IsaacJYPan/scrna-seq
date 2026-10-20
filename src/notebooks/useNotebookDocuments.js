import { useCallback, useEffect, useRef, useState } from 'react';
import { createNotebook, getNotebook, listNotebooks, saveNotebook } from './notebookApi';
import { NOTEBOOK_DOCUMENT_SCHEMA, NOTEBOOK_DOCUMENT_ID, NOTEBOOK_VERSION_ID,
  normalizeNotebookContent, normalizeNotebookCreate, normalizeNotebookSave } from '../../shared/notebookDocument.mjs';
import { publicErrorMessage } from '../publicError';

const errorMessage = error => {
  const messages = {
    NOTEBOOK_VERSION_CONFLICT: 'A newer notebook version is available. Your draft has not replaced it.',
    ANALYSIS_ARCHIVED: 'This analysis is archived. Your draft is kept; restore the analysis before saving new changes.',
    FORBIDDEN: 'Your project role allows reading notebooks but not editing them.',
    NOTEBOOK_DOCUMENT_TOO_LARGE: 'The notebook exceeds the saved document size limit. Reduce source or metadata and try again.',
    NOTEBOOK_REQUEST_CONFLICT: 'This request belongs to a different saved draft. Check the original save before starting another request.',
  };
  return messages[error.code] || publicErrorMessage(error, 'The notebook request could not be confirmed. Your draft is kept here.');
};
const localErrorMessage = error => ['INVALID_NOTEBOOK_DOCUMENT', 'NOTEBOOK_DOCUMENT_TOO_LARGE'].includes(error.code)
  ? error.message : errorMessage(error);
const draftFor = document => ({ title: document.title, content: document.content, baseVersion: document.version, dirty: false });
const newest = (...values) => values.filter(Boolean).reduce((best, value) => !best || value.version > best.version ? value : best, null);
const unreadable = () => new Error('The notebook service returned an unreadable response.');
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

// Source and editor drafts live in the mounted, user/project/service-scoped page.
// Whole-application autosave/recovery is a separate persistence facility.
export default function useNotebookDocuments({ projectId, analysisId, isActive, blocked, canWrite }) {
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
    } catch (error) {
      if (mounted.current && projectScope.current === projectId && documentGenerations.current.get(id) === request) {
        setProblems(previous => ({ ...previous, [id]: { message: errorMessage(error), inaccessible: [403, 404].includes(error.status) } }));
        if ([403, 404].includes(error.status)) setRecords(previous => { const next = { ...previous }; delete next[id]; return next; });
      }
    }
  }, [projectId, analysisId, rememberHead]);

  const edit = useCallback((id, change) => {
    if (!canWrite || blocked || pending.current.has(id) || inFlight.current.has(id)) return;
    setDrafts(previous => {
      const base = previous[id] || (live.current.records[id] && draftFor(live.current.records[id]));
      if (!base) return previous;
      const next = typeof change === 'function' ? change(base) : { ...base, ...change };
      return { ...previous, [id]: { ...next, dirty: true } };
    });
    setNotices(previous => ({ ...previous, [id]: '' }));
  }, [canWrite, blocked]);

  const applySaved = useCallback((scope, result) => {
    const saved = result.document;
    const current = rememberHead(result.currentHead);
    generation(documentGenerations, saved.id);
    generation(listGenerations, scope);
    setRecords(previous => ({ ...previous, [saved.id]: previous[saved.id]?.version > saved.version ? previous[saved.id] : saved }));
    setDrafts(previous => { const next = { ...previous }; delete next[saved.id]; return next; });
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
      const result = await createNotebook(projectId, scope, input);
      if (!mounted.current || projectScope.current !== projectId) return null;
      validateDocumentResult(result, projectId, scope);
      pending.current.delete(key); const current = applySaved(scope, result);
      if ((selectionGenerations.current.get(scope) || 0) === selection) setSelections(previous => ({ ...previous, [scope]: result.document.id }));
      if (current.version > result.document.version) void open(result.document.id, scope, false);
      return result.document;
    } catch (error) {
      if (mounted.current && projectScope.current === projectId) {
        if (error.status >= 400 && error.status < 500 && error.code !== 'TARGET_EXECUTION_UNCONFIRMED') pending.current.delete(key);
        setProblems(previous => ({ ...previous, [key]: { message: errorMessage(error) } }));
      }
      return null;
    } finally {
      inFlight.current.delete(key);
      if (mounted.current && projectScope.current === projectId) setBusy(previous => ({ ...previous, [key]: false }));
    }
  }, [projectId, analysisId, canWrite, blocked, applySaved, open]);

  const save = useCallback(async () => {
    if (!selected || !draft || blocked || inFlight.current.has(selected.id)) return;
    const id = selected.id, scope = analysisId;
    let input = pending.current.get(id);
    if (!input && (!canWrite || !draft.dirty)) return;
    try {
      if (!input) input = normalizeNotebookSave({ requestId: crypto.randomUUID(), expectedVersion: draft.baseVersion,
        title: draft.title, content: draft.content });
    } catch (error) { setProblems(previous => ({ ...previous, [id]: { message: localErrorMessage(error) } })); return; }
    pending.current.set(id, input);
    inFlight.current.add(id);
    setBusy(previous => ({ ...previous, [id]: true }));
    setProblems(previous => ({ ...previous, [id]: null }));
    try {
      const result = await saveNotebook(projectId, scope, id, input);
      if (!mounted.current || projectScope.current !== projectId) return;
      validateDocumentResult(result, projectId, scope, id);
      pending.current.delete(id); const current = applySaved(scope, result);
      if (current.version > result.document.version) void open(id, scope, false);
    } catch (error) {
      if (mounted.current && projectScope.current === projectId) {
        if (error.status >= 400 && error.status < 500 && error.code !== 'TARGET_EXECUTION_UNCONFIRMED') pending.current.delete(id);
        const currentHead = error.currentHead ? rememberHead(error.currentHead) : undefined;
        setProblems(previous => ({ ...previous, [id]: { message: errorMessage(error), currentHead } }));
      }
    } finally {
      inFlight.current.delete(id);
      if (mounted.current && projectScope.current === projectId) setBusy(previous => ({ ...previous, [id]: false }));
    }
  }, [selected, draft, projectId, analysisId, canWrite, blocked, applySaved, open, rememberHead]);

  return { index: index || { items: [] }, selectedId, selected, draft, heads, drafts,
    problem: problems[selectedId], creationProblem: problems[createKey], notice: notices[selectedId],
    busy: !!busy[selectedId], creating: !!busy[createKey], pendingSave: pending.current.has(selectedId),
    pendingCreate: pending.current.has(createKey),
    pendingCreateInfo: pending.current.has(createKey) ? { title: pending.current.get(createKey).title,
      language: pending.current.get(createKey).content.defaultLanguage } : null,
    open, edit, save, create,
    refresh: () => loadList(analysisId), loadMore: () => loadList(analysisId, index?.nextCursor) };
}
