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
async function main() {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''),
    'Set EXPERT_R_SANDBOX_IMAGE to the reviewed immutable persistent-kernel image.');
  const directory = path.join(root, 'playwright', 'report', 'private-r-console-' + Date.now());
  fs.mkdirSync(directory, { recursive: true });
  const port = await freePort(), token = crypto.randomBytes(32).toString('hex');
  let service, broker, browser, page, database;
  const errors = [], checks = [];
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
    await page.goto(service.endpoint);
    await page.getByPlaceholder('researcher@lab.edu').fill(service.account.email);
    await page.getByLabel('Password', { exact: true }).fill(service.account.password);
    await page.getByRole('button', { name: /Open Workbench/ }).click();
    await page.getByRole('button', { name: /^Advanced analysis,/ }).click();
    const darkMode = page.getByRole('button', { name: 'Switch to dark mode', exact: true });
    if (await darkMode.isVisible()) await darkMode.click();
    const consoleUi = page.getByRole('region', { name: 'Private R console', exact: true });
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
    await consoleUi.screenshot({ path: path.join(directory, 'persistent-r-table-figure.png') });
    await figure.scrollIntoViewIfNeeded();
    await figure.screenshot({ path: path.join(directory, 'rendered-r-figure.png') });
    check('Free R cells preserve variables and render actual bounded tables and PNG plots.');
    await page.reload();
    await page.getByRole('button', { name: /^Advanced analysis,/ }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor();
    await run('cat(private_value)', 3);
    assert((await output.getByLabel('R stdout').innerText()).includes('41'), 'Reload silently restarted the kernel.');
    check('Reload reconnects to the existing generation without rerunning earlier commands.');
    const editor = consoleUi.getByLabel('R console source');
    await editor.fill('cat(private_value);\nstop("unselected source must not execute")');
    await editor.press('Control+Home'); await editor.press('Control+Shift+ArrowDown');
    await consoleUi.getByRole('button', { name: 'Run selected R', exact: true }).click();
    await output.getByText('Command 4 · completed', { exact: true }).waitFor({ timeout: 125_000 });
    assert((await output.getByLabel('R stdout').innerText()).includes('41'), 'The selected R source did not run.');
    check('Editor selection executes and retains only the selected R source.');
    await run('warning("Review this R warning"); cat(private_value)', 5);
    assert((await output.getByLabel('R warnings').innerText()).includes('Review this R warning'),
      'The actual R warning was not displayed.');
    await editor.fill('stop("Review this R error")');
    await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
    await output.getByText('Command 6 · failed', { exact: true }).waitFor({ timeout: 125_000 });
    assert((await output.getByRole('alert').innerText()).includes('Review this R error'), 'The actual R error was not displayed.');
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
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
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
    await run('display_table(as.data.frame(table(obj$condition)), name="Selected conditions"); barplot(table(obj$condition), main="Saved analysis conditions")', 2);
    await output.getByRole('cell', { name: 'control', exact: true }).waitFor();
    await output.getByRole('cell', { name: 'treated', exact: true }).waitFor();
    const savedFigure = output.getByRole('img', { name: 'R figure 1', exact: true });
    await savedFigure.waitFor();
    await savedFigure.screenshot({ path: path.join(directory, 'saved-analysis-r-figure.png') });
    await consoleUi.getByText('Session reproducibility details', { exact: true }).click();
    const identity = consoleUi.getByLabel('R session identity');
    assert((await identity.innerText()).includes(selectedAnalysis.checkpointSha256)
      && (await identity.innerText()).includes(selectedAnalysis.tableSha256), 'The console identity omitted its exact selected input hashes.');
    await consoleUi.screenshot({ path: path.join(directory, 'saved-analysis-r-inputs.png') });
    const savedKernel = (await database.query('SELECT * FROM private_r_kernels WHERE analysis_object_id=$1 ORDER BY created_at DESC LIMIT 1', [selectedAnalysis.analysisId])).rows[0];
    assert(savedKernel?.status === 'ready' && savedKernel.inputs_json.length === 2
      && savedKernel.inputs_json.some(input => input.role === 'checkpoint' && input.versionId === selectedAnalysis.checkpointId && input.checksumSha256 === selectedAnalysis.checkpointSha256)
      && savedKernel.inputs_json.some(input => input.role === 'input' && input.versionId === selectedAnalysis.versionId && input.checksumSha256 === selectedAnalysis.tableSha256),
    'The retained session did not pin the selected checkpoint and CSV artifact versions.');
    const savedCommands = (await database.query('SELECT * FROM private_r_executions WHERE kernel_id=$1 ORDER BY execution_order', [savedKernel.id])).rows;
    assert(savedCommands.length === 2 && savedCommands.every(row => row.status === 'completed' && row.kernel_generation === savedKernel.runtime_generation),
      'The saved-analysis inspection did not retain its exact generation and source order.');
    check('Selecting a saved Seurat analysis and verified CSV loads obj, counts real cells, and retains exact input versions across R cells.');
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    assert(errors.length === 0, 'The production browser raised an uncaught application error.');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks, browserErrors: errors }, null, 2));
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
