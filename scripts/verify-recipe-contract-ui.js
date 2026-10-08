#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_WORKFLOW = Object.freeze({
  format: 'traceomics-workflow', schemaVersion: 1, id: 'browser-summary', name: 'Browser cell summary', version: '1.0.0', description: 'Count cells from the selected saved analysis.',
  runtime: { language: 'r', profileId: 'test-profile' }, files: { 'summary.R': 'write_output("summary", list(cells = ncol(inputs$analysis)))' },
  steps: [{ id: 'summary', label: 'Summary', entry: 'summary.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } }, parameters: [], outputs: { summary: { type: 'metrics', label: 'Cell count' } } }],
  tabs: [{ id: 'summary', label: 'Summary', step: 'summary', plots: [] }],
});

function assert(condition, message) { if (!condition) throw new Error(message); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

async function verifyRecipeContractUi({ page, artifactDirectory, legacyWorkflow = LEGACY_WORKFLOW, verifyLegacyOpen } = {}) {
  if (!page) throw new Error('A browser page displaying the workflow library is required.');
  const directory = artifactDirectory || path.join(ROOT, 'playwright', 'report', 'recipe-contract-' + Date.now());
  fs.mkdirSync(directory, { recursive: true });
  const library = page.getByRole('region', { name: 'Workflow pipelines', exact: true });
  await library.waitFor({ state: 'visible', timeout: 30000 });
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'analysis-model', 'tissue-image-inspection.json'), 'utf8'));
  const recipe = fixture.recipe;
  const checks = [];
  const upload = async value => library.getByLabel('Workflow package file').setInputFiles({
    name: 'research-method.pipeline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)),
  });

  await upload(recipe);
  await library.getByText('Valid recipe · execution unavailable', { exact: true }).waitFor();
  await library.locator('summary').filter({ hasText: 'Required capabilities' }).click();
  assert(await library.getByText('No installed executor supports workflow schema 2.', { exact: true }).isVisible(), 'The valid recipe did not explain its unsupported executor schema.');
  assert(await library.getByText(/No human operation executor is installed\./).isVisible(), 'The human-operation capability requirement was absent.');
  assert(await library.getByText(/No tool operation executor is installed\./).isVisible(), 'The external-tool capability requirement was absent.');
  await library.getByText('Review source and environment files', { exact: true }).click();
  assert(await library.locator('pre').filter({ hasText: recipe.files['tools/preview.json'] }).isVisible(), 'The reviewed source was missing or changed.');
  await library.getByText('Review source and environment files', { exact: true }).click();
  await page.screenshot({ path: path.join(directory, 'recipe-review.png'), fullPage: true });
  checks.push('Valid schema-2 recipe displays source, roots, operations and precise execution requirements.');

  await library.getByRole('button', { name: 'Install Tissue inspection', exact: true }).click();
  assert(await library.getByRole('button', { name: 'Open Tissue inspection', exact: true }).isDisabled(), 'A schema-2 recipe could be dispatched to the legacy executor.');
  const [download] = await Promise.all([
    page.waitForEvent('download'), library.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert(same(exported, recipe), 'Recipe export changed its published source or metadata.');
  checks.push('Schema-2 version installs and exports unchanged while Open remains disabled.');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await library.waitFor({ state: 'visible' });
  assert(await library.getByRole('button', { name: 'Open Tissue inspection', exact: true }).isDisabled(), 'A persisted schema-2 recipe bypassed execution validation.');
  checks.push('Persisted recipe remains valid and execution-disabled after browser reload.');

  const invalid = JSON.parse(JSON.stringify(recipe));
  invalid.steps[1].bindings.image.port = 'missing';
  await upload(invalid);
  await library.getByRole('alert').filter({ hasText: 'root input missing does not exist' }).waitFor();
  assert(await library.getByRole('button', { name: 'Install Tissue inspection', exact: true }).count() === 0, 'An invalid binding still allowed installation.');
  checks.push('Inconsistent binding fails with its operation/input path before execution.');

  await upload(legacyWorkflow);
  await library.getByRole('button', { name: `Install ${legacyWorkflow.name}`, exact: true }).click();
  const open = library.getByRole('button', { name: `Open ${legacyWorkflow.name}`, exact: true });
  assert(await open.isEnabled(), 'Existing schema-1 workflow could no longer open.');
  await open.click();
  if (verifyLegacyOpen) await verifyLegacyOpen(legacyWorkflow);
  checks.push('Existing schema-1 import/open preserves its original executable package contract.');
  await page.screenshot({ path: path.join(directory, 'legacy-compatible.png'), fullPage: true });
  fs.writeFileSync(path.join(directory, 'acceptance.json'), JSON.stringify({ passed: true, checks, scientificExecutionVerified: false }, null, 2) + '\n');
  return { passed: true, checks, directory };
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function standalone() {
  const name = 'recipe-ui-' + crypto.randomUUID();
  const fixtureDirectory = path.join(ROOT, 'scratch', name);
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  fs.writeFileSync(path.join(fixtureDirectory, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workflow library acceptance</title><link rel="icon" href="data:,"></head><body><main id="root"></main><script type="module" src="./harness.jsx"></script></body></html>');
  fs.writeFileSync(path.join(fixtureDirectory, 'harness.jsx'), `import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowLibrary from '/src/components/WorkflowLibrary.jsx';
import '/src/App.css';
window.__openedWorkflow = null;
createRoot(document.getElementById('root')).render(<div className="mx-auto max-w-5xl p-8"><WorkflowLibrary userEmail="recipe-browser@example.test" projectId="project-browser" selectedObject={{id:'analysis-browser'}} enabled runtimeProfileId="test-profile" onOpen={instance => { window.__openedWorkflow = instance; }} /></div>);
`);
  const port = await unusedPort();
  const origin = 'http://127.0.0.1:' + port;
  const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; let browser;
  const append = chunk => { output = (output + chunk).slice(-16000); };
  vite.stdout.on('data', append); vite.stderr.on('data', append);
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      if (vite.exitCode !== null) throw new Error('UI server exited: ' + output);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) throw new Error('UI server did not become ready: ' + output);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const requests = []; const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/workflows/project-browser/open', async route => {
      const body = route.request().postDataJSON();
      const workflow = JSON.parse(body.source);
      requests.push({ body, workflow });
      assert(workflow.schemaVersion === 1, 'The browser dispatched a schema-2 recipe to the legacy endpoint.');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'legacy-browser-instance', package: workflow }) });
    });
    await page.goto(origin + '/scratch/' + name + '/index.html', { waitUntil: 'domcontentloaded' });
    const result = await verifyRecipeContractUi({ page, verifyLegacyOpen: async workflow => {
      await page.waitForFunction(() => window.__openedWorkflow?.id === 'legacy-browser-instance');
      assert(requests.length === 1 && same(requests[0].workflow, workflow), 'The legacy package changed or an unsupported recipe was submitted.');
      assert(requests[0].body.analysisObjectId === 'analysis-browser', 'The selected saved analysis was not bound.');
    } });
    assert(pageErrors.length === 0, 'Browser component errors: ' + pageErrors.join('; '));
    console.log(JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    if (vite.exitCode === null) {
      const exited = new Promise(resolve => vite.once('exit', resolve));
      vite.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
  }
}

module.exports = { verifyRecipeContractUi, LEGACY_WORKFLOW };
if (require.main === module) standalone().catch(error => { console.error(error.message); process.exitCode = 1; });
