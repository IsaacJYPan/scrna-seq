#!/usr/bin/env node
'use strict';
// Drives the full researcher workflow in Chromium against a running
// `npm run dev` stack with real R: multi-condition upload, Seurat preparation,
// UMAP, markers, cluster annotation, save, Study Design sample import, edgeR
// pseudobulk, the in-app result, and the full-table download.
//
// Usage:
//   Rscript scripts/make_condition_fixture.R data/pbmc3k/pbmc3k_filtered.h5 /tmp/condition-fixture
//   node scripts/verify-researcher-workflow.js /tmp/condition-fixture [baseUrl]
// The fixture's planted interferon signal is what the pseudobulk check expects.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const dataDir = process.argv[2];
if (!dataDir || !fs.existsSync(dataDir)) {
  console.error('Usage: node scripts/verify-researcher-workflow.js <fixture-dir> [baseUrl]');
  process.exit(2);
}
const base = process.argv[3] || 'http://localhost:5173';
const shots = path.resolve(__dirname, '..', 'playwright', 'report', 'researcher-workflow');
fs.mkdirSync(shots, { recursive: true });
const email = `e2e-${Date.now()}@lab.example`;
const password = 'correct horse battery staple';
const project = `E2E ${new Date().toISOString().slice(11, 19)}`;

