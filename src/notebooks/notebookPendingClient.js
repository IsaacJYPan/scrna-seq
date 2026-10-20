import { NOTEBOOK_PENDING_SCHEMA, canonicalNotebookPendingRequest, normalizeNotebookPendingSubmit } from '../../shared/notebookPending.mjs';
import { normalizeNotebookCreate, normalizeNotebookSave, canonicalNotebookContent,
  NOTEBOOK_DOCUMENT_ID, NOTEBOOK_VERSION_ID } from '../../shared/notebookDocument.mjs';

export const pendingResponseError = () => Object.assign(new Error('The shared submission could not be confirmed. Retry to check the original request.'), { code: 'INVALID_PENDING_RESPONSE' });
const hashPattern = /^[a-f0-9]{64}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
export async function notebookRequestHash(scope, payload) {
  const text = canonicalNotebookPendingRequest({ ...scope, payload });
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
export const sameNotebookPayload = (action, left, right) => {
  const normalize = action === 'create' ? normalizeNotebookCreate : normalizeNotebookSave;
  try { return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right)); } catch { return false; }
};

export async function validateNotebookPending(result, scope, ownerUserId) {
  const journal = result?.journal;
  if (!Number.isSafeInteger(result?.journalVersion) || result.journalVersion < 0) throw pendingResponseError();
  if (journal === null) {
    if (result.journalVersion !== 0) throw pendingResponseError();
    return result;
  }
  if (!journal || journal.schema !== NOTEBOOK_PENDING_SCHEMA || journal.visibility !== 'private'
      || !positive(journal.ownerUserId) || ownerUserId !== undefined && journal.ownerUserId !== ownerUserId
      || journal.projectId !== scope.projectId || journal.analysisId !== scope.analysisId
      || journal.documentId !== scope.documentId || journal.action !== scope.action
      || !positive(journal.admittedVersion) || journal.journalVersion !== result.journalVersion
      || journal.journalVersion < journal.admittedVersion || !hashPattern.test(journal.requestSha256 || '')
      || !['pending', 'succeeded', 'rejected'].includes(journal.state)
      || journal.confirmedDraftVersion !== null && (!positive(journal.confirmedDraftVersion) || scope.action !== 'save')) throw pendingResponseError();
  try { normalizeNotebookPendingSubmit({ requestId: journal.requestId, admittedVersion: journal.admittedVersion }); }
  catch { throw pendingResponseError(); }
  if (journal.state !== 'succeeded') {
    const normalize = scope.action === 'create' ? normalizeNotebookCreate : normalizeNotebookSave;
    let payload;
    try { payload = normalize(journal.payload); } catch { throw pendingResponseError(); }
    if (payload.requestId !== journal.requestId || await notebookRequestHash(scope, payload) !== journal.requestSha256) throw pendingResponseError();
  } else if (journal.payload !== null || !NOTEBOOK_DOCUMENT_ID.test(journal.outcome?.documentId || '')
      || !NOTEBOOK_VERSION_ID.test(journal.outcome?.versionId || '') || !positive(journal.outcome?.version)
      || !hashPattern.test(journal.outcome?.sha256 || '') || journal.failure !== null) throw pendingResponseError();
  if (journal.state === 'pending' && (journal.failure !== null || journal.outcome !== null)) throw pendingResponseError();
  if (journal.state === 'rejected' && (scope.action !== 'save' || journal.failure?.code !== 'NOTEBOOK_VERSION_CONFLICT'
      || journal.failure.submittedExpectedVersion !== journal.payload.expectedVersion || journal.outcome !== null)) throw pendingResponseError();
  return result;
}

// A transport-level 200 does not prove the submitted source was retained.
export async function validateNotebookSubmission(result, scope, operation) {
  const receipt = result?.submission, saved = result?.document;
  if (!receipt || receipt.requestId !== operation.payload.requestId || receipt.action !== scope.action
      || receipt.documentId !== saved?.id || !NOTEBOOK_DOCUMENT_ID.test(saved?.id || '')
      || scope.documentId && saved.id !== scope.documentId || !NOTEBOOK_VERSION_ID.test(saved?.versionId || '')
      || receipt.versionId !== saved.versionId || receipt.version !== saved.version || receipt.sha256 !== saved.sha256
      || saved.title !== operation.payload.title
      || canonicalNotebookContent(saved.content) !== canonicalNotebookContent(operation.payload.content)
      || scope.action === 'save' && saved.version !== operation.payload.expectedVersion + 1) throw pendingResponseError();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalNotebookContent(saved.content)))),
    byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== saved.sha256) throw pendingResponseError();
}
