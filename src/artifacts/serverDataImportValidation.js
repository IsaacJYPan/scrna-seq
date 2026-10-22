import { canonicalServerDataImportRequest, normalizeServerDataImportRequest, normalizeServerDataImportPath,
  SERVER_DATA_IMPORT_ROOT_ID } from '../../shared/serverDataImport.mjs';
import { validateArtifactVersion } from '../../shared/analysisModel.mjs';

const serviceId = /^svc_[a-f0-9]{32}$/;
const operationId = /^sdi_[a-f0-9]{24}$/;
const artifactId = /^af_[a-f0-9]{24}$/;
const versionId = /^av_[a-f0-9]{24}$/;
const previousId = /^(?:av|art|eri)_[a-f0-9]{16,40}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const maximumBytes = 64 * 1024 ** 3;
const commonFields = ['projectId', 'ownerUserId', 'serviceId', 'canImport'];
const itemFields = ['id', 'requestId', 'requestSha256', 'name', 'status', 'source', 'reservedBytes', 'bytesCopied',
  'createdAt', 'updatedAt', 'expiresAt', 'acceptanceState', 'acceptance', 'availability', 'error'];
const formats = { 'org.ietf.csv': 'table', 'org.iana.tsv': 'table', 'org.ietf.json': 'file', 'org.ietf.text': 'file',
  'org.w3.png': 'image', 'org.iso.jpeg': 'image', 'org.r-project.rds': 'object' };
const extensions = { csv: 'org.ietf.csv', tsv: 'org.iana.tsv', json: 'org.ietf.json', txt: 'org.ietf.text',
  png: 'org.w3.png', jpg: 'org.iso.jpeg', jpeg: 'org.iso.jpeg', rds: 'org.r-project.rds' };
const fail = () => { throw Object.assign(new Error('The original server import could not be confirmed. Keep its request and check again.'), { code: 'SERVER_DATA_RESPONSE_INVALID' }); };

