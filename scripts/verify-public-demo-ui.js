#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function timestampSegment() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw lastError || new Error(message);
}

function validateOrigin(value, { allowLoopbackHttp = false } = {}) {
  let origin;
  try {
    origin = new URL(String(value || ''));
  } catch {
    throw new Error('Set PUBLIC_DEMO_ORIGIN to the exact deployed HTTPS origin.');
  }
  assert(!origin.username && !origin.password && origin.pathname === '/'
    && !origin.search && !origin.hash, 'The public demo origin must not contain credentials, a path, query, or fragment.');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(origin.hostname);
  assert(origin.protocol === 'https:' || (allowLoopbackHttp && loopback && origin.protocol === 'http:'),
    'Public demo acceptance requires HTTPS; only the disposable loopback harness may use HTTP.');
  return origin.origin;
}

function observePage(page, diagnostics) {
  page.on('pageerror', error => diagnostics.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('response', response => {
    let pathname = '';
    try { pathname = new URL(response.url()).pathname; } catch { /* keep empty */ }
    if (response.status() === 401 && pathname === '/api/auth/session') {
      diagnostics.expectedSession401.push(response.url());
      return;
    }
    if (response.status() >= 500) diagnostics.serverErrors.push(`${response.status()} ${response.url()}`);
    if (response.status() === 429) diagnostics.rateLimits.push(response.url());
    else if (response.status() >= 400) diagnostics.clientErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', request => {
    diagnostics.requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
  });
}

async function openSidebarPage(page, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const button = page.getByRole('button', { name: new RegExp(`^${escaped}(?:,|$)`, 'i') });
  await button.waitFor({ state: 'visible', timeout: 30_000 });
  await button.click();
}

async function waitForVisibleUmap(page, timeout = 60_000) {
  await page.waitForFunction(() => (
    [...document.querySelectorAll('.js-plotly-plot')].some(element => {
      const rectangle = element.getBoundingClientRect();
      const visible = rectangle.width > 0 && rectangle.height > 0
        && window.getComputedStyle(element).visibility !== 'hidden';
      const hasData = Array.isArray(element.data)
        && element.data.some(trace => Array.isArray(trace?.x) && trace.x.length > 0);
      const hasRenderedMarks = element.querySelectorAll('.scatterlayer .point').length > 0
        || element.querySelectorAll('canvas').length > 0;
      return visible && hasData && hasRenderedMarks
        && !/WebGL is not supported/i.test(element.textContent || '');
    })
  ), null, { timeout });
}

async function runPublicDemoAcceptance({ origin, artifactDirectory, allowLoopbackHttp = false } = {}) {
  const acceptedOrigin = validateOrigin(origin, { allowLoopbackHttp });
  const runDirectory = artifactDirectory || path.join(
    root, 'playwright', 'report', 'release-acceptance', `demo-ui-${timestampSegment()}`
  );
  fs.mkdirSync(runDirectory, { recursive: true });

  const diagnostics = {
    pageErrors: [], consoleErrors: [], serverErrors: [], clientErrors: [], rateLimits: [],
    requestFailures: [], expectedSession401: [],
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: runDirectory, size: { width: 1440, height: 1000 } },
    });
    const page = await context.newPage();
    observePage(page, diagnostics);

    await page.goto(acceptedOrigin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const start = page.getByRole('button', { name: 'Start temporary demo', exact: true });
    await start.waitFor({ state: 'visible', timeout: 30_000 });
    assert(await page.getByText(/uploads and Expert R are disabled/i).count() > 0,
      'The public demo policy notice was not visible before guest creation.');
    await start.click();

    await page.getByRole('heading', { name: /^TraceOmics Workbench/ })
      .waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByText('Curated single-cell demo', { exact: true }).first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    const expertRButtons = page.getByRole('button', { name: /^Advanced analysis, Access required$/i });
    await expertRButtons.first().waitFor({ state: 'visible', timeout: 30_000 });
    const expertRCount = await expertRButtons.count();
    assert(expertRCount > 0, 'The public demo did not expose its disabled Expert R capability state.');
    for (let index = 0; index < expertRCount; index += 1) {
      assert(await expertRButtons.nth(index).isDisabled(),
        'Every Expert R entry must remain disabled in the public demo.');
    }

    await openSidebarPage(page, 'Runs & Results');
    await page.getByRole('heading', { name: 'Runs & Results', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    const attach = page.getByRole('button', { name: 'Restore saved version', exact: true });
    await attach.waitFor({ state: 'visible', timeout: 30_000 });
    await attach.click();
    const checkpointJob = await waitFor(async () => page.evaluate(async () => {
      const projects = await window.electronAPI.listProjects();
      const project = Array.isArray(projects) ? projects[0] : null;
      if (!project?.id) return null;
      const objects = await window.electronAPI.listProjectAnalysisObjects(project.id);
      const object = Array.isArray(objects) ? objects[0] : null;
      if (!object?.id) return null;
      const jobs = await window.electronAPI.listProjectJobs(project.id, {
        jobType: 'checkpoint.load.v1', analysisObjectId: object.id,
      });
      const latest = Array.isArray(jobs) ? jobs[0] : null;
      return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
    }), 180_000, 'The public demo checkpoint job did not reach a terminal state.');
    assert(checkpointJob.status === 'completed',
      `The public demo checkpoint job ${checkpointJob.status}: ${checkpointJob.error?.message || 'unknown error'}`);
    const umapNavigation = page.getByRole('button', { name: /^UMAP(?:,|$)/i });
    await umapNavigation.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => {
      const candidate = [...document.querySelectorAll('button')]
        .find(button => /^UMAP(?:,|$)/i.test(button.getAttribute('aria-label') || button.textContent || ''));
      return Boolean(candidate && !candidate.disabled);
    }, null, { timeout: 180_000 });
    await page.getByRole('heading', { name: 'Open a saved version', exact: true })
      .waitFor({ state: 'detached', timeout: 30_000 });

    await openSidebarPage(page, 'UMAP');
    await page.getByRole('heading', { name: 'UMAP Embedding', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    try {
      await waitForVisibleUmap(page, 5_000);
    } catch {
      const runUmap = page.getByRole('button', { name: /Run 2D UMAP|Re-compute UMAP/ }).first();
      await runUmap.waitFor({ state: 'visible', timeout: 30_000 });
      await runUmap.click();
      await waitForVisibleUmap(page, 180_000);
    }
    const umapPath = path.join(runDirectory, 'public-demo-umap.png');
    await page.screenshot({ path: umapPath, fullPage: false });

    await openSidebarPage(page, 'Exploratory Analysis');
    await page.getByRole('heading', { name: 'Exploratory Analysis', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('button', { name: 'Run recipe', exact: true }).click();
    const explorationJob = await waitFor(async () => page.evaluate(async () => {
      const projects = await window.electronAPI.listProjects();
      const project = Array.isArray(projects) ? projects[0] : null;
      if (!project?.id) return null;
      const jobs = await window.electronAPI.listProjectJobs(project.id, {
        jobType: 'explore.summarize.v1',
      });
      const latest = Array.isArray(jobs) ? jobs[0] : null;
      return latest && ['completed', 'failed', 'canceled'].includes(latest.status) ? latest : null;
    }), 180_000, 'The public demo exploratory job did not reach a terminal state.');
    assert(explorationJob.status === 'completed',
      `The public demo exploratory job ${explorationJob.status}: ${explorationJob.error?.message || 'unknown error'}`);
    await page.getByText('Cells', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.js-plotly-plot').filter({ visible: true }).first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    const explorationPath = path.join(runDirectory, 'public-demo-exploration.png');
    await page.screenshot({ path: explorationPath, fullPage: false });

    assert(diagnostics.pageErrors.length === 0, `Page errors: ${diagnostics.pageErrors.join(' | ')}`);
    const expectedGeneric401 = diagnostics.consoleErrors.filter(message => (
      /Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/i.test(message)
    ));
    const unexpectedConsoleErrors = diagnostics.consoleErrors.filter(message => !expectedGeneric401.includes(message));
    assert(expectedGeneric401.length <= diagnostics.expectedSession401.length,
      `Unmatched console 401 errors: ${expectedGeneric401.join(' | ')}`);
    assert(unexpectedConsoleErrors.length === 0, `Console errors: ${unexpectedConsoleErrors.join(' | ')}`);
    assert(diagnostics.serverErrors.length === 0, `Server errors: ${diagnostics.serverErrors.join(' | ')}`);
    assert(diagnostics.clientErrors.length === 0, `Client errors: ${diagnostics.clientErrors.join(' | ')}`);
    assert(diagnostics.rateLimits.length === 0, `Unexpected rate limits: ${diagnostics.rateLimits.join(' | ')}`);
    assert(diagnostics.requestFailures.length === 0,
      `Request failures: ${diagnostics.requestFailures.join(' | ')}`);

    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.getByRole('button', { name: 'Start temporary demo', exact: true })
      .waitFor({ state: 'visible', timeout: 30_000 });
    await context.close();

    const manifest = {
      completedAt: new Date().toISOString(),
      origin: acceptedOrigin,
      umap: path.basename(umapPath),
      exploration: path.basename(explorationPath),
      videoFormat: 'Playwright WebM',
      diagnostics: Object.fromEntries(Object.entries(diagnostics).map(([key, values]) => [key, values.length])),
    };
    fs.writeFileSync(path.join(runDirectory, 'acceptance.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { runDirectory, manifest };
  } catch (error) {
    fs.writeFileSync(path.join(runDirectory, 'failure.json'), `${JSON.stringify({
      failedAt: new Date().toISOString(), origin: acceptedOrigin, error: error.message, diagnostics,
    }, null, 2)}\n`);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}

if (require.main === module) {
  runPublicDemoAcceptance({ origin: process.env.PUBLIC_DEMO_ORIGIN || process.argv[2] })
    .then(result => {
      console.log('[public-demo-ui] PASS guest checkpoint, visible UMAP, and exploratory workflow');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error(`[public-demo-ui] FAIL ${error.stack || error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { runPublicDemoAcceptance, validateOrigin };
