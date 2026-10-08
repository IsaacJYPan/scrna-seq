import { apiUrl } from '../api';

async function request(path, signal) {
  let response;
  try { response = await fetch(apiUrl(path), { credentials: 'include', signal }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('Execution history could not be reached. Please try again.'); }
  let value;
  try { value = await response.json(); } catch { throw new Error('Execution history returned an invalid response. Please try again.'); }
  if (!response.ok) throw Object.assign(new Error(typeof value?.error === 'string' && value.error.length <= 500 ? value.error : 'Execution history is unavailable.'), { status: response.status, code: value?.code });
  return value;
}
const base = projectId => `/api/execution-history/${encodeURIComponent(projectId)}`;
export function listExecutionHistory(projectId, { before, kind = 'all', limit = 25, signal } = {}) {
  return request(`${base(projectId)}?${new URLSearchParams({ kind, limit: String(limit), ...(before ? { before } : {}) })}`, signal);
}
export function getExecutionHistory(projectId, recordId, signal) { return request(`${base(projectId)}/${encodeURIComponent(recordId)}`, signal); }
export function getExecutionEnvironment(projectId, recordId, signal) { return request(`${base(projectId)}/${encodeURIComponent(recordId)}/environment`, signal); }
