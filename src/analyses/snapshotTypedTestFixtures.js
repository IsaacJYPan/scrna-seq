// Test-only exact typed identities and retained bodies. No production imports.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { snapshotScope } from './snapshotPreparationTestFixtures';
import { linkedRecipe, linkedRecord, linkedImageBytes } from './snapshotLinkedTestFixtures';
import { ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA, FIXED_RESULT_VIEW_SCHEMA_V3,
  normalizeAnalysisSnapshotTypedDescriptor, canonicalAnalysisSnapshotTypedDescriptor, projectAnalysisSnapshotJsonTable,
  normalizeAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage,
  canonicalAnalysisSnapshotResultView, canonicalSnapshotJson } from '../../shared/analysisSnapshotPreparationDispatch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const typedImageBytes = linkedImageBytes;
export const typedValue = (family = 'table') => family === 'metrics'
  ? { nCells: 0, coverage: 1.25, passed: false, missing: null, note: '' }
  : [{ missing: null, failed: false, passed: true, zero: 0, empty: '', fraction: 1.25, text: 'null', sample: 'donor 🧬' }];
export function typedDescriptor(changes = {}) {
  const type = changes.type || 'table', family = type === 'figure' ? 'image' : type;
  const bytes = family === 'image' ? typedImageBytes() : Buffer.from(JSON.stringify(typedValue(family)));
  const semantics = type === 'metrics' ? { role: 'diagnostic', title: 'Recorded QC metrics', metrics: { nCells: { label: 'Cells', unit: 'cells' }, coverage: { label: 'Coverage', unit: '%' } } }
    : { role: 'primary', title: type === 'figure' ? 'Recorded measured figure' : 'Recorded scalar table' };
  return normalizeAnalysisSnapshotTypedDescriptor({ schema: ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA, id: 'eri_' + '6'.repeat(24),
    type, sha256: hash(bytes), sizeBytes: bytes.length, profileId: 'expert-r-seurat-v1', semantics, ...changes });
}
export function typedRecipe({ family = 'table', descriptor = typedDescriptor({ type: family === 'image' ? 'figure' : family }), ...changes } = {}) {
  return normalizeAnalysisSnapshotPreparation({ ...linkedRecipe(), ...changes,
    results: changes.results || [{ kind: 'typed-analysis-reference', reference: { kind: 'artifact-version', versionId: descriptor.id, sha256: descriptor.sha256 },
      descriptorSha256: hash(canonicalAnalysisSnapshotTypedDescriptor(descriptor)), caption: 'Recorded measured finding',
      view: family === 'table' ? { family, offset: 0, limit: 25 } : { family } }] });
}
function bodySource(result) { return { artifactId: result.source.artifactId, versionId: result.source.versionId, projectId: snapshotScope.projectId, sha256: result.source.sha256 }; }
export function typedTable(result) {
  return projectAnalysisSnapshotJsonTable({ source: bodySource(result), descriptor: typedDescriptor({ id: result.source.versionId, sha256: result.source.sha256,
    sizeBytes: result.source.sizeBytes, semantics: result.view.semantics }), value: typedValue(), offset: result.view.spec.offset, limit: result.view.spec.limit });
}
export const typedTableBytes = result => Buffer.from(canonicalSnapshotJson(typedTable(result)));
export function typedMetrics(result) {
  const semantics = result.view.semantics;
  return { family: 'metrics', source: bodySource(result), semantics: { role: semantics.role, title: semantics.title },
    items: Object.entries(typedValue('metrics')).map(([key, value]) => ({ key, value, label: semantics.metrics[key]?.label ?? null, unit: semantics.metrics[key]?.unit ?? null })) };
}
export const typedMetricsBytes = result => Buffer.from(canonicalSnapshotJson(typedMetrics(result)));
export function typedRecord(input = typedRecipe(), { descriptors = [], ...options } = {}) {
  const recipe = normalizeAnalysisSnapshotPreparation(input), surrogate = { ...recipe, results: recipe.results.map(item => item.kind === 'typed-analysis-reference'
    ? { kind: 'analysis-reference', reference: item.reference, caption: item.caption, view: item.view.family === 'metrics' ? { family: 'table', offset: 0, limit: 25 } : item.view } : item) };
  const base = linkedRecord(surrogate, options), template = linkedRecord(surrogate);
  template.package.results.forEach((result, index) => {
    const chosen = recipe.results[index]; if (chosen.kind !== 'typed-analysis-reference') return;
    const descriptor = descriptors[index] || typedDescriptor({ id: chosen.reference.versionId, sha256: chosen.reference.sha256, type: chosen.view.family === 'image' ? 'figure' : chosen.view.family });
    result.origin.kind = chosen.kind; result.source.format = { id: { table: 'org.traceomics.table', metrics: 'org.ietf.json', image: 'org.w3.png' }[chosen.view.family], version: '1' };
    result.source.sizeBytes = descriptor.sizeBytes; result.source.name = chosen.view.family === 'image' ? 'recorded.png' : 'recorded.json';
    result.view = { schema: FIXED_RESULT_VIEW_SCHEMA_V3, family: chosen.view.family,
      spec: chosen.view.family === 'table' ? { offset: chosen.view.offset, limit: chosen.view.limit } : null,
      descriptorSha256: chosen.descriptorSha256, semantics: descriptor.semantics, blobSha256: '', blobBytes: 0,
      width: chosen.view.family === 'image' ? 1 : null, height: chosen.view.family === 'image' ? 1 : null };
    const bytes = chosen.view.family === 'image' ? typedImageBytes() : chosen.view.family === 'metrics' ? typedMetricsBytes(result) : typedTableBytes(result);
    result.view.blobSha256 = hash(bytes); result.view.blobBytes = bytes.length;
    result.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...result.view, source: bodySource(result) }));
  });
  const pkg = template.package, snapshotSha256 = hash(canonicalAnalysisSnapshotPackage(pkg));
  return { ...base, recipe: base.state === 'deleted' ? null : recipe, requestSha256: hash(canonicalAnalysisSnapshotPreparation(recipe)),
    snapshotSha256: ['ready', 'deleted'].includes(base.state) ? snapshotSha256 : null, package: base.state === 'ready' ? pkg : null };
}
export function typedOptions({ family = 'table', descriptor = typedDescriptor({ type: family === 'image' ? 'figure' : family }), analysisVersion = 2, items, ...changes } = {}) {
  return { schema: 'traceomics.analysis-snapshot-preparation.v1', serviceId: snapshotScope.serviceId, projectId: snapshotScope.projectId, analysisId: snapshotScope.analysisId,
    ownerUserId: snapshotScope.userId, canPrepare: true, kind: 'analysis-typed-references', analysisVersion,
    items: items || [{ reference: { kind: 'artifact-version', versionId: descriptor.id, sha256: descriptor.sha256 }, label: 'Recorded typed measured result', viewFamily: family,
      descriptor, descriptorSha256: hash(canonicalAnalysisSnapshotTypedDescriptor(descriptor)), integrity: 'not-checked', availability: 'not-checked' }], nextCursor: null, ...changes };
}
