import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { packPipeline } from './pack-pipeline.mjs';
import { parseExecutablePipeline } from '../src/pipelines/executablePipeline.mjs';

let directory;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'traceomics-package-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('packs separate author files into an importable pipeline without overwriting an existing release', async () => {
  const metadataPath = path.resolve('examples/pipelines/cell-summary.json');
  const scriptPath = path.resolve('examples/pipelines/cell-summary.R');
  const output = path.join(directory, 'cell-summary.pipeline.json');
  const pipeline = await packPipeline(metadataPath, scriptPath, output);
  expect(parseExecutablePipeline(await readFile(output, 'utf8'))).toEqual(pipeline);
  await expect(packPipeline(metadataPath, scriptPath, output)).rejects.toMatchObject({
    code: 'EEXIST',
  });
});

it('rejects a source that exceeds the package limit before creating output', async () => {
  const script = path.join(directory, 'large.R');
  const output = path.join(directory, 'package.json');
  await writeFile(script, 'x'.repeat(49 * 1024));
  await expect(
    packPipeline(path.resolve('examples/pipelines/cell-summary.json'), script, output)
  ).rejects.toThrow(/exceeds/);
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
});
