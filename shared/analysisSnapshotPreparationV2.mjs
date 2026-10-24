import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as L, ANALYSIS_SNAPSHOT_PREPARATION_ID,
  ANALYSIS_SNAPSHOT_VIEW_ID, FIXED_DOCUMENT_SOURCE_SCHEMA, canonicalSnapshotJson,
  canonicalAnalysisSnapshotDocumentSource } from './analysisSnapshotPreparation.mjs';
import { normalizeAnalysisAttachmentCreate } from './analysisAttachment.mjs';
import { validateResearchAnalysisReference } from './researchAnalysis.mjs';
import { FIXED_RESULT_VIEW_SCHEMA_V3, canonicalAnalysisSnapshotResultViewV3 } from './analysisSnapshotTypedResult.mjs';
import { ANALYSIS_SNAPSHOT_WORKFLOW_LIMITS, normalizeAnalysisSnapshotWorkflowOutputReference,
  normalizeAnalysisSnapshotWorkflowContextSelection, normalizeAnalysisSnapshotWorkflowContext,
  normalizeAnalysisSnapshotWorkflowContextEvidence, canonicalAnalysisSnapshotWorkflowContextBinding, assertAnalysisSnapshotWorkflowContextPayload } from './analysisSnapshotWorkflowContext.mjs';