function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  if (required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key !== 'string' || !required.includes(key) && !optional.includes(key)
      || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
  })) fail();
}
function array(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit
      || Reflect.ownKeys(value).length !== value.length + 1
      || Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index))
        .some(descriptor => !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) fail();
  return value;
}
function json(value, depth = 0) {
  if (depth > 24) fail();
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { array(value, 10000).forEach(item => json(item, depth + 1)); return; }
  if (!value || typeof value !== 'object') fail();
  const keys = Reflect.ownKeys(value); fields(value, keys);
  if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail();
  keys.forEach(key => json(value[key], depth + 1));
}
function snapshot(value) {
  json(value);
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > 256 * 1024) fail();
  return JSON.parse(encoded);
}
function same(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}
function line(value, maximum) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum
      || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail();
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
  return value;
}
function envelope(result, scope, extras) {
  fields(scope, ['projectId'], ['userId', 'serviceId', 'requestId']); fields(result, [...commonFields, ...extras]);
  if (typeof scope.projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{3,128}$/.test(scope.projectId)
      || result.projectId !== scope.projectId || !Number.isSafeInteger(result.ownerUserId) || result.ownerUserId < 1
      || typeof result.serviceId !== 'string' || !serviceId.test(result.serviceId) || typeof result.canImport !== 'boolean') fail();
  if (scope.userId !== undefined && (!['string', 'number'].includes(typeof scope.userId)
      || typeof scope.userId === 'string' && !/^[1-9]\d*$/.test(scope.userId)
      || !Number.isSafeInteger(Number(scope.userId)) || Number(scope.userId) < 1 || result.ownerUserId !== Number(scope.userId))) fail();
  if (scope.serviceId !== undefined && (typeof scope.serviceId !== 'string' || !serviceId.test(scope.serviceId) || result.serviceId !== scope.serviceId)) fail();
  if (scope.requestId !== undefined && (typeof scope.requestId !== 'string' || !uuid.test(scope.requestId))) fail();
}
function source(value, common) {
  fields(value, ['rootId', 'relativePath', 'name', 'serviceId', 'serviceLabel'], ['sampleMetadata']);
  if (typeof value.rootId !== 'string' || !SERVER_DATA_IMPORT_ROOT_ID.test(value.rootId)
      || value.serviceId !== common.serviceId || normalizeServerDataImportPath(value.relativePath) !== value.relativePath
      || value.name !== value.relativePath.split('/').at(-1)) fail();
  line(value.serviceLabel, 80);
  if (Object.hasOwn(value, 'sampleMetadata')) {
    const normalized = normalizeServerDataImportRequest({ requestId: '00000000-0000-4000-8000-000000000000', rootId: value.rootId,
      relativePath: value.relativePath, selectionToken: '0'.repeat(64), name: 'Source', sampleMetadata: value.sampleMetadata });
    if (!same(value.sampleMetadata, normalized.sampleMetadata)) fail();
  }
}
function acceptance(value, item) {
  fields(value, ['artifactId', 'versionId', 'versionNumber', 'previousVersionId', 'sha256', 'sizeBytes', 'createdAt']);
  if (typeof value.artifactId !== 'string' || !artifactId.test(value.artifactId) || typeof value.versionId !== 'string' || !versionId.test(value.versionId)
      || !Number.isSafeInteger(value.versionNumber) || value.versionNumber < 1
      || value.previousVersionId !== null && (typeof value.previousVersionId !== 'string' || !previousId.test(value.previousVersionId))
      || value.previousVersionId === value.versionId || (value.previousVersionId === null) !== (value.versionNumber === 1)
      || typeof value.sha256 !== 'string' || !hash.test(value.sha256) || value.sizeBytes !== item.reservedBytes
      || item.bytesCopied !== value.sizeBytes) fail();
  timestamp(value.createdAt);
}
function item(value, common, discovery) {
  if (typeof value.id !== 'string' || !operationId.test(value.id) || typeof value.requestId !== 'string' || !uuid.test(value.requestId)
      || typeof value.requestSha256 !== 'string' || !hash.test(value.requestSha256) || !['pending', 'succeeded', 'failed'].includes(value.status)
      || !Number.isSafeInteger(value.reservedBytes) || value.reservedBytes < 1 || value.reservedBytes > maximumBytes
      || !Number.isSafeInteger(value.bytesCopied) || value.bytesCopied < 0 || value.bytesCopied > value.reservedBytes) fail();
  line(value.name, 160); source(value.source, common);
  [value.createdAt, value.updatedAt, value.expiresAt].forEach(timestamp);
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt) || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) fail();
  if (value.status === 'succeeded') {
    if (!['recorded', 'legacy-unrecorded'].includes(value.acceptanceState) || value.error !== null) fail();
    if (value.acceptanceState === 'recorded') acceptance(value.acceptance, value);
    else if (value.acceptance !== null || value.bytesCopied !== value.reservedBytes) fail();
    if (discovery ? value.availability !== 'not-checked'
      : !['recorded', 'unavailable'].includes(value.availability) || value.acceptanceState === 'legacy-unrecorded' && value.availability !== 'unavailable') fail();
  } else {
    if (value.acceptanceState !== 'not-accepted' || value.acceptance !== null || value.availability !== 'not-recorded') fail();
    if (value.status === 'pending') { if (value.error !== null) fail(); }
    else {
      fields(value.error, ['code', 'message']); line(value.error.message, 1000);
      if (typeof value.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value.error.code)) fail();
    }
  }
}
function bindRequest(value, request) {
  if (value.requestId !== request.requestId || value.name !== request.name || value.source.rootId !== request.rootId
      || value.source.relativePath !== request.relativePath || !same(value.source.sampleMetadata, request.sampleMetadata)
      || value.acceptance !== null && value.acceptance.previousVersionId !== request.previousVersionId) fail();
}
function version(value, result, request) {
  fields(value, ['kind', 'schemaVersion', 'artifactId', 'versionId', 'projectId', 'ownerId', 'type', 'format', 'sha256', 'sizeBytes',
    'storageRef', 'sourceRunId', 'createdAt', 'previews', 'name', 'versionNumber', 'previousVersionId', 'owner', 'source', 'reference', 'previewBudget', 'canReplace'], ['sourceImport']);
  const recordFields = ['kind', 'schemaVersion', 'artifactId', 'versionId', 'projectId', 'ownerId', 'type', 'format', 'sha256', 'sizeBytes',
    'storageRef', 'sourceRunId', 'createdAt', 'previews'];
  validateArtifactVersion(Object.fromEntries(recordFields.map(key => [key, value[key]])));
  const accepted = result.acceptance;
  if (value.artifactId !== accepted.artifactId || value.versionId !== accepted.versionId || value.projectId !== result.projectId
      || value.ownerId !== String(result.ownerUserId) || value.name !== result.name || value.sha256 !== accepted.sha256 || value.sizeBytes !== accepted.sizeBytes
      || value.versionNumber !== accepted.versionNumber || value.previousVersionId !== accepted.previousVersionId
      || value.createdAt !== accepted.createdAt || value.storageRef !== accepted.versionId || value.sourceRunId !== null || value.canReplace !== true
      || !Object.hasOwn(formats, value.format.id) || value.format.version !== '1') fail();
  const format = extensions[result.source.name.split('.').at(-1).toLowerCase()];
  if (!format || value.format.id !== format || (request?.artifactType === 'sample-sheet'
    ? value.type !== 'sample-sheet' || !['org.ietf.csv', 'org.iana.tsv'].includes(format)
    : request ? value.type !== formats[format] : value.type !== formats[format] && !(value.type === 'sample-sheet' && ['org.ietf.csv', 'org.iana.tsv'].includes(format)))) fail();
  fields(value.owner, ['id', 'displayName']); line(value.owner.displayName, 200);
  fields(value.source, ['kind', 'id']); fields(value.reference, ['artifactId', 'versionId', 'projectId', 'sha256']);
  if (value.owner.id !== value.ownerId || value.source.kind !== 'managed-file' || value.source.id !== accepted.versionId
      || value.reference.artifactId !== accepted.artifactId || value.reference.versionId !== accepted.versionId
      || value.reference.projectId !== result.projectId || value.reference.sha256 !== accepted.sha256) fail();
  fields(value.previewBudget, ['responseBytes', 'imageBytes', 'maximumRows']);
  if (Object.values(value.previewBudget).some(number => !Number.isSafeInteger(number) || number < 1)
      || new Set(value.previews).size !== value.previews.length || value.previews.some(name => !['table', 'image', 'text', 'json'].includes(name))) fail();
  if (Object.hasOwn(value, 'sourceImport')) {
    const provenance = value.sourceImport;
    fields(provenance, ['importId', 'rootId', 'rootLabel', 'relativePath', 'serviceId', 'serviceLabel', 'sha256', 'importedAt'], ['sampleMetadata']);
    line(provenance.rootLabel, 80); timestamp(provenance.importedAt);
    if (provenance.importId !== result.id || provenance.rootId !== result.source.rootId || provenance.relativePath !== result.source.relativePath
        || provenance.serviceId !== result.serviceId || provenance.serviceLabel !== result.source.serviceLabel || provenance.sha256 !== accepted.sha256
        || !same(provenance.sampleMetadata, result.source.sampleMetadata)) fail();
  }
}

