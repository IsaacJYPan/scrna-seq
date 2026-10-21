import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';

const path = (projectId, analysisId) => `/api/projects/${encodeURIComponent(projectId)}/analyses/${encodeURIComponent(analysisId)}/attachments`;
async function request(endpoint, { signal, body } = {}) {
  return withExecutionTarget(async () => {
    const response = await fetch(apiUrl(endpoint), {
      method: body === undefined ? 'GET' : 'POST', signal, credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(result?.error || 'Outside results could not be loaded.'), { status: response.status, code: result?.code,
      attachment: result?.attachment, submittedExpectedHeadRevisionId: result?.submittedExpectedHeadRevisionId });
    if (!result || typeof result !== 'object') throw new Error('The attachment service returned an unreadable response.');
    return result;
  }, { mutation: body !== undefined });
}
function pageQuery(cursor) {
  const query = new URLSearchParams({ limit: '30' });
  if (cursor) query.set('cursor', cursor);
  return query;
}
export const listAnalysisAttachments = (projectId, analysisId, { cursor, signal } = {}) => request(`${path(projectId, analysisId)}?${pageQuery(cursor)}`, { signal });
export const listAnalysisAttachmentOptions = (projectId, analysisId, { cursor, signal } = {}) => request(`${path(projectId, analysisId)}/options?${pageQuery(cursor)}`, { signal });
export const createAnalysisAttachment = (projectId, analysisId, body, { signal } = {}) => request(path(projectId, analysisId), { body, signal });
export const getAnalysisAttachmentRequest = (projectId, analysisId, requestId, { signal } = {}) => request(`${path(projectId, analysisId)}/requests/${encodeURIComponent(requestId)}`, { signal });
const revisions = (projectId, analysisId, attachmentId) => `${path(projectId, analysisId)}/${encodeURIComponent(attachmentId)}/revisions`;
export const correctAnalysisAttachment = (projectId, analysisId, attachmentId, body, { signal } = {}) => request(revisions(projectId, analysisId, attachmentId), { body, signal });
export const listAnalysisAttachmentRevisions = (projectId, analysisId, attachmentId, { cursor, signal } = {}) => request(`${revisions(projectId, analysisId, attachmentId)}?${pageQuery(cursor)}`, { signal });
export const getAnalysisAttachmentRevision = (projectId, analysisId, attachmentId, revisionId, { signal } = {}) => request(`${revisions(projectId, analysisId, attachmentId)}/${encodeURIComponent(revisionId)}`, { signal });
const comments = (projectId, analysisId, attachmentId, revisionId) => `${revisions(projectId, analysisId, attachmentId)}/${encodeURIComponent(revisionId)}/comments`;
export const listAnalysisAttachmentComments = (projectId, analysisId, attachmentId, revisionId, { cursor, signal } = {}) => request(`${comments(projectId, analysisId, attachmentId, revisionId)}?${pageQuery(cursor)}`, { signal });
export const createAnalysisAttachmentComment = (projectId, analysisId, attachmentId, revisionId, body, { signal } = {}) => request(comments(projectId, analysisId, attachmentId, revisionId), { body, signal });
export const getAnalysisAttachmentCommentRequest = (projectId, analysisId, requestId, { signal } = {}) => request(`${path(projectId, analysisId)}/comment-requests/${encodeURIComponent(requestId)}`, { signal });
