import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import displayNameModule from './analysisDisplayName.js';

const { analysisBaseName, derivedAnalysisDisplayName } = displayNameModule;

describe('analysis display names', () => {
  it('normalizes generated prefixes and version suffixes', () => {
    expect(analysisBaseName('Saved Fork of PBMC · Branch 2026-08-19 23:52Z')).toBe('PBMC');
  });

  it('treats the canonical zone-less database timestamp as UTC', () => {
    expect(derivedAnalysisDisplayName('PBMC', 'saved', '2026-08-19 23:52:40'))
      .toBe('PBMC · Saved 2026-08-19 23:52Z');
  });

  it('does not shift the canonical database timestamp on a non-UTC host', () => {
    const modulePath = path.resolve(process.cwd(), 'backend', 'analysisDisplayName.js');
    const output = execFileSync(process.execPath, [
      '-e',
      `const { derivedAnalysisDisplayName } = require(${JSON.stringify(modulePath)}); process.stdout.write(derivedAnalysisDisplayName('PBMC', 'saved', '2026-08-19 23:52:40'));`,
    ], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'America/Los_Angeles' },
    });

    expect(output).toBe('PBMC · Saved 2026-08-19 23:52Z');
  });
});
