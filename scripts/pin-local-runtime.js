#!/usr/bin/env node
'use strict';

// Writes the workflow runtime profile for a plain R installation (no
// container), for TRACEOMICS_WORKFLOW_RUNTIME_FILE. It runs the same R code
// the R service uses to describe itself, with TRACEOMICS_RUNTIME_LOCAL_INSTALL=1,
// so the identity is a digest of the R home, version and every installed
// package. Start the R service with TRACEOMICS_RUNTIME_LOCAL_INSTALL=1 too.
// Rerun this after installing or upgrading packages, then reapprove releases.
//
//   node scripts/pin-local-runtime.js --out <file>

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runtimeIdentity } = require('../backend/workflowTrust/manifest');

function describeLocalRuntime({ rscript = process.env.RSCRIPT_PATH || 'Rscript', root = path.resolve(__dirname, '..'), exec = execFileSync } = {}) {
  const rRoot = path.join(root, 'r-backend').replace(/\\/g, '/');
  const code = [
    `workflow_runtime_root <- ${JSON.stringify(rRoot)}`,
    `source(file.path(workflow_runtime_root, "lib", "workflowTrust.R"))`,
    'm <- workflow_runtime_manifest(); m$source <- NULL',
    'cat(jsonlite::toJSON(m, auto_unbox=TRUE))',
  ].join('; ');
  const stdout = exec(rscript, ['--vanilla', '-e', code], {
    env: { ...process.env, TRACEOMICS_RUNTIME_LOCAL_INSTALL: '1', TRACEOMICS_RUNTIME_IMAGE_DIGEST: '' },
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  // Validates the schema, digest, version and package inventory.
  return runtimeIdentity(JSON.parse(stdout));
}

function main(argv = process.argv.slice(2)) {
  const at = argv.indexOf('--out');
  const out = at >= 0 ? argv[at + 1] : '';
  if (!out) {
    console.error('Usage: node scripts/pin-local-runtime.js --out <file>');
    process.exit(2);
  }
  const profile = describeLocalRuntime();
  fs.writeFileSync(out, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(`Pinned R ${profile.rVersion} with ${profile.packages.length} packages as ${profile.imageDigest}.`);
  console.log(`Set TRACEOMICS_WORKFLOW_RUNTIME_FILE=${path.resolve(out)} and TRACEOMICS_RUNTIME_LOCAL_INSTALL=1, then restart.`);
}

if (require.main === module) main();

module.exports = { describeLocalRuntime };
