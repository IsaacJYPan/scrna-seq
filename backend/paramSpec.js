'use strict';

const { codedError } = require('./codedError');

// Validates job parameters against a declarative spec of the form
// { name: { type: 'enum'|'bool'|'int'|'intOrNull'|'number', default, min, max, values } }.
// Unknown keys are rejected; missing or undefined keys take the spec default.

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateParamValue(name, spec, raw) {
  if (spec.type === 'enum') {
    if (!spec.values.includes(raw)) {
      throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be one of: ${spec.values.join(', ')}.`);
    }
    return raw;
  }
  if (spec.type === 'bool') {
    if (typeof raw !== 'boolean') {
      throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a boolean.`);
    }
    return raw;
  }
  if (spec.type === 'intOrNull' && raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a finite number.`);
  }
  if ((spec.type === 'int' || spec.type === 'intOrNull') && !Number.isInteger(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be an integer.`);
  }
  if (raw < spec.min || raw > spec.max) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be between ${spec.min} and ${spec.max}.`);
  }
  return raw;
}

function validateParamsAgainstSpec(input, paramSpec, paramNames) {
  const raw = input === undefined || input === null ? {} : input;
  if (!isJsonObject(raw)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(paramSpec, key)) {
      throw codedError('UNKNOWN_PARAMETER', `Unknown parameter '${key}'.`);
    }
  }
  const params = {};
  const defaultsApplied = [];
  for (const name of paramNames) {
    const spec = paramSpec[name];
    // nullMeansDefault: an explicit null asks for the default (for example, the
    // fixed default seed), which is then recorded as the value that ran.
    if (!Object.prototype.hasOwnProperty.call(raw, name) || raw[name] === undefined
        || (raw[name] === null && spec.nullMeansDefault)) {
      params[name] = spec.default;
      defaultsApplied.push(name);
    } else {
      params[name] = validateParamValue(name, spec, raw[name]);
    }
  }
  return { params, defaultsApplied };
}

module.exports = { isJsonObject, validateParamValue, validateParamsAgainstSpec };
