import { useCallback, useEffect, useRef, useState } from 'react';
import { getNotebookPending, admitNotebookPending, submitNotebookPending } from './notebookApi';
import { notebookRequestHash, pendingResponseError, validateNotebookPending } from './notebookPendingClient';

const scopeFor = (projectId, analysisId, documentId) => ({ projectId, analysisId, documentId: documentId || null,
  action: documentId ? 'save' : 'create' });
const keyFor = (analysisId, documentId) => documentId || `new:${analysisId}`;
const message = 'The shared submission could not be confirmed. Retry to check the original request before closing.';

// Only confirmed server records survive closure. Source and request bodies stay
// out of browser storage; opening a slot never submits shared work.
export default function useNotebookPendingSources({ projectId, userId, pending, pendingDraftVersions }) {
  const [states, setStates] = useState({});
  const known = useRef({}), operations = useRef(new Map()), reads = useRef(new Map());
  const mounted = useRef(false), scopeRef = useRef(projectId), generations = useRef(new Map());
  scopeRef.current = projectId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const patch = useCallback((key, value) => {
    if (!mounted.current || scopeRef.current !== projectId) return;
    known.current[key] = { ...known.current[key], ...value };
    setStates(previous => ({ ...previous, [key]: known.current[key] }));
  }, [projectId]);
  const accept = useCallback((key, result) => {
    const previous = known.current[key];
    if (previous?.journalVersion > result.journalVersion) return false;
    if (previous?.journal && result.journal && previous.journalVersion === result.journalVersion
        && JSON.stringify(previous.journal) !== JSON.stringify(result.journal)) throw pendingResponseError();
    patch(key, { journal: result.journal, journalVersion: result.journalVersion, loaded: true, checking: false, error: '' });
    return true;
  }, [patch]);
  const read = useCallback(async (analysisId, documentId) => {
    const key = keyFor(analysisId, documentId), scope = scopeFor(projectId, analysisId, documentId);
    if (reads.current.has(key)) return reads.current.get(key);
    const generation = (generations.current.get(key) || 0) + 1; generations.current.set(key, generation);
    patch(key, { checking: true, error: '' });
    const task = Promise.resolve().then(async () => {
      try {
        const result = await validateNotebookPending(await getNotebookPending(projectId, analysisId, documentId), scope, userId);
        if (!mounted.current || scopeRef.current !== projectId || generations.current.get(key) !== generation) return null;
        if (!accept(key, result)) { patch(key, { checking: false }); return null; }
        const journal = result.journal, local = operations.current.get(key);
        if (journal?.state === 'pending' && (!local || local.payload.requestId === journal.requestId)) {
          const operation = { payload: structuredClone(journal.payload), expectedJournalVersion: journal.admittedVersion - 1,
            admittedVersion: journal.admittedVersion, requestSha256: journal.requestSha256, confirmedDraftVersion: journal.confirmedDraftVersion };
          operations.current.set(key, operation); pending.current.set(key, operation.payload);
          if (documentId && operation.confirmedDraftVersion !== null) pendingDraftVersions.current.set(documentId, operation.confirmedDraftVersion);
          patch(key, { recovered: !local, phase: 'confirmed' });
        }
        return result;
      } catch (error) {
        patch(key, { checking: false, loaded: false, error: message,
          ...([403, 404].includes(error.status) ? { journal: null } : {}) });
        return null;
      } finally { reads.current.delete(key); }
    });
    reads.current.set(key, task);
    return task;
  }, [projectId, userId, accept, patch, pending, pendingDraftVersions]);

  const send = useCallback(async (analysisId, documentId, payload, confirmedDraftVersion = null) => {
    const key = keyFor(analysisId, documentId), scope = scopeFor(projectId, analysisId, documentId);
    let operation = operations.current.get(key);
    if (!operation) {
      if (!known.current[key]?.loaded && !await read(analysisId, documentId)) throw pendingResponseError();
      operation = operations.current.get(key);
      if (operation && operation.payload.requestId !== payload.requestId) {
        throw Object.assign(new Error('Another window has an unresolved submission. Check that original request before sharing more source.'), { code: 'NOTEBOOK_PENDING_CONFLICT' });
      }
      if (!operation) {
        operation = { payload: structuredClone(payload), expectedJournalVersion: known.current[key].journalVersion,
          confirmedDraftVersion, requestSha256: await notebookRequestHash(scope, payload) };
        if (!mounted.current || scopeRef.current !== projectId) return null;
        operations.current.set(key, operation); pending.current.set(key, operation.payload);
      }
    }
    patch(key, { error: '', phase: operation.admittedVersion ? 'confirmed' : 'unconfirmed' });
    try {
      if (!operation.admittedVersion) {
        const result = await validateNotebookPending(await admitNotebookPending(projectId, analysisId, documentId, {
          expectedJournalVersion: operation.expectedJournalVersion, payload: operation.payload,
          confirmedDraftVersion: operation.confirmedDraftVersion,
        }), scope, userId);
        if (!mounted.current || scopeRef.current !== projectId) return null;
        const admission = result.admission;
        if (!admission || admission.requestId !== operation.payload.requestId || admission.requestSha256 !== operation.requestSha256
            || admission.action !== scope.action || admission.documentId !== scope.documentId
            || admission.confirmedDraftVersion !== operation.confirmedDraftVersion
            || admission.admittedVersion !== operation.expectedJournalVersion + 1
            || !['pending', 'succeeded', 'rejected'].includes(admission.state)) throw pendingResponseError();
        operation.admittedVersion = admission.admittedVersion;
        accept(key, result); patch(key, { phase: 'confirmed' });
      }
      const response = await validateNotebookPending(await submitNotebookPending(projectId, analysisId, documentId, {
        requestId: operation.payload.requestId, admittedVersion: operation.admittedVersion,
      }), scope, userId);
      if (!mounted.current || scopeRef.current !== projectId) return null;
      const admission = response.admission;
      if (!admission || admission.requestId !== operation.payload.requestId || admission.requestSha256 !== operation.requestSha256
          || admission.admittedVersion !== operation.admittedVersion || admission.action !== scope.action
          || admission.documentId !== scope.documentId || admission.confirmedDraftVersion !== operation.confirmedDraftVersion
          || !['succeeded', 'rejected'].includes(admission.state)
          || admission.state === 'rejected' && (scope.action !== 'save' || admission.failure?.code !== 'NOTEBOOK_VERSION_CONFLICT'
            || admission.failure.submittedExpectedVersion !== operation.payload.expectedVersion)) throw pendingResponseError();
      // Do not clear the pending UUID until the controller has checked the
      // exact immutable source receipt, not just the journal's status.
      accept(key, response);
      return { ...response, operation };
    } catch (error) {
      if (error.code === 'NOTEBOOK_PENDING_CONFLICT' && !operation.admittedVersion) {
        // The server definitively refused this admission under its slot lock.
        // Keep that unsubmitted source separately while exposing the other
        // window's actual admitted operation; never loop on a stale CAS.
        const unsubmittedPayload = structuredClone(operation.payload);
        operations.current.delete(key); pending.current.delete(key);
        patch(key, { loaded: false, unsubmittedPayload, phase: null });
        await read(analysisId, documentId);
        patch(key, { unsubmittedPayload });
      }
      patch(key, { error: error.code === 'NOTEBOOK_PENDING_CONFLICT' ? error.message : message });
      throw error;
    }
  }, [projectId, userId, read, patch, accept, pending]);
  const complete = useCallback((analysisId, documentId, requestId) => {
    const key = keyFor(analysisId, documentId);
    if (requestId && operations.current.get(key)?.payload.requestId !== requestId && operations.current.has(key)) return;
    const current = known.current[key]?.journal;
    if (current && requestId && current.requestId !== requestId) {
      // Another window may admit its next operation while the previous reply
      // is still travelling. Resolve only the old request, keeping the newer
      // slot and its captured private checkpoint independently recoverable.
      operations.current.delete(key); pending.current.delete(key);
      if (current.state === 'pending') {
        const operation = { payload: structuredClone(current.payload), expectedJournalVersion: current.admittedVersion - 1,
          admittedVersion: current.admittedVersion, requestSha256: current.requestSha256, confirmedDraftVersion: current.confirmedDraftVersion };
        operations.current.set(key, operation); pending.current.set(key, operation.payload);
        if (documentId && current.confirmedDraftVersion !== null) pendingDraftVersions.current.set(documentId, current.confirmedDraftVersion);
      }
      patch(key, { phase: current.state === 'pending' ? 'confirmed' : current.state === 'rejected' ? 'rejected' : null,
        recovered: true, error: '' });
      return;
    }
    operations.current.delete(key); pending.current.delete(key);
    patch(key, { phase: known.current[key]?.journal?.state === 'rejected' ? 'rejected' : 'resolved', recovered: false, error: '' });
  }, [patch, pending, pendingDraftVersions]);
  const replay = useCallback(async (analysisId, documentId) => {
    const key = keyFor(analysisId, documentId), scope = scopeFor(projectId, analysisId, documentId);
    const journal = known.current[key]?.journal;
    if (!journal || journal.state !== 'succeeded') return null;
    const result = await validateNotebookPending(await submitNotebookPending(projectId, analysisId, documentId,
      { requestId: journal.requestId, admittedVersion: journal.admittedVersion }), scope, userId);
    if (!mounted.current || scopeRef.current !== projectId) return null;
    if (result.admission?.requestId !== journal.requestId || result.admission?.requestSha256 !== journal.requestSha256
        || result.admission?.admittedVersion !== journal.admittedVersion) throw pendingResponseError();
    accept(key, result);
    return { ...result, originalJournal: journal };
  }, [projectId, userId, accept]);
  const clearUnsubmitted = useCallback((analysisId, documentId, requestId) => {
    const key = keyFor(analysisId, documentId);
    if (known.current[key]?.unsubmittedPayload?.requestId === requestId) patch(key, { unsubmittedPayload: null });
  }, [patch]);
  return { states, known, read, send, complete, replay, clearUnsubmitted };
}
