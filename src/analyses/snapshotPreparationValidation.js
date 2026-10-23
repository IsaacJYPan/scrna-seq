import {
  ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA as SCHEMA, ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as L,
  ANALYSIS_SNAPSHOT_PREPARATION_ID as PREPARATION, ANALYSIS_SNAPSHOT_VIEW_ID as VIEW,
  FIXED_DOCUMENT_SOURCE_SCHEMA, normalizeAnalysisSnapshotPreparation,
  canonicalAnalysisSnapshotPreparation, canonicalSnapshotJson,
  canonicalAnalysisSnapshotPackage, canonicalAnalysisSnapshotResultView,
  canonicalAnalysisSnapshotDocumentSource,
} from '../../shared/analysisSnapshotPreparation.mjs';
import { normalizeAnalysisAttachmentCreate } from '../../shared/analysisAttachment.mjs';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import { scriptDocumentInfo } from '../../shared/scriptDocument.mjs';

const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SERVICE = /^svc_[a-f0-9]{32}$/, PROJECT = /^proj_[a-f0-9]{16,40}$/, ANALYSIS = /^ra_[a-f0-9]{24}$/;
const AV = /^av_[a-f0-9]{24}$/, AF = /^af_[a-f0-9]{24}$/, ATTACHMENT = /^raa_[a-f0-9]{24}$/, REVISION = /^rar_[a-f0-9]{24}$/;
const DOC = /^doc_[a-f0-9]{24}$/, DV = /^dv_[a-f0-9]{24}$/;
const common = ['schema', 'serviceId', 'projectId', 'analysisId', 'ownerUserId', 'canPrepare'];
const summaryKeys = ['preparationId', 'requestId', 'requestSha256', 'createdAt', 'updatedAt', 'state', 'canResume', 'canDelete', 'snapshotSha256', 'selection'];
const analysisKeys = ['version', 'name', 'description', 'status', 'createdByUserId', 'createdAt', 'updatedAt', 'revisionSha256'];
const documentKeys = ['documentId', 'versionId', 'version', 'title', 'documentKind', 'defaultLanguage', 'sha256', 'contentBytes'];
const fixedDocumentKeys = ['viewId', ...documentKeys, 'role', 'producingSource', 'blobSha256', 'blobBytes', 'viewSha256'];
const sourceKeys = ['artifactId', 'versionId', 'sha256', 'sizeBytes', 'name', 'format'];
const placeholder = '00000000-0000-4000-8000-000000000000';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const fail = () => { throw Object.assign(new Error('The exact private snapshot preparation could not be confirmed. Keep the original request and check again.'), { code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' }); };
const digest = async value => {
  if (!globalThis.crypto?.subtle) fail();
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
};
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (required.some(key => !Object.hasOwn(descriptors, key)) || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
      || !required.includes(key) && !optional.includes(key) || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail();
}
function dense(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
  }
  return value;
}
const capture = (value, maximum) => JSON.parse(canonicalSnapshotJson(value, maximum));
function pattern(value, expression) { if (typeof value !== 'string' || !expression.test(value)) fail(); return value; }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(); }
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
}
function savedText(value, maximum, multiline = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > maximum
      || !multiline && (!value || value !== value.trim()) || [...value].some(char => {
        const code = char.charCodeAt(0); return code === 127 || code < 32 && !(multiline && [9, 10].includes(code));
      })) fail();
}
function scopeCopy(value, discovery) {
  fields(value, ['projectId', 'analysisId', 'userId'], ['serviceId']);
  const { projectId, analysisId, userId, serviceId } = value;
  pattern(projectId, PROJECT); pattern(analysisId, ANALYSIS);
  if (typeof userId !== 'number' && (typeof userId !== 'string' || !/^[1-9]\d*$/.test(userId))) fail();
  integer(Number(userId), 1, Number.MAX_SAFE_INTEGER);
  if (!discovery || serviceId !== undefined) pattern(serviceId, SERVICE);
  return { projectId, analysisId, userId: Number(userId), serviceId };
}
function envelope(value, scope, extra) {
  fields(value, [...common, ...extra]);
  if (value.schema !== SCHEMA || value.projectId !== scope.projectId || value.analysisId !== scope.analysisId
      || value.ownerUserId !== scope.userId || typeof value.canPrepare !== 'boolean') fail();
  pattern(value.serviceId, SERVICE); if (scope.serviceId !== undefined && value.serviceId !== scope.serviceId) fail();
}
function paging(value) {
  dense(value.items, L.page);
  if (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > L.cursor
      || !/^[A-Za-z0-9_-]+$/.test(value.nextCursor)) || !value.items.length && value.nextCursor !== null) fail();
}
function unique(values) { if (new Set(values).size !== values.length) fail(); }
function descending(items, timeKey, idKey) {
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i];
    if (Date.parse(a[timeKey]) < Date.parse(b[timeKey]) || Date.parse(a[timeKey]) === Date.parse(b[timeKey]) && a[idKey] <= b[idKey]) fail();
  }
}
function state(value, canPrepare, allowDeleted = true) {
  if (!(allowDeleted ? ['preparing', 'ready', 'failed', 'deleted'] : ['preparing', 'ready', 'failed']).includes(value.state)
      || typeof value.canResume !== 'boolean' || typeof value.canDelete !== 'boolean'
      || value.canResume !== (canPrepare && ['preparing', 'failed'].includes(value.state)) || value.canDelete !== (value.state !== 'deleted')) fail();
  pattern(value.preparationId, PREPARATION); pattern(value.requestId, UUID); pattern(value.requestSha256, SHA);
  timestamp(value.createdAt); timestamp(value.updatedAt); if (value.updatedAt < value.createdAt) fail();
  if (value.state === 'ready') pattern(value.snapshotSha256, SHA);
  else if (value.state === 'deleted') { if (value.snapshotSha256 !== null) pattern(value.snapshotSha256, SHA); }
  else if (value.snapshotSha256 !== null) fail();
}
function analysis(value) {
  fields(value, analysisKeys); integer(value.version, 1, 2147483647); integer(value.createdByUserId, 1, Number.MAX_SAFE_INTEGER);
  savedText(value.name, 160); savedText(value.description, 8000, true);
  if (!['active', 'archived'].includes(value.status)) fail();
  timestamp(value.createdAt); timestamp(value.updatedAt); if (value.updatedAt < value.createdAt) fail(); pattern(value.revisionSha256, SHA);
}
function source(value) {
  fields(value, sourceKeys); pattern(value.artifactId, AF); pattern(value.versionId, AV); pattern(value.sha256, SHA);
  integer(value.sizeBytes, 0, L.originalBytes); savedText(value.name, 160); if (value.name.length > 160) fail();
  fields(value.format, ['id', 'version']);
  if (!['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg'].includes(value.format.id) || value.format.version !== '1') fail();
  return ['org.ietf.csv', 'org.iana.tsv'].includes(value.format.id) ? 'table' : 'image';
}
function attachment(value) {
  pattern(value.attachmentId, ATTACHMENT); pattern(value.revisionId, REVISION); integer(value.revisionNumber, 1, 200);
  integer(value.createdByUserId, 1, Number.MAX_SAFE_INTEGER); timestamp(value.createdAt);
  fields(value.reference, ['kind', 'versionId', 'sha256']);
  const normal = normalizeAnalysisAttachmentCreate({ requestId: placeholder, reference: value.reference, caption: value.caption, suppliedOrigin: value.suppliedOrigin });
  if (canonicalSnapshotJson(normal.reference) !== canonicalSnapshotJson(value.reference) || normal.caption !== value.caption
      || canonicalSnapshotJson(normal.suppliedOrigin) !== canonicalSnapshotJson(value.suppliedOrigin)) fail();
}
function documentMetadata(value) {
  pattern(value.documentId, DOC); pattern(value.versionId, DV); integer(value.version, 1, 2147483647);
  savedText(value.title, 160); pattern(value.sha256, SHA); integer(value.contentBytes, 1, L.documentBytes);
  if (!['script', 'notebook'].includes(value.documentKind) || !['R', 'python'].includes(value.defaultLanguage)
      || value.role !== 'supporting-source' || value.producingSource !== 'not-established') fail();
}

