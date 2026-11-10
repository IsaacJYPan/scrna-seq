#!/bin/bash
set -euo pipefail
# Host node_modules contains Windows native packages. Supply only their Linux
# counterparts in this disposable container; do not alter the host installation.
npm install --prefix /tmp/test-native --no-save --no-audit --no-fund @rollup/rollup-linux-x64-gnu@4.60.0 @esbuild/linux-x64@0.25.12
export NODE_PATH=/tmp/test-native/node_modules
cd /source
node node_modules/vitest/vitest.mjs run backend/agent-approved-runs.test.js backend/slurm-executor.test.js backend/r-worker-bridge.test.js backend/workflow-trust-v2.test.js cli/traceomics-mcp.test.mjs --config scripts/local-cluster-test/vitest.config.mjs --reporter=json --outputFile="${REGRESSION_OUTPUT:-/source/exports/evolved-study/linux-regression.json}" "$@"
