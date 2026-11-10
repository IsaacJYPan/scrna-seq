import { describe, expect, it } from 'vitest';
import { safeFigureFileName } from './figureFileName';

describe('safeFigureFileName', () => {
  it('keeps only the base name of server paths', () => {
    expect(safeFigureFileName('/srv/vault/figures/umap.png')).toBe('umap.png');
    expect(safeFigureFileName('C:\\exports\\dot plot.pdf')).toBe('dot plot.pdf');
    expect(safeFigureFileName(' figure.svg?download=1#x ')).toBe('figure.svg');
  });

  it('rejects empty, traversal-only, and control-character names', () => {
    expect(safeFigureFileName(undefined)).toBe('');
    expect(safeFigureFileName('   ')).toBe('');
    expect(safeFigureFileName('figures/..')).toBe('');
    expect(safeFigureFileName('a\nb.png')).toBe('');
  });

  it('bounds long names', () => {
    expect(safeFigureFileName(`${'a'.repeat(300)}.png`)).toHaveLength(180);
  });
});
