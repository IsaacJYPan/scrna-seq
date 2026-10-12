#!/usr/bin/env node
'use strict';

// Genuine native SSH/HTTPS acceptance: close the whole client and recover
// original private-R admissions through UUID GETs, without scientific replay.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { runDesktopTunnelAcceptance } = require('./verify-desktop-tunnel-ui');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
async function port() {
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise(resolve => listener.close(resolve)); return value;
}
async function waitFor(check, message, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(message);
}
async function main() {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''), 'Use the reviewed immutable private-R image.');
  const output = path.join(root, 'playwright', 'report', 'private-r-recovery-' + Date.now());
  fs.mkdirSync(output, { recursive: true });
  const brokerPort = await port(), token = crypto.randomBytes(32).toString('hex');
  let database, service, broker;
  const checks = [], errors = [], requests = [], recoveryPhases = [];
  const check = value => { checks.push(value); process.stdout.write('PASS: ' + value + '\n'); };
  const observed = new WeakSet();
  function observe(page) {
    if (observed.has(page)) return; observed.add(page);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/private-r-kernels/')) {
        assert(requests.length < 2000, 'The recovery request ledger exceeded its bound.');
        requests.push({ method: request.method(), pathname });
      }
    });
  }
  const ui = page => page.getByRole('region', { name: 'Private R console', exact: true });
  async function open(page) {
    observe(page);
    await page.getByRole('button', { name: /^Advanced analysis,/ }).click();
    await page.getByRole('button', { name: 'Interactive console', exact: true }).click();
    await ui(page).getByRole('heading', { name: 'Private R console', exact: true }).waitFor();
    return ui(page);
  }
  function onlyGet(offset, phase) {
    const values = requests.slice(offset);
    assert(values.length > 0 && values.every(value => value.method === 'GET'), phase + ' replayed a private R mutation.');
    recoveryPhases.push({ phase, requests: values });
  }
  async function readSmall(page, pathname) {
    return page.evaluate(async path => {
      const response = await fetch(path, { credentials: 'include' });
      const text = await response.text();
      if (text.length > 16 * 1024) throw new Error('Receipt response exceeded its limit.');
      return { status: response.status, bytes: text.length, value: JSON.parse(text) };
    }, pathname);
  }
  async function safeStorage(page) {
    const entries = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
      .filter(key => /^traceomics_(?:private_r|submission_recovery)/.test(key))
      .map(key => [key, localStorage.getItem(key)])));
    const text = JSON.stringify(entries);
    assert(text.length <= 70 * 1024 && !/recovered_value|Recovered private value|Sys\.sleep|Bearer |postgresql:|source_code|sourceSha256|binding|sessionToken/.test(text),
      'Local recovery locators contain scientific source, bindings, credentials or oversized content.');
    return entries;
  }
  async function teardown() {
    try {
      if (broker?.listening) await new Promise((resolve, reject) => broker.close(error => error ? reject(error) : resolve()));
    } finally {
      broker = null;
      if (database) { const connection = database; database = null; await connection.end(); }
    }
  }
  let compiledAsset;
  try {
    await runDesktopTunnelAcceptance({ artifactDirectory: output,
      serviceFactory: async ({ artifactDirectory }) => {
        service = await createDesktopTunnelServiceFixture({ artifactDirectory,
          webEnvironment: { EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles',
            EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${brokerPort}`, EXPERT_R_SANDBOX_TOKEN: token } });
        database = new Client({ connectionString: service.databaseUrl }); await database.connect();
        process.env.STORAGE_ROOT = service.storageRoot;
        broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker({ ...process.env,
          NODE_ENV: 'test', EXPERT_R_SANDBOX_IMAGE: image, EXPERT_R_SANDBOX_TOKEN: token,
          EXPERT_R_SANDBOX_WORK_ROOT: path.join(output, 'broker-work'), PRIVATE_R_KERNEL_ENABLED: 'true',
          PRIVATE_R_KERNEL_IDLE_SECONDS: '900', EXPERT_R_MEMORY_LIMIT: '2g', EXPERT_R_CPU_LIMIT: '1' });
        await broker.startReconciliation(); await new Promise(resolve => broker.listen(brokerPort, '127.0.0.1', resolve));
        const capability = await fetch(`http://127.0.0.1:${brokerPort}/capabilities`, {
          headers: { Authorization: 'Bearer ' + token } }).then(response => response.json());
        assert(capability.persistentKernel && capability.persistentKernelPublications && capability.persistentKernelInterrupt,
          'The exact image did not independently verify the required private-R capabilities.');
        const stop = service.stop;
        service.stop = async () => { try { await teardown(); } finally { await stop(); } };
        return service;
      },
      exerciseWorkspace: async ({ workspace, restartWorkspace, createPeerWorkspace }) => {
        let page = workspace;
        try {
        compiledAsset = await page.evaluate(() => [...document.scripts].map(value => value.src).find(value => /\/assets\/index-/.test(value)));
        const project = service.project.id, base = '/api/private-r-kernels/' + project;
        const owner = (await database.query('SELECT id FROM users WHERE email=$1', [service.account.email])).rows[0];
        let consoleUi = await open(page);
        async function reopen(phase) {
          const offset = requests.length;
          const next = await restartWorkspace(); page = next.workspace; consoleUi = await open(page);
          assert((await page.evaluate(() => [...document.scripts].map(value => value.src).find(value => /\/assets\/index-/.test(value)))) === compiledAsset,
            'Reopening changed the compiled client during acceptance.');
          await waitFor(async () => requests.slice(offset).some(value => /-submissions\//.test(value.pathname))
            && !(await consoleUi.getByText('Checking the private R session. Commands and saves wait for fresh server confirmation.', { exact: true }).count()),
            'The reopened console did not finish bounded inspection.');
          onlyGet(offset, phase); return consoleUi;
        }
        const startFault = service.interceptNextResponse({ method: 'POST', pathname: base, mode: 'drop' });
        await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
        const start = await waitFor(() => startFault.observation(), 'The genuine start acknowledgment was not intercepted.', 125_000);
        assert(start.value?.submission?.kind === 'start', 'The original start did not retain a bounded admission receipt.');
        const kernelId = start.value.submission.kernelId;
        await safeStorage(page); await reopen('Whole Electron reopen after lost start acknowledgment');
        await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor();
        assert((await database.query('SELECT COUNT(*)::int AS count FROM private_r_kernels WHERE owner_user_id=$1', [owner.id])).rows[0].count === 1,
          'Lost start recovery created another session.');
        const startReceipt = await readSmall(page, base + '/start-submissions/' + start.value.submission.requestId);
        assert(startReceipt.status === 200 && startReceipt.value.kernelId === kernelId, 'Start recovery substituted another kernel.');
        check('A lost start acknowledgment survives complete Electron shutdown and recovers its exact UUID/kernel through GET with one session.');

        const commandOffset = requests.length;
        const commandFault = service.interceptNextResponse({ method: 'POST', pathname: base + '/' + kernelId + '/executions', mode: 'drop' });
        await consoleUi.getByLabel('R console source').fill('recovered_value <- 41L; Sys.sleep(30); cat(recovered_value)');
        await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
        const running = await waitFor(async () => (await database.query("SELECT id,request_id,kernel_generation,source_sha256,execution_order FROM private_r_executions WHERE kernel_id=$1 AND status='running'", [kernelId])).rows[0],
          'The genuine private command did not begin.');
        await safeStorage(page); await reopen('Whole Electron reopen during the original running private R command');
        if ((await database.query('SELECT status FROM private_r_executions WHERE id=$1', [running.id])).rows[0]?.status !== 'completed') {
          assert(!await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(), 'An unfinished admitted command allowed another R cell.');
        }
        await waitFor(async () => (await database.query('SELECT status FROM private_r_executions WHERE id=$1', [running.id])).rows[0]?.status === 'completed',
          'The original command did not complete while the client was closed.');
        await consoleUi.getByRole('button', { name: 'Refresh session status', exact: true }).click();
        await consoleUi.getByRole('region', { name: 'R command output' }).getByText('Command 1 · completed', { exact: true }).waitFor();
        await waitFor(() => consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(), 'The exact completed command did not release its pending fence.');
        const exactCommand = await readSmall(page, base + '/' + kernelId + '/execution-submissions/' + running.request_id);
        assert(exactCommand.value.executionId === running.id && exactCommand.value.requestHash === running.source_sha256
          && exactCommand.value.generation === running.kernel_generation && exactCommand.value.order === 1,
          'Command recovery substituted a newer result or different scientific input.');
        assert(requests.slice(commandOffset).filter(value => value.method === 'POST').length === 1
          && (await database.query('SELECT COUNT(*)::int AS count FROM private_r_executions WHERE kernel_id=$1', [kernelId])).rows[0].count === 1,
        'Whole-app recovery repeated the private R command.');
        await consoleUi.getByRole('region', { name: 'R command output' }).screenshot({ path: path.join(output, 'ssh-recovered-original-command.png') });
        check('Complete Electron shutdown during actual R evaluation restores the original UUID/hash/generation/order and result without another command.');
        commandFault.release();

        const peer = await createPeerWorkspace(page); observe(peer); const peerUi = await open(peer);
        await waitFor(() => peerUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(), 'The peer did not inspect the same idle kernel.');
        await consoleUi.getByLabel('R console source').fill('Sys.sleep(5); cat(recovered_value + 1L)');
        await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
        await waitFor(() => peerUi.getByRole('button', { name: 'Run R cell', exact: true }).isDisabled(), 'The shared peer did not fence a newly pending command.');
        const peerOffset = requests.length;
        await peerUi.getByRole('button', { name: 'Run R cell', exact: true }).click({ force: true });
        assert(!requests.slice(peerOffset).some(value => value.method === 'POST'), 'A peer with a pending private command sent another mutation.');
        await consoleUi.getByRole('region', { name: 'R command output' }).getByText('Command 2 · completed', { exact: true }).waitFor();
        assert((await consoleUi.getByLabel('R stdout').innerText()).includes('42'), 'Surviving variables were replaced or lost during whole-app recovery.');
        check('The same authenticated native partition retains pending UUIDs across windows and blocks a peer mutation; a new explicit cell proves surviving variables.');

        const actorRequests = [];
        page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname.startsWith(base)) actorRequests.push(pathname); });
        const heldCommand = service.interceptNextResponse({ method: 'POST', pathname: base + '/' + kernelId + '/executions', mode: 'hold' });
        await waitFor(() => consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(), 'The second command did not finish inspection.');
        await consoleUi.getByLabel('R console source').fill('cat(recovered_value + 2L)');
        await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
        const held = await waitFor(() => heldCommand.observation(), 'The completed third command acknowledgment was not held.');
        assert(held.value.submission?.order === 3, 'The held acknowledgment does not identify the original third command.');
        await peerUi.getByRole('button', { name: 'Refresh session status', exact: true }).click();
        await waitFor(() => peerUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(), 'The peer did not confirm the held original command through GET.');
        await peerUi.getByLabel('R console source').fill('Sys.sleep(10); cat(recovered_value + 3L)');
        await peerUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
        const peerCommand = await waitFor(async () => (await database.query("SELECT id,request_id FROM private_r_executions WHERE kernel_id=$1 AND execution_order=4 AND status='running'", [kernelId])).rows[0],
          'The newer explicit peer command did not begin.');
        heldCommand.release();
        await waitFor(async () => actorRequests.includes(base + '/' + kernelId + '/execution-submissions/' + peerCommand.request_id)
          && !(await consoleUi.getByText('Checking the private R session. Commands and saves wait for fresh server confirmation.', { exact: true }).count()),
          'The delayed acknowledgment did not inspect the newer peer intent.');
        const selectedPeer = await page.evaluate(() => JSON.parse(localStorage.getItem('traceomics_private_r_submission_recovery_v1')).selection);
        assert(selectedPeer.requestId === peerCommand.request_id && selectedPeer.executionId === peerCommand.id,
          'The delayed original acknowledgment overwrote a newer peer selection.');
        await peerUi.getByRole('region', { name: 'R command output' }).getByText('Command 4 · completed', { exact: true }).waitFor();
        await consoleUi.getByRole('button', { name: 'Refresh session status', exact: true }).click();
        await consoleUi.getByRole('region', { name: 'R command output' }).getByText('Command 4 · completed', { exact: true }).waitFor();
        await consoleUi.getByRole('region', { name: 'Private R submitted requests' }).screenshot({ path: path.join(output, 'ssh-exact-request-recovery-panel.png') });
        await peer.close();
        check('A delayed genuine command acknowledgment preserves a newer peer command selection and the exact fourth output in both windows.');

        await waitFor(() => consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).isEnabled(), 'The explicit new cell did not complete its inspection.');
        const saveFault = service.interceptNextResponse({ method: 'POST', pathname: base + '/' + kernelId + '/publications', mode: 'drop' });
        await consoleUi.getByLabel('Existing R binding', { exact: true }).fill('recovered_value');
        await consoleUi.getByLabel('Saved output name', { exact: true }).fill('Recovered private value');
        await consoleUi.getByRole('button', { name: 'Save object', exact: true }).click();
        const save = await waitFor(() => saveFault.observation(), 'The committed save acknowledgment was not intercepted.', 125_000);
        assert(save.value?.submission?.kind === 'publication', 'The save admission did not retain its own UUID namespace.');
        await safeStorage(page); await reopen('Whole Electron reopen after lost immutable publication acknowledgment');
        await consoleUi.getByText('Recovered private value · object · completed', { exact: true }).waitFor();
        const exactSave = await readSmall(page, base + '/' + kernelId + '/publication-submissions/' + save.value.submission.requestId);
        assert(exactSave.value.publicationId === save.value.publication.id && exactSave.value.versionId === save.value.version.versionId
          && exactSave.value.requestHash === save.value.submission.requestHash,
        'The publication recovery substituted another version or internal serialization UUID.');
        assert((await database.query('SELECT COUNT(*)::int AS count FROM private_r_publications WHERE kernel_id=$1', [kernelId])).rows[0].count === 1,
          'Recovery serialized or published a second saved artifact.');
        check('A committed save with lost acknowledgment reopens its exact publication UUID and immutable version without another serialization.');

        const restartFault = service.interceptNextResponse({ method: 'POST', pathname: base + '/' + kernelId + '/restart', mode: 'drop' });
        await consoleUi.getByRole('button', { name: 'Restart session', exact: true }).click();
        await consoleUi.getByRole('button', { name: 'Restart and discard unsaved memory', exact: true }).click();
        const restarted = await waitFor(() => restartFault.observation(), 'The committed restart acknowledgment was not intercepted.', 125_000);
        assert(restarted.value?.submission?.kind === 'restart', 'The restart lost its original request identity.');
        await safeStorage(page); await reopen('Whole Electron reopen after lost original restart acknowledgment');
        const replacementId = restarted.value.submission.replacementKernelId;
        const replacement = (await database.query('SELECT id,runtime_generation,next_order,status FROM private_r_kernels WHERE id=$1', [replacementId])).rows[0];
        assert(replacement && replacement.runtime_generation !== running.kernel_generation && Number(replacement.next_order) === 0
          && (await database.query('SELECT COUNT(*)::int AS count FROM private_r_kernels WHERE owner_user_id=$1', [owner.id])).rows[0].count === 2,
        'Restart recovery created another replacement or replayed earlier commands.');
        const exactRestart = await readSmall(page, base + '/restart-submissions/' + restarted.value.submission.requestId);
        assert(exactRestart.value.kernelId === kernelId && exactRestart.value.replacementKernelId === replacementId,
          'The restart recovery followed a normal-start identity instead of the original restart.');
        assert((await readSmall(page, base + '/start-submissions/' + restarted.value.submission.requestId)).status === 404,
          'A restart replacement was incorrectly returned as a normal start receipt.');
        const identity = consoleUi.getByLabel('R session identity');
        await identity.getByText('Session ready · unsaved memory available', { exact: true }).waitFor();
        await identity.getByText('Session reproducibility details', { exact: true }).click();
        await identity.getByText(`Kernel ${replacementId} · generation ${replacement.runtime_generation}`, { exact: true }).waitFor();
        await consoleUi.getByText('Restart created a fresh session from the original selected input versions. Unsaved variables and files were discarded; earlier commands were not rerun. Saved artifact versions remain available.', { exact: true }).waitFor();
        const previous = consoleUi.getByRole('region', { name: 'Previous R session evidence' });
        await previous.getByText(`Previous kernel ${kernelId} → current kernel ${replacementId}`, { exact: true }).waitFor();
        await previous.getByRole('button', { name: 'Inspect previous session', exact: true }).click();
        await previous.getByRole('button', { name: 'Inspect previous Recovered private value · v1', exact: true }).click();
        await consoleUi.getByRole('region', { name: 'Saved R artifact preview' })
          .getByText(`Version ${exactSave.value.versionId} · org.r-project.rds`, { exact: true }).waitFor();
        await consoleUi.getByLabel('R session identity').screenshot({ path: path.join(output, 'ssh-recovered-replacement-generation.png') });
        check('Lost restart acknowledgment recovers one linked replacement generation through the original UUID, retains saved versions and replays no source.');
        const receipts = [startReceipt.value, exactCommand.value, exactSave.value, exactRestart.value];
        assert(receipts.every(value => JSON.stringify(value).length < 16 * 1024
          && !/recovered_value|Recovered private value|source_code|sourceSha256|binding|storage_key|Bearer |postgresql:/.test(JSON.stringify(value))),
        'A private UUID receipt exposed source, output names, storage or credentials.');
        await safeStorage(page);
        assert(errors.length === 0, 'The native recovery workspace raised browser errors.');
        check('Private recovery storage and UUID GETs contain bounded identifiers/hash/status only and no scientific source or private paths.');
        return page;
        } catch (error) {
          await page.screenshot({ path: path.join(output, 'recovery-failure.png'), fullPage: true }).catch(() => {});
          throw error;
        }
      },
    });
    fs.writeFileSync(path.join(output, 'recovery-report.json'), JSON.stringify({ ok: true, checks, browserErrors: errors,
      compiledAsset, requests, recoveryPhases }, null, 2));
    return { ok: true, checks: checks.length, artifactDirectory: output };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'recovery-report.json'), JSON.stringify({ ok: false, checks, error: error.message,
      browserErrors: errors, compiledAsset, requests, recoveryPhases }, null, 2));
    throw error;
  } finally {
    try { await teardown(); } finally {
      try { await service?.stop(); } finally {
        const directory = path.resolve(output, 'broker-work');
        assert(directory.startsWith(path.resolve(output) + path.sep), 'Invalid private fixture cleanup path.');
        await fs.promises.rm(directory, { recursive: true, force: true });
      }
    }
  }
}
if (require.main === module) main().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
  process.stderr.write(error.stack + '\n'); process.exitCode = 1;
});
module.exports = { main };
