import { canonicalSnapshotJson } from './analysisSnapshotPreparation.mjs';

export const FIXED_RESULT_VIEW_SCHEMA_V4 = 'traceomics.fixed-result-view.v4';
export const ANALYSIS_SNAPSHOT_INERT_LIMITS = Object.freeze({ sourceBytes: 200 * 1024 * 1024, prefixBytes: 16 * 1024, responseBytes: 256 * 1024 });
export const ANALYSIS_SNAPSHOT_INERT_FORMATS = Object.freeze(['org.ietf.text', 'org.ietf.json']);
const L = ANALYSIS_SNAPSHOT_INERT_LIMITS, SHA = /^[a-f0-9]{64}$/, VERSION = /^(?:av|eri)_[a-f0-9]{16,40}$/;
const ARTIFACT = /^(?:af|av|eri)_[a-f0-9]{16,40}$/, PROJECT = /^proj_[a-f0-9]{16,40}$/;
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteArrayName = Object.getOwnPropertyDescriptor(arrayPrototype, Symbol.toStringTag).get;
const byteArrayLength = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteLength').get;
const encoder = new TextEncoder();
function invalid(message, large = false) {
  throw Object.assign(new Error(message), { code: large ? 'ANALYSIS_SNAPSHOT_PREPARATION_TOO_LARGE' : 'INVALID_ANALYSIS_SNAPSHOT_PREPARATION', status: large ? 413 : 400 });
}
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Use a plain inert-prefix object.');
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) || actual.some(key => typeof key !== 'string' || !keys.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid('Use only the exact inert-prefix fields.');
}
function pattern(value, expression) { if (typeof value !== 'string' || !expression.test(value)) invalid('Keep an exact inert source identity.'); }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) invalid('An inert-prefix bound is unsupported.'); }
function source(value) {
  fields(value, ['artifactId', 'versionId', 'projectId', 'sha256']);
  pattern(value.artifactId, ARTIFACT); pattern(value.versionId, VERSION); pattern(value.projectId, PROJECT); pattern(value.sha256, SHA);
}
const capture = value => JSON.parse(canonicalSnapshotJson(value, L.responseBytes));
function spec(value) { fields(value, ['maxBytes']); integer(value.maxBytes, 1, L.prefixBytes); }

export function canonicalAnalysisSnapshotResultViewV4(input) {
  const value = capture(input);
  fields(value, ['schema', 'source', 'family', 'spec', 'blobSha256', 'blobBytes', 'width', 'height']);
  if (value.schema !== FIXED_RESULT_VIEW_SCHEMA_V4 || value.family !== 'text' || value.width !== null || value.height !== null) invalid('Use the known fixed source-prefix schema.');
  source(value.source); spec(value.spec); pattern(value.blobSha256, SHA); integer(value.blobBytes, 1, L.responseBytes);
  return canonicalSnapshotJson(value, L.responseBytes);
}

export function canonicalAnalysisSnapshotInertBody(input) {
  // Check numeric facts before JSON could erase negative zero.
  fields(input, ['family', 'representation', 'source', 'sourceFormatId', 'text', 'sourceBytes', 'maxBytes', 'includedSourceBytes', 'truncated', 'syntax']);
  integer(input.sourceBytes, 0, L.sourceBytes); integer(input.maxBytes, 1, L.prefixBytes); integer(input.includedSourceBytes, 0, L.prefixBytes);
  const value = capture(input); source(value.source);
  if (value.family !== 'text' || value.representation !== 'utf8-source-prefix' || value.syntax !== 'not-checked'
      || !ANALYSIS_SNAPSHOT_INERT_FORMATS.includes(value.sourceFormatId) || typeof value.text !== 'string' || !value.text.isWellFormed()) invalid('Keep a literal known UTF8 source-prefix representation.');
  const length = encoder.encode(value.text).byteLength, maximum = Math.min(value.maxBytes, value.sourceBytes);
  if (length !== value.includedSourceBytes || length > maximum || maximum - length > 3
      || value.sourceBytes <= value.maxBytes && length !== value.sourceBytes || value.truncated !== (length < value.sourceBytes)) invalid('The retained source byte facts do not match the exact text prefix.');
  return canonicalSnapshotJson(value, L.responseBytes);
}

export function projectAnalysisSnapshotInertPrefix(input) {
  fields(input, ['source', 'sourceFormatId', 'sourceBytes', 'maxBytes', 'bytes']);
  integer(input.sourceBytes, 0, L.sourceBytes); integer(input.maxBytes, 1, L.prefixBytes);
  const ref = capture(input.source); source(ref);
  if (!ANALYSIS_SNAPSHOT_INERT_FORMATS.includes(input.sourceFormatId)) invalid('Choose an owned declared plain-text or JSON source.');
  const bytes = input.bytes;
  if (!ArrayBuffer.isView(bytes) || byteArrayName.call(bytes) !== 'Uint8Array' || byteArrayLength.call(bytes) !== Math.min(input.sourceBytes, input.maxBytes)) invalid('Supply only the exact bounded prefix bytes.');
  const copied = new Uint8Array(byteArrayLength.call(bytes)); Uint8Array.prototype.set.call(copied, bytes);
  let text;
  try { text = new globalThis.TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copied, { stream: input.sourceBytes > input.maxBytes }); }
  catch { invalid('The included source prefix requires valid UTF8 without replacement characters.'); }
  const body = { family: 'text', representation: 'utf8-source-prefix', source: ref, sourceFormatId: input.sourceFormatId,
    text, sourceBytes: input.sourceBytes, maxBytes: input.maxBytes, includedSourceBytes: encoder.encode(text).byteLength,
    truncated: encoder.encode(text).byteLength < input.sourceBytes, syntax: 'not-checked' };
  canonicalAnalysisSnapshotInertBody(body); return body;
}
