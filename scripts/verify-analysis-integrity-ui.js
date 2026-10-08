#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { assertRestoredAnalysisResults } = require('./verify-restored-results-ui');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function waitFor(check, message, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(message);
}
async function navigate(page, label) {
  await page.getByRole('button', { name: new RegExp('^' + label + '(?:,|$)', 'i') }).click();
}
async function pipelineState(page, objectId) {
  return page.evaluate(id => window.electronAPI.apiRequest('/pipeline-state', {
    headers: { 'X-Object-ID': id },
  }), objectId);
}

async function runAnalysisIntegrityAcceptance({ origin, restartInteractiveRuntime, artifactDirectory, expectedDataset = 'synthetic' } = {}) {
  assert(['synthetic', 'pbmc3k'].includes(expectedDataset), 'Unsupported integrity acceptance dataset.');
  const pbmc = expectedDataset === 'pbmc3k';
  const target = new URL(origin);
  assert(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname)
    && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash,
  'Analysis integrity acceptance requires the disposable loopback demo.');
  assert(typeof restartInteractiveRuntime === 'function', 'A disposable runtime restart callback is required.');
  const output = artifactDirectory || path.join(__dirname, '..', 'playwright', 'report',
    'analysis-integrity-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(output, { recursive: true });
  const pageErrors = [];
  const serverErrors = [];
  const checks = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 500) serverErrors.push(response.status() + ' ' + new URL(response.url()).pathname);
  });
  page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto(target.origin, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Start temporary demo', exact: true }).click();
    await page.getByRole('heading', { name: /^TraceOmics Workbench/ }).waitFor();
    await page.getByText('Curated single-cell demo', { exact: true }).first().waitFor();
    const identity = await page.evaluate(async () => {
      const projects = await window.electronAPI.listProjects();
      const objects = await window.electronAPI.listProjectAnalysisObjects(projects[0].id);
      return { projectId: projects[0].id, objectId: objects[0].id, savedName: objects[0].displayName };
    });

    await navigate(page, 'Runs & Results');
    await page.getByRole('button', { name: 'Restore saved version', exact: true }).click();
    await waitFor(async () => {
      const state = await pipelineState(page, identity.objectId);
      return state.exists === true && state.has_unsaved_changes === false;
    }, 'Restoring a saved version did not establish a clean baseline.');
    await page.getByRole('heading', { name: 'Open a saved version', exact: true }).waitFor({ state: 'detached' });
    assert(await page.getByText('Unsaved live changes.', { exact: true }).count() === 0,
      'A freshly restored checkpoint was marked dirty.');
    checks.push('restored checkpoint is clean');

    const restoredResults = await assertRestoredAnalysisResults({
      page, objectId: identity.objectId, artifactDirectory: path.join(output, 'restored-results'),
    });
    checks.push(...restoredResults.checks);

    const mappingResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/r/meta-values' && url.searchParams.get('column') === 'sample_id'
        && response.status() === 200;
    });
    await navigate(page, 'Study Design');
    const mappedValues = await (await mappingResponse).json();
    assert(mappedValues.n_unique === (pbmc ? 1 : 4), 'Unexpected biological sample group count.');
    if (pbmc) {
      await page.getByText('10x PBMC3k: sample_id = PBMC3k', { exact: true }).waitFor();
      await page.getByText(/This analysis contains one sample_id group/).waitFor();
      checks.push('PBMC3k correctly identifies one biological sample');
    } else {
      await page.getByText('Control replicate 1: sample_id = C1', { exact: true }).waitFor();
      assert(await page.getByText(/This analysis contains one/).count() === 0,
        'The multi-sample cohort displayed a single-sample warning.');
      checks.push('sample_id mappings avoid false orig.ident warning');
    }
    await page.screenshot({ path: path.join(output, 'study-design.png') });

    await navigate(page, 'UMAP');
    await page.getByRole('button', { name: /Run 2D UMAP|Re-compute UMAP/ }).first().click();
    await page.getByText('Unsaved live changes.', { exact: true }).waitFor({ timeout: 180_000 });
    const dirty = await waitFor(async () => {
      const state = await pipelineState(page, identity.objectId);
      return state.has_unsaved_changes === true ? state : null;
    }, 'UMAP did not mark the private live object as changed.');
    assert(dirty.live_revision > dirty.saved_revision, 'The server revision did not advance.');
    checks.push('live UMAP mutation is unsaved');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Unsaved live changes.', { exact: true }).waitFor();
    const inputNotice = await page.getByRole('status').filter({ hasText: 'Unsaved live changes.' }).innerText();
    assert(inputNotice.includes('Queued analyses use the saved version') && identity.savedName && inputNotice.includes(identity.savedName),
      'The warning did not identify the saved input used by queued analysis.');
    await page.screenshot({ path: path.join(output, 'dirty-after-reload.png') });
    checks.push('unsaved warning survives browser reload');

    await page.getByRole('button', { name: 'Save current analysis', exact: true }).click();
    await page.getByText('Saved and opened as a durable analysis version.', { exact: true })
      .waitFor({ timeout: 180_000 });
    const savedId = await page.evaluate(async projectId => {
      const objects = await window.electronAPI.listProjectAnalysisObjects(projectId);
      return objects[0].id;
    }, identity.projectId);
    assert(savedId !== identity.objectId, 'Saving did not create a new immutable analysis version.');
    const savedState = await pipelineState(page, savedId);
    assert(savedState.exists === true && savedState.has_unsaved_changes === false,
      'The newly saved version did not have a clean live baseline.');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitFor(async () => {
      const state = await pipelineState(page, savedId);
      return state.exists === true && state.has_unsaved_changes === false;
    }, 'The clean saved baseline did not survive reload.');
    assert(await page.getByText('Unsaved live changes.', { exact: true }).count() === 0,
      'A clean saved version became dirty after reload.');
    checks.push('save opens a clean child version across reload');

    await restartInteractiveRuntime();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(/Live analysis is unavailable. Restore a saved version/).waitFor({ timeout: 60_000 });
    assert(await page.getByText('Unsaved live changes.', { exact: true }).count() === 0,
      'A lost R session retained a misleading dirty flag.');
    await navigate(page, 'UMAP');
    await page.getByRole('heading', { name: 'PCA Required', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: /Run 2D UMAP|Re-compute UMAP/ }).count() === 0,
      'The UMAP compute action remained available after its live object was lost.');
    await page.screenshot({ path: path.join(output, 'runtime-recovery.png') });
    checks.push('runtime loss clears live availability and offers recovery');

    await page.getByRole('button', { name: 'Open Runs & Results', exact: true }).first().click();
    await page.getByRole('button', { name: 'Restore saved version', exact: true }).click();
    await waitFor(async () => {
      const state = await pipelineState(page, savedId);
      return state.exists === true && state.has_unsaved_changes === false;
    }, 'Restoring the saved version after a runtime restart failed.');
    await page.getByText(/Live analysis is unavailable. Restore a saved version/).waitFor({ state: 'detached' });
    checks.push('saved analysis recovers after runtime restart');

    assert(pageErrors.length === 0, 'Browser errors: ' + pageErrors.join(' | '));
    assert(serverErrors.length === 0, 'Server errors: ' + serverErrors.join(' | '));
    const result = { completedAt: new Date().toISOString(), checks, pageErrors, serverErrors };
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    return { artifactDirectory: output, ...result };
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({
      error: error.message, checks, pageErrors, serverErrors,
    }, null, 2) + '\n');
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}
module.exports = { runAnalysisIntegrityAcceptance };
