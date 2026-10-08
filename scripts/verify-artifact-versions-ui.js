#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64');
function assert(value, message) { if (!value) throw new Error(message); }

async function verifyArtifactVersionsUi({ page, artifactDirectory, corruptVersion, revokeAccess } = {}) {
  if (!page) throw new Error('An authenticated browser page displaying the artifact inspector is required.');
  const directory = artifactDirectory || path.join(ROOT, 'playwright', 'report', 'artifact-versions-' + Date.now());
  fs.mkdirSync(directory, { recursive: true });
  const region = page.getByRole('region', { name: 'Artifact versions', exact: true });
  await region.waitFor({ state: 'visible', timeout: 30000 });
  const tag = crypto.randomBytes(4).toString('hex');
  const checks = [];
  const upload = async (filename, bytes, name, purpose = 'auto') => {
    await region.getByLabel('Artifact file', { exact: true }).setInputFiles({ name: filename, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    await region.getByLabel('Artifact name', { exact: true }).fill(name);
    await region.getByLabel('Artifact purpose', { exact: true }).selectOption(purpose);
  };
  const verified = async () => {
    await region.getByRole('button', { name: /^(?:Import artifact|Save new artifact version)$/ }).waitFor();
    await region.getByText('Saved checksum verified · preview from this exact version', { exact: true }).waitFor();
  };
  const reference = async () => {
    const details = region.locator('details').filter({ hasText: 'Exact artifact reference' });
    await details.locator('summary').click();
    const value = JSON.parse(await details.locator('pre').innerText());
    await details.locator('summary').click();
    return value;
  };
  const tableName = `Acceptance samples ${tag}`;
  const firstBytes = 'sample,condition,note\nsample-1,control,"one, two"\nsample-2,treated,"line 1\nline 2"\n';
  await upload('samples.csv', firstBytes, tableName, 'sample-sheet');
  await region.getByRole('button', { name: 'Import artifact', exact: true }).click();
  await verified();
  assert(await region.getByRole('cell', { name: 'one, two', exact: true }).isVisible(), 'Quoted CSV content did not render as a single cell.');
  assert(await region.getByText('org.ietf.csv · 1', { exact: true }).isVisible(), 'The exact imported format was missing.');
  const original = await reference();
  assert(original.sha256 === crypto.createHash('sha256').update(firstBytes).digest('hex'), 'The UI reference did not match original saved bytes.');
  await region.getByLabel('Rows per page', { exact: true }).selectOption('1');
  await verified();
  assert(await region.getByRole('cell', { name: 'sample-1', exact: true }).isVisible(), 'The first bounded page was missing.');
  await region.getByRole('button', { name: 'Next rows', exact: true }).click();
  await verified();
  assert(await region.getByRole('cell', { name: 'sample-2', exact: true }).isVisible(), 'The next bounded page was missing.');
  checks.push('Actual sample-sheet import exposes exact identity/checksum and bounded CSV pages with quoted fields.');

  const nextBytes = 'sample,condition,note\nsample-1,control,revised\n';
  await upload('samples.csv', nextBytes, tableName, 'sample-sheet');
  await region.getByLabel('New version of selected artifact', { exact: true }).check();
  await region.getByRole('button', { name: 'Save new artifact version', exact: true }).click();
  await verified();
  assert(await region.getByRole('cell', { name: 'revised', exact: true }).isVisible(), 'Replacement preview did not expose the new saved bytes.');
  const replacement = await reference();
  assert(replacement.artifactId === original.artifactId && replacement.versionId !== original.versionId && replacement.sha256 !== original.sha256, 'Replacement did not preserve logical identity while creating an immutable version.');
  await region.getByRole('button', { name: new RegExp(`^${tableName} · v1`) }).click();
  await verified();
  assert(await region.getByRole('cell', { name: 'one, two', exact: true }).isVisible(), 'Original content did not remain inspectable after replacement.');
  await page.screenshot({ path: path.join(directory, 'immutable-table-versions.png'), fullPage: true });
  checks.push('Replacement creates a second exact version while original contents remain inspectable.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await region.getByRole('button', { name: new RegExp(`^${tableName} · v1`) }).click();
  await verified();
  assert(await region.getByRole('cell', { name: 'one, two', exact: true }).isVisible(), 'Immutable original did not survive page reload.');
  assert(await region.getByRole('button', { name: new RegExp(`^${tableName} · v2`) }).isVisible(), 'Replacement did not survive page reload.');
  checks.push('Both exact managed versions remain available after a fresh authenticated page load.');

  const imageName = `Acceptance tissue ${tag}`;
  await upload('histology.png', PNG, imageName);
  await region.getByRole('button', { name: 'Import artifact', exact: true }).click();
  await verified();
  const image = region.getByRole('img', { name: `Preview of ${imageName}`, exact: true });
  await image.waitFor({ state: 'visible' });
  await image.evaluate(element => element.decode());
  assert(await image.evaluate(element => element.naturalWidth === 1 && element.naturalHeight === 1), 'Raster preview did not load checked actual image bytes.');
  await page.screenshot({ path: path.join(directory, 'checked-raster-preview.png'), fullPage: true });
  checks.push('Small raster import renders through its authenticated checksum-verified image endpoint.');

  const objectName = `Acceptance opaque object ${tag}`;
  await upload('untrusted.rds', 'arbitrary serialized object placeholder', objectName);
  await region.getByRole('button', { name: 'Import artifact', exact: true }).click();
  await verified();
  assert(await region.getByText('Metadata only', { exact: true }).isVisible(), 'Untrusted RDS offered an unsafe preview.');
  assert(await region.getByText(/its contents require an appropriate private analysis runtime/).isVisible(), 'Metadata-only object restriction was absent.');
  assert(await region.getByRole('img').count() === 0 && await region.getByRole('table').count() === 0, 'Opaque RDS was deserialized in the inspector.');
  await page.screenshot({ path: path.join(directory, 'opaque-object-metadata.png'), fullPage: true });
  checks.push('Untrusted RDS remains metadata-only with integrity status and no object transfer or deserialization.');

  if (corruptVersion) {
    await corruptVersion(replacement);
    await region.getByRole('button', { name: new RegExp(`^${tableName} · v2`) }).click();
    await region.getByRole('alert').filter({ hasText: 'integrity check failed' }).waitFor();
    assert(await region.getByRole('table').count() === 0, 'Corrupted bytes still received a table preview.');
    await page.screenshot({ path: path.join(directory, 'changed-bytes-rejected.png'), fullPage: true });
    await region.getByRole('button', { name: new RegExp(`^${tableName} · v1`) }).click();
    await verified();
    assert(await region.getByRole('cell', { name: 'one, two', exact: true }).isVisible(), 'A corrupted newer version affected the earlier immutable version.');
    checks.push('Changed storage bytes fail inspection while the earlier immutable version remains intact.');
  }
  if (revokeAccess) {
    await revokeAccess(original);
    await region.getByRole('button', { name: 'Refresh artifacts', exact: true }).click();
    await region.getByRole('alert').waitFor();
    assert(await region.getByRole('table').count() === 0 && await region.getByRole('img').count() === 0, 'Revoked membership left a private preview visible.');
    assert(await region.getByRole('button', { name: new RegExp(`^${tableName} · v1`) }).count() === 0, 'Revoked membership left private artifact entries visible.');
    checks.push('Revoked project membership clears prior private artifact details and previews.');
  }
  fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify({ passed: true, checks, references: { original, replacement }, scientificDeserializationVerified: false }, null, 2) + '\n');
  return { passed: true, checks, directory, references: { original, replacement } };
}

module.exports = { verifyArtifactVersionsUi };

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function standalone() {
  if (process.env.TRACEOMICS_ARTIFACT_UI_DB_DISPOSABLE !== '1' || !process.env.DATABASE_URL || process.env.NODE_ENV !== 'test') {
    throw new Error('Standalone artifact acceptance requires an explicitly disposable PostgreSQL test database.');
  }
  require('./require-test-database');
  const name = 'artifact-ui-' + crypto.randomUUID();
  const fixtureDirectory = path.join(ROOT, 'scratch', name);
  const directory = path.join(ROOT, 'playwright', 'report', 'artifact-versions-' + Date.now());
  fs.mkdirSync(fixtureDirectory, { recursive: true }); fs.mkdirSync(directory, { recursive: true });
  const port = await unusedPort(); const origin = 'http://127.0.0.1:' + port;
  Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', STORAGE_ROOT: path.join(fixtureDirectory, 'storage'), FRONTEND_ORIGIN: origin });
  const utils = require('../backend/_http-test-utils'); const db = utils.db;
  const storage = require('../backend/storage'); const provider = storage.createLocalStorageProvider();
  let server, browser, vite, activePage; let output = '';
  try {
    server = await utils.startServer(); await db.resetSchemaForTests();
    const owner = await utils.createUserWithToken({ email: 'artifact-browser-owner@example.test', displayName: 'Browser researcher' });
    const viewer = await utils.createUserWithToken({ email: 'artifact-browser-viewer@example.test', displayName: 'Browser viewer' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Browser artifact laboratory' });
    const project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Immutable artifact inspection' });
    const other = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Separate study' });
    await db.addProjectMemberByEmail(project.id, viewer.user.email, 'viewer', { userId: owner.user.id });
    const object = await db.createProjectAnalysisObject(owner.user.id, project.id, { objectType: 'seurat', displayName: 'Existing saved analysis' });
    const job = await db.createProjectJob(owner.user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    const checkpoint = db.genId('art'); const key = storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'checkpoint.rds');
    const opaque = Buffer.from('Opaque checkpoint: never deserialize this acceptance fixture.');
    fs.writeFileSync(provider.prepareWrite(key), opaque);
    await db.query("INSERT INTO job_artifacts(id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')", [checkpoint, project.id, job.id, owner.user.id, object.id, key, crypto.createHash('sha256').update(opaque).digest('hex'), opaque.length]);
    const backendOrigin = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(path.join(fixtureDirectory, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Artifact inspection acceptance</title><link rel="icon" href="data:,"></head><body><main id="root"></main><script type="module" src="./harness.jsx"></script></body></html>');
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
    const projectViteConfig = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts'].find(file => fs.existsSync(path.join(ROOT, file)));
    fs.writeFileSync(configPath, `import config from '../../${projectViteConfig}'; export default {...config,server:{...config.server,watch:null}};`);
    vite = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', configPath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, env: { ...process.env, VITE_API_BASE_URL: backendOrigin }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const append = chunk => { output = (output + chunk).slice(-16000); }; vite.stdout.on('data', append); vite.stderr.on('data', append);
    const deadline = Date.now() + 30000; let ready = false;
    while (Date.now() < deadline) {
      if (vite.exitCode !== null) throw new Error('UI server exited: ' + output);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) throw new Error('UI server did not become ready: ' + output);
    browser = await chromium.launch({ headless: true });
    const cookie = require('../backend/config').sessionCookieName();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addCookies([{ name: cookie, value: owner.token, url: backendOrigin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); activePage = page; const errors = []; const requests = []; const responses = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser page error: ' + error.message); });
    page.on('request', request => { if (request.url().startsWith(backendOrigin)) requests.push({ method: request.method(), path: new URL(request.url()).pathname }); });
    page.on('response', response => { if (response.url().startsWith(backendOrigin)) responses.push({ status: response.status(), path: new URL(response.url()).pathname }); });
    const url = origin + '/scratch/' + name + '/index.html';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const region = page.getByRole('region', { name: 'Artifact versions', exact: true });
    await region.getByRole('button', { name: /^Saved analysis/ }).click();
    await region.getByText('Saved checksum verified · preview from this exact version', { exact: true }).waitFor();
    assert(await region.getByText(job.id, { exact: true }).isVisible(), 'Existing checkpoint lost its source-run identity.');
    assert(await region.getByText('org.traceomics.seurat-checkpoint · 1', { exact: true }).isVisible(), 'Existing checkpoint format was absent.');
    const result = await verifyArtifactVersionsUi({ page, artifactDirectory: directory,
      corruptVersion: async reference => {
        const row = (await db.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [reference.versionId])).rows[0];
        fs.writeFileSync(provider.resolveKey(row.storage_key), 'sample,condition,note\nsample-1,control,tampered\n');
      },
      revokeAccess: async () => { await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]); },
    });
    const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await viewerContext.addCookies([{ name: cookie, value: viewer.token, url: backendOrigin, httpOnly: true, sameSite: 'Lax' }]);
    const viewerPage = await viewerContext.newPage(); await viewerPage.goto(url, { waitUntil: 'domcontentloaded' });
    const viewerRegion = viewerPage.getByRole('region', { name: 'Artifact versions', exact: true });
    await viewerRegion.getByText('No saved artifact files are available for your workspace yet.', { exact: true }).waitFor();
    assert(await viewerRegion.getByLabel('Artifact file').count() === 0, 'Viewer received writer-only import controls.');
    const rejectedUpload = await viewerPage.evaluate(async ({ backendOrigin, projectId }) => {
      const body = new FormData(); body.append('file', new Blob(['a\n1']), 'viewer.csv');
      const response = await fetch(backendOrigin + '/api/artifact-versions/' + projectId, { credentials: 'include', method: 'POST', headers: { 'X-Traceomics-Csrf': '1' }, body });
      return { status: response.status, body: await response.json() };
    }, { backendOrigin, projectId: project.id });
    assert(rejectedUpload.status === 403, 'Viewer imported a managed file through the real API.');
    await viewerPage.screenshot({ path: path.join(directory, 'viewer-permissions.png'), fullPage: true });
    await db.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [project.id, owner.user.id]);
    const wrongProject = await page.evaluate(async ({ backendOrigin, otherId, versionId }) => {
      const response = await fetch(backendOrigin + '/api/artifact-versions/' + otherId + '/' + versionId + '/preview', { credentials: 'include' });
      return response.status;
    }, { backendOrigin, otherId: other.id, versionId: result.references.original.versionId });
    assert(wrongProject === 404, 'An exact managed version crossed the project boundary.');
    assert(!requests.some(request => request.path.startsWith('/api/r')), 'Artifact inspection invoked a shared R endpoint.');
    assert(errors.length === 0, 'Browser errors: ' + errors.join('; '));
    result.checks.unshift('Existing saved checkpoint adapts to generic object metadata with verified bytes and exact source run.');
    result.checks.push('Actual viewer project role hides imports; API denies uploads and wrong-project previews.');
    fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify({ ...result, noEndpointMocks: true, actualProjectHistory: true, scientificDeserializationVerified: false, requests, responses }, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, checks: result.checks, directory }));
  } catch (error) {
    if (activePage) {
      await activePage.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(directory, 'failure.txt'), error.message + '\n' + await activePage.locator('body').innerText().catch(() => '') + '\n' + output);
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (vite?.exitCode === null) { const exited = new Promise(resolve => vite.once('exit', resolve)); vite.kill('SIGTERM'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]); }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await db.close();
  }
}

if (require.main === module) standalone().catch(error => { console.error(error.message); process.exitCode = 1; });
