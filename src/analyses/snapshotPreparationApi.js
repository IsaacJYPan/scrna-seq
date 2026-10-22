import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';
import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS } from '../../shared/analysisSnapshotPreparation.mjs';

const base = (projectId, analysisId) => `/api/projects/${encodeURIComponent(projectId)}/analyses/${encodeURIComponent(analysisId)}/snapshot-preparations`;
const path = (projectId, analysisId, preparationId) => `${base(projectId, analysisId)}/${encodeURIComponent(preparationId)}`;
const policy = ANALYSIS_SNAPSHOT_PREPARATION_LIMITS;
const limits = { full: policy.fullBytes, list: policy.listBytes, error: 16 * 1024, table: policy.tableBytes, image: policy.imageBytes, document: policy.documentBytes };
const invalid = message => Object.assign(new Error(message || 'The snapshot response could not be verified.'), { code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' });
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');

async function boundedBytes(response, maximum) {
  const length = response.headers?.get('Content-Length');
  if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel(); throw invalid('The snapshot response exceeds its supported limit.');
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) throw invalid('The snapshot response exceeds its supported limit.');
    return bytes;
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw invalid('The snapshot response exceeds its supported limit.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { reader.releaseLock(); }
}
function json(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid('The snapshot service returned an unreadable response.'); }
}
async function checkedResponse(endpoint, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(apiUrl(endpoint), { method, credentials: 'include', signal,
      headers: { 'X-Traceomics-Csrf': '1', Accept: 'application/json, image/png, image/jpeg', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw Object.assign(new Error('The workspace could not be reached. Keep the original snapshot request and check its outcome.'), { code: 'SNAPSHOT_PREPARATION_UNREACHABLE' });
  }
  if (!response.ok) {
    let result; try { result = json(await boundedBytes(response, limits.error)); } catch { /* Keep safe status even for an unreadable error. */ }
    const code = typeof result?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.code) ? result.code : undefined;
    throw Object.assign(new Error(response.status === 401 ? 'Sign in again to open this workspace.'
      : 'This snapshot request could not be confirmed. Check its original outcome before continuing.'), { status: response.status, code });
  }
  return response;
}
function request(endpoint, options = {}, maximum = limits.full) {
  return withExecutionTarget(async () => {
    const response = await checkedResponse(endpoint, options);
    if ((response.headers?.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel(); throw invalid();
    }
    return json(await boundedBytes(response, maximum));
  }, { mutation: !!options.method && options.method !== 'GET' });
}
function page(cursor, kind) {
  return new URLSearchParams({ limit: '30', ...(kind ? { kind } : {}), ...(cursor ? { cursor } : {}) });
}
export const listSnapshotPreparations = (projectId, analysisId, { cursor, signal } = {}) => request(`${base(projectId, analysisId)}?${page(cursor)}`, { signal }, limits.list);
export const listSnapshotPreparationOptions = (projectId, analysisId, kind, { cursor, signal } = {}) => request(`${base(projectId, analysisId)}/options?${page(cursor, kind)}`, { signal }, limits.list);
export const getSnapshotPreparation = (projectId, analysisId, preparationId, { signal } = {}) => request(path(projectId, analysisId, preparationId), { signal });
export const getSnapshotPreparationRequest = (projectId, analysisId, requestId, { signal } = {}) => request(`${base(projectId, analysisId)}/requests/${encodeURIComponent(requestId)}`, { signal });
export const createSnapshotPreparation = (projectId, analysisId, body, { signal } = {}) => request(base(projectId, analysisId), { method: 'POST', body, signal });
export const resumeSnapshotPreparation = (projectId, analysisId, preparationId, body, { signal } = {}) => request(`${path(projectId, analysisId, preparationId)}/resume`, { method: 'POST', body, signal });
export const deleteSnapshotPreparation = (projectId, analysisId, preparationId, body, { signal } = {}) => request(path(projectId, analysisId, preparationId), { method: 'DELETE', body, signal });

async function retainedBytes(endpoint, expected, type, maximum, signal) {
  if (!expected || !Number.isSafeInteger(expected.blobBytes) || expected.blobBytes < 1 || expected.blobBytes > maximum
      || typeof expected.blobSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.blobSha256) || !globalThis.crypto?.subtle) throw invalid();
  return withExecutionTarget(async () => {
    const response = await checkedResponse(endpoint, { signal });
    if ((response.headers?.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== type) { await response.body?.cancel(); throw invalid(); }
    const bytes = await boundedBytes(response, expected.blobBytes);
    if (bytes.byteLength !== expected.blobBytes || await digest(bytes) !== expected.blobSha256) throw invalid('The retained snapshot file does not match its saved checksum and size.');
    return { bytes, type };
  }, { mutation: false });
}
// Call only with a descriptor from an independently validated ready package.
// Scope/generation checks in the caller must precede parsing or making Blob URLs.
export function readSnapshotPreparationView(projectId, analysisId, preparationId, result, { signal } = {}) {
  const table = result?.view?.family === 'table';
  const type = table ? 'application/json' : { 'org.w3.png': 'image/png', 'org.iso.jpeg': 'image/jpeg' }[result?.source?.format?.id];
  if (!type || !table && result?.view?.family !== 'image') return Promise.reject(invalid());
  return retainedBytes(`${path(projectId, analysisId, preparationId)}/views/${encodeURIComponent(result.viewId)}`, result.view, type, table ? limits.table : limits.image, signal);
}
export function readSnapshotPreparationDocument(projectId, analysisId, preparationId, document, { signal } = {}) {
  return retainedBytes(`${path(projectId, analysisId, preparationId)}/documents/${encodeURIComponent(document?.viewId)}`, document, 'application/json', limits.document, signal);
}
