import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';

const base = projectId => `/api/artifact-versions/${encodeURIComponent(projectId)}`;
const publicMessages = {
  ARTIFACT_IMPORT_NOT_FOUND: 'No accepted receipt is available yet. The original upload remains unconfirmed; keep its file and check again.',
  ARTIFACT_IMPORT_REQUEST_CONFLICT: 'This request identifies a different accepted import. Keep the original request and check its receipt.',
  ARTIFACT_IMPORT_SOURCE_CHANGED: 'The selected file changed while being copied. Keep the original request and check its outcome.',
  INVALID_ARTIFACT_IMPORT_REQUEST: 'Keep one original request when importing or recovering this exact file.',
  INVALID_ARTIFACT_NAME: 'Choose an artifact name of at most 160 characters on one line.',
  INVALID_ARTIFACT_TYPE: 'Choose automatic format detection or a CSV/TSV sample sheet.',
  INVALID_ARTIFACT_FILE: 'Choose a regular file within the supported import size and format limits.',
  INVALID_ARTIFACT_FORMAT: 'The file cannot be inspected within the supported format and preview limits.',
  ARTIFACT_PREVIEW_INVALID: 'The file cannot be inspected within the supported format and preview limits.',
  ARTIFACT_FORMAT_CHANGED: 'A replacement must keep the same artifact format. Import a separate artifact for a different format.',
  ARTIFACT_VERSION_READ_ONLY: 'This saved result cannot be replaced. Import a separate managed artifact.',
  ARTIFACT_VERSION_CHANGED: 'The selected immutable version no longer matches its saved reference. Refresh before continuing.',
  ARTIFACT_INTEGRITY_FAILED: 'The saved file is missing or its integrity check failed. Earlier versions remain available.',
  ARTIFACT_VERSION_NOT_FOUND: 'The requested artifact version is unavailable to this account.',
  PROJECT_ROLE_REQUIRED: 'Your current project role cannot perform this action.',
  FORBIDDEN: 'Your current project role cannot perform this action.',
  NOT_FOUND: 'The requested project or artifact is unavailable to this account.',
};
async function request(path, options = {}) {
  return withExecutionTarget(async () => {
  let response;
  try {
    response = await fetch(apiUrl(path), { credentials: 'include', ...options, headers: { 'X-Traceomics-Csrf': '1', ...(options.headers || {}) } });
  } catch (failure) {
    if (failure.name === 'AbortError') throw failure;
    throw Object.assign(new Error('The artifact service could not be reached. Please try again.'), { code: 'ARTIFACT_SERVICE_UNREACHABLE' });
  }
  let value;
  try { value = await response.json(); } catch {
    throw Object.assign(new Error('The artifact service returned an invalid response. Please try again.'), { status: response.status, code: 'INVALID_ARTIFACT_SERVICE_RESPONSE' });
  }
  const message = publicMessages[value?.code] || (response.status === 401 ? 'Sign in again to access this project.' : 'The artifact request could not be confirmed. Please review it and try again.');
  if (!response.ok) throw Object.assign(new Error(message), { status: response.status, code: value?.code });
  return value;
  }, { mutation: Boolean(options.method && options.method !== 'GET') });
}
export function listArtifactVersions(projectId, { signal, before, limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) });
  return request(`${base(projectId)}?${query}`, { signal });
}
export function getArtifactVersion(projectId, versionId, signal) {
  return request(`${base(projectId)}/${encodeURIComponent(versionId)}`, { signal });
}
export function previewArtifactVersion(projectId, versionId, { signal, offset = 0, limit = 25, pointLimit } = {}) {
  return request(`${base(projectId)}/${encodeURIComponent(versionId)}/preview?${new URLSearchParams({ offset: String(offset), limit: String(limit), ...(pointLimit === undefined ? {} : { pointLimit: String(pointLimit) }) })}`, { signal });
}
export function artifactImageUrl(projectId, versionId) {
  return apiUrl(`${base(projectId)}/${encodeURIComponent(versionId)}/image`);
}
export function getArtifactImportReceipt(projectId, requestId, { signal } = {}) {
  return request(`${base(projectId)}/imports/${encodeURIComponent(requestId)}`, { signal });
}
export function importArtifactVersion(projectId, { file, name, artifactType = 'auto', previousVersionId, requestId, expectedRequestSha256, signal }) {
  const body = new FormData(); body.append('file', file);
  if (name) body.append('name', name);
  body.append('artifactType', artifactType);
  if (requestId !== undefined) body.append('requestId', requestId);
  if (expectedRequestSha256 !== undefined) body.append('expectedRequestSha256', expectedRequestSha256);
  return request(`${base(projectId)}${previousVersionId ? `/${encodeURIComponent(previousVersionId)}/versions` : ''}`, { method: 'POST', body, signal });
}
