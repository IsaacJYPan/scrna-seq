import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';
import { validateServerDataImport, validateServerDataImportList } from './serverDataImportValidation';

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

export function importServerData(projectId, input, signal, scope = {}) {
  return request(`${base(projectId)}/imports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal }).then(async value => {
    try { return await validateServerDataImport(value, { ...scope, projectId, requestId: input.requestId }, input); }
    catch { throw Object.assign(new Error('The saved import receipt could not be confirmed. Check this import request before submitting another import.'), { code: 'SERVER_DATA_IMPORT_UNCONFIRMED' }); }
  });
}

export function getServerDataImport(projectId, requestId, signal, scope = {}) {
  return request(`${base(projectId)}/imports/${encodeURIComponent(requestId)}`, { signal }).then(value => validateServerDataImport(value, { ...scope, projectId, requestId }));
}

export function listServerDataImports(projectId, { cursor, limit = 30, signal, userId, serviceId } = {}) {
  const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
  return request(`${base(projectId)}/imports?${query}`, { signal }).then(value => validateServerDataImportList(value, { projectId, userId, serviceId }));
}