export const ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2 = 'traceomics.analysis-snapshot-preparation.v2';
export const ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA_V2 = 'traceomics.analysis-snapshot-package.v2';
export const FIXED_RESULT_VIEW_SCHEMA_V2 = 'traceomics.fixed-result-view.v2';
export const ANALYSIS_SNAPSHOT_LINKED_LIMITS = Object.freeze({ caption: 2000, label: 160, detail: 1000, sourceName: 200, optionLabel: 200 });
const B = ANALYSIS_SNAPSHOT_LINKED_LIMITS;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/, PROJECT = /^proj_[a-f0-9]{16,40}$/, ANALYSIS = /^ra_[a-f0-9]{24}$/, SERVICE = /^svc_[a-f0-9]{32}$/;
const VERSION = /^(?:av|art|eri)_[a-f0-9]{16,40}$/, ARTIFACT = /^(?:af|av|art|eri)_[a-f0-9]{16,40}$/;
const ATTACHMENT = /^raa_[a-f0-9]{24}$/, REVISION = /^rar_[a-f0-9]{24}$/, AV = /^av_[a-f0-9]{24}$/;
const DOC = /^doc_[a-f0-9]{24}$/, DV = /^dv_[a-f0-9]{24}$/;
const capture = (value, maximum) => JSON.parse(canonicalSnapshotJson(value, maximum));
function invalid(message, large = false) {
  throw Object.assign(new Error(message), { code: large ? 'ANALYSIS_SNAPSHOT_PREPARATION_TOO_LARGE' : 'INVALID_ANALYSIS_SNAPSHOT_PREPARATION', status: large ? 413 : 400 });
}
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) invalid('Use only the documented snapshot fields.');
}
function pattern(value, regex) { if (typeof value !== 'string' || !regex.test(value)) invalid('Use an exact saved identity.'); return value; }
function integer(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid('A snapshot value exceeds its supported bound.'); return value;
}
function array(value, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid('The selected snapshot item count is unsupported.'); return value;
}
function text(value, max, nullable = false, multiline = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed()) invalid('Use well-formed supplied text.');
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (/[\p{Cc}\p{Cf}]/u.test(multiline ? normalized.replace(/[\t\n]/g, '') : normalized)) invalid('Supplied text contains hidden controls.');
  if (nullable && !normalized) return null;
  if (!normalized || normalized.length > max) invalid('Supplied text exceeds its supported bound.'); return normalized;
}
export const normalizeAnalysisSnapshotCaptionV2 = value => text(value, B.caption);
function identity(value) {
  pattern(value.serviceId, SERVICE); pattern(value.projectId, PROJECT); pattern(value.analysisId, ANALYSIS); integer(value.ownerUserId);
}
function reference(value, artifactOnly = false, attached = false) {
  const normalized = validateResearchAnalysisReference(value);
  if (artifactOnly && normalized.kind !== 'artifact-version') invalid('Choose an exact saved artifact result.');
  if (attached && !AV.test(normalized.versionId)) invalid('Outside attachments retain their exact managed source.');
  return normalized;
}
function selectedView(value) {
  if (value?.family === 'image') { fields(value, ['family']); return { family: 'image' }; }
  fields(value, ['family', 'offset', 'limit']); if (value.family !== 'table') invalid('Choose a supported fixed table or image view.');
  return { family: 'table', offset: integer(value.offset, 0, L.tableOffset), limit: integer(value.limit, 1, L.tableRows) };
}
function selectedTypedView(value) {
  if (value?.family === 'embedding') { fields(value, ['family', 'pointLimit']); return { family: 'embedding', pointLimit: integer(value.pointLimit, 1, 5000) }; }
  if (value?.family === 'metrics') { fields(value, ['family']); return { family: 'metrics' }; }
  return selectedView(value);
}
function selectedResult(value) {
  if (value?.kind === 'attachment-revision') {
    fields(value, ['kind', 'attachmentId', 'revisionId', 'reference', 'view']);
    return { kind: value.kind, attachmentId: pattern(value.attachmentId, ATTACHMENT), revisionId: pattern(value.revisionId, REVISION),
      reference: reference(value.reference, true, true), view: selectedView(value.view) };
  }
  if (value?.kind === 'captured-workflow-output') {
    fields(value, ['kind', 'snapshotReference', 'stepId', 'port', 'reference', 'descriptorSha256', 'caption', 'view', 'contextSelection', 'contextSha256']);
    const origin = normalizeAnalysisSnapshotWorkflowOutputReference({ snapshotReference: value.snapshotReference, stepId: value.stepId, port: value.port, reference: value.reference });
    const view = selectedTypedView(value.view);
    return { kind: value.kind, ...origin, descriptorSha256: pattern(value.descriptorSha256, SHA), caption: text(value.caption, B.caption), view,
      contextSelection: normalizeAnalysisSnapshotWorkflowContextSelection(value.contextSelection), contextSha256: pattern(value.contextSha256, SHA) };
  }
  if (value?.kind === 'typed-analysis-reference') {
    fields(value, ['kind', 'reference', 'descriptorSha256', 'caption', 'view']);
    const view = selectedTypedView(value.view);
    return { kind: value.kind, reference: reference(value.reference, true), descriptorSha256: pattern(value.descriptorSha256, SHA), caption: text(value.caption, B.caption), view };
  }
  fields(value, ['kind', 'reference', 'caption', 'view']); if (value.kind !== 'analysis-reference') invalid('Choose a supported saved-result origin.');
  return { kind: value.kind, reference: reference(value.reference, true), caption: text(value.caption, B.caption), view: selectedView(value.view) };
}
function selectionKey(value) {
  if (value.kind === 'captured-workflow-output') return canonicalSnapshotJson({ kind: value.kind, snapshotReference: value.snapshotReference, stepId: value.stepId, port: value.port,
    reference: value.reference, view: value.view, contextSelection: value.contextSelection });
  return canonicalSnapshotJson(value.kind === 'attachment-revision'
    ? { kind: value.kind, attachmentId: value.attachmentId, revisionId: value.revisionId, reference: value.reference, view: value.view }
    : { kind: value.kind, reference: value.reference, view: value.view });
}
function unique(items, key) { if (new Set(items.map(key)).size !== items.length) invalid('Select each exact item once.'); }
function notes(value) {
  fields(value, ['summary', 'decisions', 'limitations']);
  return Object.fromEntries(['summary', 'decisions', 'limitations'].map(key => [key, text(value[key], L.notes, true)]));
}
function prerequisite(value) {
  if (value?.kind === 'captured-workflow-reference') {
    fields(value, ['kind', 'snapshotReference', 'stepId', 'port', 'reference', 'label', 'detail']);
    const origin = normalizeAnalysisSnapshotWorkflowOutputReference({ snapshotReference: value.snapshotReference, stepId: value.stepId, port: value.port, reference: value.reference });
    return { kind: value.kind, ...origin, label: text(value.label, B.label, false, false), detail: text(value.detail, B.detail, true) };
  }
  if (value?.kind === 'analysis-reference') {
    fields(value, ['kind', 'reference', 'label', 'detail']);
    return { kind: value.kind, reference: reference(value.reference), label: text(value.label, B.label, false, false), detail: text(value.detail, B.detail, true) };
  }
  fields(value, ['kind', 'label', 'detail']);
  if (!['data', 'environment', 'compute', 'other'].includes(value.kind)) invalid('Choose a supported declared prerequisite.');
  return { kind: value.kind, label: text(value.label, B.label, false, false), detail: text(value.detail, B.detail, true) };
}
function prerequisites(value) {
  const result = array(value, L.prerequisites).map(prerequisite);
  unique(result.filter(item => item.kind === 'analysis-reference'), item => canonicalSnapshotJson(item.reference));
  unique(result.filter(item => item.kind === 'captured-workflow-reference'), item => canonicalSnapshotJson({ snapshotReference: item.snapshotReference, stepId: item.stepId, port: item.port, reference: item.reference })); return result;
}
function chosenDocuments(value) {
  const result = array(value, L.documents).map(item => {
    fields(item, ['documentId', 'versionId', 'sha256']);
    return { documentId: pattern(item.documentId, DOC), versionId: pattern(item.versionId, DV), sha256: pattern(item.sha256, SHA) };
  });
  unique(result, item => `${item.documentId}:${item.versionId}`); return result;
}
export function normalizeAnalysisSnapshotPreparationV2(input) {
  const value = capture(input, L.requestBytes);
  fields(value, ['schema', 'requestId', 'serviceId', 'projectId', 'analysisId', 'ownerUserId', 'analysisVersion', 'results', 'documents', 'notes', 'prerequisites']);
  if (value.schema !== ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2) invalid('Use the linked-result preparation schema.'); identity(value);
  const results = array(value.results, L.results, 1).map(selectedResult); unique(results, selectionKey);
  const result = { schema: value.schema, requestId: pattern(value.requestId, UUID).toLowerCase(), serviceId: value.serviceId,
    projectId: value.projectId, analysisId: value.analysisId, ownerUserId: value.ownerUserId,
    analysisVersion: integer(value.analysisVersion, 1, 2147483647), results, documents: chosenDocuments(value.documents), notes: notes(value.notes), prerequisites: prerequisites(value.prerequisites) };
  if (new TextEncoder().encode(requestCanonical(result)).byteLength > L.requestBytes) invalid('Preparation exceeds its request byte bound.', true); return result;
}
function requestCanonical(value) {
  return JSON.stringify({ schema: value.schema, serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId,
    ownerUserId: value.ownerUserId, requestId: value.requestId, analysisVersion: value.analysisVersion,
    results: value.results, documents: value.documents, notes: value.notes, prerequisites: value.prerequisites });
}
export const canonicalAnalysisSnapshotPreparationV2 = input => requestCanonical(normalizeAnalysisSnapshotPreparationV2(input));

