#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const executeFile = promisify(execFile);

async function savedAnalysisFixture(database, service, image) {
  const owner = (await database.query('SELECT id FROM users WHERE email=$1', [service.account.email])).rows[0];
  assert(owner, 'The disposable research account is missing.');
  const identity = prefix => prefix + '_' + crypto.randomBytes(12).toString('hex');
  const analysisId = identity('ao'), jobId = identity('job'), checkpointId = identity('art');
  const projectId = service.project.id;
  const checkpointKey = `projects/${projectId}/checkpoints/${jobId}/checkpoint.rds`;
  const checkpointPath = path.join(service.storageRoot, ...checkpointKey.split('/'));
  const checkpointDirectory = path.dirname(checkpointPath);
  fs.mkdirSync(checkpointDirectory, { recursive: true });
  // Only this owned output directory is writable by the nonroot fixture
  // producer. It receives no storage parent, server secrets or untrusted RDS.
  fs.chmodSync(checkpointDirectory, 0o777);
  try {
    await executeFile('docker', ['run', '--rm', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
      '--pids-limit', '128', '--memory', '1g', '--cpus', '1',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m',
      '--mount', `type=bind,source=${checkpointDirectory},target=/fixture`,
      '--entrypoint', 'Rscript', image, '--vanilla', '-e', `
        suppressPackageStartupMessages({library(Seurat); library(Matrix)})
        set.seed(1919)
        counts <- matrix(rpois(20L * 12L, 3), nrow=20L, ncol=12L)
        rownames(counts) <- paste0('Gene', seq_len(nrow(counts)))
        colnames(counts) <- paste0('Cell', seq_len(ncol(counts)))
        obj <- CreateSeuratObject(Matrix(counts, sparse=TRUE))
        obj$condition <- rep(c('control','treated'), each=6L)
        stopifnot(ncol(obj)==12L, nrow(obj)==20L)
        saveRDS(list(global=obj,raw=obj), '/fixture/checkpoint.rds')
      `], { cwd: root, windowsHide: true, timeout: 90_000, maxBuffer: 64 * 1024 });
  } catch { throw new Error('The reviewed isolated R image could not create the disposable saved analysis.'); }
  finally { fs.chmodSync(checkpointDirectory, 0o755); }
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const checksum = value => crypto.createHash('sha256').update(value).digest('hex');
  const tableId = identity('art'), versionId = identity('av');
  const tableKey = `projects/${projectId}/artifacts/${tableId}/cell-metadata.csv`;
  const tablePath = path.join(service.storageRoot, ...tableKey.split('/'));
  const tableBytes = Buffer.from('cell,condition\n' + Array.from({ length: 12 }, (_, index) =>
    `Cell${index + 1},${index < 6 ? 'control' : 'treated'}`).join('\n') + '\n');
  fs.mkdirSync(path.dirname(tablePath), { recursive: true }); fs.writeFileSync(tablePath, tableBytes);
  await database.query('BEGIN');
  try {
    await database.query(`INSERT INTO analysis_objects(id,owner_user_id,project_id,object_type,display_name,metadata_json)
      VALUES($1,$2,$3,'seurat','Selected saved Seurat analysis',$4)`,
    [analysisId, owner.id, projectId, JSON.stringify({ acceptanceFixture: true, cells: 12, genes: 20 })]);
    await database.query(`INSERT INTO jobs(id,owner_user_id,project_id,analysis_object_id,result_analysis_object_id,job_type,status,started_at,completed_at)
      VALUES($1,$2,$3,$4,$4,'checkpoint.noop','completed',NOW(),NOW())`, [jobId, owner.id, projectId, analysisId]);
    await database.query(`INSERT INTO job_artifacts(id,project_id,job_id,result_analysis_object_id,created_by_user_id,artifact_type,name,mime_type,storage_kind,storage_uri,checksum_sha256,size_bytes,status,metadata_json)
      VALUES($1,$2,$3,$4,$5,'checkpoint','Selected Seurat checkpoint','application/x-r-rds','local_internal',$6,$7,$8,'available',$9)`,
    [checkpointId, projectId, jobId, analysisId, owner.id, checkpointKey, checksum(checkpointBytes), checkpointBytes.length, JSON.stringify({ acceptanceFixture: true })]);
    await database.query(`INSERT INTO managed_artifact_versions(id,artifact_id,project_id,owner_user_id,name,version_number,artifact_type,format_json,mime_type,checksum_sha256,size_bytes,storage_key,source_job_id)
      VALUES($1,$2,$3,$4,'cell-metadata.csv',1,'table',$5,'text/csv',$6,$7,$8,$9)`,
    [versionId, tableId, projectId, owner.id, JSON.stringify({ id: 'org.ietf.csv', version: '1' }), checksum(tableBytes), tableBytes.length, tableKey, jobId]);
    await database.query('COMMIT');
  } catch (error) { await database.query('ROLLBACK'); throw error; }
  return { analysisId, checkpointId, versionId, checkpointSha256: checksum(checkpointBytes), tableSha256: checksum(tableBytes) };
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(check, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function readableContrast(locator) {
  return locator.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const components = color => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map(value => value / 255);
    };
    let background = [1, 1, 1]; const ancestors = [];
    for (let current = element; current; current = current.parentElement) ancestors.push(current);
    for (const current of ancestors.reverse()) {
      const color = components(getComputedStyle(current).backgroundColor);
      background = background.map((value, index) => color[index] * color[3] + value * (1 - color[3]));
    }
    const color = components(getComputedStyle(element).color);
    const foreground = background.map((value, index) => color[index] * color[3] + value * (1 - color[3]));
    const luminance = rgb => rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((value, channel, index) => value + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const first = luminance(foreground), second = luminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  });
}
async function main() {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''),
    'Set EXPERT_R_SANDBOX_IMAGE to the reviewed immutable persistent-kernel image.');
  const directory = path.join(root, 'playwright', 'report', 'private-r-console-' + Date.now());
  fs.mkdirSync(directory, { recursive: true });
  const port = await freePort(), token = crypto.randomBytes(32).toString('hex');
  let service, broker, browser, page, database;
  const errors = [], checks = [], kernelRequests = [], recoveryReads = [];
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory,
      webEnvironment: { EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles',
        EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${port}`, EXPERT_R_SANDBOX_TOKEN: token } });
    process.env.STORAGE_ROOT = service.storageRoot;
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const selectedAnalysis = await savedAnalysisFixture(database, service, image);
    const env = { ...process.env, NODE_ENV: 'test', EXPERT_R_SANDBOX_TOKEN: token,
      EXPERT_R_SANDBOX_IMAGE: image, EXPERT_R_SANDBOX_WORK_ROOT: path.join(directory, 'broker-work'),
      PRIVATE_R_KERNEL_ENABLED: 'true', PRIVATE_R_KERNEL_IDLE_SECONDS: '300' };
    broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker(env);
    await broker.startReconciliation();
    await new Promise(resolve => broker.listen(port, '127.0.0.1', resolve));
    const capability = await fetch(`http://127.0.0.1:${port}/capabilities`, {
      headers: { Authorization: 'Bearer ' + token } }).then(response => response.json());
    assert(capability.persistentKernel === true, 'The exact image did not pass the independent persistent-kernel probe.');
    assert(capability.persistentKernelPublications === true, 'The exact image did not pass the independent output-publication probe.');
    assert(capability.persistentKernelInterrupt === true, 'The exact image did not pass the independent interrupt probe.');
    const certificate = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    const authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(certificate.verify(authority.publicKey) && certificate.checkHost(new URL(service.endpoint).hostname),
      'The disposable HTTPS certificate did not match its authority and hostname.');
    const spki = crypto.createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    // Trust only this disposable leaf key in this acceptance browser. Production
    // code has no certificate override; native tunnel acceptance tests TLS errors.
    browser = await chromium.launch({ headless: true, args: [
      '--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + spki,
    ] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/private-r-kernels/')) {
        if (kernelRequests.length >= 2500) {
          if (!errors.includes('Private R acceptance exceeded its bounded request ledger.')) errors.push('Private R acceptance exceeded its bounded request ledger.');
          return;
        }
        kernelRequests.push({ method: request.method(), pathname });
      }
    });
    const assertReadOnly = (offset, phase) => {
      const requests = kernelRequests.slice(offset);
      assert(requests.length > 0 && requests.every(request => request.method === 'GET'),
        phase + ' dispatched a private R mutation or did not inspect the server.');
      recoveryReads.push({ phase, requests });
    };
    await page.goto(service.endpoint);
    await page.getByPlaceholder('researcher@lab.edu').fill(service.account.email);
    await page.getByLabel('Password', { exact: true }).fill(service.account.password);
    await page.getByRole('button', { name: /Open Workbench/ }).click();
    await page.getByRole('button', { name: /^Advanced analysis,/ }).click();
    const darkMode = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
    if (await darkMode.isVisible()) await darkMode.click();
    const consoleUi = page.getByRole('region', { name: 'Private R console', exact: true });
    await page.getByRole('button', { name: 'Interactive console', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).waitFor();
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125_000 });
    check('Production HTTPS login and project-role authorization start an actual private R kernel.');
    async function run(source, order) {
      await consoleUi.getByLabel('R console source').fill(source);
      await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
      await consoleUi.getByRole('region', { name: 'R command output' }).getByText('Command ' + order + ' · completed', { exact: true }).waitFor({ timeout: 125_000 });
    }
    await run('private_value <- 41; private_value', 1);
    await consoleUi.getByRole('button', { name: 'Add R cell', exact: true }).click();
    await run('cat(private_value + 1L); display_table(data.frame(cells=c("a","b"), counts=c(2,3)), name="Cell counts"); plot(1:3)', 2);
    const output = consoleUi.getByRole('region', { name: 'R command output' });
    assert((await output.getByLabel('R stdout').innerText()).includes('42'), 'Earlier private variables were lost between commands.');
    await output.getByRole('cell', { name: 'a', exact: true }).waitFor();
    const figure = output.getByRole('img', { name: 'R figure 1', exact: true });
    await figure.waitFor();
    await output.screenshot({ path: path.join(directory, 'persistent-r-table-figure.png') });
    await figure.scrollIntoViewIfNeeded();
    await figure.screenshot({ path: path.join(directory, 'rendered-r-figure.png') });
    check('Free R cells preserve variables and render actual bounded tables and PNG plots.');
    const originalKernel = (await database.query('SELECT id,runtime_generation,next_order FROM private_r_kernels ORDER BY created_at DESC LIMIT 1')).rows[0];
    const initialReads = kernelRequests.length;
    const initialInspection = service.interceptNextResponse({ method: 'GET',
      pathname: '/api/private-r-kernels/' + service.project.id + '/' + originalKernel.id, mode: 'hold' });
    try {
      await page.reload();
      await page.getByRole('button', { name: /^Advanced analysis,/ }).click();
      await page.getByRole('button', { name: 'Interactive console', exact: true }).click();
      await waitFor(() => initialInspection.observation(), 'Initial attach did not inspect the exact existing kernel.');
      await consoleUi.getByText('Checking the private R session. Commands and saves wait for fresh server confirmation.', { exact: true }).waitFor();
      assert(!await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(),
        'A cached ready session allowed execution before its initial exact-kernel inspection finished.');
      const initialSave = consoleUi.getByRole('button', { name: 'Save object', exact: true });
      assert(await initialSave.count() === 0 || !await initialSave.isEnabled(),
        'An unconfirmed initial session allowed object serialization.');
    } finally { initialInspection.release(); }
    await output.getByText('Command 2 · completed', { exact: true }).waitFor({ timeout: 30_000 });
    await output.getByRole('cell', { name: 'a', exact: true }).waitFor();
    await output.getByRole('img', { name: 'R figure 1', exact: true }).evaluate(element => element.decode());
    await consoleUi.getByLabel('R command journal').getByRole('button', { name: 'Command 1 · completed', exact: true }).waitFor();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor();
    const reattached = (await database.query('SELECT id,runtime_generation,next_order FROM private_r_kernels ORDER BY created_at DESC LIMIT 1')).rows[0];
    assert(reattached.id === originalKernel.id && reattached.runtime_generation === originalKernel.runtime_generation
      && Number(reattached.next_order) === 2, 'Initial journal inspection changed the exact kernel or replayed a command.');
    assertReadOnly(initialReads, 'Initial existing-session and latest journal/output recovery');
    await output.screenshot({ path: path.join(directory, 'reloaded-existing-journal-output.png') });
    await consoleUi.getByLabel('R session identity').screenshot({ path: path.join(directory, 'reloaded-exact-session-identity.png') });
    check('Initial reload requires fresh exact-kernel inspection, restores the existing latest journal/table/figure through GET, and never starts or executes R.');
    const editor = consoleUi.getByLabel('R console source');
    const retainedDraft = '# Unexecuted local inspection draft\ncat(private_value + 100L)';
    await editor.fill(retainedDraft);
    const sourceCopyRequests = kernelRequests.length;
    await output.getByRole('button', { name: 'Copy executed source to new R cell', exact: true }).click();
    const retainedSource = (await database.query('SELECT source_code FROM private_r_executions WHERE kernel_id=$1 AND execution_order=2', [originalKernel.id])).rows[0].source_code;
    assert(await editor.inputValue() === retainedSource, 'Source copy did not select the exact retained executed source.');
    await consoleUi.getByRole('button', { name: 'Cell 1', exact: true }).click();
    assert(await editor.inputValue() === retainedDraft, 'Copying retained source replaced the researcher\'s existing draft.');
    assert(kernelRequests.length === sourceCopyRequests, 'Copying executed source sent a scientific request.');
    check('Copying exact retained source creates a separate editable R cell, preserves the existing draft, and sends no request.');
    await consoleUi.getByLabel('Existing R binding', { exact: true }).fill('private_value');
    await consoleUi.getByLabel('Saved output name', { exact: true }).fill('Unsubmitted private value');
    assert(await consoleUi.getByRole('button', { name: 'Save object', exact: true }).isEnabled(),
      'The valid unsent output form was not usable before disconnect.');
    const unavailableReads = kernelRequests.length;
    await context.setOffline(true);
    try {
      await consoleUi.getByRole('button', { name: 'Refresh session status', exact: true }).click();
      await consoleUi.getByText('Session inspection is unconfirmed. Previous results remain visible; inspect status before running or saving.', { exact: true }).waitFor();
      assert(!await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(),
        'An unavailable status inspection left R execution enabled.');
      assert(!await consoleUi.getByRole('button', { name: 'Save object', exact: true }).isEnabled(),
        'An unavailable status inspection left object serialization enabled.');
      assert(await editor.inputValue() === retainedDraft, 'A temporary outage erased edited R source.');
      await output.getByRole('cell', { name: 'a', exact: true }).waitFor();
      await consoleUi.getByText('Session inspection is unconfirmed. Previous results remain visible; inspect status before running or saving.', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(directory, 'unavailable-session-retains-draft-output.png') });
      await editor.screenshot({ path: path.join(directory, 'unavailable-retained-edited-source.png') });
      await output.screenshot({ path: path.join(directory, 'unavailable-retained-command-output.png') });
    } finally { await context.setOffline(false); }
    await consoleUi.getByRole('button', { name: 'Refresh session status', exact: true }).click();
    await waitFor(() => consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(),
      'The same surviving session did not become usable after fresh online inspection.');
    assert(await editor.inputValue() === retainedDraft, 'Reconnect inspection replaced edited R source.');
    assertReadOnly(unavailableReads, 'Unavailable and recovered exact-session inspection');
    const survived = (await database.query('SELECT runtime_generation,next_order FROM private_r_kernels WHERE id=$1', [originalKernel.id])).rows[0];
    assert(survived.runtime_generation === originalKernel.runtime_generation && Number(survived.next_order) === 2,
      'Outage recovery changed the generation or ran the unexecuted local draft.');
    check('A genuine browser transport outage gates R and saves, retains prior output and edited cells, and recovers the same generation through explicit GET inspection.');
    await run('cat(private_value)', 3);
    assert((await output.getByLabel('R stdout').innerText()).includes('41'), 'Reload silently restarted the kernel.');
    check('Reload reconnects to the existing generation without rerunning earlier commands.');
    await editor.fill('cat(private_value);\nstop("unselected source must not execute")');
    await editor.press('Control+Home'); await editor.press('Control+Shift+ArrowDown');
    await consoleUi.getByRole('button', { name: 'Run selected R', exact: true }).click();
    await output.getByText('Command 4 · completed', { exact: true }).waitFor({ timeout: 125_000 });
    assert((await output.getByLabel('R stdout').innerText()).includes('41'), 'The selected R source did not run.');
    check('Editor selection executes and retains only the selected R source.');
    await run('warning("Review this R warning"); cat(private_value)', 5);
    assert((await output.getByLabel('R warnings').innerText()).includes('Review this R warning'),
      'The actual R warning was not displayed.');
    assert(await readableContrast(output.getByLabel('R warnings')) >= 4.5, 'The actual dark-mode R warning has insufficient text contrast.');
    await editor.fill('stop("Review this R error")');
    await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
    await output.getByText('Command 6 · failed', { exact: true }).waitFor({ timeout: 125_000 });
    assert((await output.getByRole('alert').innerText()).includes('Review this R error'), 'The actual R error was not displayed.');
    assert(await readableContrast(output.getByRole('alert')) >= 4.5, 'The actual dark-mode R error has insufficient text contrast.');
    await run('cat(private_value)', 7);
    assert((await output.getByLabel('R stdout').innerText()).includes('41'), 'An R error erased earlier private variables.');
    check('Actionable R warnings and errors render in the console while earlier variables remain usable.');
    const journal = (await database.query('SELECT * FROM private_r_executions ORDER BY execution_order')).rows;
    assert(journal.length === 7 && journal[3].source_code.trim() === 'cat(private_value);'
      && journal.every((row, index) => Number(row.execution_order) === index + 1
      && row.status === (index === 5 ? 'failed' : 'completed') && row.kernel_generation === journal[0].kernel_generation
      && crypto.createHash('sha256').update(row.source_code).digest('hex') === row.source_sha256),
    'The durable private command journal lost exact source, order, or generation.');
    let immutable = false;
    try { await database.query("UPDATE private_r_executions SET source_code='changed' WHERE id=$1", [journal[0].id]); }
    catch (error) { immutable = error.code === '55000'; }
    assert(immutable, 'Postgres allowed retained private command source to be rewritten.');
    check('Postgres retains immutable creator-private source hashes and ordered generation receipts.');
    const firstKernelId = journal[0].kernel_id;
    const commandPost = () => page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/executions'), { timeout: 125_000 });
    async function waitForRunning(kernelId) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const row = (await database.query("SELECT active_execution_id FROM private_r_kernels WHERE id=$1 AND status='running'", [kernelId])).rows[0];
        if (row?.active_execution_id) return row.active_execution_id;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('The genuine R command did not enter its reserved running state.');
    }
    await editor.fill('interrupt_mutation <- 1L; display_table(data.frame(partial=1L), name="Interrupted partial table"); plot(1:3); repeat { interrupt_mutation <- interrupt_mutation + 1L; Sys.sleep(0.1) }');
    const interruptedPost = commandPost();
    await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
    const interruptedId = await waitForRunning(firstKernelId);
    await new Promise(resolve => setTimeout(resolve, 750));
    await consoleUi.getByRole('button', { name: 'Interrupt R command', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, 'running-r-interrupt-controls.png') });
    assert(await consoleUi.getByRole('button', { name: 'Interrupt R command', exact: true }).isEnabled(), 'A pending R HTTP command blocked its independent interrupt control.');
    assert(await consoleUi.getByRole('button', { name: 'Refresh session status', exact: true }).isEnabled(), 'A pending R command blocked explicit status inspection.');
    const interruptPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/interrupt'), { timeout: 30_000 });
    await consoleUi.getByRole('button', { name: 'Interrupt R command', exact: true }).click();
    const interruptedResponse = await interruptPost; const interrupted = await interruptedResponse.json();
    assert(interruptedResponse.ok() && interrupted.idleConfirmed === true && interrupted.outcome === 'interrupted'
      && interrupted.session.id === firstKernelId && interrupted.session.generation === journal[0].kernel_generation
      && interrupted.execution.id === interruptedId && interrupted.execution.status === 'failed'
      && interrupted.execution.interrupted === true && interrupted.execution.result.error.code === 'PRIVATE_KERNEL_INTERRUPTED'
      && interrupted.execution.result.tables.length === 0 && interrupted.execution.result.figures.length === 0,
    'An actual interruption did not retain its exact generation receipt and confirm idle without publishing partial previews.');
    const originalInterruptedResponse = await interruptedPost;
    assert(originalInterruptedResponse.ok(), 'The original execution response did not reconcile its interrupted command.');
    await output.getByText('Command 8 · interrupted', { exact: true }).waitFor();
    assert(await output.getByRole('table').count() === 0 && await output.getByRole('img').count() === 0
      && await output.getByRole('button', { name: /^Save figure/ }).count() === 0,
    'Interrupted partial tables or figures were displayed or offered for publication.');
    await output.screenshot({ path: path.join(directory, 'confirmed-r-interruption.png') });
    await run('stopifnot(private_value==41L, exists("interrupt_mutation"), interrupt_mutation>=1L); cat("Earlier value:",private_value,"changed value:",interrupt_mutation)', 9);
    assert((await output.getByLabel('R stdout').innerText()).includes('Earlier value: 41 changed value:'), 'A confirmed interrupt erased prior private memory or failed to make the next command usable.');
    check('An independent UI interrupt stops a genuine long R loop, confirms idle, retains the exact interrupted source receipt, drops partial tables/PNG, and keeps earlier and already-mutated variables usable.');
    await editor.fill('restart_volatile <- 77L; repeat { Sys.sleep(0.1) }');
    const discardedPost = commandPost();
    await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
    await waitForRunning(firstKernelId);
    await consoleUi.getByRole('button', { name: 'Restart session', exact: true }).click();
    await consoleUi.getByText(/Restart discards unsaved variables and files, reloads the original selected input versions/).waitFor();
    const restartPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/restart'), { timeout: 125_000 });
    await consoleUi.getByRole('button', { name: 'Restart and discard unsaved memory', exact: true }).click();
    const restartResponse = await restartPost; const restarted = await restartResponse.json();
    assert(restartResponse.ok() && restarted.status === 'completed' && restarted.previousKernelId === firstKernelId
      && restarted.session.id !== firstKernelId && restarted.session.generation !== journal[0].kernel_generation
      && restarted.session.restartedFromKernelId === firstKernelId && restarted.session.status === 'ready',
    'Explicit restart did not create a linked independent ready generation.');
    await discardedPost;
    await consoleUi.getByText(/Restart created a fresh session from the original selected input versions/).waitFor();
    await run('stopifnot(!exists("private_value"), !exists("interrupt_mutation"), !exists("restart_volatile")); cat("Fresh restart has no discarded globals")', 1);
    const restartOldRows = (await database.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 ORDER BY execution_order', [firstKernelId])).rows;
    assert(restartOldRows.length === 10 && restartOldRows[7].result_json.interrupted === true
      && restartOldRows[7].source_sha256 === crypto.createHash('sha256').update(restartOldRows[7].source_code).digest('hex'),
    'Restart rewrote or replayed the earlier interrupted journal.');
    await consoleUi.getByRole('button', { name: 'Inspect previous session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Previous command 8 · interrupted', exact: true }).click();
    await output.getByText('Command 8 · interrupted', { exact: true }).waitFor();
    await consoleUi.getByRole('region', { name: 'Previous R session evidence', exact: true }).screenshot({ path: path.join(directory, 'restarted-r-journal-evidence.png') });
    await page.reload();
    await page.getByRole('button', { name: /^Advanced analysis,/ }).click();
    await page.getByRole('button', { name: 'Interactive console', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor();
    await run('stopifnot(!exists("private_value")); cat("Reload retained fresh generation")', 2);
    const freshRows = (await database.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 ORDER BY execution_order', [restarted.session.id])).rows;
    assert(freshRows.length === 2 && freshRows.every(row => row.kernel_generation === restarted.session.generation), 'Reload replayed old cells or changed the replacement generation.');
    check('Explicit restart during a long R command discards old globals, creates a linked fresh generation, retains the old journal for inspection, and reloads without replaying earlier cells.');
    // These tiny commands use the genuine R bridge and durable source journal.
    // Preserve the earlier ten-command acceptance assumptions in the previous
    // generation and exercise pagination only in this disposable fresh kernel.
    for (let order = 3; order <= 32; order += 1) {
      await run('stopifnot(!exists("private_value")); cat("Journal pagination command ' + order + '")', order);
    }
    const paginatedRows = (await database.query('SELECT id,execution_order,kernel_generation,source_code FROM private_r_executions WHERE kernel_id=$1 ORDER BY execution_order', [restarted.session.id])).rows;
    assert(paginatedRows.length === 32 && paginatedRows.every((row, index) => Number(row.execution_order) === index + 1
      && row.kernel_generation === restarted.session.generation), 'The pagination fixture lost real command order or generation.');
    const journalUi = consoleUi.getByLabel('R command journal');
    await waitFor(async () => await journalUi.getByRole('button', { name: /^Command \d+ · completed$/ }).count() === 30,
      'The latest private command journal was not bounded to 30 entries.');
    assert(await journalUi.getByRole('button', { name: 'Command 1 · completed', exact: true }).count() === 0,
      'Latest journal inspection silently loaded every retained command.');
    const olderReads = kernelRequests.length;
    await journalUi.getByRole('button', { name: 'Load older R commands', exact: true }).click();
    await journalUi.getByRole('button', { name: 'Command 1 · completed', exact: true }).waitFor();
    assert(await journalUi.getByRole('button', { name: /^Command \d+ · completed$/ }).count() === 32,
      'Older journal pagination lost entries or created duplicates.');
    await journalUi.getByRole('button', { name: 'Command 1 · completed', exact: true }).click();
    await output.getByText('Command 1 · completed', { exact: true }).waitFor();
    assert((await output.getByLabel('R stdout').innerText()).includes('Fresh restart has no discarded globals'),
      'An older journal item did not retrieve its exact retained output.');
    assertReadOnly(olderReads, 'Bounded older-journal page and exact first-command detail');
    await journalUi.screenshot({ path: path.join(directory, 'older-private-command-page.png') });
    await output.screenshot({ path: path.join(directory, 'older-exact-command-output.png') });
    check('Thirty-two real R commands retain one generation and exact order; latest inspection loads thirty entries and explicit GET pagination opens the original command without replay.');
    const expiryReads = kernelRequests.length;
    // Move only this owned fixture's authoritative expiry into the past. The
    // production GET then runs its real broker stop path and removes the actual
    // isolated kernel; no receipt or kernel status is fabricated by the harness.
    const expired = await database.query("UPDATE private_r_kernels SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1 AND runtime_generation=$2 AND status='ready' RETURNING id",
      [restarted.session.id, restarted.session.generation]);
    assert(expired.rowCount === 1, 'The exact disposable ready kernel could not be expired.');
    await consoleUi.getByRole('button', { name: 'Refresh session status', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    assert(!await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(),
      'An authoritatively expired kernel still allowed R execution.');
    await consoleUi.getByText('This session no longer has unsaved memory. Earlier journal source and saved versions remain available. Start a new session explicitly; earlier commands will not run automatically.', { exact: true }).waitFor();
    await output.getByText('Command 1 · completed', { exact: true }).waitFor();
    const endedKernel = (await database.query('SELECT id,runtime_generation,status,next_order FROM private_r_kernels WHERE id=$1', [restarted.session.id])).rows[0];
    const endedCount = Number((await database.query('SELECT COUNT(*) AS count FROM private_r_executions WHERE kernel_id=$1', [restarted.session.id])).rows[0].count);
    assert(endedKernel.status === 'stopped' && endedKernel.runtime_generation === restarted.session.generation
      && Number(endedKernel.next_order) === 32 && endedCount === 32,
      'Expiry inspection changed the exact generation, replayed retained source, or did not confirm stopped memory.');
    assertReadOnly(expiryReads, 'Authoritative exact-kernel expiry and retained selected source/output');
    await consoleUi.getByLabel('R session identity').screenshot({ path: path.join(directory, 'expired-exact-kernel-retained-evidence.png') });
    await output.screenshot({ path: path.join(directory, 'expired-selected-command-evidence.png') });
    check('Authoritative expiry inspection stops the genuine owned kernel, gates execution, preserves exact selected journal evidence, and requires explicit creation of another session.');
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125_000 });
    await run('cat(exists("private_value"))', 1);
    assert((await output.getByLabel('R stdout').innerText()).includes('FALSE'), 'A new generation inherited discarded memory.');
    check('Explicit stop discards unsaved memory; a new session receives an independent generation.');
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    await consoleUi.getByLabel('Initial saved analysis', { exact: true }).selectOption(selectedAnalysis.analysisId);
    await consoleUi.getByRole('checkbox', { name: 'Use cell-metadata.csv', exact: true }).check();
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125_000 });
    await run(`stopifnot(inherits(obj, "Seurat"), ncol(obj)==12L, nrow(obj)==20L)
selected_metadata <- read_input("cell-metadata.csv")
stopifnot(identical(as.character(selected_metadata$cell), colnames(obj)))
obj$condition <- selected_metadata$condition
display_table(data.frame(cells=ncol(obj), features=nrow(obj), conditions=length(unique(obj$condition))), name="Loaded saved analysis")
cat("Loaded cells:", ncol(obj), "features:", nrow(obj))`, 1);
    assert((await output.getByLabel('R stdout').innerText()).includes('Loaded cells: 12 features: 20'),
      'The saved Seurat checkpoint or its exact CSV input was not loaded into the private kernel.');
    await output.getByRole('columnheader', { name: 'cells', exact: true }).waitFor();
    await output.getByRole('cell', { name: '12', exact: true }).waitFor();
    await output.screenshot({ path: path.join(directory, 'saved-analysis-cell-counts.png') });
    await run('control_obj <- subset(obj, cells=colnames(obj)[obj$condition=="control"]); condition_counts <- as.data.frame(table(obj$condition)); names(condition_counts) <- c("condition","cells"); display_table(condition_counts, name="Selected conditions"); barplot(table(obj$condition), main="Saved analysis conditions")', 2);
    await output.getByRole('cell', { name: 'control', exact: true }).waitFor();
    await output.getByRole('cell', { name: 'treated', exact: true }).waitFor();
    const savedFigure = output.getByRole('img', { name: 'R figure 1', exact: true });
    await savedFigure.waitFor();
    await savedFigure.screenshot({ path: path.join(directory, 'saved-analysis-r-figure.png') });
    await consoleUi.getByText('Session reproducibility details', { exact: true }).click();
    const identity = consoleUi.getByLabel('R session identity');
    assert((await identity.innerText()).includes(selectedAnalysis.checkpointSha256)
      && (await identity.innerText()).includes(selectedAnalysis.tableSha256), 'The console identity omitted its exact selected input hashes.');
    await identity.screenshot({ path: path.join(directory, 'saved-analysis-r-inputs.png') });
    const savedKernel = (await database.query('SELECT * FROM private_r_kernels WHERE analysis_object_id=$1 ORDER BY created_at DESC LIMIT 1', [selectedAnalysis.analysisId])).rows[0];
    assert(savedKernel?.status === 'ready' && savedKernel.inputs_json.length === 2
      && savedKernel.inputs_json.some(input => input.role === 'checkpoint' && input.versionId === selectedAnalysis.checkpointId && input.checksumSha256 === selectedAnalysis.checkpointSha256)
      && savedKernel.inputs_json.some(input => input.role === 'input' && input.versionId === selectedAnalysis.versionId && input.checksumSha256 === selectedAnalysis.tableSha256),
    'The retained session did not pin the selected checkpoint and CSV artifact versions.');
    const savedCommands = (await database.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 ORDER BY execution_order', [savedKernel.id])).rows;
    assert(savedCommands.length === 2 && savedCommands.every(row => row.status === 'completed' && row.kernel_generation === savedKernel.runtime_generation),
      'The saved-analysis inspection did not retain its exact generation and source order.');
    check('Selecting a saved Seurat analysis and verified CSV loads obj, counts real cells, and retains exact input versions across R cells.');
    async function saveOutput({ type, binding, name, previousVersionId } = {}) {
      await consoleUi.getByLabel('R output type', { exact: true }).selectOption(type);
      if (binding !== undefined) await consoleUi.getByLabel('Existing R binding', { exact: true }).fill(binding);
      await consoleUi.getByLabel('Saved output name', { exact: true }).fill(name);
      await consoleUi.getByLabel('Version to extend', { exact: true }).selectOption(previousVersionId || '');
      const pending = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/publications'), { timeout: 125_000 });
      await consoleUi.getByRole('button', { name: type === 'object' ? 'Save object' : type === 'table' ? 'Save table' : 'Save figure', exact: true }).click();
      const response = await pending; const value = await response.json();
      assert(response.ok() && value.publication?.status === 'completed' && value.version?.reference,
        'The explicit R output save did not complete with a durable artifact reference.');
      const preview = consoleUi.getByRole('region', { name: 'Saved R artifact preview', exact: true });
      await preview.getByRole('heading', { name: name + ' · v' + value.version.versionNumber, exact: true }).waitFor();
      await preview.getByText('Checksum verified for this saved version', { exact: true }).waitFor();
      assert(value.version.sha256 === value.version.reference.sha256, 'The publication reference differs from its artifact bytes.');
      return value;
    }
    await output.getByRole('button', { name: 'Save figure 1', exact: true }).click();
    const plot = await saveOutput({ type: 'figure', name: 'Condition plot' });
    assert(plot.publication.sourceExecutionId === savedCommands[1].id && plot.publication.order === 2
      && plot.publication.sourceSha256 === savedCommands[1].source_sha256,
    'Figure publication did not retain the exact completed execution.');
    const publishedFigure = consoleUi.getByRole('img', { name: 'Saved figure Condition plot', exact: true });
    await publishedFigure.evaluate(element => element.decode());
    assert(await publishedFigure.evaluate(element => element.naturalWidth > 0 && element.naturalHeight > 0), 'The saved PNG endpoint did not render its verified actual bytes.');
    await consoleUi.getByRole('region', { name: 'Saved R artifact preview', exact: true }).screenshot({ path: path.join(directory, 'published-checked-figure.png') });
    check('An explicit figure save preserves the exact completed command PNG and renders its authenticated checksum-verified saved preview.');
    const firstObject = await saveOutput({ type: 'object', binding: 'control_obj', name: 'Control cells' });
    const table = await saveOutput({ type: 'table', binding: 'condition_counts', name: 'Condition counts' });
    const tablePreview = consoleUi.getByRole('region', { name: 'Saved R artifact preview', exact: true });
    await tablePreview.getByRole('cell', { name: 'control', exact: true }).waitFor();
    await tablePreview.getByRole('cell', { name: 'treated', exact: true }).waitFor();
    await tablePreview.screenshot({ path: path.join(directory, 'published-checked-table.png') });
    assert(firstObject.publication.order === 3 && table.publication.order === 4, 'Object/table serialization was not recorded as distinct ordered commands.');
    const objectRow = (await database.query('SELECT * FROM managed_artifact_versions WHERE id=$1', [firstObject.version.versionId])).rows[0];
    const firstObjectPath = path.resolve(service.storageRoot, ...objectRow.storage_key.split('/'));
    assert(firstObjectPath.startsWith(path.resolve(service.storageRoot) + path.sep), 'Invalid owned saved object path.');
    const originalObjectBytes = fs.readFileSync(firstObjectPath);
    assert(crypto.createHash('sha256').update(originalObjectBytes).digest('hex') === firstObject.version.sha256,
      'The saved object checksum differs from its immutable physical bytes.');
    check('Selected genuine Seurat and data-frame bindings save as full RDS/CSV artifacts with new ordered serialization receipts and verified table preview.');
    await run('control_obj <- subset(control_obj, cells=colnames(control_obj)[seq_len(5L)]); cat("Revised cells:", ncol(control_obj))', 5);
    const revisedObject = await saveOutput({ type: 'object', binding: 'control_obj', name: 'Control cells', previousVersionId: firstObject.version.versionId });
    assert(revisedObject.version.artifactId === firstObject.version.artifactId
      && revisedObject.version.versionId !== firstObject.version.versionId
      && revisedObject.version.sha256 !== firstObject.version.sha256
      && revisedObject.version.previousVersionId === firstObject.version.versionId
      && revisedObject.version.versionNumber === 2 && revisedObject.publication.order === 6,
    'Saving the revised binding did not create an independent version of the same logical object.');
    assert(fs.readFileSync(firstObjectPath).equals(originalObjectBytes), 'Replacement modified the original immutable RDS bytes.');
    await consoleUi.getByRole('button', { name: 'Inspect Control cells · v1', exact: true }).click();
    await tablePreview.getByRole('heading', { name: 'Control cells · v1', exact: true }).waitFor();
    await tablePreview.getByText('Checksum verified for this saved version', { exact: true }).waitFor();
    await consoleUi.screenshot({ path: path.join(directory, 'published-immutable-object-versions.png') });
    check('Saving a revised Seurat binding retains the original RDS bytes and creates an inspectable second version with its own source/order/checksum.');
    const tableRow = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [table.version.versionId])).rows[0];
    const savedTablePath = path.resolve(service.storageRoot, ...tableRow.storage_key.split('/'));
    assert(savedTablePath.startsWith(path.resolve(service.storageRoot) + path.sep), 'Invalid owned saved table path.');
    const originalTableBytes = fs.readFileSync(savedTablePath);
    await run('condition_counts$cells <- condition_counts$cells - 1L; display_table(condition_counts, name="Revised condition counts")', 7);
    const revisedTable = await saveOutput({ type: 'table', binding: 'condition_counts', name: 'Condition counts', previousVersionId: table.version.versionId });
    assert(revisedTable.version.artifactId === table.version.artifactId && revisedTable.version.versionId !== table.version.versionId
      && revisedTable.version.previousVersionId === table.version.versionId && revisedTable.version.versionNumber === 2
      && revisedTable.version.format.id === 'org.ietf.csv' && revisedTable.publication.order === 8
      && fs.readFileSync(savedTablePath).equals(originalTableBytes), 'CSV replacement changed the original file or failed to preserve its logical identity and format.');
    await consoleUi.getByRole('button', { name: 'Inspect Condition counts · v1', exact: true }).click();
    await tablePreview.getByRole('heading', { name: 'Condition counts · v1', exact: true }).waitFor();
    await tablePreview.getByText('Checksum verified for this saved version', { exact: true }).waitFor();
    assert(await tablePreview.getByRole('cell', { name: '6', exact: true }).count() === 2, 'The original six-cell table did not remain inspectable after replacement.');
    await tablePreview.screenshot({ path: path.join(directory, 'published-immutable-table-original.png') });
    const evidenceCard = consoleUi.getByRole('region', { name: 'Saved R outputs', exact: true }).locator(':scope > div').first();
    await evidenceCard.getByText('Save details', { exact: true }).click();
    await evidenceCard.screenshot({ path: path.join(directory, 'published-source-input-environment-lineage.png') });
    check('CSV replacement preserves the original complete table, retains CSV format, and records independent version/source/input/environment evidence.');
    const published = [plot, firstObject, table, revisedObject, revisedTable];
    for (const value of published) {
      const row = (await database.query('SELECT * FROM managed_artifact_versions WHERE id=$1', [value.version.versionId])).rows[0];
      const lineage = value.publication.lineage;
      assert(row.source_publication_id === value.publication.id && row.checksum_sha256 === value.version.sha256
        && row.provenance_json.environment.manifestSha256 === savedKernel.environment_json.manifestSha256
        && lineage.environment.manifestSha256 === savedKernel.environment_json.manifestSha256
        && lineage.inputs.some(input => input.versionId === selectedAnalysis.checkpointId && input.checksumSha256 === selectedAnalysis.checkpointSha256)
        && lineage.inputs.some(input => input.versionId === selectedAnalysis.versionId && input.checksumSha256 === selectedAnalysis.tableSha256)
        && lineage.sourceVersions.some(source => source.id === savedCommands[0].id && source.sha256 === savedCommands[0].source_sha256)
        && lineage.replay.complete === false,
      'A saved output lost exact environment, selected inputs, retained source, or honest replay evidence.');
    }
    check('Actual PostgreSQL artifact publications retain source hashes, selected input versions, environment manifest, generation, and explicit incomplete replay evidence.');
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    await consoleUi.getByLabel('R command journal').getByRole('button', { name: 'Command 2 · completed', exact: true }).click();
    await output.getByRole('button', { name: 'Save figure 1', exact: true }).click();
    const stoppedPlot = await saveOutput({ type: 'figure', name: 'Retained condition plot' });
    assert(stoppedPlot.publication.sourceExecutionId === savedCommands[1].id
      && stoppedPlot.publication.order === 2 && stoppedPlot.version.sha256 === plot.version.sha256
      && stoppedPlot.publication.lineage.environment.manifestSha256 === savedKernel.environment_json.manifestSha256,
    'Saving a retained completed figure after stopping changed its exact source or PNG bytes.');
    published.push(stoppedPlot);
    check('A completed journal figure can be explicitly saved after its kernel stops, without running R or changing the exact retained PNG.');
    await consoleUi.getByRole('button', { name: 'Restart session', exact: true }).click();
    const savedRestartPost = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/restart'), { timeout: 125_000 });
    await consoleUi.getByRole('button', { name: 'Restart and discard unsaved memory', exact: true }).click();
    const savedRestartResponse = await savedRestartPost; const savedRestart = await savedRestartResponse.json();
    assert(savedRestartResponse.ok() && savedRestart.status === 'completed' && savedRestart.previousKernelId === savedKernel.id
      && savedRestart.session.id !== savedKernel.id && savedRestart.session.generation !== savedKernel.runtime_generation
      && savedRestart.session.environment.manifestSha256 === savedKernel.environment_json.manifestSha256
      && savedRestart.session.inputs.length === 2 && savedRestart.session.inputs.every(input => savedKernel.inputs_json.some(original =>
        original.versionId === input.versionId && original.checksumSha256 === input.checksumSha256 && original.role === input.role)),
    'Restart changed its originally pinned checkpoint, CSV, or environment instead of reloading exact original inputs.');
    await run(`stopifnot(inherits(obj,"Seurat"), ncol(obj)==12L, nrow(obj)==20L,
  !exists("control_obj"), !exists("condition_counts"), !exists("selected_metadata"))
original_metadata <- read_input(${JSON.stringify(selectedAnalysis.versionId)})
stopifnot(nrow(original_metadata)==12L)
cat("Original checkpoint restored:",ncol(obj),"cells; original input rows:",nrow(original_metadata))`, 1);
    assert((await output.getByLabel('R stdout').innerText()).includes('Original checkpoint restored: 12 cells; original input rows: 12'),
      'A fresh restart did not restore the original checkpoint and CSV without replaying old analysis cells.');
    await consoleUi.getByRole('button', { name: 'Inspect previous session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Inspect previous Condition counts · v1', exact: true }).click();
    await tablePreview.getByText('Checksum verified for this saved version', { exact: true }).waitFor();
    assert(await tablePreview.getByRole('cell', { name: '6', exact: true }).count() === 2, 'Restart changed the earlier immutable saved table.');
    await consoleUi.getByRole('button', { name: 'Inspect previous Control cells · v1', exact: true }).click();
    await tablePreview.getByText('Checksum verified for this saved version', { exact: true }).waitFor();
    await consoleUi.getByRole('button', { name: 'Inspect previous Condition plot · v1', exact: true }).click();
    await tablePreview.getByRole('img', { name: 'Saved figure Condition plot', exact: true }).evaluate(element => element.decode());
    await consoleUi.getByRole('region', { name: 'Previous R session evidence', exact: true }).screenshot({ path: path.join(directory, 'restarted-original-inputs-retained-outputs.png') });
    const preservedSavedRows = (await database.query('SELECT id,checksum_sha256 FROM managed_artifact_versions WHERE id=ANY($1::text[])', [published.map(value => value.version.versionId)])).rows;
    assert(preservedSavedRows.length === published.length && preservedSavedRows.every(row => published.some(value =>
      value.version.versionId === row.id && value.version.sha256 === row.checksum_sha256)), 'Restart erased or changed a saved RDS, CSV, or PNG version.');
    check('Restart reloads the original exact saved Seurat checkpoint and CSV environment, drops earlier analysis globals without replay, and preserves inspectable linked RDS/CSV/PNG artifacts.');
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    await consoleUi.getByLabel('Initial saved analysis', { exact: true }).selectOption('');
    await consoleUi.getByRole('checkbox', { name: 'Use cell-metadata.csv', exact: true }).uncheck();
    await consoleUi.getByRole('checkbox', { name: 'Use Control cells · v1', exact: true }).check();
    await consoleUi.getByRole('checkbox', { name: 'Use Condition counts · v1', exact: true }).check();
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125_000 });
    await run(`restored_obj <- read_input(${JSON.stringify(firstObject.version.versionId)})
restored_table <- read_input(${JSON.stringify(table.version.versionId)})
stopifnot(inherits(restored_obj, "Seurat"), ncol(restored_obj)==6L, nrow(restored_obj)==20L,
          identical(as.character(restored_table$condition), c("control","treated")), all(restored_table$cells==6L))
cat("Restored original cells:", ncol(restored_obj)); display_table(restored_table, name="Restored saved counts")`, 1);
    assert((await output.getByLabel('R stdout').innerText()).includes('Restored original cells: 6'), 'The original RDS version could not reopen after termination.');
    await output.getByRole('cell', { name: 'treated', exact: true }).waitFor();
    await output.screenshot({ path: path.join(directory, 'published-object-table-reopened.png') });
    check('After kernel termination an independent session reopens the original genuine Seurat RDS and exact saved CSV via selected immutable versions and read_input.');
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    await consoleUi.getByRole('checkbox', { name: 'Use Control cells · v1', exact: true }).uncheck();
    await consoleUi.getByRole('checkbox', { name: 'Use Control cells · v2', exact: true }).check();
    await consoleUi.getByRole('checkbox', { name: 'Use Condition counts · v1', exact: true }).uncheck();
    await consoleUi.getByRole('checkbox', { name: 'Use Condition counts · v2', exact: true }).check();
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125_000 });
    await run(`latest_obj <- read_input(${JSON.stringify(revisedObject.version.versionId)}); latest_table <- read_input(${JSON.stringify(revisedTable.version.versionId)}); stopifnot(inherits(latest_obj,"Seurat"),ncol(latest_obj)==5L,all(latest_table$cells==5L)); cat("Restored revised cells:",ncol(latest_obj)); display_table(latest_table,name="Restored revised counts")`, 1);
    assert((await output.getByLabel('R stdout').innerText()).includes('Restored revised cells: 5'), 'The revised RDS did not reopen its independent saved contents.');
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    await output.screenshot({ path: path.join(directory, 'published-revised-object-table-reopened.png') });
    check('A later independent session reopens both revised five-cell object/table versions while the first six-cell versions remain unchanged.');
    // Locator screenshots may temporarily resize the viewport, leaving the
    // responsive sidebar collapsed when its original width is restored.
    const expandSidebar = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expandSidebar.isVisible()) await expandSidebar.click();
    await page.getByRole('button', { name: /^Runs & Results(?:,|$)/ }).click();
    await page.getByText('Inspect or import artifact files', { exact: true }).click();
    const inspector = page.getByRole('region', { name: 'Artifact versions', exact: true });
    await inspector.getByRole('button', { name: /^Condition plot · v1/ }).click();
    await inspector.getByText('Saved checksum verified · preview from this exact version', { exact: true }).waitFor();
    const retainedFigure = inspector.getByRole('img', { name: 'Preview of Condition plot', exact: true });
    await retainedFigure.evaluate(element => element.decode());
    await inspector.screenshot({ path: path.join(directory, 'terminated-session-saved-figure.png') });
    check('The standard project artifact inspector reopens the saved exact PNG after its producing kernel is terminated.');
    const apiGet = async (target, endpoint) => target.evaluate(async url => {
      const response = await fetch(url, { credentials: 'include', headers: { 'X-Traceomics-Csrf': '1' } });
      return { status: response.status, value: await response.json() };
    }, endpoint);
    const apiPost = async (target, endpoint, input) => target.evaluate(async ({ url, body }) => {
      const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-Traceomics-Csrf': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, value: await response.json() };
    }, { url: endpoint, body: input });
    const owner = (await database.query('SELECT * FROM users WHERE email=$1', [service.account.email])).rows[0];
    const projectRow = (await database.query('SELECT * FROM projects WHERE id=$1', [service.project.id])).rows[0];
    const otherProjectId = 'proj_' + crypto.randomBytes(12).toString('hex');
    await database.query('INSERT INTO projects(id,organization_id,name,created_by_user_id) VALUES($1,$2,$3,$4)', [otherProjectId, projectRow.organization_id, 'Separate saved-output study', owner.id]);
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [otherProjectId, owner.id]);
    const wrongProject = await apiGet(page, '/api/artifact-versions/' + otherProjectId + '/' + revisedObject.version.versionId + '/preview');
    assert(wrongProject.status === 404, 'A saved private version was accessible through another project.');
    const wrongProjectRestart = await apiPost(page, '/api/private-r-kernels/' + otherProjectId + '/' + savedKernel.id + '/restart', { requestId: crypto.randomUUID(), generation: savedKernel.runtime_generation });
    assert(wrongProjectRestart.status === 404, 'A private restart could be targeted through another project.');
    const colleagueEmail = 'colleague-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
    // The disposable colleague receives the fixture's password hash and salt.
    // No production account or credential is modified or persisted in reports.
    const colleague = (await database.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id', [colleagueEmail, owner.password_hash, owner.salt, 'Separate project analyst'])).rows[0];
    await database.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [projectRow.organization_id, colleague.id]);
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'analyst')", [service.project.id, colleague.id]);
    const otherContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const otherPage = await otherContext.newPage(); await otherPage.goto(service.endpoint);
    await otherPage.getByPlaceholder('researcher@lab.edu').fill(colleagueEmail);
    await otherPage.getByLabel('Password', { exact: true }).fill(service.account.password);
    await otherPage.getByRole('button', { name: /Open Workbench/ }).click();
    await otherPage.getByRole('button', { name: /^Advanced analysis,/ }).waitFor();
    const privateVersion = await apiGet(otherPage, '/api/artifact-versions/' + service.project.id + '/' + revisedObject.version.versionId + '/preview');
    const privateJournal = await apiGet(otherPage, '/api/private-r-kernels/' + service.project.id + '/' + savedKernel.id + '/publications');
    const colleagueVersions = await apiGet(otherPage, '/api/artifact-versions/' + service.project.id);
    const privateInterrupt = await apiPost(otherPage, '/api/private-r-kernels/' + service.project.id + '/' + savedKernel.id + '/interrupt', { requestId: crypto.randomUUID(), generation: savedKernel.runtime_generation, executionId: savedCommands[0].id });
    const privateRestart = await apiPost(otherPage, '/api/private-r-kernels/' + service.project.id + '/' + savedKernel.id + '/restart', { requestId: crypto.randomUUID(), generation: savedKernel.runtime_generation });
    const privateRestartReceipt = await apiGet(otherPage, '/api/private-r-kernels/' + service.project.id + '/' + savedKernel.id + '/restart');
    assert(privateVersion.status === 404 && privateJournal.status === 404
      && privateInterrupt.status === 404 && privateRestart.status === 404 && privateRestartReceipt.status === 404
      && colleagueVersions.status === 200 && !colleagueVersions.value.items.some(item => published.some(value => value.version.versionId === item.versionId)),
    'Project analyst membership exposed another creator\'s private R outputs or publication history.');
    await otherContext.close();
    check('Actual authenticated APIs reject wrong-project versions and keep saved artifacts/publication history private from another authorized project analyst.');
    check('Another authorized project analyst cannot interrupt, restart, or read the creator-private restart receipt; wrong-project restart targets also fail.');
    try {
      fs.writeFileSync(savedTablePath, 'condition,cells\ncontrol,999\n');
      const changed = await apiGet(page, '/api/artifact-versions/' + service.project.id + '/' + table.version.versionId + '/preview');
      assert(changed.status === 409 && changed.value.code === 'ARTIFACT_INTEGRITY_FAILED', 'Changed publication bytes were accepted as a saved preview.');
      await inspector.getByRole('button', { name: /^Condition counts · v1/ }).click();
      await inspector.getByRole('alert').filter({ hasText: 'could not be verified against its saved version and checksum' }).waitFor();
      assert(await inspector.getByRole('table').count() === 0 && await inspector.getByRole('img').count() === 0, 'Tampered saved contents remained visible in the inspector.');
      await inspector.screenshot({ path: path.join(directory, 'published-tamper-rejected.png') });
    } finally { fs.writeFileSync(savedTablePath, originalTableBytes); }
    check('Changed saved CSV bytes fail the actual checksum API and disappear from the bounded inspector without affecting intact versions.');
    await inspector.getByRole('button', { name: /^Condition plot · v1/ }).click();
    await inspector.getByText('Saved checksum verified · preview from this exact version', { exact: true }).waitFor();
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, owner.id]);
    const revoked = await apiGet(page, '/api/artifact-versions/' + service.project.id + '/' + plot.version.versionId + '/preview');
    assert([403,404].includes(revoked.status), 'Revoked membership retained access to a saved output.');
    const revokedRestart = await apiGet(page, '/api/private-r-kernels/' + service.project.id + '/' + savedKernel.id + '/restart');
    assert([403,404].includes(revokedRestart.status), 'Revoked project membership retained private restart-receipt access.');
    await inspector.getByRole('button', { name: 'Refresh artifacts', exact: true }).click();
    await inspector.getByRole('alert').waitFor();
    assert(await inspector.getByRole('table').count() === 0 && await inspector.getByRole('img').count() === 0,
      'Revoked membership left a saved private preview visible.');
    check('Membership revocation denies actual saved-byte APIs and clears previous private preview content from the project UI.');
    assert(errors.length === 0, 'The production browser raised an uncaught application error.');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks, browserErrors: errors,
      recoveryReads, privateKernelRequestCount: kernelRequests.length,
      publications: published.map(value => ({ publication: value.publication, reference: value.version.reference })) }, null, 2));
    console.log('Private R console acceptance passed; report: ' + directory);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close(); await database?.end();
    if (broker?.listening) await new Promise((resolve, reject) => broker.close(error => error ? reject(error) : resolve()));
    await service?.stop();
    const work = path.resolve(directory, 'broker-work');
    assert(work.startsWith(path.resolve(directory) + path.sep), 'Invalid disposable kernel work cleanup.');
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
