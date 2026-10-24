import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as L, canonicalSnapshotJson } from './analysisSnapshotPreparation.mjs';
import { validateResultSemantics } from './resultSemantics.mjs';

export const ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA = 'traceomics.retained-output-descriptor.v1';
export const FIXED_RESULT_VIEW_SCHEMA_V3 = 'traceomics.fixed-result-view.v3';
export const ANALYSIS_SNAPSHOT_SCALAR_MODEL = 'finite-ieee754-safe-integers.v1';
export const ANALYSIS_SNAPSHOT_TYPED_LIMITS = Object.freeze({ sourceBytes: 5 * 1024 * 1024, sourceRows: 50000,
  columns: 100, columnCharacters: 100, cellCharacters: 2000, metrics: 40, metricKeyCharacters: 100,
  responseBytes: 256 * 1024, rows: 100, offset: 10000, depth: 4, nodes: 1100000 });
const T = ANALYSIS_SNAPSHOT_TYPED_LIMITS, SHA = /^[a-f0-9]{64}$/, VERSION = /^(?:av|art|eri)_[a-f0-9]{16,40}$/;
const ARTIFACT = /^(?:af|av|art|eri)_[a-f0-9]{16,40}$/, PROJECT = /^proj_[a-f0-9]{16,40}$/;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
// JSON object key order can carry table column order. Native Object.keys sorts
// integer-index keys; retain the checked source order outside the public value.
const sourceKeyOrders = new WeakMap();
function invalid(message, large = false) {
  throw Object.assign(new Error(message), { code: large ? 'ANALYSIS_SNAPSHOT_PREPARATION_TOO_LARGE' : 'INVALID_ANALYSIS_SNAPSHOT_PREPARATION', status: large ? 413 : 400 });
}
const capture = (value, maximum = L.packageBytes) => JSON.parse(canonicalSnapshotJson(value, maximum));
function fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Use a plain typed result object.');
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) || actual.some(key => typeof key !== 'string' || !keys.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid('Use only the exact typed result fields.');
}
function array(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid('Typed rows must be bounded dense arrays.');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('Typed rows cannot contain holes or accessors.');
  }
  return value;
}
function pattern(value, expression) { if (typeof value !== 'string' || !expression.test(value)) invalid('Keep an exact typed result identity.'); }
function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) invalid('A typed result exceeds its supported bound.'); }
function source(value) {
  fields(value, ['artifactId', 'versionId', 'projectId', 'sha256']); pattern(value.artifactId, ARTIFACT); pattern(value.versionId, VERSION); pattern(value.projectId, PROJECT); pattern(value.sha256, SHA);
}
function scalar(value) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string' && value.isWellFormed() && value.length <= T.cellCharacters) return;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  invalid('A typed cell must retain a supported JSON scalar without conversion.');
}
function semantics(value, type) {
  let result; try { result = validateResultSemantics(value, type); } catch { invalid('The trusted typed meaning is unsupported.'); }
  return result;
}
export function normalizeAnalysisSnapshotTypedDescriptor(input) {
  const value = capture(input); fields(value, ['schema', 'id', 'type', 'sha256', 'sizeBytes', 'profileId', 'semantics']);
  if (value.schema !== ANALYSIS_SNAPSHOT_TYPED_DESCRIPTOR_SCHEMA || !['table', 'metrics', 'figure'].includes(value.type)) invalid('Choose a supported trusted typed result.');
  pattern(value.id, VERSION); pattern(value.sha256, SHA);
  integer(value.sizeBytes, 1, value.type === 'figure' ? L.imageBytes : T.sourceBytes);
  if (value.profileId !== null && (typeof value.profileId !== 'string' || value.profileId.length > 120
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.profileId) || reserved.has(value.profileId))) invalid('Keep a bounded recorded profile identity.');
  return { schema: value.schema, id: value.id, type: value.type, sha256: value.sha256, sizeBytes: value.sizeBytes, profileId: value.profileId,
    semantics: semantics(value.semantics, value.type) };
}
export const canonicalAnalysisSnapshotTypedDescriptor = input => canonicalSnapshotJson(normalizeAnalysisSnapshotTypedDescriptor(input), L.packageBytes);
export function canonicalAnalysisSnapshotResultViewV3(input) {
  const value = capture(input); fields(value, ['schema', 'source', 'family', 'spec', 'blobSha256', 'blobBytes', 'width', 'height', 'descriptorSha256', 'semantics']);
  if (value.schema !== FIXED_RESULT_VIEW_SCHEMA_V3 || !['table', 'metrics', 'image'].includes(value.family)) invalid('Use the known fixed typed view schema.');
  source(value.source); pattern(value.blobSha256, SHA); pattern(value.descriptorSha256, SHA);
  const type = value.family === 'image' ? 'figure' : value.family, meaning = semantics(value.semantics, type);
  if (canonicalSnapshotJson(meaning) !== canonicalSnapshotJson(value.semantics)) invalid('Keep the normalized trusted result meaning.');
  if (value.family === 'table') {
    fields(value.spec, ['offset', 'limit']); integer(value.spec.offset, 0, T.offset); integer(value.spec.limit, 1, T.rows);
  } else if (value.spec !== null) invalid('A fixed metric or raster has no query settings.');
  integer(value.blobBytes, 1, value.family === 'image' ? L.imageBytes : T.responseBytes);
  if (value.family === 'image') {
    integer(value.width, 1, 100000); integer(value.height, 1, 100000); if (value.width * value.height > L.imagePixels) invalid('The typed raster exceeds its pixel budget.', true);
  } else if (value.width !== null || value.height !== null) invalid('Scalar typed results have no raster dimensions.');
  return canonicalSnapshotJson(value, L.packageBytes);
}

