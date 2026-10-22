import { normalizeAnalysisAttachmentCreate } from './analysisAttachment.mjs';

export const ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA = 'traceomics.analysis-snapshot-preparation.v1';
export const ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA = 'traceomics.analysis-snapshot-package.v1';
export const FIXED_RESULT_VIEW_SCHEMA = 'traceomics.fixed-result-view.v1';
export const FIXED_DOCUMENT_SOURCE_SCHEMA = 'traceomics.fixed-document-source.v1';
export const ANALYSIS_SNAPSHOT_PREPARATION_ID = /^asp_[a-f0-9]{24}$/;
export const ANALYSIS_SNAPSHOT_VIEW_ID = /^asv_[a-f0-9]{24}$/;
export const ANALYSIS_SNAPSHOT_PREPARATION_LIMITS = Object.freeze({
  results: 8, documents: 2, prerequisites: 20, notes: 2000,
  prerequisiteLabel: 160, prerequisiteDetail: 1000,
  originalBytes: 200 * 1024 * 1024, retainedBytes: 16 * 1024 * 1024,
  documentBytes: 1024 * 1024, documentTotalBytes: 2 * 1024 * 1024,
  tableBytes: 256 * 1024, tableRows: 100, tableColumns: 100,
  tableOffset: 10000, tableCellCharacters: 2000, tableScanBytes: 2 * 1024 * 1024,
  imageBytes: 5 * 1024 * 1024, imagePixels: 12000000,
  requestBytes: 64 * 1024, packageBytes: 256 * 1024,
  fullBytes: 384 * 1024, listBytes: 128 * 1024,
  page: 30, cursor: 256, live: 10, requests: 2000,
  ownerBytes: 128 * 1024 * 1024, projectBytes: 512 * 1024 * 1024,
  depth: 24, nodes: 100000,
});

