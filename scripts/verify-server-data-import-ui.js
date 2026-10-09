#!/usr/bin/env node
'use strict';

// Real server-resident files enter a private R session through selected SSH/HTTPS.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('pg');
const { runDesktopTunnelAcceptance } = require('./verify-desktop-tunnel-ui');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const execute = promisify(execFile);
const assert = (value, message) => { if (!value) throw new Error(message); };
const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function command(program, args, timeout = 90_000) {
  try { return await execute(program, args, { cwd: root, windowsHide: true, timeout, maxBuffer: 256 * 1024 }); }
  catch { throw new Error('A disposable server-data fixture command failed.'); }
}
async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function prepareStudy(directory, image) {
  fs.mkdirSync(directory, { recursive: true }); fs.chmodSync(directory, 0o777);
  try {
    await command('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', '10001:10001', '--pids-limit', '128',
      '--memory', '1g', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m',
      '--mount', 'type=bind,source=' + directory + ',target=/fixture', '--entrypoint', 'Rscript', image,
      '--vanilla', '-e', [
        'suppressPackageStartupMessages({library(Seurat);library(Matrix)})',
        'set.seed(1919)',
        'counts<-matrix(rpois(20L*12L,3),nrow=20L,ncol=12L)',
        'rownames(counts)<-paste0("Gene",seq_len(nrow(counts)))',
        'colnames(counts)<-paste0("Cell",seq_len(ncol(counts)))',
        'obj<-CreateSeuratObject(Matrix(counts,sparse=TRUE))',
        'obj$condition<-rep(c("control","treated"),each=6L)',
        'stopifnot(ncol(obj)==12L,nrow(obj)==20L)',
        'saveRDS(obj,"/fixture/input-seurat.rds")',
      ].join('\n')]);
  } finally { fs.chmodSync(directory, 0o755); }
  const csv = 'cell,condition\n' + Array.from({ length: 12 }, (_, index) =>
    'Cell' + (index + 1) + ',' + (index < 6 ? 'control' : 'treated')).join('\n') + '\n';
  fs.writeFileSync(path.join(directory, 'cell-metadata.csv'), csv);
  fs.writeFileSync(path.join(directory, 'uncertain-receipt.csv'), 'sample,cells\nstudy,12\n');
  return { object: fs.readFileSync(path.join(directory, 'input-seurat.rds')), table: Buffer.from(csv) };
}

