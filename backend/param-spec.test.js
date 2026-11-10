import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { validateParamsAgainstSpec } = require('./paramSpec');

const SPEC = {
  method: { type: 'enum', values: ['a', 'b'], default: 'a' },
  enabled: { type: 'bool', default: true },
  count: { type: 'int', min: 1, max: 10, default: 3 },
  limit: { type: 'intOrNull', min: 1, max: 5, default: null },
  ratio: { type: 'number', min: 0, max: 1, default: 0.5 },
};
const NAMES = Object.keys(SPEC);

function rejects(input, code, message) {
  let error;
  try { validateParamsAgainstSpec(input, SPEC, NAMES); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe(code);
  if (message) expect(error.message).toBe(message);
}

describe('validateParamsAgainstSpec', () => {
  it('applies defaults for missing or undefined parameters and records them', () => {
    expect(validateParamsAgainstSpec(undefined, SPEC, NAMES)).toEqual({
      params: { method: 'a', enabled: true, count: 3, limit: null, ratio: 0.5 },
      defaultsApplied: NAMES,
    });
    expect(validateParamsAgainstSpec({ count: 7, ratio: undefined }, SPEC, NAMES).defaultsApplied)
      .toEqual(['method', 'enabled', 'limit', 'ratio']);
  });

  it('accepts values of every supported type', () => {
    const { params } = validateParamsAgainstSpec({ method: 'b', enabled: false, count: 10, limit: null, ratio: 0 }, SPEC, NAMES);
    expect(params).toEqual({ method: 'b', enabled: false, count: 10, limit: null, ratio: 0 });
  });

  it('rejects non-object input and unknown or prototype keys', () => {
    rejects([], 'INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
    rejects('x', 'INVALID_PARAMETERS');
    rejects({ extra: 1 }, 'UNKNOWN_PARAMETER', "Unknown parameter 'extra'.");
    rejects(JSON.parse('{"__proto__": {"count": 2}}'), 'UNKNOWN_PARAMETER');
  });

  it('rejects values outside each type', () => {
    rejects({ method: 'c' }, 'INVALID_PARAMETER', "Parameter 'method' must be one of: a, b.");
    rejects({ enabled: 'yes' }, 'INVALID_PARAMETER', "Parameter 'enabled' must be a boolean.");
    rejects({ count: '3' }, 'INVALID_PARAMETER', "Parameter 'count' must be a finite number.");
    rejects({ count: 2.5 }, 'INVALID_PARAMETER', "Parameter 'count' must be an integer.");
    rejects({ count: 11 }, 'INVALID_PARAMETER', "Parameter 'count' must be between 1 and 10.");
    rejects({ ratio: Number.NaN }, 'INVALID_PARAMETER');
    rejects({ count: null }, 'INVALID_PARAMETER');
  });
});
