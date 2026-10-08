#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
function assert(condition, message) { if (!condition) throw new Error(message); }

async function verifyExecutionHistoryUi({ page, fixtures, newSource, directory, corruptOutput, revokeAccess }) {
  const checks = [];
  const region = page.getByRole('region', { name: 'Execution history', exact: true });
  async function open(id, kind = 'all') {
    await region.getByLabel('Execution category').selectOption(kind);
    await region.getByRole('button', { name: new RegExp(id) }).click();
    await region.getByText('Replay evidence incomplete', { exact: true }).waitFor();
    assert(await region.getByText(id, { exact: true }).count() >= 1, 'Selected execution lost its exact identity.');
  }
  async function expand(name) {
    const detail = region.locator('details').filter({ has: page.locator('summary').filter({ hasText: new RegExp('^' + name) }) });
    if (await detail.getAttribute('open') === null) await detail.locator('summary').click();
  }
  await open(fixtures.guided.id, 'guided');
  await expand('Executed source'); await expand('Parameters'); await expand('Outputs');
  assert(await region.getByText('FindAllMarkers(object, min.pct = 0.1)', { exact: true }).isVisible(), 'Guided retained source was absent.');
  assert((await region.innerText()).includes('"minPct": 0.1'), 'Recorded resolved defaults were absent.');
  assert((await region.innerText()).includes('user-supplied metadata'), 'Imported guided provenance was presented as server-verified source.');
  await region.getByRole('button', { name: 'Inspect Recorded gene scores', exact: true }).click();
  await region.getByRole('cell', { name: 'GENE_A', exact: true }).waitFor();
  assert(await region.getByText('Recorded gene scores · recorded version checksum verified', { exact: true }).isVisible(), 'Exact result bytes were not verified.');
  await page.screenshot({ path: path.join(directory, 'guided-execution.png'), fullPage: true });
  checks.push('Actual guided job history displays retained source, recorded resolved parameters, timestamp/status, explicit provenance/input gaps, and checksum-verified CSV output.');

  await open(fixtures.workflow.id, 'workflow');
  await expand('Executed source'); await expand('Parameters'); await expand('Inputs'); await expand('Outputs'); await expand('Kernel generation');
  assert((await region.innerText()).includes('history-summary@1.0.0'), 'Pinned recipe package identity was absent.');
  assert((await region.innerText()).includes('"threshold": 2') && (await region.innerText()).includes('"seed": 42'), 'Matching recipe parameters/seed were absent.');
  assert((await region.innerText()).includes(fixtures.checkpoint.sha256), 'Exact recipe input checksum was absent.');
  assert((await region.innerText()).includes('One-shot legacy jobs'), 'Recipe generation was falsely presented as kernel command order.');
  await region.getByRole('button', { name: 'Inspect analysis', exact: true }).click();
  await region.getByText('analysis · recorded version checksum verified', { exact: true }).waitFor();
  assert((await region.innerText()).includes('supports metadata inspection; its contents require an appropriate private analysis runtime.'), 'Opaque checkpoint metadata-only inspection was absent.');
  await region.getByRole('button', { name: 'Inspect Workflow metrics', exact: true }).click();
  await region.getByText('Workflow metrics · recorded version checksum verified', { exact: true }).waitFor();
  assert((await region.innerText()).includes('cells'), 'Recorded workflow output preview was absent.');
  await page.screenshot({ path: path.join(directory, 'recipe-execution.png'), fullPage: true });
  checks.push('Recipe history pins package/input/output checksums and matching resolved parameters/seed; opaque RDS bytes remain metadata-only, and workflow generation is not treated as kernel order.');

  await open(fixtures.live.id, 'live-r');
  await expand('Executed source'); await expand('Kernel generation'); await expand('Environment');
  assert((await region.innerText()).includes('Execution order 7') && (await region.innerText()).includes('Result live revision 3'), 'Trusted process order/result revision were conflated or absent.');
  assert((await region.innerText()).includes('Guided interactive R process'), 'Kernel scope was not disclosed.');
  assert((await region.innerText()).includes('5.3.0'), 'Observed R package version was absent.');
  await page.screenshot({ path: path.join(directory, 'live-execution.png'), fullPage: true });
  await open(fixtures.imported.id, 'provenance'); await expand('Kernel generation');
  assert((await region.innerText()).includes('not a server-verified execution journal'), 'Imported provenance trust boundary was absent.');
  assert(!(await region.innerText()).includes('Execution order 999'), 'Client-supplied provenance forged kernel order.');
  checks.push('Production journal read adapter displays server-owned process generation/order/result revision; client-imported provenance cannot forge kernel evidence. Fixture records do not claim scientific execution.');

  await open(fixtures.expert.id, 'expert-r'); await expand('Executed source'); await expand('Environment');
  assert((await region.innerText()).includes('Only the source checksum was retained.'), 'Legacy source-retention gap was hidden.');
  await region.getByRole('button', { name: 'Verify environment manifest', exact: true }).click();
  await region.getByText('Environment manifest checksum verified', { exact: true }).waitFor();
  assert((await region.innerText()).includes('traceomics.r-environment.v1'), 'Protected manifest was not read from verified storage bytes.');
  checks.push('Legacy terminal R source stays explicitly hash-only; exact private environment manifest is delivered only after byte/checksum/reference verification.');
  if (newSource) {
    await open(newSource.id, 'expert-r'); await expand('Executed source');
    assert(await region.getByText('Private source version ' + newSource.sourceVersionId, { exact: true }).isVisible(), 'New terminal R job lost its retained private source version.');
    assert(await region.getByText(newSource.code, { exact: true }).isVisible(), 'New failed R job did not retain exact source.');
    assert((await region.innerText()).includes('failed'), 'Failed job history was missing.');
    await page.screenshot({ path: path.join(directory, 'retained-r-source.png'), fullPage: true });
    checks.push('New real database enqueue retains immutable creator-private R source through failure while terminal transport parameters erase the script.');
  }
  if (corruptOutput) {
    await open(fixtures.guided.id, 'guided'); await expand('Outputs');
    await corruptOutput();
    await region.getByRole('button', { name: 'Inspect Recorded gene scores', exact: true }).click();
    await region.getByRole('alert').waitFor();
    assert(await region.getByRole('table').count() === 0, 'Changed bytes received a private table preview.');
    await page.screenshot({ path: path.join(directory, 'integrity-rejected.png'), fullPage: true });
    checks.push('Changed output bytes fail the real integrity resolver and clear the prior table preview.');
  }
  if (revokeAccess) {
    await revokeAccess(); await region.getByRole('button', { name: 'Refresh executions', exact: true }).click();
    await region.getByRole('alert').waitFor();
    assert(await region.getByRole('button', { name: new RegExp(fixtures.guided.id) }).count() === 0, 'Revoked membership left private history entries visible.');
    assert(await region.locator('details').count() === 0 && await region.getByRole('table').count() === 0, 'Revoked membership left prior source/output evidence visible.');
    checks.push('Revoked current project membership clears earlier private evidence and history entries.');
  }
  return { passed: true, checks, directory };
}

