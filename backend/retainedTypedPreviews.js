'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { PREVIEW_LIMITS } = require('./artifactPreviews');

const RETAINED_TYPED_LIMITS = Object.freeze({
  sourceJsonBytes: 5 * 1024 * 1024, responseBytes: PREVIEW_LIMITS.bytes,
  metrics: 40, metricKeyCharacters: 100, metricTextCharacters: 2000,
  sourcePoints: 100000, defaultPoints: 2000, maximumPoints: 5000,
  identifierCharacters: 200, groupCharacters: 100, groups: 40,
});
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
function failure(message, status = 400) {
  return Object.assign(new Error(message), { code: status === 413 ? 'RETAINED_PREVIEW_LIMIT' : status === 409 ? 'RETAINED_PREVIEW_SOURCE_MISMATCH' : 'RETAINED_PREVIEW_INVALID', status });
}
function record(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.getOwnPropertySymbols(value).length) throw failure(`${name} must be a plain JSON object.`);
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (reserved.has(key) || allowed && !allowed.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) throw failure(`${name} contains an unsupported field.`);
  }
  return value;
}
function text(value, maximum, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || !value.isWellFormed()
      || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw failure(`${name} must be bounded text on one line.`);
  return value;
}
function identifier(value, name) {
  text(value, 120, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || reserved.has(value)) throw failure(`${name} must be a stable identifier.`);
  return value;
}
function sourceReference(value) {
  record(value, ['artifactId', 'versionId', 'projectId', 'sha256'], 'Source reference');
  identifier(value.artifactId, 'Source artifact'); identifier(value.projectId, 'Source project');
  if (typeof value.versionId !== 'string' || !/^(?:av|art|eri)_[a-f0-9]{16,40}$/.test(value.versionId)
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw failure('An exact source version and lowercase checksum are required.');
  return { artifactId: value.artifactId, versionId: value.versionId, projectId: value.projectId, sha256: value.sha256 };
}
function descriptorFor(value, source) {
  record(value, ['id', 'type', 'sha256', 'sizeBytes', 'profileId'], 'Workflow output descriptor');
  if (value.id !== source.versionId || value.sha256 !== source.sha256) throw failure('The trusted output descriptor does not match the exact source reference.', 409);
  if (!['metrics', 'scatter'].includes(value.type)) throw failure('This output has no typed metrics or embedding adapter.');
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || value.sizeBytes > RETAINED_TYPED_LIMITS.sourceJsonBytes) throw failure('Typed preview source JSON exceeds its bounded size.', 413);
  if (Object.hasOwn(value, 'profileId')) identifier(value.profileId, 'Output profile');
  return value;
}
function optionalText(value, maximum, name) { return value === undefined || value === null ? null : text(value, maximum, name); }
function semanticsFor(value = {}, embedding = false, metricKeys = []) {
  if (value === null) value = {};
  record(value, embedding ? ['role', 'title', 'entityType', 'axes'] : ['role', 'title', 'metrics'], 'Result semantics');
  if (value.role !== undefined && value.role !== null && !['primary', 'diagnostic'].includes(value.role)) throw failure('Result role must be primary or diagnostic when declared.');
  const common = { role: value.role ?? null, title: optionalText(value.title, 160, 'Result title') };
  if (embedding) {
    if (value.entityType !== undefined && value.entityType !== null && !['cell', 'sample', 'observation', 'feature', 'point'].includes(value.entityType)) throw failure('The declared point entity type is unsupported.');
    const axes = value.axes == null ? {} : record(value.axes, ['x', 'y'], 'Embedding axes');
    const axis = key => {
      const item = axes[key] == null ? {} : record(axes[key], ['label', 'unit'], 'Axis semantics');
      return { label: optionalText(item.label, 120, 'Axis label'), unit: optionalText(item.unit, 80, 'Axis unit') };
    };
    return { ...common, entityType: value.entityType ?? null, axes: { x: axis('x'), y: axis('y') } };
  }
  const metrics = value.metrics == null ? {} : record(value.metrics, metricKeys, 'Metric semantics');
  const entries = new Map();
  for (const [key, description] of Object.entries(metrics)) {
    const item = description === null ? {} : record(description, ['label', 'unit'], 'Metric description');
    entries.set(key, { label: optionalText(item.label, 120, 'Metric label'), unit: optionalText(item.unit, 80, 'Metric unit') });
  }
  return { ...common, metrics: entries };
}
function byteAllowance(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > RETAINED_TYPED_LIMITS.responseBytes) throw failure('The preview response allowance must be a positive integer within the common response budget.');
  return value;
}
function responseBudget(value, maximum) {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw failure('The typed preview exceeds the bounded response size.', 413);
  return value;
}