function fullSource(value) {
  fields(value, ['artifactId', 'versionId', 'projectId', 'sha256']); pattern(value.artifactId, ARTIFACT);
  pattern(value.versionId, VERSION); pattern(value.projectId, PROJECT); pattern(value.sha256, SHA);
}
export function canonicalAnalysisSnapshotResultViewV2(input) {
  const value = capture(input, L.packageBytes);
  fields(value, ['schema', 'source', 'family', 'spec', 'blobSha256', 'blobBytes', 'width', 'height']);
  if (value.schema !== FIXED_RESULT_VIEW_SCHEMA_V2) invalid('Use the linked fixed-view schema.'); fullSource(value.source); pattern(value.blobSha256, SHA);
  if (value.family === 'table') {
    fields(value.spec, ['offset', 'limit']); integer(value.spec.offset, 0, L.tableOffset); integer(value.spec.limit, 1, L.tableRows);
    integer(value.blobBytes, 1, L.tableBytes); if (value.width !== null || value.height !== null) invalid('A table has no image dimensions.');
  } else if (value.family === 'image') {
    if (value.spec !== null) invalid('A fixed raster has no query specification.'); integer(value.blobBytes, 1, L.imageBytes);
    integer(value.width, 1, 100000); integer(value.height, 1, 100000); if (value.width * value.height > L.imagePixels) invalid('The raster exceeds its pixel bound.', true);
  } else invalid('Choose a supported fixed view family.');
  return canonicalSnapshotJson(value, L.packageBytes);
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('Use an exact saved UTC timestamp.');
}
function savedText(value, max, multiline = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > max || !multiline && (!value || value !== value.trim())
      || [...value].some(char => char.charCodeAt(0) === 127 || char.charCodeAt(0) < 32 && !(multiline && [9, 10].includes(char.charCodeAt(0))))) invalid('Copied text does not match its original contract.');
}
function savedAnalysis(value) {
  fields(value, ['version', 'name', 'description', 'status', 'createdByUserId', 'createdAt', 'updatedAt', 'revisionSha256']);
  integer(value.version, 1, 2147483647); savedText(value.name, 160); savedText(value.description, 8000, true); integer(value.createdByUserId);
  if (!['active', 'archived'].includes(value.status)) invalid('Saved analysis status is unsupported.');
  timestamp(value.createdAt); timestamp(value.updatedAt); if (value.updatedAt < value.createdAt) invalid('A saved revision cannot predate its creation.'); pattern(value.revisionSha256, SHA);
}
function savedSource(value, owner, projectId, typed = false) {
  fields(value, ['artifactId', 'versionId', 'ownerUserId', 'sha256', 'sizeBytes', 'name', 'format']);
  fullSource({ artifactId: value.artifactId, versionId: value.versionId, projectId, sha256: value.sha256 });
  if (value.ownerUserId !== owner) invalid('Fixed findings must retain their original owned source.'); integer(value.sizeBytes, 0, L.originalBytes);
  if (text(value.name, B.sourceName, false, false) !== value.name || /[\\/]/.test(value.name)) invalid('Use a safe bounded source label, not a path.');
  fields(value.format, ['id', 'version']);
  if (!(typed ? ['org.traceomics.table', 'org.ietf.json', 'org.w3.png', 'org.traceomics.coordinates'] : ['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg']).includes(value.format.id)
      || value.format.version !== '1') invalid('Choose a supported source format for this exact adapter.');
}
function savedOrigin(value, source, analysisVersion, owner) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Choose an exact saved result origin.');
  if (value.kind === 'attachment-revision') {
    fields(value, ['kind', 'attachment']); const item = value.attachment;
    fields(item, ['attachmentId', 'revisionId', 'revisionNumber', 'caption', 'suppliedOrigin', 'createdByUserId', 'createdAt', 'sourceOwnerUserId']);
    pattern(item.attachmentId, ATTACHMENT); pattern(item.revisionId, REVISION); integer(item.revisionNumber, 1, 200); integer(item.createdByUserId); timestamp(item.createdAt);
    if (item.sourceOwnerUserId !== owner || !AV.test(source.versionId)) invalid('An attachment retains its exact owned managed source.');
    const copied = normalizeAnalysisAttachmentCreate({ requestId: '00000000-0000-4000-8000-000000000000',
      reference: { kind: 'artifact-version', versionId: source.versionId, sha256: source.sha256 }, caption: item.caption, suppliedOrigin: item.suppliedOrigin });
    if (copied.caption !== item.caption || canonicalSnapshotJson(copied.suppliedOrigin) !== canonicalSnapshotJson(item.suppliedOrigin)) invalid('Keep literal saved attachment context.');
    return { kind: value.kind, attachmentId: item.attachmentId, revisionId: item.revisionId, reference: copied.reference };
  }
  if (value.kind === 'captured-workflow-output') {
    fields(value, ['kind', 'snapshotReference', 'analysisVersion', 'stepId', 'port', 'reference', 'caption', 'captionOrigin', 'context', 'contextSha256', 'contextEvidence']);
    const origin = normalizeAnalysisSnapshotWorkflowOutputReference({ snapshotReference: value.snapshotReference, stepId: value.stepId, port: value.port, reference: value.reference });
    const context = normalizeAnalysisSnapshotWorkflowContext(value.context); normalizeAnalysisSnapshotWorkflowContextEvidence(value.contextEvidence, context); pattern(value.contextSha256, SHA);
    if (value.analysisVersion !== analysisVersion || value.captionOrigin !== 'user-supplied' || text(value.caption, B.caption) !== value.caption
        || origin.reference.versionId !== source.versionId || origin.reference.sha256 !== source.sha256
        || canonicalSnapshotJson(context.snapshotReference) !== canonicalSnapshotJson(origin.snapshotReference) || context.stepId !== origin.stepId || context.port !== origin.port) invalid('Keep exact captured output and selected recorded context.');
    return { kind: value.kind, ...origin, contextSelection: { method: context.method !== null, parameterKeys: context.parameters.map(item => item.key), seed: context.seed !== null, environment: context.environment !== null } };
  }
  fields(value, ['kind', 'reference', 'analysisVersion', 'caption', 'captionOrigin']);
  if (!['analysis-reference', 'typed-analysis-reference'].includes(value.kind) || value.analysisVersion !== analysisVersion || value.captionOrigin !== 'user-supplied'
      || text(value.caption, B.caption) !== value.caption) invalid('Keep exact selected saved-analysis context and supplied caption.');
  const ref = reference(value.reference, true);
  if (ref.versionId !== source.versionId || ref.sha256 !== source.sha256) invalid('The selected reference must match its retained source.');
  return { kind: value.kind, reference: ref };
}
export function canonicalAnalysisSnapshotPackageV2(input) {
  assertAnalysisSnapshotWorkflowContextPayload(input);
  const value = capture(input, L.packageBytes);
  fields(value, ['schema', 'serviceId', 'projectId', 'analysisId', 'ownerUserId', 'preparationId', 'createdAt', 'analysis', 'results', 'documents', 'notes', 'prerequisites', 'reproduction']);
  if (value.schema !== ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA_V2) invalid('Use the linked snapshot package schema.'); identity(value);
  pattern(value.preparationId, ANALYSIS_SNAPSHOT_PREPARATION_ID); timestamp(value.createdAt); savedAnalysis(value.analysis);
  let retained = 0, documentBytes = 0, contextBytes = 0; const ids = [], selections = [], sources = new Map(), typedDescriptors = new Map();
  array(value.results, L.results, 1).forEach(item => {
    fields(item, ['viewId', 'origin', 'source', 'view']); pattern(item.viewId, ANALYSIS_SNAPSHOT_VIEW_ID); ids.push(item.viewId);
    const typed = ['typed-analysis-reference', 'captured-workflow-output'].includes(item.origin?.kind); savedSource(item.source, value.ownerUserId, value.projectId, typed);
    const origin = savedOrigin(item.origin, item.source, value.analysis.version, value.ownerUserId);
    if (item.origin.kind === 'captured-workflow-output') {
      canonicalAnalysisSnapshotWorkflowContextBinding({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId, ownerUserId: value.ownerUserId, analysisVersion: value.analysis.version, context: item.origin.context });
      contextBytes += new TextEncoder().encode(canonicalSnapshotJson(item.origin.context)).byteLength;
      if (contextBytes > ANALYSIS_SNAPSHOT_WORKFLOW_LIMITS.candidateContextBytes) invalid('Selected recorded context exceeds its candidate byte budget.', true);
    }
    fields(item.view, ['schema', 'family', 'spec', 'blobSha256', 'blobBytes', 'viewSha256', 'width', 'height', ...(typed ? ['descriptorSha256', 'semantics'] : [])]);
    const { viewSha256, ...view } = item.view; pattern(viewSha256, SHA);
    (typed ? canonicalAnalysisSnapshotResultViewV3 : canonicalAnalysisSnapshotResultViewV2)({ ...view, source: { artifactId: item.source.artifactId, versionId: item.source.versionId, projectId: value.projectId, sha256: item.source.sha256 } });
    const family = typed ? { 'org.traceomics.table': 'table', 'org.ietf.json': 'metrics', 'org.w3.png': 'image', 'org.traceomics.coordinates': 'embedding' }[item.source.format.id]
      : ['org.ietf.csv', 'org.iana.tsv'].includes(item.source.format.id) ? 'table' : 'image';
    if (typed) {
      if (view.schema !== FIXED_RESULT_VIEW_SCHEMA_V3 || item.source.sizeBytes > 5 * 1024 * 1024 || item.source.sizeBytes < 1) invalid('Typed findings retain a complete bounded source.');
      const descriptorIdentity = canonicalSnapshotJson({ sha256: view.descriptorSha256, semantics: view.semantics }), prior = typedDescriptors.get(item.source.versionId);
      if (prior && prior !== descriptorIdentity) invalid('One source version must retain one exact typed descriptor and meaning.');
      typedDescriptors.set(item.source.versionId, descriptorIdentity);
    }
    if (view.family !== family || family === 'image' && (view.blobBytes !== item.source.sizeBytes || view.blobSha256 !== item.source.sha256)) invalid('A fixed view must match its original source format and raster bytes.');
    selections.push({ ...origin, view: ['table', 'embedding'].includes(family) ? { family, ...view.spec } : { family } });
    const previous = sources.get(item.source.versionId);
    if (previous && canonicalSnapshotJson(previous) !== canonicalSnapshotJson(item.source)) invalid('One source version must retain one exact identity.');
    sources.set(item.source.versionId, item.source); retained += view.blobBytes;
  });
  unique(selections, selectionKey);
  if ([...sources.values()].reduce((sum, source) => sum + source.sizeBytes, 0) > L.originalBytes) invalid('Original sources exceed the verification budget.', true);
  const documents = array(value.documents, L.documents);
  documents.forEach(item => {
    fields(item, ['viewId', 'documentId', 'versionId', 'version', 'title', 'documentKind', 'defaultLanguage', 'sha256', 'contentBytes', 'role', 'producingSource', 'blobSha256', 'blobBytes', 'viewSha256']);
    pattern(item.viewId, ANALYSIS_SNAPSHOT_VIEW_ID); ids.push(item.viewId); integer(item.version, 1, 2147483647); savedText(item.title, 160); pattern(item.viewSha256, SHA);
    if (!['script', 'notebook'].includes(item.documentKind) || !['R', 'python'].includes(item.defaultLanguage) || item.role !== 'supporting-source' || item.producingSource !== 'not-established') invalid('Supporting source cannot claim producing execution.');
    canonicalAnalysisSnapshotDocumentSource({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA, source: { documentId: item.documentId, versionId: item.versionId, sha256: item.sha256 }, blobSha256: item.blobSha256, blobBytes: item.blobBytes });
    if (item.contentBytes !== item.blobBytes) invalid('Keep the exact original saved document bytes.'); documentBytes += item.blobBytes; retained += item.blobBytes;
  });
  unique(ids, item => item); unique(documents, item => `${item.documentId}:${item.versionId}`);
  if (documentBytes > L.documentTotalBytes) invalid('Supporting sources exceed their byte budget.', true);
  if (canonicalSnapshotJson(notes(value.notes)) !== canonicalSnapshotJson(value.notes)) invalid('Keep normalized supplied notes.');
  fields(value.prerequisites, ['declaration', 'items']); if (value.prerequisites.declaration !== 'selected-and-user-supplied') invalid('Reference prerequisites are selected identities, not source grants.');
  const chosen = array(value.prerequisites.items, L.prerequisites).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Choose a supported recorded prerequisite.');
    if (!['analysis-reference', 'captured-workflow-reference'].includes(item.kind)) return prerequisite(item);
    fields(item, ['kind', 'reference', 'label', 'detail', 'role', 'reason', 'integrity', 'dataAccess', ...(item.kind === 'captured-workflow-reference' ? ['snapshotReference', 'stepId', 'port'] : [])]);
    if (item.role !== 'reference-only' || !['opaque', 'unsupported-view', 'restricted-or-unavailable', 'not-included'].includes(item.reason)
        || item.integrity !== 'not-checked' || item.dataAccess !== 'not-granted') invalid('A reference prerequisite grants no source, integrity or runtime capability.');
    return prerequisite({ kind: item.kind, reference: item.reference, label: item.label, detail: item.detail,
      ...(item.kind === 'captured-workflow-reference' ? { snapshotReference: item.snapshotReference, stepId: item.stepId, port: item.port } : {}) });
  });
  chosen.forEach((item, index) => {
    const original = value.prerequisites.items[index];
    if (item.label !== original.label || item.detail !== original.detail || item.reference && canonicalSnapshotJson(item.reference) !== canonicalSnapshotJson(original.reference)) invalid('Keep normalized selected prerequisite context.');
  });
  unique(chosen.filter(item => item.kind === 'analysis-reference'), item => canonicalSnapshotJson(item.reference));
  unique(chosen.filter(item => item.kind === 'captured-workflow-reference'), item => canonicalSnapshotJson({ snapshotReference: item.snapshotReference, stepId: item.stepId, port: item.port, reference: item.reference }));
  fields(value.reproduction, ['status', 'producingSource', 'runtime', 'dataAccess']);
  if (value.reproduction.status !== 'not-checked' || value.reproduction.producingSource !== 'not-established'
      || value.reproduction.runtime !== 'not-included' || value.reproduction.dataAccess !== 'not-granted') invalid('A snapshot does not establish reproduction or execution access.');
  const canonical = canonicalSnapshotJson(value, L.packageBytes);
  if (retained + new TextEncoder().encode(canonical).byteLength > L.retainedBytes) invalid('Retained evidence exceeds its byte budget.', true); return canonical;
}