const step = (name) => console.log(`\n== ${name}`);
async function waitFor(page, predicate, { timeout = 600000, interval = 3000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await page.waitForTimeout(interval);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const mainText = (page) => page.locator('main').innerText();

(async () => {
  // CHROMIUM_EXECUTABLE selects a preinstalled browser when the bundled
  // Playwright download is unavailable.
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const apiErrors = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/') && r.status() >= 400 && r.status() !== 401) {
      let body = ''; try { body = (await r.text()).slice(0, 160); } catch { /* ignore */ }
      apiErrors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname} ${body}`);
    }
  });
  try {
    step('Sign up');
    await page.goto(base);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await page.getByRole('textbox', { name: 'Full name' }).fill('E2E Researcher');
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
    await page.getByRole('textbox', { name: 'Confirm password' }).fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('button', { name: 'Create project' }).click({ timeout: 30000 });

    step('Create project and upload four donor files');
    await page.getByRole('textbox', { name: 'Project Name' }).fill(project);
    await page.getByRole('textbox', { name: 'Project Name' }).press('Enter');
    await page.getByRole('button', { name: 'Add dataset' }).click();
    await page.getByRole('button', { name: /10X H5 analysis workflow/ }).click();
    await page.getByRole('button', { name: 'Multiple conditions' }).click();
    const files = fs.readdirSync(dataDir).filter(f => /^donor\d_(ctrl|stim)\.h5$/.test(f)).sort();
    await page.getByTestId('seurat-pipeline-upload').setInputFiles(files.map(f => path.join(dataDir, f)));
    await waitFor(page, async () => (await page.getByRole('textbox', { name: /^Condition for donor/ }).count()) === files.length, { label: 'uploads', timeout: 120000 });
    for (const f of files) {
      const [, donor, condition] = f.match(/^donor(\d)_(ctrl|stim)/);
      await page.getByRole('textbox', { name: `Condition for ${f}` }).fill(condition);
      await page.getByRole('textbox', { name: `Donor code for ${f}` }).fill(`D${donor}`);
    }
    const prepare = page.getByRole('button', { name: 'Prepare multi-condition analysis' });
    if (!(await prepare.isEnabled())) throw new Error('Prepare multi-condition analysis stayed disabled after valid uploads');
    await prepare.click();

    step('Wait for multi-condition preparation');
    await waitFor(page, async () => (await page.getByRole('button', { name: 'Open saved version' }).count()) > 0
      && /Complete/.test(await mainText(page)), { label: 'preparation job' });
    const runSummary = await mainText(page);
    if (/\[object Object\]/.test(runSummary)) throw new Error('Run summary still renders [object Object]');
    console.log(runSummary.match(/Cells\n[\d,]+/g));
    await page.getByRole('button', { name: 'Open saved version' }).click();
    await waitFor(page, async () => /Live analysis/.test(await mainText(page)), { label: 'live attach' });

    step('UMAP loads on first visit');
    await page.getByRole('button', { name: 'Inspect this result step by step' }).click();
    await page.getByRole('button', { name: 'UMAP', exact: true }).click();
    await waitFor(page, async () => /Cluster 0/.test(await mainText(page)), { label: 'UMAP', timeout: 30000, interval: 1000 });
    if (/compute is busy/i.test(await mainText(page))) throw new Error('UMAP showed a busy error');
    await page.screenshot({ path: path.join(shots, '01-umap-clusters.png') });

    step('Run marker analysis');
    await page.getByRole('button', { name: /Markers \/ DEG/ }).click();
    await page.getByRole('button', { name: 'Run marker analysis' }).click();
    await waitFor(page, async () => /Top Marker Preview/.test(await mainText(page)), { label: 'marker job' });

    step('Annotate clusters from markers');
    const panel = page.getByTestId('cluster-annotation-panel');
    await waitFor(page, async () => (await panel.getByLabel(/^Label for cluster/).count()) > 0, { label: 'annotation panel', timeout: 30000, interval: 1000 });
    const rows = await panel.locator('tbody tr').allInnerTexts();
    const guess = (markers) => {
      const m = markers.toUpperCase();
      if (/CD79A|MS4A1|IGLL5|VPREB3|LINC00926|TCL1A/.test(m)) return 'B';
      if (/LILRA4|CLEC4C/.test(m)) return 'pDC';
      if (/PPBP|PF4|GP9|LY6G6F|PDZK1IP1/.test(m)) return 'Platelet';
      if (/FCGR3A|VMO1|CKB|ICAM4|MS4A7/.test(m)) return 'FCGR3A Mono';
      if (/CD14|S100A8|S100A12|LYZ|TMEM176B|MARCO/.test(m)) return 'CD14 Mono';
      if (/GNLY|NKG7|AKR1C3|FASLG|RAMP1|SH2D1B/.test(m)) return 'NK';
      if (/CD8A|GZMK|LAG3/.test(m)) return 'CD8 T';
      if (/TNFRSF4|AQP3|CD40LG|TNFRSF18/.test(m)) return 'Memory CD4 T';
      return 'Naive CD4 T';
    };
    const labels = {};
    for (const row of rows) {
      const [cluster, , markers] = row.split('\t');
      labels[cluster.trim()] = guess(markers || '');
      await panel.getByLabel(`Label for cluster ${cluster.trim()}`).fill(labels[cluster.trim()]);
    }
    console.log(labels);
    await panel.getByRole('button', { name: /^Apply/ }).click();
    await waitFor(page, async () => /current identities/.test(await panel.innerText()), { label: 'annotation applied', timeout: 30000, interval: 1000 });
    await panel.getByRole('button', { name: 'Save analysis' }).click();
    await waitFor(page, async () => /Analysis saved/.test(await mainText(page)), { label: 'checkpoint save', timeout: 180000 });

    step('UMAP shows cell types');
    await page.getByRole('button', { name: 'UMAP', exact: true }).click();
    await waitFor(page, async () => /CD14 Mono/.test(await mainText(page)), { label: 'labeled UMAP', timeout: 30000, interval: 1000 });
    await page.screenshot({ path: path.join(shots, '02-umap-celltypes.png') });

    step('Study Design: import recorded samples and run pseudobulk');
    await page.getByRole('button', { name: /^Study design/i }).first().click();
    const recorded = page.getByTestId('recorded-sample-import');
    await recorded.getByRole('button', { name: 'Use recorded samples' }).click({ timeout: 30000 });
    await waitFor(page, async () => /already registered and mapped/.test(await recorded.innerText()), { label: 'sample import', timeout: 60000, interval: 1000 });
    const design = await mainText(page);
    if (!/4 registered samples/.test(design)) throw new Error('Expected 4 registered samples after import');
    await page.getByLabel('Contrast name', { exact: true }).fill('stim_vs_ctrl');
    await page.getByLabel('Numerator condition', { exact: true }).selectOption({ label: 'stim' });
    await page.getByLabel('Denominator condition', { exact: true }).selectOption({ label: 'ctrl' });
    await page.getByLabel('Cell type column', { exact: true }).fill('cell_type');
    await page.getByRole('button', { name: 'Save comparison design' }).click();
    await page.getByRole('button', { name: 'Run edgeR pseudobulk' }).click({ timeout: 30000 });
    await waitFor(page, async () => /Condition comparison started/.test(await mainText(page)), { label: 'pseudobulk submit', timeout: 30000, interval: 1000 });
    await page.screenshot({ path: path.join(shots, '03-study-design.png'), fullPage: true });

    step('Pseudobulk result appears under the contrast');
    const result = page.getByTestId('contrast-result');
    await waitFor(page, async () => (await result.count()) > 0, { label: 'pseudobulk result', timeout: 600000, interval: 5000 });
    const resultText = await result.innerText();
    console.log(resultText.split('\n').slice(0, 8).join('\n'));
    if (!/IFIT3|IFITM3|ISG15|MX1|IFI6|LY6E/.test(resultText)) throw new Error('Expected interferon genes among top pseudobulk results');
    const fdrCells = await result.locator('tbody tr td:nth-child(5)').allInnerTexts();
    if (fdrCells.some(v => v.trim() === '0')) throw new Error('A top-result FDR was rounded to 0');
    await result.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, '03-study-design-result.png') });

    step('Download the full table from Runs & Results');
    await page.getByRole('button', { name: /^Runs & results/i }).first().click();
    const row = page.getByRole('row').filter({ hasText: 'Condition comparison results' }).first();
    await waitFor(page, async () => (await row.count()) > 0, { label: 'result row', timeout: 60000, interval: 2000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      row.getByRole('button', { name: /Download result/ }).click(),
    ]);
    const csvPath = path.join(shots, 'condition_de_results.csv');
    await download.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    console.log(`CSV rows: ${csv.length - 1}; header: ${csv[0]}`);
    if (!/"cell_type","gene","log_fc"/.test(csv[0]) || csv.length < 1000) throw new Error('Unexpected result table');
    await page.screenshot({ path: path.join(shots, '04-runs-results.png') });
    console.log('\nPASS researcher workflow');
  } catch (error) {
    console.error('\nFAIL', error.message);
    await page.screenshot({ path: path.join(shots, 'failure.png'), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (apiErrors.length) console.log('\nAPI errors observed:\n' + apiErrors.join('\n'));
    await browser.close();
  }
})();
