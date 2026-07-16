#!/usr/bin/env node
'use strict';

// Real-R lease-renewal check for the durable deg.find_markers.v1 worker path.
//
// scripts/verify_seurat_pipeline.js already proves that a real, long-running R call
// keeps its worker claim alive past a deliberately short lease via startClaimRenewal
// (backend/jobWorker.js). That mechanism is SHARED by every R-facing handler, but the
// mocked backend/deg-find-markers-worker.test.js suite stubs `callR` to return
// instantly, so it can never independently prove the DEG endpoint's own real R call
// (POST /object/deg-find-markers) survives lease renewal under load. This script closes
// that gap by driving the ACTUAL worker -> rWorkerBridge -> spawned R Plumber path for
// deg.find_markers.v1 specifically, with a real (small, fast) Seurat FindAllMarkers call
// delayed past a short lease, and asserts:
//   - at least two real lease heartbeat renewals during the delayed DEG call
//   - a competing claimant cannot reap/steal the job after the original lease deadline
//   - the job completes with the expected deg_markers + deg_summary artifacts
//   - the DEG summary reports the two seeded cluster groups
//   - no storage path/key leaks into the public artifact projection
//
// To keep this check fast and focused on DEG (not re-proving seurat.pipeline.v1's own
// lease renewal, which verify_seurat_pipeline.js already covers), the live-loadable
// input checkpoint is a small synthetic clustered Seurat object (built by
// scripts/make_deg_seed_checkpoint.R) manufactured directly as a completed
// pbmc.pipeline.v1 result via the real DB layer (no R call for that step), then
// reattached into live R for real via a checkpoint.load.v1 job before DEG runs.
//
// It SKIPS cleanly (exit 0) when Rscript / Seurat / dplyr are unavailable, so the
// default `npm run test:backend` stays green in CI (which has no R).
//
// Usage: node scripts/verify_deg_worker_pipeline.js  (or: npm run test:deg-worker-pipeline)

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = path.resolve(__dirname, '..');
const PLUMBER_PORT = Number(process.env.PLUMBER_TEST_PORT || 18133);
const API_TOKEN = 'verify-deg-worker-token-0000000000000000';
const RUN_R = path.join(WORKSPACE, 'r-backend', 'run.R');
const STORAGE_ROOT = path.join(WORKSPACE, 'data');

function skip(reason) {
  console.log(`SKIP verify_deg_worker_pipeline: ${reason}`);
  process.exit(0);
}