// The caller must already have authorized and verified the immutable bytes.
// These pure projections bind metadata; they do not establish byte integrity.
function projectRetainedMetrics({ source, value, semantics, responseBytes = RETAINED_TYPED_LIMITS.responseBytes }) {
  const maximumBytes = byteAllowance(responseBytes);
  const reference = sourceReference(source);
  record(value, null, 'Saved metrics');
  const keys = Object.keys(value);
  if (keys.length > RETAINED_TYPED_LIMITS.metrics) throw failure('A metrics preview supports at most 40 scalar metrics.', 413);
  for (const key of keys) {
    text(key, RETAINED_TYPED_LIMITS.metricKeyCharacters, 'Metric key');
    const item = value[key];
    if (!(item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)
        || typeof item === 'string' && item.length <= RETAINED_TYPED_LIMITS.metricTextCharacters && item.isWellFormed())) throw failure('Metrics must retain finite numbers, booleans, nulls or bounded text.');
  }
  const descriptions = semanticsFor(semantics, false, keys);
  return responseBudget({ family: 'metrics', source: reference,
    semantics: { role: descriptions.role, title: descriptions.title },
    items: keys.map(key => ({ key, value: value[key], label: descriptions.metrics.get(key)?.label ?? null, unit: descriptions.metrics.get(key)?.unit ?? null })) }, maximumBytes);
}

const compare = (left, right) => Buffer.compare(left.rank, right.rank) || (left.key === right.key ? 0 : left.key < right.key ? -1 : 1);
function admit(heap, item, maximum) {
  if (heap.length < maximum) {
    heap.push(item); let at = heap.length - 1;
    while (at > 0) { const parent = (at - 1) >>> 1; if (compare(heap[parent], heap[at]) >= 0) break; [heap[parent], heap[at]] = [heap[at], heap[parent]]; at = parent; }
    return;
  }
  if (compare(item, heap[0]) >= 0) return;
  heap[0] = item; let at = 0;
  while (at * 2 + 1 < heap.length) {
    let child = at * 2 + 1;
    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child += 1;
    if (compare(heap[at], heap[child]) >= 0) break;
    [heap[at], heap[child]] = [heap[child], heap[at]]; at = child;
  }
}
const scalarBytes = value => Buffer.byteLength(JSON.stringify(value));
function projectRetainedEmbedding({ source, value, pointLimit = RETAINED_TYPED_LIMITS.defaultPoints, semantics, responseBytes = RETAINED_TYPED_LIMITS.responseBytes }) {
  const maximumBytes = byteAllowance(responseBytes);
  const reference = sourceReference(source);
  record(value, ['x', 'y', 'ids', 'groups'], 'Saved embedding');
  if (!Number.isSafeInteger(pointLimit) || pointLimit < 1 || pointLimit > RETAINED_TYPED_LIMITS.maximumPoints) throw failure('Embedding point limit must be an integer from 1 to 5000.');
  if (!Array.isArray(value.x) || !Array.isArray(value.y) || value.x.length !== value.y.length) throw failure('Embedding coordinates must be equally sized arrays.');
  const count = value.x.length, hasIds = Object.hasOwn(value, 'ids'), hasGroups = Object.hasOwn(value, 'groups');
  if (count > RETAINED_TYPED_LIMITS.sourcePoints) throw failure('The saved embedding exceeds 100000 supported source points.', 413);
  if (hasIds && (!Array.isArray(value.ids) || value.ids.length !== count) || hasGroups && (!Array.isArray(value.groups) || value.groups.length !== count)) throw failure('Embedding identifiers and groups must align with the coordinates.');
  const details = semanticsFor(semantics, true), ids = new Set(), groups = new Set(), heap = [];
  const fields = Object.keys(value);
  let jsonBytes = 2 + Math.max(0, fields.length - 1) + fields.reduce((total, field) => total + scalarBytes(field) + 1 + 2 + Math.max(0, count - 1), 0);
  const salt = JSON.stringify(reference);
  for (let index = 0; index < count; index++) {
    if (!Number.isFinite(value.x[index]) || !Number.isFinite(value.y[index])) throw failure('Embedding coordinates must all be finite numbers.');
    if (hasIds) {
      text(value.ids[index], RETAINED_TYPED_LIMITS.identifierCharacters, 'Source point identifier');
      if (ids.has(value.ids[index])) throw failure('Source point identifiers must be unique within this saved version.');
      ids.add(value.ids[index]);
    }
    if (hasGroups) {
      text(value.groups[index], RETAINED_TYPED_LIMITS.groupCharacters, 'Source group'); groups.add(value.groups[index]);
      if (groups.size > RETAINED_TYPED_LIMITS.groups) throw failure('An embedding preview supports at most 40 source groups.', 413);
    }
    jsonBytes += scalarBytes(value.x[index]) + scalarBytes(value.y[index])
      + (hasIds ? scalarBytes(value.ids[index]) : 0) + (hasGroups ? scalarBytes(value.groups[index]) : 0);
    if (jsonBytes > RETAINED_TYPED_LIMITS.sourceJsonBytes) throw failure('Typed preview source JSON exceeds its bounded size.', 413);
    const key = hasIds ? value.ids[index] : String(index);
    const rank = crypto.createHash('sha256').update('traceomics.retained-embedding.priority.v1\0').update(salt).update('\0').update(hasIds ? 'id:' : 'row:').update(key).digest();
    admit(heap, { index, rank, key }, pointLimit);
  }
  const candidates = heap.sort(compare);
  const project = number => {
    // Complete views preserve source order. A sampled view uses the stable
    // hash-priority order so every bounded selection is reproducible.
    const selected = candidates.slice(0, number);
    if (number === count) selected.sort((left, right) => left.index - right.index);
    const indices = selected.map(item => item.index);
    return { family: 'embedding', source: reference, semantics: details,
      identity: { kind: hasIds ? 'source-identifiers' : 'source-row-positions', scope: 'exact-source-version', indexBase: 0 },
      x: indices.map(index => value.x[index]), y: indices.map(index => value.y[index]),
      ids: hasIds ? indices.map(index => value.ids[index]) : null,
      ...(hasGroups ? { groups: indices.map(index => value.groups[index]) } : {}), sourceIndices: indices,
      sampling: { method: number < count ? 'sha256-priority-v1' : 'none', sourceCount: count, returnedCount: number,
        requestedLimit: pointLimit, sampled: number < count, aggregated: false, stratified: false,
        budgetLimited: number < Math.min(count, pointLimit) } };
  };
  let low = 0, high = candidates.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(project(middle))) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  if (count && low === 0) throw failure('Even one source point exceeds the bounded response size.', 413);
  return responseBudget(project(low), maximumBytes);
}

