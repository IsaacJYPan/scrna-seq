import { describe, expect, it } from 'vitest';

const { inheritedAnalysisSummary } = require('./pgDatabase');

describe('checkpoint fork summary inheritance', () => {
  it('copies only validated source dimensions into a fork', () => {
    expect(inheritedAnalysisSummary({
      summary: {
        cells: 2643,
        features: 13714,
        density: 2.4,
        storageUri: 'C:\\private\\source.rds',
      },
    })).toEqual({ cells: 2643, features: 13714, density: 2.4 });
  });

  it('does not turn unavailable or invalid dimensions into zero', () => {
    expect(inheritedAnalysisSummary({ summary: { cells: null, features: -1 } })).toEqual({});
    expect(inheritedAnalysisSummary({})).toEqual({});
  });
});
