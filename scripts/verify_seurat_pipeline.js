#!/usr/bin/env node
'use strict';

// Real-R integration check for the durable seurat.pipeline.v1 worker path.
//
// This is the regression guard the mocked backend suites cannot provide: the
// *-worker.test.js suites stub `callR` to return instantly with unboxed objects, so
// they never exercise real R timing (which is what expired the worker lease), real
// plumber JSON serialization, or real Seurat compute. This script drives the ACTUAL
// worker -> rWorkerBridge -> spawned R Plumber path against genuine PBMC3k tutorial
// data and asserts the job COMPLETES with the standard result and leaks no storage
// paths/keys.
//
// It SKIPS cleanly (exit 0) when Rscript / Seurat / hdf5r are unavailable, so the
// default `npm run test:backend` stays green in CI (which has no R).
//
// Usage: node scripts/verify_seurat_pipeline.js   (or: npm run test:seurat-pipeline)

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = path.resolve(__dirname, '..');
const PLUMBER_PORT = Number(process.env.PLUMBER_TEST_PORT || 18132);
const API_TOKEN = 'verify-seurat-pipeline-token';
const RUN_R = path.join(WORKSPACE, 'r-backend', 'run.R');

function skip(reason) {
  console.log(`SKIP verify_seurat_pipeline: ${reason}`);
  process.exit(0);
}

function rHasPackages() {
  const probe = spawnSync('Rscript', ['-e',
    'q(status = if (all(c("Seurat","hdf5r","Matrix") %in% rownames(installed.packages()))) 0 else 1)'
  ], { cwd: WORKSPACE, encoding: 'utf8' });
  return probe.status === 0;
}

function httpGetHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PLUMBER_PORT, path: '/health', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

async function waitForPlumber(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const code = await httpGetHealth();
    if (code === 200 || code === 403) return true; // 403 = alive, needs token
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

let passCount = 0;
function assert(cond, message, detail = '') {
  if (!cond) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
  passCount += 1;
  console.log(`PASS ${message}`);
}

async function main() {
  if (spawnSync('Rscript', ['--version'], { encoding: 'utf8' }).status !== 0) skip('Rscript not on PATH');
  if (!rHasPackages()) skip('Seurat / hdf5r / Matrix not installed in R');

  const mtx = path.join(WORKSPACE, 'data', 'pbmc3k', 'filtered_gene_bc_matrices', 'hg19');
  if (!fs.existsSync(mtx)) skip('PBMC3k MTX sample data missing (run scripts/download_sample_data.js)');

  // Build a real 10x .h5 in the vault (where R's validate_path("...","vault") resolves).
  const stamp = Date.now();
  const vaultRel = `vault/verify_seurat_${stamp}`;
  const vaultAbs = path.join(WORKSPACE, vaultRel);
  fs.mkdirSync(vaultAbs, { recursive: true });
  const h5Rel = `${vaultRel}/pbmc3k.h5`;
  const h5Abs = path.join(WORKSPACE, h5Rel);

  console.log('INFO converting MTX -> 10x .h5 ...');
  const conv = spawnSync('Rscript', [path.join('scripts', 'make_pbmc3k_h5.R'), mtx, h5Abs],
    { cwd: WORKSPACE, encoding: 'utf8' });
  if (conv.status !== 0 || !fs.existsSync(h5Abs)) {
    console.error(conv.stderr || conv.stdout);
    throw new Error('h5 conversion failed');
  }

  const db = require('../backend/database');
  const { createJobWorker } = require('../backend/jobWorker');
  db.initDatabase(':memory:');

  const owner = db.createUser(`seurat-verify-${stamp}@example.com`, 'password123', 'Verifier');
  const org = db.createOrganizationForUser(owner.id, { name: 'Verify Org' });
  const project = db.createProjectForUser(owner.id, { organizationId: org.id, name: 'Verify Project' });
  const dataset = db.createDatasetForProject(owner.id, project.id, {
    fileType: 'tenx_h5', originalFilename: 'pbmc3k.h5',
  });
  const bytes = fs.readFileSync(h5Abs);
  db.markDatasetUploaded(project.id, dataset.id, {
    internalStorageKey: h5Rel,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    fileSizeBytes: bytes.length,
  });
  const inputObject = db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'matrix', datasetId: dataset.id, displayName: 'Raw 10x HDF5',
    metadata: { source: 'dataset', fileType: 'tenx_h5' },
  });
  const job = db.createProjectJob(owner.id, project.id, {
    jobType: 'seurat.pipeline.v1', datasetId: dataset.id, analysisObjectId: inputObject.id, parameters: {},
  });
  console.log(`INFO seeded job ${job.id}`);

  const plumber = spawn('Rscript', [RUN_R], {
    cwd: WORKSPACE,
    env: { ...process.env, API_TOKEN, PLUMBER_PORT: String(PLUMBER_PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  const cleanup = () => {
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(plumber.pid), '/T', '/F'], { stdio: 'ignore' }); else plumber.kill('SIGTERM'); } catch { /* ignore */ }
    try { fs.rmSync(vaultAbs, { recursive: true, force: true }); } catch { /* ignore */ }
    try { db.closeDatabase(); } catch { /* ignore */ }
  };

  try {
    if (!(await waitForPlumber())) throw new Error('plumber did not become healthy');
    console.log(`INFO plumber healthy on :${PLUMBER_PORT}`);

    // Default lease (120s) + in-flight renewal must carry the ~40s compute to completion.
    const worker = createJobWorker({ db, rBridgeConfig: { port: PLUMBER_PORT, token: API_TOKEN } });
    const result = await worker.runOnce();
    assert(result.status === 'completed', 'worker completed the seurat.pipeline.v1 job', result.status);

    const done = db.getProjectJob(owner.id, project.id, job.id);
    assert(done.status === 'completed', 'job status is completed');
    assert(typeof done.resultAnalysisObjectId === 'string' && done.resultAnalysisObjectId.startsWith('ao_'),
      'job produced a result analysis object', String(done.resultAnalysisObjectId));

    const resultObj = db.getProjectAnalysisObject(owner.id, project.id, done.resultAnalysisObjectId);
    assert(resultObj && resultObj.objectType === 'seurat', 'result object is a seurat object');

    const artifacts = db.getJobArtifactsByJobId(job.id);
    const types = artifacts.map((a) => a.artifactType).sort();
    assert(JSON.stringify(types) === JSON.stringify(['checkpoint', 'pipeline_summary']),
      'job created checkpoint + pipeline_summary artifacts', JSON.stringify(types));

    const summaryArtifact = artifacts.find((a) => a.artifactType === 'pipeline_summary');
    const summary = summaryArtifact && summaryArtifact.metadata && summaryArtifact.metadata.summary;
    assert(summary && summary.nCells === 2638, 'summary nCells matches tutorial (2638)', String(summary && summary.nCells));
    assert(summary && summary.nClusters === 9, 'summary nClusters matches tutorial (9)', String(summary && summary.nClusters));

    // No storage path/key leak in the public projection.
    const publicArtifacts = JSON.stringify(db.listProjectJobArtifacts(owner.id, project.id, job.id));
    assert(!publicArtifacts.includes(h5Rel) && !publicArtifacts.includes('vault/') && !publicArtifacts.includes('storageUri')
      && !publicArtifacts.includes('internalStorageKey'),
      'public artifact projection leaks no storage path/key');

    console.log(`\nALL ${passCount} CHECKS PASSED`);
  } finally {
    cleanup();
  }
}

main().catch((err) => { console.error(`FAIL ${err.message}`); process.exitCode = 1; });
