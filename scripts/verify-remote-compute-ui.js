#!/usr/bin/env node
'use strict';

// Scientific acceptance through the actual desktop-selected SSH/HTTPS authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('pg');
const { runDesktopTunnelAcceptance } = require('./verify-desktop-tunnel-ui');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const executeFile = promisify(execFile);
const assert = (value, message) => { if (!value) throw new Error(message); };
async function command(program, args, timeout = 90_000) {
  try {
    return await executeFile(program, args, { cwd: root, windowsHide: true, timeout, maxBuffer: 256 * 1024 });
  } catch { throw new Error('A disposable scientific fixture command failed.'); }
}
async function waitFor(check, message, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(message);
}
async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function savedSeurat(database, service, image) {
  const owner = (await database.query('SELECT id FROM users WHERE email=$1', [service.account.email])).rows[0];
  assert(owner, 'The scientific fixture account is missing.');
  const identity = prefix => prefix + '_' + crypto.randomBytes(12).toString('hex');
  const analysisId = identity('ao'), jobId = identity('job'), checkpointId = identity('art');
  const key = `projects/${service.project.id}/checkpoints/${jobId}/checkpoint.rds`;
  const filename = path.join(service.storageRoot, ...key.split('/'));
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true }); fs.chmodSync(directory, 0o777);
  try {
    await command('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', '10001:10001', '--pids-limit', '128',
      '--memory', '1g', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m',
      '--mount', `type=bind,source=${directory},target=/fixture`, '--entrypoint', 'Rscript', image,
      '--vanilla', '-e', `
        suppressPackageStartupMessages({library(Seurat);library(Matrix)})
        set.seed(1919)
        counts<-matrix(rpois(20L*12L,3),nrow=20L,ncol=12L)
        rownames(counts)<-paste0('Gene',seq_len(nrow(counts)))
        colnames(counts)<-paste0('Cell',seq_len(ncol(counts)))
        obj<-CreateSeuratObject(Matrix(counts,sparse=TRUE))
        obj$condition<-rep(c('control','treated'),each=6L)
        stopifnot(ncol(obj)==12L,nrow(obj)==20L)
        saveRDS(list(global=obj,raw=obj),'/fixture/checkpoint.rds')
      `]);
  } finally { fs.chmodSync(directory, 0o755); }
  const bytes = fs.readFileSync(filename), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await database.query('BEGIN');
  try {
    await database.query(`INSERT INTO analysis_objects(id,owner_user_id,project_id,object_type,display_name,metadata_json)
      VALUES($1,$2,$3,'seurat','Remote saved Seurat analysis',$4)`,
    [analysisId, owner.id, service.project.id, JSON.stringify({ acceptanceFixture: true, cells: 12, genes: 20 })]);
    await database.query(`INSERT INTO jobs(id,owner_user_id,project_id,analysis_object_id,result_analysis_object_id,job_type,status,started_at,completed_at)
      VALUES($1,$2,$3,$4,$4,'checkpoint.noop','completed',NOW(),NOW())`, [jobId, owner.id, service.project.id, analysisId]);
    await database.query(`INSERT INTO job_artifacts(id,project_id,job_id,result_analysis_object_id,created_by_user_id,artifact_type,name,mime_type,storage_kind,storage_uri,checksum_sha256,size_bytes,status)
      VALUES($1,$2,$3,$4,$5,'checkpoint','Remote Seurat checkpoint','application/x-r-rds','local_internal',$6,$7,$8,'available')`,
    [checkpointId, service.project.id, jobId, analysisId, owner.id, key, sha256, bytes.length]);
    await database.query('COMMIT');
  } catch (error) { await database.query('ROLLBACK'); throw error; }
  return { ownerId: owner.id, analysisId, checkpointId, checkpointSha256: sha256,
    checkpointBytes: bytes.length, checkpointBase64: bytes.toString('base64') };
}
function remoteRecipe(profileId) {
  return {
    format: 'traceomics-workflow', schemaVersion: 1, id: 'remote-inspection', name: 'Remote inspection',
    version: '1.0.0', description: 'Subset a saved analysis on the selected service and inspect a bounded summary.',
    runtime: { language: 'r', profileId },
    steps: [{ id: 'subset', label: 'Remote subset', entry: 'subset.R',
      inputs: { analysis: { from: 'input.analysis', type: 'rds' } },
      parameters: [{ key: 'cells', label: 'Cells to keep', type: 'integer', default: 6, min: 1, max: 12 }],
      outputs: { summary: { type: 'metrics', label: 'Subset summary' } } }],
    tabs: [{ id: 'subset', label: 'Remote subset', step: 'subset', plots: [] }],
    files: { 'subset.R': `selected <- subset(inputs$analysis, cells=colnames(inputs$analysis)[seq_len(params$cells)])
stopifnot(inherits(selected,"Seurat"))
Sys.sleep(30)
write_output("summary",list(cells=ncol(selected),features=nrow(selected)))` },
  };
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32' && child.connected) child.send({ type: 'traceomics:shutdown' });
  else child.kill('SIGTERM');
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 15_000); })]);
  clearTimeout(timer);
}
async function main() {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''), 'Set EXPERT_R_SANDBOX_IMAGE to the reviewed immutable R image.');
  const output = path.join(root, 'playwright', 'report', 'remote-compute-' + Date.now());
  fs.mkdirSync(output, { recursive: true });
  const brokerPort = await freePort(), rPort = await freePort();
  const token = crypto.randomBytes(32).toString('hex'), rToken = crypto.randomBytes(32).toString('hex');
  const rName = 'traceomics-remote-r-' + crypto.randomBytes(8).toString('hex');
  let database, broker, worker, service, rStarted = false, capability, fixture, compiledAsset, reconnectedAsset;
  const checks = [], errors = [], responses = [], requests = [];
  const check = message => { checks.push(message); process.stdout.write('PASS: ' + message + '\n'); };
  async function teardownCompute() {
    await stopChild(worker); worker = null;
    if (database) { await database.end(); database = null; }
    if (broker?.listening) await new Promise((resolve, reject) => broker.close(error => error ? reject(error) : resolve()));
    broker = null;
    if (rStarted) { await command('docker', ['rm', '-f', rName]).catch(() => {}); rStarted = false; }
  }
  try {
    await runDesktopTunnelAcceptance({ artifactDirectory: output,
      serviceFactory: async ({ artifactDirectory }) => {
        let serviceEnvironment;
        service = await createDesktopTunnelServiceFixture({ artifactDirectory,
          webEnvironment: { EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles',
            EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${brokerPort}`, EXPERT_R_SANDBOX_TOKEN: token,
            EXECUTION_SERVICE_LABEL: 'Scientific fixture server' },
          configureEnvironment: async ({ env }) => {
            serviceEnvironment = env;
            fs.mkdirSync(env.STORAGE_ROOT, { recursive: true }); fs.mkdirSync(env.VAULT_ROOT, { recursive: true });
            await command('docker', ['run', '-d', '--rm', '--name', rName, '--cap-drop', 'ALL',
              '--security-opt', 'no-new-privileges', '--read-only', '--user', '10001:10001', '--pids-limit', '256',
              '--memory', '2g', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
              '-p', `127.0.0.1:${rPort}:8000`, '-e', 'PLUMBER_HOST=0.0.0.0', '-e', 'API_TOKEN=' + rToken,
              '-e', 'STORAGE_ROOT=/service/storage', '-e', 'VAULT_ROOT=/service/vault',
              '--mount', `type=bind,source=${env.STORAGE_ROOT},target=/service/storage`,
              '--mount', `type=bind,source=${env.VAULT_ROOT},target=/service/vault`,
              '--mount', `type=bind,source=${path.join(root, 'r-backend')},target=/app,readonly`, image]);
            rStarted = true;
            await waitFor(async () => {
              try { const response = await fetch(`http://127.0.0.1:${rPort}/health`, { headers: { 'X-API-Token': rToken } }); return response.ok; }
              catch { return false; }
            }, 'The actual guided R service did not become ready.', 90_000);
            return { R_RUNTIME_MODE: 'external', R_BACKEND_URL: `http://127.0.0.1:${rPort}`, R_API_TOKEN: rToken };
          } });
        database = new Client({ connectionString: service.databaseUrl }); await database.connect();
        fixture = await savedSeurat(database, service, image);
        process.env.STORAGE_ROOT = service.storageRoot;
        broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker({ ...process.env,
          NODE_ENV: 'test', EXPERT_R_SANDBOX_IMAGE: image, EXPERT_R_SANDBOX_TOKEN: token,
          EXPERT_R_SANDBOX_WORK_ROOT: path.join(output, 'broker-work'), PRIVATE_R_KERNEL_ENABLED: 'true',
          PRIVATE_R_KERNEL_IDLE_SECONDS: '300', EXPERT_R_MEMORY_LIMIT: '2g', EXPERT_R_CPU_LIMIT: '1' });
        await broker.startReconciliation(); await new Promise(resolve => broker.listen(brokerPort, '127.0.0.1', resolve));
        capability = await fetch(`http://127.0.0.1:${brokerPort}/capabilities`, { headers: { Authorization: 'Bearer ' + token } }).then(response => response.json());
        assert(capability.persistentKernel && capability.environment, 'The pinned image did not verify private kernel support.');
        worker = spawn(process.execPath, [path.join(root, 'worker.js')], { cwd: root, shell: false, windowsHide: true,
          env: { ...serviceEnvironment, ENABLE_JOB_WORKER: 'true', JOB_WORKER_HEALTH_PORT: '0',
            JOB_WORKER_MIN_FREE_MEMORY_MB: '1', JOB_WORKER_POLL_MS: '250', JOB_WORKER_STARTUP_TIMEOUT_MS: '30000' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        worker.stdout.on('data', chunk => fs.appendFileSync(path.join(output, 'worker.txt'), chunk));
        worker.stderr.on('data', chunk => fs.appendFileSync(path.join(output, 'worker.txt'), chunk));
        const stopService = service.stop;
        service.stop = async () => { await teardownCompute(); await stopService(); };
        return service;
      },
      exerciseWorkspace: async context => exerciseWorkspace(context),
    });
    assert(errors.length === 0, 'The compiled remote workspace raised a browser error.');
    fs.writeFileSync(path.join(output, 'scientific-report.json'), JSON.stringify({ ok: true, checks, browserErrors: errors,
      environment: capability.environment, checkpointSha256: fixture.checkpointSha256, compiledAsset, reconnectedAsset,
      largestApiResponseBytes: Math.max(0, ...responses.map(value => value.bytes)), requests }, null, 2));
    return { ok: true, checks: checks.length, artifactDirectory: output };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'scientific-report.json'), JSON.stringify({ ok: false, checks, error: error.message }, null, 2));
    throw error;
  } finally {
    await teardownCompute();
    await service?.stop();
    if (rStarted) await command('docker', ['rm', '-f', rName]).catch(() => {});
    const work = path.resolve(output, 'broker-work');
    assert(work.startsWith(path.resolve(output) + path.sep), 'Unsafe disposable broker cleanup target.');
    await fs.promises.rm(work, { recursive: true, force: true });
  }

  async function exerciseWorkspace({ workspace, application, openSettings }) {
    compiledAsset = await workspace.evaluate(() => [...document.scripts].map(script => script.src).find(source => /\/assets\/index-/.test(source)));
    await workspace.locator('[aria-label="Execution target"]').getByText('Compute: Tunneled lab', { exact: true }).waitFor();
    const observed = new WeakSet();
    const observe = page => {
    if (observed.has(page)) return; observed.add(page);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname, origin: new URL(request.url()).origin });
    });
    page.on('response', async response => {
      if (!new URL(response.url()).pathname.startsWith('/api/') || response.status() !== 200) return;
      try {
        const body = await response.body();
        responses.push({ path: new URL(response.url()).pathname, bytes: body.length,
          containsCheckpoint: body.includes(Buffer.from(fixture.checkpointBase64)) });
      } catch { /* A deliberate disconnect can cancel a response. */ }
    });
    };
    observe(workspace); application.on('window', observe);
    await workspace.getByRole('button', { name: /^Advanced analysis,/ }).click();
    await workspace.getByRole('button', { name: 'Interactive console', exact: true }).click();
    const consoleUi = workspace.getByRole('region', { name: 'Private R console', exact: true });
    await consoleUi.getByLabel('Initial saved analysis', { exact: true }).selectOption(fixture.analysisId);
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125_000 });
    await consoleUi.getByLabel('R console source').fill('stopifnot(inherits(obj,"Seurat")); remote_cells<-ncol(obj); cat("Remote cells:",remote_cells); display_table(data.frame(cells=remote_cells,features=nrow(obj)),name="Remote dimensions"); plot(seq_len(remote_cells))');
    await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
    await consoleUi.getByRole('region', { name: 'R command output' }).getByText('Command 1 · completed', { exact: true }).waitFor({ timeout: 125_000 });
    assert((await consoleUi.getByLabel('R stdout').innerText()).includes('Remote cells: 12'), 'Remote free R did not inspect the genuine server checkpoint.');
    await consoleUi.getByRole('img', { name: 'R figure 1', exact: true }).waitFor();
    const layout = await workspace.evaluate(() => {
      const panel = document.querySelector('[aria-label="Private R console"]').getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth,
        panelLeft: panel.left, panelRight: panel.right };
    });
    assert(layout.scrollWidth <= layout.width && layout.panelLeft >= 0 && layout.panelRight <= layout.width,
      'The actual native R console has page or panel horizontal overflow.');
    await consoleUi.getByRole('region', { name: 'R command output' }).scrollIntoViewIfNeeded();
    await workspace.screenshot({ path: path.join(output, 'ssh-free-r-checkpoint.png') });
    const kernel = (await database.query('SELECT * FROM private_r_kernels WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 1', [fixture.ownerId])).rows[0];
    assert(kernel.environment_json.id === capability.environment.id && kernel.inputs_json.some(value => value.checksumSha256 === fixture.checkpointSha256), 'The private R session changed its pinned environment or selected checkpoint bytes.');
    assert(/^svc_[a-f0-9]{32}$/.test(kernel.target_json.serviceId) && kernel.target_json.serviceLabel === 'Scientific fixture server', 'The private session lacks a server-owned installation identity.');
    await consoleUi.locator('summary').filter({ hasText: 'Session reproducibility details' }).click();
    await consoleUi.getByLabel('Recorded execution target').getByText('Scientific fixture server · ' + kernel.target_json.serviceId, { exact: true }).waitFor();
    await consoleUi.getByLabel('Recorded execution target').scrollIntoViewIfNeeded();
    await workspace.screenshot({ path: path.join(output, 'ssh-private-session-target.png') });
    check('Native SSH free R inspects a genuine server-resident Seurat checkpoint and returns only a small table, console output and figure.');

    const explore = workspace.locator('[data-destination="explore"]');
    if (!await explore.isVisible()) await workspace.getByRole('button', { name: 'Explore', exact: true }).click();
    await explore.click();
    await workspace.getByRole('heading', { name: 'Exploratory Analysis', exact: true }).waitFor();
    await waitFor(() => workspace.getByRole('button', { name: 'Run recipe', exact: true }).isEnabled(),
      'The connected saved analysis never enabled its guided recipe.', 30_000);
    const [guidedResponse] = await Promise.all([
      workspace.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/jobs')),
      workspace.getByRole('button', { name: 'Run recipe', exact: true }).click(),
    ]);
    assert(guidedResponse.ok(), 'Guided analysis was not admitted through SSH.');
    const guided = await guidedResponse.json();
    const guidedDone = await waitFor(async () => {
      const row = (await database.query('SELECT * FROM jobs WHERE id=$1', [guided.id])).rows[0];
      if (row?.status === 'failed') throw new Error('The genuine guided R job failed.');
      return row?.status === 'completed' ? row : null;
    }, 'Guided R did not complete.');
    await workspace.getByText('Complete', { exact: true }).waitFor();
    const summary = (await database.query("SELECT metadata_json::jsonb AS metadata FROM job_artifacts WHERE job_id=$1 AND artifact_type='exploration_summary'", [guidedDone.id])).rows[0]?.metadata?.summary;
    assert(summary?.nCells === 12 && summary.nFeatures === 20, 'Actual guided R summary does not match the checkpoint.');
    const guidedReceipt = (await database.query('SELECT * FROM job_execution_receipts WHERE job_id=$1', [guidedDone.id])).rows[0];
    assert(guidedReceipt?.target_json.id === kernel.target_json.serviceId && guidedReceipt.target_json.label === 'Scientific fixture server'
      && guidedReceipt.target_json.runtimeKind === 'guided-r', 'The guided job does not retain the same actual installation as free R.');
    await workspace.screenshot({ path: path.join(output, 'ssh-guided-seurat-summary.png') });
    check('A native SSH UI guided recipe queues a durable real worker job; actual Seurat compute produces the exact 12-cell, 20-feature aggregate.');
    await workspace.locator('[data-destination="history"]').click();
    const guidedHistory = workspace.getByRole('region', { name: 'Execution history', exact: true });
    const [guidedDetailResponse] = await Promise.all([
      workspace.waitForResponse(response => response.request().method() === 'GET'
        && new URL(response.url()).pathname === `/api/execution-history/${service.project.id}/${guided.id}`),
      guidedHistory.getByRole('button').filter({ hasText: guided.id }).click(),
    ]);
    const guidedDetail = await guidedDetailResponse.json();
    assert(guidedDetail.environment.precision === 'observed-metadata' && guidedDetail.environment.observed.rVersion
      && guidedDetail.environment.observed.packages.some(value => value.name === 'Seurat' && value.version),
    'Guided history does not retain the actual observed R and Seurat versions.');
    await guidedHistory.getByLabel('Recorded execution target').first()
      .getByText('Scientific fixture server · ' + kernel.target_json.serviceId, { exact: true }).waitFor();
    await guidedHistory.locator('summary').filter({ hasText: 'Environment · observed metadata' }).click();
    await guidedHistory.getByText(guidedDetail.environment.observed.rVersion, { exact: false }).waitFor();
    await guidedHistory.locator('summary').filter({ hasText: 'Environment · observed metadata' }).scrollIntoViewIfNeeded();
    await workspace.screenshot({ path: path.join(output, 'ssh-guided-observed-environment.png') });
    check('Guided execution history retains the actual server identity and observed R/Seurat versions without claiming a fully pinned environment.');

    await workspace.getByRole('button', { name: /^Pipelines,/ }).click();
    const recipe = remoteRecipe(capability.environment.profileId);
    await workspace.getByLabel('Workflow package file').setInputFiles({ name: 'remote-inspection.pipeline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(recipe)) });
    await workspace.getByRole('button', { name: 'Install Remote inspection', exact: true }).click();
    await workspace.getByRole('button', { name: 'Open Remote inspection', exact: true }).click();
    await workspace.getByLabel('Cells to keep', { exact: true }).fill('5');
    await workspace.getByRole('button', { name: 'Run Remote subset', exact: true }).click();
    const workflowJob = await waitFor(async () => {
      const row = (await database.query("SELECT * FROM jobs WHERE owner_user_id=$1 AND job_type='expert.r.v1' ORDER BY created_at DESC LIMIT 1", [fixture.ownerId])).rows[0];
      if (row?.status === 'failed') throw new Error('The real custom R step failed.');
      return row?.status === 'running' ? row : null;
    }, 'The custom R step never reached the durable worker.');
    const settings = await openSettings(workspace);
    await settings.getByRole('button', { name: 'Disconnect SSH tunnel', exact: true }).click();
    await workspace.locator('[aria-label="Execution target"]').getByText('SSH tunnel disconnected', { exact: true }).waitFor();
    const stillRunning = (await database.query('SELECT status,attempts FROM jobs WHERE id=$1', [workflowJob.id])).rows[0];
    assert(stillRunning?.status === 'running' && stillRunning.attempts === workflowJob.attempts,
      'The scientific fixture finished before disconnect, so offline continuation was not exercised.');
    const requestsBeforeBlockedSubmit = requests.length;
    const denied = await workspace.evaluate(async ({ projectId, analysisId }) => {
      try { await window.electronAPI.createProjectJob(projectId, { jobType: 'explore.summarize.v1', analysisObjectId: analysisId, parameters: { recipe: 'overview' } }); return null; }
      catch (error) { return error.code; }
    }, { projectId: service.project.id, analysisId: fixture.analysisId });
    assert(denied === 'TARGET_DISCONNECTED' && requests.length === requestsBeforeBlockedSubmit, 'Disconnected compute submission was not blocked before browser transport.');
    await workspace.getByRole('button', { name: /^Advanced analysis,/ }).click();
    await workspace.getByRole('button', { name: 'Interactive console', exact: true }).click();
    const disconnectedConsole = workspace.getByRole('region', { name: 'Private R console', exact: true });
    await disconnectedConsole.getByRole('button', { name: 'Run R cell', exact: true }).waitFor();
    assert(await disconnectedConsole.getByRole('button', { name: 'Run R cell', exact: true }).isDisabled(), 'The disconnected native console permits another R command.');
    check('Disconnected native UI disables R work and its API rejects another guided submission before sending any request.');
    const completedOffline = await waitFor(async () => {
      const row = (await database.query('SELECT * FROM jobs WHERE id=$1', [workflowJob.id])).rows[0];
      if (row?.status === 'failed') throw new Error('Disconnected server computation failed.');
      return row?.status === 'completed' ? row : null;
    }, 'The server did not finish the accepted job after the desktop disconnected.');
    assert(completedOffline.attempts === workflowJob.attempts, 'Disconnect caused another scientific attempt.');
    check('An accepted custom R step continues on the server after explicit SSH disconnect and records completion with the same job and attempt.');
    const opening = application.waitForEvent('window');
    await settings.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click();
    const reconnected = await opening;
    await reconnected.locator('[aria-label="Execution target"]').getByText('SSH tunnel connected', { exact: true }).waitFor({ timeout: 30000 });
    reconnectedAsset = await reconnected.evaluate(() => [...document.scripts].map(script => script.src).find(source => /\/assets\/index-/.test(source)));
    assert(reconnectedAsset === compiledAsset, 'Explicit reconnect changed the compiled acceptance UI.');
    await reconnected.getByRole('button', { name: /^Pipelines,/ }).click();
    await reconnected.getByRole('button', { name: 'Open Remote inspection', exact: true }).click();
    await reconnected.getByRole('heading', { name: 'Subset summary', exact: true }).waitFor({ timeout: 30000 });
    await reconnected.getByRole('heading', { name: 'Subset summary', exact: true })
      .locator('xpath=ancestor::section[1]').getByText('5', { exact: true }).waitFor();
    assert((await database.query("SELECT COUNT(*)::int AS count FROM jobs WHERE owner_user_id=$1 AND job_type='expert.r.v1'", [fixture.ownerId])).rows[0].count === 1, 'Explicit reconnect replayed custom scientific source.');
    const state = (await database.query('SELECT state_json FROM workflow_instances WHERE owner_user_id=$1', [fixture.ownerId])).rows[0].state_json;
    assert(state.results.subset.parameters.cells === 5 && !state.active, 'The reopened recipe lost its edited settings or completion.');
    const customReceipt = (await database.query('SELECT * FROM job_execution_receipts WHERE job_id=$1', [workflowJob.id])).rows[0];
    assert(customReceipt?.target_json.id === kernel.target_json.serviceId && customReceipt.target_json.runtimeKind === 'sandbox-r'
      && customReceipt.environment_json.reference.id === capability.environment.id, 'The custom recipe lost its server installation or pinned R environment receipt.');
    await reconnected.screenshot({ path: path.join(output, 'ssh-reconnected-custom-step.png') });
    check('Explicit reconnect to the same server restores the exact completed recipe step and edited parameters without scientific replay.');
    await reconnected.getByRole('button', { name: 'Back to Pipelines', exact: true }).click();
    const runs = reconnected.locator('[data-destination="history"]');
    if (!await runs.isVisible()) await reconnected.getByRole('button', { name: 'Results', exact: true }).click();
    await runs.click();
    const history = reconnected.getByRole('region', { name: 'Execution history', exact: true });
    await history.getByRole('button').filter({ hasText: workflowJob.id }).click();
    const evidence = history.getByLabel('Recorded execution target').first();
    await evidence.getByText('Scientific fixture server · ' + kernel.target_json.serviceId, { exact: true }).waitFor();
    assert(!(await evidence.innerText()).includes('Tunneled lab'), 'Execution history substituted the current client profile label for recorded server identity.');
    await history.locator('summary').filter({ hasText: 'Executed source' }).click();
    await history.getByText(recipe.files['subset.R'], { exact: false }).waitFor();
    await history.locator('summary').filter({ hasText: 'Environment ·' }).click();
    await history.getByRole('button', { name: 'Verify environment manifest', exact: true }).click();
    await history.getByText('Environment manifest checksum verified', { exact: true }).waitFor();
    await evidence.scrollIntoViewIfNeeded();
    await reconnected.screenshot({ path: path.join(output, 'ssh-recorded-custom-step-evidence.png') });
    check('Actual execution history displays the retained server identity, exact custom source and verified pinned environment independently of the client connection label.');
    assert(!requests.some(value => /checkpoint.*download|\/download$/.test(value.path)), 'The remote compute flow fetched a full checkpoint or output bundle to the renderer.');
    assert(requests.every(value => value.origin === service.endpoint), 'A scientific request left the desktop-selected HTTPS authority.');
    assert(responses.every(value => value.bytes < 512 * 1024 && !value.containsCheckpoint), 'A scientific API response transferred a full analysis object.');
    check('Scientific browser traffic stays bounded and contains no checkpoint or output-bundle download.');
    // The native transport suite continues its strict certificate, identity and loss checks.
    return reconnected;
  }
}
if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
module.exports = { main };
