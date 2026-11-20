'use strict';

// A pinned workflow runtime for tests. Planning an approved workflow requires
// TRACEOMICS_WORKFLOW_RUNTIME_FILE (backend/workflowTrust/manifest.js); in a
// deployment it is written from the R service's /runtime/workflow-trust.
// Underscore-prefixed so Vitest does not treat it as a test file.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_WORKFLOW_RUNTIME = Object.freeze({
  schema: 'traceomics.workflow-runtime.v1',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  rVersion: '4.5.3',
  packages: [{ name: 'Seurat', version: '5.5.1' }],
});

// Writes the runtime file and points the environment at it, for the local and
// Slurm targets. Returns a restore function.
function useTestWorkflowRuntime(profile = TEST_WORKFLOW_RUNTIME) {
  const previous = process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE;
  const file = path.join(os.tmpdir(), `workflow-runtime-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ targets: { local: profile, slurm: profile } }));
  process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE = file;
  return () => {
    if (previous === undefined) delete process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE;
    else process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE = previous;
    fs.rmSync(file, { force: true });
  };
}

module.exports = { TEST_WORKFLOW_RUNTIME, useTestWorkflowRuntime };
