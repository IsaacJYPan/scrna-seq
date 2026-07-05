import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('light-mode-first styling', () => {
  it('keeps light tokens as the default and dark tokens behind data-theme="dark"', () => {
    const css = readFileSync(join(here, 'App.css'), 'utf8');

    expect(css).toMatch(/--color-background:\s*#f6f8fb/);
    expect(css).toMatch(/--color-surfaceRaised:\s*#f1f5f9/);
    expect(css).toMatch(/--color-text:\s*#111827/);
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    expect(css).toMatch(/:root:not\(\[data-theme="dark"\]\) input/);
    expect(css).toMatch(/:root:not\(\[data-theme="dark"\]\) \.bg-slate-900/);
    expect(css).toMatch(/background-color:\s*var\(--color-surfaceRaised\)\s*!important/);
  });
});
