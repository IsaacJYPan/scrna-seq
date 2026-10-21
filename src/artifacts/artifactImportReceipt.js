import { ARTIFACT_IMPORT_SCHEMA as schema, ARTIFACT_UPLOAD_LIMITS, normalizeArtifactImportRequest,
  canonicalArtifactImportRequest, invalidArtifactImportResponse } from '../../shared/artifactImport.mjs';
export { ARTIFACT_UPLOAD_LIMITS, normalizeArtifactImportRequest, canonicalArtifactImportRequest, invalidArtifactImportResponse } from '../../shared/artifactImport.mjs';
const managedVersion = /^av_[a-f0-9]{24}$/;
const artifactId = /^af_[a-f0-9]{24}$/;
const invalidInput = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARTIFACT_IMPORT_INPUT' }); };
export async function artifactImportRequestSha256(value) {
  const bytes = new TextEncoder().encode(canonicalArtifactImportRequest(value));
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const readBytes = file => typeof file.arrayBuffer === 'function' ? file.arrayBuffer() : new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('The selected file could not be read.'));
  reader.onabort = () => reject(new Error('The selected file read was canceled.'));
  reader.readAsArrayBuffer(file);
});

export async function prepareArtifactImportRequest({ file, name, artifactType = 'auto', previousVersionId = null, projectId, ownerUserId, requestId }) {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) invalidInput('Choose a regular file to import.');
  const filename = file.name.replace(/\\/g, '/').split('/').pop().trim();
  const maximum = /\.rds$/i.test(filename) ? ARTIFACT_UPLOAD_LIMITS.fileBytes : ARTIFACT_UPLOAD_LIMITS.otherFileBytes;
  if (file.size > maximum) invalidInput(`Choose a file within the ${maximum / (1024 * 1024)} MiB import limit.`);
  const request = { schema, projectId, ownerUserId: Number(ownerUserId), requestId, originalFilename: filename,
    name: (name || filename).trim(), artifactType, previousVersionId: previousVersionId || null, sha256: '0'.repeat(64), sizeBytes: file.size };
  try { normalizeArtifactImportRequest(request); } catch { invalidInput('Choose a file and a name of at most 160 characters, with a valid current project and account.'); }
  let bytes;
  try { bytes = new Uint8Array(await readBytes(file)); } catch { invalidInput('The selected file could not be read. Choose it again before starting an upload.'); }
  if (bytes.byteLength !== file.size || bytes.byteLength > maximum) invalidInput('The selected file size changed while it was read. Choose the file again.');
  try { request.sha256 = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
  catch { invalidInput('The selected file checksum could not be prepared. Keep the file and try again.'); }
  return normalizeArtifactImportRequest(request);
}

/** A receipt confirms acceptance, not current byte integrity or a scientific run. */
export async function validateArtifactImportReceipt(input, expected, { post = false } = {}) {
  const fail = () => { throw invalidArtifactImportResponse(); };
  const wanted = normalizeArtifactImportRequest(expected);
  const receipt = post ? input?.importRequest : input;
  const version = post ? input?.version === null ? null : input : input?.version;
  const accepted = receipt?.acceptance;
  let sameRequest = false;
  try { sameRequest = canonicalArtifactImportRequest(receipt?.request) === canonicalArtifactImportRequest(wanted); } catch { fail(); }
  if (!sameRequest || receipt.requestId !== wanted.requestId || receipt.status !== 'succeeded'
      || typeof receipt.canImport !== 'boolean' || receipt.requestSha256 !== await artifactImportRequestSha256(wanted)
      || post && typeof receipt.replayed !== 'boolean' || !['recorded', 'unavailable'].includes(receipt.availability)
      || !accepted || typeof accepted.artifactId !== 'string' || !artifactId.test(accepted.artifactId)
      || typeof accepted.versionId !== 'string' || !managedVersion.test(accepted.versionId)
      || !Number.isSafeInteger(accepted.versionNumber) || accepted.versionNumber < 1
      || accepted.previousVersionId !== wanted.previousVersionId || accepted.sha256 !== wanted.sha256 || accepted.sizeBytes !== wanted.sizeBytes
      || typeof accepted.createdAt !== 'string' || !Number.isFinite(Date.parse(accepted.createdAt))) fail();
  if (receipt.availability === 'unavailable') { if (version !== null) fail(); }
  else if (!version || version.versionId !== accepted.versionId || version.artifactId !== accepted.artifactId
      || version.projectId !== wanted.projectId || version.ownerId !== String(wanted.ownerUserId)
      || version.sha256 !== wanted.sha256 || version.sizeBytes !== wanted.sizeBytes || version.name !== wanted.name
      || version.versionNumber !== accepted.versionNumber || (version.previousVersionId ?? null) !== wanted.previousVersionId
      || wanted.artifactType === 'sample-sheet' && version.type !== 'sample-sheet'
      || version.reference?.versionId !== accepted.versionId || version.reference?.artifactId !== accepted.artifactId
      || version.reference?.projectId !== wanted.projectId || version.reference?.sha256 !== wanted.sha256) fail();
  return { requestId: receipt.requestId, request: wanted, status: receipt.status, requestSha256: receipt.requestSha256,
    acceptance: accepted, availability: receipt.availability, version, canImport: receipt.canImport,
    ...(post ? { replayed: receipt.replayed } : {}) };
}
