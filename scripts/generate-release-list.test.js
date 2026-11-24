import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderReleaseList } from './generate-release-list.mjs';

describe('generated release list', () => {
  it('matches the release catalog (run node scripts/generate-release-list.mjs)', () => {
    const file = path.join(__dirname, '..', 'docs', 'workflow-releases.md');
    expect(fs.readFileSync(file, 'utf8')).toBe(renderReleaseList());
  });
});
