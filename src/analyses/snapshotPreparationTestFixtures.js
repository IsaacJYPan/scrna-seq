// Test-only scientific identities and real canonical receipts. Production never imports this file.
import { createHash } from 'node:crypto';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import { ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA as schema, ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA,
  FIXED_RESULT_VIEW_SCHEMA, FIXED_DOCUMENT_SOURCE_SCHEMA, normalizeAnalysisSnapshotPreparation,
  canonicalAnalysisSnapshotPreparation, canonicalSnapshotJson, canonicalAnalysisSnapshotResultView,
  canonicalAnalysisSnapshotDocumentSource } from '../../shared/analysisSnapshotPreparation.mjs';

export const snapshotScope = { serviceId: 'svc_' + '1'.repeat(32), projectId: 'proj_' + '2'.repeat(16), analysisId: 'ra_' + '3'.repeat(24), userId: 7 };
export const snapshotTime = '2026-10-22T12:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const byteLength = value => new TextEncoder().encode(value).byteLength;
const emptyOrigin = () => ({ origin: null, sourceReference: null, documentReference: null, environmentReference: null });
export const savedSnapshotContent = { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'code_one', type: 'code', language: 'R', source: '\tncol(obj)  \r\n', metadata: {}, collapsed: false }], metadata: {} };
const sourceBytes = canonicalNotebookContent(savedSnapshotContent);
export function snapshotAnalysisOption(version = 2, changes = {}) {
  return { version, name: `PBMC saved question ${version}`, description: `Question retained in saved version ${version}.`, status: 'active', createdByUserId: 7,
    createdAt: snapshotTime, updatedAt: snapshotTime, revisionSha256: 'b'.repeat(64), ...changes };
}
export function snapshotResultOption(changes = {}) {
  const reference = { kind: 'artifact-version', versionId: 'av_' + '4'.repeat(24), sha256: 'a'.repeat(64) };
  return { attachmentId: 'raa_' + '7'.repeat(24), revisionId: 'rar_' + '8'.repeat(24), revisionNumber: 1, reference,
    caption: 'Measured expression contrast', suppliedOrigin: emptyOrigin(), createdByUserId: 8, createdAt: snapshotTime, sourceOwnerUserId: 7,
    source: { artifactId: 'af_' + 'c'.repeat(24), versionId: reference.versionId, sha256: reference.sha256, sizeBytes: 1024,
      name: 'measured.csv', format: { id: 'org.ietf.csv', version: '1' } }, families: ['table'], integrity: 'not-checked', ...changes };
}
export function snapshotDocumentOption(changes = {}) {
  return { documentId: 'doc_' + '5'.repeat(24), versionId: 'dv_' + '6'.repeat(24), version: 1, title: 'Supporting saved notebook',
    documentKind: 'notebook', defaultLanguage: 'R', sha256: hash(sourceBytes), contentBytes: byteLength(sourceBytes), actorUserId: 7,
    createdAt: snapshotTime, role: 'supporting-source', producingSource: 'not-established', ...changes };
}
export function snapshotRecipe(changes = {}) {
  const result = snapshotResultOption(), doc = snapshotDocumentOption();
  return normalizeAnalysisSnapshotPreparation({ requestId: '12345678-1234-4234-8234-123456789abc', serviceId: snapshotScope.serviceId,
    projectId: snapshotScope.projectId, analysisId: snapshotScope.analysisId, ownerUserId: snapshotScope.userId, analysisVersion: 2,
    results: [{ attachmentId: result.attachmentId, revisionId: result.revisionId, reference: result.reference, view: { family: 'table', offset: 0, limit: 25 } }],
    documents: [{ documentId: doc.documentId, versionId: doc.versionId, sha256: doc.sha256 }], notes: { summary: null, decisions: null, limitations: null }, prerequisites: [], ...changes });
}
export function snapshotRecord(input, { state = 'ready', canPrepare = true, preparationId = 'asp_' + '9'.repeat(24), analysisName, unavailable = false, failure } = {}) {
  const recipe = normalizeAnalysisSnapshotPreparation(input), results = recipe.results.map((item, index) => {
    const option = snapshotResultOption(), spec = item.view.family === 'table' ? { offset: item.view.offset, limit: item.view.limit } : null;
    const table = { family: 'table', columns: ['sample', 'value'], rows: [['donor α', '3']], offset: spec?.offset || 0, limit: spec?.limit || 25,
      hasMore: false, scannedRows: (spec?.offset || 0) + 1, truncated: false };
    const blob = canonicalSnapshotJson(table), source = { ...option.source, versionId: item.reference.versionId, sha256: item.reference.sha256 };
    const view = { schema: FIXED_RESULT_VIEW_SCHEMA, family: item.view.family, spec, blobSha256: hash(blob), blobBytes: byteLength(blob), width: null, height: null };
    const fullSource = { artifactId: source.artifactId, versionId: source.versionId, projectId: recipe.projectId, sha256: source.sha256 };
    return { viewId: 'asv_' + (index + 10).toString(16).padStart(24, '0'), attachment: { attachmentId: item.attachmentId, revisionId: item.revisionId,
      revisionNumber: option.revisionNumber, caption: option.caption, suppliedOrigin: option.suppliedOrigin, createdByUserId: option.createdByUserId, createdAt: snapshotTime, sourceOwnerUserId: recipe.ownerUserId },
    source, view: { ...view, viewSha256: hash(canonicalAnalysisSnapshotResultView({ ...view, source: fullSource })) } };
  });
  const documents = recipe.documents.map((item, index) => {
    const original = snapshotDocumentOption(), view = { schema: FIXED_DOCUMENT_SOURCE_SCHEMA, source: item, blobSha256: item.sha256, blobBytes: original.contentBytes };
    return { viewId: 'asv_' + (index + 100).toString(16).padStart(24, '0'), documentId: item.documentId, versionId: item.versionId, version: original.version, title: original.title,
      documentKind: original.documentKind, defaultLanguage: original.defaultLanguage, sha256: item.sha256, contentBytes: original.contentBytes, role: original.role,
      producingSource: original.producingSource, blobSha256: item.sha256, blobBytes: original.contentBytes, viewSha256: hash(canonicalAnalysisSnapshotDocumentSource(view)) };
  });
  const pkg = { schema: ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA, serviceId: recipe.serviceId, projectId: recipe.projectId, analysisId: recipe.analysisId, ownerUserId: recipe.ownerUserId,
    preparationId, createdAt: snapshotTime, analysis: snapshotAnalysisOption(recipe.analysisVersion, analysisName ? { name: analysisName } : {}), results, documents,
    notes: structuredClone(recipe.notes), prerequisites: { declaration: 'user-supplied', items: structuredClone(recipe.prerequisites) },
    reproduction: { status: 'not-checked', producingSource: 'not-established', runtime: 'not-included', dataAccess: 'not-granted' } };
  return { schema, serviceId: recipe.serviceId, projectId: recipe.projectId, analysisId: recipe.analysisId, ownerUserId: recipe.ownerUserId, preparationId,
    requestId: recipe.requestId, requestSha256: hash(canonicalAnalysisSnapshotPreparation(recipe)), createdAt: snapshotTime, updatedAt: snapshotTime, replayed: false,
    state, canPrepare, canResume: canPrepare && ['preparing', 'failed'].includes(state), canDelete: state !== 'deleted', recipe: state === 'deleted' ? null : recipe,
    snapshotSha256: ['ready', 'deleted'].includes(state) ? hash(canonicalSnapshotJson(pkg)) : null, package: state === 'ready' ? pkg : null,
    availability: state === 'ready' ? { status: unavailable ? 'unavailable' : 'available', views: results.map(item => ({ viewId: item.viewId, status: unavailable ? 'unavailable' : 'available' })),
      documents: documents.map(item => ({ documentId: item.documentId, versionId: item.versionId, status: 'available' })) } : null,
    failure: state === 'failed' ? failure || { code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE', message: 'The exact source could not be verified.' } : null };
}
export function snapshotSummary(value) {
  return { preparationId: value.preparationId, requestId: value.requestId, requestSha256: value.requestSha256, createdAt: value.createdAt, updatedAt: value.updatedAt,
    state: value.state, canResume: value.canResume, canDelete: value.canDelete, snapshotSha256: value.snapshotSha256,
    selection: value.state === 'deleted' ? null : { analysisVersion: value.recipe.analysisVersion,
      analysisName: value.package?.analysis.name || snapshotAnalysisOption(value.recipe.analysisVersion).name,
      resultCount: value.recipe.results.length, documentCount: value.recipe.documents.length, prerequisiteCount: value.recipe.prerequisites.length } };
}
export function snapshotList(records = [], canPrepare = true) {
  return { schema, serviceId: snapshotScope.serviceId, projectId: snapshotScope.projectId, analysisId: snapshotScope.analysisId, ownerUserId: 7, canPrepare,
    items: records.filter(value => value.state !== 'deleted').map(value => snapshotSummary({ ...value, canPrepare, canResume: canPrepare && ['preparing', 'failed'].includes(value.state) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.preparationId.localeCompare(a.preparationId)), nextCursor: null };
}
export function snapshotOptions(kind, canPrepare = true, items, analysisVersion = 2) {
  if (['analysis-references', 'analysis-typed-references'].includes(kind)) return { ...snapshotList([], canPrepare), kind, analysisVersion, items: items || [] };
  return { ...snapshotList([], canPrepare), kind, items: items || (kind === 'analysis-versions' ? [snapshotAnalysisOption(2), snapshotAnalysisOption(1)]
    : kind === 'results' ? [snapshotResultOption()] : [snapshotDocumentOption()]) };
}
