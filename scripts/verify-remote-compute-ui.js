#!/usr/bin/env node
'use strict';

// Scientific acceptance through the actual desktop-selected SSH/HTTPS authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
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
Sys.sleep(60)
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
async function appendFixtureWorkerLogs(databaseUrl, job, entries) {
  // Exercise the production worker's claim and lease fence. Keep disposable
  // credentials in the private input pipe, outside command arguments/reports.
  const source = `const db=require('./backend/pgDatabase');let raw='';
    process.stdin.on('data',chunk=>raw+=chunk);
    process.stdin.on('end',async()=>{try{const input=JSON.parse(raw);
      for(const entry of input.entries) await db.appendJobLogByWorker(input.id,input.workerId,input.claimToken,entry);
      process.stdout.write(JSON.stringify({count:input.entries.length}));
    }catch{process.exitCode=1;}finally{await db.close();}});`;
  const child = spawn(process.execPath, ['-e', source], { cwd: root, shell: false, windowsHide: true,
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-1024); });
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ id: job.id, workerId: job.worker_id, claimToken: job.claim_token, entries }));
  const timer = setTimeout(() => child.kill(), 15_000);
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve); child.once('error', () => reject(new Error('Could not start the disposable worker log fixture.')));
  }).finally(() => clearTimeout(timer));
  assert(code === 0 && JSON.parse(output).count === entries.length, 'The disposable fixture could not append logs through the active worker claim.');
}
async function isolatedServiceRequest(service, pathname, { method = 'GET', cookie, body } = {}) {
  const endpoint = new URL(service.endpoint), payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', port: endpoint.port, servername: endpoint.hostname,
      ca: fs.readFileSync(service.caCertificatePath), rejectUnauthorized: true, path: pathname, method,
      headers: { Host: endpoint.host, Origin: endpoint.origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, response => {
      let bytes = 0; const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8192) request.destroy(new Error('The isolated access check exceeded its response bound.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()),
          cookie: (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; '), bytes }); }
        catch { reject(new Error('The isolated service access check returned an invalid response.')); }
      });
      response.on('error', () => reject(new Error('The isolated service access check failed.')));
    });
    request.setTimeout(10_000, () => request.destroy());
    request.on('error', () => reject(new Error('The isolated service access check failed.')));
    request.end(payload);
  });
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
  const checks = [], errors = [], responses = [], requests = [], pausedReads = new Set();
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
      exerciseWorkspace: async context => {
        try { return await exerciseWorkspace(context); }
        catch (error) {
          for (const release of pausedReads) release(); pausedReads.clear();
          await context.workspace.screenshot({ path: path.join(output, 'scientific-acceptance-failure.png') }).catch(() => {});
          throw error;
        }
      },
    });
    assert(errors.length === 0, 'The compiled remote workspace raised a browser error.');
    fs.writeFileSync(path.join(output, 'scientific-report.json'), JSON.stringify({ ok: true, checks, browserErrors: errors,
      environment: capability.environment, checkpointSha256: fixture.checkpointSha256, compiledAsset, reconnectedAsset,
      peerWindowMode: 'Disposable second renderer sharing the actual native session; readonly copy of its verified target descriptor. Production desktop remains single-window.',
      largestApiResponseBytes: Math.max(0, ...responses.map(value => value.bytes)), requests }, null, 2));
    return { ok: true, checks: checks.length, artifactDirectory: output };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'scientific-report.json'), JSON.stringify({ ok: false, checks, error: error.message }, null, 2));
    throw error;
  } finally {
    for (const release of pausedReads) release(); pausedReads.clear();
    await teardownCompute();
    await service?.stop();
    if (rStarted) await command('docker', ['rm', '-f', rName]).catch(() => {});
    const work = path.resolve(output, 'broker-work');
    assert(work.startsWith(path.resolve(output) + path.sep), 'Unsafe disposable broker cleanup target.');
    await fs.promises.rm(work, { recursive: true, force: true });
  }

  async function exerciseWorkspace({ workspace, application, openSettings, restartWorkspace, createPeerWorkspace }) {
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
    const monitorBase = '/api/run-monitoring/' + service.project.id;
    const readMonitor = (page, suffix = '') => page.evaluate(async url => {
      const response = await fetch(url, { credentials: 'include' });
      return { status: response.status, value: await response.json() };
    }, monitorBase + suffix);
    const submittedJobs = () => requests.filter(value => value.method === 'POST'
      && (/\/jobs$/.test(value.path) || /^\/api\/workflows\/.*\/run$/.test(value.path)
        || /^\/api\/private-r-kernels\/.*\/executions$/.test(value.path))).length;
    async function openHistory(page) {
      const expandSidebar = page.getByRole('button', { name: 'Expand sidebar', exact: true });
      if (await expandSidebar.isVisible()) await expandSidebar.click();
      const historyLink = page.locator('[data-destination="history"]');
      if (!await historyLink.isVisible()) await page.getByRole('button', { name: 'Project', exact: true }).click();
      await historyLink.click();
    }
    async function openMonitor(page, recordId) {
      await openHistory(page);
      const panel = page.getByRole('region', { name: 'Run monitoring', exact: true });
      await panel.getByRole('list', { name: 'Monitored runs', exact: true }).waitFor();
      // Workspace tabs retain their mounted views. Refresh the existing list
      // before selecting work accepted while the researcher used another tab.
      await panel.getByRole('button', { name: 'Refresh monitoring', exact: true }).click();
      await panel.getByRole('list', { name: 'Monitored runs', exact: true })
        .getByRole('button').filter({ hasText: recordId }).click();
      const detail = panel.getByRole('region', { name: 'Selected run monitoring', exact: true });
      await detail.waitFor();
      return { panel, detail };
    }
    function assertPrivateMonitor(value, job) {
      const serialized = JSON.stringify(value);
      assert(!['claim_token', 'claimToken', 'worker_id', 'workerId', 'storage_uri', 'storageKey', 'source_code', 'sourceCode']
        .some(field => serialized.includes('"' + field + '"')), 'Run monitoring exposed private source, storage or worker capabilities.');
      assert(![job?.claim_token, job?.worker_id, service.storageRoot].filter(Boolean).some(secret => serialized.includes(secret)),
        'Run monitoring exposed a private claim, worker identity or absolute server path.');
    }
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

    const firstCommand = (await database.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 ORDER BY execution_order DESC LIMIT 1', [kernel.id])).rows[0];
    const firstCommandReport = await readMonitor(workspace, '/' + firstCommand.id);
    assert(firstCommandReport.status === 200 && firstCommandReport.value.kind === 'r-console'
      && firstCommandReport.value.kernel.id === kernel.id && firstCommandReport.value.kernel.generation === kernel.runtime_generation
      && firstCommandReport.value.status === 'completed' && firstCommandReport.value.resources.state === 'unavailable'
      && firstCommandReport.value.logs.items.some(value => value.message.includes('Remote cells: 12')),
    'Completed private R monitoring lost its exact kernel generation, retained output or distinction between limits and measured usage.');
    assertPrivateMonitor(firstCommandReport.value);
    await consoleUi.getByLabel('R console source').fill('Sys.sleep(30); cat("Monitored private command completed.")');
    await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
    const secondCommand = await waitFor(async () => {
      const row = (await database.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 AND execution_order=2', [kernel.id])).rows[0];
      if (row?.status === 'failed') throw new Error('The actual monitored private R command failed.');
      return row?.status === 'running' ? row : null;
    }, 'The actual private R command did not become durable running work.');
    const commandPosts = () => requests.filter(value => value.method === 'POST' && /\/executions$/.test(value.path)).length;
    const commandsBeforeMonitoring = commandPosts();
    const privateMonitor = await openMonitor(workspace, secondCommand.id);
    await privateMonitor.detail.getByRole('heading', { name: 'Server state: Running', exact: true }).waitFor();
    const privateSample = await waitFor(async () => {
      const report = await readMonitor(workspace, '/' + secondCommand.id);
      assert(report.status === 200, 'The owner lost access to its running private command monitor.');
      return report.value.status === 'running' && report.value.resources.state === 'observed' ? report.value : null;
    }, 'The actual private R command did not yield its own generation-scoped container observation.', 15_000);
    assert(privateSample.kernel.id === kernel.id && privateSample.kernel.generation === kernel.runtime_generation
      && privateSample.resources.kernelGeneration === kernel.runtime_generation && privateSample.resources.dispatchId === null
      && privateSample.target.serviceId === kernel.target_json.serviceId && privateSample.resources.scope === 'r-container'
      && privateSample.resources.memoryBytes > 0 && Number.isFinite(privateSample.resources.cpuPercent)
      && privateSample.resources.observedAt && privateSample.progress.percent === null && privateSample.timing.remainingMs === null,
    'Private command monitoring mixed kernel generations, batch dispatches or inferred scientific progress.');
    await privateMonitor.panel.getByRole('button', { name: 'Refresh monitoring', exact: true }).click();
    await privateMonitor.detail.getByLabel('CPU usage', { exact: true }).waitFor();
    await privateMonitor.detail.getByLabel('Memory usage', { exact: true }).waitFor();
    assertPrivateMonitor(privateSample);
    await privateMonitor.detail.scrollIntoViewIfNeeded();
    await workspace.screenshot({ path: path.join(output, 'ssh-running-private-r-monitor.png') });
    await waitFor(async () => (await database.query('SELECT status FROM private_r_executions WHERE id=$1', [secondCommand.id])).rows[0]?.status === 'completed',
      'The monitored private R command did not finish.');
    const privateCompleted = await readMonitor(workspace, '/' + secondCommand.id);
    assert(privateCompleted.status === 200 && privateCompleted.value.resources.state === 'unavailable'
      && privateCompleted.value.logs.items.some(value => value.message.includes('Monitored private command completed.'))
      && commandPosts() === commandsBeforeMonitoring
      && (await database.query('SELECT COUNT(*)::int AS count FROM private_r_executions WHERE kernel_id=$1', [kernel.id])).rows[0].count === 2,
    'Private R monitoring replayed a command or retained another command\'s live resource evidence.');
    check('Actual native private R monitoring binds measured container usage to the running command\'s exact kernel generation, keeps progress unknown and retrieves its final retained output without replay.');

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
    await workspace.getByText('Private analysis workspace · aggregate-only result', { exact: true })
      .locator('..').getByText('Complete', { exact: true }).waitFor();
    const summary = (await database.query("SELECT metadata_json::jsonb AS metadata FROM job_artifacts WHERE job_id=$1 AND artifact_type='exploration_summary'", [guidedDone.id])).rows[0]?.metadata?.summary;
    assert(summary?.nCells === 12 && summary.nFeatures === 20, 'Actual guided R summary does not match the checkpoint.');
    const guidedReceipt = (await database.query('SELECT * FROM job_execution_receipts WHERE job_id=$1', [guidedDone.id])).rows[0];
    assert(guidedReceipt?.target_json.id === kernel.target_json.serviceId && guidedReceipt.target_json.label === 'Scientific fixture server'
      && guidedReceipt.target_json.runtimeKind === 'guided-r', 'The guided job does not retain the same actual installation as free R.');
    await workspace.screenshot({ path: path.join(output, 'ssh-guided-seurat-summary.png') });
    check('A native SSH UI guided recipe queues a durable real worker job; actual Seurat compute produces the exact 12-cell, 20-feature aggregate.');
    const owner = (await database.query('SELECT * FROM users WHERE id=$1', [fixture.ownerId])).rows[0];
    const colleagueEmail = 'monitor-colleague-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
    const colleague = (await database.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id',
      [colleagueEmail, owner.password_hash, owner.salt, 'Separate project analyst'])).rows[0];
    const organization = (await database.query('SELECT organization_id FROM projects WHERE id=$1', [service.project.id])).rows[0];
    await database.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [organization.organization_id, colleague.id]);
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'analyst')", [service.project.id, colleague.id]);
    const colleagueJob = 'job_' + crypto.randomBytes(12).toString('hex');
    await database.query(`INSERT INTO jobs(id,owner_user_id,project_id,job_type,status,started_at,completed_at,logs_json)
      VALUES($1,$2,$3,'explore.summarize.v1','completed',NOW(),NOW(),$4)`,
    [colleagueJob, colleague.id, service.project.id, JSON.stringify([{ ts: new Date().toISOString(), level: 'info', message: 'Private colleague activity.' }])]);
    const monitorList = await readMonitor(workspace), guidedMonitor = await readMonitor(workspace, '/' + guidedDone.id);
    assert(monitorList.status === 200 && monitorList.value.schema === 'traceomics.run-monitoring.v1'
      && monitorList.value.items.length <= 25 && !monitorList.value.items.some(value => value.id === colleagueJob),
    'Run monitoring returned another project member\'s private activity or an unbounded list.');
    const deniedColleague = await readMonitor(workspace, '/' + colleagueJob);
    assert(deniedColleague.status === 404 && Object.keys(deniedColleague.value).every(key => ['error', 'code'].includes(key)),
      'Owner-scoped monitoring admitted another analyst\'s guided job.');
    const colleagueLogin = await isolatedServiceRequest(service, '/api/auth/login',
      { method: 'POST', body: { email: colleagueEmail, password: service.account.password } });
    assert(colleagueLogin.status === 200 && colleagueLogin.cookie, 'The disposable project colleague could not establish an independent authenticated session.');
    const colleagueCookie = colleagueLogin.cookie;
    for (const recordId of [guidedDone.id, firstCommand.id, secondCommand.id]) {
      const denied = await isolatedServiceRequest(service, monitorBase + '/' + recordId, { cookie: colleagueCookie });
      assert(denied.status === 404 && Object.keys(denied.value).every(key => ['error', 'code'].includes(key)) && denied.bytes < 1024,
        'A different authenticated project member received another owner\'s monitored state, logs or resource evidence.');
      assertPrivateMonitor(denied.value);
    }
    assert(guidedMonitor.status === 200 && guidedMonitor.value.logs.items.length <= 50
      && Buffer.byteLength(JSON.stringify(guidedMonitor.value)) <= 128 * 1024,
    'Guided monitoring returned an unbounded log or detail payload.');
    assert(guidedMonitor.value.resources.state === 'unavailable' && guidedMonitor.value.resources.memoryBytes === null
      && guidedMonitor.value.resources.cpuPercent === null,
    'Completed guided monitoring represented configured limits as measured resource usage.');
    assertPrivateMonitor(guidedMonitor.value, guidedDone);
    check('Owner-scoped monitoring bounds its list and detail, and independent authenticated project colleagues cannot read each other\'s job or private R command observations.');
    await workspace.locator('[data-destination="history"]').click();
    const guidedHistory = workspace.getByRole('region', { name: 'Execution history', exact: true });
    await guidedHistory.getByRole('button', { name: 'Refresh executions', exact: true }).click();
    await guidedHistory.getByRole('button').filter({ hasText: guided.id }).click();
    const guidedDetailResponse = await workspace.evaluate(async url => {
      const response = await fetch(url, { credentials: 'include' });
      return { status: response.status, value: await response.json() };
    }, `/api/execution-history/${service.project.id}/${guided.id}`);
    assert(guidedDetailResponse.status === 200, 'The retained guided environment receipt became inaccessible.');
    const guidedDetail = guidedDetailResponse.value;
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
    const jobsBeforeMonitor = submittedJobs();
    const runningMonitor = await openMonitor(workspace, workflowJob.id);
    await runningMonitor.detail.getByRole('heading', { name: 'Server state: Running', exact: true }).waitFor();
    await runningMonitor.detail.getByText('Progress is not reported.', { exact: true }).waitFor();
    await runningMonitor.detail.getByText('Remaining time is unknown.', { exact: true }).waitFor();
    const sampled = await waitFor(async () => {
      const report = await readMonitor(workspace, '/' + workflowJob.id);
      assert(report.status === 200, 'The admitted job monitor became inaccessible.');
      return report.value.status === 'running' && report.value.resources.state === 'observed' ? report.value : null;
    }, 'The actual running recipe did not yield its own bounded R-container resource observation.', 20_000);
    const activeReceipt = (await database.query('SELECT * FROM job_execution_receipts WHERE job_id=$1 ORDER BY dispatch_order DESC LIMIT 1',
      [workflowJob.id])).rows[0];
    assert(sampled.target?.id === kernel.target_json.serviceId && sampled.target.runtimeKind === 'sandbox-r'
      && sampled.execution.dispatchId === activeReceipt.dispatch_id && sampled.resources.dispatchId === activeReceipt.dispatch_id,
    'The live recipe observation is not bound to this actual server and dispatch receipt.');
    assert(sampled.resources.scope === 'r-container' && Number.isSafeInteger(sampled.resources.memoryBytes)
      && sampled.resources.memoryBytes > 0 && sampled.resources.memoryBytes <= sampled.resources.memoryLimitBytes
      && sampled.resources.memoryLimitBytes === 2 * 1024 ** 3
      && Number.isFinite(sampled.resources.cpuPercent) && sampled.resources.cpuPercent >= 0
      && sampled.resources.cpuPercent <= sampled.resources.cpuLimit * 100 + 10
      && Number.isFinite(Date.parse(sampled.resources.observedAt))
      && Date.now() - Date.parse(sampled.resources.observedAt) < 15_000,
    'The live recipe resource observation is invalid, stale or substitutes an unrelated host policy.');
    assert(sampled.progress.state === 'unknown' && sampled.progress.percent === null && sampled.progress.remainingMs === null
      && sampled.timing.remainingMs === null && sampled.timing.runElapsedMs > 0
      && sampled.worker.state === 'lease-current' && sampled.worker.heartbeatAt,
    'Running monitoring fabricates progress/ETA or hides its actual worker lease observation.');
    assertPrivateMonitor(sampled, workflowJob);
    const benign = 'Retained scientific status is available.';
    const marker = 'monitor-fixture-' + crypto.randomBytes(12).toString('hex');
    const fixtureLogs = Array.from({ length: 56 }, (_, index) => ({ level: 'info', message: 'Bounded worker observation ' + (index + 1) + '.' }));
    fixtureLogs.push({ level: 'info', message: benign }, { level: 'info',
      message: 'password=' + marker + ' Bearer ' + marker
        + ' ssh://researcher:' + marker + '@private.host.invalid/study /private/lab/' + marker
        + ' claim_token=' + marker });
    await appendFixtureWorkerLogs(service.databaseUrl, workflowJob, fixtureLogs);
    const scrubbedMonitor = await readMonitor(workspace, '/' + workflowJob.id);
    assert(scrubbedMonitor.status === 200 && scrubbedMonitor.value.logs.items.length <= 50
      && scrubbedMonitor.value.logs.omittedCount > 0 && scrubbedMonitor.value.logs.truncated && scrubbedMonitor.value.logs.redacted
      && scrubbedMonitor.value.logs.items.some(value => value.message.includes(benign))
      && !JSON.stringify(scrubbedMonitor.value).includes(marker)
      && Buffer.byteLength(JSON.stringify(scrubbedMonitor.value.logs)) <= 64 * 1024
      && Buffer.byteLength(JSON.stringify(scrubbedMonitor.value)) <= 128 * 1024,
    'Monitoring failed to bound real worker logs or preserve useful status while scrubbing credentials, claims and private paths.');
    assertPrivateMonitor(scrubbedMonitor.value, workflowJob);
    const foreignMonitor = await isolatedServiceRequest(service, monitorBase + '/' + workflowJob.id, { cookie: colleagueCookie });
    assert(foreignMonitor.status === 404 && foreignMonitor.bytes < 1024
      && Object.keys(foreignMonitor.value).every(key => ['error', 'code'].includes(key))
      && !JSON.stringify(foreignMonitor.value).includes(marker),
    'Another authenticated owner received the actual live job\'s private logs or resource evidence.');
    assertPrivateMonitor(foreignMonitor.value, workflowJob);
    await runningMonitor.panel.getByRole('button', { name: 'Refresh monitoring', exact: true }).click();
    await runningMonitor.detail.getByLabel('CPU usage', { exact: true }).waitFor();
    await runningMonitor.detail.getByLabel('Memory usage', { exact: true }).waitFor();
    await runningMonitor.detail.locator('summary').filter({ hasText: 'Run notes' }).click();
    await runningMonitor.detail.getByText(benign, { exact: false }).waitFor();
    assert(!(await runningMonitor.detail.innerText()).includes(marker), 'The actual native monitor displayed a scrubbed secret fixture value.');
    await runningMonitor.detail.getByLabel('Recorded execution target').getByText('Scientific fixture server · ' + kernel.target_json.serviceId,
      { exact: true }).waitFor();
    const liveLayout = await workspace.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(liveLayout.scrollWidth <= liveLayout.width, 'The actual native run-monitor panel overflows the page horizontally.');
    assert(submittedJobs() === jobsBeforeMonitor, 'Monitoring polls or refresh submitted another scientific job.');
    await runningMonitor.detail.scrollIntoViewIfNeeded();
    await workspace.screenshot({ path: path.join(output, 'ssh-running-recipe-monitor.png') });
    check('Actual native monitoring follows the running Seurat recipe with its durable server/dispatch, elapsed time, unknown progress/ETA and measured container CPU/memory; polling and refresh submit no job.');
    check('Actual native monitoring bounds logs from the production worker claim, preserves useful text, scrubs credential-shaped fixtures and denies a different authenticated project owner access to live evidence.');
    const settings = await openSettings(workspace);
    await settings.getByRole('button', { name: 'Disconnect SSH tunnel', exact: true }).click();
    await workspace.locator('[aria-label="Execution target"]').getByText('SSH tunnel disconnected', { exact: true }).waitFor();
    const stillRunning = (await database.query('SELECT status,attempts FROM jobs WHERE id=$1', [workflowJob.id])).rows[0];
    assert(stillRunning?.status === 'running' && stillRunning.attempts === workflowJob.attempts,
      'The scientific fixture finished before disconnect, so offline continuation was not exercised.');
    await runningMonitor.detail.getByRole('heading', { name: 'Last confirmed server state: Running', exact: true }).waitFor();
    assert(await runningMonitor.panel.getByRole('button', { name: 'Refresh monitoring', exact: true }).isDisabled(),
      'The disconnected monitor permits another network refresh.');
    const offlineElapsed = await runningMonitor.detail.getByLabel('Run elapsed time', { exact: true }).innerText();
    const offlineObservation = await runningMonitor.detail.getByLabel('Last run observation', { exact: true }).innerText();
    await workspace.waitForTimeout(1_200);
    assert(await runningMonitor.detail.getByLabel('Run elapsed time', { exact: true }).innerText() === offlineElapsed
      && await runningMonitor.detail.getByLabel('Last run observation', { exact: true }).innerText() === offlineObservation,
    'Disconnected monitoring invents new elapsed or observation evidence after the last confirmed server response.');
    assert(submittedJobs() === jobsBeforeMonitor, 'Disconnecting run monitoring replayed a scientific job.');
    await runningMonitor.detail.scrollIntoViewIfNeeded();
    await workspace.screenshot({ path: path.join(output, 'ssh-disconnected-monitor-last-known.png') });
    check('SSH disconnect keeps the same last-confirmed running state and freezes its elapsed/resource evidence separately from connection loss, without replay.');
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
    await history.getByRole('button', { name: 'Refresh executions', exact: true }).click();
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
    const completedMonitor = await openMonitor(reconnected, workflowJob.id);
    await completedMonitor.detail.getByRole('heading', { name: 'Server state: Complete', exact: true }).waitFor();
    const completedReport = await readMonitor(reconnected, '/' + workflowJob.id);
    assert(completedReport.status === 200 && completedReport.value.status === 'completed'
      && completedReport.value.execution.dispatchId === activeReceipt.dispatch_id
      && completedReport.value.progress.state === 'complete' && completedReport.value.resources.state === 'unavailable'
      && completedReport.value.resources.cpuPercent === null && completedReport.value.resources.memoryBytes === null,
    'Reconnected monitoring lost the durable attempt or displayed finished-container usage as live evidence.');
    assert(submittedJobs() === jobsBeforeMonitor
      && (await database.query('SELECT attempts FROM jobs WHERE id=$1', [workflowJob.id])).rows[0].attempts === workflowJob.attempts,
    'Monitoring after reconnect submitted or executed a second scientific attempt.');
    assertPrivateMonitor(completedReport.value, completedOffline);
    await completedMonitor.detail.scrollIntoViewIfNeeded();
    await reconnected.screenshot({ path: path.join(output, 'ssh-reconnected-completed-monitor.png') });
    check('Explicit reconnect retrieves the same completed job and dispatch through GET-only monitoring, clears live usage for the finished container and creates no additional attempt.');

    let recoveryWorkspace = reconnected;
    const recoveryKey = 'traceomics_submission_recovery_v1';
    async function requestReceipt(page, pathname, method = 'GET', body) {
      return page.evaluate(async input => {
        const response = await fetch(input.pathname, { method: input.method, credentials: 'include',
          ...(input.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input.body) }) });
        const text = await response.text();
        return { status: response.status, bytes: new TextEncoder().encode(text).length, value: JSON.parse(text) };
      }, { pathname, method, body });
    }
    function assertSafeSubmission(value, expected) {
      const { job, ...receipt } = value;
      const serialized = JSON.stringify(receipt);
      assert(value.requestId === expected.requestId && value.jobId === expected.jobId && value.projectId === service.project.id
        && /^[a-f0-9]{64}$/.test(value.requestHash), 'A durable submission receipt changed the original request or job identity.');
      assert(!['source_code', 'sourceCode', 'source', 'claim_token', 'claimToken', 'worker_id', 'workerId', 'storage_uri', 'storageKey', 'parameters']
        .some(field => serialized.includes('"' + field + '":'))
        && ![recipe.files['subset.R'], service.account.password, service.storageRoot, fixture.checkpointBase64]
          .some(secret => serialized.includes(secret)), 'A small submission receipt exposed scientific inputs or a private capability.');
      assert(Buffer.byteLength(serialized) < 8192, 'A submission receipt exceeded the bounded identifier payload.');
      if (job) assertPrivateMonitor(job);
    }
    async function readRecoveryStorage(page) {
      const stored = await page.evaluate(key => localStorage.getItem(key), recoveryKey);
      assert(stored && Buffer.byteLength(stored) <= 32 * 1024, 'Submission recovery did not retain a bounded local identifier record.');
      const value = JSON.parse(stored);
      assert(value.scope.installationId === kernel.target_json.serviceId && value.scope.userId === Number(fixture.ownerId)
        && typeof value.scope.targetHash === 'string' && value.scope.targetHash.length <= 128
        && Array.isArray(value.records) && value.records.length <= 24,
      'Submission recovery did not isolate its retained identifiers by installation, target and authenticated owner.');
      const allowed = ['kind', 'requestId', 'projectId', 'instanceId', 'jobId', 'requestHash', 'state', 'createdAt'];
      assert(value.records.every(record => Object.keys(record).every(key => allowed.includes(key)))
        && ![recipe.files['subset.R'], service.account.password, service.storageRoot, fixture.checkpointBase64]
          .some(secret => stored.includes(secret)), 'Submission recovery persisted source, objects, private paths or credentials.');
      return value;
    }
    async function reopenDesktop(page) {
      const scientificPostsBefore = submittedJobs();
      const previousProcess = application.process().pid;
      const next = await restartWorkspace();
      application = next.application; recoveryWorkspace = next.workspace;
      observe(recoveryWorkspace); application.on('window', observe);
      assert(application.process().pid !== previousProcess && page.isClosed(), 'Acceptance did not close and reopen the whole desktop process.');
      assert(await recoveryWorkspace.evaluate(() => [...document.scripts].map(script => script.src).find(source => /\/assets\/index-/.test(source))) === compiledAsset,
        'Complete desktop reopening changed the compiled acceptance UI.');
      await openHistory(recoveryWorkspace);
      await recoveryWorkspace.getByRole('region', { name: 'Saved submissions', exact: true }).waitFor();
      assert(submittedJobs() === scientificPostsBefore, 'Reopening the complete desktop app replayed a scientific submission.');
      return scientificPostsBefore;
    }
    async function openRecoveredRun(page, requestId, jobId) {
      const card = page.getByRole('region', { name: 'Submission ' + requestId, exact: true });
      await card.getByRole('button', { name: 'Open exact run', exact: true }).waitFor({ timeout: 30_000 });
      await card.getByRole('button', { name: 'Open exact run', exact: true }).click();
      const detail = page.getByRole('region', { name: 'Selected run monitoring', exact: true });
      await detail.getByText(new RegExp(jobId)).waitFor({ timeout: 30_000 });
      const selected = page.getByRole('list', { name: 'Monitored runs', exact: true }).getByRole('button').filter({ hasText: jobId });
      assert(await selected.getAttribute('aria-pressed') === 'true', 'Recovery displayed a latest matching job instead of the exact saved job.');
      return detail;
    }

    const originalWorkflow = (await database.query('SELECT instance_id,request_id FROM workflow_runs WHERE job_id=$1', [workflowJob.id])).rows[0];
    const firstWorkflowReceiptPath = `/api/workflows/${service.project.id}/instances/${originalWorkflow.instance_id}/submissions/${originalWorkflow.request_id}`;
    const peer = await createPeerWorkspace(recoveryWorkspace); observe(peer);
    assert(await peer.evaluate(() => [...document.scripts].map(script => script.src).find(source => /\/assets\/index-/.test(source))) === compiledAsset,
      'The disposable peer did not load the same production analysis UI.');
    await openHistory(peer);
    const peerOriginal = peer.getByRole('region', { name: 'Submission ' + originalWorkflow.request_id, exact: true });
    await peerOriginal.getByRole('button', { name: 'Open exact run', exact: true }).waitFor({ timeout: 30_000 });
    assert(await peer.getByRole('region', { name: 'Submission recovery', exact: true }).count() === 0,
      'Confirmed submissions kept an unnecessary recovery warning in the workspace.');
    const peerReadFault = service.interceptNextResponse({ method: 'GET', pathname: firstWorkflowReceiptPath, mode: 'hold' });
    pausedReads.add(peerReadFault.release);
    await peerOriginal.getByRole('button', { name: 'Check receipt', exact: true }).click();
    const delayedPeerReceipt = await waitFor(() => peerReadFault.observation(),
      'The peer did not complete the production read underlying its delayed receipt.', 15_000);
    assert(delayedPeerReceipt.status === 200 && delayedPeerReceipt.bytes < 8192,
      'The peer could not obtain its bounded original workflow receipt through native SSH.');
    const returnExplore = recoveryWorkspace.locator('[data-destination="explore"]');
    if (!await returnExplore.isVisible()) await recoveryWorkspace.getByRole('button', { name: 'Explore', exact: true }).click();
    await returnExplore.click();
    await waitFor(() => recoveryWorkspace.getByRole('button', { name: 'Run recipe', exact: true }).isEnabled(),
      'The restored analysis did not enable another explicit guided submission.', 30_000);
    let lostSubmission, lostInput, retainedBeforeCommit, routeFailure;
    const lostReplyFault = service.interceptNextResponse({ method: 'POST', pathname: `/api/projects/${service.project.id}/jobs`, mode: 'drop' });
    const jobRoute = /\/api\/projects\/[^/]+\/jobs$/;
    await recoveryWorkspace.route(jobRoute, async route => {
      if (route.request().method() !== 'POST' || lostInput) return route.continue();
      lostInput = route.request().postDataJSON();
      try {
        retainedBeforeCommit = await readRecoveryStorage(recoveryWorkspace);
        assert(retainedBeforeCommit.records.some(value => value.requestId === lostInput.requestId && value.state === 'pending' && !value.jobId),
          'The guided request UUID was not retained before any server admission.');
      } catch (error) { routeFailure = error; await route.abort('failed'); return; }
      // The server commits its original request while the renderer receives no
      // acknowledgement. Reopening must reconcile it by GET, never retry POST.
      await route.continue();
    });
    const guidedCountBefore = (await database.query("SELECT COUNT(*)::int AS count FROM jobs WHERE owner_user_id=$1 AND job_type='explore.summarize.v1'", [fixture.ownerId])).rows[0].count;
    await recoveryWorkspace.getByRole('button', { name: 'Run recipe', exact: true }).click();
    const lostReply = await waitFor(() => { if (routeFailure) throw routeFailure; return lostReplyFault.observation(); },
      'The lost-acknowledgement guided submission did not complete its production admission.', 30_000);
    assert(lostReply.status === 201 && lostReply.bytes < 16 * 1024 && lostReply.value,
      'The actual guided submission was not admitted before its reply was lost.');
    lostSubmission = lostReply.value;
    await recoveryWorkspace.unroute(jobRoute);
    await recoveryWorkspace.getByText(/Acceptance of this submission is unconfirmed/i).waitFor({ timeout: 10_000 });
    assert(lostInput.requestId && lostSubmission.submission?.requestId === lostInput.requestId,
      'Guided submission did not preserve an admitted request UUID across the missing reply.');
    assertSafeSubmission(lostSubmission.submission, { requestId: lostInput.requestId, jobId: lostSubmission.id });
    const pendingStorage = await readRecoveryStorage(recoveryWorkspace);
    assert(pendingStorage.records.some(value => value.requestId === lostInput.requestId && value.state === 'pending' && !value.jobId),
      'The interrupted receipt body did not leave its original guided request genuinely unconfirmed.');
    assert((await database.query("SELECT COUNT(*)::int AS count FROM jobs WHERE owner_user_id=$1 AND job_type='explore.summarize.v1'", [fixture.ownerId])).rows[0].count === guidedCountBefore + 1,
      'Losing the original POST acknowledgement created more than one guided job.');
    const postsAfterLostReply = submittedJobs();
    await waitFor(() => recoveryWorkspace.getByRole('button', { name: 'Run recipe', exact: true }).isEnabled(),
      'The guided page did not release its local busy state after losing the reply.', 10_000);
    await recoveryWorkspace.getByRole('button', { name: 'Run recipe', exact: true }).click();
    await recoveryWorkspace.getByText(/An earlier submission has not been confirmed/i).waitFor();
    assert(submittedJobs() === postsAfterLostReply, 'Clicking the guided page again while acceptance was unknown sent a new scientific POST.');
    const deliveredPeerReceipt = peer.waitForResponse(response => response.request().method() === 'GET'
      && new URL(response.url()).pathname === firstWorkflowReceiptPath && response.status() === 200, { timeout: 15_000 });
    peerReadFault.release(); pausedReads.delete(peerReadFault.release);
    await deliveredPeerReceipt;
    await waitFor(() => peerOriginal.getByRole('button', { name: 'Check receipt', exact: true }).isEnabled(),
      'The peer did not finish its stale original receipt inspection.', 15_000);
    const afterStalePeerRead = await readRecoveryStorage(peer);
    assert(afterStalePeerRead.records.some(value => value.requestId === lostInput.requestId && value.state === 'pending' && !value.jobId),
      'A stale receipt confirmation in another renderer overwrote the new unconfirmed submission locator.');
    const peerExplore = peer.locator('[data-destination="explore"]');
    if (!await peerExplore.isVisible()) await peer.getByRole('button', { name: 'Explore', exact: true }).click();
    await peerExplore.click();
    await waitFor(() => peer.getByRole('button', { name: 'Run recipe', exact: true }).isEnabled(),
      'The peer guided page did not become available for the pending-request guard check.', 15_000);
    const postsBeforePeerClick = submittedJobs();
    await peer.getByRole('button', { name: 'Run recipe', exact: true }).click();
    await peer.getByText(/An earlier submission has not been confirmed/i).waitFor();
    assert(submittedJobs() === postsBeforePeerClick
      && (await readRecoveryStorage(peer)).records.some(value => value.requestId === lostInput.requestId && value.state === 'pending'),
    'A genuine second renderer submitted work or erased the first renderer\'s unconfirmed request.');
    await peer.screenshot({ path: path.join(output, 'ssh-peer-window-pending-request-blocked.png') });
    await peer.close();
    check('A disposable second compiled renderer shares the real native SSH/TLS/auth session; its stale receipt response preserves another window\'s pending locator and its guided click sends no scientific POST. Production desktop connection controls are unchanged.');
    const guidedReceiptPath = `/api/projects/${service.project.id}/job-submissions/${lostInput.requestId}`;
    const lostReplyReceipt = await requestReceipt(recoveryWorkspace, guidedReceiptPath);
    assert(lostReplyReceipt.status === 200 && lostReplyReceipt.value.job.id === lostSubmission.id,
      'The owner-only GET receipt cannot recover the committed guided submission.');
    assertSafeSubmission(lostReplyReceipt.value, { requestId: lostInput.requestId, jobId: lostSubmission.id });
    const repeatedGuided = await requestReceipt(recoveryWorkspace, `/api/projects/${service.project.id}/jobs`, 'POST', lostInput);
    assert(repeatedGuided.status === 200 && repeatedGuided.value.id === lostSubmission.id
      && repeatedGuided.value.submission.requestHash === lostSubmission.submission.requestHash,
    'An explicit repeat of the exact guided request did not return its original admitted job.');
    await reopenDesktop(recoveryWorkspace);
    const recoveredGuided = await openRecoveredRun(recoveryWorkspace, lostInput.requestId, lostSubmission.id);
    await waitFor(async () => {
      const row = (await database.query('SELECT status FROM jobs WHERE id=$1', [lostSubmission.id])).rows[0];
      if (row?.status === 'failed') throw new Error('The admitted guided job failed after losing its acknowledgement.');
      return row?.status === 'completed';
    }, 'The original guided job did not finish after the complete desktop app reopened.');
    await recoveryWorkspace.getByRole('region', { name: 'Run monitoring', exact: true }).getByRole('button', { name: 'Refresh monitoring', exact: true }).click();
    await recoveredGuided.getByRole('heading', { name: 'Server state: Complete', exact: true }).waitFor();
    const recoveredStorage = await readRecoveryStorage(recoveryWorkspace);
    assert(recoveredStorage.records.some(value => value.requestId === lostInput.requestId && value.jobId === lostSubmission.id && value.state === 'accepted'),
      'Complete app reopening did not resolve the pending request to its exact accepted job.');
    assert((await database.query("SELECT COUNT(*)::int AS count FROM jobs WHERE owner_user_id=$1 AND job_type='explore.summarize.v1'", [fixture.ownerId])).rows[0].count === guidedCountBefore + 1,
      'Complete app reopening duplicated the lost-acknowledgement guided submission.');
    await recoveredGuided.scrollIntoViewIfNeeded();
    await recoveryWorkspace.screenshot({ path: path.join(output, 'ssh-reopened-lost-ack-guided.png') });
    check('A genuine guided POST commits before its acknowledgement is lost; complete Electron shutdown/reopen recovers the exact request and job through GET without a second scientific submission.');

    const originalReceipt = await requestReceipt(recoveryWorkspace, firstWorkflowReceiptPath);
    assert(originalReceipt.status === 200 && originalReceipt.value.schema === 'traceomics.workflow-submission.v1',
      'The original workflow request is not independently recoverable.');
    assertSafeSubmission(originalReceipt.value, { requestId: originalWorkflow.request_id, jobId: workflowJob.id });
    await recoveryWorkspace.getByRole('button', { name: /^Pipelines,/ }).click();
    await recoveryWorkspace.getByRole('button', { name: 'Open Remote inspection', exact: true }).click();
    await recoveryWorkspace.getByLabel('Cells to keep', { exact: true }).fill('4');
    const [laterRunResponse] = await Promise.all([
      recoveryWorkspace.waitForResponse(response => response.request().method() === 'POST' && /\/instances\/[^/]+\/run$/.test(new URL(response.url()).pathname)),
      recoveryWorkspace.getByRole('button', { name: 'Run Remote subset', exact: true }).click(),
    ]);
    assert(laterRunResponse.ok(), 'The explicit later workflow step was not admitted.');
    const laterRun = await laterRunResponse.json();
    assert(laterRun.submission?.jobId && laterRun.submission.jobId !== workflowJob.id, 'A deliberate new workflow request did not create a distinct run.');
    const laterJob = await waitFor(async () => {
      const row = (await database.query('SELECT * FROM jobs WHERE id=$1', [laterRun.submission.jobId])).rows[0];
      if (row?.status === 'failed') throw new Error('The second actual custom R step failed.');
      return row?.status === 'running' ? row : null;
    }, 'The later custom R step did not begin scientific work.');
    const originalDuringLater = await requestReceipt(recoveryWorkspace, firstWorkflowReceiptPath);
    assert(originalDuringLater.status === 200 && originalDuringLater.value.jobId === workflowJob.id
      && originalDuringLater.value.requestHash === originalReceipt.value.requestHash,
      'The original workflow receipt was replaced by the newer active run.');
    const duplicate = await requestReceipt(recoveryWorkspace, `/api/workflows/${service.project.id}/instances/${originalWorkflow.instance_id}/run`, 'POST',
      { requestId: originalWorkflow.request_id, stepId: 'subset', parameters: { cells: 5 }, seed: 1 });
    assert(duplicate.status === 200 && duplicate.value.submission.jobId === workflowJob.id
      && duplicate.value.state.active.id === laterJob.id,
      'A duplicate workflow request lost its original job receipt or displaced the later active step.');
    for (const changed of [{ parameters: { cells: 3 }, seed: 1 }, { parameters: { cells: 5 }, seed: 2 }]) {
      const conflict = await requestReceipt(recoveryWorkspace, `/api/workflows/${service.project.id}/instances/${originalWorkflow.instance_id}/run`, 'POST',
        { requestId: originalWorkflow.request_id, stepId: 'subset', ...changed });
      assert(conflict.status === 409 && conflict.bytes < 1024 && Object.keys(conflict.value).every(key => ['error', 'code'].includes(key)),
        'Reusing an admitted workflow UUID with changed scientific inputs was not rejected by a bounded conflict response.');
    }
    for (const pathname of [guidedReceiptPath, firstWorkflowReceiptPath]) {
      const deniedReceipt = await isolatedServiceRequest(service, pathname, { cookie: colleagueCookie });
      assert(deniedReceipt.status === 404 && deniedReceipt.bytes < 1024
        && Object.keys(deniedReceipt.value).every(key => ['error', 'code'].includes(key)),
      'Another authenticated project member received an owner-private submission receipt.');
    }
    assert((await database.query("SELECT COUNT(*)::int AS count FROM jobs WHERE owner_user_id=$1 AND job_type='expert.r.v1'", [fixture.ownerId])).rows[0].count === 2,
      'Workflow receipt inspection, duplicate submission or conflict checks created additional scientific jobs.');
    check('An original workflow receipt keeps its exact job after a later run; an identical UUID returns that original receipt, changed parameters or seed conflict, and independent project colleagues cannot inspect owner-private receipts.');
    await openMonitor(recoveryWorkspace, laterJob.id);
    await recoveryWorkspace.getByRole('region', { name: 'Selected run monitoring', exact: true }).getByRole('heading', { name: 'Server state: Running', exact: true }).waitFor();
    await reopenDesktop(recoveryWorkspace);
    const reopenedCustom = await openRecoveredRun(recoveryWorkspace, laterRun.submission.requestId, laterJob.id);
    const jobAfterReopen = (await database.query('SELECT status,attempts FROM jobs WHERE id=$1', [laterJob.id])).rows[0];
    assert(jobAfterReopen.status === 'running' && jobAfterReopen.attempts === laterJob.attempts,
      'The running custom recipe did not survive complete desktop shutdown with the same attempt.');
    await reopenedCustom.getByRole('heading', { name: 'Server state: Running', exact: true }).waitFor();
    await reopenedCustom.scrollIntoViewIfNeeded();
    await recoveryWorkspace.screenshot({ path: path.join(output, 'ssh-reopened-exact-running-recipe.png') });
    const laterCompleted = await waitFor(async () => {
      const row = (await database.query('SELECT status,attempts FROM jobs WHERE id=$1', [laterJob.id])).rows[0];
      if (row?.status === 'failed') throw new Error('The custom recipe failed after complete desktop reopening.');
      return row?.status === 'completed' ? row : null;
    }, 'The original running recipe did not complete after full desktop reopening.');
    await recoveryWorkspace.getByRole('region', { name: 'Run monitoring', exact: true }).getByRole('button', { name: 'Refresh monitoring', exact: true }).click();
    await reopenedCustom.getByRole('heading', { name: 'Server state: Complete', exact: true }).waitFor();
    assert(laterCompleted.attempts === laterJob.attempts
      && (await database.query("SELECT COUNT(*)::int AS count FROM jobs WHERE owner_user_id=$1 AND job_type='expert.r.v1'", [fixture.ownerId])).rows[0].count === 2,
    'Complete desktop recovery replayed custom R or started another attempt.');
    const exactLaterReceipt = await requestReceipt(recoveryWorkspace,
      `/api/workflows/${service.project.id}/instances/${originalWorkflow.instance_id}/submissions/${laterRun.submission.requestId}`);
    assertSafeSubmission(exactLaterReceipt.value, { requestId: laterRun.submission.requestId, jobId: laterJob.id });
    await readRecoveryStorage(recoveryWorkspace);
    await recoveryWorkspace.getByRole('button', { name: /^Pipelines,/ }).click();
    await recoveryWorkspace.getByRole('button', { name: 'Open Remote inspection', exact: true }).click();
    await recoveryWorkspace.getByRole('heading', { name: 'Subset summary', exact: true })
      .locator('xpath=ancestor::section[1]').getByText('4', { exact: true }).waitFor();
    await recoveryWorkspace.screenshot({ path: path.join(output, 'ssh-reopened-completed-recipe-result.png') });
    check('Complete Electron shutdown during a real running Seurat recipe restores its exact saved job on the same SSH target, retains one attempt and retrieves the edited four-cell result without scientific replay.');
    check('Recovery storage and submission receipts contain bounded scoped identifiers, without scientific source, objects, private paths or credentials.');
    assert(requests.some(value => value.path.startsWith(monitorBase))
      && requests.filter(value => value.path.startsWith(monitorBase)).every(value => value.method === 'GET'),
    'Browser monitoring sent a mutating request or did not exercise the owner-scoped monitoring routes.');
    assert(!requests.some(value => /checkpoint.*download|\/download$/.test(value.path)), 'The remote compute flow fetched a full checkpoint or output bundle to the renderer.');
    assert(requests.every(value => value.origin === service.endpoint), 'A scientific request left the desktop-selected HTTPS authority.');
    assert(responses.every(value => value.bytes < 512 * 1024 && !value.containsCheckpoint), 'A scientific API response transferred a full analysis object.');
    check('Scientific browser traffic stays bounded and contains no checkpoint or output-bundle download.');
    // The native transport suite continues its strict certificate, identity and loss checks.
    return recoveryWorkspace;
  }
}
if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
module.exports = { main };
