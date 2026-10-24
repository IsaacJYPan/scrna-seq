import { createSnapshotTransport } from './snapshotTransport';
import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as limits } from '../../shared/analysisSnapshotPreparation.mjs';

const base = (projectId, analysisId) => `/api/projects/${encodeURIComponent(projectId)}/analyses/${encodeURIComponent(analysisId)}/snapshot-publications`;
const path = (projectId, analysisId, publicationId) => `${base(projectId, analysisId)}/${encodeURIComponent(publicationId)}`;
const { request, retainedBytes } = createSnapshotTransport({ invalidCode: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE', unreachableCode: 'SNAPSHOT_PUBLICATION_UNREACHABLE',
  // This bounded summary remains untrusted until the publication validator
  // binds it to the acknowledged private preparation and exact package SHA.
  errorProperties: (body, code) => code === 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED' && body && Object.keys(body).length === 3
    && ['error', 'code', 'publication'].every(key => Object.hasOwn(body, key)) ? { publication: body.publication } : {},
});
const page = cursor => new URLSearchParams({ limit: '30', ...(cursor ? { cursor } : {}) });
export const listSnapshotPublications = (projectId, analysisId, { cursor, signal } = {}) => request(`${base(projectId, analysisId)}?${page(cursor)}`, { signal }, limits.listBytes);
export const listSnapshotPublicationRequests = (projectId, analysisId, { cursor, signal } = {}) => request(`${base(projectId, analysisId)}/requests?${page(cursor)}`, { signal }, limits.listBytes);
export const getSnapshotPublication = (projectId, analysisId, publicationId, { signal } = {}) => request(path(projectId, analysisId, publicationId), { signal });
export const getSnapshotPublicationRequest = (projectId, analysisId, requestId, { signal } = {}) => request(`${base(projectId, analysisId)}/requests/${encodeURIComponent(requestId)}`, { signal });
export const publishAnalysisSnapshot = (projectId, analysisId, body, { signal } = {}) => request(base(projectId, analysisId), { method: 'POST', body, signal });
export const withdrawAnalysisSnapshot = (projectId, analysisId, publicationId, body, { signal } = {}) => request(`${path(projectId, analysisId, publicationId)}/withdrawals`, { method: 'POST', body, signal });

export function readSnapshotPublicationView(projectId, analysisId, publicationId, result, { signal } = {}) {
  const json = result?.view?.family === 'table' || ['metrics', 'embedding'].includes(result?.view?.family) && result?.view?.schema === 'traceomics.fixed-result-view.v3'
    || result?.view?.family === 'text' && result?.view?.schema === 'traceomics.fixed-result-view.v4';
  const type = json ? 'application/json' : { 'org.w3.png': 'image/png', 'org.iso.jpeg': 'image/jpeg' }[result?.source?.format?.id];
  if (!type || !json && result?.view?.family !== 'image') return Promise.reject(Object.assign(new Error('The retained publication view could not be verified.'), { code: 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE' }));
  return retainedBytes(`${path(projectId, analysisId, publicationId)}/views/${encodeURIComponent(result.viewId)}`, result.view, type, json ? limits.tableBytes : limits.imageBytes, signal);
}
export function readSnapshotPublicationDocument(projectId, analysisId, publicationId, document, { signal } = {}) {
  return retainedBytes(`${path(projectId, analysisId, publicationId)}/documents/${encodeURIComponent(document?.viewId)}`, document, 'application/json', limits.documentBytes, signal);
}
