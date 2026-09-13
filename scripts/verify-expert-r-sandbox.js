#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const stamp = `${process.pid}-${Date.now()}`;
const storageRoot = path.join(os.tmpdir(), `traceomics-expert-storage-${stamp}`);
const workRoot = path.join(os.tmpdir(), `traceomics-expert-work-${stamp}`);
const port = 40000 + crypto.randomInt(1000);
const token = crypto.randomBytes(32).toString('hex');
const profileId = 'scrna-r-4.5-bioconductor-3.22-v1';
const projectId = `proj_${crypto.randomBytes(12).toString('hex')}`;
const producerJobId = `job_${crypto.randomBytes(12).toString('hex')}`;
const checkpointKey = `projects/${projectId}/checkpoints/${producerJobId}/checkpoint.rds`;
let checkpointChecksumSha256 = null;
let checkpointSizeBytes = null;
let brokerProcess = null;
const acceptanceJobIds = new Set();

function run(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args.join(' ')} failed\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  return result;
}

function assert(condition, message, detail = '') {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Expert R broker did not become healthy.');
}

async function request(body, { auth = token, signal } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/run`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
  let parsed = {};
  try { parsed = await response.json(); } catch { /* asserted by caller */ }
  return { status: response.status, body: parsed };
}

function job(script, suffix = crypto.randomBytes(12).toString('hex')) {
  const jobId = `job_${suffix}`;
  acceptanceJobIds.add(jobId);
  return {
    jobId, projectId, profileId, script, checkpointStorageKey: checkpointKey,
    checkpointChecksumSha256,
    checkpointSizeBytes,
    outputStorageKey: `projects/${projectId}/artifacts/${jobId}/expert-r-outputs.tar.gz`,
  };
}

function archiveText(key, file) {
  const result = run([
    'run', '--rm', '-v', `${storageRoot}:/storage:ro`, 'alpine:3.21',
    'tar', '-xOzf', `/storage/data/${key}`, `./${file}`,
  ], { capture: true });
  return result.stdout.trim();
}

async function waitForCleanup() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const containers = run(['ps', '-a', '--filter', 'name=traceomics-expert-job_', '--format', '{{.Names}}'], { capture: true });
    const ownedContainers = containers.stdout.trim().split(/\r?\n/).filter((name) => (
      name && [...acceptanceJobIds].some((jobId) => name.includes(jobId))
    ));
    const workEntries = fs.existsSync(workRoot) ? fs.readdirSync(workRoot).length : 0;
    if (ownedContainers.length === 0 && workEntries === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Expert R container or job directory was not cleaned up.');
}

async function main() {
  let failed = false;
  try {
    console.log('[expert-r] building the reviewed R image');
    run(['build', '-f', 'r-backend/Dockerfile', '-t', 'traceomics-r:single-host', 'r-backend']);
    const inspected = run([
      'image', 'inspect', 'traceomics-r:single-host',
      '--format', '{{.Id}}',
    ], { capture: true });
    const rImage = inspected.stdout.trim();
    // Local builds have an immutable image ID even before publication to a registry.
    assert(/^sha256:[0-9a-f]{64}$/.test(rImage), 'R sandbox image must use an immutable image ID', rImage);

    fs.mkdirSync(path.join(storageRoot, 'data'), { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    const checkpointExpression = `
      suppressPackageStartupMessages({library(Seurat); library(Matrix)})
      set.seed(8181); counts <- matrix(rpois(120*120, 2), nrow=120, ncol=120)
      rownames(counts) <- paste0('Gene', seq_len(nrow(counts))); colnames(counts) <- paste0('Cell', seq_len(ncol(counts)))
      obj <- CreateSeuratObject(Matrix(counts, sparse=TRUE)); obj <- NormalizeData(obj, verbose=FALSE)
      dir.create(dirname('/storage/data/${checkpointKey}'), recursive=TRUE, showWarnings=FALSE)
      saveRDS(list(global=obj, raw=obj), '/storage/data/${checkpointKey}', compress=FALSE)
    `;
    run(['run', '--rm', '--user', '0:0', '-v', `${storageRoot}:/storage`, '--entrypoint', 'Rscript', rImage, '-e', checkpointExpression]);
    const checkpointDigest = run([
      'run', '--rm', '-v', `${storageRoot}:/storage:ro`, 'alpine:3.21',
      'sha256sum', `/storage/data/${checkpointKey}`,
    ], { capture: true });
    checkpointChecksumSha256 = checkpointDigest.stdout.trim().split(/\s+/)[0];
    assert(/^[0-9a-f]{64}$/.test(checkpointChecksumSha256), 'checkpoint checksum must be available');
    const checkpointSize = run([
      'run', '--rm', '-v', `${storageRoot}:/storage:ro`, 'alpine:3.21',
      'stat', '-c', '%s', `/storage/data/${checkpointKey}`,
    ], { capture: true });
    checkpointSizeBytes = Number(checkpointSize.stdout.trim());
    assert(Number.isSafeInteger(checkpointSizeBytes) && checkpointSizeBytes > 0, 'checkpoint size must be available');
    const privateInputId = `eri_${crypto.randomBytes(12).toString('hex')}`;
    const privateInputKey = `projects/${projectId}/artifacts/${privateInputId}/private-input.csv`;
    const privateInputPath = path.join(storageRoot, 'data', ...privateInputKey.split('/'));
    fs.mkdirSync(path.dirname(privateInputPath), { recursive: true });
    fs.writeFileSync(privateInputPath, 'sample,condition\nS1,treated\n', { flag: 'wx' });
    const privateInputBytes = fs.readFileSync(privateInputPath);
    const privateInput = {
      id: privateInputId,
      originalFilename: 'covariates.csv',
      internalStorageKey: privateInputKey,
      sizeBytes: privateInputBytes.length,
      checksumSha256: crypto.createHash('sha256').update(privateInputBytes).digest('hex'),
    };
    // Run the broker on host loopback for acceptance. Production runs the same
    // module in the hardened broker service sharing only the app's private
    // network namespace; the per-request R workload remains a fresh container.
    brokerProcess = spawn(process.execPath, [path.join(root, 'backend', 'expertSandboxBroker.js')], {
      cwd: root,
      env: {
        ...process.env,
        STORAGE_ROOT: path.join(storageRoot, 'data'),
        EXPERT_R_SANDBOX_TOKEN: token,
        EXPERT_R_SANDBOX_IMAGE: rImage,
        EXPERT_R_SANDBOX_WORK_ROOT: workRoot,
        EXPERT_R_SANDBOX_HOST: '127.0.0.1',
        EXPERT_R_SANDBOX_PORT: String(port),
        EXPERT_R_MAX_CONCURRENT: '2',
        EXPERT_R_MEMORY_LIMIT: '2g',
        EXPERT_R_CPU_LIMIT: '1',
        EXPERT_R_TIMEOUT_MS: '60000',
        EXPERT_R_MIN_FREE_BYTES: '268435456',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    await waitForHealth();

    const unauthorized = await request(job('write_table(data.frame(x=1), "x.csv")'), { auth: '0'.repeat(64) });
    assert(unauthorized.status === 404, 'wrong broker credentials must be indistinguishable from a missing route');
    const crossProject = job('write_table(data.frame(x=1), "x.csv")');
    crossProject.checkpointStorageKey = `projects/proj_${'f'.repeat(24)}/checkpoints/job_${'e'.repeat(24)}/checkpoint.rds`;
    const hidden = await request(crossProject);
    assert(hidden.status === 500, 'cross-project checkpoint scope must be rejected');

    const safe = job("write_table(data.frame(cells=ncol(obj), features=nrow(obj)), 'summary.csv')");
    const safeResult = await request(safe);
    assert(safeResult.status === 200 && safeResult.body.saved === true, 'reviewed Expert R execution must succeed', JSON.stringify(safeResult));
    assert(safeResult.body.nFiles === 1 && safeResult.body.outputBytes > 0,
      'the baseline output must be bounded and archived', JSON.stringify(safeResult));
    assert(safeResult.body.checkpointChecksumSha256 === checkpointChecksumSha256,
      'the broker must bind output provenance to the declared checkpoint checksum');
    assert(/^sha256:[0-9a-f]{64}$/.test(safeResult.body.sandboxImageDigest || ''),
      'the broker must report the pinned sandbox image digest');
    assert(safeResult.body.resourcePolicyVersion === 'expert-r-sandbox-policy.v3',
      'the broker must report the resource policy version');
    assert(safeResult.body.files.every((file) => /^[0-9a-f]{64}$/.test(file.checksumSha256 || '')),
      'every retained Expert R output must have a checksum');
    await waitForCleanup();

    const imported = job(`
      covariates <- read_input('covariates.csv')
      write_table(covariates, 'selected-input.csv')
    `);
    imported.privateInputs = [privateInput];
    const importedResult = await request(imported);
    assert(importedResult.status === 200 && importedResult.body.saved === true,
      'a selected creator-private input must be readable inside only that run', JSON.stringify(importedResult));
    assert(JSON.stringify(importedResult.body.privateInputs) === JSON.stringify([{
      id: privateInput.id,
      sizeBytes: privateInput.sizeBytes,
      checksumSha256: privateInput.checksumSha256,
    }]), 'private input provenance must contain only fixed IDs and integrity metadata');
    assert(archiveText(imported.outputStorageKey, 'selected-input.csv').includes('treated'),
      'the selected private input must drive a normal EDA output');
    await waitForCleanup();

    const rdsInputId = `eri_${crypto.randomBytes(12).toString('hex')}`;
    const rdsInputKey = `projects/${projectId}/artifacts/${rdsInputId}/private-input.rds`;
    run([
      'run', '--rm', '--user', '0:0', '-v', `${storageRoot}:/storage`,
      '--entrypoint', 'Rscript', rImage, '-e',
      `dir.create(dirname('/storage/data/${rdsInputKey}'), recursive=TRUE, showWarnings=FALSE); saveRDS(data.frame(sample=c('S1','S2'), batch=c('A','B')), '/storage/data/${rdsInputKey}')`,
    ]);
    const rdsInputPath = path.join(storageRoot, 'data', ...rdsInputKey.split('/'));
    const rdsInputBytes = fs.readFileSync(rdsInputPath);
    const rdsInput = {
      id: rdsInputId,
      originalFilename: 'batch-metadata.rds',
      internalStorageKey: rdsInputKey,
      sizeBytes: rdsInputBytes.length,
      checksumSha256: crypto.createHash('sha256').update(rdsInputBytes).digest('hex'),
    };
    const derived = job(`
      batch_metadata <- read_input('batch-metadata.rds')
      obj$imported_batch <- batch_metadata$batch[[1]]
      save_workspace(obj, 'derived-analysis.rds')
      write_table(batch_metadata, 'rds-input-summary.csv')
    `);
    derived.privateInputs = [rdsInput];
    const derivedResult = await request(derived);
    assert(derivedResult.status === 200 && derivedResult.body.saved === true,
      'sandbox-private RDS input and derived RDS output must succeed', JSON.stringify(derivedResult));
    assert(derivedResult.body.files.some((file) => file.name === 'derived-analysis.rds'),
      'derived RDS must be retained only in the bounded private output bundle');
    assert(archiveText(derived.outputStorageKey, 'rds-input-summary.csv').includes('S2'),
      'the sandbox must deserialize the selected private RDS input');
    await waitForCleanup();

    const oversized = job(`
      target <- safe_output_path('too-large.txt')
      connection <- file(target, open='wb')
      chunk <- raw(10 * 1024 * 1024)
      suppressWarnings(for (index in seq_len(25)) writeBin(chunk, connection))
      close(connection)
      if (file.info(target)$size < 250 * 1024 * 1024) stop('bounded output write was incomplete')
    `);
    const oversizedResult = await request(oversized);
    assert(oversizedResult.status === 422,
      'the kernel-backed per-run filesystem quota must stop an oversized write', JSON.stringify(oversizedResult));
    assert(oversizedResult.body.explanation === 'The R script exceeded the per-run output storage limit.',
      'quota failures must return only the fixed owner-safe explanation', JSON.stringify(oversizedResult));
    const oversizedArchiveMissing = run([
      'run', '--rm', '-v', `${storageRoot}:/storage:ro`, 'alpine:3.21',
      'test', '!', '-e', `/storage/data/${oversized.outputStorageKey}`,
    ], { capture: true });
    assert(oversizedArchiveMissing.status === 0, 'quota-failed runs must not publish an output bundle');
    await waitForCleanup();

    const controls = job(`
      options(timeout=2)
      network <- tryCatch({ con <- url('https://example.com', open='rb'); close(con); 'unexpected' }, error=function(e) 'blocked')
      storage_visible <- if (length(list.files('/app/storage-volume/data', all.files=TRUE, no..=TRUE)) == 0) 'isolated' else 'unexpected'
      root_write <- tryCatch({ writeLines('x', '/escape.txt'); 'unexpected' }, error=function(e) 'blocked')
      writeLines(network, safe_output_path('network.txt'))
      writeLines(storage_visible, safe_output_path('storage.txt'))
      writeLines(root_write, safe_output_path('root-write.txt'))
      writeLines(system('cat /sys/fs/cgroup/memory.max', intern=TRUE), safe_output_path('memory.txt'))
      writeLines(system('cat /sys/fs/cgroup/pids.max', intern=TRUE), safe_output_path('pids.txt'))
    `);
    const controlsResult = await request(controls);
    assert(controlsResult.status === 200 && controlsResult.body.nFiles === 5,
      'adversarial control probes must complete inside the sandbox', JSON.stringify(controlsResult));
    assert(archiveText(controls.outputStorageKey, 'network.txt') === 'blocked', 'sandbox networking must be disabled');
    assert(archiveText(controls.outputStorageKey, 'storage.txt') === 'isolated', 'project storage must not be mounted');
    assert(archiveText(controls.outputStorageKey, 'root-write.txt') === 'blocked', 'container root must be read-only');
    assert(Number(archiveText(controls.outputStorageKey, 'memory.txt')) <= 2 * 1024 * 1024 * 1024, 'memory cgroup must be bounded');
    assert(Number(archiveText(controls.outputStorageKey, 'pids.txt')) <= 256, 'PID cgroup must be bounded');
    await waitForCleanup();

    const copiedCheckpoint = job("file.copy('/work/input/checkpoint.rds', safe_output_path('copy.txt'))");
    const copiedCheckpointResult = await request(copiedCheckpoint);
    assert(copiedCheckpointResult.status === 500, 'an exact checkpoint copy must not become a downloadable Expert R output when disguised as text');
    const copiedCheckpointArchiveMissing = run([
      'run', '--rm', '-v', `${storageRoot}:/storage:ro`, 'alpine:3.21',
      'test', '!', '-e', `/storage/data/${copiedCheckpoint.outputStorageKey}`,
    ], { capture: true });
    assert(copiedCheckpointArchiveMissing.status === 0, 'rejected checkpoint copy must not publish an archive');
    await waitForCleanup();

    const symlink = job("file.symlink('/work/input/checkpoint.rds', safe_output_path('leak.rds'))");
    const symlinkResult = await request(symlink);
    assert(symlinkResult.status === 500, 'symlink output must be rejected');
    const missingArchive = run([
      'run', '--rm', '-v', `${storageRoot}:/storage:ro`, 'alpine:3.21',
      'test', '!', '-e', `/storage/data/${symlink.outputStorageKey}`,
    ], { capture: true });
    assert(missingArchive.status === 0, 'rejected output must not publish an archive');
    await waitForCleanup();

    const sleeping = "Sys.sleep(60); write_table(data.frame(x=1), 'late.csv')";
    const firstAbort = new AbortController(); const secondAbort = new AbortController();
    const first = request(job(sleeping), { signal: firstAbort.signal }).catch((error) => ({ aborted: error.name === 'AbortError' }));
    const second = request(job(sleeping), { signal: secondAbort.signal }).catch((error) => ({ aborted: error.name === 'AbortError' }));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const busy = await request(job('write_table(data.frame(x=1), "third.csv")'));
    assert(busy.status === 503, 'a third concurrent Expert R request must be rejected by the capacity bound');
    firstAbort.abort(); secondAbort.abort();
    const aborted = await Promise.all([first, second]);
    assert(aborted.every((result) => result.aborted === true), 'disconnects must abort both sandbox clients');
    await waitForCleanup();

    console.log('[expert-r] PASS digest-pinned execution, private mounts, bounds, capacity, cancellation, and cleanup');
    console.log(JSON.stringify({
      rImage, safeJobId: safe.jobId, outputChecksumSha256: safeResult.body.checksumSha256,
      outputBytes: safeResult.body.outputBytes, files: safeResult.body.files,
    }, null, 2));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { if (brokerProcess && brokerProcess.exitCode === null) brokerProcess.kill('SIGTERM'); } catch { /* best effort */ }
    try {
      const containers = run(['ps', '-a', '--filter', 'name=traceomics-expert-job_', '--format', '{{.Names}}'], {
        capture: true, allowFailure: true,
      });
      for (const name of containers.stdout.trim().split(/\r?\n/).filter(Boolean)) {
        if ([...acceptanceJobIds].some((jobId) => name.includes(jobId))) {
          run(['rm', '-f', name], { capture: true, allowFailure: true });
        }
      }
    } catch { /* best effort */ }
    try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(storageRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    if (failed) console.error('[expert-r] isolated resources removed after failure');
  }
}

main().catch((error) => {
  console.error(`[expert-r] FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