export function validateSnapshotPreparationList(input, expectedScope) {
  try {
    const value = capture(input, L.listBytes), scope = scopeCopy(expectedScope, true);
    envelope(value, scope, ['items', 'nextCursor']); paging(value);
    value.items.forEach(item => {
      fields(item, summaryKeys); state(item, value.canPrepare, false);
      fields(item.selection, ['analysisVersion', 'analysisName', 'resultCount', 'documentCount', 'prerequisiteCount']);
      integer(item.selection.analysisVersion, 1, 2147483647); savedText(item.selection.analysisName, 160);
      integer(item.selection.resultCount, 1, L.results); integer(item.selection.documentCount, 0, L.documents); integer(item.selection.prerequisiteCount, 0, L.prerequisites);
    });
    unique(value.items.map(item => item.preparationId)); unique(value.items.map(item => item.requestId));
    descending(value.items, 'createdAt', 'preparationId'); return value;
  } catch { fail(); }
}
export function validateSnapshotPreparationOptions(input, expectedScope, kind) {
  try {
    const value = capture(input, L.listBytes), scope = scopeCopy(expectedScope, true);
    envelope(value, scope, ['kind', 'items', 'nextCursor']); paging(value);
    if (!['analysis-versions', 'results', 'documents'].includes(kind) || value.kind !== kind) fail();
    if (kind === 'analysis-versions') {
      value.items.forEach(analysis); unique(value.items.map(item => item.version));
      for (let i = 1; i < value.items.length; i++) if (value.items[i - 1].version <= value.items[i].version) fail();
    } else if (kind === 'results') {
      value.items.forEach(item => {
        fields(item, ['attachmentId', 'revisionId', 'revisionNumber', 'reference', 'caption', 'suppliedOrigin', 'createdByUserId', 'createdAt', 'sourceOwnerUserId', 'source', 'families', 'integrity']);
        attachment(item); const family = source(item.source);
        if (item.sourceOwnerUserId !== scope.userId || item.integrity !== 'not-checked' || item.reference.versionId !== item.source.versionId
            || item.reference.sha256 !== item.source.sha256 || dense(item.families, 1).length !== 1 || item.families[0] !== family) fail();
      }); unique(value.items.map(item => item.revisionId)); descending(value.items, 'createdAt', 'revisionId');
    } else {
      value.items.forEach(item => {
        fields(item, [...documentKeys, 'actorUserId', 'createdAt', 'role', 'producingSource']); documentMetadata(item);
        integer(item.actorUserId, 1, Number.MAX_SAFE_INTEGER); timestamp(item.createdAt);
      }); unique(value.items.map(item => item.versionId)); descending(value.items, 'createdAt', 'versionId');
    }
    return value;
  } catch { fail(); }
}

