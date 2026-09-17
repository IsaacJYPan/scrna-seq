#!/usr/bin/env node
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseWorkflowJSON, serializeWorkflow, validateWorkflowPackage, WORKFLOW_LIMITS } from '../shared/workflowPackage.mjs';

export async function packWorkflow(directory, output) {
  const root = await realpath(directory);
  const metadataPath = path.join(root, 'pipeline.json');
  if ((await lstat(metadataPath)).size > WORKFLOW_LIMITS.metadataBytes) throw new Error('Workflow metadata exceeds 64 KiB.');
  const metadata = parseWorkflowJSON(await readFile(metadataPath, 'utf8'));
  if (Object.hasOwn(metadata, 'files')) throw new Error('Keep R source in separate files when authoring a workflow.');
  if (!Array.isArray(metadata.steps) || metadata.steps.length > WORKFLOW_LIMITS.steps) throw new Error('Invalid workflow steps.');
  const files = {};
  for (const entry of new Set(metadata.steps.map(step => step.entry))) {
    if (typeof entry !== 'string' || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.R$/.test(entry)) throw new Error('Invalid R source filename.');
    const filename = path.join(root, entry);
    const resolved = await realpath(filename);
    const relative = path.relative(root, resolved);
    const info = await lstat(filename);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !info.isFile() || info.isSymbolicLink()) throw new Error('R source must be a regular file inside the workflow directory.');
    if (info.size > WORKFLOW_LIMITS.scriptBytes) throw new Error('R source exceeds the 30 KiB author-code limit.');
    files[entry] = await readFile(filename, 'utf8');
  }
  const workflow = validateWorkflowPackage({ ...metadata, files });
  await writeFile(output, serializeWorkflow(workflow), { flag: 'wx' });
  return workflow;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) { console.error('Usage: npm run workflow:pack -- source-directory output.pipeline.json'); process.exitCode = 1; }
  else {
    try { await packWorkflow(...args); console.log(`Packed workflow into ${args[1]}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
