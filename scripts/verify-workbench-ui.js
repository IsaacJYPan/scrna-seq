#!/usr/bin/env node
'use strict';

// Exercise the authenticated full workbench with deterministic R responses.
// The dataset is a frontend fixture; no live analysis is mutated.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { prepareVisualPage } = require('./test_visual_ux');

const root = path.resolve(__dirname, '..');
const phase = process.argv.includes('--before') ? 'before' : 'after';
const extraOnly = process.argv.includes('--extra-only');
const out = path.join(root, 'playwright/report/full-workbench', extraOnly ? 'extra' : phase);
const port = 5184;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const cellCount = 2700;
const traces = Array.from({ length: 8 }, (_, cluster) => {
  const count = cluster === 7 ? 341 : 337;
  const points = Array.from({ length: count }, (_, i) => {
    const angle = i * 2.3999632297, radius = Math.sqrt(i / count) * 1.1;
    return { x: (cluster % 4) * 3 + Math.cos(angle) * radius,
      y: Math.floor(cluster / 4) * 4 + Math.sin(angle) * radius, z: Math.sin(angle) };
  });
  return { name: `Cluster ${cluster}`, x: points.map(p => p.x), y: points.map(p => p.y), z: points.map(p => p.z) };
});
const baseline = { n_cells: cellCount, n_features: 13714,
  percent_mt: Array.from({ length: cellCount }, (_, i) => 0.2 + (i % 117) / 15),
  nFeature_RNA: Array.from({ length: cellCount }, (_, i) => 300 + (i % 91) * 27),
  nCount_RNA: Array.from({ length: cellCount }, (_, i) => 600 + (i % 139) * 61) };
