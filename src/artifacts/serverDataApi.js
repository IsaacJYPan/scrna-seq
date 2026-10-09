import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';

const base = projectId => `/api/server-data/${encodeURIComponent(projectId)}`;

async function request(path, options = {}) {
  const mutation = options.method === 'POST';
  return withExecutionTarget(async () => {
    let response;
    try {
      response = await fetch(apiUrl(path), { credentials: 'include', ...options, headers: { 'X-Traceomics-Csrf': '1', ...(options.headers || {}) } });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw Object.assign(new Error(mutation
        ? 'Import completion could not be confirmed. Check this import request after reconnecting before submitting another import.'
        : 'Server data could not be reached. Reconnect and try the request again.'), { code: mutation ? 'SERVER_DATA_IMPORT_UNCONFIRMED' : 'SERVER_DATA_UNAVAILABLE' });
    }
    let value;
    try { value = await response.json(); }
    catch {
      throw Object.assign(new Error(mutation
        ? 'Import completion could not be confirmed from the server response. Check this import request before submitting another import.'
        : 'The server data response could not be read.'), { status: response.status, code: mutation ? 'SERVER_DATA_IMPORT_UNCONFIRMED' : 'SERVER_DATA_RESPONSE_INVALID' });
    }
    if (!response.ok) {
      const message = typeof value?.error === 'string' && value.error.length <= 500 ? value.error : 'Server data import is unavailable.';
      throw Object.assign(new Error(message), { status: response.status, code: mutation && response.status >= 500 ? 'SERVER_DATA_IMPORT_UNCONFIRMED' : value?.code });
    }
    return value;
  }, { mutation });
}

export function listServerDataRoots(projectId, signal) {
  return request(`${base(projectId)}/roots`, { signal });
}

export function listServerDataFiles(projectId, rootId, { path = '', cursor, limit = 50, signal } = {}) {
  const query = new URLSearchParams({ path, limit: String(limit), ...(cursor ? { cursor } : {}) });
  return request(`${base(projectId)}/roots/${encodeURIComponent(rootId)}/files?${query}`, { signal });
}

export function importServerData(projectId, input, signal) {
  return request(`${base(projectId)}/imports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal }).then(value => validateReceipt(value, input.requestId, projectId, true));
}

export function getServerDataImport(projectId, requestId, signal) {
  return request(`${base(projectId)}/imports/${encodeURIComponent(requestId)}`, { signal }).then(value => validateReceipt(value, requestId, projectId));
}

function validateReceipt(value, requestId, projectId, mutation = false) {
  const valid = value && value.requestId === requestId && ['pending', 'succeeded', 'failed'].includes(value.status)
    && (value.status !== 'succeeded' || value.version?.projectId === String(projectId) && typeof value.version.versionId === 'string' && /^[a-f0-9]{64}$/.test(value.version.sha256));
  if (!valid) throw Object.assign(new Error('The saved import receipt could not be confirmed. Check this import request before submitting another import.'), { code: mutation ? 'SERVER_DATA_IMPORT_UNCONFIRMED' : 'SERVER_DATA_RESPONSE_INVALID' });
  return value;
}
