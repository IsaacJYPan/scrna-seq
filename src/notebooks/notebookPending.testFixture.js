import { createHash } from 'node:crypto';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import { canonicalNotebookPendingRequest } from '../../shared/notebookPending.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
// In-memory service fixture for controller/component interaction tests. Real
// transaction, authorization and concurrency checks live in the backend suite.
export function installNotebookJournalFixture(api) {
  const slots = new Map(), requests = new Map();
  const key = (project, analysis, document) => `${project}:${analysis}:${document || 'create'}`;
  const response = (journal, admission, result) => ({ journal: clone(journal || null), journalVersion: journal?.journalVersion || 0,
    ...(admission ? { admission: clone(admission) } : {}), ...(result ? { result: clone(result) } : {}) });
  api.getNotebookPending.mockImplementation(async (project, analysis, document) => response(slots.get(key(project, analysis, document))));
  api.admitNotebookPending.mockImplementation(async (projectId, analysisId, documentId, input) => {
    const slotKey = key(projectId, analysisId, documentId), action = documentId ? 'save' : 'create';
    const old = requests.get(input.payload.requestId);
    if (old) return response(slots.get(slotKey), old, old.result);
    const previous = slots.get(slotKey), journalVersion = (previous?.journalVersion || 0) + 1;
    if (input.expectedJournalVersion !== journalVersion - 1 || previous?.state === 'pending') throw Object.assign(new Error('Pending conflict'), { status: 409, code: 'NOTEBOOK_PENDING_CONFLICT' });
    const journal = { schema: 'traceomics.notebook-pending.v1', visibility: 'private', ownerUserId: 1, projectId, analysisId,
      documentId: documentId || null, action, journalVersion, admittedVersion: journalVersion, requestId: input.payload.requestId,
      requestSha256: hash(canonicalNotebookPendingRequest({ projectId, analysisId, documentId, action, payload: input.payload })),
      payload: clone(input.payload), confirmedDraftVersion: input.confirmedDraftVersion, state: 'pending', failure: null, outcome: null,
      createdAt: '2026-10-20T12:00:00Z', updatedAt: '2026-10-20T12:00:00Z' };
    slots.set(slotKey, journal); requests.set(journal.requestId, journal);
    return response(journal, journal);
  });
  api.submitNotebookPending.mockImplementation(async (project, analysis, documentId, input) => {
    const slotKey = key(project, analysis, documentId), accepted = requests.get(input.requestId);
    if (!accepted || accepted.admittedVersion !== input.admittedVersion) throw new Error('Unknown pending request');
    if (accepted.result) return response(slots.get(slotKey), accepted, accepted.result);
    let result;
    try {
      result = accepted.action === 'create'
        ? await api.createNotebook(project, analysis, clone(accepted.payload))
        : await api.saveNotebook(project, analysis, documentId, clone(accepted.payload));
    } catch (error) {
      if (error.code !== 'NOTEBOOK_VERSION_CONFLICT') throw error;
      accepted.state = 'rejected'; accepted.failure = { code: error.code, message: error.message, currentHead: error.currentHead,
        submittedExpectedVersion: accepted.payload.expectedVersion };
      accepted.journalVersion++; return response(accepted, accepted);
    }
    if (!result?.document) return response(slots.get(slotKey), accepted, result);
    result = clone(result);
    const document = result.document;
    document.sha256 = hash(canonicalNotebookContent(document.content));
    if (result.currentHead?.versionId === document.versionId) result.currentHead.sha256 = document.sha256;
    result.submission = { schema: 'traceomics.notebook-submission.v1', action: accepted.action, requestId: input.requestId,
      documentId: document.id, versionId: document.versionId, version: document.version, sha256: document.sha256 };
    accepted.result = clone(result); accepted.state = 'succeeded'; accepted.journalVersion++;
    accepted.outcome = { documentId: document.id, versionId: document.versionId, version: document.version, sha256: document.sha256 };
    accepted.payload = null;
    return response(slots.get(slotKey), accepted, result);
  });
  return { slots, requests, response };
}
