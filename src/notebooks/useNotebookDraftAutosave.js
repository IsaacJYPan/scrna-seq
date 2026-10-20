import { useCallback, useEffect, useRef, useState } from 'react';
import { getNotebookDraft, saveNotebookDraft, clearNotebookDraft } from './notebookApi';
import { NOTEBOOK_VERSION_ID, normalizeNotebookContent } from '../../shared/notebookDocument.mjs';
import { normalizeNotebookDraft, canonicalNotebookDraftSnapshot } from '../../shared/notebookDraft.mjs';

const invalid = () => Object.assign(new Error('The private document draft service returned an unreadable response.'), { code: 'INVALID_DRAFT_RESPONSE' });
const messageFor = error => error.code === 'NOTEBOOK_DRAFT_CONFLICT'
  ? 'Your private draft changed in another window. Your current source is kept here; review both copies.'
  : error.code === 'ANALYSIS_ARCHIVED' ? 'This analysis is archived. Your private draft is kept; restore the analysis before checkpointing new edits.'
    : error.code === 'FORBIDDEN' ? 'Your current role cannot checkpoint new edits. Previously confirmed private drafts remain recoverable while you can read this project.'
      : ['INVALID_NOTEBOOK_DOCUMENT', 'NOTEBOOK_DOCUMENT_TOO_LARGE', 'INVALID_NOTEBOOK_DRAFT'].includes(error.code) ? error.message
        : 'Private autosave could not be confirmed. Your current source is kept here; retry to check the same checkpoint.';
const blank = () => ({ state: 'idle', message: '', confirmedDraftVersion: 0, updatedAt: null, loaded: false, recovery: null });

