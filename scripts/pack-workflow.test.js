import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { packWorkflow } from './pack-workflow.mjs';
import { parseWorkflowPackage } from '../shared/workflowPackage.mjs';

let directory;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'traceomics-workflow-pack-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('packs the example with separate R files and preserves the branching dependency contract', async () => {
  const output = path.join(directory, 'workflow.pipeline.json');
  const workflow = await packWorkflow(path.resolve('examples/pipelines/scrna-workflow'), output);
  expect(parseWorkflowPackage(await readFile(output, 'utf8'))).toEqual(workflow);
  expect(workflow.steps.find(step => step.id === 'umap').inputs.analysis.from).toBe('pca.analysis');
  expect(workflow.steps.find(step => step.id === 'neighbors').inputs.analysis.from).toBe('pca.analysis');
  await expect(packWorkflow(path.resolve('examples/pipelines/scrna-workflow'), output)).rejects.toMatchObject({ code: 'EEXIST' });
});

it.each(['../outside.R', '/absolute.R', 'C:/private.R', 'steps\\outside.R'])(
  'rejects unsafe source names before reading them: %s', async entry => {
    await writeFile(path.join(directory, 'pipeline.json'), JSON.stringify({ steps: [{ entry }] }));
    await expect(packWorkflow(directory, path.join(directory, 'output.json'))).rejects.toThrow(/Invalid R source filename/);
  }
);

it('rejects oversized source before writing the release file', async () => {
  await writeFile(path.join(directory, 'pipeline.json'), JSON.stringify({ steps: [{ entry: 'large.R' }] }));
  await writeFile(path.join(directory, 'large.R'), '#'.repeat(31 * 1024));
  await expect(packWorkflow(directory, path.join(directory, 'output.json'))).rejects.toThrow(/30 KiB/);
  await expect(readFile(path.join(directory, 'output.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