async function verifySnapshotPackage(pkg, binding) {
  fields(binding, ['serviceId', 'projectId', 'analysisId', 'ownerUserId', 'preparationId', 'snapshotSha256']);
  pattern(binding.serviceId, SERVICE); pattern(binding.projectId, PROJECT); pattern(binding.analysisId, ANALYSIS);
  integer(binding.ownerUserId, 1, Number.MAX_SAFE_INTEGER); pattern(binding.preparationId, PREPARATION); pattern(binding.snapshotSha256, SHA);
  const canonical = canonicalAnalysisSnapshotPackage(pkg);
  if (pkg.serviceId !== binding.serviceId || pkg.projectId !== binding.projectId || pkg.analysisId !== binding.analysisId
      || pkg.ownerUserId !== binding.ownerUserId || pkg.preparationId !== binding.preparationId
      || new TextEncoder().encode(canonical).byteLength + pkg.results.reduce((sum, item) => sum + item.view.blobBytes, 0)
        + pkg.documents.reduce((sum, item) => sum + item.blobBytes, 0) > L.retainedBytes
      || await digest(canonical) !== binding.snapshotSha256) fail();
  for (const item of pkg.results) {
    const { viewSha256, ...view } = item.view;
    if (await digest(canonicalAnalysisSnapshotResultView({ ...view, source: { artifactId: item.source.artifactId,
      versionId: item.source.versionId, projectId: pkg.projectId, sha256: item.source.sha256 } })) !== viewSha256) fail();
  }
  for (const item of pkg.documents) {
    if (await digest(canonicalAnalysisSnapshotDocumentSource({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA,
      source: { documentId: item.documentId, versionId: item.versionId, sha256: item.sha256 },
      blobSha256: item.blobSha256, blobBytes: item.blobBytes })) !== item.viewSha256) fail();
  }
  return pkg;
}
// Neutral scientific-package validation binds its publisher, not the current
// viewer or an action actor. Private preparation intent is checked separately.
export async function validateSnapshotPackage(input, expectedBinding) {
  try {
    const pkg = capture(input, L.packageBytes), binding = capture(expectedBinding, L.requestBytes);
    return await verifySnapshotPackage(pkg, binding);
  } catch { fail(); }
}

