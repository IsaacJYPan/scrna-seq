#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PREFIX = 'traceomics_expert_browser_';
const R_TOKEN = 'expert-browser-r-token-000000000000000000000000';

function assert(condition, message, detail = '') {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
}

function databaseUrlFor(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedDatabase(name) {
  if (!new RegExp(`^${DATABASE_PREFIX}[a-z0-9_]+$`).test(name)) {
    throw new Error('Refusing to operate outside the Expert R browser database namespace.');
  }
  return `"${name}"`;
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, timeoutMs = 120000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error('Timed out waiting for Expert R browser acceptance.');
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Docker command failed (${args[0] || 'unknown'}).\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  return result;
}

function collectProcessOutput(child) {
  let output = '';
  const append = (chunk) => { output = `${output}${chunk}`.slice(-65536); };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return () => output;
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.connected) child.send({ type: 'traceomics:shutdown' });
  else child.kill('SIGTERM');
}

async function waitForExit(child, timeoutMs = 15000) {
  if (!child || child.exitCode !== null) return child?.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child process did not exit.')), timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function startReadinessR(storageRoot, port) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers['x-api-token'] !== R_TOKEN) {
      response.statusCode = 401;
      return response.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    const pathname = new URL(request.url, 'http://r.internal').pathname;
    if (request.method === 'GET' && pathname === '/health') {
      return response.end(JSON.stringify({ status: 'ok', r_version: '4.5.3' }));
    }
    if (request.method === 'GET' && pathname === '/session-id') {
      return response.end(JSON.stringify({ sessionId: 'expert-browser-readiness-r' }));
    }
    if (request.method === 'GET' && pathname === '/pipeline-state') {
      return response.end(JSON.stringify({ exists: false }));
    }
    if (request.method === 'GET' && pathname === '/internal/worker-readiness') {
      const nonce = String(request.headers['x-storage-probe-nonce'] || '');
      const probe = path.join(storageRoot, `.traceomics-worker-storage-probe-${nonce}`);
      const visible = /^[0-9a-f]{32}$/.test(nonce)
        && fs.existsSync(probe)
        && fs.readFileSync(probe, 'utf8') === 'traceomics-shared-storage-v1\n';
      response.statusCode = visible ? 200 : 503;
      return response.end(JSON.stringify({
        status: visible ? 'ok' : 'not_ready',
        storage_shared: visible,
        runtime_session_id: 'expert-browser-readiness-r',
      }));
    }
    response.statusCode = 404;
    return response.end(JSON.stringify({ error: 'Not found' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function login(page, email, password) {
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.getByPlaceholder('researcher@lab.edu').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /Open Workbench/ }).click();
  await page.getByRole('button', { name: 'Log out' }).waitFor({ state: 'visible', timeout: 15000 });
}

async function newestExpertJob(client, userId) {
  const result = await client.query(
    `SELECT id, status, error_json, parameters_json, result_analysis_object_id
       FROM jobs
      WHERE owner_user_id = $1 AND job_type = 'expert.r.v1'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [Number(userId)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    parameters_json: JSON.parse(row.parameters_json || '{}'),
    error_json: row.error_json ? JSON.parse(row.error_json) : null,
  };
}

async function main() {
  assert(fs.existsSync(path.join(ROOT, 'dist', 'index.html')),
    'Build the frontend before running Expert R browser acceptance.');
  const baseDatabaseUrl = String(process.env.DATABASE_URL || '').trim();
  assert(baseDatabaseUrl, 'DATABASE_URL must point to an operator-controlled local Postgres instance.');

  const suffix = `${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const databaseName = `${DATABASE_PREFIX}${suffix}`;
  const adminUrl = databaseUrlFor(baseDatabaseUrl, 'postgres');
  const databaseUrl = databaseUrlFor(baseDatabaseUrl, databaseName);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-expert-browser-'));
  const storageRoot = path.join(tempRoot, 'storage');
  const vaultRoot = path.join(tempRoot, 'vault');
  const workRoot = path.join(tempRoot, 'work');
  const inputPath = path.join(tempRoot, 'covariates.csv');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(inputPath, 'sample,condition\nS1,treated\n', { flag: 'wx' });

  const webPort = await unusedPort();
  const rPort = await unusedPort();
  const brokerPort = await unusedPort();
  const origin = `http://127.0.0.1:${webPort}`;
  const sandboxToken = crypto.randomBytes(32).toString('hex');
  const sessionSecret = crypto.randomBytes(48).toString('hex');
  const admin = new Client({ connectionString: adminUrl });
  let databaseCreated = false;
  let db = null;
  let appClient = null;
  let readinessR = null;
  let broker = null;
  let web = null;
  let worker = null;
  let browser = null;
  let readBrokerOutput = () => '';
  let readWebOutput = () => '';
  let readWorkerOutput = () => '';
  const jobIds = [];

  await admin.connect();
  try {
    console.log('[expert-r-browser] building reviewed R sandbox image');
    docker(['build', '-f', 'r-backend/Dockerfile', '-t', 'traceomics-r:single-host', 'r-backend']);
    const inspected = docker([
      'image', 'inspect', 'traceomics-r:single-host', '--format', '{{.Id}}',
    ], { capture: true });
    const sandboxImage = inspected.stdout.trim();
    assert(/^sha256:[0-9a-f]{64}$/.test(sandboxImage),
      'The browser flow requires an immutable local sandbox image ID', sandboxImage);

    await admin.query(`CREATE DATABASE ${quotedDatabase(databaseName)}`);
    databaseCreated = true;
    process.env.DATABASE_URL = databaseUrl;
    process.env.STORAGE_ROOT = storageRoot;
    process.env.VAULT_ROOT = vaultRoot;
    process.env.APP_DEPLOYMENT_MODE = 'private';
    process.env.EXPERT_R_ENABLED = 'true';
    process.env.EXPERT_R_ACCESS_POLICY = 'project-roles';
    process.env.EXPERT_R_SANDBOX_URL = `http://127.0.0.1:${brokerPort}`;
    process.env.EXPERT_R_SANDBOX_TOKEN = sandboxToken;
    db = require('../backend/pgDatabase');
    await db.initSchema();
    appClient = new Client({ connectionString: databaseUrl });
    await appClient.connect();

    const email = `expert-browser-${suffix}@example.invalid`;
    const password = `Expert-${crypto.randomBytes(18).toString('base64url')}`;
    const user = await db.createUser(email, password, 'Expert browser owner');
    const organization = await db.createOrganizationForUser(user.id, { name: 'Expert browser organization' });
    const project = await db.createProjectForUser(user.id, {
      organizationId: organization.id,
      name: 'Expert browser project',
    });
    const analysis = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
      displayName: 'Expert browser saved analysis',
    });
    const producer = await db.createProjectJob(user.id, project.id, {
      jobType: 'checkpoint.noop', analysisObjectId: analysis.id,
    });
    await db.updateJobStatusForUser(user.id, producer.id, 'running');
    await db.updateJobStatusForUser(user.id, producer.id, 'completed', {
      resultAnalysisObjectId: analysis.id,
    });
    assert(await db.hasExpertRExecuteCapability(user.id, project.id),
      'New private project-role policy must authorize its owner without an individual grant.');

    const checkpointKey = `projects/${project.id}/checkpoints/${producer.id}/checkpoint.rds`;
    const checkpointPath = path.join(storageRoot, ...checkpointKey.split('/'));
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    const checkpointExpression = `
      suppressPackageStartupMessages({library(Seurat); library(Matrix)})
      set.seed(9191)
      counts <- matrix(rpois(120 * 80, 2), nrow=120, ncol=80)
      rownames(counts) <- paste0('Gene', seq_len(nrow(counts)))
      colnames(counts) <- paste0('Cell', seq_len(ncol(counts)))
      obj <- CreateSeuratObject(Matrix(counts, sparse=TRUE))
      obj$seurat_clusters <- factor(rep(c('0','1'), length.out=ncol(obj)))
      saveRDS(list(global=obj, raw=obj), '/storage/checkpoint.rds', compress=FALSE)
    `;
    docker([
      'run', '--rm', '--user', '0:0', '-v', `${path.dirname(checkpointPath)}:/storage`,
      '--entrypoint', 'Rscript', sandboxImage, '-e', checkpointExpression,
    ]);
    const checkpointBytes = fs.readFileSync(checkpointPath);
    const checkpointChecksum = crypto.createHash('sha256').update(checkpointBytes).digest('hex');
    await db.query(
      `INSERT INTO job_artifacts
         (id, project_id, job_id, result_analysis_object_id, created_by_user_id,
          artifact_type, name, mime_type, storage_kind, storage_uri,
          checksum_sha256, size_bytes, status, metadata_json)
       VALUES ($1, $2, $3, $4, $5, 'checkpoint', 'Expert browser checkpoint',
               'application/x-r-rds', 'local_internal', $6, $7, $8, 'available', $9)`,
      [db.genId('art'), project.id, producer.id, analysis.id, Number(user.id), checkpointKey,
        checkpointChecksum, checkpointBytes.length, JSON.stringify({ acceptanceFixture: true })]
    );

    readinessR = await startReadinessR(storageRoot, rPort);
    const commonEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      STORAGE_ROOT: storageRoot,
      VAULT_ROOT: vaultRoot,
      APP_DEPLOYMENT_MODE: 'private',
      EXPERT_R_ENABLED: 'true',
      EXPERT_R_ACCESS_POLICY: 'project-roles',
      EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${brokerPort}`,
      EXPERT_R_SANDBOX_TOKEN: sandboxToken,
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: `http://127.0.0.1:${rPort}`,
      R_API_TOKEN: R_TOKEN,
    };
    broker = spawn(process.execPath, [path.join(ROOT, 'backend', 'expertSandboxBroker.js')], {
      cwd: ROOT,
      env: {
        ...commonEnv,
        EXPERT_R_SANDBOX_IMAGE: sandboxImage,
        EXPERT_R_SANDBOX_WORK_ROOT: workRoot,
        EXPERT_R_SANDBOX_HOST: '127.0.0.1',
        EXPERT_R_SANDBOX_PORT: String(brokerPort),
        EXPERT_R_MAX_CONCURRENT: '1',
        EXPERT_R_MEMORY_LIMIT: '2g',
        EXPERT_R_CPU_LIMIT: '1',
        EXPERT_R_TIMEOUT_MS: '90000',
        EXPERT_R_MIN_FREE_BYTES: '268435456',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    readBrokerOutput = collectProcessOutput(broker);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${brokerPort}/health`)).ok, 90000);

    web = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: {
        ...commonEnv,
        SESSION_SECRET: sessionSecret,
        FRONTEND_ORIGIN: origin,
        COOKIE_SECURE: 'false',
        WEB_HOST: '127.0.0.1',
        PORT: String(webPort),
        ENABLE_JOB_WORKER: 'false',
        DISABLE_RATE_LIMIT: 'true',
        WEB_DRAIN_DELAY_MS: '0',
        WEB_SHUTDOWN_TIMEOUT_MS: '10000',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    readWebOutput = collectProcessOutput(web);
    await waitFor(async () => (await fetch(`${origin}/readyz`)).ok, 30000);

    worker = spawn(process.execPath, [path.join(ROOT, 'worker.js')], {
      cwd: ROOT,
      env: {
        ...commonEnv,
        ENABLE_JOB_WORKER: 'true',
        JOB_WORKER_ALLOWED_JOB_TYPES: 'expert.r.v1',
        JOB_WORKER_MIN_FREE_MEMORY_MB: '1',
        JOB_WORKER_HEALTH_PORT: '0',
        JOB_WORKER_STARTUP_TIMEOUT_MS: '30000',
        JOB_WORKER_POLL_MS: '100',
        JOB_WORKER_LEASE_SECONDS: '120',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    readWorkerOutput = collectProcessOutput(worker);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const serverErrors = [];
    const clientErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
      else if (response.status() >= 400) clientErrors.push(`${response.status()} ${response.url()}`);
    });

    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Log In', exact: true }).waitFor({ state: 'visible' });
    await login(page, email, password);
    await page.getByText('Expert browser project', { exact: true }).first().waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /^Advanced analysis/ }).click();
    await page.getByRole('heading', { name: 'Expert R Workbench' }).waitFor({ state: 'visible' });
    const rStatusScreenshots = path.join(ROOT, 'playwright/report/release-acceptance/private-r');
    fs.mkdirSync(rStatusScreenshots, { recursive: true });
    await page.screenshot({ path: path.join(rStatusScreenshots, 'runtime-ready.png'), fullPage: true });
    await page.getByLabel('Choose private input').setInputFiles(inputPath);
    await page.getByRole('button', { name: 'Import file' }).click();
    await page.getByText('covariates.csv', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('Selected for this run: 1/5', { exact: true }).waitFor({ state: 'visible' });

    const successScript = `
covariates <- read_input("covariates.csv")
summary_table <- data.frame(
  cells = ncol(obj),
  features = nrow(obj),
  condition = covariates$condition[[1]]
)
write_table(summary_table, "object-summary.csv")
`;
    await page.getByLabel('R script').fill(successScript);
    await page.getByRole('button', { name: 'Run R analysis' }).click();
    await page.getByText('Run submitted. Results will remain private until you choose to share them.', { exact: true })
      .waitFor({ state: 'visible' });
    const completedJob = await waitFor(async () => {
      const row = await newestExpertJob(appClient, user.id);
      if (row?.id && !jobIds.includes(row.id)) jobIds.push(row.id);
      return row?.status === 'completed' ? row : null;
    }, 180000, 500);
    assert(completedJob.result_analysis_object_id, 'Successful Expert R run did not publish a private result object.');
    assert(!JSON.stringify(completedJob.parameters_json || {}).includes(successScript.trim()),
      'Terminal Expert R job retained source text instead of only its hash.');

    await page.getByRole('button', { name: /View in Runs & Results/ }).click();
    await page.getByRole('heading', { name: 'Runs & Results' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByText('Complete', { exact: true }).first().waitFor({ state: 'visible' });
    await page.getByText('R analysis output', { exact: true }).waitFor({ state: 'visible' });
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download result' }).click();
    const download = await downloadPromise;
    const downloadPath = path.join(tempRoot, 'expert-r-output.tar.gz');
    await download.saveAs(downloadPath);
    const downloadedBytes = fs.readFileSync(downloadPath);
    const artifactResult = await appClient.query(
      `SELECT checksum_sha256, size_bytes
         FROM job_artifacts
        WHERE job_id = $1 AND artifact_type = 'expert_r_bundle'`,
      [completedJob.id]
    );
    assert(artifactResult.rows.length === 1, 'Successful run did not publish exactly one output bundle.');
    assert(downloadedBytes.length === Number(artifactResult.rows[0].size_bytes),
      'Browser download size did not match the recorded output bundle.');
    assert(crypto.createHash('sha256').update(downloadedBytes).digest('hex') === artifactResult.rows[0].checksum_sha256,
      'Browser download checksum did not match the recorded output bundle.');
    const archive = docker([
      'run', '--rm', '-v', `${tempRoot}:/acceptance:ro`, 'alpine:3.21',
      'tar', '-xOzf', '/acceptance/expert-r-output.tar.gz', './object-summary.csv',
    ], { capture: true });
    assert(/treated/.test(archive.stdout) && /80/.test(archive.stdout) && /120/.test(archive.stdout),
      'Downloaded output did not contain the browser-imported input and checkpoint-derived summary.');

    const { pipelineRunScript } = await import('../src/pipelines/executablePipeline.mjs');
    const pipeline = {
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/pipelines/cell-summary.json'), 'utf8')),
      script: fs.readFileSync(path.join(ROOT, 'examples/pipelines/cell-summary.R'), 'utf8'),
    };
    await page.getByRole('button', { name: /^Pipelines/ }).click();
    await page.getByLabel('Pipeline package file').setInputFiles({
      name: 'cell-summary.pipeline.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(pipeline)),
    });
    await page.getByRole('button', { name: 'Install version 1.0.0', exact: true }).click();
    assert((await newestExpertJob(appClient, user.id)).id === completedJob.id,
      'Installing a pipeline must not submit a job.');
    await page.getByRole('button', { name: 'Run Cell summary', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Pipeline submitted.' }).waitFor({ state: 'visible' });
    const pipelineJob = await waitFor(async () => {
      const row = await newestExpertJob(appClient, user.id);
      if (row?.id && !jobIds.includes(row.id)) jobIds.push(row.id);
      return row?.id !== completedJob.id && ['completed', 'failed'].includes(row?.status) ? row : null;
    }, 180000, 500);
    assert(pipelineJob.status === 'completed', 'Imported pipeline execution failed');
    const expectedSourceHash = crypto.createHash('sha256').update(pipelineRunScript(pipeline)).digest('hex');
    assert(pipelineJob.parameters_json.scriptSha256 === expectedSourceHash,
      'The pipeline run must retain the hash of its exact version and source.');
    assert(!pipelineJob.parameters_json.script, 'A completed pipeline must erase retained source text.');
    const pipelineArtifact = await appClient.query(
      "SELECT storage_uri FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'expert_r_bundle'",
      [pipelineJob.id]
    );
    assert(pipelineArtifact.rows.length === 1, 'The imported pipeline must publish one result bundle.');
    const pipelineArchive = docker([
      'run', '--rm', '-v', `${storageRoot}:/storage:ro`, 'alpine:3.21',
      'tar', '-xOzf', `/storage/${pipelineArtifact.rows[0].storage_uri}`, './cell-summary.csv',
    ], { capture: true });
    const summaryValues = pipelineArchive.stdout.trim().split(/\r?\n/).at(-1).split(',').map(Number);
    assert(summaryValues.length === 2 && summaryValues[0] === 80 && summaryValues[1] === 120,
      'The imported pipeline must compute cell and feature counts from the saved analysis.');

    const { packWorkflow } = await import('./pack-workflow.mjs');
    const workflowPath = path.join(tempRoot, 'scrna-workflow.pipeline.json');
    await packWorkflow(path.join(ROOT, 'examples/pipelines/scrna-workflow'), workflowPath);
    await page.getByLabel('Workflow package file').setInputFiles(workflowPath);
    await page.getByRole('button', { name: 'Install Single-cell workflow', exact: true }).click();
    await page.getByRole('button', { name: 'Open Single-cell workflow', exact: true }).click();
    await page.getByRole('heading', { name: 'Single-cell workflow', exact: true, level: 1 }).waitFor();
    const pcaNavigation = page.getByRole('button', { name: 'PCA', exact: true });
    assert(await pcaNavigation.getAttribute('aria-disabled') === 'true', 'PCA must start locked');
    await pcaNavigation.focus();
    await page.getByRole('tooltip').filter({ hasText: 'Requires Normalize.' }).waitFor({ state: 'visible' });
    async function runWorkflowStep(label, id) {
      const before = (await appClient.query('SELECT state_json FROM workflow_instances WHERE owner_user_id=$1', [user.id])).rows[0].state_json.generation;
      if (id !== 'qc' && id !== 'umap-figure') {
        const navigation = page.getByRole('button', { name: label, exact: true });
        await waitFor(async () => await navigation.getAttribute('aria-disabled') !== 'true', 15000, 100);
        await navigation.click();
      }
      await page.getByRole('button', { name: `Run ${label}`, exact: true }).click();
      await waitFor(async () => {
        const latest = await newestExpertJob(appClient, user.id);
        if (latest?.id && !jobIds.includes(latest.id)) jobIds.push(latest.id);
        const { rows } = await appClient.query('SELECT state_json FROM workflow_instances WHERE owner_user_id=$1', [user.id]);
        const state = rows[0]?.state_json;
        if (state?.error) throw new Error(state.error);
        return state?.results[id] && !state.active && state.generation > before;
      }, 180000, 500);
      await page.getByRole('button', { name: `Run ${label}`, exact: true }).waitFor({ state: 'visible' });
    }
    for (const [label, id] of [['Quality Control', 'qc'], ['Normalize', 'normalize'], ['PCA', 'pca'], ['Neighbors', 'neighbors'], ['Clustering', 'clusters'], ['UMAP', 'umap'], ['Cluster-colored UMAP', 'umap-figure']]) {
      await runWorkflowStep(label, id);
      console.log(`[workflow-browser] PASS ${label}`);
    }
    await page.getByRole('img', { name: 'UMAP by cluster', exact: true }).waitFor({ state: 'visible' });
    await waitFor(async () => await page.locator('.scatterlayer .point').count() === 80, 15000, 100);
    const screenshotDirectory = path.join(ROOT, 'playwright/report/release-acceptance/workflow');
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDirectory, 'workflow-umap.png'), fullPage: true });
    const figure = page.getByRole('img', { name: 'UMAP by cluster', exact: true });
    await waitFor(async () => figure.evaluate(image => image.complete && image.naturalWidth > 0), 15000, 100);
    await figure.screenshot({ path: path.join(screenshotDirectory, 'workflow-custom-figure.png') });
    await page.getByLabel('Snapshot name').fill('Completed workflow');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByText('Saved Completed workflow.', { exact: true }).waitFor();
    assert((await appClient.query('SELECT COUNT(*)::int AS count FROM workflow_snapshots WHERE owner_user_id=$1', [user.id])).rows[0].count === 1, 'Explicit save must create one workflow snapshot.');
    await pcaNavigation.click();
    await page.getByLabel('Components', { exact: true }).fill('8');
    await runWorkflowStep('PCA', 'pca');
    const resetState = (await appClient.query('SELECT state_json FROM workflow_instances WHERE owner_user_id=$1', [user.id])).rows[0].state_json;
    assert(!resetState.results.umap && !resetState.results.neighbors && !resetState.results.clusters && !resetState.results['umap-figure'], 'Changed PCA must clear both branches and their figures.');
    await page.getByText('Saved workflows for this analysis', { exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByText('Opened Completed workflow.', { exact: true }).waitFor();
    assert(await page.getByLabel('Components', { exact: true }).inputValue() === '15', 'Snapshot restore must restore the applied form settings.');
    await page.getByRole('button', { name: 'UMAP', exact: true }).click();
    await figure.waitFor({ state: 'visible' });
    console.log('[workflow-browser] PASS import, locks, figures, rerun invalidation, and snapshot restoration');

    await page.getByRole('button', { name: /^Advanced analysis/ }).click();
    await page.getByRole('heading', { name: 'Expert R Workbench' }).waitFor({ state: 'visible' });
    const privateMarker = `${tempRoot}\\private-marker.txt`;
    await page.getByLabel('R script').fill(`stop("${privateMarker.replace(/\\/g, '\\\\')}")`);
    await page.getByRole('button', { name: 'Run R analysis' }).click();
    await page.getByText('Run submitted. Results will remain private until you choose to share them.', { exact: true })
      .waitFor({ state: 'visible' });
    const failedJob = await waitFor(async () => {
      const row = await newestExpertJob(appClient, user.id);
      if (row?.id && !jobIds.includes(row.id)) jobIds.push(row.id);
      return row?.id !== completedJob.id && row?.status === 'failed' ? row : null;
    }, 180000, 500);
    assert(!JSON.stringify(failedJob.parameters_json || {}).includes(privateMarker),
      'Failed terminal job retained private source text.');
    assert(!JSON.stringify(failedJob.error_json || {}).includes(privateMarker),
      'Failed job error retained a private path from R output.');

    await page.getByRole('button', { name: /View in Runs & Results/ }).click();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByText('Needs attention', { exact: true }).first().waitFor({ state: 'visible' });
    const historyText = await page.locator('body').innerText();
    assert(historyText.includes('The R script stopped with an error. Check input names, columns, and function arguments.'),
      'Runs & Results did not show the approved path-free owner explanation', historyText.slice(-2000));
    assert(!historyText.includes(privateMarker),
      'The failed-script private path appeared in the browser.');
    assert(serverErrors.length === 0, `Browser observed server errors: ${serverErrors.join(' | ')}`);
    assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join(' | ')}`);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => (
      !/Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/i.test(message)
    ));
    const unexpectedClientErrors = clientErrors.filter((entry) => (
      !/^401 http:\/\/127\.0\.0\.1:\d+\/api\/auth\/session$/.test(entry)
    ));
    assert(unexpectedClientErrors.length === 0,
      `Browser observed unexpected client errors: ${unexpectedClientErrors.join(' | ')}`);
    assert(unexpectedConsoleErrors.length === 0,
      `Browser console errors: ${unexpectedConsoleErrors.join(' | ')}; client responses: ${clientErrors.join(' | ')}`);

    const published = await appClient.query(
      `SELECT COUNT(*)::int AS count
         FROM analysis_objects
        WHERE owner_user_id = $1 AND object_type = 'generic'`,
      [Number(user.id)]
    );
    assert(Number(published.rows[0].count) === 2,
      'Only the two successful runs should publish creator-private result objects.');
    await db.setExpertRExecutorByEmail(email, false);
    await page.getByRole('button', { name: /^Advanced analysis/ }).click();
    await page.reload();
    await page.getByRole('button', { name: /^Advanced analysis/ }).click();
    await page.getByText(/administrator has revoked R execution/i).waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(rStatusScreenshots, 'access-revoked.png'), fullPage: true });
    assert(await page.getByRole('button', { name: 'Check R availability', exact: true }).isEnabled(),
      'Revoked researchers must be able to inspect R setup/status.');
    assert(await page.getByRole('button', { name: 'Run R analysis', exact: true }).count() === 0,
      'Revoked researchers must not receive an execution control.');
    assert((await appClient.query("SELECT COUNT(*)::int AS count FROM jobs WHERE owner_user_id=$1 AND job_type='expert.r.v1' AND status='queued'", [user.id])).rows[0].count === 0,
      'Reviewing revoked R status must not queue analysis work.');
    console.log('[expert-r-browser] PASS role-authorized isolated R without an individual grant and revoked-access UI');
    console.log('[expert-r-browser] PASS private file import, pipeline package execution, exact download, source erasure, and path-free failure UX');
  } catch (error) {
    const diagnostics = [
      readBrokerOutput() && `broker:\n${readBrokerOutput()}`,
      readWebOutput() && `web:\n${readWebOutput()}`,
      readWorkerOutput() && `worker:\n${readWorkerOutput()}`,
    ].filter(Boolean).join('\n');
    if (diagnostics) console.error(diagnostics);
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    for (const child of [worker, web]) stopChild(child);
    if (broker && broker.exitCode === null) broker.kill('SIGTERM');
    for (const child of [worker, web, broker]) {
      try { await waitForExit(child); } catch {
        try { child?.kill('SIGKILL'); } catch { /* best effort */ }
      }
    }
    await closeServer(readinessR);
    if (db) await db.close().catch(() => {});
    if (appClient) await appClient.end().catch(() => {});
    for (const jobId of jobIds) {
      const names = docker([
        'ps', '-a', '--filter', `name=traceomics-expert-${jobId}-`, '--format', '{{.Names}}',
      ], { capture: true, allowFailure: true }).stdout.trim().split(/\r?\n/).filter(Boolean);
      for (const name of names) docker(['rm', '-f', name], { allowFailure: true, capture: true });
    }
    if (databaseCreated) {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName]
      ).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase(databaseName)}`).catch(() => {});
    }
    await admin.end().catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[expert-r-browser] FAIL', error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
