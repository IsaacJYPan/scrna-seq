#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
function assert(condition, message) { if (!condition) throw new Error(message); }
async function buildReactFixture(output) {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const sourceDirectory = path.join(output, 'fixture-source');
  const frontendDirectory = path.join(output, 'fixture-dist');
  assert(path.resolve(output).startsWith(path.join(root, 'playwright', 'report') + path.sep)
    && path.resolve(frontendDirectory).startsWith(path.resolve(output) + path.sep),
  'Desktop fixture build output must remain inside its disposable workspace report.');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  const modulePath = file => path.relative(sourceDirectory, path.join(root, file)).replace(/\\/g, '/');
  fs.writeFileSync(path.join(sourceDirectory, 'index.html'),
    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
  fs.writeFileSync(path.join(sourceDirectory, 'main.jsx'), `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ExecutionTargetIndicator from '${modulePath('src/components/ExecutionTargetIndicator.jsx')}';
import { electronAPI } from '${modulePath('src/api.js')}';
import '${modulePath('src/App.css')}';
window.electronAPI = electronAPI;
function Workspace() {
  const [service, setService] = useState('Opening workspace');
  const [policy, setPolicy] = useState({});
  const [remembered, setRemembered] = useState(localStorage.getItem('project-id'));
  const updateCapabilities = () => electronAPI.getExpertRCapabilities().then(setPolicy)
    .catch(() => setPolicy({ expertRStatus: { state: 'access-required' } }));
  useEffect(() => {
    fetch('/fixture/service').then(response => response.json()).then(value => setService(value.name));
    updateCapabilities();
  }, []);
  const remember = async () => {
    document.cookie = 'session=' + service + '; path=/; SameSite=Lax; Max-Age=3600';
    localStorage.setItem('project-id', service + '-project');
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('target-fixture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('selections');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('selections', 'readwrite');
        transaction.objectStore('selections').put(service + '-object', 'selected');
        transaction.oncomplete = () => { database.close(); resolve(); };
      };
    });
    setRemembered(service + '-project');
    await updateCapabilities();
  };
  return <main className="min-h-screen bg-background text-text">
    <ExecutionTargetIndicator deploymentPolicy={policy} />
    <div className="p-8"><h1 className="text-2xl font-bold">{service}</h1>
      <p className="my-4">{remembered || 'No remembered project'}</p>
      <button className="btn btn-primary" onClick={remember}>Remember this workspace</button>
    </div>
  </main>;
}
createRoot(document.getElementById('root')).render(<Workspace />);
`);
  await build({ configFile: false, root: sourceDirectory, base: './', logLevel: 'error', plugins: [react()],
    define: { 'import.meta.env.VITE_API_BASE_URL': '""' },
    build: { outDir: frontendDirectory, emptyOutDir: true } });
  return frontendDirectory;
}

async function assertTargetIndicator({ page, name, endpoint, rStatus, application, artifactDirectory } = {}) {
  const indicator = page.locator('[aria-label="Execution target"]');
  const summary = indicator.locator('summary').filter({ hasText: 'Connection details' });
  if ((await indicator.locator('details').getAttribute('open')) === null) await summary.click();
  const panelId = await summary.getAttribute('aria-controls');
  const panel = page.locator('[id=' + JSON.stringify(panelId) + ']');
  await panel.getByText('Server: ' + name, { exact: true }).waitFor();
  assert(await panel.getByText(endpoint, { exact: true }).isVisible(), 'The indicator omits the connected service endpoint.');
  if (rStatus) {
    try { await panel.getByText(rStatus, { exact: true }).waitFor({ timeout: 5000 }); }
    catch {
      const rendered = await panel.textContent();
      if (artifactDirectory) await page.screenshot({ path: path.join(artifactDirectory, 'execution-target-status-mismatch.png') });
      throw new Error(`Expected runtime status "${rStatus}" in Connection details; found: ${rendered}`);
    }
  }
  assert(await panel.getByRole('button', { name: 'Change server', exact: true }).isVisible(),
    'The desktop indicator does not expose native target settings.');
  if (artifactDirectory) await page.screenshot({ path: path.join(artifactDirectory,
    'execution-target-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png') });
  if (application) return openSettings(application, page);
}
async function startFixture(name, compatible = true, frontendDirectory) {
  const requests = [];
  let descriptor = compatible ? { product: 'TraceOmics', serviceApiVersion: 1, minimumClientApiVersion: 1 }
    : { product: 'UnrelatedSite', serviceApiVersion: 1, minimumClientApiVersion: 1 };
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, cookie: request.headers.cookie || '' });
    if (request.url === '/api/service/compatibility') {
      response.writeHead(descriptor == null ? 404 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(descriptor || { error: 'Legacy service.' })); return;
    }
    if (request.url === '/api/auth/policy') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(compatible ? { registrationEnabled: false } : { differentApplication: true }));
      return;
    }
    if (request.url === '/fixture/service') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ name })); return;
    }
    if (request.url === '/api/expert-r/capabilities') {
      const authenticated = (request.headers.cookie || '').split(';').some(cookie => cookie.trim() === 'session=' + name);
      response.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(authenticated
        ? { expertREnabled: name === 'ServiceA', expertRStatus: { state: name === 'ServiceA' ? 'ready' : 'access-revoked' } }
        : { error: 'Authentication required.' })); return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? path.join(frontendDirectory, 'index.html')
      : path.resolve(frontendDirectory, '.' + pathname);
    if (!file.startsWith(path.resolve(frontendDirectory) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    response.writeHead(200, { 'Content-Type': contentType,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
    response.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}`,
    setCompatibility(value) { descriptor = value; } };
}
async function launch(userData, serverUrl = '') {
  return electron.launch({ args: [root, `--user-data-dir=${userData}`],
    env: { ...process.env, TRACEOMICS_DESKTOP_URL: serverUrl }, timeout: 60_000 });
}
async function openSettings(application, page) {
  const opened = application.waitForEvent('window');
  await page.getByRole('button', { name: 'Change server', exact: true }).click();
  const setup = await opened;
  await setup.getByRole('heading', { name: 'Choose your research server', exact: true }).waitFor();
  return setup;
}
async function connect(application, setup, { name, origin } = {}) {
  await setup.locator('#saved-target').selectOption('');
  await setup.getByLabel('Target name', { exact: true }).fill(name);
  await setup.getByLabel('Connection type', { exact: true }).selectOption('local');
  await setup.getByLabel('Server address', { exact: true }).fill(origin);
  const opened = application.waitForEvent('window');
  await setup.getByRole('button', { name: 'Save and connect', exact: true }).click();
  return opened;
}
async function browserState(page) {
  return page.evaluate(async () => ({ cookie: document.cookie, projectId: localStorage.getItem('project-id'),
    objectId: await new Promise(resolve => {
      const request = indexedDB.open('target-fixture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('selections');
      request.onsuccess = () => {
        const database = request.result;
        const read = database.transaction('selections').objectStore('selections').get('selected');
        read.onsuccess = () => { database.close(); resolve(read.result || null); };
      };
      request.onerror = () => resolve(null);
    }), target: await window.desktopShell.getCurrentTarget() }));
}

async function runDesktopTargetAcceptance({ artifactDirectory } = {}) {
  const output = artifactDirectory || path.join(root, 'playwright', 'report',
    'desktop-targets-' + new Date().toISOString().replace(/[:.]/g, '-'));
  const userData = path.join(output, 'user-data');
  fs.mkdirSync(userData, { recursive: true });
  const settingsFile = path.join(userData, 'desktop-settings.json');
  const frontendDirectory = await buildReactFixture(output);
  const fixtures = await Promise.all([startFixture('ServiceA', true, frontendDirectory), startFixture('ServiceB', true, frontendDirectory), startFixture('UnrelatedSite', false, frontendDirectory)]);
  const [first, second, incompatible] = fixtures;
  const checks = [];
  let application;
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({ serverUrl: first.origin }));
    application = await launch(userData);
    let page = await application.firstWindow();
    await page.getByRole('heading', { name: 'ServiceA', exact: true }).waitFor();
    const actualUserData = await application.evaluate(({ app }) => app.getPath('userData'));
    assert(path.resolve(actualUserData) === path.resolve(userData), 'Electron did not use disposable application storage.');
    const migrated = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert(migrated.schemaVersion === 1 && migrated.profiles.length === 1 && migrated.profiles[0].endpoint === first.origin,
      'Legacy direct URL settings did not migrate.');
    checks.push('legacy URL opens and migrates to a named local target');
    await assertTargetIndicator({ page, name: 'Saved server', endpoint: first.origin, rStatus: 'Custom R access required' });
    await page.getByRole('button', { name: 'Remember this workspace', exact: true }).click();
    await page.getByText('ServiceA-project', { exact: true }).waitFor();
    const denied = await page.evaluate(async () => {
      try { await window.desktopShell.saveTargetProfile({ name: 'Unauthorized', kind: 'local', endpoint: 'http://localhost:3000' }); }
      catch (error) { return error.message; }
      return '';
    });
    assert(denied.includes('connection settings'), 'A remotely served page could modify native target profiles.');
    const deniedSshActions = await page.evaluate(async () => {
      const actions = [() => window.desktopShell.getTargetProfiles(), () => window.desktopShell.chooseSshIdentity(),
        () => window.desktopShell.verifySshTarget({}), () => window.desktopShell.confirmSshHost('untrusted', 'fingerprint'),
        () => window.desktopShell.cancelSshVerification(), () => window.desktopShell.openSshHostTrust(),
        () => window.desktopShell.unlockSshIdentity('untrusted-file')];
      return Promise.all(actions.map(async action => { try { await action(); return false; } catch (error) { return error.message.includes('connection settings'); } }));
    });
    assert(deniedSshActions.every(Boolean), 'A remotely served page accessed native SSH settings, identity selection, or trust.');
    checks.push('remote renderer cannot alter native connection settings');

    let setup = await assertTargetIndicator({ page, name: 'Saved server', endpoint: first.origin,
      rStatus: 'Custom R available', application, artifactDirectory: output });
    page = await connect(application, setup, { name: 'Second workstation', origin: second.origin });
    await page.getByRole('heading', { name: 'ServiceB', exact: true }).waitFor();
    const isolated = await browserState(page);
    assert(isolated.cookie === '' && isolated.projectId === null && isolated.objectId === null,
      'Loopback target switch reused another service cookie or object selection.');
    assert(isolated.target.name === 'Second workstation' && isolated.target.endpoint === second.origin,
      'Current target metadata names the wrong project service.');
    assert(isolated.target.serviceCompatibility?.product === 'TraceOmics' && !isolated.target.capabilities,
      'The native target fabricated compute capability from a compatible public descriptor.');
    assert(second.requests.filter(request => request.path === '/').every(request => request.cookie === ''),
      'The first request sent credentials from another loopback service.');
    await page.getByRole('button', { name: 'Remember this workspace', exact: true }).click();
    await page.getByText('ServiceB-project', { exact: true }).waitFor();
    checks.push('different loopback ports isolate cookies, localStorage, and IndexedDB');

    setup = await assertTargetIndicator({ page, name: 'Second workstation', endpoint: second.origin,
      rStatus: 'Custom R access revoked', application, artifactDirectory: output });
    assert(first.requests.some(request => request.path === '/api/expert-r/capabilities' && request.cookie.includes('session=ServiceA'))
      && second.requests.some(request => request.path === '/api/expert-r/capabilities' && request.cookie.includes('session=ServiceB')),
    'The React workspace did not request authenticated R capabilities on each service.');
    checks.push('actual React indicator follows native service metadata and authenticated R access');
    const beforeFailure = fs.readFileSync(settingsFile, 'utf8');
    second.setCompatibility({ product: 'TraceOmics', serviceApiVersion: 2, minimumClientApiVersion: 2 });
    await setup.getByRole('button', { name: 'Save and connect', exact: true }).click();
    await setup.getByRole('alert').filter({ hasText: 'service API is incompatible' }).waitFor();
    assert(fs.readFileSync(settingsFile, 'utf8') === beforeFailure && (await browserState(page)).cookie === 'session=ServiceB',
      'An incompatible same-service reconnect replaced the current authenticated workspace.');
    second.setCompatibility(null);
    await setup.getByRole('button', { name: 'Save and connect', exact: true }).click();
    await setup.getByRole('alert').filter({ hasText: 'does not publish a TraceOmics compatibility descriptor' }).waitFor();
    assert((await browserState(page)).target.status === 'connected', 'A missing compatibility descriptor displaced the current connection.');
    second.setCompatibility({ product: 'TraceOmics', serviceApiVersion: 1, minimumClientApiVersion: 1 });
    checks.push('same-service reconnect freshly rejects incompatible and legacy APIs while preserving the authenticated workspace');
    await setup.getByLabel('Server address', { exact: true }).fill(incompatible.origin);
    await setup.getByRole('button', { name: 'Save and connect', exact: true }).click();
    await setup.getByRole('alert').filter({ hasText: 'not a compatible TraceOmics server' }).waitFor();
    assert(fs.readFileSync(settingsFile, 'utf8') === beforeFailure, 'Failed connection modified the selected target settings.');
    assert((await browserState(page)).target.endpoint === second.origin, 'Failed connection replaced the current workspace.');
    checks.push('failed connection preserves the open workspace and saved selection');

    await setup.locator('#saved-target').selectOption('');
    await setup.getByLabel('Target name', { exact: true }).fill('Direct deployment');
    await setup.getByLabel('Connection type', { exact: true }).selectOption('https');
    await setup.getByLabel('Server address', { exact: true }).fill('https://user:password@research.example.org');
    await setup.getByRole('button', { name: 'Save profile', exact: true }).click();
    await setup.getByRole('alert').filter({ hasText: 'cannot include credentials' }).waitFor();
    assert(!fs.readFileSync(settingsFile, 'utf8').includes('password'), 'Credentials were persisted in target settings.');
    await setup.getByLabel('Server address', { exact: true }).fill('https://research.example.org/');
    await setup.getByRole('button', { name: 'Save profile', exact: true }).click();
    await setup.getByText('Target profile saved. Connect to use this project service.', { exact: true }).waitFor();
    assert(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).profiles.some(profile => profile.kind === 'https'
      && profile.endpoint === 'https://research.example.org'), 'Direct HTTPS profile was not saved in normalized form.');
    checks.push('direct HTTPS profiles save normalized endpoints and reject embedded credentials');

    await setup.locator('#saved-target').selectOption('');
    await setup.getByLabel('Target name', { exact: true }).fill('Lab compute');
    await setup.getByLabel('Connection type', { exact: true }).selectOption('ssh');
    await setup.getByLabel('SSH host', { exact: true }).fill('compute.example.org');
    await setup.getByLabel('SSH username (optional)', { exact: true }).fill('researcher');
    await setup.getByLabel('SSH port (optional)', { exact: true }).fill('22');
    await setup.getByRole('button', { name: 'Save profile', exact: true }).click();
    await setup.getByText(/SSH configuration saved\. Verify SSH access/).waitFor();
    assert(await setup.getByRole('button', { name: 'Verify SSH access', exact: true }).isEnabled(),
      'A saved SSH configuration cannot verify host identity and authentication.');
    assert(!(await setup.evaluate(() => window.desktopShell.getCurrentTarget())).sshAuthentication,
      'Saving a configuration falsely authenticated an SSH connection.');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const sshProfile = saved.profiles.find(profile => profile.kind === 'ssh');
    assert(sshProfile && !sshProfile.endpoint && Object.keys(sshProfile.ssh).sort().join(',') === 'host,port,remoteHost,remotePort,username',
      'SSH profile contains undeclared fields or a misleading local tunnel address.');
    await setup.screenshot({ path: path.join(output, 'ssh-profile-pending.png'), fullPage: true });
    checks.push('SSH profile records nonsecret settings and remains explicitly configuration-only');

    const original = saved.profiles.find(profile => profile.endpoint === first.origin);
    await setup.locator('#saved-target').selectOption(original.id);
    const reopened = application.waitForEvent('window');
    await setup.getByRole('button', { name: 'Save and connect', exact: true }).click();
    page = await reopened;
    await page.getByRole('heading', { name: 'ServiceA', exact: true }).waitFor();
    const preserved = await browserState(page);
    assert(preserved.cookie === 'session=ServiceA' && preserved.projectId === 'ServiceA-project' && preserved.objectId === 'ServiceA-object',
      'Returning to a service did not restore its own isolated credentials and selections.');
    await assertTargetIndicator({ page, name: 'Saved server', endpoint: first.origin, rStatus: 'Custom R available' });
    assert(first.requests.filter(request => request.path === '/api/service/compatibility').every(request => request.cookie === '')
      && second.requests.filter(request => request.path === '/api/service/compatibility').every(request => request.cookie === ''),
    'Public compatibility checks leaked a persisted account cookie.');
    checks.push('public API compatibility checks omit persisted account credentials on initial connection and reconnect');
    checks.push('returning to a service restores only its own persisted workspace');
    await page.screenshot({ path: path.join(output, 'service-a-restored.png') });
    await application.close(); application = null;

    application = await launch(userData, second.origin);
    page = await application.firstWindow();
    await page.getByRole('heading', { name: 'ServiceB', exact: true }).waitFor();
    const overridden = await browserState(page);
    assert(overridden.target.endpoint === second.origin && overridden.cookie === 'session=ServiceB'
      && overridden.projectId === 'ServiceB-project', 'Environment direct URL did not select its own service partition.');
    checks.push('environment URL override remains usable with profile isolation');
    await application.close(); application = null;
    application = await launch(userData);
    page = await application.firstWindow();
    await page.getByRole('heading', { name: 'ServiceB', exact: true }).waitFor();
    assert((await browserState(page)).target.endpoint === second.origin, 'Selected service did not survive desktop restart.');
    checks.push('desktop restart restores the selected named target');
    const result = { completedAt: new Date().toISOString(), checks };
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
    return { artifactDirectory: output, ...result };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, checks }, null, 2) + '\n');
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    await Promise.all(fixtures.map(({ server }) => new Promise(resolve => server.close(resolve))));
  }
}

module.exports = { runDesktopTargetAcceptance, assertTargetIndicator };
if (require.main === module) runDesktopTargetAcceptance().then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