export function validateServerDataImportList(input, scope) {
  try {
    const result = snapshot(input); envelope(result, scope, ['items', 'nextCursor']);
    array(result.items, 30).forEach(value => { fields(value, itemFields); item(value, result, true); });
    if (new Set(result.items.map(value => value.id)).size !== result.items.length
        || new Set(result.items.map(value => value.requestId)).size !== result.items.length) fail();
    for (let index = 1; index < result.items.length; index++) {
      const previous = result.items[index - 1], current = result.items[index];
      if (previous.createdAt < current.createdAt || previous.createdAt === current.createdAt && previous.id < current.id) fail();
    }
    if (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 256
        || !/^[A-Za-z0-9_-]+$/.test(result.nextCursor)) || !result.items.length && result.nextCursor !== null) fail();
    return result;
  } catch { fail(); }
}

export async function validateServerDataImport(input, scope, expectedInput) {
  try {
    const result = snapshot(input);
    envelope(result, scope, [...itemFields, 'request', 'replayed', 'version', 'message'].filter(key => !commonFields.includes(key)));
    item(result, result, false);
    if (typeof result.replayed !== 'boolean' || scope.requestId !== undefined && result.requestId !== scope.requestId) fail();
    if (result.status === 'pending') line(result.message, 1000);
    else if (result.message !== null) fail();
    let request = result.request === null ? null : normalizeServerDataImportRequest(result.request);
    if (request && !same(result.request, request)) fail();
    const expected = expectedInput === undefined ? null : normalizeServerDataImportRequest(expectedInput);
    if (request && expected && canonicalServerDataImportRequest(request) !== canonicalServerDataImportRequest(expected)) fail();
    request = request || expected;
    if (request) {
      bindRequest(result, request);
      const canonical = canonicalServerDataImportRequest(request);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
      const checksum = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (result.requestSha256 !== checksum) fail();
    }
    if (result.availability === 'recorded') {
      if (result.status !== 'succeeded' || result.acceptanceState !== 'recorded') fail();
      version(result.version, result, request);
    } else if (result.version !== null) fail();
    return result;
  } catch { fail(); }
}
