import { createSnapshotTransport } from './snapshotTransport';
import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as policy } from '../../shared/analysisSnapshotPreparation.mjs';

const base = (projectId, analysisId) => `/api/projects/${encodeURIComponent(projectId)}/analyses/${encodeURIComponent(analysisId)}/snapshot-preparations`;
const path = (projectId, analysisId, preparationId) => `${base(projectId, analysisId)}/${encodeURIComponent(preparationId)}`;
const { request, retainedBytes } = createSnapshotTransport({ invalidCode: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE', unreachableCode: 'SNAPSHOT_PREPARATION_UNREACHABLE' });
const limits = { list: policy.listBytes, table: policy.tableBytes, image: policy.imageBytes, document: policy.documentBytes };
const invalid = () => Object.assign(new Error('The snapshot response could not be verified.'), { code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' });
function page(cursor, kind) {
  return new URLSearchParams({ limit: '30', ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}) });
}
export const listSnapshotPreparations = (projectId, analysisId, { cursor, signal } = {}) => request(`${base(projectId, analysisId)}?${page(cursor)}`, { signal }, limits.list);
export const listSnapshotPreparationOptions = (projectId, analysisId, kind, { cursor, signal, analysisVersion, snapshotReference } = {}) => {
  const query = page(cursor, kind);
  if (analysisVersion !== undefined) query.set('analysisVersion', String(analysisVersion));
  if (snapshotReference !== undefined) { query.set('snapshotId', snapshotReference.snapshotId); query.set('snapshotSha256', snapshotReference.sha256); }
  return request(`${base(projectId, analysisId)}/options?${query}`, { signal }, limits.list);
};
export const getSnapshotPreparation = (projectId, analysisId, preparationId, { signal } = {}) => request(path(projectId, analysisId, preparationId), { signal });
export const getSnapshotPreparationRequest = (projectId, analysisId, requestId, { signal } = {}) => request(`${base(projectId, analysisId)}/requests/${encodeURIComponent(requestId)}`, { signal });
export const createSnapshotPreparation = (projectId, analysisId, body, { signal } = {}) => request(base(projectId, analysisId), { method: 'POST', body, signal });
export const resumeSnapshotPreparation = (projectId, analysisId, preparationId, body, { signal } = {}) => request(`${path(projectId, analysisId, preparationId)}/resume`, { method: 'POST', body, signal });
export const deleteSnapshotPreparation = (projectId, analysisId, preparationId, body, { signal } = {}) => request(path(projectId, analysisId, preparationId), { method: 'DELETE', body, signal });

// Call only with a descriptor from an independently validated ready package.
// Scope/generation checks in the caller must precede parsing or making Blob URLs.
export function readSnapshotPreparationView(projectId, analysisId, preparationId, result, { signal } = {}) {
  const json = result?.view?.family === 'table' || result?.view?.family === 'metrics' && result?.view?.schema === 'traceomics.fixed-result-view.v3';
  const type = json ? 'application/json' : { 'org.w3.png': 'image/png', 'org.iso.jpeg': 'image/jpeg' }[result?.source?.format?.id];
  if (!type || !json && result?.view?.family !== 'image') return Promise.reject(invalid());
  return retainedBytes(`${path(projectId, analysisId, preparationId)}/views/${encodeURIComponent(result.viewId)}`, result.view, type, json ? limits.table : limits.image, signal);
}
export function readSnapshotPreparationDocument(projectId, analysisId, preparationId, document, { signal } = {}) {
  return retainedBytes(`${path(projectId, analysisId, preparationId)}/documents/${encodeURIComponent(document?.viewId)}`, document, 'application/json', limits.document, signal);
}
