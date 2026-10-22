#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, request } = require('playwright');

async function runGuidedDemoAcceptance({ origin, artifactDirectory } = {}) {
  origin = String(origin).replace(/\/+$/, '');
  const out = artifactDirectory || path.resolve('playwright/report/guided-demo');
  fs.mkdirSync(out, { recursive: true });
  if (fs.existsSync(path.join(out, 'acceptance.json'))) fs.unlinkSync(path.join(out, 'acceptance.json'));
  const diagnostics = { pageErrors: [], serverErrors: [], failures: [], expectedWakeDisconnects: [] };
  const report = { at: new Date().toISOString(), origin, imageId: process.env.GUIDED_DEMO_IMAGE_ID, checks: [], diagnostics };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage();
  let phase = 'entry';
  try {
    page.on('pageerror', error => diagnostics.pageErrors.push(error.message));
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (response.status() >= 500 && !/^\/_traceomics\/(status|wake)$/.test(pathname)) diagnostics.serverErrors.push(response.status() + ' ' + pathname);
    });
    page.on('requestfailed', req => {
      const pathname = new URL(req.url()).pathname;
      const message = pathname + ' ' + req.failure()?.errorText;
      if (/^\/_traceomics\/(status|wake)$/.test(pathname)) diagnostics.expectedWakeDisconnects.push(message);
      else diagnostics.failures.push(message);
    });
    const saved = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('traceomics-analysis-demo-v2')));
    const headers = objectId => ({ 'X-Client-ID': 'guided-demo', 'X-TraceOmics-CSRF': '1', ...(objectId ? { 'X-Object-ID': objectId } : {}) });
    const runtimeState = async () => {
      const current = await saved();
      const response = await context.request.get(origin + '/api/r/pipeline-state', { headers: headers(current.currentObjectId) });
      assert.equal(response.status(), 200); return response.json();
    };
    const run = async (button, status) => {
      const started = Date.now();
      await page.getByRole('button', { name: button, exact: true }).click();
      const outcome = await Promise.race([
        page.getByText(status).waitFor({ timeout: 300_000 }).then(() => 'completed'),
        page.getByRole('alert').waitFor({ timeout: 300_000 }).then(() => 'failed'),
      ]);
      if (outcome === 'failed') throw new Error(await page.getByRole('alert').innerText());
      await page.getByRole('button', { name: 'Reset analysis' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.demo-reset')?.disabled);
      return Date.now() - started;
    };
    const started = Date.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('heading', { name: 'PBMC3k analysis' }).waitFor({ timeout: 240_000 });
    await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.data?.[0]?.y?.length === 2700);
    report.entryMs = Date.now() - started;
    let current = await saved();
    report.testGuestId = current.userId;
    fs.writeFileSync(path.join(out, 'cleanup-target.json'), JSON.stringify({ userId: current.userId, projectId: current.projectId }));
    assert.equal(current.stage, 'input'); assert.equal(current.map, null); assert.equal(current.pca, null);
    assert.equal(current.baseline.n_cells, 2700);
    const text = await page.locator('body').innerText();
    assert(!/No account needed|A few minutes|Meet the|small window|made approachable|A few things/i.test(text));
    assert(text.includes('Some capabilities are disabled'));
    assert(await page.getByRole('tab', { name: /Clustering/ }).isDisabled());
    let state = await runtimeState();
    assert.equal(state.has_pca, false); assert.equal(state.has_umap, false); assert.equal(state.has_normalized, false);
    report.checks.push('Entry shows 2,700 original count cells and QC plots; no prepared PCA, UMAP, or promotional copy');
    await page.screenshot({ path: path.join(out, 'desktop-qc.png') });
    await page.getByRole('button', { name: 'Scatter', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.data?.[0]?.x?.length === 2700);
    await page.waitForFunction(() => document.querySelectorAll('.scatterlayer .point').length === 2700);
    await page.screenshot({ path: path.join(out, 'desktop-qc-scatter.png') });
    phase = 'QC';
    await page.getByLabel('Maximum genes per cell', { exact: true }).fill('2000');
    await page.getByLabel('Minimum RNA counts per cell', { exact: true }).fill('1000');
    report.qcMs = await run('Apply QC', /^QC complete:/);
    current = await saved();
    state = await runtimeState();
    assert.equal(current.appliedQC.max_features, 2000); assert.equal(current.appliedQC.min_counts, 1000);
    assert.equal(current.stage, 'qc'); assert.equal(state.has_pca, false); assert.equal(state.has_umap, false);
    const filtered = (await context.request.get(origin + '/api/r/object-info', { headers: headers(current.currentObjectId) }).then(r => r.json())).n_cells;
    assert(filtered < 2638 && filtered > 60); report.filteredCells = filtered;
    report.checks.push('Chosen QC thresholds change the real retained cells and clear downstream analysis');
    phase = 'PCA';
    await page.getByLabel('Variable genes', { exact: true }).fill('1500');
    await page.getByLabel('Principal components to compute', { exact: true }).fill('20');
    report.pcaMs = await run('Run normalization & PCA', /^PCA complete:/);
    current = await saved();
    assert.equal(current.stage, 'pca'); assert.equal(current.processing.variableFeatures, 1500); assert.equal(current.pca.npcs, 20);
    assert.equal(current.pca.stdevs.length, 20); assert(current.pca.stdevs.every(value => Number.isFinite(value) && value > 0));
    await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.data?.[0]?.y?.length === 20);
    assert.deepEqual(await page.evaluate(() => document.querySelector('.js-plotly-plot').data[0].y), current.pca.stdevs);
    state = await runtimeState(); assert.equal(state.has_pca, true); assert.equal(state.has_umap, false);
    await page.screenshot({ path: path.join(out, 'desktop-pca.png') });
    report.checks.push('User-selected normalization and variable-gene settings generate real PCA and elbow values');
    await page.getByRole('button', { name: 'Continue to clustering', exact: true }).click();
    assert(await page.getByText('UMAP has not been computed').isVisible());
    phase = 'clustering';
    await page.getByLabel('Clustering resolution', { exact: true }).fill('0.8');
    await page.getByLabel('UMAP neighbors', { exact: true }).fill('20');
    await page.getByLabel('UMAP minimum distance', { exact: true }).fill('0.5');
    report.clusteringMs = await run('Run clustering & UMAP', /^Clustering complete:/);
    current = await saved();
    assert.equal(current.stage, 'complete'); assert.equal(current.clustering.resolution, 0.8);
    assert.equal(current.clustering.neighbors, 20); assert.equal(current.clustering.minDist, 0.5);
    assert.equal(current.map.n_cells, filtered); assert(current.map.n_clusters > 0);
    await page.waitForFunction(expected => document.querySelector('.js-plotly-plot')?.data?.reduce((sum, trace) => sum + trace.x.length, 0) === expected, filtered);
    await page.waitForFunction(expected => document.querySelectorAll('.scatterlayer .point').length === expected, filtered);
    report.rerun = { cells: current.map.n_cells, clusters: current.map.n_clusters };
    report.checks.push('User-selected clustering and UMAP settings generate a new real embedding');
    await page.screenshot({ path: path.join(out, 'desktop-umap.png') });
    await page.locator('.demo-chart').hover();
    const downloadPending = page.waitForEvent('download', { timeout: 15_000 });
    await page.locator('.modebar-btn[data-title*="Download"]').click();
    const download = await downloadPending;
    await download.saveAs(path.join(out, 'exported-umap.png'));
    assert.equal(fs.readFileSync(path.join(out, 'exported-umap.png')).subarray(1, 4).toString(), 'PNG');
    report.checks.push('The visible SVG embedding renders every retained cell and exports as a PNG');
    phase = 'gene expression';
    await page.getByRole('button', { name: 'MS4A1', exact: true }).click();
    await page.getByRole('heading', { name: 'MS4A1 expression', exact: true }).waitFor({ timeout: 90_000 });
    await page.waitForFunction(() => !document.querySelector('.demo-reset')?.disabled);
    const expression = await page.evaluate(() => document.querySelector('.js-plotly-plot').data[0].marker.color);
    assert.equal(expression.length, filtered); assert(expression.some(value => value > 0) && expression.some(value => value === 0));
    const percent = 100 * expression.filter(value => value > 0).length / expression.length;
    assert(await page.getByText(percent.toFixed(1) + '%', { exact: true }).isVisible());
    report.expression = { gene: 'MS4A1', cells: expression.length, percentExpressing: percent };
    await page.screenshot({ path: path.join(out, 'desktop-gene.png') });
    report.checks.push('Gene expression coloring and statistics use the filtered Seurat object');
    const geneRequests = [];
    const recordGene = req => { if (new URL(req.url()).pathname === '/api/r/feature-values') geneRequests.push(req.url()); };
    page.on('request', recordGene);
    await page.getByRole('button', { name: 'LYZ', exact: true }).click();
    await page.getByRole('heading', { name: 'LYZ expression', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.demo-reset')?.disabled);
    const cachedGeneStarted = Date.now();
    await page.getByRole('button', { name: 'MS4A1', exact: true }).click();
    await page.getByRole('heading', { name: 'MS4A1 expression', exact: true }).waitFor();
    report.cachedGeneMs = Date.now() - cachedGeneStarted;
    page.off('request', recordGene);
    assert.equal(geneRequests.length, 1, 'Returning to a loaded gene should not repeat its API request.');
    report.checks.push('Switching back to a loaded gene reuses its current-object expression data');
    phase = 'refresh';
    const refreshRequests = [];
    const record = req => { if (/\/api\/r\/(normalize|pca|cluster|umap)\?/.test(req.url())) refreshRequests.push(req.url()); };
    page.on('request', record);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'UMAP', exact: true }).waitFor({ timeout: 120_000 });
    await page.waitForFunction(() => document.querySelector('.js-plotly-plot')?.data?.length > 1);
    page.off('request', record); assert.equal(refreshRequests.length, 0);
    current = await saved(); assert.equal(current.clustering.resolution, 0.8); assert.equal(current.map.n_cells, filtered);
    report.checks.push('Refresh restores selected parameters and saved computed results without rerunning analysis');
    phase = 'mobile';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => document.querySelector('.demo-shell').scrollWidth <= 390));
    await page.screenshot({ path: path.join(out, 'mobile-umap.png'), fullPage: true });
    await page.locator('.demo-plot-card').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'mobile-umap-plot.png') });
    report.checks.push('Mobile controls and plots remain within the viewport');
    phase = 'refilter';
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole('tab', { name: /Quality control/ }).click();
    await page.getByLabel('Maximum genes per cell', { exact: true }).fill('2500');
    await page.getByLabel('Minimum RNA counts per cell', { exact: true }).fill('0');
    await run('Apply QC', /^QC complete: 2,638/);
    current = await saved(); assert.equal(current.map, null); assert.equal(current.pca, null);
    assert(await page.getByRole('tab', { name: /Clustering/ }).isDisabled());
    report.checks.push('Loosening QC restores original cells and invalidates the previous PCA and embedding');
    phase = 'reset';
    await run('Reset analysis', 'Analysis reset to input counts.');
    current = await saved(); assert.equal(current.stage, 'input'); assert.equal(current.baseline.n_cells, 2700);
    state = await runtimeState(); assert.equal(state.has_umap, false); assert.equal(state.has_pca, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.querySelector('.demo-shell').scrollWidth <= 390));
    await page.screenshot({ path: path.join(out, 'mobile-qc.png'), fullPage: true });
    await page.locator('.demo-plot-card').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'mobile-qc-plots.png') });
    report.checks.push('Reset returns to original counts and input QC');
    phase = 'access restrictions';
    for (const endpoint of ['/api/auth/login', '/api/auth/signup', '/api/auth/change-password', '/API/auth/LOGIN/']) {
      const response = await context.request.post(origin + endpoint, { headers: headers(), data: {} });
      assert([403, 404].includes(response.status()), endpoint + ' must be unavailable');
    }
    const excessive = await context.request.get(origin + '/api/r/cluster?dims=10&resolution=10&algorithm=1&seed=42', { headers: headers(current.currentObjectId) });
    assert.equal(excessive.status(), 403);
    const anonymous = await request.newContext({ baseURL: origin });
    try { assert.equal((await anonymous.get('/api/projects')).status(), 401); } finally { await anonymous.dispose(); }
    report.checks.push('Login remains disabled, analysis bounds enforced, and guest data access isolated');
    assert.equal(diagnostics.pageErrors.length, 0, JSON.stringify(diagnostics.pageErrors));
    assert.equal(diagnostics.serverErrors.length, 0, JSON.stringify(diagnostics.serverErrors));
    assert.equal(diagnostics.failures.length, 0, JSON.stringify(diagnostics.failures));
    report.success = true;
    fs.writeFileSync(path.join(out, 'acceptance.json'), JSON.stringify(report, null, 2));
    return { runDirectory: out, manifest: report };
  } catch (error) {
    report.success = false; report.phase = phase; report.error = error.message;
    report.visibleText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1800);
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify(report, null, 2));
    throw error;
  } finally { await browser.close(); }
}
if (require.main === module) {
  runGuidedDemoAcceptance({ origin: process.env.PUBLIC_DEMO_ORIGIN || process.argv[2], artifactDirectory: process.env.GUIDED_DEMO_ARTIFACTS })
    .then(result => console.log(JSON.stringify(result.manifest, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runGuidedDemoAcceptance };
