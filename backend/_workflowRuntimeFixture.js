'use strict';

// Test-only pinned workflow runtime (image digest and package inventory).
// Planning refuses to run without one (workflowTrust/manifest.js), so suites
// that exercise agent planning configure this profile for their duration.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const RUNTIME_PROFILE = Object.freeze({
  schema: 'traceomics.workflow-runtime.v1',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  rVersion: '4.5.3',
  packages: [{ name: 'Seurat', version: '5.5.1' }],
});

function useWorkflowRuntimeProfile() {
  const previous = process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE;
  const file = path.join(os.tmpdir(), `workflow-runtime-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(RUNTIME_PROFILE));
  process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE = file;
  return function restore() {
    if (previous === undefined) delete process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE;
    else process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE = previous;
    fs.rmSync(file, { force: true });
  };
}

// The R runtime's /runtime/workflow-trust reply for the pinned profile and the
// current R service sources, as the claim-time recheck expects.
function runtimeAttestation() {
  const { trustManifest } = require('./workflowTrust/manifest');
  const source = trustManifest().source.filter((f) => f.path.startsWith('r-backend/') && f.path.endsWith('.R'));
  return { ...RUNTIME_PROFILE, source };
}

module.exports = { RUNTIME_PROFILE, useWorkflowRuntimeProfile, runtimeAttestation };
