import * as legacy from './analysisSnapshotPreparation.mjs';
import * as linked from './analysisSnapshotPreparationV2.mjs';
import * as typed from './analysisSnapshotTypedResult.mjs';
export * from './analysisSnapshotPreparation.mjs';
export * from './analysisSnapshotPreparationV2.mjs';
export * from './analysisSnapshotTypedResult.mjs';
export * from './analysisSnapshotWorkflowContext.mjs';

function schema(value, optional = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return unsupported();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'schema');
  if (!descriptor && optional) return null;
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return unsupported();
  return descriptor.value;
}
function unsupported() {
  throw Object.assign(new Error('This exact snapshot schema is not supported. Keep the original request.'), { status: 400, code: 'ANALYSIS_SNAPSHOT_SCHEMA_UNSUPPORTED' });
}
export function normalizeAnalysisSnapshotPreparation(input) {
  const version = schema(input, true);
  return version === null ? legacy.normalizeAnalysisSnapshotPreparation(input)
    : version === linked.ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2 ? linked.normalizeAnalysisSnapshotPreparationV2(input) : unsupported();
}
export function canonicalAnalysisSnapshotPreparation(input) {
  const version = schema(input, true);
  return version === null ? legacy.canonicalAnalysisSnapshotPreparation(input)
    : version === linked.ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2 ? linked.canonicalAnalysisSnapshotPreparationV2(input) : unsupported();
}
export function canonicalAnalysisSnapshotPackage(input) {
  const version = schema(input);
  return version === legacy.ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA ? legacy.canonicalAnalysisSnapshotPackage(input)
    : version === linked.ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA_V2 ? linked.canonicalAnalysisSnapshotPackageV2(input) : unsupported();
}
export function canonicalAnalysisSnapshotResultView(input) {
  const version = schema(input);
  return version === legacy.FIXED_RESULT_VIEW_SCHEMA ? legacy.canonicalAnalysisSnapshotResultView(input)
    : version === linked.FIXED_RESULT_VIEW_SCHEMA_V2 ? linked.canonicalAnalysisSnapshotResultViewV2(input)
      : version === typed.FIXED_RESULT_VIEW_SCHEMA_V3 ? typed.canonicalAnalysisSnapshotResultViewV3(input) : unsupported();
}
