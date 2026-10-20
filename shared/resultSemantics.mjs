const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();
function invalid(message) { throw new Error(message); }
function record(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.getOwnPropertySymbols(value).length) invalid(`${name} must be a plain JSON object.`);
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (reserved.has(key) || fields && !fields.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) invalid(`${name} contains an unsupported field.`);
  }
  return value;
}
function text(value, maximum, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || !value.isWellFormed()
      || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid(`${name} must be bounded text on one line.`);
  return value;
}
const optionalText = (value, maximum, name) => value === undefined || value === null ? null : text(value, maximum, name);
const description = (value, name) => {
  const item = value == null ? {} : record(value, ['label', 'unit'], name);
  return { label: optionalText(item.label, 120, `${name} label`), unit: optionalText(item.unit, 80, `${name} unit`) };
};

// Meaning is supplied by the pinned method, separately from result bytes.
// Validation never derives biological identities, axes, units or result roles.
export function validateResultSemantics(value, type, metricKeys) {
  const embedding = type === 'scatter', metrics = type === 'metrics';
  if (!['rds', 'table', 'metrics', 'scatter', 'figure'].includes(type)) invalid('Result semantics require a supported output type.');
  const input = value == null ? {} : value;
  record(input, ['role', 'title', ...(embedding ? ['entityType', 'axes'] : metrics ? ['metrics'] : [])], 'Result semantics');
  if (input.role != null && !['primary', 'diagnostic'].includes(input.role)) invalid('Result role must be primary or diagnostic when declared.');
  const result = { role: input.role ?? null, title: optionalText(input.title, 160, 'Result title') };
  if (embedding) {
    if (input.entityType != null && !['cell', 'sample', 'observation', 'feature', 'point'].includes(input.entityType)) invalid('The declared point entity type is unsupported.');
    const axes = input.axes == null ? {} : record(input.axes, ['x', 'y'], 'Embedding axes');
    result.entityType = input.entityType ?? null;
    result.axes = { x: description(axes.x, 'Axis'), y: description(axes.y, 'Axis') };
  }
  if (metrics) {
    const entries = input.metrics == null ? {} : record(input.metrics, metricKeys ?? null, 'Metric semantics');
    if (Object.keys(entries).length > 40) invalid('Result semantics support at most 40 metrics.');
    result.metrics = Object.fromEntries(Object.entries(entries).map(([key, value]) => [text(key, 100, 'Metric key'), description(value, 'Metric')]));
  }
  if (encoder.encode(JSON.stringify(result)).length > 16 * 1024) invalid('Result semantics exceed 16 KiB.');
  return result;
}