// Only the new typed adapter uses this bounded source guard. Original notebook
// and generic artifact parsers retain their existing contracts.
export function parseAnalysisSnapshotScalarJson(input) {
  if (typeof input !== 'string' || !input.isWellFormed()) invalid('Typed source must be well-formed UTF-8 JSON.');
  if (new TextEncoder().encode(input).length > T.sourceBytes) invalid('Typed JSON exceeds its complete source budget.', true);
  let offset = 0, nodes = 0;
  const malformed = () => invalid('Typed source must contain complete ordinary JSON.');
  const whitespace = () => { while (offset < input.length && /[\t\n\r ]/.test(input[offset])) offset++; };
  const string = () => {
    if (input[offset] !== '"') malformed(); const start = offset++;
    while (offset < input.length) { const char = input[offset++]; if (char === '\\') offset++; else if (char === '"') { const result = JSON.parse(input.slice(start, offset)); if (!result.isWellFormed()) malformed(); return result; } }
    return malformed();
  };
  const value = depth => {
    if (depth > T.depth || ++nodes > T.nodes) invalid('Typed JSON exceeds its structural budget.', true);
    whitespace(); const char = input[offset];
    if (char === '{') {
      offset++; whitespace(); const object = {}, keys = new Set(); sourceKeyOrders.set(object, []);
      if (input[offset] === '}') { offset++; return object; }
      while (offset < input.length) {
        whitespace(); const key = string(); if (keys.has(key) || reserved.has(key)) invalid('Typed JSON contains duplicate or unsafe object keys.'); keys.add(key);
        whitespace(); if (input[offset++] !== ':') malformed(); const child = value(depth + 1);
        Object.defineProperty(object, key, { value: child, enumerable: true, writable: true, configurable: true }); sourceKeyOrders.get(object).push(key);
        whitespace(); const end = input[offset++]; if (end === '}') return object; if (end !== ',') malformed();
      }
      malformed();
    } else if (char === '[') {
      offset++; whitespace(); const items = []; if (input[offset] === ']') { offset++; return items; }
      while (offset < input.length) { items.push(value(depth + 1)); whitespace(); const end = input[offset++]; if (end === ']') return items; if (end !== ',') malformed(); } malformed();
    } else if (char === '"') return string();
    else {
      const start = offset; while (offset < input.length && !/[\t\n\r ,}\]]/.test(input[offset])) offset++; const token = input.slice(start, offset);
      if (['true', 'false', 'null'].includes(token)) return token === 'null' ? null : token === 'true';
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) malformed();
      const number = Number(token);
      if (!Number.isFinite(number) || Object.is(number, -0) || Number.isInteger(number) && !Number.isSafeInteger(number)
          || number === 0 && /[1-9]/.test(token.split(/[eE]/)[0])) invalid('A typed number cannot retain its value under the declared finite IEEE754 safe-integral model.');
      return number;
    }
  };
  try { const result = value(0); whitespace(); if (offset !== input.length) malformed(); return result; }
  catch (error) { if (error?.code?.startsWith('ANALYSIS_SNAPSHOT_') || error?.code === 'INVALID_ANALYSIS_SNAPSHOT_PREPARATION') throw error; return malformed(); }
}

export function projectAnalysisSnapshotJsonTable(input) {
  fields(input, ['source', 'descriptor', 'value', 'offset', 'limit']);
  const ref = capture(input.source), descriptor = normalizeAnalysisSnapshotTypedDescriptor(input.descriptor); source(ref);
  if (descriptor.type !== 'table' || descriptor.id !== ref.versionId || descriptor.sha256 !== ref.sha256) invalid('The typed table does not match its exact source descriptor.');
  const offset = input.offset, limit = input.limit; integer(offset, 0, T.offset); integer(limit, 1, T.rows);
  const rows = array(input.value, T.sourceRows), columns = rows.length ? sourceKeyOrders.get(rows[0]) || Object.keys(rows[0] || {}) : [];
  if (columns.length > T.columns || rows.length && !columns.length || columns.some(key => !key.trim() || !key.isWellFormed() || key.length > T.columnCharacters
      || reserved.has(key) || /[\p{Cc}]/u.test(key))) invalid('A typed table requires bounded exact scalar columns.');
  let bytes = 2 + Math.max(0, rows.length - 1);
  for (const row of rows) {
    fields(row, columns); for (const key of columns) scalar(row[key]);
    bytes += JSON.stringify(row).length; // Fast early allowance; UTF-8 is checked below.
    if (bytes > T.sourceBytes) invalid('Typed JSON exceeds its complete source budget.', true);
  }
  if (new TextEncoder().encode(JSON.stringify(rows)).length > T.sourceBytes) invalid('Typed JSON exceeds its complete source budget.', true);
  const result = { family: 'table', source: ref, semantics: descriptor.semantics, columns, rows: rows.slice(offset, offset + limit).map(row => columns.map(key => row[key])),
    offset, limit, totalRows: rows.length, hasMore: offset + limit < rows.length, truncated: false, scalarModel: ANALYSIS_SNAPSHOT_SCALAR_MODEL };
  canonicalSnapshotJson(result, T.responseBytes); return result;
}
