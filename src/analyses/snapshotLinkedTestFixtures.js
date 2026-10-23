// Test-only exact v2 identities and bodies. Production never imports this file.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { snapshotScope, snapshotTime, snapshotRecipe, snapshotRecord, snapshotAnalysisOption } from './snapshotPreparationTestFixtures';
import { ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA, ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2,
  ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA_V2, FIXED_RESULT_VIEW_SCHEMA_V2,
  normalizeAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage,
  canonicalAnalysisSnapshotResultView, canonicalAnalysisSnapshotDocumentSource, FIXED_DOCUMENT_SOURCE_SCHEMA,
  canonicalSnapshotJson } from '../../shared/analysisSnapshotPreparationDispatch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const linkedImageBytes = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVcoAAAAASUVORK5CYII=', 'base64');
export function linkedReference(changes = {}) {
  return { kind: 'artifact-version', versionId: 'art_' + '4'.repeat(24), sha256: 'a'.repeat(64), ...changes };
}
export function linkedImageResult(changes = {}) {
  return { kind: 'analysis-reference', reference: linkedReference({ sha256: hash(linkedImageBytes()) }), caption: 'Exact saved figure', view: { family: 'image' }, ...changes };
}
export function linkedRecipe(changes = {}) {
  const base = snapshotRecipe();
  return normalizeAnalysisSnapshotPreparation({ ...base, schema: ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2,
    results: [{ kind: 'analysis-reference', reference: linkedReference(), caption: 'Linked measured result', view: { family: 'table', offset: 0, limit: 25 } }], ...changes });
}
export function linkedTable(result) {
  const view = result.view || result;
  return { family: 'table', columns: ['sample', 'value'], rows: [['donor α', '3']], offset: view.spec?.offset ?? view.offset ?? 0,
    limit: view.spec?.limit ?? view.limit ?? 25, hasMore: false, scannedRows: (view.spec?.offset ?? view.offset ?? 0) + 1, truncated: false };
}
export const linkedTableBytes = result => Buffer.from(canonicalSnapshotJson(linkedTable(result)));
export function linkedRecord(input = linkedRecipe(), { state = 'ready', canPrepare = true, preparationId = 'asp_' + '9'.repeat(24),
  unavailable = false, analysisName, referenceReasons = [], ...changes } = {}) {
  const recipe = normalizeAnalysisSnapshotPreparation(input), base = snapshotRecord(snapshotRecipe({ ownerUserId: recipe.ownerUserId }));
  const results = recipe.results.map((chosen, index) => {
    const image = chosen.view.family === 'image', bytes = image ? linkedImageBytes() : linkedTableBytes(chosen);
    const source = { artifactId: chosen.reference.versionId.startsWith('av_') ? 'af_' + 'c'.repeat(24) : chosen.reference.versionId,
      versionId: chosen.reference.versionId, ownerUserId: recipe.ownerUserId, sha256: chosen.reference.sha256,
      sizeBytes: image ? bytes.length : 1024, name: image ? 'measured.png' : 'measured.csv',
      format: { id: image ? 'org.w3.png' : 'org.ietf.csv', version: '1' } };
    const origin = chosen.kind === 'attachment-revision' ? { kind: chosen.kind, attachment: { ...structuredClone(base.package.results[0].attachment),
      attachmentId: chosen.attachmentId, revisionId: chosen.revisionId, sourceOwnerUserId: recipe.ownerUserId } }
      : { kind: chosen.kind, reference: structuredClone(chosen.reference), analysisVersion: recipe.analysisVersion,
        caption: chosen.caption, captionOrigin: 'user-supplied' };
    const fixed = { schema: FIXED_RESULT_VIEW_SCHEMA_V2, family: chosen.view.family, spec: image ? null : { offset: chosen.view.offset, limit: chosen.view.limit },
      blobSha256: image ? chosen.reference.sha256 : hash(bytes), blobBytes: bytes.length, width: image ? 1 : null, height: image ? 1 : null };
    return { viewId: 'asv_' + (index + 10).toString(16).padStart(24, '0'), origin, source,
      view: { ...fixed, viewSha256: hash(canonicalAnalysisSnapshotResultView({ ...fixed, source: { artifactId: source.artifactId,
        versionId: source.versionId, projectId: recipe.projectId, sha256: source.sha256 } })) } };
  });
  const documents = recipe.documents.map((chosen, index) => {
    const item = { ...structuredClone(base.package.documents[index] || base.package.documents[0]), viewId: 'asv_' + (index + 100).toString(16).padStart(24, '0'),
      documentId: chosen.documentId, versionId: chosen.versionId, sha256: chosen.sha256, blobSha256: chosen.sha256 };
    item.viewSha256 = hash(canonicalAnalysisSnapshotDocumentSource({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA, source: chosen, blobSha256: chosen.sha256, blobBytes: item.blobBytes })); return item;
  });
  const pkg = { schema: ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA_V2, serviceId: recipe.serviceId, projectId: recipe.projectId, analysisId: recipe.analysisId,
    ownerUserId: recipe.ownerUserId, preparationId, createdAt: snapshotTime, analysis: snapshotAnalysisOption(recipe.analysisVersion, analysisName ? { name: analysisName } : {}),
    results, documents, notes: structuredClone(recipe.notes), prerequisites: { declaration: 'selected-and-user-supplied',
      items: recipe.prerequisites.map((item, index) => item.kind === 'analysis-reference'
        ? { ...structuredClone(item), role: 'reference-only', reason: referenceReasons[index] || 'restricted-or-unavailable', integrity: 'not-checked', dataAccess: 'not-granted' }
        : structuredClone(item)) }, reproduction: structuredClone(base.package.reproduction) };
  const snapshotSha256 = hash(canonicalAnalysisSnapshotPackage(pkg));
  return { ...base, schema: ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA, serviceId: recipe.serviceId, projectId: recipe.projectId, analysisId: recipe.analysisId,
    ownerUserId: recipe.ownerUserId, preparationId, requestId: recipe.requestId, requestSha256: hash(canonicalAnalysisSnapshotPreparation(recipe)),
    state, canPrepare, canResume: canPrepare && ['preparing', 'failed'].includes(state), canDelete: state !== 'deleted',
    recipe: state === 'deleted' ? null : recipe, package: state === 'ready' ? pkg : null,
    snapshotSha256: ['ready', 'deleted'].includes(state) ? snapshotSha256 : null,
    availability: state === 'ready' ? { status: unavailable ? 'unavailable' : 'available', views: results.map(item => ({ viewId: item.viewId, status: unavailable ? 'unavailable' : 'available' })),
      documents: documents.map(item => ({ documentId: item.documentId, versionId: item.versionId, status: 'available' })) } : null,
    failure: state === 'failed' ? { code: 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE', message: 'This exact source could not be verified.' } : null, ...changes };
}
export function linkedOptions({ analysisVersion = 2, reference = linkedReference(), viewFamily = 'table', reason = null,
  canPrepare = true, label = 'Saved linked measured result', items, nextCursor = null } = {}) {
  return { schema: ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA, serviceId: snapshotScope.serviceId, projectId: snapshotScope.projectId,
    analysisId: snapshotScope.analysisId, ownerUserId: snapshotScope.userId, canPrepare, kind: 'analysis-references', analysisVersion,
    items: items || [{ reference, label, viewFamily, referenceOnlyReason: reason, integrity: 'not-checked', availability: 'not-checked' }], nextCursor };
}
