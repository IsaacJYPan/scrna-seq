#!/usr/bin/env node

'use strict';

// Cross-language recovery proof for CellChat: R creates the actual signed
// completion envelope during its real inference smoke, then this Node process
// verifies the HMAC and reconstructs the descriptor the worker would adopt
// after an indeterminate response. This is intentionally a test harness, not
// a runtime code path.

const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  descriptorFromCompletionReceipt,
  verifyCompletionReceiptEnvelope,
} = require('../backend/rWorkerBridge');

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scrna-cellchat-receipt-'));
  const interopPath = path.join(tempRoot, 'r-receipt.json');
  try {
    execFileSync(process.env.RSCRIPT || 'Rscript', [
      path.join(__dirname, 'verify_cellchat_inference.R'),
    ], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        CELLCHAT_SMOKE_INTEROP_OUTPUT: interopPath,
      },
      stdio: 'inherit',
    });

    assert.ok(fs.existsSync(interopPath), 'R smoke did not produce a receipt handoff.');
    const interop = JSON.parse(fs.readFileSync(interopPath, 'utf8'));
    assert.equal(interop?.job?.id, 'job_cellchat');
    assert.equal(interop?.job?.jobType, 'cellchat.infer.v1');
    assert.equal(interop?.job?.projectId, 'proj_cellchat');
    assert.equal(interop?.job?.analysisObjectId, 'ao_cellchat');
    assert.equal(interop?.job?.datasetId, null);
    assert.equal(
      interop?.expected?.outputStorageKey,
      'projects/proj_cellchat/artifacts/job_cellchat/cellchat-inference.csv'
    );
    assert.equal(typeof interop?.r_api_token, 'string');
    assert.ok(interop.r_api_token.length >= 32, 'R smoke did not provide its test signing token.');
    assert.equal(typeof interop?.envelope_json, 'string');

    const envelope = JSON.parse(interop.envelope_json);
    const receipt = verifyCompletionReceiptEnvelope(envelope, interop.r_api_token);
    const descriptor = descriptorFromCompletionReceipt(interop.job, receipt, interop.expected);
    assert.equal(descriptor.operation, 'r.cellchat.infer.v1');
    assert.equal(descriptor.artifactType, 'cellchat_summary');
    assert.equal(descriptor.result.saved, true);
    assert.ok(Number.isInteger(descriptor.result.nRows));
    assert.ok(descriptor.result.nRows > 0);
    assert.equal(descriptor.metadata.summary.analysisIntent, 'single_context');
    assert.doesNotMatch(JSON.stringify(descriptor), /storage[_-]?(?:key|uri)|state[_-]?key/i);
    assert.throws(
      () => verifyCompletionReceiptEnvelope(envelope, `${interop.r_api_token}x`),
      /Completion receipt is invalid/
    );
    process.stdout.write('CELLCHAT R-TO-NODE RECEIPT INTEROP PASSED\n');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`CellChat R-to-Node receipt interoperability failed: ${error.message}\n`);
  process.exitCode = 1;
}
