#!/usr/bin/env node
'use strict';

// Work through the Seurat PBMC3k tutorial in the running app the way a person
// does: sign up, create a project, load the PBMC 3k dataset, apply QC,
// normalize, run PCA, cluster and UMAP with the tutorial's settings, save the
// UMAP figure to the project gallery, export its history, and save the
// analysis. Writes a JSON report plus the exported R script and screenshots.
//
//   APP_URL=http://localhost:5173 node scripts/verify-pbmc3k-tutorial-ui.js <out-dir>
//
// Compare the saved analysis with Seurat run directly using
// scripts/compare-pbmc3k-tutorial.R.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const OUT = path.resolve(process.argv[2] || 'playwright/report/pbmc3k-tutorial');
const STEP_TIMEOUT = Number(process.env.STEP_TIMEOUT_MS || 240000);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('dialog', (dialog) => dialog.accept());
  const report = { startedAt: new Date().toISOString(), steps: [], issues: [] };
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
  let shot = 0;
  const snap = async (name) => page.screenshot({ path: path.join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`) });
  const step = async (name, work) => {
    const started = Date.now();
    try {
      const detail = await work();
      report.steps.push({ name, ok: true, seconds: (Date.now() - started) / 1000, ...(detail ? { detail } : {}) });
      await snap(name);
    } catch (error) {
      report.steps.push({ name, ok: false, seconds: (Date.now() - started) / 1000, error: String(error.message).slice(0, 500) });
      await snap(`${name}-failed`).catch(() => {});
      throw error;
    }
  };
  const nav = (label) => page.locator('nav, aside').getByText(label, { exact: true }).first().click();
  const rCall = (pattern) => page.waitForResponse((response) => pattern.test(response.url()) && response.status() !== 429, { timeout: STEP_TIMEOUT });

  try {
    const email = `tutorial-${Date.now()}@lab.example`;
    await step('sign-up', async () => {
      await page.goto(APP_URL);
      await page.getByRole('button', { name: 'Sign up' }).click();
      await page.getByRole('textbox', { name: 'Full name' }).fill('Tutorial Runner');
      await page.getByRole('textbox', { name: 'Email' }).fill(email);
      await page.getByRole('textbox', { name: 'Password', exact: true }).fill('Correct-Horse-Battery-9');
      await page.getByRole('textbox', { name: 'Confirm password' }).fill('Correct-Horse-Battery-9');
      await page.getByRole('button', { name: 'Create account' }).click();
      await page.getByRole('heading', { name: 'Projects' }).waitFor({ timeout: 60000 });
    });
    await step('create-project', async () => {
      await page.getByRole('button', { name: /^(Create project|New project)$/ }).first().click();
      await page.getByPlaceholder('Project Name').fill('PBMC3k tutorial');
      await page.getByPlaceholder('Project Name').press('Enter');
      await page.getByRole('button', { name: 'Add dataset' }).waitFor({ timeout: 30000 });
    });
    await step('load-pbmc3k', async () => {
      await page.getByRole('button', { name: 'Add dataset' }).click();
      const loaded = rCall(/\/api\/r\/load-data/);
      await page.getByText('PBMC 3k Demo Dataset', { exact: true }).click();
      await loaded;
      await page.getByRole('button', { name: 'Open Quality Control' }).waitFor({ timeout: STEP_TIMEOUT });
      return { summary: (await page.locator('main').innerText()).match(/Cells\s+([\d,]+)\s+Features\s+([\d,]+)/)?.slice(1) };
    });
    await step('quality-control', async () => {
      await page.getByRole('button', { name: 'Open Quality Control' }).click();
      const done = rCall(/\/api\/r\/qc(\?|$)/);
      await page.getByRole('button', { name: /Apply QC Filters/ }).click();
      await done;
      await page.getByText('Post-filter cells').waitFor({ timeout: STEP_TIMEOUT });
      const text = await page.getByText('Post-filter cells').locator('..').innerText();
      return { postFilterCells: Number(text.replace(/[^\d]/g, '')) };
    });
    await step('normalize', async () => {
      await nav('Normalize');
      const done = rCall(/\/api\/r\/normalize/);
      await page.getByRole('button', { name: 'Run Normalization' }).click();
      await done;
      await page.getByText(/variable features identified/).waitFor({ timeout: STEP_TIMEOUT });
    });
    await step('pca', async () => {
      await nav('PCA');
      await page.getByRole('button', { name: /^(Run PCA|Re-run PCA)$/ }).waitFor();
      await page.waitForTimeout(1500);
      const done = rCall(/\/api\/r\/pca\?/);
      await page.getByRole('button', { name: /^(Run PCA|Re-run PCA)$/ }).click();
      const response = await done;
      return { url: response.url().replace(/^.*\/api\/r/, ''), status: response.status() };
    });
    await step('cluster', async () => {
      await nav('Cluster');
      await page.locator('#cluster-dims').waitFor();
      const settings = { resolution: await page.locator('#cluster-res').inputValue(), dims: await page.locator('#cluster-dims').inputValue() };
      const done = rCall(/\/api\/r\/cluster/);
      await page.getByRole('button', { name: /^(Run Clustering|Re-Cluster)$/ }).click();
      const response = await done;
      return { settings, url: response.url().replace(/^.*\/api\/r/, ''), status: response.status() };
    });
    await step('umap', async () => {
      await nav('UMAP');
      await page.locator('#umap-dims').waitFor();
      const settings = { dims: await page.locator('#umap-dims').inputValue(), neighbors: await page.locator('#umap-neighbors').inputValue(),
        minDist: await page.locator('#umap-dist').inputValue() };
      const done = rCall(/\/api\/r\/umap/);
      await page.getByRole('button', { name: /Run 2D UMAP|Re-compute UMAP/ }).click();
      const response = await done;
      await page.waitForTimeout(3000);
      const groups = await page.getByRole('region', { name: 'Cell group counts' }).innerText().catch(() => '');
      return { settings, url: response.url().replace(/^.*\/api\/r/, ''), groups: groups.split('\n').filter(Boolean).slice(0, 40) };
    });
    let figureId = null;
    await step('save-umap-figure', async () => {
      await page.getByRole('button', { name: /Save Figure/ }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Title', { exact: true }).fill('Figure 1: PBMC3k clusters');
      await dialog.getByLabel('Collection').fill('Figure 1');
      await dialog.getByLabel('Tags (comma-separated)').fill('tutorial, umap');
      const save = dialog.getByRole('button', { name: /Save to Figure Gallery/ });
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('[role=dialog] button')].find((b) => /Save to Figure Gallery/.test(b.textContent));
        return button && !button.disabled;
      }, null, { timeout: STEP_TIMEOUT });
      const created = page.waitForResponse((response) => /\/api\/projects\/[^/]+\/figures$/.test(response.url()) && response.request().method() === 'POST');
      await save.click();
      const response = await created;
      figureId = (await response.json()).id;
      await dialog.getByText(/Saved to the/).waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'Close figure editor' }).click();
      return { figureId, status: response.status() };
    });
    await step('gallery-export-history', async () => {
      await nav('Figure gallery');
      await page.getByRole('button', { name: /Select Figure 1: PBMC3k clusters/ }).click();
      const bundleResponse = page.waitForResponse((response) => /\/figures\/bundles$/.test(response.url()));
      await page.getByRole('button', { name: /Export with history/ }).first().click();
      const bundle = await (await bundleResponse).json();
      fs.writeFileSync(path.join(OUT, 'figure-bundle.json'), JSON.stringify(bundle, null, 2));
      fs.writeFileSync(path.join(OUT, 'figure-bundle.R'), bundle.script);
      await page.getByRole('dialog').getByText(/Keeps/).waitFor();
      await snap('export-dialog');
      await page.getByRole('button', { name: 'Close export' }).click();
      return { kept: bundle.summary?.kept, steps: bundle.steps?.map((s) => s.operation), unresolved: bundle.unresolved };
    });
    await step('save-analysis', async () => {
      const saved = page.waitForResponse((response) => /\/checkpoint/.test(response.url()) || /\/jobs$/.test(response.url()), { timeout: STEP_TIMEOUT }).catch(() => null);
      await page.locator('button', { hasText: /^Save$/ }).first().click();
      await saved;
      await page.waitForFunction(() => !/Unsaved live changes/.test(document.body.innerText), null, { timeout: STEP_TIMEOUT });
      await page.getByText('Analysis saved').first().waitFor({ timeout: STEP_TIMEOUT });
    });
    await step('find-markers', async () => {
      await nav('Markers / DEG');
      await page.getByRole('button', { name: 'Run marker analysis' }).waitFor({ timeout: 30000 });
      // The tutorial: FindAllMarkers(only.pos = TRUE, min.pct = 0.25, logfc.threshold = 0.25).
      await page.getByLabel('min.pct').fill('0.25');
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Run marker analysis'));
        return button && !button.disabled;
      }, null, { timeout: STEP_TIMEOUT });
      const minPctBeforeRun = await page.getByLabel('min.pct').inputValue();
      await page.getByRole('button', { name: 'Run marker analysis' }).click();
      const deadline = Date.now() + STEP_TIMEOUT;
      let text = '';
      while (Date.now() < deadline) {
        await page.waitForTimeout(5000);
        text = await page.locator('main').innerText();
        if (/failed|unavailable/i.test(text) && !/Running|queued/i.test(text)) break;
        if (/Marker analysis summary/.test(text) && /Outcome\s+Complete/.test(text)) break;
        const refresh = page.getByRole('button', { name: 'Refresh' });
        if (await refresh.isVisible().catch(() => false)) await refresh.click().catch(() => {});
      }
      fs.writeFileSync(path.join(OUT, 'markers-page.txt'), text);
      return { minPctBeforeRun, excerpt: text.slice(0, 600) };
    });
  } catch (error) {
    report.error = String(error.message).slice(0, 1000);
    process.exitCode = 1;
  } finally {
    report.consoleErrors = consoleErrors.slice(0, 50);
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    console.log(JSON.stringify(report.steps.map((s) => [s.name, s.ok, s.seconds]), null, 0));
    if (report.error) console.error(report.error);
  }
}

main();
