// Test-only literal inert source fixtures. Production never imports this file.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { snapshotScope } from './snapshotPreparationTestFixtures';
import { linkedRecipe } from './snapshotLinkedTestFixtures';
import { embeddingRecord } from './snapshotEmbeddingTestFixtures';
import { FIXED_RESULT_VIEW_SCHEMA_V4, normalizeAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPreparation,
  canonicalAnalysisSnapshotPackage, canonicalAnalysisSnapshotResultView, canonicalAnalysisSnapshotInertBody, projectAnalysisSnapshotInertPrefix } from '../../shared/analysisSnapshotPreparationDispatch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const inertValue = (formatId = 'org.ietf.text') => formatId === 'org.ietf.json'
  ? '{"large":9007199254740993,"dup":1,"dup":2,"markup":"<b>inert</b>"}\r\n'
  : '\uFEFF# Selected source\r\nprint("<b>inert</b>")\r\n';
export function inertRecipe({ formatId = 'org.ietf.text', text = inertValue(formatId), maxBytes = 16384, versionId = 'av_' + '8'.repeat(24), ...changes } = {}) {
  const base = linkedRecipe(changes);
  return normalizeAnalysisSnapshotPreparation({ ...base, results: changes.results || [{ kind: 'inert-analysis-reference',
    reference: { kind: 'artifact-version', versionId, sha256: hash(Buffer.from(text)) }, caption: 'Selected inert source text', view: { family: 'text', maxBytes }, includeSourceText: true }] });
}
export function inertBody(result, text = inertValue(result.source.format.id), projectId = snapshotScope.projectId) {
  const bytes = Buffer.from(text);
  return projectAnalysisSnapshotInertPrefix({ source: { artifactId: result.source.artifactId, versionId: result.source.versionId, projectId, sha256: result.source.sha256 },
    sourceFormatId: result.source.format.id, sourceBytes: result.source.sizeBytes, maxBytes: result.view.spec.maxBytes,
    bytes: bytes.subarray(0, Math.min(result.source.sizeBytes, result.view.spec.maxBytes)) });
}
export const inertBytes = (result, text, projectId) => Buffer.from(canonicalAnalysisSnapshotInertBody(inertBody(result, text, projectId)));
export function inertRecord(input = inertRecipe(), { values = [], formats = [], embeddingValues = [], ...options } = {}) {
  const recipe = normalizeAnalysisSnapshotPreparation(input), surrogate = { ...recipe, results: recipe.results.map((item, index) => item.kind === 'inert-analysis-reference'
    ? { kind: 'analysis-reference', reference: item.reference, caption: item.caption, view: { family: 'table', offset: 2000 + index, limit: 25 } } : item) };
  const base = embeddingRecord(surrogate, { ...options, values: embeddingValues }), { state: _state, ...readyOptions } = options;
  const pkg = embeddingRecord(surrogate, { ...readyOptions, values: embeddingValues }).package;
  pkg.results.forEach((result, index) => {
    const chosen = recipe.results[index]; if (chosen.kind !== 'inert-analysis-reference') return;
    const formatId = formats[index] || 'org.ietf.text', text = values[index] ?? inertValue(formatId);
    result.source = { ...result.source, name: formatId === 'org.ietf.json' ? 'selected-source.json' : 'selected-source.txt', sizeBytes: Buffer.byteLength(text), format: { id: formatId, version: '1' } };
    result.origin = { kind: chosen.kind, reference: chosen.reference, analysisVersion: recipe.analysisVersion, caption: chosen.caption, captionOrigin: 'user-supplied', includeSourceText: true };
    result.view = { schema: FIXED_RESULT_VIEW_SCHEMA_V4, family: 'text', spec: { maxBytes: chosen.view.maxBytes }, width: null, height: null, blobSha256: '', blobBytes: 0 };
    const bytes = inertBytes(result, text, recipe.projectId); result.view.blobSha256 = hash(bytes); result.view.blobBytes = bytes.length;
    result.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...result.view,
      source: { artifactId: result.source.artifactId, versionId: result.source.versionId, projectId: recipe.projectId, sha256: result.source.sha256 } }));
  });
  const snapshotSha256 = hash(canonicalAnalysisSnapshotPackage(pkg));
  return { ...base, recipe: base.state === 'deleted' ? null : recipe, requestSha256: hash(canonicalAnalysisSnapshotPreparation(recipe)),
    snapshotSha256: ['ready', 'deleted'].includes(base.state) ? snapshotSha256 : null, package: base.state === 'ready' ? pkg : null };
}
export function inertOptions({ formatId = 'org.ietf.text', text = inertValue(formatId), versionId = 'av_' + '8'.repeat(24), items, analysisVersion = 2, ...changes } = {}) {
  return { schema: 'traceomics.analysis-snapshot-preparation.v1', serviceId: snapshotScope.serviceId, projectId: snapshotScope.projectId, analysisId: snapshotScope.analysisId,
    ownerUserId: snapshotScope.userId, canPrepare: true, kind: 'analysis-inert-references', analysisVersion,
    items: items || [{ reference: { kind: 'artifact-version', versionId, sha256: hash(Buffer.from(text)) }, label: formatId === 'org.ietf.json' ? 'Selected JSON source' : 'Selected text source',
      viewFamily: 'text', sourceFormatId: formatId, sourceBytes: Buffer.byteLength(text), integrity: 'not-checked', availability: 'not-checked' }], nextCursor: null, ...changes };
}
