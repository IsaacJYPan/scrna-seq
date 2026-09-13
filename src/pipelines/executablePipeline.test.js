import { describe, expect, it } from 'vitest';
import {
  installPipeline,
  parseExecutablePipeline,
  pipelineRunScript,
  validateExecutablePipeline,
} from './executablePipeline.mjs';
const { validateExpertRParams } = require('../../backend/expertR');

const pipeline = {
  format: 'traceomics-pipeline',
  schemaVersion: 1,
  id: 'cell-summary',
  name: 'Cell summary',
  version: '1.0.0',
  description: 'Count cells.',
  runtime: { language: 'r', profileId: 'scrna-r-4.5-bioconductor-3.22-v1' },
  script: 'write_table(data.frame(cells = ncol(obj)), "summary.csv")',
};

describe('executable pipeline packages', () => {
  it('produces a script accepted by the existing isolated runner with version provenance', () => {
    const installed = parseExecutablePipeline(JSON.stringify(pipeline));
    const script = pipelineRunScript(installed);
    const result = validateExpertRParams({
      profileId: installed.runtime.profileId,
      script,
      inputIds: [],
    });
    expect(result.params.script).toBe(`# Pipeline: cell-summary@1.0.0\n${pipeline.script}`);
    expect(result.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    const next = validateExpertRParams({
      ...result.params,
      script: pipelineRunScript({ ...installed, version: '1.0.1' }),
    });
    expect(next.scriptSha256).not.toBe(result.scriptSha256);
  });

  it.each([
    { endpoint: '/api/run' },
    { packages: ['anything'] },
    { script: '' },
    { script: '\0' },
    { id: '../../private' },
    { id: 'abc\nprint(1)' },
    { version: '1.0.0\nprint(1)' },
    { runtime: { language: 'javascript', profileId: 'node' } },
    { runtime: { ...pipeline.runtime, network: true } },
  ])('rejects unsupported or malformed package contents: %j', (changes) => {
    expect(() => validateExecutablePipeline({ ...pipeline, ...changes })).toThrow();
  });

  it('bounds UTF-8 script bytes including the provenance header', () => {
    expect(() => validateExecutablePipeline({ ...pipeline, script: 'é'.repeat(16384) })).toThrow(
      /32 KiB/
    );
    expect(() => parseExecutablePipeline(' '.repeat(48 * 1024 + 1))).toThrow(/48 KiB/);
  });

  it('pins installed versions and rejects silent content replacement', () => {
    const installed = installPipeline([], pipeline);
    expect(installPipeline(installed, pipeline)).toBe(installed);
    expect(() => installPipeline(installed, { ...pipeline, script: 'print("changed")' })).toThrow(
      /different contents/
    );
    const updated = installPipeline(installed, {
      ...pipeline,
      version: '1.1.0',
      script: 'print("new version")',
    });
    expect(updated.map((item) => item.version)).toEqual(['1.0.0', '1.1.0']);
  });
});
