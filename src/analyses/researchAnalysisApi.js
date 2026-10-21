import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';

const projectPath = projectId => `/api/projects/${encodeURIComponent(projectId)}/analyses`;

async function request(path, { signal, method = 'GET', body } = {}) {
  return withExecutionTarget(async () => {
    const response = await fetch(apiUrl(path), {
      method, signal, credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw Object.assign(new Error(result?.error || 'The analysis service is unavailable.'), {
        status: response.status, code: result?.code,
        analysis: result?.analysis, submittedExpectedVersion: result?.submittedExpectedVersion,
      });
    }
    if (!result || typeof result !== 'object') throw new Error('The analysis service returned an unreadable response.');
    return result;
  }, { mutation: method !== 'GET' });
}

export function listAnalyses(projectId, { status = 'active', limit = 50, cursor, signal } = {}) {
  const query = new URLSearchParams({ status, limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return request(`${projectPath(projectId)}?${query}`, { signal });
}

export const getAnalysis = (projectId, analysisId, { signal } = {}) =>
  request(`${projectPath(projectId)}/${encodeURIComponent(analysisId)}`, { signal });

export const createAnalysis = (projectId, body) => request(projectPath(projectId), { method: 'POST', body });

export const updateAnalysis = (projectId, analysisId, body) =>
  request(`${projectPath(projectId)}/${encodeURIComponent(analysisId)}`, { method: 'PATCH', body });

export function listReferenceOptions(projectId, { cursor, signal } = {}) {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  return request(`${projectPath(projectId)}/reference-options?${query}`, { signal });
}
export function listExistingWork(projectId, { kind = 'objects', cursor, signal } = {}) {
  const query = new URLSearchParams({ kind, limit: '30' });
  if (cursor) query.set('cursor', cursor);
  return request(`${projectPath(projectId)}/existing-work?${query}`, { signal });
}

const workflowSnapshotPath = (projectId, snapshotId) => `${projectPath(projectId)}/workflow-snapshots/${encodeURIComponent(snapshotId)}`;
export const getWorkflowSnapshot = (projectId, snapshotId, { sha256, signal } = {}) =>
  request(`${workflowSnapshotPath(projectId, snapshotId)}${sha256 ? `?sha256=${encodeURIComponent(sha256)}` : ''}`, { signal });
export const openWorkflowSnapshot = (projectId, snapshotId, body) =>
  request(`${workflowSnapshotPath(projectId, snapshotId)}/open`, { method: 'POST', body });
