import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';

const base = (projectId, analysisId) => `/api/projects/${encodeURIComponent(projectId)}/analyses/${encodeURIComponent(analysisId)}/documents`;
async function request(path, { method = 'GET', body, signal } = {}) {
  return withExecutionTarget(async () => {
    const response = await fetch(apiUrl(path), {
      method, signal, credentials: 'include', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(result?.error || 'The notebook service is unavailable.'), {
      status: response.status, code: result?.code, currentHead: result?.currentHead,
      submittedExpectedVersion: result?.submittedExpectedVersion,
    });
    if (!result || typeof result !== 'object') throw new Error('The notebook service returned an unreadable response.');
    return result;
  }, { mutation: method !== 'GET' });
}

export function listNotebooks(projectId, analysisId, { cursor, signal } = {}) {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  return request(`${base(projectId, analysisId)}?${query}`, { signal });
}
export const getNotebook = (projectId, analysisId, documentId, { signal } = {}) =>
  request(`${base(projectId, analysisId)}/${encodeURIComponent(documentId)}`, { signal });
export const createNotebook = (projectId, analysisId, body) =>
  request(base(projectId, analysisId), { method: 'POST', body });
export const saveNotebook = (projectId, analysisId, documentId, body) =>
  request(`${base(projectId, analysisId)}/${encodeURIComponent(documentId)}`, { method: 'PUT', body });
export const getNotebookVersion = (projectId, analysisId, documentId, versionId, { signal } = {}) =>
  request(`${base(projectId, analysisId)}/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}`, { signal });
