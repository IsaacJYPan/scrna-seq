import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ids = require('./resourceIds');

const CASES = [
  ['isValidDatasetIdFormat', 'ds_0af'],
  ['isValidAnalysisObjectIdFormat', 'ao_0af'],
  ['isValidJobIdFormat', 'job_0af'],
  ['isValidProvenanceIdFormat', 'prov_0af'],
  ['isValidFigureIdFormat', 'fig_0af'],
  ['isValidArtifactIdFormat', 'art_0af'],
  ['isValidBranchIdFormat', 'br_0af'],
  ['isValidReviewIdFormat', 'rev_0af'],
  ['isValidConditionIdFormat', 'cond_0af'],
  ['isValidSampleIdFormat', 'sample_0af'],
];

describe('resource id formats', () => {
  it.each(CASES)('%s accepts only its prefix with lowercase hex', (name, valid) => {
    const check = ids[name];
    expect(check(valid)).toBe(true);
    expect(check(valid.toUpperCase())).toBe(false);
    expect(check(`${valid}g`)).toBe(false);
    expect(check(`${valid}/..`)).toBe(false);
    expect(check(`x${valid}`)).toBe(false);
    expect(check(valid.replace(/_.*/, '_'))).toBe(false);
    expect(check(123)).toBe(false);
    expect(check(null)).toBe(false);
  });

  it('accepts bounded slug-like object ids for X-Object-ID', () => {
    expect(ids.isValidObjectIdFormat('ao_123')).toBe(true);
    expect(ids.isValidObjectIdFormat('ab')).toBe(false);
    expect(ids.isValidObjectIdFormat('a'.repeat(129))).toBe(false);
    expect(ids.isValidObjectIdFormat('../etc')).toBe(false);
  });
});
