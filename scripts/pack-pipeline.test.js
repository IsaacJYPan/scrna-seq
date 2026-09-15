import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { packPipeline } from './pack-pipeline.mjs';
import { MAX_PIPELINE_FILE_BYTES, parseExecutablePipeline } from '../src/pipelines/executablePipeline.mjs';
import { serializePipeline } from '../src/pipelines/pipelineSerialization.mjs';

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

it('packs a boundary-size file that can be reimported and rejects one extra byte', async () => {
  const metadataPath = path.resolve('examples/pipelines/cell-summary.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const scriptPath = path.join(directory, 'boundary.R');
  const output = path.join(directory, 'boundary.pipeline.json');
  let script = '# é\n' + '\t'.repeat(24000);
  script += 'x'.repeat(MAX_PIPELINE_FILE_BYTES - Buffer.byteLength(serializePipeline({ ...metadata, script })));
  await writeFile(scriptPath, script);
  const pipeline = await packPipeline(metadataPath, scriptPath, output);
  const source = await readFile(output, 'utf8');
  expect(Buffer.byteLength(source)).toBe(MAX_PIPELINE_FILE_BYTES);
  expect(parseExecutablePipeline(source)).toEqual(pipeline);
  expect(source).toBe(serializePipeline(pipeline));

  await writeFile(scriptPath, script + 'x');
  const oversizedOutput = path.join(directory, 'oversized.pipeline.json');
  await expect(packPipeline(metadataPath, scriptPath, oversizedOutput)).rejects.toThrow(/48 KiB/);
  await expect(readFile(oversizedOutput)).rejects.toMatchObject({ code: 'ENOENT' });
});
