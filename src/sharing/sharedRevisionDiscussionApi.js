import { createSnapshotTransport } from '../analyses/snapshotTransport';

const { request } = createSnapshotTransport({ invalidCode: 'INVALID_SHARED_DISCUSSION_RESPONSE', unreachableCode: 'SHARED_DISCUSSION_UNREACHABLE' });
const maximumBytes = 1024 * 1024;
const invalid = () => Object.assign(new Error('Use the exact saved revision and a bounded discussion page.'), { code: 'INVALID_SHARED_DISCUSSION_REQUEST' });

// Read-only use of the existing discussion route. Thirty maximum-size Unicode
// comments fit here; streamed bytes are bounded before JSON parsing.
export async function listSharedRevisionComments(projectId, analysisId, attachmentId, revisionId, { cursor, signal } = {}) {
  if (typeof projectId !== 'string' || !/^proj_[a-f0-9]{16,40}$/.test(projectId)
    || typeof analysisId !== 'string' || !/^ra_[a-f0-9]{24}$/.test(analysisId)
    || typeof attachmentId !== 'string' || !/^raa_[a-f0-9]{24}$/.test(attachmentId)
    || typeof revisionId !== 'string' || !/^rar_[a-f0-9]{24}$/.test(revisionId)
    || cursor !== null && cursor !== undefined && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(cursor))) throw invalid();
  const query = new URLSearchParams({ limit: '30', ...(cursor ? { cursor } : {}) });
  return request(`/api/projects/${projectId}/analyses/${analysisId}/attachments/${attachmentId}/revisions/${revisionId}/comments?${query}`, { signal }, maximumBytes);
}
