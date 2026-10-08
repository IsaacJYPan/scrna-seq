import { apiUrl } from '../api';

const base = projectId => `/api/artifact-versions/${encodeURIComponent(projectId)}`;
async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(apiUrl(path), { credentials: 'include', ...options, headers: { 'X-Traceomics-Csrf': '1', ...(options.headers || {}) } });
  } catch (failure) {
    if (failure.name === 'AbortError') throw failure;
    throw new Error('The artifact service could not be reached. Please try again.');
  }
  let value;
  try { value = await response.json(); } catch {
    throw Object.assign(new Error('The artifact service returned an invalid response. Please try again.'), { status: response.status });
  }
  const message = typeof value?.error === 'string' && value.error.length <= 500 ? value.error : 'Artifact inspection failed.';
  if (!response.ok) throw Object.assign(new Error(message), { status: response.status, code: value?.code });
  return value;
}
export function listArtifactVersions(projectId, { signal, before, limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) });
  return request(`${base(projectId)}?${query}`, { signal });
}
export function getArtifactVersion(projectId, versionId, signal) {
  return request(`${base(projectId)}/${encodeURIComponent(versionId)}`, { signal });
}
export function previewArtifactVersion(projectId, versionId, { signal, offset = 0, limit = 25 } = {}) {
  return request(`${base(projectId)}/${encodeURIComponent(versionId)}/preview?${new URLSearchParams({ offset: String(offset), limit: String(limit) })}`, { signal });
}
export function artifactImageUrl(projectId, versionId) {
  return apiUrl(`${base(projectId)}/${encodeURIComponent(versionId)}/image`);
}
export function importArtifactVersion(projectId, { file, name, artifactType = 'auto', previousVersionId, signal }) {
  const body = new FormData(); body.append('file', file);
  if (name) body.append('name', name);
  body.append('artifactType', artifactType);
  return request(`${base(projectId)}${previousVersionId ? `/${encodeURIComponent(previousVersionId)}/versions` : ''}`, { method: 'POST', body, signal });
}