function availability(value, pkg) {
  fields(value, ['status', 'views', 'documents']);
  if (!['available', 'unavailable'].includes(value.status)) fail();
  const views = dense(value.views, L.results), documents = dense(value.documents, L.documents);
  if (views.length !== pkg.results.length || documents.length !== pkg.documents.length) fail();
  views.forEach((item, i) => { fields(item, ['viewId', 'status']); if (item.viewId !== pkg.results[i].viewId || !['available', 'unavailable'].includes(item.status)) fail(); });
  documents.forEach((item, i) => { fields(item, ['documentId', 'versionId', 'status']); if (item.documentId !== pkg.documents[i].documentId
    || item.versionId !== pkg.documents[i].versionId || !['available', 'unavailable'].includes(item.status)) fail(); });
  if (value.status !== ([...views, ...documents].every(item => item.status === 'available') ? 'available' : 'unavailable')) fail();
}
export async function validateSnapshotPreparation(input, expectedScope, expectedRecipe) {
  try {
    // Capture every caller-controlled value before any asynchronous digest.
    const value = capture(input, L.fullBytes), scope = scopeCopy(expectedScope, false);
    const expected = expectedRecipe === undefined ? null : normalizeAnalysisSnapshotPreparation(capture(expectedRecipe, L.requestBytes));
    envelope(value, scope, ['preparationId', 'requestId', 'requestSha256', 'createdAt', 'updatedAt', 'replayed', 'state', 'canResume', 'canDelete', 'recipe', 'snapshotSha256', 'package', 'availability', 'failure']);
    state(value, value.canPrepare); if (typeof value.replayed !== 'boolean') fail();
    const recipe = value.state === 'deleted' ? null : normalizeAnalysisSnapshotPreparation(value.recipe);
    if (value.state === 'deleted' && value.recipe !== null || recipe && canonicalSnapshotJson(recipe) !== canonicalSnapshotJson(value.recipe)) fail();
    for (const bound of [recipe, expected].filter(Boolean)) {
      if (bound.serviceId !== value.serviceId || bound.projectId !== value.projectId || bound.analysisId !== value.analysisId
          || bound.ownerUserId !== value.ownerUserId || bound.requestId !== value.requestId
          || await digest(canonicalAnalysisSnapshotPreparation(bound)) !== value.requestSha256) fail();
    }
    if (recipe && expected && canonicalAnalysisSnapshotPreparation(recipe) !== canonicalAnalysisSnapshotPreparation(expected)) fail();
    if (value.state !== 'ready') {
      if (value.package !== null || value.availability !== null) fail();
      if (value.state === 'failed') {
        fields(value.failure, ['code', 'message']); pattern(value.failure.code, /^[A-Z][A-Z0-9_]{0,63}$/);
        if (typeof value.failure.message !== 'string' || !value.failure.message || value.failure.message.length > 240 || /[\p{Cc}\p{Cf}]/u.test(value.failure.message)) fail();
      } else if (value.failure !== null) fail();
      return value;
    }
    if (value.failure !== null) fail();
    const pkg = value.package, canonical = canonicalAnalysisSnapshotPackage(pkg);
    if (pkg.serviceId !== value.serviceId || pkg.projectId !== value.projectId || pkg.analysisId !== value.analysisId || pkg.ownerUserId !== value.ownerUserId
        || pkg.preparationId !== value.preparationId || pkg.createdAt !== value.createdAt || pkg.analysis.version !== recipe.analysisVersion
        || pkg.results.length !== recipe.results.length || pkg.documents.length !== recipe.documents.length
        || canonicalSnapshotJson(pkg.notes) !== canonicalSnapshotJson(recipe.notes)
        || canonicalSnapshotJson(pkg.prerequisites.items) !== canonicalSnapshotJson(recipe.prerequisites)
        || new TextEncoder().encode(canonical).byteLength + new TextEncoder().encode(canonicalAnalysisSnapshotPreparation(recipe)).byteLength
          + pkg.results.reduce((sum, item) => sum + item.view.blobBytes, 0) + pkg.documents.reduce((sum, item) => sum + item.blobBytes, 0) > L.retainedBytes) fail();
    await verifySnapshotPackage(pkg, { serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId,
      ownerUserId: value.ownerUserId, preparationId: value.preparationId, snapshotSha256: value.snapshotSha256 });
    for (let i = 0; i < pkg.results.length; i++) {
      const item = pkg.results[i], chosen = recipe.results[i], view = item.view;
      if (item.attachment.attachmentId !== chosen.attachmentId || item.attachment.revisionId !== chosen.revisionId
          || item.source.versionId !== chosen.reference.versionId || item.source.sha256 !== chosen.reference.sha256
          || view.family !== chosen.view.family || view.family === 'table' && (view.spec.offset !== chosen.view.offset || view.spec.limit !== chosen.view.limit)) fail();
    }
    for (let i = 0; i < pkg.documents.length; i++) {
      const item = pkg.documents[i], chosen = recipe.documents[i];
      if (item.documentId !== chosen.documentId || item.versionId !== chosen.versionId || item.sha256 !== chosen.sha256) fail();
    }
    availability(value.availability, pkg); return value;
  } catch { fail(); }
}

