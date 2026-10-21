export const ARTIFACT_IMPORT_SCHEMA = 'traceomics.artifact-import.v1';
export const ARTIFACT_UPLOAD_LIMITS = Object.freeze({ fileBytes: 200 * 1024 * 1024, otherFileBytes: 25 * 1024 * 1024 });
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const managedVersion = /^av_[a-f0-9]{24}$/;
const fields = ['schema', 'projectId', 'ownerUserId', 'requestId', 'originalFilename', 'name', 'artifactType', 'previousVersionId', 'sha256', 'sizeBytes'];
export const invalidArtifactImportResponse = () => Object.assign(new Error('The original import could not be confirmed. Keep its file and check the same request again.'), { code: 'INVALID_ARTIFACT_IMPORT_RESPONSE' });
const controls = value => /\p{Cc}/u.test(value);
const nameValue = value => typeof value === 'string' && value.trim() && value.length <= 160 && value.isWellFormed() && !controls(value);

// Keep the original v1 field order and validation. Accepted import hashes include
// the UUID, owner and project, and must survive later contract extraction.
export function normalizeArtifactImportRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== fields.length
      || fields.some(field => !Object.getOwnPropertyDescriptor(value, field)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, field), 'value'))
      || value.schema !== ARTIFACT_IMPORT_SCHEMA || typeof value.projectId !== 'string' || !value.projectId || value.projectId.length > 128 || controls(value.projectId)
      || !Number.isSafeInteger(value.ownerUserId) || value.ownerUserId < 1 || typeof value.requestId !== 'string' || !uuid.test(value.requestId)
      || !nameValue(value.originalFilename) || /[/\\]/.test(value.originalFilename) || value.originalFilename !== value.originalFilename.trim()
      || !nameValue(value.name) || value.name !== value.name.trim() || !['auto', 'sample-sheet'].includes(value.artifactType)
      || value.previousVersionId !== null && (typeof value.previousVersionId !== 'string' || !managedVersion.test(value.previousVersionId))
      || typeof value.sha256 !== 'string' || !hash.test(value.sha256) || !Number.isSafeInteger(value.sizeBytes)
      || value.sizeBytes < 0 || value.sizeBytes > ARTIFACT_UPLOAD_LIMITS.fileBytes) throw invalidArtifactImportResponse();
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}
export const canonicalArtifactImportRequest = value => JSON.stringify(normalizeArtifactImportRequest(value));
