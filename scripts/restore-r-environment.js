#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { discoverExpertRuntimeEnvironment } = require('../backend/expertSandboxBroker');
const { MAX_ENVIRONMENT_BYTES, validateEnvironmentManifest, summarizeEnvironmentManifest, assertEnvironmentMatches } = require('../backend/rEnvironment');

async function restoreEnvironment(manifest, { pull = false, discover = discoverExpertRuntimeEnvironment, runDocker = args => spawnSync('docker',args,{ encoding:'utf8',windowsHide:true,timeout:120000 }) } = {}) {
  const expected = validateEnvironmentManifest(manifest);
  const image = expected.runtime.imageReference;
  if (pull) {
    if (!image.includes('@')) throw new Error('A local image ID cannot be pulled from a registry. Transfer the original image with docker save/docker load, then retry.');
    const result = runDocker(['pull',image]);
    if (result.error || result.status !== 0) throw new Error('The exact recorded image is unavailable from its registry. No replacement image or current packages were installed.');
  }
  let actual;
  try { actual = await discover({ EXPERT_R_SANDBOX_IMAGE:image }); }
  catch { throw new Error('The exact recorded runtime or one of its required dependencies is unavailable. Restore the original image on a compatible Linux worker; no substitute packages were installed.'); }
  const reference = assertEnvironmentMatches(summarizeEnvironmentManifest(expected),summarizeEnvironmentManifest(actual));
  return { reference, manifest: actual };
}
async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args,options: { manifest:{ type:'string' },pull:{ type:'boolean' },help:{ type:'boolean' } } });
  if (values.help) { console.log('Usage: node scripts/restore-r-environment.js --manifest environment.json [--pull]'); console.log('Verifies the original immutable Linux image and its complete installed package inventory. --pull retrieves only an exact registry digest. Local image IDs require docker save/docker load. No packages are installed or upgraded.'); return; }
  if (!values.manifest) throw new Error('Choose a recorded environment manifest with --manifest.');
  const handle = await fs.open(values.manifest,'r'); let bytes;
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > MAX_ENVIRONMENT_BYTES) throw new Error('The environment manifest exceeds its supported limit.'); bytes = Buffer.alloc(stat.size+1); const read = await handle.read(bytes,0,bytes.length,0); bytes = bytes.subarray(0,read.bytesRead); if (bytes.length !== stat.size) throw new Error('The environment manifest changed while reading.'); }
  finally { await handle.close(); }
  const result = await restoreEnvironment(JSON.parse(bytes.toString('utf8')), { pull:values.pull });
  console.log(JSON.stringify({ status:'verified',environment:result.reference }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode=1; });
module.exports = { restoreEnvironment,main };
