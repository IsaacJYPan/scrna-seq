#!/usr/bin/env node
'use strict';

// Real-R acceptance for seurat.multisample.v1. This complements mocked worker
// tests by exercising genuine 10x HDF5 reads, Seurat merge/preprocessing,
// checkpoint publication, completion receipts, and the durable result contract.

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const PLUMBER_PORT = Number(process.env.PLUMBER_TEST_PORT || 18134);
const API_TOKEN = 'verify-multisample-seurat-token-0000000000000000';
const RUN_R = path.join(WORKSPACE, 'r-backend', 'run.R');
const STORAGE_ROOT = path.join(WORKSPACE, 'data');

function skip(reason) {
  console.log(`SKIP verify_multi_sample_seurat_pipeline: ${reason}`);
  process.exit(0);
}

function assert(condition, message, detail = '') {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
  console.log(`PASS ${message}`);
}

function rHasPackages() {
  const probe = spawnSync('Rscript', ['-e',
    'q(status = if (all(c("Seurat","hdf5r","Matrix") %in% rownames(installed.packages()))) 0 else 1)'
  ], { cwd: WORKSPACE, encoding: 'utf8' });
  return probe.status === 0;
}

function health() {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: PLUMBER_PORT, path: '/health', timeout: 2000 },
      response => { response.resume(); resolve(response.statusCode); });
    request.on('error', () => resolve(0));
    request.on('timeout', () => { request.destroy(); resolve(0); });
  });
}

