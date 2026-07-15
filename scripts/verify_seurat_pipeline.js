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
const API_TOKEN = 'verify-seurat-pipeline-token-0000000000000000';
const RUN_R = path.join(WORKSPACE, 'r-backend', 'run.R');
const STORAGE_ROOT = path.join(WORKSPACE, 'data');

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

  const db = require('../backend/pgDatabase');
  const { buildRChildEnv } = require('../backend/rRuntime');
  await db.initSchema();

  const owner = await db.createUser(`seurat-verify-${stamp}@example.com`, 'password123', 'Verifier');
  const org = await db.createOrganizationForUser(owner.id, { name: 'Verify Org' });
  const project = await db.createProjectForUser(owner.id, { organizationId: org.id, name: 'Verify Project' });
  const dataset = await db.createDatasetForProject(owner.id, project.id, {
    fileType: 'tenx_h5', originalFilename: 'pbmc3k.h5',
  });
  const bytes = fs.readFileSync(h5Abs);
  await db.markDatasetUploaded(project.id, dataset.id, {
    internalStorageKey: h5Rel,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    fileSizeBytes: bytes.length,
  });
  const inputObject = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'matrix', datasetId: dataset.id, displayName: 'Raw 10x HDF5',
    metadata: { source: 'dataset', fileType: 'tenx_h5' },
  });
  const job = await db.createProjectJob(owner.id, project.id, {
    jobType: 'seurat.pipeline.v1', datasetId: dataset.id, analysisObjectId: inputObject.id, parameters: {},
  });
  console.log(`INFO seeded job ${job.id}`);

  const plumber = spawn('Rscript', [RUN_R], {
    cwd: WORKSPACE,
    env: buildRChildEnv({
      ...process.env,
      ENABLE_R_TEST_DIAGNOSTICS: 'true',
      R_TEST_SEURAT_DELAY_MS: '16000',
    }, {
      token: API_TOKEN,
      port: PLUMBER_PORT,
      storageRoot: STORAGE_ROOT,
      analysisRoot: WORKSPACE,
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let workerProcess = null;

  const cleanup = async () => {
    try {
      if (workerProcess && workerProcess.exitCode === null) workerProcess.kill('SIGTERM');
    } catch { /* ignore */ }
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(plumber.pid), '/T', '/F'], { stdio: 'ignore' }); else plumber.kill('SIGTERM'); } catch { /* ignore */ }
    try { fs.rmSync(vaultAbs, { recursive: true, force: true }); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
  };

  try {
    if (!(await waitForPlumber())) throw new Error('plumber did not become healthy');
    console.log(`INFO plumber healthy on :${PLUMBER_PORT}`);

    // Run the real standalone process with a deliberately short lease. The pipeline
    // exceeds that lease, so repeated heartbeat advances are required to prevent a
    // competing reaper/worker from taking the job.
    workerProcess = spawn(process.execPath, [path.join(WORKSPACE, 'worker.js'), '--once'], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        ENABLE_JOB_WORKER: 'true',
        R_RUNTIME_MODE: 'external',
        R_BACKEND_URL: `http://127.0.0.1:${PLUMBER_PORT}`,
        R_API_TOKEN: API_TOKEN,
        STORAGE_ROOT,
        JOB_WORKER_HEALTH_PORT: '0',
        JOB_WORKER_MIN_FREE_MEMORY_MB: '1',
        JOB_WORKER_LEASE_SECONDS: '12',
        JOB_WORKER_STARTUP_TIMEOUT_MS: '30000',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    let workerExited = false;
    let workerExitCode = null;
    const workerExit = new Promise((resolve, reject) => {
      workerProcess.once('error', reject);
      workerProcess.once('exit', (code) => {
        workerExited = true;
        workerExitCode = code;
        resolve(code);
      });
    });

    const renewedHeartbeatValues = new Set();
    let initialRunningHeartbeat = null;
    let runningSince = null;
    let competitorChecked = false;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (!workerExited && Date.now() < deadline) {
      const current = await db.getWorkerJob(job.id);
      if (current && current.status === 'running' && runningSince === null) {
        runningSince = Date.now();
        initialRunningHeartbeat = current.heartbeatAt;
      }
      if (current && current.status === 'running' && current.heartbeatAt
          && initialRunningHeartbeat && current.heartbeatAt !== initialRunningHeartbeat) {
        renewedHeartbeatValues.add(current.heartbeatAt);
      }
      if (!competitorChecked && runningSince !== null && Date.now() - runningSince >= 14000) {
        const reaped = await db.reapExpiredJobs();
        assert(!reaped.requeued.includes(job.id) && !reaped.failed.includes(job.id),
          'live heartbeat prevents lease reaping after the original deadline');
        const competingClaim = await db.claimNextJob('worker_competing_probe', { leaseSeconds: 12 });
        assert(competingClaim === null, 'a second worker cannot claim the heartbeating job');
        competitorChecked = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!workerExited && Date.now() >= deadline) throw new Error('standalone worker timed out');
    await workerExit;
    assert(workerExitCode === 0, 'standalone worker process exited cleanly', String(workerExitCode));
    assert(competitorChecked, 'competing reaper check ran after the original lease deadline');
    assert(renewedHeartbeatValues.size >= 2,
      'controlled long real-R call recorded at least two lease renewals',
      String(renewedHeartbeatValues.size));

    const done = await db.getProjectJob(owner.id, project.id, job.id);
    assert(done.status === 'completed', 'job status is completed');
    assert(typeof done.resultAnalysisObjectId === 'string' && done.resultAnalysisObjectId.startsWith('ao_'),
      'job produced a result analysis object', String(done.resultAnalysisObjectId));

    const resultObj = await db.getProjectAnalysisObject(owner.id, project.id, done.resultAnalysisObjectId);
    assert(resultObj && resultObj.objectType === 'seurat', 'result object is a seurat object');

    const artifacts = await db.getJobArtifactsByJobId(job.id);
    const types = artifacts.map((a) => a.artifactType).sort();
    assert(JSON.stringify(types) === JSON.stringify(['checkpoint', 'pipeline_summary']),
      'job created checkpoint + pipeline_summary artifacts', JSON.stringify(types));

    const summaryArtifact = artifacts.find((a) => a.artifactType === 'pipeline_summary');
    const summary = summaryArtifact && summaryArtifact.metadata && summaryArtifact.metadata.summary;
    assert(summary && summary.nCells === 2638, 'summary nCells matches tutorial (2638)', String(summary && summary.nCells));
    assert(summary && summary.nClusters === 9, 'summary nClusters matches tutorial (9)', String(summary && summary.nClusters));

    // No storage path/key leak in the public projection.
    const publicArtifacts = JSON.stringify(await db.listProjectJobArtifacts(owner.id, project.id, job.id));
    assert(!publicArtifacts.includes(h5Rel) && !publicArtifacts.includes('vault/') && !publicArtifacts.includes('storageUri')
      && !publicArtifacts.includes('internalStorageKey'),
      'public artifact projection leaks no storage path/key');

    console.log(`\nALL ${passCount} CHECKS PASSED`);
  } finally {
    await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`FAIL ${err.message}`);
    process.exit(1);
  });
