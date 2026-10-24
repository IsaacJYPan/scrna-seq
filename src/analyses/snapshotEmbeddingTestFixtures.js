// Test-only fixed embedding identities. Production never imports these builders.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import previews from '../../backend/retainedTypedPreviews.js';
import { snapshotScope } from './snapshotPreparationTestFixtures';
import { typedRecipe, typedOptions } from './snapshotTypedTestFixtures';
import { workflowRecord, workflowOffer, workflowSelection, workflowContext, workflowSnapshotReference } from './snapshotWorkflowTestFixtures';
import { ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA, FIXED_RESULT_VIEW_SCHEMA_V3,
  normalizeAnalysisSnapshotTypedDescriptor, canonicalAnalysisSnapshotTypedDescriptor,
  normalizeAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage,
  canonicalAnalysisSnapshotResultView, canonicalAnalysisSnapshotWorkflowContextBinding, canonicalSnapshotJson } from '../../shared/analysisSnapshotPreparationDispatch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function embeddingValue({ count = 12, ids = true, groups = true } = {}) {
  return { x: Array.from({ length: count }, (_, i) => i / 3), y: Array.from({ length: count }, (_, i) => i ? -i / 7 : 0),
    ...(ids ? { ids: Array.from({ length: count }, (_, i) => `cell-${i}`) } : {}),
    ...(groups ? { groups: Array.from({ length: count }, (_, i) => i % 2 ? 'treated' : 'control') } : {}) };
}
export function embeddingDescriptor({ value = embeddingValue(), ...changes } = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return normalizeAnalysisSnapshotTypedDescriptor({ schema: ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA, id: 'eri_' + '8'.repeat(24), type: 'scatter',
    sha256: hash(bytes), sizeBytes: bytes.length, profileId: 'expert-r-seurat-v1',
    semantics: { role: 'primary', title: 'Recorded coordinate map', entityType: 'cell', axes: { x: { label: 'PC 1' }, y: { label: 'PC 2', unit: null } } }, ...changes });
}
export function embeddingRecipe({ value = embeddingValue(), descriptor = embeddingDescriptor({ value }), pointLimit = 5, captured = false,
  offer = workflowOffer(), selection = workflowSelection(), snapshotReference = workflowSnapshotReference(), stepId = 'counts', port = 'values', ...changes } = {}) {
  const base = typedRecipe(changes), selected = { kind: 'typed-analysis-reference', reference: { kind: 'artifact-version', versionId: descriptor.id, sha256: descriptor.sha256 },
    descriptorSha256: hash(canonicalAnalysisSnapshotTypedDescriptor(descriptor)), caption: 'Recorded coordinate finding', view: { family: 'embedding', pointLimit } };
  if (captured) {
    const context = workflowContext({ snapshotReference, stepId, port, offer, selection });
    Object.assign(selected, { kind: 'captured-workflow-output', snapshotReference, stepId, port, contextSelection: selection,
      contextSha256: hash(canonicalAnalysisSnapshotWorkflowContextBinding({ serviceId: base.serviceId, projectId: base.projectId, analysisId: base.analysisId,
        ownerUserId: base.ownerUserId, analysisVersion: base.analysisVersion, context })) });
  }
  return normalizeAnalysisSnapshotPreparation({ ...base, results: changes.results || [selected] });
}
export function embeddingBody(result, value = embeddingValue(), projectId = snapshotScope.projectId) {
  return previews.projectRetainedEmbedding({ source: { artifactId: result.source.artifactId, versionId: result.source.versionId, projectId, sha256: result.source.sha256 },
    value, pointLimit: result.view.spec.pointLimit, semantics: result.view.semantics, responseBytes: 256 * 1024 });
}
export const embeddingBytes = (result, value, projectId) => Buffer.from(canonicalSnapshotJson(embeddingBody(result, value, projectId)));
export function embeddingRecord(input = embeddingRecipe(), { values = [], descriptors = [], ...options } = {}) {
  // The older table fixture intentionally strips captured context. Give each
  // temporary embedding a different excerpt so that this test-only surrogate
  // cannot collapse distinct bounds or contexts before restoring real views.
  const recipe = normalizeAnalysisSnapshotPreparation(input), surrogate = { ...recipe, results: recipe.results.map((item, index) => item.view.family === 'embedding'
    ? { ...item, view: { family: 'table', offset: 1000 + index, limit: 25 } } : item) };
  const base = workflowRecord(surrogate, options), { state: _state, ...readyOptions } = options;
  const pkg = workflowRecord(surrogate, readyOptions).package;
  pkg.results.forEach((result, index) => {
    const chosen = recipe.results[index]; if (chosen.view.family !== 'embedding') return;
    const value = values[index] || embeddingValue(), descriptor = descriptors[index] || embeddingDescriptor({ value, id: chosen.reference.versionId, sha256: chosen.reference.sha256 });
    result.source = { ...result.source, format: { id: 'org.traceomics.coordinates', version: '1' }, name: 'recorded-coordinates.json', sizeBytes: descriptor.sizeBytes };
    result.view = { schema: FIXED_RESULT_VIEW_SCHEMA_V3, family: 'embedding', spec: { pointLimit: chosen.view.pointLimit }, width: null, height: null,
      descriptorSha256: chosen.descriptorSha256, semantics: descriptor.semantics, blobSha256: '', blobBytes: 0 };
    const bytes = embeddingBytes(result, value, recipe.projectId); result.view.blobBytes = bytes.length; result.view.blobSha256 = hash(bytes);
    result.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...result.view,
      source: { artifactId: result.source.artifactId, versionId: result.source.versionId, projectId: recipe.projectId, sha256: result.source.sha256 } }));
  });
  const snapshotSha256 = hash(canonicalAnalysisSnapshotPackage(pkg));
  return { ...base, recipe: base.state === 'deleted' ? null : recipe, requestSha256: hash(canonicalAnalysisSnapshotPreparation(recipe)),
    snapshotSha256: ['ready', 'deleted'].includes(base.state) ? snapshotSha256 : null, package: base.state === 'ready' ? pkg : null };
}
export function embeddingOptions({ captured = false, descriptor = embeddingDescriptor(), offer = workflowOffer(), snapshotReference = workflowSnapshotReference(), items, ...changes } = {}) {
  const base = typedOptions({ family: 'embedding', descriptor, ...changes });
  if (!captured) return { ...base, items: items || base.items };
  const selected = base.items[0];
  return { ...base, kind: 'captured-workflow-outputs', snapshotReference, items: items || [{ stepId: 'counts', stepLabel: 'Summarize conditions', port: 'values', outputLabel: 'Recorded condition values',
    reference: selected.reference, viewFamily: 'embedding', descriptor, descriptorSha256: selected.descriptorSha256, referenceOnlyReason: null, contextOffer: offer,
    integrity: 'not-checked', availability: 'not-checked' }] };
}
