#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function freePort() {
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function main() {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''), 'Set EXPERT_R_SANDBOX_IMAGE to the reviewed immutable R image.');
  const directory = path.join(root, 'playwright', 'report', 'runtime-readiness-' + Date.now()); fs.mkdirSync(directory, { recursive: true });
  const brokerPort = await freePort(), token = crypto.randomBytes(32).toString('hex');
  const checks = [], errors = [], observations = [];
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, broker, browser, page;
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory, webEnvironment: {
      EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles', EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${brokerPort}`, EXPERT_R_SANDBOX_TOKEN: token,
    } });
    process.env.STORAGE_ROOT = service.storageRoot;
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker({ ...process.env, NODE_ENV: 'test',
      EXPERT_R_SANDBOX_TOKEN: token, EXPERT_R_SANDBOX_IMAGE: image, EXPERT_R_SANDBOX_WORK_ROOT: path.join(directory, 'broker-work'),
      PRIVATE_R_KERNEL_ENABLED: 'true', PRIVATE_R_KERNEL_IDLE_SECONDS: '300' });
    await broker.startReconciliation(); await new Promise(resolve => broker.listen(brokerPort, '127.0.0.1', resolve));
    const capability = await fetch(`http://127.0.0.1:${brokerPort}/capabilities`, { headers: { Authorization: 'Bearer ' + token } }).then(response => response.json());
    assert(capability.persistentKernel && capability.persistentKernelInterrupt && capability.persistentKernelPublications, 'The reviewed image did not pass the actual private R capability probes.');
    const certificate = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    const authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(certificate.verify(authority.publicKey) && certificate.checkHost(new URL(service.endpoint).hostname), 'Disposable HTTPS certificate identity is invalid.');
    const spki = crypto.createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    // Trust only this owned disposable key. Production code retains TLS checks.
    browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1', '--ignore-certificate-errors-spki-list=' + spki] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('response', async response => {
      if (new URL(response.url()).pathname !== '/api/runtime/readiness' || response.status() !== 200) return;
      try { observations.push(await response.json()); } catch { /* Failed reads are checked through the UI. */ }
    });
    await page.goto(service.endpoint); await page.getByPlaceholder('researcher@lab.edu').fill(service.account.email);
    await page.getByLabel('Password', { exact: true }).fill(service.account.password);
    await page.getByRole('button', { name: /Open Workbench/ }).click();
    await page.getByText('Connection details', { exact: true }).waitFor();
    assert(observations.length === 0, 'Login started a readiness check without an explicit request.');
    const initial = (await database.query('SELECT (SELECT count(*) FROM jobs)::int AS jobs,(SELECT count(*) FROM private_r_kernels)::int AS kernels')).rows[0];
    await page.getByText('Connection details', { exact: true }).click();
    const opener = page.getByText('Connection details', { exact: true });
    const readinessButton = page.getByRole('button', { name: 'Check server readiness', exact: true });
    await opener.focus(); await page.keyboard.press('Tab');
    assert(await readinessButton.evaluate(element => element === document.activeElement), 'Tab did not enter the portaled connection controls.');
    await page.keyboard.press('Shift+Tab'); assert(await opener.evaluate(element => element === document.activeElement), 'Shift+Tab did not return to the connection opener.');
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert(await opener.evaluate(element => !element.closest('details').open && document.activeElement !== element && document.activeElement !== document.body), 'Tab from the final connection action did not close and continue within the application.');
    await opener.click();
    await page.getByRole('button', { name: 'Check server readiness', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Server readiness', exact: true });
    await dialog.getByText('This server supports the current application. Guided R target: R 4.5.x.', { exact: true }).waitFor();
    await dialog.getByText(`R ${capability.environment.rVersion} · Bioconductor ${capability.environment.bioconductor}`, { exact: true }).waitFor();
    await dialog.getByText('Execution access allowed', { exact: true }).waitFor();
    await dialog.getByText(/No current queued-worker observation/).waitFor();
    assert(observations[0].privateR.environment.manifestSha256 === capability.environment.manifestSha256, 'The panel did not receive the actual reviewed image environment.');
    assert(observations[0].privateR.resources.kernel.memoryBytes > 0 && observations[0].privateR.resources.kernel.cpuLimit > 0, 'The broker did not report its actual private R resource policy.');
    assert(observations[0].storage.durable.writable === true && observations[0].privateR.storage.work.writable === true, 'Actual owned storage write/read/remove probes did not succeed.');
    await dialog.screenshot({ path: path.join(directory, 'readiness-light.png') });
    check('Explicit production HTTPS/real PostgreSQL readiness shows the actual isolated image environment, resource ceilings and writable storage; an absent worker remains unknown.');
    const after = (await database.query('SELECT (SELECT count(*) FROM jobs)::int AS jobs,(SELECT count(*) FROM private_r_kernels)::int AS kernels')).rows[0];
    assert(JSON.stringify(initial) === JSON.stringify(after), 'Opening readiness dispatched scientific work.');
    check('Opening and reading readiness creates neither queued analyses nor private R sessions.');
    check('Portaled connection controls support Tab and Shift+Tab, then dismiss and continue after the opener without trapping focus.');
    async function recheck({ renew = false } = {}) {
      if (renew) await sleep(5200);
      // Finish the explicit check-on-open before associating a response with
      // this manual refresh. A visible button may still be disabled.
      await dialog.locator('button:not(:disabled)').filter({ hasText: /^Check again$/ }).waitFor();
      const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/runtime/readiness');
      await dialog.getByRole('button', { name: 'Check again', exact: true }).click();
      const result = await response; await dialog.locator('button:not(:disabled)').filter({ hasText: /^Check again$/ }).waitFor();
      return { status: result.status(), report: result.ok() ? await result.json() : null };
    }
    await sleep(5200); await dialog.getByText(/observation is no longer current/).waitFor();
    check('A five-second observation becomes visibly stale without background polling.');
    service.setRuntimeHealth({ status: 'ok', r_version: '4.5.3', packages: { Seurat: false, dplyr: true, plumber: true, jsonlite: true, ggplot2: true } });
    await database.query("INSERT INTO worker_pool_runtime_status(slot,state,capabilities_json,updated_at) VALUES(1,'ready',$1,NOW()) ON CONFLICT(slot) DO UPDATE SET state='ready',capabilities_json=EXCLUDED.capabilities_json,updated_at=NOW()", [JSON.stringify({ pathwayEnrichment: true, cellChat: false })]);
    const missing = await recheck();
    assert(missing.report.guided.state === 'missing-packages' && missing.report.workers.state === 'ready', 'A missing package or fresh worker heartbeat was incorrectly projected.');
    await dialog.getByText('Required packages missing', { exact: true }).waitFor();
    await dialog.getByText('Required and optional packages', { exact: true }).click();
    await dialog.getByText('Seurat: Missing', { exact: true }).waitFor();
    await dialog.getByText(/provide the required package/).first().waitFor();
    check('A controlled guided-service health response exposes a missing core package and remediation; a fresh real database heartbeat exposes queued-worker availability.');
    await database.query("UPDATE worker_pool_runtime_status SET updated_at=NOW()-INTERVAL '90 seconds' WHERE slot=1");
    const staleWorker = await recheck({ renew: true });
    assert(staleWorker.report.workers.state === 'unknown' && staleWorker.report.workers.capabilities.cellChat === null, 'A stale worker heartbeat retained current availability.');
    await dialog.getByText(/No current queued-worker observation/).waitFor();
    check('A stale worker observation becomes unknown, including its package capabilities.');
    service.setRuntimeHealth({ error: 'private runtime credential details' }, 401);
    const credentials = await recheck({ renew: true });
    assert(credentials.report.guided.state === 'authentication-failed', 'Guided-service authentication failure was reported as a package issue.');
    await dialog.getByText('Service authentication failed', { exact: true }).waitFor();
    await dialog.getByText(/repair the guided R service credentials/).waitFor();
    assert(!(await dialog.innerText()).includes('private runtime credential details'), 'A raw service error reached the panel.');
    check('A controlled service credential failure is distinct and offers safe remediation without raw diagnostics.');
    const storageRoot = path.resolve(service.storageRoot), backupRoot = storageRoot + '-readiness-check';
    assert(storageRoot.startsWith(path.resolve(directory) + path.sep) && backupRoot.startsWith(path.resolve(directory) + path.sep), 'Storage fixture targets must remain within the owned report.');
    fs.renameSync(storageRoot, backupRoot); fs.writeFileSync(storageRoot, 'owned readiness storage obstruction\n', { flag: 'wx' });
    try {
      const unwritable = await recheck({ renew: true });
      assert(unwritable.report.storage.durable.state === 'not-writable' && unwritable.report.storage.durable.writable === false, 'A non-directory storage mount was accepted as writable.');
      await dialog.getByText(/repair its access permissions/).first().waitFor();
      await dialog.screenshot({ path: path.join(directory, 'readiness-storage-unavailable.png') });
      check('An actual owned storage obstruction is reported as not writable with concrete recovery guidance.');
    } finally { fs.unlinkSync(storageRoot); fs.renameSync(backupRoot, storageRoot); }
    await dialog.getByRole('button', { name: 'Close server readiness', exact: true }).click();
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await page.getByText('Connection details', { exact: true }).click(); await page.getByRole('button', { name: 'Check server readiness', exact: true }).click();
    await recheck({ renew: true }); await dialog.getByRole('region', { name: 'Configured resource limits', exact: true }).scrollIntoViewIfNeeded();
    await dialog.screenshot({ path: path.join(directory, 'readiness-dark.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().width <= window.innerWidth), 'The readiness panel overflows the narrow viewport.');
    await dialog.getByRole('region', { name: 'Storage readiness', exact: true }).scrollIntoViewIfNeeded();
    await dialog.screenshot({ path: path.join(directory, 'readiness-mobile.png') });
    await dialog.getByRole('button', { name: 'Close server readiness', exact: true }).focus();
    await page.keyboard.press('Shift+Tab'); assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'Keyboard focus escaped the modal.');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert(await page.getByText('Connection details', { exact: true }).evaluate(element => element === document.activeElement), 'Closing readiness did not restore the connection opener.');
    check('Light, dark and narrow-screen reports remain readable and scrollable; keyboard focus stays in the panel and returns on dismissal.');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.getByRole('button', { name: /^Advanced analysis,/ }).click(); await page.getByRole('button', { name: 'Interactive console', exact: true }).click();
    const consoleUi = page.getByRole('region', { name: 'Private R console', exact: true });
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125000 });
    await consoleUi.getByLabel('R console source').fill('cat(21L * 2L)'); await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
    await consoleUi.getByRole('region', { name: 'R command output' }).getByText('Command 1 · completed', { exact: true }).waitFor({ timeout: 125000 });
    assert((await consoleUi.getByLabel('R stdout').innerText()).includes('42'), 'The actual private R command did not complete.');
    await consoleUi.screenshot({ path: path.join(directory, 'readiness-followed-by-real-r.png') });
    check('After diagnostic checks, an explicit UI command still starts the actual isolated reviewed R image and completes ordinary free R.');
    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click(); await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    await page.getByText('Connection details', { exact: true }).click(); await page.getByRole('button', { name: 'Check server readiness', exact: true }).click();
    await dialog.getByText('Execution access allowed', { exact: true }).waitFor();
    const owner = (await database.query('SELECT id FROM users WHERE email=$1', [service.account.email])).rows[0];
    await database.query("INSERT INTO platform_capabilities(user_id,capability) VALUES($1,'expert_r.denied')", [owner.id]);
    const revoked = await recheck();
    assert(revoked.report.privateR.accessState === 'access-revoked' && revoked.report.privateR.environment === null && revoked.report.privateR.resources.kernel === null, 'A cached probe retained a revoked user environment or policy: ' + JSON.stringify({ status: revoked.status, accessState: revoked.report.privateR.accessState, environmentVisible: revoked.report.privateR.environment !== null, kernelPolicyVisible: revoked.report.privateR.resources.kernel !== null }));
    await dialog.getByText('Execution access revoked', { exact: true }).waitFor(); await dialog.getByText('An exact custom R environment has not been verified.', { exact: true }).waitFor();
    check('A fresh access check immediately hides private environment and policy after account revocation, even while runtime observations are cached.');
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, owner.id]);
    await recheck(); await dialog.getByRole('alert').filter({ hasText: /review your access/ }).waitFor();
    assert(await dialog.getByText('Execution access revoked', { exact: true }).count() === 0, 'A denied project report retained earlier details.');
    check('Project membership removal rejects readiness and clears earlier report content.');
    await context.clearCookies(); await recheck(); await dialog.getByRole('alert').filter({ hasText: /sign-in has expired/ }).waitFor();
    check('Expired authentication gives a sign-in recovery instruction without changing servers.');
    const serialized = JSON.stringify(observations);
    assert(!serialized.includes(token) && !serialized.includes(service.storageRoot) && !serialized.includes(service.databaseUrl), 'A readiness report exposed host paths or credentials.');
    assert(!/"(?:workerId|slot|containerId|hostPath|cgroup)"/i.test(serialized), 'A readiness report exposed internal worker or host metadata.');
    assert(errors.length === 0, 'The production application raised an uncaught browser error.');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks, browserErrors: errors,
      imageDigest: capability.environment.imageDigest, environmentId: capability.environment.id,
      faultControls: ['guided health responses', 'real database heartbeat freshness', 'owned storage obstruction', 'real account/project access revocation'] }, null, 2));
    console.log('Runtime readiness UI acceptance passed; report: ' + directory);
  } catch (error) { await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally {
    await browser?.close(); await database?.end();
    if (broker?.listening) await new Promise((resolve, reject) => broker.close(error => error ? reject(error) : resolve()));
    await service?.stop();
    const work = path.resolve(directory, 'broker-work'); assert(work.startsWith(path.resolve(directory) + path.sep), 'Invalid disposable broker cleanup target.');
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