function rHasPackages() {
  const probe = spawnSync('Rscript', ['-e',
    'q(status = if (all(c("Seurat","dplyr") %in% rownames(installed.packages()))) 0 else 1)'
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

function spawnStandaloneWorkerOnce(env) {
  return spawn(process.execPath, [path.join(WORKSPACE, 'worker.js'), '--once'], {
    cwd: WORKSPACE,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

let passCount = 0;
function assert(cond, message, detail = '') {
  if (!cond) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
  passCount += 1;
  console.log(`PASS ${message}`);
}

async function main() {
  if (spawnSync('Rscript', ['--version'], { encoding: 'utf8' }).status !== 0) skip('Rscript not on PATH');
  if (!rHasPackages()) skip('Seurat / dplyr not installed in R');

  const db = require('../backend/pgDatabase');
  const { buildRChildEnv } = require('../backend/rRuntime');
  const { allocateCheckpointStorageKey } = require('../backend/pbmcPipeline');
  await db.initSchema();

  const stamp = Date.now();
  const owner = await db.createUser(`deg-worker-verify-${stamp}@example.com`, 'password123', 'Verifier');
  const org = await db.createOrganizationForUser(owner.id, { name: 'Verify Org' });
  const project = await db.createProjectForUser(owner.id, { organizationId: org.id, name: 'Verify Project' });
  const parent = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'matrix', displayName: 'Seed input',
  });

  // Manufacture a completed pbmc.pipeline.v1-shaped checkpoint directly at the DB layer
  // (no R call here — that lease-renewal path is proven by verify_seurat_pipeline.js).
  // This gives DEG a real, live-loadable checkpoint to work with while keeping this
  // script's real-R budget focused on the DEG endpoint itself.
  const seedJob = await db.createProjectJob(owner.id, project.id, {
    jobType: 'pbmc.pipeline.v1', analysisObjectId: parent.id, parameters: {},
  });
  const claimed = await db.claimNextJob('worker_seed', { leaseSeconds: 300 });
  if (!claimed || claimed.id !== seedJob.id) throw new Error('failed to claim seed job');

  const checkpointStorageKey = allocateCheckpointStorageKey(project.id, seedJob.id);
  const checkpointAbsPath = path.join(STORAGE_ROOT, checkpointStorageKey);
  fs.mkdirSync(path.dirname(checkpointAbsPath), { recursive: true });

  console.log('INFO building synthetic clustered checkpoint bundle ...');
  const buildCkpt = spawnSync('Rscript',
    [path.join('scripts', 'make_deg_seed_checkpoint.R'), checkpointAbsPath],
    { cwd: WORKSPACE, encoding: 'utf8' });
  if (buildCkpt.status !== 0 || !fs.existsSync(checkpointAbsPath)) {
    console.error(buildCkpt.stderr || buildCkpt.stdout);
    throw new Error('checkpoint seed build failed');
  }
  const ckptBytes = fs.readFileSync(checkpointAbsPath);
  const checksumSha256 = crypto.createHash('sha256').update(ckptBytes).digest('hex');

  const completion = await db.completePbmcPipelineResultByWorker(
    seedJob.id, 'worker_seed', claimed.claimToken,
    {
      result: {
        objectType: 'seurat', displayName: 'Seed clustered object',
        metadata: { source: 'seed', scientific_output: true },
      },
      checkpointArtifact: {
        artifactType: 'checkpoint', name: 'Seed checkpoint',
        description: 'Synthetic seed checkpoint for the DEG worker lease-renewal check.',
        storageKind: 'local_internal', internalStorageKey: checkpointStorageKey,
        checksumSha256, sizeBytes: ckptBytes.length,
        metadata: { operation: 'seed', scientific_output: true, downloadable: false },
      },
      summaryArtifact: {
        artifactType: 'pipeline_summary', name: 'Seed summary',
        description: 'Synthetic seed summary.',
        storageKind: 'metadata_only', metadata: { source: 'seed' },
      },
    }
  );
  const resultObjectId = completion.resultObject.id;
  // Release the seed job's claim/lease now that its result is committed. The one-slot
  // topology refuses any new claim while ANY job holds an unexpired 'running' lease
  // (backend/pgDatabase.js claimNextJob's activeClaim guard), so leaving this claim open
  // would silently block both the checkpoint.load.v1 and deg.find_markers.v1 jobs below.
  await db.completeJobByWorker(seedJob.id, 'worker_seed', claimed.claimToken, {
    resultAnalysisObjectId: resultObjectId,
  });
  console.log(`INFO seeded clustered checkpoint object ${resultObjectId}`);

  const plumber = spawn('Rscript', [RUN_R], {
    cwd: WORKSPACE,
    env: buildRChildEnv({
      ...process.env,
      ENABLE_R_TEST_DIAGNOSTICS: 'true',
      R_TEST_DEG_DELAY_MS: '16000',
    }, {
      token: API_TOKEN,
      port: PLUMBER_PORT,
      storageRoot: STORAGE_ROOT,
      analysisRoot: WORKSPACE,
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let loadWorkerProcess = null;
  let degWorkerProcess = null;

  const cleanup = async () => {
    for (const proc of [loadWorkerProcess, degWorkerProcess]) {
      try { if (proc && proc.exitCode === null) proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(plumber.pid), '/T', '/F'], { stdio: 'ignore' }); else plumber.kill('SIGTERM'); } catch { /* ignore */ }
    try { await db.close(); } catch { /* ignore */ }
  };

  try {
    if (!(await waitForPlumber())) throw new Error('plumber did not become healthy');
    console.log(`INFO plumber healthy on :${PLUMBER_PORT}`);

    const baseWorkerEnv = {
      ...process.env,
      ENABLE_JOB_WORKER: 'true',
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: `http://127.0.0.1:${PLUMBER_PORT}`,
      R_API_TOKEN: API_TOKEN,
      STORAGE_ROOT,
      JOB_WORKER_HEALTH_PORT: '0',
      JOB_WORKER_MIN_FREE_MEMORY_MB: '1',
    };

    // 1. Reattach the seeded checkpoint into the owner's live session for real (fast;
    //    no injected delay on /object/checkpoint-load). A generous lease is fine here —
    //    this step's own lease renewal is not what this script is proving.
    const loadJob = await db.createProjectJob(owner.id, project.id, {
      jobType: 'checkpoint.load.v1', analysisObjectId: resultObjectId, parameters: {},
    });
    loadWorkerProcess = spawnStandaloneWorkerOnce({
      ...baseWorkerEnv,
      JOB_WORKER_LEASE_SECONDS: '120',
      JOB_WORKER_STARTUP_TIMEOUT_MS: '30000',
    });
    const loadExitCode = await waitForExit(loadWorkerProcess);
    assert(loadExitCode === 0, 'checkpoint-load worker process exited cleanly', String(loadExitCode));
    const loadedJobRow = await db.getProjectJob(owner.id, project.id, loadJob.id);
    assert(loadedJobRow.status === 'completed', 'checkpoint.load.v1 completed', loadedJobRow.status);

    // 2. Run deg.find_markers.v1 for real with a deliberately short lease against the
    //    16s R-side diagnostic delay, so multiple heartbeat renewals are REQUIRED for
    //    the job to survive to completion.
    const degJob = await db.createProjectJob(owner.id, project.id, {
      jobType: 'deg.find_markers.v1', analysisObjectId: resultObjectId, parameters: {},
    });
    degWorkerProcess = spawnStandaloneWorkerOnce({
      ...baseWorkerEnv,
      JOB_WORKER_LEASE_SECONDS: '12',
      JOB_WORKER_STARTUP_TIMEOUT_MS: '30000',
    });
    let degWorkerExited = false;
    let degWorkerExitCode = null;
    const degWorkerExit = new Promise((resolve, reject) => {
      degWorkerProcess.once('error', reject);
      degWorkerProcess.once('exit', (code) => {
        degWorkerExited = true;
        degWorkerExitCode = code;
        resolve(code);
      });
    });

    const renewedHeartbeatValues = new Set();
    let initialRunningHeartbeat = null;
    let runningSince = null;
    let competitorChecked = false;
    const deadline = Date.now() + 5 * 60 * 1000;
    while (!degWorkerExited && Date.now() < deadline) {
      const current = await db.getWorkerJob(degJob.id);
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
        assert(!reaped.requeued.includes(degJob.id) && !reaped.failed.includes(degJob.id),
          'live heartbeat prevents lease reaping after the original deadline');
        const competingClaim = await db.claimNextJob('worker_competing_probe', { leaseSeconds: 12 });
        assert(competingClaim === null, 'a second worker cannot claim the heartbeating DEG job');
        competitorChecked = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!degWorkerExited && Date.now() >= deadline) throw new Error('standalone worker timed out');
    await degWorkerExit;
    assert(degWorkerExitCode === 0, 'standalone worker process exited cleanly', String(degWorkerExitCode));
    assert(competitorChecked, 'competing reaper check ran after the original lease deadline');
    assert(renewedHeartbeatValues.size >= 2,
      'controlled long real-R DEG call recorded at least two lease renewals',
      String(renewedHeartbeatValues.size));

    const done = await db.getProjectJob(owner.id, project.id, degJob.id);
    assert(done.status === 'completed', 'DEG job status is completed');

    const artifacts = await db.getJobArtifactsByJobId(degJob.id);
    const types = artifacts.map((a) => a.artifactType).sort();
    assert(JSON.stringify(types) === JSON.stringify(['deg_markers', 'deg_summary']),
      'DEG job created deg_markers + deg_summary artifacts', JSON.stringify(types));

    const summaryArtifact = artifacts.find((a) => a.artifactType === 'deg_summary');
    const summaryMeta = summaryArtifact && summaryArtifact.metadata && summaryArtifact.metadata.summary;
    const groups = summaryMeta && summaryMeta.groups;
    assert(Array.isArray(groups) && groups.length === 2,
      'DEG summary reports the two seeded groups (A, B)', JSON.stringify(groups));

    // No storage path/key leak in the public projection.
    const publicArtifacts = JSON.stringify(await db.listProjectJobArtifacts(owner.id, project.id, degJob.id));
    assert(!publicArtifacts.includes(checkpointStorageKey) && !publicArtifacts.includes('projects/')
      && !publicArtifacts.includes('storageUri') && !publicArtifacts.includes('internalStorageKey'),
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
