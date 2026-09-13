#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_PIPELINE_FILE_BYTES,
  validateExecutablePipeline,
} from '../src/pipelines/executablePipeline.mjs';

export async function packPipeline(metadataPath, scriptPath, outputPath) {
  for (const source of [metadataPath, scriptPath]) {
    if ((await stat(source)).size > MAX_PIPELINE_FILE_BYTES)
      throw new Error(`Input exceeds 48 KiB: ${source}`);
  }
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (Object.hasOwn(metadata, 'script'))
    throw new Error('Keep the R script in its own file, not in the package metadata.');
  const pipeline = validateExecutablePipeline({
    ...metadata,
    script: await readFile(scriptPath, 'utf8'),
  });
  await writeFile(outputPath, `${JSON.stringify(pipeline, null, 2)}\n`, { flag: 'wx' });
  return pipeline;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args.includes('--help')) {
    console.log('Usage: npm run pipeline:pack -- metadata.json analysis.R output.pipeline.json');
    process.exitCode = args.includes('--help') ? 0 : 1;
  } else {
    try {
      const pipeline = await packPipeline(...args);
      console.log(`Packed ${pipeline.id}@${pipeline.version} into ${args[2]}`);
    } catch (error) {
      console.error(
        error.code === 'EEXIST'
          ? 'Output already exists. Choose a new file or version.'
          : error.message
      );
      process.exitCode = 1;
    }
  }
}