async function raw(bytes, expected, maximum) {
  // Native brand/accessors accept byte arrays from another realm without
  // reading a caller's constructor, byteLength getter or Symbol.iterator.
  if (!ArrayBuffer.isView(bytes) || typedArrayName.call(bytes) !== 'Uint8Array') fail();
  integer(expected.blobBytes, 1, maximum); pattern(expected.blobSha256, SHA);
  const length = typedArrayByteLength.call(bytes);
  if (length !== expected.blobBytes) fail();
  const copied = new Uint8Array(length); Uint8Array.prototype.set.call(copied, bytes);
  if (await digest(copied) !== expected.blobSha256) fail();
  return new TextDecoder('utf-8', { fatal: true }).decode(copied);
}
export async function decodeSnapshotPreparationTable(bytes, resultDescriptor) {
  try {
    const result = capture(resultDescriptor, L.packageBytes);
    fields(result, ['viewId', 'attachment', 'source', 'view']); pattern(result.viewId, VIEW);
    if (source(result.source) !== 'table') fail();
    fields(result.view, ['schema', 'family', 'spec', 'blobSha256', 'blobBytes', 'viewSha256', 'width', 'height']);
    pattern(result.view.viewSha256, SHA);
    if (result.view.schema !== 'traceomics.fixed-result-view.v1' || result.view.family !== 'table' || result.view.width !== null || result.view.height !== null) fail();
    fields(result.view.spec, ['offset', 'limit']); integer(result.view.spec.offset, 0, L.tableOffset); integer(result.view.spec.limit, 1, L.tableRows);
    const text = await raw(bytes, result.view, L.tableBytes), table = JSON.parse(text);
    fields(table, ['family', 'columns', 'rows', 'offset', 'limit', 'hasMore', 'scannedRows', 'truncated']);
    if (table.family !== 'table' || table.offset !== result.view.spec.offset || table.limit !== result.view.spec.limit
        || typeof table.hasMore !== 'boolean' || typeof table.truncated !== 'boolean' || table.truncated && !table.hasMore
        || canonicalSnapshotJson(table, L.tableBytes) !== text) fail();
    const columns = dense(table.columns, L.tableColumns), rows = dense(table.rows, table.limit);
    if (!columns.length || columns.some(item => typeof item !== 'string' || !item.trim() || item.length > L.tableCellCharacters)) fail();
    unique(columns);
    rows.forEach(row => { if (dense(row, L.tableColumns).length !== columns.length || row.some(cell => typeof cell !== 'string' || cell.length > L.tableCellCharacters)) fail(); });
    integer(table.scannedRows, rows.length, L.tableScanBytes);
    if (rows.length && table.scannedRows < table.offset + rows.length || !table.truncated && table.hasMore
        && (rows.length !== table.limit || table.scannedRows !== table.offset + table.limit + 1)) fail();
    return table;
  } catch { fail(); }
}
export async function decodeSnapshotPreparationDocument(bytes, documentDescriptor) {
  try {
    const value = capture(documentDescriptor, L.packageBytes); fields(value, fixedDocumentKeys); pattern(value.viewId, VIEW); documentMetadata(value);
    pattern(value.viewSha256, SHA);
    canonicalAnalysisSnapshotDocumentSource({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA,
      source: { documentId: value.documentId, versionId: value.versionId, sha256: value.sha256 }, blobSha256: value.blobSha256, blobBytes: value.blobBytes });
    if (value.contentBytes !== value.blobBytes) fail();
    const text = await raw(bytes, value, L.documentBytes), content = JSON.parse(text);
    if (canonicalNotebookContent(content) !== text || content.defaultLanguage !== value.defaultLanguage) fail();
    let kind = 'notebook'; try { if (scriptDocumentInfo(content)) kind = 'script'; } catch { /* Match the owning document service's classification. */ }
    if (kind !== value.documentKind) fail(); return content;
  } catch { fail(); }
}
