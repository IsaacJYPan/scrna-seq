#!/usr/bin/env node
'use strict';

// Real durable CellChat worker smoke. It drives the actual standalone worker,
// rWorkerBridge, and spawned R Plumber service against a private, owner-loaded
// Seurat checkpoint. The harness intentionally drops the first successful R
// response after R has persisted its signed completion receipt, then advances
// the bounded recovery window and proves a second worker publishes exactly that
// output without issuing CellChat a second time.
//
// This is deliberately an integration test rather than a browser test. It
// proves the worker/R/private-storage/receipt path; the browser flow has its
// own mocked-transport Playwright test.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const PLUMBER_PORT = Number(process.env.CELLCHAT_WORKER_PLUMBER_PORT || 18134);
const PROXY_PORT = Number(process.env.CELLCHAT_WORKER_PROXY_PORT || 18135);
const API_TOKEN = 'verify-cellchat-worker-token-0000000000000000';
const RUN_R = path.join(WORKSPACE, 'r-backend', 'run.R');
const R_SEED_SCRIPT = path.join(WORKSPACE, 'scripts', 'make_cellchat_seed_checkpoint.R');

function skip(reason) {
  console.log(`SKIP verify_cellchat_worker_pipeline: ${reason}`);
  process.exit(0);
}

function rHasPackages() {
  const probe = spawnSync('Rscript', ['-e',
    'q(status = if (all(c("Seurat","dplyr","CellChat","NMF") %in% rownames(installed.packages()))) 0 else 1)'
  ], { cwd: WORKSPACE, encoding: 'utf8' });
  return probe.status === 0;
}

function httpGetHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

async function waitForPlumber(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const code = await httpGetHealth(PLUMBER_PORT);
    if (code === 200 || code === 403) return true; // 403 means it is alive and requires its token.
    await new Promise((resolve) => setTimeout(resolve, 2000));
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

function startResponseDroppingProxy() {
  const counters = { cellChatRequests: 0, droppedResponses: 0 };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const dropResponse = req.method === 'POST' && pathname === '/object/cellchat-infer';
    if (dropResponse) counters.cellChatRequests += 1;

    const upstream = http.request({
      host: '127.0.0.1',
      port: PLUMBER_PORT,
      method: req.method,
      path: req.url,
      headers: req.headers,
    }, (upstreamRes) => {
      if (dropResponse) {
        // Fully consume R's response first. Its endpoint has already atomically
        // written the CSV and signed receipt before it responds. Closing only the
        // downstream side then models a real response-side disconnect without
        // re-running CellChat.
        upstreamRes.resume();
        upstreamRes.once('end', () => {
          counters.droppedResponses += 1;
          if (!res.destroyed) res.destroy();
        });
        return;
      }
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.destroyed) res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PROXY_PORT, '127.0.0.1', () => resolve({ server, counters }));
  });
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

let passCount = 0;
function assert(condition, message, detail = '') {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
  passCount += 1;
  console.log(`PASS ${message}`);
}

