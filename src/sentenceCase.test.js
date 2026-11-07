import { describe, expect, it } from 'vitest';
import { sentenceCase } from './sentenceCase';

describe('sentenceCase', () => {
  it('lowercases title-case words after the first', () => {
    expect(sentenceCase('Quality Control')).toBe('Quality control');
    expect(sentenceCase('Runs & Results')).toBe('Runs & results');
    expect(sentenceCase('Study Design & Conditions')).toBe('Study design & conditions');
  });
  it('keeps acronyms, product names, and mixed-case terms', () => {
    expect(sentenceCase('Run PCA')).toBe('Run PCA');
    expect(sentenceCase('Standard scRNA-seq workflow')).toBe('Standard scRNA-seq workflow');
    expect(sentenceCase('CellChat Communication')).toBe('CellChat communication');
    expect(sentenceCase('Feature Plot')).toBe('Feature plot');
  });
  it('passes non-strings through', () => {
    const node = { type: 'span' };
    expect(sentenceCase(node)).toBe(node);
  });
});