const L = ANALYSIS_SNAPSHOT_PREPARATION_LIMITS;
const encoder = new TextEncoder();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const PROJECT = /^proj_[a-f0-9]{16,40}$/;
const ANALYSIS = /^ra_[a-f0-9]{24}$/;
const SERVICE = /^svc_[a-f0-9]{32}$/;
const VERSION = /^av_[a-f0-9]{24}$/;
const ARTIFACT = /^af_[a-f0-9]{24}$/;
const ATTACHMENT = /^raa_[a-f0-9]{24}$/;
const REVISION = /^rar_[a-f0-9]{24}$/;
const DOCUMENT = /^doc_[a-f0-9]{24}$/;
const DOCUMENT_VERSION = /^dv_[a-f0-9]{24}$/;
const requestKeys = ['requestId', 'serviceId', 'projectId', 'analysisId', 'ownerUserId', 'analysisVersion', 'results', 'documents', 'notes', 'prerequisites'];
const reserved = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(message, large = false) {
  throw Object.assign(new Error(message), {
    code: large ? 'ANALYSIS_SNAPSHOT_PREPARATION_TOO_LARGE' : 'INVALID_ANALYSIS_SNAPSHOT_PREPARATION',
    status: large ? 413 : 400,
  });
}
function fields(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must use plain fields.`);
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))
      || keys.some(key => !Object.hasOwn(descriptors, key))) invalid(`${label} must use only its documented fields.`);
  return value;
}
function array(value, maximum, label, minimum = 0) {
  if (!Array.isArray(value) || ![Array.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be an ordinary array.`);
  const descriptors = Object.getOwnPropertyDescriptors(value), length = descriptors.length.value;
  if (length < minimum || length > maximum || Reflect.ownKeys(descriptors).length !== length + 1) invalid(`${label} exceeds its item bound or has unsupported properties.`);
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(`${label} must not contain holes or getters.`);
    return descriptor.value;
  });
}
function pattern(value, expression, label) {
  if (typeof value !== 'string' || !expression.test(value)) invalid(`${label} is invalid.`);
  return value;
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} is outside its supported bound.`);
  return value;
}
function identity(input) {
  pattern(input.serviceId, SERVICE, 'Workspace service');
  pattern(input.projectId, PROJECT, 'Project');
  pattern(input.analysisId, ANALYSIS, 'Analysis');
  integer(input.ownerUserId, 1, Number.MAX_SAFE_INTEGER, 'Owner');
}
function text(value, maximum, label, nullable = false, multiline = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed()) invalid(`${label} must be valid plain text.`);
  const lineNormalized = value.replace(/\r\n?/g, '\n');
  if (/[\p{Cc}\p{Cf}]/u.test(multiline ? lineNormalized.replace(/[\t\n]/g, '') : lineNormalized)) invalid(`${label} contains hidden controls.`);
  const normalized = lineNormalized.trim();
  if (nullable && !normalized) return null;
  if (!normalized || normalized.length > maximum) invalid(`${label} exceeds its text bound.`);
  return normalized;
}
function reference(value) {
  fields(value, ['kind', 'versionId', 'sha256'], 'Result reference');
  if (value.kind !== 'artifact-version') invalid('Select an exact managed artifact version.');
  return { kind: 'artifact-version', versionId: pattern(value.versionId, VERSION, 'Result version'), sha256: pattern(value.sha256, SHA, 'Source checksum') };
}
function selectionView(value) {
  // Inspect descriptors before reading the discriminator.
  if (!value || typeof value !== 'object') invalid('Select a fixed result view.');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'family');
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('Select a plain fixed result view.');
  if (descriptor.value === 'image') { fields(value, ['family'], 'Image selection'); return { family: 'image' }; }
  fields(value, ['family', 'offset', 'limit'], 'Table selection');
  if (value.family !== 'table') invalid('Only fixed table or image views are supported.');
  return { family: 'table', offset: integer(value.offset, 0, L.tableOffset, 'Table offset'), limit: integer(value.limit, 1, L.tableRows, 'Table rows') };
}
function notes(value) {
  fields(value, ['summary', 'decisions', 'limitations'], 'Supplied notes');
  return Object.fromEntries(['summary', 'decisions', 'limitations'].map(key => [key, text(value[key], L.notes, 'Supplied note', true)]));
}
function prerequisites(value) {
  return array(value, L.prerequisites, 'Prerequisites').map(item => {
    fields(item, ['kind', 'label', 'detail'], 'Declared prerequisite');
    if (!['data', 'environment', 'compute', 'other'].includes(item.kind)) invalid('Use a supported declared prerequisite kind.');
    return { kind: item.kind, label: text(item.label, L.prerequisiteLabel, 'Prerequisite label', false, false), detail: text(item.detail, L.prerequisiteDetail, 'Prerequisite detail', true) };
  });
}
function unique(items, key, label) {
  if (new Set(items.map(key)).size !== items.length) invalid(`${label} contains duplicate selections.`);
}
function byteBound(value, maximum, label) {
  if (encoder.encode(value).byteLength > maximum) invalid(`${label} exceeds its byte bound.`, true);
  return value;
}

export function normalizeAnalysisSnapshotPreparation(input) {
  fields(input, requestKeys, 'Preparation request'); identity(input);
  const results = array(input.results, L.results, 'Results', 1).map(item => {
    fields(item, ['attachmentId', 'revisionId', 'reference', 'view'], 'Selected result');
    return { attachmentId: pattern(item.attachmentId, ATTACHMENT, 'Attachment'), revisionId: pattern(item.revisionId, REVISION, 'Attachment revision'), reference: reference(item.reference), view: selectionView(item.view) };
  });
  unique(results, item => JSON.stringify(item), 'Results');
  const documents = array(input.documents, L.documents, 'Supporting source').map(item => {
    fields(item, ['documentId', 'versionId', 'sha256'], 'Supporting source');
    return { documentId: pattern(item.documentId, DOCUMENT, 'Source document'), versionId: pattern(item.versionId, DOCUMENT_VERSION, 'Saved source version'), sha256: pattern(item.sha256, SHA, 'Saved source checksum') };
  });
  unique(documents, item => `${item.documentId}:${item.versionId}`, 'Supporting source');
  const result = { requestId: pattern(input.requestId, UUID, 'Request UUID').toLowerCase(), serviceId: input.serviceId,
    projectId: input.projectId, analysisId: input.analysisId, ownerUserId: input.ownerUserId,
    analysisVersion: integer(input.analysisVersion, 1, 2147483647, 'Saved analysis version'), results, documents,
    notes: notes(input.notes), prerequisites: prerequisites(input.prerequisites) };
  byteBound(requestCanonical(result), L.requestBytes, 'Preparation request');
  return result;
}
function requestCanonical(value) {
  return JSON.stringify({ schema: ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA, serviceId: value.serviceId, projectId: value.projectId,
    analysisId: value.analysisId, ownerUserId: value.ownerUserId, requestId: value.requestId, analysisVersion: value.analysisVersion,
    results: value.results, documents: value.documents, notes: value.notes, prerequisites: value.prerequisites });
}
export function canonicalAnalysisSnapshotPreparation(input) {
  return requestCanonical(normalizeAnalysisSnapshotPreparation(input));
}

/** Strict sorted JSON for new snapshot fingerprints; never canonicalizes saved notebook bytes. */
export function canonicalSnapshotJson(value, maximumBytes = L.retainedBytes) {
  integer(maximumBytes, 1, L.retainedBytes, 'Canonical byte allowance');
  const ancestors = new Set(); let nodes = 0;
  function visit(item, depth) {
    if (depth > L.depth || ++nodes > L.nodes) invalid('Snapshot JSON exceeds its complexity bound.', true);
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') {
      if (!item.isWellFormed()) invalid('Snapshot JSON contains malformed Unicode.');
      return JSON.stringify(item);
    }
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalid('Snapshot JSON must contain finite plain JSON values.');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) result = `[${array(item, L.nodes, 'Snapshot JSON array').map(child => visit(child, depth + 1)).join(',')}]`;
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalid('Snapshot JSON must use plain objects.');
      const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
      if (keys.some(key => typeof key !== 'string' || reserved.has(key) || !key.isWellFormed()
          || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid('Snapshot JSON contains unsupported fields.');
      result = `{${keys.sort().map(key => `${JSON.stringify(key)}:${visit(descriptors[key].value, depth + 1)}`).join(',')}}`;
    }
    ancestors.delete(item); return result;
  }
  return byteBound(visit(value, 0), maximumBytes, 'Snapshot JSON');
}

function fullSource(value) {
  fields(value, ['artifactId', 'versionId', 'projectId', 'sha256'], 'Fixed view source');
  pattern(value.artifactId, ARTIFACT, 'Artifact'); pattern(value.versionId, VERSION, 'Artifact version');
  pattern(value.projectId, PROJECT, 'Source project'); pattern(value.sha256, SHA, 'Source checksum');
}
export function canonicalAnalysisSnapshotResultView(input) {
  fields(input, ['schema', 'source', 'family', 'spec', 'blobSha256', 'blobBytes', 'width', 'height'], 'Fixed result descriptor');
  if (input.schema !== FIXED_RESULT_VIEW_SCHEMA) invalid('Use the fixed result descriptor schema.');
  fullSource(input.source); pattern(input.blobSha256, SHA, 'Retained blob checksum');
  if (input.family === 'table') {
    fields(input.spec, ['offset', 'limit'], 'Fixed table specification');
    integer(input.spec.offset, 0, L.tableOffset, 'Fixed table offset'); integer(input.spec.limit, 1, L.tableRows, 'Fixed table rows');
    integer(input.blobBytes, 1, L.tableBytes, 'Fixed table bytes');
    if (input.width !== null || input.height !== null) invalid('Fixed tables have no raster dimensions.');
  } else if (input.family === 'image') {
    if (input.spec !== null) invalid('A fixed raster has no source expansion specification.');
    integer(input.blobBytes, 1, L.imageBytes, 'Fixed raster bytes');
    integer(input.width, 1, 100000, 'Raster width'); integer(input.height, 1, 100000, 'Raster height');
    if (input.width * input.height > L.imagePixels) invalid('Fixed raster exceeds its pixel bound.', true);
  } else invalid('Use a supported fixed result family.');
  return canonicalSnapshotJson(input, L.packageBytes);
}
export function canonicalAnalysisSnapshotDocumentSource(input) {
  fields(input, ['schema', 'source', 'blobSha256', 'blobBytes'], 'Fixed supporting source descriptor');
  if (input.schema !== FIXED_DOCUMENT_SOURCE_SCHEMA) invalid('Use the fixed supporting source schema.');
  fields(input.source, ['documentId', 'versionId', 'sha256'], 'Fixed supporting source');
  pattern(input.source.documentId, DOCUMENT, 'Document'); pattern(input.source.versionId, DOCUMENT_VERSION, 'Saved document version');
  pattern(input.source.sha256, SHA, 'Saved document checksum'); pattern(input.blobSha256, SHA, 'Supporting source blob checksum');
  if (input.blobSha256 !== input.source.sha256) invalid('Supporting source retains its existing canonical checksum.');
  integer(input.blobBytes, 1, L.documentBytes, 'Supporting source bytes');
  return canonicalSnapshotJson(input, L.packageBytes);
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(`${label} must be an exact UTC timestamp.`);
}
function savedText(value, maximum, label, multiline = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > maximum
      || !multiline && (!value || value !== value.trim()) || [...value].some(char => {
        const code = char.charCodeAt(0); return code === 127 || code < 32 && !(multiline && [9, 10].includes(code));
      })) invalid(`${label} does not match its saved text contract.`);
}

/** Validates the frozen metadata shape. Callers verify its declared hashes and stored bytes separately. */
export function canonicalAnalysisSnapshotPackage(input) {
  fields(input, ['schema', 'serviceId', 'projectId', 'analysisId', 'ownerUserId', 'preparationId', 'createdAt', 'analysis', 'results', 'documents', 'notes', 'prerequisites', 'reproduction'], 'Snapshot package');
  if (input.schema !== ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA) invalid('Use the snapshot package schema.');
  identity(input); pattern(input.preparationId, ANALYSIS_SNAPSHOT_PREPARATION_ID, 'Preparation'); timestamp(input.createdAt, 'Preparation time');
  fields(input.analysis, ['version', 'name', 'description', 'status', 'createdByUserId', 'createdAt', 'updatedAt', 'revisionSha256'], 'Saved analysis projection');
  integer(input.analysis.version, 1, 2147483647, 'Saved analysis version'); savedText(input.analysis.name, 160, 'Saved analysis name');
  savedText(input.analysis.description, 8000, 'Saved analysis description', true);
  if (!['active', 'archived'].includes(input.analysis.status)) invalid('Saved analysis status is invalid.');
  integer(input.analysis.createdByUserId, 1, Number.MAX_SAFE_INTEGER, 'Analysis creator');
  timestamp(input.analysis.createdAt, 'Analysis creation time'); timestamp(input.analysis.updatedAt, 'Analysis update time'); pattern(input.analysis.revisionSha256, SHA, 'Analysis revision fingerprint');
  let retained = 0, documentBytes = 0; const sourceSizes = new Map(), selections = [];
  const ids = [], documents = [];
  array(input.results, L.results, 'Snapshot results', 1).forEach(item => {
    fields(item, ['viewId', 'attachment', 'source', 'view'], 'Snapshot result');
    pattern(item.viewId, ANALYSIS_SNAPSHOT_VIEW_ID, 'Retained view'); ids.push(item.viewId);
    fields(item.attachment, ['attachmentId', 'revisionId', 'revisionNumber', 'caption', 'suppliedOrigin', 'createdByUserId', 'createdAt', 'sourceOwnerUserId'], 'Captured attachment');
    pattern(item.attachment.attachmentId, ATTACHMENT, 'Captured attachment'); pattern(item.attachment.revisionId, REVISION, 'Captured attachment revision');
    integer(item.attachment.revisionNumber, 1, 200, 'Attachment revision number'); integer(item.attachment.createdByUserId, 1, Number.MAX_SAFE_INTEGER, 'Caption author');
    timestamp(item.attachment.createdAt, 'Attachment time');
    if (item.attachment.sourceOwnerUserId !== input.ownerUserId) invalid('A preparation may retain only its owner\'s outside source.');
    fields(item.source, ['artifactId', 'versionId', 'sha256', 'sizeBytes', 'name', 'format'], 'Saved result source');
    fullSource({ artifactId: item.source.artifactId, versionId: item.source.versionId, projectId: input.projectId, sha256: item.source.sha256 });
    integer(item.source.sizeBytes, 0, L.originalBytes, 'Original result bytes');
    if (typeof item.source.name !== 'string' || item.source.name.length > 160) invalid('Saved artifact name exceeds its owning contract.');
    savedText(item.source.name, 160, 'Saved artifact name');
    fields(item.source.format, ['id', 'version'], 'Saved result format');
    if (item.source.format.version !== '1') invalid('Use a supported outside result format version.');
    fields(item.view, ['schema', 'family', 'spec', 'blobSha256', 'blobBytes', 'viewSha256', 'width', 'height'], 'Saved fixed view');
    const { viewSha256, ...descriptor } = item.view; pattern(viewSha256, SHA, 'View descriptor checksum');
    canonicalAnalysisSnapshotResultView({ ...descriptor, source: { artifactId: item.source.artifactId, versionId: item.source.versionId, projectId: input.projectId, sha256: item.source.sha256 } });
    const table = ['org.ietf.csv', 'org.iana.tsv'].includes(item.source.format.id);
    const image = ['org.w3.png', 'org.iso.jpeg'].includes(item.source.format.id);
    if (!table && !image || table && item.view.family !== 'table' || image && item.view.family !== 'image') invalid('Fixed view does not match its saved source format.');
    if (image && (item.view.blobSha256 !== item.source.sha256 || item.view.blobBytes !== item.source.sizeBytes)) invalid('A fixed outside raster retains its exact original bytes.');
    const copied = normalizeAnalysisAttachmentCreate({ requestId: '00000000-0000-4000-8000-000000000000',
      reference: { kind: 'artifact-version', versionId: item.source.versionId, sha256: item.source.sha256 }, caption: item.attachment.caption, suppliedOrigin: item.attachment.suppliedOrigin });
    if (copied.caption !== item.attachment.caption || canonicalSnapshotJson(copied.suppliedOrigin) !== canonicalSnapshotJson(item.attachment.suppliedOrigin)) invalid('Captured attachment context must retain its literal saved content.');
    selections.push({ attachmentId: item.attachment.attachmentId, revisionId: item.attachment.revisionId,
      reference: copied.reference, view: table ? { family: 'table', ...item.view.spec } : { family: 'image' } });
    const prior = sourceSizes.get(item.source.versionId);
    if (prior && (prior.sha256 !== item.source.sha256 || prior.sizeBytes !== item.source.sizeBytes || prior.artifactId !== item.source.artifactId)) invalid('One source version cannot identify different retained source records.');
    sourceSizes.set(item.source.versionId, item.source); retained += item.view.blobBytes;
  });
  unique(selections, item => JSON.stringify(item), 'Snapshot results');
  if ([...sourceSizes.values()].reduce((sum, source) => sum + source.sizeBytes, 0) > L.originalBytes) invalid('Original source verification exceeds its aggregate bound.', true);
  array(input.documents, L.documents, 'Snapshot supporting sources').forEach(item => {
    fields(item, ['viewId', 'documentId', 'versionId', 'version', 'title', 'documentKind', 'defaultLanguage', 'sha256', 'contentBytes', 'role', 'producingSource', 'blobSha256', 'blobBytes', 'viewSha256'], 'Snapshot supporting source');
    pattern(item.viewId, ANALYSIS_SNAPSHOT_VIEW_ID, 'Supporting source view'); ids.push(item.viewId);
    integer(item.version, 1, 2147483647, 'Document version'); savedText(item.title, 160, 'Saved document title');
    if (!['script', 'notebook'].includes(item.documentKind) || !['R', 'python'].includes(item.defaultLanguage)
        || item.role !== 'supporting-source' || item.producingSource !== 'not-established') invalid('Supporting source cannot claim producing execution.');
    pattern(item.viewSha256, SHA, 'Supporting source view checksum');
    canonicalAnalysisSnapshotDocumentSource({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA,
      source: { documentId: item.documentId, versionId: item.versionId, sha256: item.sha256 }, blobSha256: item.blobSha256, blobBytes: item.blobBytes });
    if (item.contentBytes !== item.blobBytes) invalid('Supporting source bytes must match the saved canonical document.');
    documentBytes += item.blobBytes; retained += item.blobBytes; documents.push(item);
  });
  unique(ids, item => item, 'Retained object identities'); unique(documents, item => `${item.documentId}:${item.versionId}`, 'Supporting document versions');
  if (documentBytes > L.documentTotalBytes) invalid('Supporting source exceeds its aggregate byte bound.', true);
  const normalizedNotes = notes(input.notes);
  if (canonicalSnapshotJson(normalizedNotes) !== canonicalSnapshotJson(input.notes)) invalid('Package notes must already be normalized.');
  fields(input.prerequisites, ['declaration', 'items'], 'Snapshot prerequisites');
  if (input.prerequisites.declaration !== 'user-supplied'
      || canonicalSnapshotJson(prerequisites(input.prerequisites.items)) !== canonicalSnapshotJson(input.prerequisites.items)) invalid('Prerequisites must remain normalized supplied declarations.');
  fields(input.reproduction, ['status', 'producingSource', 'runtime', 'dataAccess'], 'Reproduction statement');
  if (input.reproduction.status !== 'not-checked' || input.reproduction.producingSource !== 'not-established'
      || input.reproduction.runtime !== 'not-included' || input.reproduction.dataAccess !== 'not-granted') invalid('A preparation does not establish execution or grant original data access.');
  const result = canonicalSnapshotJson(input, L.packageBytes);
  if (retained + encoder.encode(result).byteLength > L.retainedBytes) invalid('Retained package exceeds its aggregate byte bound.', true);
  return result;
}
