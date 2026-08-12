import { describe, expect, it } from 'vitest';
import { DEFAULT_PUBLIC_ERROR, isTransientComputeBusy, publicErrorMessage } from './publicError';

describe('publicErrorMessage', () => {
  it('preserves short actionable scientific and access feedback', () => {
    expect(publicErrorMessage('No cells matched these filters.')).toBe('No cells matched these filters.');
    expect(publicErrorMessage('Select a saved analysis before continuing.')).toBe('Select a saved analysis before continuing.');
    expect(publicErrorMessage('permission denied')).toBe('You do not have access to this project action.');
  });

  it('replaces infrastructure, path, state, and identifier details', () => {
    const raw = 'Error in Rscript: /__private_vault__/proj_123/job_456.rds state_key=user-7:obj-private';
    expect(publicErrorMessage(raw)).toBe(DEFAULT_PUBLIC_ERROR);
    expect(publicErrorMessage('{"error":"https://runtime.internal/api/r failed"}')).toBe(DEFAULT_PUBLIC_ERROR);
    expect(publicErrorMessage('unknown backend exception')).toBe(DEFAULT_PUBLIC_ERROR);
  });

  it('maps shared compute contention to a short actionable explanation', () => {
    const expected = 'Analysis compute is busy. Wait a moment and try again.';
    expect(publicErrorMessage('R service is busy. Please retry shortly.')).toBe(expected);
    expect(publicErrorMessage(expected)).toBe(expected);
    expect(isTransientComputeBusy('R service is busy. Please retry shortly.')).toBe(true);
    expect(isTransientComputeBusy('R request failed.')).toBe(false);
  });
});
