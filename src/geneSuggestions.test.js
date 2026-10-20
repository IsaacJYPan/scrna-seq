import { describe, expect, it, vi } from 'vitest';
import { findGeneSuggestions } from './geneSuggestions';

const previousSuggestions = (genes, input) => genes
  .filter(gene => gene.toLowerCase().startsWith(input.toLowerCase())).slice(0, 8);

describe('gene suggestions', () => {
  it('matches the previous suggestions, including casing, order, duplicates, and nonmatches', () => {
    const genes = ['CD3E', 'Cd3d', 'MS4A1', 'CD3E', 'Cd8a', 'CD8B', 'cd19', 'CD4', 'CD79A', 'CD79B', 'CD2', 'İGENE', 'ÄGENE'];
    for (const input of ['CD', 'cD3', 'MS4', 'absent', 'İG', 'ÄG', '', ' CD']) {
      expect(findGeneSuggestions(genes, input)).toEqual(previousSuggestions(genes, input));
    }
    expect(findGeneSuggestions([], 'CD')).toEqual([]);
    expect(genes[0]).toBe('CD3E');
  });

  it('stops reading and matching genes after filling the eight visible suggestions', () => {
    const genes = Array.from({ length: 30000 }, (_, index) => `CD${index}`);
    const lowerCaseCalls = vi.fn();
    const trackedGenes = genes.map(gene => ({
      toLowerCase() { lowerCaseCalls(); return gene.toLowerCase(); },
    }));
    expect(findGeneSuggestions(trackedGenes, 'cD')).toEqual(trackedGenes.slice(0, 8));
    expect(lowerCaseCalls).toHaveBeenCalledTimes(8);
    lowerCaseCalls.mockClear();
    expect(previousSuggestions(trackedGenes, 'cD')).toEqual(trackedGenes.slice(0, 8));
    expect(lowerCaseCalls).toHaveBeenCalledTimes(30000);
  });

  it('still scans the full list when there are fewer than eight matches', () => {
    const genes = Array.from({ length: 30000 }, (_, index) => index === 29999 ? 'MS4A1' : `AC${index}`);
    for (const input of ['AC', 'AC0', 'MS4', 'missing']) {
      expect(findGeneSuggestions(genes, input)).toEqual(previousSuggestions(genes, input));
    }
  });
});
