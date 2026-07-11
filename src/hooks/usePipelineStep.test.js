import { describe, expect, it } from 'vitest';
import { friendlyPipelineError } from './usePipelineStep';

describe('friendlyPipelineError', () => {
  it('hides raw backend failures', () => {
    expect(friendlyPipelineError('Backend Exception: invalid negative subscript'))
      .toBe('The analysis could not run with these values. Check the settings and try again.');
  });

  it('gives useful feedback when QC removes every cell', () => {
    expect(friendlyPipelineError('No cells matched these filters'))
      .toBe('No cells matched these filters. Loosen the thresholds and try again.');
  });
});