const findings = [];
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, passed: !!condition, detail });
  assert.ok(condition, name + (detail ? ': ' + JSON.stringify(detail) : ''));
  console.log('PASS ' + name);
}
async function fixture(context) {
  const result = await prepareVisualPage(context, { logConsole: false });
  const { page } = result;
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const cursor = document.createElement('div');
      cursor.setAttribute('aria-hidden', 'true');
      cursor.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:10px;height:10px;border:1px solid #fff;background:#334155;border-radius:50%;transform:translate(-50%,-50%);display:none;box-shadow:0 0 0 1px #334155';
      document.body.appendChild(cursor);
      document.addEventListener('pointermove', event => {
        cursor.style.display = event.pointerType === 'touch' ? 'none' : 'block';
        cursor.style.left = event.clientX + 'px'; cursor.style.top = event.clientY + 'px';
      });
      document.addEventListener('pointerdown', () => { cursor.style.background = '#0071e3'; });
      document.addEventListener('pointerup', () => { cursor.style.background = '#334155'; });
    });
  });
  const respond = async (pattern, getBody) => page.route(pattern, async route => {
    await route.fulfill({ status: 200, json: getBody(new URL(route.request().url())) });
  });
  await respond('**/pipeline-state*', () => ({ exists: true, has_qc: true, has_normalized: true,
    has_pca: true, pca_dims: 30, has_clusters: true, n_clusters: 8, has_umap: true }));
  await respond('**/reduction-results*', url => ({ result: url.searchParams.get('reduction') === 'pca'
    ? { exists: true, restored: true, npcs: 30, stdevs: Array.from({ length: 30 }, (_, i) => 12 / Math.sqrt(i + 1)),
      gene_loadings: { PC1: ['LYZ', 'CD3D', 'MS4A1'], PC2: ['NKG7', 'GNLY'] }, trace_data: traces }
    : { exists: true, restored: true, n_components: 2, n_cells: cellCount, trace_data: traces },
    live_state: { live_revision: 0, saved_revision: 0, has_unsaved_changes: false } }));
  await respond('**/qc-distributions*', () => baseline);
  const points = traces.flatMap((trace, cluster) => trace.x.map((x, i) => ({ x, y: trace.y[i], cluster })));
  const expression = points.map((_, i) => (i % 60) / 10);
  await respond('**/feature-values*', () => ({ gene: 'CD3E', u1: points.map(p => p.x), u2: points.map(p => p.y), expression }));
  await respond('**/gene-expression*', () => ({ gene: 'CD3E', u1: points.map(p => p.x), u2: points.map(p => p.y), expression,
    clusters: points.map(p => String(p.cluster)) }));
  await respond('**/dot-plot*', () => ({ genes: ['CD3E', 'MS4A1'], clusters: ['0', '1', '2'],
    avg_expr: [[1.23, 0.04, 0.42], [0.02, 2.13, 0.12]], pct_expr: [[0.78, 0.04, 0.32], [0.02, 0.91, 0.12]] }));
  await respond('**/umap*', url => ({ provenance: { id: 'prov_visual_umap' }, result: {
    n_components: Number(url.searchParams.get('n_components')) || 2, n_cells: cellCount, trace_data: traces } }));
  await respond('**/object-info*', () => ({ n_cells: cellCount, n_features: 13714, n_genes: 13714,
    memory_mb: 45.2, assays: ['RNA'], active_assay: 'RNA', reductions: ['pca', 'umap'],
    meta_cols: [{ name: 'orig.ident', type: 'character' }, { name: 'nCount_RNA', type: 'numeric' },
      { name: 'nFeature_RNA', type: 'numeric' }, { name: 'percent.mt', type: 'numeric' },
      { name: 'seurat_clusters', type: 'character' }] }));
  return result;
}
async function navigate(page, destination) {
  const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator(`aside button[data-destination="${destination}"]`).click();
  await pause(600);
  if (await page.locator('.js-plotly-plot:visible').count()) await page.waitForFunction(() =>
    [...document.querySelectorAll('.js-plotly-plot')].filter(el => el.getBoundingClientRect().height > 0).every(el => el._fullLayout));
  await page.mouse.move(1, 1);
}
async function capture(page, name) {
  await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' });
  findings.push({ name, text: await page.locator('main').innerText() });
}
async function hoverPlot(page, name, pattern) {
  const plot = page.locator('.js-plotly-plot:visible').first();
  await plot.scrollIntoViewIfNeeded();
  const target = await plot.evaluate(el => {
    const layout = el._fullLayout, rect = el.getBoundingClientRect();
    const trace = el._fullData.find(trace => ['scatter', 'scattergl', 'heatmap'].includes(trace.type) && trace.hoverinfo !== 'skip');
    if (!trace) return null;
    const index = Math.min(10, trace.x.length - 1);
    const x = trace.type === 'heatmap' ? trace.x[1] : trace.x[index];
    const y = trace.type === 'heatmap' ? trace.y[1] : trace.y[index];
    const cells = el._fullData.filter(trace => ['scatter', 'scattergl'].includes(trace.type) && trace.hoverinfo !== 'skip')
      .flatMap(trace => trace.x.map((value, i) => [layout.xaxis.d2p(value), layout.yaxis.d2p(trace.y[i])]));
    let empty = null;
    for (const fractionX of [0.02, 0.98, 0.5, 0.25, 0.75]) for (const fractionY of [0.02, 0.98, 0.5, 0.25, 0.75]) {
      const x = layout.xaxis._length * fractionX, y = layout.yaxis._length * fractionY;
      if (!empty && cells.every(cell => Math.hypot(cell[0] - x, cell[1] - y) > Math.max(20, layout.hoverdistance) + 5)) empty = { x, y };
    }
    return { x: rect.x + layout.xaxis._offset + layout.xaxis.d2p(x),
      y: rect.y + layout.yaxis._offset + layout.yaxis.d2p(y),
      blankX: empty ? rect.x + layout.xaxis._offset + empty.x : rect.x + 2,
      blankY: empty ? rect.y + layout.yaxis._offset + empty.y : rect.y + 2,
      insideEmpty: !!empty,
      type: trace.type };
  });
  check(name + ': real data point available', !!target, target);
  await page.mouse.move(target.x, target.y, { steps: 18 });
  await pause(180);
  const text = (await plot.locator('.hoverlayer').allTextContents()).join(' ').trim();
  check(name + ': concise tooltip at data point', pattern.test(text) && !/trace \d|UMAP[123]:|percent\.mt|nFeature_RNA|nCount_RNA|Stdev|\bExpr:/.test(text), text);
  const label = await plot.evaluate(el => ({ background: el._fullLayout.hoverlabel.bgcolor, font: el._fullLayout.hoverlabel.font.color }));
  check(name + ': tooltip has distinct foreground/background', label.background !== label.font, label);
  await capture(page, name + '-hover');
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(target.x + Math.sin(i / 3) * 12, target.y + Math.cos(i / 3) * 12);
    await pause(15);
  }
  if (target.type !== 'heatmap') {
    await page.mouse.move(target.blankX, target.blankY, { steps: 12 });
    await pause(180);
    check(name + (target.insideEmpty ? ': empty plot space has no tooltip' : ': plot margin has no tooltip'), (await plot.locator('.hoverlayer').allTextContents()).join('').trim() === '');
  }
  await page.mouse.move(1, 1, { steps: 12 });
  await pause(120);
  check(name + ': tooltip clears on pointer exit', (await plot.locator('.hoverlayer').allTextContents()).join('').trim() === '');
}
async function stableControl(page, locator, name) {
  const before = await locator.boundingBox();
  await locator.hover(); await pause(180);
  const after = await locator.boundingBox();
  check(name + ': hover does not shift control', before && after && ['x', 'y', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) < 0.5));
  await locator.focus();
  check(name + ': keyboard focus works', await locator.evaluate(el => el === document.activeElement));
}
async function workbench(browser, theme, width) {
  const label = `${theme}-${width}`;
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 },
    hasTouch: width < 600, recordVideo: { dir: out, size: { width, height: width < 600 ? 844 : 1000 } } });
  await context.addInitScript(value => localStorage.setItem('theme', value), theme);
  const { page, consoleErrors, networkFailures } = await fixture(context);
  try {
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add analysis', exact: true }).first().click();
    await page.getByRole('button', { name: /PBMC 3k Demo Dataset/ }).click();
    await page.getByText('PBMC_3k_Tutorial', { exact: true }).first().waitFor();
    for (const destination of ['workspace', 'qc', 'pca', 'umap', 'inspect', 'normalize', 'cluster', 'featureplot', 'heatmap', 'dotplot', 'geneviewer']) {
      await navigate(page, destination);
      const name = `${label}-${destination}`;
      if (destination === 'featureplot') {
        await page.getByRole('textbox', { name: 'Feature plot gene symbol' }).fill('CD3E');
        await page.getByRole('button', { name: 'Plot', exact: true }).click();
      }
      if (destination === 'dotplot') {
        const field = page.getByRole('textbox', { name: 'Add gene to dot plot' });
        await field.fill('CD3E'); await field.press('Enter');
        await field.fill('MS4A1'); await field.press('Enter');
        await page.getByRole('button', { name: 'Plot', exact: true }).click();
      }
      if (destination === 'geneviewer') {
        const field = page.getByRole('textbox', { name: 'Search gene by symbol' });
        await field.fill('CD3E'); await field.press('Enter');
        await page.getByRole('button', { name: 'FeaturePlot', exact: true }).click();
      }
      await pause(450);
      await capture(page, name);
      if (phase === 'before') continue;
      check(name + ': page fits viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const violations = audit.violations.filter(v => ['critical', 'serious'].includes(v.impact));
      check(name + ': accessibility', violations.length === 0, violations.map(v => ({ id: v.id, nodes: v.nodes.map(node => node.html).slice(0, 3) })));
      if (destination === 'workspace') {
        const details = page.getByRole('button', { name: 'Dataset details', exact: true });
        await stableControl(page, details, name + ' details');
        await details.press('Enter');
        check(name + ': data details accessible', await page.getByText('Matrix density', { exact: true }).isVisible());
        await capture(page, name + '-details'); await details.press('Escape');
        check(name + ': Escape restores focus', await details.evaluate(el => el === document.activeElement));
      }
      if (destination === 'qc') {
        await hoverPlot(page, name, /Mitochondrial RNA: [\d.]+%/);
        await page.getByLabel('Show dots', { exact: true }).uncheck();
        check(name + ': hidden dots remove cell hover targets', await page.locator('.js-plotly-plot:visible').evaluate(el => el._fullData.every(trace => trace.hoverinfo === 'skip')));
        await page.getByLabel('Show dots', { exact: true }).check();
        for (const tab of ['Detected genes', 'RNA counts', 'Feature Scatter']) {
          await page.getByRole('button', { name: tab, exact: true }).click();
          await pause(250);
          await hoverPlot(page, name + '-' + tab.replaceAll(' ', '-'), /Genes detected:|RNA counts:/);
        }
      }
      if (destination === 'pca') {
        await hoverPlot(page, name + '-elbow', /Standard deviation:/);
        await page.getByRole('button', { name: 'PC1 vs PC2', exact: true }).click();
        await pause(250); await hoverPlot(page, name + '-embedding', /^Cluster \d+$/);
      }
      if (destination === 'umap') {
        const distance = page.getByLabel('Minimum Distance', { exact: true });
        await distance.fill('');
        check(name + ': blank input blocks compute', await page.getByRole('button', { name: /compute UMAP|Run 2D UMAP/ }).isDisabled());
        await distance.pressSequentially('0.35', { delay: 60 });
        check(name + ': natural decimal entry works', await distance.inputValue() === '0.35');
        await distance.fill('0.3');
        await hoverPlot(page, name, /^Cluster \d+$/);
      }
      if (['featureplot', 'geneviewer'].includes(destination)) await hoverPlot(page, name, /CD3E.*Expression:/);
      if (['dotplot', 'heatmap'].includes(destination)) await hoverPlot(page, name, /Average expression:/);
    }
    findings.push({ label, consoleErrors, networkFailures });
    if (phase !== 'before') {
      check(label + ': no uncaught browser errors', consoleErrors.length === 0, consoleErrors);
      check(label + ': no unexpected request failures', networkFailures.length === 0, networkFailures);
    }
  } finally {
    const video = page.video(); await context.close();
    await video.saveAs(path.join(out, 'navigation-' + label + '.webm'));
  }
}
async function extraInteractions(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
    recordVideo: { dir: out, size: { width: 1440, height: 1000 } } });
  const { page, consoleErrors } = await fixture(context);
  try {
    await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add analysis', exact: true }).first().click();
    await page.getByRole('button', { name: /PBMC 3k Demo Dataset/ }).click();
    await page.getByText('PBMC_3k_Tutorial', { exact: true }).first().waitFor();
    await navigate(page, 'umap');
    let plot = page.locator('.js-plotly-plot:visible').first();
    const box = await plot.boundingBox();
    const range = await plot.evaluate(el => JSON.stringify(el._fullLayout.xaxis.range));
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 24 }); await page.mouse.up();
    await pause(250);
    check('2D drag selects a zoom region', await plot.evaluate((el, before) => JSON.stringify(el._fullLayout.xaxis.range) !== before, range));
    const reset = plot.locator('.modebar-btn[data-title*="Reset"]').first();
    await reset.click(); await pause(200);
    await capture(page, 'umap-zoom-reset');
    const exportButton = plot.locator('.modebar-btn[data-title*="Download"]').first();
    const downloaded = page.waitForEvent('download'); await exportButton.click();
    const file = await downloaded; await file.saveAs(path.join(out, 'umap-export.png'));
    check('Plot download produces a PNG', fs.readFileSync(path.join(out, 'umap-export.png')).subarray(1, 4).toString() === 'PNG');
    await page.getByRole('button', { name: '3D', exact: true }).click();
    await page.getByRole('button', { name: 'Run 3D UMAP', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-hidden="false"] .js-plotly-plot')].some(el => el._fullLayout?.scene && el._fullData?.some(trace => trace.type === 'scatter3d')));
    await pause(600);
    plot = page.locator('[aria-hidden="false"] .js-plotly-plot:visible').first();
    const sceneBox = await plot.boundingBox();
    const cameraBefore = await plot.evaluate(el => JSON.stringify(el._fullLayout.scene._scene.getCamera()));
    await page.mouse.move(sceneBox.x + sceneBox.width * 0.45, sceneBox.y + sceneBox.height * 0.45);
    await page.mouse.down(); await page.mouse.move(sceneBox.x + sceneBox.width * 0.65, sceneBox.y + sceneBox.height * 0.55, { steps: 32 }); await page.mouse.up();
    await pause(750);
    const cameraAfter = await plot.evaluate(el => JSON.stringify(el._fullLayout.scene._scene.getCamera()));
    check('3D drag rotates the camera', cameraAfter !== cameraBefore, { before: cameraBefore, after: cameraAfter });
    let hover = '';
    for (let row = 1; row <= 10 && !hover; row++) for (let column = 1; column <= 10 && !hover; column++) {
      await page.mouse.move(sceneBox.x + sceneBox.width * column / 11, sceneBox.y + sceneBox.height * row / 11);
      await pause(35);
      hover = (await plot.locator('.hovertext').allTextContents()).join('').trim();
    }
    check('3D point hover shows only its cluster', /^Cluster \d+$/.test(hover), hover);
    await capture(page, 'umap-3d-hover');
    await pause(800);
    check('Camera remains stable during hover and persistence', await plot.evaluate((el, before) => JSON.stringify(el._fullLayout.scene._scene.getCamera()) === before, cameraAfter));
    await page.mouse.move(1, 1); await pause(200);
    check('3D tooltip clears on exit', (await plot.locator('.hovertext').allTextContents()).join('').trim() === '');
    await page.getByRole('button', { name: '2D', exact: true }).click(); await pause(300);
    await page.getByRole('button', { name: '3D', exact: true }).click(); await pause(300);
    const switchedCamera = await plot.evaluate(el => JSON.stringify(el._fullLayout.scene._scene.getCamera()));
    const expectedCamera = JSON.parse(cameraAfter), actualCamera = JSON.parse(switchedCamera);
    const cameraDifference = Math.max(...['eye', 'center', 'up'].flatMap(part => ['x', 'y', 'z'].map(axis => Math.abs(expectedCamera[part][axis] - actualCamera[part][axis]))));
    check('2D/3D switching preserves camera', cameraDifference < 0.000001, { before: expectedCamera, after: actualCamera, cameraDifference });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const connection = page.getByRole('button', { name: 'Connection details', exact: true });
    check('Reduced motion removes prolonged transitions', await connection.evaluate(el => getComputedStyle(el).transitionDuration.split(',').every(value => parseFloat(value) <= 0.01)));
    await page.getByRole('button', { name: '2D', exact: true }).click();
    const minDistance = page.getByLabel('Minimum Distance', { exact: true });
    const rerunUmap = page.getByRole('button', { name: /Re-compute UMAP|^Run UMAP$/ });
    await minDistance.fill('');
    check('Blank minimum distance prevents UMAP submission', await rerunUmap.isDisabled());
    await minDistance.fill('0');
    await page.getByLabel('Number of Neighbors', { exact: true }).fill('2');
    await page.getByLabel('Input Dimensions (PCs)', { exact: true }).fill('2');
    check('Zero-distance two-neighbor two-PC UMAP remains executable', await rerunUmap.isEnabled());
    const boundedRequest = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname.endsWith('/umap') && url.searchParams.get('min_dist') === '0'
        && url.searchParams.get('n_neighbors') === '2' && url.searchParams.get('dims') === '2';
    });
    await rerunUmap.click();
    const submittedUmap = new URL((await boundedRequest).url());
    check('Supported lower UMAP settings reach the analysis API', submittedUmap.searchParams.get('n_components') === '2');
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-hidden="false"] .js-plotly-plot')]
      .some(el => el._fullData?.some(trace => trace.type === 'scatter' && trace.x?.length)));
    await capture(page, 'umap-supported-lower-settings');
    await page.setViewportSize({ width: 320, height: 844 });
    for (const destination of ['workspace', 'inspect', 'qc', 'umap', 'heatmap', 'dotplot']) {
      await navigate(page, destination);
      check(`320px ${destination} fits viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await capture(page, 'narrow-' + destination);
    }
    check('Extra interaction pass has no browser errors', consoleErrors.length === 0, consoleErrors);
  } finally {
    const video = page.video(); await context.close(); await video.saveAs(path.join(out, 'plots-and-transitions.webm'));
  }
}
let server, browser;
(async () => {
  fs.mkdirSync(out, { recursive: true });
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { if (data.toString().includes('Local:')) resolve(); });
    server.stderr.on('data', data => console.error(data.toString()));
    server.once('exit', code => reject(new Error('Vite exited ' + code)));
    setTimeout(() => reject(new Error('Vite startup timeout')), 30000).unref();
  });
  browser = await chromium.launch({ headless: true });
  if (extraOnly) { await extraInteractions(browser); return; }
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    if (phase === 'before' && (theme !== 'light' || width !== 1440)) continue;
    await workbench(browser, theme, width);
  }
  if (phase !== 'before') await extraInteractions(browser);
})().catch(error => { console.error(error); checks.push({ name: 'Recorded acceptance completed', passed: false, detail: error.message }); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
  fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(findings, null, 2));
  fs.writeFileSync(path.join(out, 'acceptance.json'), JSON.stringify(checks, null, 2));
  console.log(`${checks.filter(c => c.passed).length}/${checks.length} checks passed`);
  console.log('Full workbench captures: ' + out);
});
