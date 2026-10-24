import { canonicalSnapshotJson, ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as L } from './analysisSnapshotPreparation.mjs';
import { validateResearchAnalysisReference } from './researchAnalysis.mjs';

export const ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_SCHEMA = 'traceomics.captured-workflow-context.v1';
export const ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_BINDING_SCHEMA = 'traceomics.captured-workflow-context-binding.v1';
export const ANALYSIS_SNAPSHOT_WORKFLOW_LIMITS = Object.freeze({ offeredParameters: 24, selectedParameters: 12, contextBytes: 16 * 1024,
  candidateContextBytes: 32 * 1024, outputs: 320, sourceBytes: 3 * 1024 * 1024, stateBytes: 2 * 1024 * 1024, environmentBytes: 256 * 1024 });
const W = ANALYSIS_SNAPSHOT_WORKFLOW_LIMITS, SHA = /^[a-f0-9]{64}$/, IDENTIFIER = /^[a-z][a-z0-9-]{1,39}$/;
const environmentKeys = ['id', 'manifestSha256', 'profileId', 'rVersion', 'bioconductor', 'imageDigest', 'imageId', 'snapshotScope'];
function capture(value, maximum = L.requestBytes) {
  // New context must not silently canonicalize a captured negative zero.
  const ancestors = new Set(); let nodes = 0;
  const numbers = (item, depth = 0) => {
    if (++nodes > L.nodes || depth > L.depth) invalid('Recorded context exceeds its structural bound.');
    if (typeof item === 'number' && Object.is(item, -0)) invalid('Recorded negative zero cannot be silently replaced.');
    if (!item || typeof item !== 'object') return;
    if (ancestors.has(item)) invalid('Recorded context must be acyclic plain JSON.'); ancestors.add(item);
    for (const property of Object.values(Object.getOwnPropertyDescriptors(item))) if (Object.hasOwn(property, 'value')) numbers(property.value, depth + 1);
    ancestors.delete(item);
  };
  numbers(value); return JSON.parse(canonicalSnapshotJson(value, maximum));
}
// Wire captures must check these new values before JSON canonicalization could
// erase -0. Inspect only data descriptors; legacy snapshot branches are unchanged.
export function assertAnalysisSnapshotWorkflowContextPayload(input) {
  const ancestors = new Set(); let nodes = 0;
  const visit = (value, depth = 0) => {
    if (++nodes > L.nodes || depth > L.depth) invalid('Recorded context payload exceeds its structural bound.');
    if (!value || typeof value !== 'object') return;
    if (ancestors.has(value)) invalid('Recorded context payload must be acyclic.'); ancestors.add(value);
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) if (Object.hasOwn(property, 'value')) {
      if (key === 'context') normalizeAnalysisSnapshotWorkflowContext(property.value);
      else if (key === 'contextOffer' && property.value !== null) normalizeAnalysisSnapshotWorkflowContextOffer(property.value);
      else visit(property.value, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(input);
}
function invalid(message) { throw Object.assign(new Error(message), { code: 'INVALID_ANALYSIS_SNAPSHOT_PREPARATION', status: 400 }); }
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid('Use only the exact recorded-context fields.');
}
function pattern(value, regex) { if (typeof value !== 'string' || !regex.test(value)) invalid('Keep an exact saved workflow identity.'); return value; }
function integer(value, min = 0, max = 2147483647) { if (!Number.isSafeInteger(value) || value < min || value > max || Object.is(value, -0)) invalid('A recorded context value is outside its supported bound.'); return value; }
function array(value, maximum) { if (!Array.isArray(value) || value.length > maximum) invalid('Recorded context exceeds its item bound.'); return value; }
function copiedLabel(value) {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || value.length > 100 || /[\p{Cc}]/u.test(value)) invalid('A recorded workflow label is invalid.'); return value;
}
function method(value) {
  if (value === null) return null;
  fields(value, ['id', 'name', 'version', 'digest', 'stepLabel', 'outputLabel']); pattern(value.id, IDENTIFIER);
  if (typeof value.version !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value.version)) invalid('Keep the recorded method version.');
  pattern(value.digest, SHA); copiedLabel(value.name); copiedLabel(value.stepLabel); copiedLabel(value.outputLabel); return value;
}
function parameter(value) {
  fields(value, ['key', 'type', 'label', 'value']); pattern(value.key, IDENTIFIER); copiedLabel(value.label);
  if (['integer', 'number'].includes(value.type)) {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value) || Object.is(value.value, -0)
        || Number.isInteger(value.value) && !Number.isSafeInteger(value.value) || value.type === 'integer' && !Number.isSafeInteger(value.value)) invalid('Choose an exact supported recorded numeric setting.');
  } else if (value.type === 'boolean') { if (typeof value.value !== 'boolean') invalid('A recorded boolean cannot be substituted.'); }
  else if (value.type === 'choice') pattern(value.value, /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,79}$/);
  else invalid('Only reviewed numeric, boolean and safe choice settings can be included.');
  return value;
}
function environment(value) {
  if (value === null) return null;
  fields(value, environmentKeys); pattern(value.manifestSha256, SHA);
  if (value.id !== `renv_${value.manifestSha256}` || value.snapshotScope !== 'container-userspace') invalid('Keep the exact recorded environment reference.');
  pattern(value.profileId, /^[a-z][a-z0-9.-]{0,99}$/); pattern(value.rVersion, /^\d+\.\d+\.\d+$/); pattern(value.bioconductor, /^\d+\.\d+$/);
  pattern(value.imageDigest, /^sha256:[a-f0-9]{64}$/); pattern(value.imageId, /^sha256:[a-f0-9]{64}$/); return value;
}
function offer(value, maximum) {
  fields(value, ['method', 'parameters', 'seed', 'environment']); method(value.method);
  array(value.parameters, maximum).forEach(parameter);
  if (new Set(value.parameters.map(item => item.key)).size !== value.parameters.length) invalid('Select each recorded setting once.');
  if (value.seed !== null) integer(value.seed); environment(value.environment); return value;
}
export function normalizeAnalysisSnapshotWorkflowContextOffer(input) {
  const value = capture(input, W.contextBytes * 2); return offer(value, W.offeredParameters);
}
export function normalizeAnalysisSnapshotWorkflowContextSelection(input) {
  const value = capture(input); fields(value, ['method', 'parameterKeys', 'seed', 'environment']);
  if (['method', 'seed', 'environment'].some(key => typeof value[key] !== 'boolean')) invalid('Explicitly choose each optional recorded context category.');
  array(value.parameterKeys, W.selectedParameters).forEach(key => pattern(key, IDENTIFIER));
  if (new Set(value.parameterKeys).size !== value.parameterKeys.length) invalid('Choose each recorded setting once.');
  return { method: value.method, parameterKeys: value.parameterKeys, seed: value.seed, environment: value.environment };
}
export function normalizeAnalysisSnapshotWorkflowOutputReference(input) {
  const value = capture(input); fields(value, ['snapshotReference', 'stepId', 'port', 'reference']);
  const snapshotReference = validateResearchAnalysisReference(value.snapshotReference), reference = validateResearchAnalysisReference(value.reference);
  if (snapshotReference.kind !== 'workflow-snapshot' || reference.kind !== 'artifact-version') invalid('Choose a recorded exact workflow output reference.');
  pattern(value.stepId, IDENTIFIER); pattern(value.port, IDENTIFIER);
  return { snapshotReference, stepId: value.stepId, port: value.port, reference };
}
export function normalizeAnalysisSnapshotWorkflowContext(input) {
  const value = capture(input, W.contextBytes); fields(value, ['schema', 'snapshotReference', 'stepId', 'port', 'relation', 'method', 'parameters', 'seed', 'environment']);
  if (value.schema !== ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_SCHEMA || value.relation !== 'recorded-in-capture') invalid('Recorded context does not establish producing code or runtime.');
  const ref = validateResearchAnalysisReference(value.snapshotReference); if (ref.kind !== 'workflow-snapshot') invalid('Choose an exact saved capture.');
  pattern(value.stepId, IDENTIFIER); pattern(value.port, IDENTIFIER);
  offer({ method: value.method, parameters: value.parameters, seed: value.seed, environment: value.environment }, W.selectedParameters); return value;
}
export function projectAnalysisSnapshotWorkflowContext(input) {
  const value = capture(input); fields(value, ['snapshotReference', 'stepId', 'port', 'offer', 'selection']);
  const offered = normalizeAnalysisSnapshotWorkflowContextOffer(value.offer), selected = normalizeAnalysisSnapshotWorkflowContextSelection(value.selection);
  if (selected.method && offered.method === null || selected.seed && offered.seed === null || selected.environment && offered.environment === null) invalid('The selected recorded context was not offered by this exact capture.');
  const parameters = selected.parameterKeys.map(key => { const item = offered.parameters.find(item => item.key === key); if (!item) invalid('A selected applied setting is missing; a method default cannot replace it.'); return item; });
  return normalizeAnalysisSnapshotWorkflowContext({ schema: ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_SCHEMA, snapshotReference: value.snapshotReference, stepId: value.stepId, port: value.port,
    relation: 'recorded-in-capture', method: selected.method ? offered.method : null, parameters, seed: selected.seed ? offered.seed : null,
    environment: selected.environment ? offered.environment : null });
}
export function canonicalAnalysisSnapshotWorkflowContextBinding(input) {
  const value = capture(input); fields(value, ['serviceId', 'projectId', 'analysisId', 'ownerUserId', 'analysisVersion', 'context']);
  pattern(value.serviceId, /^svc_[a-f0-9]{32}$/); pattern(value.projectId, /^proj_[a-f0-9]{16,40}$/); pattern(value.analysisId, /^ra_[a-f0-9]{24}$/);
  integer(value.ownerUserId, 1, Number.MAX_SAFE_INTEGER); integer(value.analysisVersion, 1); const context = normalizeAnalysisSnapshotWorkflowContext(value.context);
  return canonicalSnapshotJson({ schema: ANALYSIS_SNAPSHOT_WORKFLOW_CONTEXT_BINDING_SCHEMA, serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId,
    ownerUserId: value.ownerUserId, analysisVersion: value.analysisVersion, context }, L.requestBytes);
}
export function normalizeAnalysisSnapshotWorkflowContextEvidence(input, contextInput) {
  const context = normalizeAnalysisSnapshotWorkflowContext(contextInput), value = capture(input); fields(value, ['capture', 'environment']);
  if (value.capture !== 'fingerprint-checked' || value.environment !== (context.environment === null ? 'not-included' : 'manifest-checked')) invalid('Keep captured identity checks separate from environment verification and producing claims.');
  return value;
}