module.exports = { verifyExecutionHistoryUi };

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}

async function standalone() {
  if (process.env.TRACEOMICS_EXECUTION_HISTORY_UI_DB_DISPOSABLE !== '1' || !process.env.DATABASE_URL || process.env.NODE_ENV !== 'test') throw new Error('Standalone execution acceptance requires an explicitly disposable PostgreSQL test database.');
  require('./require-test-database');
  const name = 'history-ui-' + crypto.randomUUID(); const fixtureDirectory = path.join(ROOT, 'scratch', name);
  const directory = path.join(ROOT, 'playwright', 'report', 'execution-history-' + Date.now());
  fs.mkdirSync(fixtureDirectory, { recursive: true }); fs.mkdirSync(directory, { recursive: true });
  const port = await unusedPort(); const origin = 'http://127.0.0.1:' + port;
  Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', STORAGE_ROOT: path.join(fixtureDirectory, 'storage'), FRONTEND_ORIGIN: origin });
  const db = require('../backend/pgDatabase'); const provider = require('../backend/storage').createLocalStorageProvider();
  const { seedExecutionHistory, seedRetainedExpertSource } = require('../backend/_executionHistoryFixtures');
  const { startServer, createUserWithToken } = require('../backend/_http-test-utils');
  let server, vite, browser, activePage, output = '';
  try {
    server = await startServer(); await db.resetSchemaForTests();
    const owner = await createUserWithToken({ email: 'history-owner@example.test', displayName: 'History researcher' });
    const viewer = await createUserWithToken({ email: 'history-viewer@example.test', displayName: 'History viewer' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Recorded methods lab' });
    const project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Execution history acceptance' });
    const other = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Separate study' });
    await db.addProjectMemberByEmail(project.id, viewer.user.email, 'viewer', { userId: owner.user.id });
    const fixtures = await seedExecutionHistory(db, provider, owner.user.id, project.id);
    const newSource = await seedRetainedExpertSource(db, owner.user.id, project.id, fixtures.object.id, fixtures.environment.reference);
    const backendOrigin = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(path.join(fixtureDirectory, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Execution history acceptance</title><link rel="icon" href="data:,"></head><body><main id="root"></main><script type="module" src="./harness.jsx"></script></body></html>');
    fs.writeFileSync(path.join(fixtureDirectory, 'harness.jsx'), `import React from 'react';
import { createRoot } from 'react-dom/client';
import ProjectHistory from '/src/pages/ProjectHistory.jsx';
import { electronAPI } from '/src/api.js';
import '/src/App.css';
window.electronAPI = electronAPI;
const user = await electronAPI.restoreSession();
const project = await electronAPI.getProject(${JSON.stringify(project.id)});
createRoot(document.getElementById('root')).render(<div className="mx-auto max-w-6xl p-8"><ProjectHistory userId={user.id} currentWs={{selectedProjectId:project.id,projects:[project],objects:[],selectedObjectIds:[]}} deploymentPolicy={{demoMode:false}} /></div>);
`);
    const configPath = path.join(fixtureDirectory, 'vite.config.mjs');
    const config = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts'].find(file => fs.existsSync(path.join(ROOT, file)));
    fs.writeFileSync(configPath, `import config from '../../${config}'; export default {...config,server:{...config.server,watch:null}};`);
    vite = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', configPath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, env: { ...process.env, VITE_API_BASE_URL: backendOrigin }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const append = chunk => { output = (output + chunk).slice(-16000); }; vite.stdout.on('data', append); vite.stderr.on('data', append);
    const deadline = Date.now() + 30000; let ready = false;
    while (Date.now() < deadline) {
      if (vite.exitCode !== null) throw new Error('UI server exited: ' + output);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) throw new Error('UI server did not become ready: ' + output);
    browser = await chromium.launch({ headless: true }); const cookie = require('../backend/config').sessionCookieName();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addCookies([{ name: cookie, value: owner.token, url: backendOrigin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); activePage = page; const errors = []; const requests = []; const responses = [];
    page.on('pageerror', error => { errors.push(error.message); });
    page.on('request', request => { if (request.url().startsWith(backendOrigin)) requests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    page.on('response', response => { if (response.url().startsWith(backendOrigin)) responses.push({ status: response.status(), path: new URL(response.url()).pathname }); });
    const url = origin + '/scratch/' + name + '/index.html'; await page.goto(url, { waitUntil: 'domcontentloaded' });
    const result = await verifyExecutionHistoryUi({ page, fixtures, newSource, directory,
      corruptOutput: async () => { fs.writeFileSync(provider.resolveKey(fixtures.result.key), 'gene,score\nCHANGED,9\n'); },
      revokeAccess: async () => { await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]); },
    });
    const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await viewerContext.addCookies([{ name: cookie, value: viewer.token, url: backendOrigin, httpOnly: true, sameSite: 'Lax' }]);
    const viewerPage = await viewerContext.newPage(); await viewerPage.goto(url, { waitUntil: 'domcontentloaded' });
    const viewerRegion = viewerPage.getByRole('region', { name: 'Execution history', exact: true });
    await viewerRegion.getByRole('button', { name: new RegExp(newSource.id) }).click();
    await viewerRegion.getByText(/require separate sharing authorization/).waitFor();
    assert(!(await viewerRegion.innerText()).includes(newSource.code), 'Collaborator activity disclosed creator-private code.');
    await viewerRegion.getByLabel('Execution category').selectOption('live-r');
    await viewerRegion.getByText('No execution records are available for this category.', { exact: true }).waitFor();
    const rejected = await viewerPage.evaluate(async ({ backendOrigin, projectId, recordId }) => {
      const response = await fetch(backendOrigin + '/api/execution-history/' + projectId + '/' + recordId, { credentials: 'include' }); return response.status;
    }, { backendOrigin, projectId: project.id, recordId: newSource.id });
    assert(rejected === 404, 'Viewer retrieved creator-private source through the actual API.');
    await viewerPage.screenshot({ path: path.join(directory, 'viewer-permissions.png'), fullPage: true });
    await db.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [project.id, owner.user.id]);
    const wrongProject = await page.evaluate(async ({ backendOrigin, projectId, recordId }) => {
      const response = await fetch(backendOrigin + '/api/execution-history/' + projectId + '/' + recordId, { credentials: 'include' }); return response.status;
    }, { backendOrigin, projectId: other.id, recordId: newSource.id });
    assert(wrongProject === 404, 'Private execution crossed its project boundary.');
    assert(!requests.some(request => request.path.startsWith('/api/r/')), 'Read-only execution inspection invoked a shared R endpoint.');
    assert(errors.length === 0, 'Browser errors: ' + errors.join('; '));
    result.checks.push('Actual viewer membership permits bounded project activity while private source/journal/details remain inaccessible; wrong-project history is rejected.');
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify({ ...result, noEndpointMocks: true, actualProjectHistory: true, scientificExecutionVerified: false, trustedJournalFixtureUsed: true, requests, responses }, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (error) {
    if (activePage) { await activePage.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure.txt'), error.message + '\n' + await activePage.locator('body').innerText().catch(() => '') + '\n' + output); }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (vite?.exitCode === null) { const exited = new Promise(resolve => vite.once('exit', resolve)); vite.kill('SIGTERM'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  }
}
if (require.main === module) standalone().catch(error => { console.error(error.message); process.exitCode = 1; });