export default function useNotebookDraftAutosave({ projectId, analysisId, userId, blocked, canWrite,
  records, drafts, setDrafts, rememberHead, sharedPending, sharedInFlight }) {
  const [copies, setCopies] = useState({});
  const known = useRef({}), mounted = useRef(false), scope = useRef(projectId);
  const generations = useRef(new Map()), pending = useRef(new Map()), pendingClears = useRef(new Map()), inFlight = useRef(new Map());
  const timers = useRef(new Map()), confirmedObjects = useRef(new Map()), access = useRef({});
  const live = useRef(null);
  scope.current = projectId;
  access.current[analysisId] = canWrite;
  live.current = { records, drafts, blocked };
  const patch = useCallback((id, change) => {
    known.current[id] = { ...(known.current[id] || blank()), ...change };
    setCopies(previous => ({ ...previous, [id]: known.current[id] }));
    return known.current[id];
  }, []);
  const generation = id => { const value = (generations.current.get(id) || 0) + 1; generations.current.set(id, value); return value; };
  const cancelTimer = useCallback(id => { clearTimeout(timers.current.get(id)?.timer); timers.current.delete(id); }, []);
  useEffect(() => {
    const scheduled = timers.current;
    mounted.current = true;
    return () => { mounted.current = false; for (const { timer } of scheduled.values()) clearTimeout(timer); scheduled.clear(); };
  }, []);

  const validate = useCallback((result, id, selectedAnalysis) => {
    const head = result?.currentHead, copy = result?.draft;
    if (!Number.isSafeInteger(result?.draftVersion) || result.draftVersion < 0 || !head || head.id !== id
        || head.projectId !== projectId || head.analysisId !== selectedAnalysis || !Number.isSafeInteger(head.version)
        || head.version < 1 || !NOTEBOOK_VERSION_ID.test(head.versionId || '') || !/^[a-f0-9]{64}$/.test(head.sha256 || '')) throw invalid();
    if (copy !== null) {
      if (!copy || copy.schema !== 'traceomics.notebook-draft.v1' || copy.visibility !== 'private'
          || copy.documentId !== id || copy.projectId !== projectId || copy.analysisId !== selectedAnalysis
          || !Number.isSafeInteger(copy.ownerUserId) || copy.ownerUserId < 1 || userId !== undefined && copy.ownerUserId !== userId
          || copy.draftVersion !== result.draftVersion || !/^[a-f0-9]{64}$/.test(copy.sha256 || '') || !Number.isFinite(Date.parse(copy.updatedAt))) throw invalid();
      try { normalizeNotebookDraft({ requestId: '550e8400-e29b-41d4-a716-446655440000', expectedDraftVersion: copy.draftVersion,
        baseVersion: copy.baseVersion, baseVersionId: copy.baseVersionId, title: copy.title, content: copy.content, uiState: copy.uiState }); }
      catch { throw invalid(); }
    }
    if (result.checkpoint && (!Number.isSafeInteger(result.checkpoint.draftVersion) || result.checkpoint.draftVersion < 1
      || result.checkpoint.draftVersion > result.draftVersion || !['update', 'clear'].includes(result.checkpoint.action))) throw invalid();
    return result;
  }, [projectId, userId]);

  const read = useCallback(async (id, selectedAnalysis, forConflict = false) => {
    if (!projectId || !selectedAnalysis || live.current.blocked) return null;
    const request = generation(id);
    try {
      const result = validate(await getNotebookDraft(projectId, selectedAnalysis, id), id, selectedAnalysis);
      if (!mounted.current || scope.current !== projectId || generations.current.get(id) !== request) return null;
      rememberHead(result.currentHead);
      const previous = known.current[id] || blank();
      if (result.draftVersion < previous.confirmedDraftVersion) return result;
      if ((previous.loaded || previous.confirmedDraftVersion > 0) && result.draftVersion === previous.confirmedDraftVersion
          && (!!previous.remote !== !!result.draft || previous.remote && (previous.remote.sha256 !== result.draft.sha256
            || canonicalNotebookDraftSnapshot(previous.remote) !== canonicalNotebookDraftSnapshot(result.draft)))) throw invalid();
      const local = live.current.drafts[id] || (live.current.records[id] && {
        ...live.current.records[id], baseVersion: live.current.records[id].version, baseVersionId: live.current.records[id].versionId });
      const newer = (previous.loaded || previous.confirmedDraftVersion > 0) && result.draftVersion > previous.confirmedDraftVersion;
      let matchesLocal = false;
      try { matchesLocal = !!result.draft && !!local && canonicalNotebookDraftSnapshot(result.draft) === canonicalNotebookDraftSnapshot(local); }
      catch { /* Incomplete local edits do not hide another window's valid private copy. */ }
      const needsChoice = !!result.draft && (!previous.loaded || forConflict || previous.recovery || newer && !matchesLocal);
      const removedLocalCheckpoint = newer && !result.draft && (local?.dirty || local?.privateDirty);
      if (removedLocalCheckpoint) confirmedObjects.current.delete(id);
      if (needsChoice || removedLocalCheckpoint) cancelTimer(id);
      patch(id, { loaded: true, confirmedDraftVersion: result.draftVersion, remote: result.draft,
        recovery: needsChoice ? result.draft : null, updatedAt: result.draft?.updatedAt || null,
        ...(removedLocalCheckpoint ? { needsConfirmation: true, state: 'failed',
          message: 'Another window removed your private checkpoint. Current edits are kept only here. Retry private autosave or explicitly save shared source before closing.' } : {}),
        ...(needsChoice ? { state: forConflict ? 'conflict' : 'saved',
          message: forConflict ? 'Another window has a newer private draft. Review it before choosing which source to keep.'
            : 'A confirmed private draft is available. Review it, then restore it or keep your current source.' } : {}) });
      return result;
    } catch (error) {
      if (mounted.current && scope.current === projectId && generations.current.get(id) === request) {
        patch(id, { loaded: false, state: live.current.blocked ? 'offline-unsaved' : 'failed', message: messageFor(error),
          ...([403, 404].includes(error.status) ? { recovery: null, remote: null } : {}) });
      }
      return null;
    }
  }, [projectId, patch, rememberHead, validate, cancelTimer]);

  const checkpoint = useCallback(async (id, selectedAnalysis, snapshot, automatic = false) => {
    if (inFlight.current.has(id)) return inFlight.current.get(id);
    if (live.current.blocked) { patch(id, { state: 'offline-unsaved', message: 'Current source has not reached the workspace. Reconnect before closing the app.' }); return null; }
    let input = pending.current.get(id);
    if (!input && !access.current[selectedAnalysis]) return null;
    const task = Promise.resolve().then(async () => {
      try {
        if (!known.current[id]?.loaded) {
          if (!await read(id, selectedAnalysis)) return null;
        }
        const copy = known.current[id] || blank();
        if (automatic && (copy.needsConfirmation || ['failed', 'conflict'].includes(copy.state))) return null;
        if (!input && copy.recovery) { patch(id, { state: 'conflict', message: 'Review the confirmed private draft before replacing it with current source.' }); return null; }
        if (!input) {
          const current = snapshot || live.current.drafts[id];
          if (!current?.dirty && !current?.privateDirty) return { draftVersion: copy.confirmedDraftVersion, draft: copy.remote };
          if (confirmedObjects.current.get(id) === current) return { draftVersion: copy.confirmedDraftVersion, draft: copy.remote };
          input = normalizeNotebookDraft({ requestId: crypto.randomUUID(), expectedDraftVersion: copy.confirmedDraftVersion,
            baseVersion: current.baseVersion, baseVersionId: current.baseVersionId || live.current.records[id]?.versionId,
            title: current.title, content: current.content, uiState: current.uiState || {} });
        }
        pending.current.set(id, input);
        cancelTimer(id); generation(id);
        patch(id, { state: 'saving', message: 'Checkpointing your private draft…' });
        const result = validate(await saveNotebookDraft(projectId, selectedAnalysis, id, input), id, selectedAnalysis);
        if (!mounted.current || scope.current !== projectId) return null;
        if (!result.checkpoint || result.checkpoint.requestId !== input.requestId || result.checkpoint.action !== 'update'
            || result.checkpoint.cleared !== false || result.checkpoint.draftVersion !== input.expectedDraftVersion + 1
            || !/^[a-f0-9]{64}$/.test(result.checkpoint.sha256 || '')) throw invalid();
        const acceptedCurrent = result.checkpoint.draftVersion === result.draftVersion;
        if (acceptedCurrent && (!result.draft || result.draft.sha256 !== result.checkpoint.sha256
          || canonicalNotebookDraftSnapshot(result.draft) !== canonicalNotebookDraftSnapshot(input))) throw invalid();
        pending.current.delete(id); rememberHead(result.currentHead);
        const previous = known.current[id] || blank();
        if (result.draftVersion < previous.confirmedDraftVersion) return result;
        const current = snapshot || live.current.drafts[id];
        let currentMatches = false;
        try {
          currentMatches = !!current && canonicalNotebookDraftSnapshot(normalizeNotebookDraft({ ...input,
            title: current.title, content: current.content, uiState: current.uiState || {}, baseVersion: current.baseVersion,
            baseVersionId: current.baseVersionId || live.current.records[id]?.versionId })) === canonicalNotebookDraftSnapshot(input);
        } catch { /* Newer incomplete local edits do not invalidate an accepted checkpoint. */ }
        if (acceptedCurrent && currentMatches) confirmedObjects.current.set(id, current);
        if (!acceptedCurrent && !result.draft) confirmedObjects.current.delete(id);
        patch(id, { loaded: true, confirmedDraftVersion: result.draftVersion, remote: result.draft,
          recovery: acceptedCurrent ? null : result.draft, updatedAt: result.draft?.updatedAt || null,
          needsConfirmation: !acceptedCurrent && !result.draft,
          state: acceptedCurrent ? currentMatches ? 'saved' : 'pending' : result.draft ? 'conflict' : 'failed',
          message: acceptedCurrent ? currentMatches ? 'Private draft checkpointed. Shared saved source is unchanged.' : 'Newer local edits are waiting for private autosave.'
            : result.draft ? 'Your earlier checkpoint was confirmed. Another window has a newer private draft; review both copies.'
              : 'Your earlier checkpoint was confirmed, then removed in another window. Current edits are kept only here; retry private autosave or explicitly save shared source.' });
        return acceptedCurrent ? result : null;
      } catch (error) {
        if (mounted.current && scope.current === projectId) {
          if (error.status >= 400 && error.status < 500 && error.code !== 'TARGET_EXECUTION_UNCONFIRMED') pending.current.delete(id);
          patch(id, { state: error.code === 'NOTEBOOK_DRAFT_CONFLICT' ? 'conflict' : live.current.blocked ? 'offline-unsaved' : 'failed', message: messageFor(error) });
          if (error.code === 'NOTEBOOK_DRAFT_CONFLICT') await read(id, selectedAnalysis, true);
        }
        return null;
      } finally { inFlight.current.delete(id); }
    });
    inFlight.current.set(id, task);
    return task;
  }, [projectId, read, patch, cancelTimer, validate, rememberHead]);

  useEffect(() => {
    for (const [id, current] of Object.entries(drafts)) {
      const selectedAnalysis = records[id]?.analysisId;
      const copy = copies[id] || blank();
      if (!current.dirty && !current.privateDirty || !selectedAnalysis || confirmedObjects.current.get(id) === current || sharedPending.current.has(id)
          || sharedInFlight.current.has(id) || inFlight.current.has(id) || pending.current.has(id) || pendingClears.current.has(id) || copy.recovery
          || ['failed', 'conflict'].includes(copy.state) || !access.current[selectedAnalysis]) continue;
      if (blocked) { if (copy.state !== 'offline-unsaved') patch(id, { state: 'offline-unsaved', message: 'Current source has not reached the workspace. Reconnect before closing the app.' }); cancelTimer(id); continue; }
      const previous = timers.current.get(id);
      if (previous?.snapshot === current) continue;
      const firstQueued = previous?.firstQueued || Date.now(); clearTimeout(previous?.timer);
      const timer = setTimeout(() => { timers.current.delete(id); void checkpoint(id, selectedAnalysis, undefined, true); }, Math.min(1000, Math.max(0, 5000 - (Date.now() - firstQueued))));
      timers.current.set(id, { timer, firstQueued, snapshot: current });
      if (copy.state !== 'pending') patch(id, { state: 'pending', message: 'Current edits are waiting for private autosave.' });
    }
  }, [drafts, records, copies, blocked, canWrite, checkpoint, patch, cancelTimer, sharedPending, sharedInFlight]);

  const recover = useCallback(id => {
    const copy = known.current[id], remote = copy?.recovery;
    if (!remote || sharedPending.current.has(id) || sharedInFlight.current.has(id) || inFlight.current.has(id)) return false;
    const saved = live.current.records[id];
    const restored = { title: remote.title, content: normalizeNotebookContent(remote.content), baseVersion: remote.baseVersion,
      baseVersionId: remote.baseVersionId, uiState: remote.uiState,
      dirty: !saved || saved.title !== remote.title || JSON.stringify(saved.content) !== JSON.stringify(remote.content), privateDirty: false };
    confirmedObjects.current.set(id, restored); setDrafts(previous => ({ ...previous, [id]: restored }));
    patch(id, { recovery: null, needsConfirmation: false, state: 'saved', message: 'Restored your confirmed private draft. Shared saved source is unchanged.' });
    return true;
  }, [patch, setDrafts, sharedPending, sharedInFlight]);

  const discard = useCallback(async (id, selectedAnalysis, expectedVersion) => {
    if (live.current.blocked || !access.current[selectedAnalysis] && !pendingClears.current.has(id)
      || sharedPending.current.has(id) || inFlight.current.has(id)) return false;
    if (pending.current.has(id) && !await checkpoint(id, selectedAnalysis)) return false;
    cancelTimer(id); generation(id);
    const version = expectedVersion ?? known.current[id]?.confirmedDraftVersion;
    if (!Number.isSafeInteger(version)) return false;
    const input = pendingClears.current.get(id) || { requestId: crypto.randomUUID(), expectedDraftVersion: version };
    pendingClears.current.set(id, input);
    const task = Promise.resolve().then(async () => {
      try {
      patch(id, { state: 'saving', message: 'Confirming private draft removal…' });
      const result = validate(await clearNotebookDraft(projectId, selectedAnalysis, id, input), id, selectedAnalysis);
      if (!mounted.current || scope.current !== projectId) return false;
      if (!result.checkpoint || result.checkpoint.requestId !== input.requestId || result.checkpoint.action !== 'clear'
          || result.checkpoint.cleared !== true || result.checkpoint.sha256 !== null
          || result.checkpoint.draftVersion !== input.expectedDraftVersion + 1
          || result.checkpoint.draftVersion === result.draftVersion && result.draft !== null) throw invalid();
      pendingClears.current.delete(id);
      if (result.draftVersion < (known.current[id]?.confirmedDraftVersion || 0)) return false;
      confirmedObjects.current.delete(id);
      patch(id, { loaded: true, confirmedDraftVersion: result.draftVersion, remote: result.draft, recovery: result.draft, needsConfirmation: false,
        state: result.draft ? 'conflict' : 'idle', message: result.draft ? 'Another private draft remains available.' : 'Previous private draft discarded. Your current source is kept here.', updatedAt: result.draft?.updatedAt || null });
      return !result.draft;
    } catch (error) {
      if (mounted.current && scope.current === projectId) {
        if (error.status >= 400 && error.status < 500 && error.code !== 'TARGET_EXECUTION_UNCONFIRMED') pendingClears.current.delete(id);
        patch(id, { state: error.code === 'NOTEBOOK_DRAFT_CONFLICT' ? 'conflict' : 'failed', message: messageFor(error) });
        if (error.code === 'NOTEBOOK_DRAFT_CONFLICT') await read(id, selectedAnalysis, true); }
      return false;
      } finally { inFlight.current.delete(id); }
    });
    inFlight.current.set(id, task);
    return task;
  }, [projectId, checkpoint, cancelTimer, validate, patch, read, sharedPending]);

  const ensure = useCallback(async (id, selectedAnalysis, snapshot) => {
    cancelTimer(id);
    const prior = inFlight.current.get(id);
    if (prior && !await prior) return null;
    if (pendingClears.current.has(id) && !await discard(id, selectedAnalysis)) return null;
    const first = await checkpoint(id, selectedAnalysis, snapshot);
    if (!first) return null;
    // Resolving an older uncertain checkpoint does not confirm newer text that
    // was typed while its reply was unknown. Flush that exact later snapshot too.
    if (first.draft && canonicalNotebookDraftSnapshot(first.draft) === canonicalNotebookDraftSnapshot(snapshot)) return first;
    const next = await checkpoint(id, selectedAnalysis, snapshot);
    return next?.draft && canonicalNotebookDraftSnapshot(next.draft) === canonicalNotebookDraftSnapshot(snapshot) ? next : null;
  }, [cancelTimer, checkpoint, discard]);
  const retry = useCallback((id, selectedAnalysis) => pendingClears.current.has(id)
    ? discard(id, selectedAnalysis) : checkpoint(id, selectedAnalysis), [checkpoint, discard]);
  const edited = useCallback(id => {
    if (known.current[id]?.state === 'failed' && !known.current[id]?.needsConfirmation && !pending.current.has(id) && !pendingClears.current.has(id)) {
      patch(id, { state: 'pending', message: 'Current edits are waiting for private autosave.' });
    }
  }, [patch]);
  return { copies, read, ensure, discard, recover,
    retry, edited,
    // Successful shared saves must use the version captured by their exact flush.
    clearPublished: discard };
}