async function main() {
  if (!process.env.DATABASE_URL) skip('DATABASE_URL is not set (requires a real test Postgres database)');
  if (spawnSync('Rscript', ['--version'], { encoding: 'utf8' }).status !== 0) skip('Rscript not on PATH');
  if (!rHasPackages()) skip('Seurat / dplyr / CellChat / NMF are not installed in R');

  const db = require('../backend/pgDatabase');
  const storage = require('../backend/storage');
  const { buildRChildEnv } = require('../backend/rRuntime');
  const { allocateCheckpointStorageKey } = require('../backend/pbmcPipeline');
  const { allocateCellChatInferenceResultStorageKey } = require('../backend/cellChatInference');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scrna-cellchat-worker-'));
  const storageRoot = path.join(tempRoot, 'storage');
  let plumber = null;
  let responseProxy = null;
  let loadWorker = null;
  let firstCellChatWorker = null;
  let recoveryWorker = null;

  const cleanup = async () => {
    await closeServer(responseProxy && responseProxy.server);
    for (const proc of [loadWorker, firstCellChatWorker, recoveryWorker]) {
      try { if (proc && proc.exitCode === null) proc.kill('SIGTERM'); } catch { /* best effort */ }
    }
    try {
      if (plumber && plumber.exitCode === null) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(plumber.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          plumber.kill('SIGTERM');
        }
      }
    } catch { /* best effort */ }
    try { await db.close(); } catch { /* best effort */ }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };

  try {
    await db.initSchema();
    const stamp = Date.now();
    const owner = await db.createUser(`cellchat-worker-verify-${stamp}@example.com`, 'password123', 'Verifier');
    const org = await db.createOrganizationForUser(owner.id, { name: 'CellChat Verify Org' });
    const project = await db.createProjectForUser(owner.id, { organizationId: org.id, name: 'CellChat Verify Project' });
    const parent = await db.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'matrix', displayName: 'CellChat seed input',
    });

    // Manufacture the completed source checkpoint through the same durable DB
    // shapes used by the checkpoint loader. The only scientific compute here is
    // the target CellChat job; this keeps the smoke focused and repeatable.
    const seedJob = await db.createProjectJob(owner.id, project.id, {
      jobType: 'pbmc.pipeline.v1', analysisObjectId: parent.id, parameters: {},
    });
    const claimedSeed = await db.claimNextJob('worker_cellchat_seed', { leaseSeconds: 300 });
    if (!claimedSeed || claimedSeed.id !== seedJob.id) throw new Error('failed to claim CellChat seed job');

    const checkpointStorageKey = allocateCheckpointStorageKey(project.id, seedJob.id);
    const checkpointAbsPath = path.join(storageRoot, checkpointStorageKey);
    fs.mkdirSync(path.dirname(checkpointAbsPath), { recursive: true });
    console.log('INFO building synthetic CellChat checkpoint bundle ...');
    const seedBuild = spawnSync('Rscript', [R_SEED_SCRIPT, checkpointAbsPath], {
      cwd: WORKSPACE,
      encoding: 'utf8',
    });
    if (seedBuild.status !== 0 || !fs.existsSync(checkpointAbsPath)) {
      console.error(seedBuild.stderr || seedBuild.stdout);
      throw new Error('CellChat checkpoint seed build failed');
    }
    const checkpointBytes = fs.readFileSync(checkpointAbsPath);
    const checkpointChecksum = crypto.createHash('sha256').update(checkpointBytes).digest('hex');
    const seedCompletion = await db.completePbmcPipelineResultByWorker(
      seedJob.id, 'worker_cellchat_seed', claimedSeed.claimToken,
      {
        result: {
          objectType: 'seurat', displayName: 'CellChat seed clustered object',
          metadata: { source: 'cellchat-worker-smoke', scientific_output: true },
        },
        checkpointArtifact: {
          artifactType: 'checkpoint', name: 'CellChat seed checkpoint',
          description: 'Synthetic CellChat checkpoint for the real durable worker smoke.',
          storageKind: 'local_internal', internalStorageKey: checkpointStorageKey,
          checksumSha256: checkpointChecksum, sizeBytes: checkpointBytes.length,
          metadata: { operation: 'seed', scientific_output: true, downloadable: false },
        },
        summaryArtifact: {
          artifactType: 'pipeline_summary', name: 'CellChat seed summary',
          description: 'Synthetic CellChat worker seed summary.',
          storageKind: 'metadata_only', metadata: { source: 'cellchat-worker-smoke' },
        },
      }
    );
    const resultObjectId = seedCompletion.resultObject.id;
    await db.completeJobByWorker(seedJob.id, 'worker_cellchat_seed', claimedSeed.claimToken, {
      resultAnalysisObjectId: resultObjectId,
    });
    console.log(`INFO seeded CellChat checkpoint object ${resultObjectId}`);

    plumber = spawn('Rscript', [RUN_R], {
      cwd: WORKSPACE,
      env: buildRChildEnv(process.env, {
        token: API_TOKEN,
        port: PLUMBER_PORT,
        storageRoot,
        analysisRoot: WORKSPACE,
      }),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (!(await waitForPlumber())) throw new Error('plumber did not become healthy');
    console.log(`INFO plumber healthy on :${PLUMBER_PORT}`);

    const directWorkerEnv = {
      ...process.env,
      ENABLE_JOB_WORKER: 'true',
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: `http://127.0.0.1:${PLUMBER_PORT}`,
      R_API_TOKEN: API_TOKEN,
      STORAGE_ROOT: storageRoot,
      JOB_WORKER_HEALTH_PORT: '0',
      JOB_WORKER_MIN_FREE_MEMORY_MB: '1',
      JOB_WORKER_LEASE_SECONDS: '180',
      JOB_WORKER_STARTUP_TIMEOUT_MS: '90000',
    };

    // Reattach the checkpoint into the owner's private live R state through the
    // actual standalone worker before CellChat runs.
    const loadJob = await db.createProjectJob(owner.id, project.id, {
      jobType: 'checkpoint.load.v1', analysisObjectId: resultObjectId, parameters: {},
    });
    loadWorker = spawnStandaloneWorkerOnce(directWorkerEnv);
    const loadExitCode = await waitForExit(loadWorker);
    assert(loadExitCode === 0, 'checkpoint-load worker process exited cleanly', String(loadExitCode));
    const loaded = await db.getProjectJob(owner.id, project.id, loadJob.id);
    assert(loaded.status === 'completed', 'checkpoint.load.v1 completed against real R', loaded.status);

    const cellChatParameters = {
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      databaseCategory: 'secreted_signaling',
      analysisIntent: 'single_context',
      minCellsPerGroup: 10,
      maxCellsPerGroup: 500,
      maxTotalCells: 1000,
      pValueCutoff: 0.1,
      topInteractions: 5,
      topPathways: 5,
      randomSeed: 17,
    };
    const cellChatJob = await db.createProjectJob(owner.id, project.id, {
      jobType: 'cellchat.infer.v1', analysisObjectId: resultObjectId, parameters: cellChatParameters,
    });
    const resultStorageKey = allocateCellChatInferenceResultStorageKey(project.id, cellChatJob.id);
    const resultAbsPath = path.join(storageRoot, resultStorageKey);
    const receiptStorageKey = storage.completionReceiptKey(project.id, cellChatJob.id);
    const receiptAbsPath = path.join(storageRoot, receiptStorageKey);

    responseProxy = await startResponseDroppingProxy();
    const droppedResponseWorkerEnv = {
      ...directWorkerEnv,
      R_BACKEND_URL: `http://127.0.0.1:${PROXY_PORT}`,
    };
    firstCellChatWorker = spawnStandaloneWorkerOnce(droppedResponseWorkerEnv);
    const firstExitCode = await waitForExit(firstCellChatWorker);
    assert(firstExitCode === 0,
      'response-disconnect CellChat worker process exited without a runtime crash', String(firstExitCode));
    assert(responseProxy.counters.cellChatRequests === 1 && responseProxy.counters.droppedResponses === 1,
      'the proxy observed exactly one completed CellChat dispatch before dropping its response',
      JSON.stringify(responseProxy.counters));
    assert(fs.existsSync(resultAbsPath) && fs.statSync(resultAbsPath).size > 0,
      'real R persisted the private CellChat CSV before the response disconnect');
    assert(fs.existsSync(receiptAbsPath) && fs.statSync(receiptAbsPath).size > 0,
      'real R persisted a signed CellChat completion receipt before the response disconnect');
    const indeterminate = await db.getWorkerJob(cellChatJob.id);
    assert(indeterminate.status === 'running'
      && indeterminate.lastWorkerError && indeterminate.lastWorkerError.code === 'R_TIMEOUT_INDETERMINATE',
    'the worker preserved the indeterminate CellChat result for receipt-only recovery',
    JSON.stringify(indeterminate.lastWorkerError));
    assert((await db.getJobArtifactsByJobId(cellChatJob.id)).length === 0,
      'no CellChat artifacts were published before receipt recovery');

    // The production grace window is five minutes. Advance only the test DB's
    // injected clock to reach the reviewed recovery-only claim without sleeping.
    const reaped = await db.reapExpiredJobs({ now: new Date(Date.now() + (6 * 60 * 1000)) });
    assert(reaped.requeued.includes(cellChatJob.id),
      'expired indeterminate CellChat job became one receipt-only recovery claim',
      JSON.stringify(reaped));
    const queuedForRecovery = await db.getWorkerJob(cellChatJob.id);
    assert(queuedForRecovery.status === 'queued'
      && queuedForRecovery.lastWorkerError && queuedForRecovery.lastWorkerError.code === 'R_TIMEOUT_RECOVERY_PENDING',
    'recovery queue marker blocks a second CellChat analysis dispatch',
    JSON.stringify(queuedForRecovery.lastWorkerError));

    const proxyCounters = responseProxy.counters;
    await closeServer(responseProxy.server);
    responseProxy = null;
    recoveryWorker = spawnStandaloneWorkerOnce(directWorkerEnv);
    const recoveryExitCode = await waitForExit(recoveryWorker);
    assert(recoveryExitCode === 0, 'receipt-recovery worker process exited cleanly', String(recoveryExitCode));
    assert(!fs.existsSync(receiptAbsPath),
      'the signed receipt was removed only after claim-guarded artifact publication');

    const completed = await db.getProjectJob(owner.id, project.id, cellChatJob.id);
    assert(completed.status === 'completed', 'CellChat job completed from its real R receipt', completed.status);
    const artifacts = await db.getJobArtifactsByJobId(cellChatJob.id);
    const artifactTypes = artifacts.map((artifact) => artifact.artifactType).sort();
    assert(JSON.stringify(artifactTypes) === JSON.stringify(['cellchat_results', 'cellchat_summary']),
      'receipt recovery published the fixed CellChat results and summary artifacts', JSON.stringify(artifactTypes));

    const resultsArtifact = artifacts.find((artifact) => artifact.artifactType === 'cellchat_results');
    const summaryArtifact = artifacts.find((artifact) => artifact.artifactType === 'cellchat_summary');
    assert(resultsArtifact && resultsArtifact.storageKind === 'local_internal'
      && resultsArtifact.storageUri === resultStorageKey && resultsArtifact.sizeBytes > 0
      && Number.isInteger(resultsArtifact.metadata && resultsArtifact.metadata.nRows)
      && resultsArtifact.metadata.nRows > 0,
    'the complete candidate table remains a populated private project artifact');
    const summary = summaryArtifact && summaryArtifact.metadata && summaryArtifact.metadata.summary;
    assert(summary && summary.analysisIntent === 'single_context'
      && summary.groupBy === 'seurat_clusters' && summary.species === 'human'
      && summary.databaseCategory === 'secreted_signaling',
    'the durable summary records the fixed CellChat scientific scope', JSON.stringify(summary));
    assert(Array.isArray(summary.groups) && summary.groups.length === 2
      && summary.groups.every((group) => /^Group [1-9][0-9]*$/.test(group.group)),
    'the durable summary exposes only opaque CellChat group labels', JSON.stringify(summary.groups));

    const privateCsv = fs.readFileSync(resultAbsPath, 'utf8');
    assert(privateCsv.includes('"source_group","target_group"') && !privateCsv.includes('unsafe/group'),
      'the private CSV uses opaque groups and excludes raw source metadata labels');
    const publicArtifacts = JSON.stringify(await db.listProjectJobArtifacts(owner.id, project.id, cellChatJob.id));
    assert(!publicArtifacts.includes(resultStorageKey) && !publicArtifacts.includes(storageRoot)
      && !publicArtifacts.includes('unsafe/group') && !/storage[_-]?(?:key|uri)|state[_-]?key/i.test(publicArtifacts),
    'the public artifact projection exposes neither private storage/state nor raw group labels');
    assert(proxyCounters.cellChatRequests === 1 && proxyCounters.droppedResponses === 1,
      'receipt recovery reused the persisted result instead of replaying CellChat', JSON.stringify(proxyCounters));

    console.log(`\nALL ${passCount} CHECKS PASSED`);
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