function projectRetainedTypedPreview({ source, descriptor, bytes, pointLimit, semantics, responseBytes }) {
  const reference = sourceReference(source), output = descriptorFor(descriptor, reference);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw failure('Typed preview bytes must be a bounded binary buffer.');
  if (bytes.byteLength !== output.sizeBytes) throw failure('The parsed bytes do not match the trusted descriptor size.', 409);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure('The retained typed result must contain valid UTF-8 JSON.'); }
  return output.type === 'metrics' ? projectRetainedMetrics({ source: reference, value, semantics, responseBytes })
    : projectRetainedEmbedding({ source: reference, value, pointLimit, semantics, responseBytes });
}

function validateRetainedRasterMetadata(value) {
  record(value, ['formatId', 'width', 'height', 'sizeBytes'], 'Raster metadata');
  if (!['org.w3.png', 'org.iso.jpeg'].includes(value.formatId)) throw failure('Only bounded PNG or JPEG raster previews are supported.');
  if (!Number.isSafeInteger(value.width) || value.width < 1 || value.width > 100000
      || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 100000
      || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1) throw failure('Raster dimensions and size must be positive bounded integers.');
  const pixels = value.width * value.height;
  if (pixels > PREVIEW_LIMITS.imagePixels || value.sizeBytes > PREVIEW_LIMITS.imageBytes) throw failure('This retained raster exceeds the browser preview budget.', 413);
  return { formatId: value.formatId, width: value.width, height: value.height, pixels, boundedBytes: value.sizeBytes,
    formatMetadata: { 'org.traceomics.image:width': value.width, 'org.traceomics.image:height': value.height } };
}

module.exports = { RETAINED_TYPED_LIMITS, projectRetainedMetrics, projectRetainedEmbedding, projectRetainedTypedPreview, validateRetainedRasterMetadata };