async function main() {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''),
    'Set EXPERT_R_SANDBOX_IMAGE to the reviewed immutable R image.');
  const output = path.join(root, 'playwright', 'report', 'server-data-import-' + Date.now());
  fs.mkdirSync(output, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-server-data-'));
  const dataRoot = path.join(temporary, 'shared-study');
  const otherRoot = path.join(temporary, 'separate-study');
  const study = path.join(dataRoot, 'study');
  let source, service, broker, database, owner, colleague, capability, project, compiledAsset;
  const brokerPort = await freePort(), token = crypto.randomBytes(32).toString('hex');
  let brokerClosed = false;
  const checks = [], errors = [], requests = [], responses = [];
  const check = message => { checks.push(message); process.stdout.write('PASS: ' + message + '\n'); };
  async function stopCompute() {
    if (database) { await database.end(); database = null; }
    if (broker?.listening && !brokerClosed) {
      brokerClosed = true;
      await new Promise((resolve, reject) => broker.close(error => error ? reject(error) : resolve()));
    }
  }
  try {
    source = await prepareStudy(study, image);
    fs.mkdirSync(otherRoot); fs.writeFileSync(path.join(otherRoot, 'private.csv'), 'hidden,value\nsample,7\n');
    fs.symlinkSync(otherRoot, path.join(dataRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await runDesktopTunnelAcceptance({ artifactDirectory: output,
      serviceFactory: async ({ artifactDirectory }) => {
        service = await createDesktopTunnelServiceFixture({ artifactDirectory,
          webEnvironment: { EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles',
            EXPERT_R_SANDBOX_URL: 'http://127.0.0.1:' + brokerPort, EXPERT_R_SANDBOX_TOKEN: token,
            EXECUTION_SERVICE_LABEL: 'Server data fixture' },
          configureProjectEnvironment: async ({ env, project: seededProject, account }) => {
            project = seededProject;
            database = new Client({ connectionString: env.DATABASE_URL });
            database.on('error', () => {});
            await database.connect();
            owner = (await database.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0];
            const organizationId = (await database.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0].organization_id;
            colleague = (await database.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING *',
              ['server-data-colleague-' + crypto.randomBytes(8).toString('hex') + '@example.invalid',
                owner.password_hash, owner.salt, 'Separate project analyst'])).rows[0];
            await database.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, colleague.id]);
            await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'analyst')", [project.id, colleague.id]);
            await database.end(); database = null;
            return { SERVER_DATA_IMPORT_ROOTS: JSON.stringify([
              { id: 'shared', label: 'Shared study data', path: dataRoot, grants: [{ projectId: project.id, ownerUserId: Number(owner.id) }] },
              { id: 'separate', label: 'Separate study data', path: otherRoot, grants: [{ projectId: project.id, ownerUserId: Number(colleague.id) }] },
            ]) };
          } });
        database = new Client({ connectionString: service.databaseUrl });
        database.on('error', () => {});
        await database.connect();
        process.env.STORAGE_ROOT = service.storageRoot;
        broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker({ ...process.env,
          NODE_ENV: 'test', EXPERT_R_SANDBOX_IMAGE: image, EXPERT_R_SANDBOX_TOKEN: token,
          EXPERT_R_SANDBOX_WORK_ROOT: path.join(output, 'broker-work'), PRIVATE_R_KERNEL_ENABLED: 'true',
          PRIVATE_R_KERNEL_IDLE_SECONDS: '300', EXPERT_R_MEMORY_LIMIT: '2g', EXPERT_R_CPU_LIMIT: '1' });
        await broker.startReconciliation();
        await new Promise(resolve => broker.listen(brokerPort, '127.0.0.1', resolve));
        capability = await fetch('http://127.0.0.1:' + brokerPort + '/capabilities',
          { headers: { Authorization: 'Bearer ' + token } }).then(response => response.json());
        assert(capability.persistentKernel && capability.environment, 'The pinned image did not verify private kernel support.');
        const stopService = service.stop;
        service.stop = async () => { await stopCompute(); await stopService(); };
        return service;
      },
      exerciseWorkspace,
    });
    assert(errors.length === 0, 'The compiled server-data workspace raised a browser error.');
    fs.writeFileSync(path.join(output, 'server-data-report.json'), JSON.stringify({
      ok: true, checks, browserErrors: errors, compiledAsset, environment: capability.environment,
      sourceObjectSha256: checksum(source.object), sourceTableSha256: checksum(source.table),
      largestApiResponseBytes: Math.max(0, ...responses.map(value => value.bytes)), requests,
    }, null, 2));
    return { ok: true, checks: checks.length, artifactDirectory: output };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'server-data-report.json'), JSON.stringify({ ok: false, checks, error: error.message }, null, 2));
    throw error;
  } finally {
    await stopCompute(); await service?.stop();
    assert(path.dirname(path.resolve(temporary)) === path.resolve(os.tmpdir())
      && path.basename(temporary).startsWith('traceomics-server-data-'), 'Unsafe disposable source cleanup target.');
    await fs.promises.rm(temporary, { recursive: true, force: true });
    const work = path.resolve(output, 'broker-work');
    assert(work.startsWith(path.resolve(output) + path.sep), 'Unsafe disposable broker cleanup target.');
    await fs.promises.rm(work, { recursive: true, force: true });
  }

  async function exerciseWorkspace({ workspace }) {
    compiledAsset = await workspace.evaluate(() => [...document.scripts].map(script => script.src).find(value => /\/assets\/index-/.test(value)));
    workspace.on('pageerror', error => errors.push(error.message));
    workspace.on('request', request => {
      const address = new URL(request.url());
      if (address.pathname.startsWith('/api/')) requests.push({
        method: request.method(), path: address.pathname, origin: address.origin,
        postBytes: request.postDataBuffer()?.length || 0,
      });
    });
    workspace.on('response', async response => {
      if (!new URL(response.url()).pathname.startsWith('/api/')) return;
      try {
        const body = await response.body();
        responses.push({ bytes: body.length, containsObject: body.includes(source.object),
          contentType: response.headers()['content-type'] || '' });
      } catch { /* Native transport checks deliberately close responses. */ }
    });
    const api = (url, body) => workspace.evaluate(async ({ url, body }) => {
      const response = await fetch(url, { credentials: 'include',
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        headers: { 'X-Traceomics-Csrf': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) } });
      return { status: response.status, value: await response.json() };
    }, { url, body });
    const base = '/api/server-data/' + project.id;
    await workspace.getByRole('button', { name: /^Runs & Results(?:,|$)/ }).click();
    await workspace.getByText('Inspect or import artifact files', { exact: true }).click();
    const artifacts = workspace.getByRole('region', { name: 'Artifact versions', exact: true });
    const importer = artifacts.getByRole('region', { name: 'Import server data', exact: true });
    await importer.getByRole('button', { name: 'Browse server data', exact: true }).click();
    await importer.getByLabel('Authorized data root', { exact: true }).waitFor();
    assert(await importer.getByLabel('Authorized data root').locator('option').count() === 1,
      'The native server-data UI exposed a data root without an explicit owner grant.');
    assert(await importer.getByRole('button', { name: 'Open folder escape', exact: true }).count() === 0,
      'The server browser exposed a symlink/junction directory.');
    await importer.getByRole('button', { name: 'Open folder study', exact: true }).click();
    await importer.getByRole('button', { name: 'Select server file input-seurat.rds', exact: true }).waitFor();
    const listed = await api(base + '/roots/shared/files?path=study&limit=50');
    assert(listed.status === 200 && listed.value.items.length === 3, 'The authorized bounded folder listing is incomplete.');
    assert(!JSON.stringify(listed.value).includes(temporary) && !JSON.stringify(listed.value).includes(service.storageRoot),
      'The public server-data listing exposes an absolute filesystem path.');
    const layout = await workspace.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(layout.scrollWidth <= layout.width, 'The actual native server-data browser has horizontal page overflow.');
    await importer.screenshot({ path: path.join(output, 'ssh-authorized-server-data-browser.png') });
    check('The actual native SSH UI browses only its explicitly granted data root and omits symlink/junction folders and absolute server paths.');
    for (const url of [
      base + '/roots/separate/files?path=',
      base + '/roots/shared/files?path=' + encodeURIComponent('../separate-study'),
      base + '/roots/shared/files?path=' + encodeURIComponent(dataRoot),
      base + '/roots/shared/files?path=escape',
    ]) {
      const denied = await api(url);
      assert(denied.status >= 400 && !JSON.stringify(denied.value).includes(temporary),
        'A forbidden root, absolute path, traversal or junction remained readable.');
    }
    const escaped = await api(base + '/imports', { requestId: crypto.randomUUID(), rootId: 'shared',
      relativePath: 'escape/private.csv', selectionToken: '0'.repeat(64), artifactType: 'auto' });
    assert(escaped.status >= 400, 'A forced symlink/junction import was admitted.');
    check('Authenticated production API rejects unauthorized roots, absolute paths, traversal and forced junction imports through the selected SSH authority.');

    async function importFile(filename, name) {
      await importer.getByRole('button', { name: 'Select server file ' + filename, exact: true }).click();
      await importer.getByLabel('Server artifact name', { exact: true }).fill(name);
      if (filename === 'cell-metadata.csv') {
        await importer.locator('summary').filter({ hasText: 'Sample details (optional)' }).click();
        await importer.getByLabel('Server sample sample id', { exact: true }).fill('ssh-study');
        await importer.getByLabel('Server sample condition', { exact: true }).fill('control + treated');
        await importer.getByLabel('Server sample tissue', { exact: true }).fill('blood');
        await importer.getByLabel('Server sample species', { exact: true }).fill('human');
      }
      await importer.getByRole('button', { name: 'Import selected server file', exact: true }).click();
      await importer.getByText('Server file saved as an immutable artifact version.', { exact: true }).waitFor({ timeout: 125_000 });
      const row = (await database.query('SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2 AND name=$3',
        [project.id, owner.id, name])).rows[0];
      assert(row, 'The UI import did not persist its private managed artifact.');
      await artifacts.getByText(row.checksum_sha256, { exact: true }).waitFor();
      return row;
    }
    const savedObject = await importFile('input-seurat.rds', 'Server Seurat snapshot');
    assert(savedObject.checksum_sha256 === checksum(source.object) && Number(savedObject.size_bytes) === source.object.length,
      'The imported RDS receipt does not match exact original bytes.');
    const savedObjectFile = path.join(service.storageRoot, ...savedObject.storage_key.split('/'));
    assert(fs.readFileSync(savedObjectFile).equals(source.object), 'The immutable RDS snapshot differs from its source.');
    await workspace.screenshot({ path: path.join(output, 'ssh-server-rds-snapshot.png') });
    const savedTable = await importFile('cell-metadata.csv', 'Server condition metadata');
    assert(savedTable.checksum_sha256 === checksum(source.table) && Number(savedTable.size_bytes) === source.table.length,
      'The imported CSV receipt does not match exact original bytes.');
    const savedTableFile = path.join(service.storageRoot, ...savedTable.storage_key.split('/'));
    assert(fs.readFileSync(savedTableFile).equals(source.table), 'The immutable CSV snapshot differs from its source.');
    await artifacts.getByRole('cell', { name: 'Cell12', exact: true }).waitFor();
    await artifacts.getByText('Saved checksum verified · preview from this exact version', { exact: true }).waitFor();
    const metadataVersion = await api('/api/artifact-versions/' + project.id + '/' + savedTable.id);
    assert(metadataVersion.value.sourceImport?.sampleMetadata?.sampleId === 'ssh-study'
      && metadataVersion.value.sourceImport?.sampleMetadata?.condition === 'control + treated',
    'The saved snapshot lost its optional sample and condition annotations.');
    await artifacts.locator('summary').filter({ hasText: 'Server source and sample details' }).click();
    await artifacts.getByText('ssh-study', { exact: true }).waitFor();
    await artifacts.getByText('Server data fixture', { exact: true }).waitFor();
    assert(/^svc_[a-f0-9]{32}$/.test(metadataVersion.value.sourceImport?.serviceId)
      && metadataVersion.value.sourceImport?.serviceLabel === 'Server data fixture',
    'The imported artifact lacks the retained server installation identity.');
    await workspace.screenshot({ path: path.join(output, 'ssh-server-csv-snapshot-preview.png') });
    check('Real server Seurat RDS and CSV files become private immutable managed versions with exact physical bytes, SHA-256 and bounded inspector previews.');

    await importer.getByRole('button', { name: 'Select server file uncertain-receipt.csv', exact: true }).click();
    await importer.getByLabel('Server artifact name', { exact: true }).fill('Recovered server snapshot');
    const admissionCount = requests.filter(value => value.method === 'POST' && value.path === base + '/imports').length;
    await workspace.evaluate(importPath => {
      // Discard one genuine admission receipt, leaving actual server I/O untouched.
      const original = Response.prototype.json;
      Response.prototype.json = function (...args) {
        if (new URL(this.url).pathname === importPath) {
          Response.prototype.json = original;
          return Promise.reject(new SyntaxError('Disposable unreadable admission receipt.'));
        }
        return original.apply(this, args);
      };
    }, base + '/imports');
    await importer.getByRole('button', { name: 'Import selected server file', exact: true }).click();
    await importer.getByRole('alert').filter({ hasText: 'Import completion is unconfirmed.' }).waitFor();
    assert(await importer.getByRole('button', { name: 'Import selected server file', exact: true }).isDisabled(),
      'The unreadable receipt enabled another import before status lookup.');
    await importer.getByRole('button', { name: 'Check server import status', exact: true }).click();
    await importer.getByText('Server file saved as an immutable artifact version.', { exact: true }).waitFor({ timeout: 125_000 });
    const recovered = (await database.query('SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2 AND name=$3',
      [project.id, owner.id, 'Recovered server snapshot'])).rows;
    assert(recovered.length === 1
      && requests.filter(value => value.method === 'POST' && value.path === base + '/imports').length === admissionCount + 1,
    'Receipt recovery created or submitted another source snapshot.');
    await workspace.screenshot({ path: path.join(output, 'ssh-unreadable-import-receipt-recovered.png') });
    check('Discarding one real admission receipt leaves completion unconfirmed; explicit compiled-UI status lookup recovers the original saved snapshot without another POST or version.');

    fs.writeFileSync(path.join(study, 'input-seurat.rds'), 'Original research file was replaced after snapshot.\n');
    fs.writeFileSync(path.join(study, 'cell-metadata.csv'), 'cell,condition\nchanged,replaced\n');
    assert(fs.readFileSync(savedObjectFile).equals(source.object) && fs.readFileSync(savedTableFile).equals(source.table),
      'Changing source files changed an already admitted artifact snapshot.');
    const stale = listed.value.items.find(value => value.name === 'cell-metadata.csv');
    const staleAdmission = await api(base + '/imports', { requestId: crypto.randomUUID(), rootId: 'shared',
      relativePath: stale.relativePath, selectionToken: stale.selectionToken, name: 'Stale source denied', artifactType: 'auto' });
    assert(staleAdmission.status === 409, 'A source mutation was not rejected before another snapshot was admitted.');
    check('Later source replacement leaves both saved versions unchanged and invalidates the previously listed source selection before a new import.');

    await workspace.getByRole('button', { name: /^Advanced analysis,/ }).click();
    await workspace.getByRole('button', { name: 'Interactive console', exact: true }).click();
    const consoleUi = workspace.getByRole('region', { name: 'Private R console', exact: true });
    await consoleUi.getByRole('checkbox', { name: 'Use Server Seurat snapshot', exact: true }).check();
    await consoleUi.getByRole('checkbox', { name: 'Use Server condition metadata', exact: true }).check();
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125_000 });
    await consoleUi.getByLabel('R console source').fill(
      'obj<-read_input(' + JSON.stringify(savedObject.id) + '); metadata<-read_input(' + JSON.stringify(savedTable.id) + '); ' +
      'stopifnot(inherits(obj,"Seurat"),ncol(obj)==12L,nrow(obj)==20L,nrow(metadata)==12L,' +
      'identical(as.character(metadata$condition),rep(c("control","treated"),each=6L))); ' +
      'cat("Snapshot cells:",ncol(obj)); display_table(as.data.frame(table(metadata$condition)),name="Imported conditions"); barplot(table(obj$condition))');
    await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
    const commandOutput = consoleUi.getByRole('region', { name: 'R command output' });
    await commandOutput.getByText('Command 1 · completed', { exact: true }).waitFor({ timeout: 125_000 });
    assert((await commandOutput.getByLabel('R stdout').innerText()).includes('Snapshot cells: 12'),
      'Actual free R did not reopen the original genuine imported Seurat bytes.');
    await commandOutput.getByRole('cell', { name: 'treated', exact: true }).waitFor();
    await commandOutput.getByRole('img', { name: 'R figure 1', exact: true }).waitFor();
    const kernel = (await database.query('SELECT * FROM private_r_kernels WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 1', [owner.id])).rows[0];
    assert(kernel.environment_json.id === capability.environment.id
      && kernel.target_json.serviceLabel === 'Server data fixture'
      && kernel.inputs_json.some(value => value.checksumSha256 === savedObject.checksum_sha256)
      && kernel.inputs_json.some(value => value.checksumSha256 === savedTable.checksum_sha256),
    'The private R generation lost the exact imported input versions or selected server environment.');
    await commandOutput.scrollIntoViewIfNeeded();
    await workspace.screenshot({ path: path.join(output, 'ssh-imported-snapshot-free-r.png') });
    check('A real pinned private R session on the selected server reopens both original snapshots after source replacement and verifies 12 cells, 20 genes, condition counts and a figure.');
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();

    const ownerReceipt = (await database.query('SELECT request_id FROM server_data_imports WHERE version_id=$1', [savedObject.id])).rows[0];
    assert(ownerReceipt, 'The completed import lacks a durable request receipt.');
    const colleagueLogin = await api('/api/auth/login', { email: colleague.email, password: service.account.password });
    assert(colleagueLogin.status === 200, 'The disposable colleague could not authenticate.');
    const privateVersion = await api('/api/artifact-versions/' + project.id + '/' + savedObject.id);
    const privateReceipt = await api(base + '/imports/' + ownerReceipt.request_id);
    const privateRoot = await api(base + '/roots/shared/files?path=study');
    assert(privateVersion.status === 404 && privateReceipt.status === 404 && privateRoot.status === 404,
      'A different project analyst accessed another owner’s snapshot, receipt or source grant.');
    const ownerLogin = await api('/api/auth/login', { email: service.account.email, password: service.account.password });
    assert(ownerLogin.status === 200, 'The fixture owner session could not be restored.');
    check('A separate analyst in the same project cannot read the original owner’s imported snapshot, durable request receipt or source root grant.');
    assert(requests.every(value => value.origin === service.endpoint), 'A server import or R request left the desktop-selected HTTPS authority.');
    assert(!requests.some(value => /\/download$|checkpoint.*download/.test(value.path)),
      'The import workflow downloaded a full analysis object to the renderer.');
    assert(requests.filter(value => value.path === base + '/imports').every(value => value.postBytes < 8192),
      'A server import transported file contents in its admission request.');
    assert(responses.every(value => value.bytes < 512 * 1024 && !value.containsObject
      && !/application\/(?:x-r-rds|octet-stream)/i.test(value.contentType)),
    'A browser API transferred a complete RDS object instead of bounded previews and receipts.');
    check('Observed browser traffic carries only small metadata, import selections, bounded tables and figures; complete Seurat bytes remain on the server.');
    return workspace;
  }
}
if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result) + '\n'))
  .catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
module.exports = { main };