async function waitForPlumber(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await health();
    if (status === 200 || status === 403) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('standalone worker timed out')), timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function main() {
  if (spawnSync('Rscript', ['--version'], { encoding: 'utf8' }).status !== 0) skip('Rscript not on PATH');
  if (!rHasPackages()) skip('Seurat / hdf5r / Matrix not installed in R');
  if (!process.env.DATABASE_URL) skip('DATABASE_URL is not configured');

  const matrixDirectory = path.join(
    WORKSPACE, 'data', 'pbmc3k', 'filtered_gene_bc_matrices', 'hg19'
  );
  if (!fs.existsSync(matrixDirectory)) skip('PBMC3k MTX sample data missing');

  const stamp = Date.now();
  const inputRelativeRoot = `vault/verify_multisample_${stamp}`;
  const inputAbsoluteRoot = path.join(WORKSPACE, inputRelativeRoot);
  fs.mkdirSync(inputAbsoluteRoot, { recursive: true });
  const baseH5 = path.join(inputAbsoluteRoot, 'base.h5');
  const conversion = spawnSync(
    'Rscript',
    [path.join('scripts', 'make_pbmc3k_h5.R'), matrixDirectory, baseH5],
    { cwd: WORKSPACE, encoding: 'utf8' }
  );
  if (conversion.status !== 0 || !fs.existsSync(baseH5)) {
    console.error(conversion.stderr || conversion.stdout);
    throw new Error('10x HDF5 fixture conversion failed');
  }

  const db = require('../backend/pgDatabase');
  const storage = require('../backend/storage');
  const { buildRChildEnv } = require('../backend/rRuntime');
  const durableStorage = storage.createLocalStorageProvider({ root: STORAGE_ROOT });
  await db.initSchema();

  const owner = await db.createUser(`multisample-verify-${stamp}@example.com`, 'password123', 'Verifier');
  const organization = await db.createOrganizationForUser(owner.id, { name: 'Multi-sample Verify Org' });
  const project = await db.createProjectForUser(owner.id, {
    organizationId: organization.id,
    name: 'Multi-sample Verify Project',
  });

  const sampleDefinitions = [
    { sampleName: 'control 1', conditionName: 'control' },
    { sampleName: 'treated 1', conditionName: 'treated' },
  ];
  const datasets = [];
  const datasetStorageKeys = [];
  for (let index = 0; index < sampleDefinitions.length; index += 1) {
    const filename = `sample_${index + 1}.h5`;
    const uploadSource = path.join(inputAbsoluteRoot, filename);
    fs.copyFileSync(baseH5, uploadSource);
    const dataset = await db.createDatasetForProject(owner.id, project.id, {
      fileType: 'tenx_h5', originalFilename: filename,
    });
    const key = storage.projectStorageFileKey(project.id, 'datasets', dataset.id, filename);
    const stored = await durableStorage.putFileFromPath(uploadSource, key);
    datasetStorageKeys.push(key);
    datasets.push(await db.markDatasetUploaded(project.id, dataset.id, {
      internalStorageKey: stored.key,
      sha256: stored.checksumSha256,
      fileSizeBytes: stored.sizeBytes,
    }));
  }

  const inputObject = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'matrix',
    datasetId: datasets[0].id,
    displayName: 'Primary multi-sample input',
    metadata: { source: 'dataset', fileType: 'tenx_h5' },
  });
  const job = await db.createProjectJob(owner.id, project.id, {
    jobType: 'seurat.multisample.v1',
    datasetId: datasets[0].id,
    analysisObjectId: inputObject.id,
    parameters: {
      samples: sampleDefinitions.map((definition, index) => ({
        datasetId: datasets[index].id,
        ...definition,
        donorCode: null,
        batch: null,
      })),
      seed: 17,
    },
  });

  const plumber = spawn('Rscript', [RUN_R], {
    cwd: WORKSPACE,
    env: buildRChildEnv(process.env, {
      token: API_TOKEN,
      port: PLUMBER_PORT,
      storageRoot: STORAGE_ROOT,
      analysisRoot: WORKSPACE,
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let workerProcess = null;
  const cleanup = async () => {
    try { if (workerProcess && workerProcess.exitCode === null) workerProcess.kill('SIGTERM'); } catch { /* best effort */ }
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(plumber.pid), '/T', '/F'], { stdio: 'ignore' });
      } else plumber.kill('SIGTERM');
    } catch { /* best effort */ }
    for (const key of [
      ...datasetStorageKeys,
      storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'checkpoint.rds'),
      storage.completionReceiptKey(project.id, job.id),
    ]) {
      try { durableStorage.remove(key); } catch { /* best effort */ }
    }
    const projectStorageRoot = path.resolve(STORAGE_ROOT, 'projects', project.id);
    for (const emptyDirectory of [
      ...datasets.map(dataset => path.join(projectStorageRoot, 'datasets', dataset.id)),
      path.join(projectStorageRoot, 'datasets'),
      path.join(projectStorageRoot, 'checkpoints', job.id),
      path.join(projectStorageRoot, 'checkpoints'),
      path.join(projectStorageRoot, 'artifacts', job.id),
      path.join(projectStorageRoot, 'artifacts'),
      projectStorageRoot,
    ]) {
      try { fs.rmdirSync(emptyDirectory); } catch { /* remove empty directories only */ }
    }
    try {
      const expectedParent = path.resolve(WORKSPACE, 'vault');
      const resolvedInputRoot = path.resolve(inputAbsoluteRoot);
      const relativeInputRoot = path.relative(expectedParent, resolvedInputRoot);
      if (relativeInputRoot && !relativeInputRoot.startsWith('..') && !path.isAbsolute(relativeInputRoot)
          && path.basename(resolvedInputRoot).startsWith('verify_multisample_')) {
        fs.rmSync(resolvedInputRoot, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
    try { await db.close(); } catch { /* best effort */ }
  };

  try {
    if (!(await waitForPlumber())) throw new Error('plumber did not become healthy');
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
        JOB_WORKER_LEASE_SECONDS: '30',
        JOB_WORKER_STARTUP_TIMEOUT_MS: '30000',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const exitCode = await waitForExit(workerProcess, 10 * 60 * 1000);
    assert(exitCode === 0, 'standalone worker exited cleanly', String(exitCode));

    const completed = await db.getProjectJob(owner.id, project.id, job.id);
    assert(completed.status === 'completed', 'multi-sample job completed', completed.status);
    const result = await db.getProjectAnalysisObject(
      owner.id, project.id, completed.resultAnalysisObjectId
    );
    assert(result && result.objectType === 'seurat', 'result is a reusable Seurat analysis');
    assert(result.metadata.sampleMetadataColumn === 'sample_id', 'result records the sample metadata column');
    assert(result.metadata.conditionMetadataColumn === 'condition', 'result records the condition metadata column');
    assert(result.metadata.summary.nSamples === 2, 'real-R summary records both biological samples');
    assert(JSON.stringify(result.metadata.summary.conditions) === JSON.stringify(['control', 'treated']),
      'real-R summary records both conditions');

    const artifacts = await db.getJobArtifactsByJobId(job.id);
    assert(JSON.stringify(artifacts.map(artifact => artifact.artifactType).sort())
      === JSON.stringify(['checkpoint', 'pipeline_summary']),
    'job published one checkpoint and one summary artifact');
    const publicArtifacts = JSON.stringify(
      await db.listProjectJobArtifacts(owner.id, project.id, job.id)
    );
    assert(!publicArtifacts.includes('vault/') && !publicArtifacts.includes('storageUri')
      && !publicArtifacts.includes('internalStorageKey'),
    'public artifacts contain no storage paths or keys');
  } finally {
    await cleanup();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  });
