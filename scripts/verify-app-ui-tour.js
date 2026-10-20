#!/usr/bin/env node
'use strict';

// Full-app navigation review. Measured PBMC3k plots, simulated application APIs.
// Native SSH is separately verified with a real disposable OpenSSH server.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const { prepareVisualPage } = require('./test_visual_ux');
const root = path.resolve(__dirname, '..');
const phase = process.argv.includes('--before') ? 'before' : 'after';
const interactionsOnly = process.argv.includes('--interactions');
const authOnly = process.argv.includes('--auth');
const walkthroughOnly = process.argv.includes('--walkthrough');
const pipelineLayoutOnly = process.argv.includes('--pipeline-layout');
const out = path.join(root, 'playwright/report/ui-audit', pipelineLayoutOnly ? 'pipeline-layout' : walkthroughOnly ? 'walkthrough' : authOnly ? 'auth' : interactionsOnly ? 'interactions' : phase);
const dataPath = process.env.UI_REVIEW_PBMC_DATA || path.join(root, 'playwright/report/ui-audit/data/pbmc-ui-data.json');
assert.ok(fs.existsSync(dataPath), 'Export the prepared PBMC3k checkpoint with scripts/export-ui-review-pbmc.R first; see README UI verification instructions.');
const measured = JSON.parse(fs.readFileSync(dataPath));
assert.equal(measured.source.synthetic, false);
const port = Number(process.env.APP_TOUR_PORT || 5185);
const origin = `http://localhost:${port}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], observations = [], requests = [], chapters = [];
const destinations = ['workspace', 'pipeline-manager', 'history', 'branches', 'study-design', 'expert-r', 'team',
  'lineage', 'publication', 'validation', 'inspect', 'qc', 'normalize', 'integrate', 'pca', 'cluster',
  'umap', 'featureplot', 'geneviewer', 'heatmap', 'dotplot', 'explore', 'deg', 'enrichment', 'cellchat', 'account'];
function check(name, passed, detail) {
  checks.push({ name, passed: !!passed, detail });
  console.log((passed ? 'PASS ' : 'FAIL ') + name + (!passed ? ': ' + JSON.stringify(detail) : ''));
}
const projectId = 'proj_visual_mock', objectId = 'ao_abcdef1234567890';
async function fixture(context, theme) {
  const result = await prepareVisualPage(context, { logConsole: false, fullPipeline: true });
  const { page } = result;
  const pageRequests = [];
  const respond = async (pattern, body) => page.route(pattern, route => route.fulfill({ status: 200,
    json: typeof body === 'function' ? body(new URL(route.request().url()), route.request()) : body }));
  await context.addInitScript(value => {
    localStorage.setItem('theme', value);
    document.addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('div'); label.setAttribute('aria-hidden', 'true');
      label.style.cssText = 'position:fixed;bottom:3px;right:3px;z-index:2147483646;pointer-events:none;font:10px system-ui;padding:4px 7px;border:1px solid #64748b;border-radius:4px;color:#334155;background:#fff';
      label.textContent = 'UI review: measured PBMC3k plots · simulated services'; document.body.appendChild(label);
      const cursor = document.createElement('div'); cursor.setAttribute('aria-hidden', 'true');
      cursor.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:10px;height:10px;border:1px solid #fff;background:#334155;border-radius:50%;transform:translate(-50%,-50%);display:none;box-shadow:0 0 0 1px #334155';
      document.body.appendChild(cursor);
      document.addEventListener('pointermove', e => { cursor.style.display = 'block'; cursor.style.left=e.clientX+'px'; cursor.style.top=e.clientY+'px'; });
    });
  }, theme);
  const object = { id: objectId, ownerUserId: 1, projectId, objectType: 'seurat', displayName: 'PBMC3k · prepared real data',
    metadata: { sourceType: 'pbmc3k_demo', summary: { cells: measured.source.cells, features: measured.source.features }, synthetic: false },
    createdAt: '2026-10-11T12:00:00Z', updatedAt: '2026-10-11T12:00:00Z' };
  const jobs = [{ id: 'job_prepared_pbmc', ownerUserId: 1, projectId, analysisObjectId: objectId,
    resultAnalysisObjectId: objectId, jobType: 'pbmc.pipeline.v1', status: 'completed', createdAt: '2026-10-11T12:00:00Z' }];
  const artifacts = [{ id: 'artifact_prepared_pbmc', artifactType: 'checkpoint', name: 'Prepared PBMC3k checkpoint',
    jobId: jobs[0].id, resultAnalysisObjectId: objectId, status: 'available', storageKind: 'metadata_only' }];
  const receipts = new Map();
  await respond('**/api/projects/*/job-submissions/*', url => receipts.get(url.pathname.split('/').at(-1)));
  const monitored = job => ({ id: job.id, projectId, kind: 'job', operation: job.jobType, status: job.status,
    timestamps: { createdAt: job.createdAt }, target: { id: 'ui-review', precision: 'unavailable', note: 'Simulated service for UI review' },
    timing: { elapsedMs: null }, logs: { state: 'unavailable' }, resources: { state: 'unavailable' } });
  await respond('**/api/run-monitoring/**', url => {
    const id = url.pathname.split('/')[4];
    return id ? { schema: 'traceomics.run-monitoring.v1', checkedAt: new Date().toISOString(), staleAfterMs: 10000, ...monitored(jobs.find(job => job.id === id) || jobs[0]) }
      : { schema: 'traceomics.run-monitoring.v1', checkedAt: new Date().toISOString(), staleAfterMs: 10000, items: jobs.map(monitored), nextCursor: null };
  });
  await page.route('**/api/projects/*/jobs**', async route => {
    const request = route.request(), url = new URL(request.url());
    const parts = url.pathname.split('/'), index = parts.indexOf('jobs'), id = parts[index + 1];
    let body;
    if (!id && request.method() === 'POST') {
      const input = request.postDataJSON();
      body = { id: 'job_review_' + jobs.length, projectId, ownerUserId: 1, analysisObjectId: objectId,
        jobType: input.jobType, parameters: input.parameters, status: input.jobType === 'explore.summarize.v1' ? 'completed' : 'running', createdAt: new Date().toISOString() };
      jobs.push(body);
      const receipt = { schema: 'traceomics.job-submission.v1', requestId: input.requestId, projectId,
        jobId: body.id, requestHash: 'a'.repeat(64) };
      receipts.set(input.requestId, receipt);
      body.submission = receipt;
      if (input.jobType === 'explore.summarize.v1') artifacts.push({ id: 'artifact_explore', jobId: body.id,
        artifactType: 'exploration_summary', metadata: { summary: { nCells: measured.source.cells, nFeatures: measured.source.features,
          recipe: input.parameters.recipe, panels: [{ type: 'cell_groups', title: 'Cells per cluster', rows: Object.entries(measured.clusterCounts).map(([label,count]) => ({label,count})) }] } } });
    } else if (parts[index + 2] === 'artifacts') body = artifacts.filter(a => a.jobId === id);
    else if (parts[index + 2] === 'logs') body = { stdout: '', stderr: '' };
    else if (parts[index + 2] === 'cancel') { body = jobs.find(j => j.id === id); body.status = 'canceled'; }
    else if (id) body = jobs.find(j => j.id === id);
    else body = jobs.filter(job => (!url.searchParams.get('jobType') || job.jobType === url.searchParams.get('jobType')) &&
      (!url.searchParams.get('analysisObjectId') || job.analysisObjectId === url.searchParams.get('analysisObjectId')));
    await route.fulfill({ json: body });
  });
  await respond('**/api/projects/*/artifacts*', artifacts);
  await respond('**/api/projects/*/provenance*', [{ id: 'prov_pbmc', operation: 'prepared_checkpoint', analysisObjectId: objectId, createdAt: '2026-10-11T12:00:00Z' }]);
  await respond('**/api/projects/*/branches', [{ id: 'branch_review', ownerUserId: 1, name: 'UI review draft', description: 'Simulated branch for interaction review',
    visibility: 'private', status: 'active', baseAnalysisObjectId: objectId, headAnalysisObjectId: objectId, version: 1 }]);
  await page.route('**/api/projects/*/analysis-objects**', async route => {
    const url = new URL(route.request().url());
    if (/\/summary$/.test(url.pathname)) await route.fulfill({ json: object });
    else if (/\/analysis-objects$/.test(url.pathname)) await route.fulfill({ json: route.request().method() === 'POST' ? object : [object] });
    else await route.fallback();
  });
  await respond('**/api/auth/policy*', { registrationEnabled: true, datasetUploadsEnabled: true, legacyLocalImportsEnabled: true,
    legacyLiveMutationToolsEnabled: true, serverFigureExportEnabled: true, expertREnabled: true, expertRStatus: { state: 'ready' } });
  await respond('**/api/runtime/compute-status*', () => ({ status: 'ready', updatedAt: new Date().toISOString(),
    capabilities: { pathwayEnrichment: true, cellChat: true } }));
  await respond('**/api/expert-r/capabilities*', { expertREnabled: true, expertRStatus: { state: 'ready' },
    expertRProfile: { id: 'ui-review', packages: ['Seurat', 'ggplot2', 'dplyr'], capabilities: { persistentKernel: true } } });
  await respond('**/api/private-r-kernels/*', { items: [], nextCursor: null });
  await respond('**/load-data*', { result: { cells: measured.source.cells, genes: measured.source.features, features: measured.source.features }, provenance: { operation: 'load' } });
  await respond('**/pipeline-state*', { exists: true, has_qc: true, has_normalized: true, has_pca: true, pca_dims: 50,
    has_clusters: true, n_clusters: 9, cluster_dims: 10, has_umap: true });
  await respond('**/reduction-results*', url => ({ result: url.searchParams.get('reduction') === 'pca' ? measured.pca : measured.umap,
    live_state: { live_revision: 0, saved_revision: 0, has_unsaved_changes: false } }));
  await respond('**/qc-distributions*', measured.qc);
  await respond('**/object-info*', measured.objectInfo);
  await respond('**/genes*', { genes: measured.genes });
  await respond('**/feature-values*', url => measured.expression[url.searchParams.get('gene')] || measured.expression.CD3E);
  await respond('**/gene-expression*', url => measured.expression[url.searchParams.get('gene')] || measured.expression.CD3E);
  await respond('**/heatmap*', measured.heatmap);
  await respond('**/dot-plot*', url => {
    const genes = (url.searchParams.get('genes') || 'CD3E').split(',');
    return { ...measured.dotplot, genes, avg_expr: genes.map(g => measured.dotplot.avg_expr[measured.genes.indexOf(g)]),
      pct_expr: genes.map(g => measured.dotplot.pct_expr[measured.genes.indexOf(g)]) };
  });
  await respond('**/meta-values*', url => ({ values: url.searchParams.get('column') === 'seurat_clusters'
    ? Object.entries(measured.clusterCounts).map(([value, count]) => ({ value, count })) : [{ value: 'PBMC3k', count: measured.source.cells }] }));
  await respond('**/cellchat-group-map*', url => url.searchParams.get('preflight') === 'true'
    ? { ready: true, group_count: Object.keys(measured.clusterCounts).length }
    : { schema: 'traceomics.cellchat-group-map.v1', group_by: 'seurat_clusters', groups: Object.entries(measured.clusterCounts)
      .map(([label,count],index) => ({ group: `Group ${index+1}`, label, input_cells: count })) });
  await respond('**/api/projects/*/conditions', [{ id: 'condition_pbmc', name: 'PBMC3k reference' }]);
  await respond('**/api/projects/*/samples', [{ id: 'sample_pbmc', name: 'PBMC3k sample', conditionId: 'condition_pbmc', conditionName: 'PBMC3k reference', modality: 'scrna' }]);
  await respond('**/api/projects/*/contrasts', []);
  await respond('**/api/projects/*/analysis-objects/*/sample-bindings', [{ id: 'binding_pbmc', analysisObjectId: objectId,
    sampleId: 'sample_pbmc', sampleName: 'PBMC3k sample', cellMetadataColumn: 'sample_id', cellMetadataValue: 'PBMC3k' }]);
  await respond('**/api/projects/*/members', [{ userId: 1, email: 'researcher@lab.edu', displayName: 'Visual Tester', role: 'owner' }]);
  await respond('**/validate*', { result: { n_cells: measured.source.cells, n_genes: measured.source.features,
    cell_count: measured.source.cells, feature_count: measured.source.features, sparsity: 97.4,
    has_qc: true, has_normalized: true, has_pca: true, has_clusters: true, has_umap: true } });
  await respond('**/api/workflows/*', url => url.pathname.endsWith('capabilities')
    ? { enabled: true, profiles: [] } : []);
  const storage = { state: 'ready', writable: true, freeBytes: 32 * 1024 ** 3, minFreeBytes: 1024 ** 3, reservedBytes: 0 };
  await respond('**/api/runtime/readiness*', () => ({ schema: 'traceomics.runtime-readiness.v1', checkedAt: new Date().toISOString(), staleAfterMs: 10000,
    service: { product: 'TraceOmics', state: 'ready', serviceApiVersion: 1, minimumClientApiVersion: 1, supportedTarget: 'R 4.5.x' },
    guided: { state: 'ready', rVersion: '4.5.3', packages: [{ name: 'Seurat', state: 'available' }] },
    workers: { state: 'ready', mode: 'standalone', updatedAt: new Date().toISOString(), capabilities: { pathwayEnrichment: true, cellChat: true } },
    privateR: { state: 'ready', accessState: 'allowed', capabilities: { persistentKernel: true, persistentKernelInterrupt: true, persistentKernelPublications: true },
      resources: { oneShot: { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2, timeoutSeconds: 600, maxConcurrent: 2 }, kernel: { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2, pidsLimit: 256, idleTimeoutSeconds: 900, maxLifetimeSeconds: 14400, executionSeconds: 300, maxActive: 2, maxPerOwner: 1 } }, storage: { work: storage, durable: storage } },
    storage: { durable: storage, private: storage }, scheduler: { state: 'unsupported', kind: null }, issues: [] }));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) {
    const record = { path: new URL(request.url()).pathname, method: request.method() };
    requests.push(record); pageRequests.push(record);
  } });
  return { ...result, requests: pageRequests };
}
async function navigate(page, destination) {
  const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
  if (await expand.isVisible()) await expand.click();
  const button = destination === 'account' ? page.getByRole('button', { name: 'Account security', exact: true }).last()
    : page.locator(`aside button[data-destination="${destination}"]`).first();
  assert.equal(await button.count(), 1, 'Missing destination ' + destination);
  await button.click();
  await pause(250);
  await page.mouse.move(1,1);
}
async function capture(page, name) {
  await page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' });
  const text = await page.locator('main').innerText();
  observations.push({ name, words: text.split(/\s+/).length, text });
}
async function formState(page) {
  return page.locator('main input:visible, main select:visible, main textarea:visible').evaluateAll(elements => elements
    .filter(el => !['password', 'file'].includes(el.type)).map(el => ({ label: el.id || el.getAttribute('aria-label') || el.type,
      value: el.value, checked: el.type === 'checkbox' ? el.checked : undefined })));
}
async function scrollBody(page, bottom) {
  return page.locator('main').evaluate((main, bottom) => {
    const candidates = [...main.querySelectorAll('*')].filter(el => el.getBoundingClientRect().height > 0 && el.scrollHeight > el.clientHeight + 30 && ['auto','scroll'].includes(getComputedStyle(el).overflowY));
    const body = candidates.sort((a,b) => b.clientHeight-a.clientHeight)[0];
    if (body) { body.scrollTop = bottom ? body.scrollHeight : 0; return body.scrollTop; } return 0;
  }, bottom);
}
async function prepareView(page, destination) {
  if (destination === 'featureplot') {
    await page.getByLabel('Feature plot gene symbol').fill('CD3E');
    await page.getByRole('button', { name: 'Plot', exact: true }).click();
  } else if (destination === 'geneviewer') {
    const search = page.getByLabel('Search gene by symbol'); await search.fill('MS4A1'); await search.press('Enter');
    await page.getByRole('button', { name: 'FeaturePlot', exact: true }).click();
  } else if (destination === 'dotplot') {
    const field = page.getByLabel('Add gene to dot plot');
    for (const gene of ['CD3E','MS4A1','LYZ']) { await field.fill(gene); await field.press('Enter'); }
    await page.getByRole('button', { name: 'Plot', exact: true }).click();
  } else if (destination === 'validation') await page.getByRole('button', { name: 'Run Validation', exact: true }).click();
  else if (destination === 'qc') await page.getByRole('button', { name: 'Detected genes', exact: true }).click();
  else if (destination === 'pca') await page.getByRole('button', { name: 'PC1 vs PC2', exact: true }).click();
  else if (destination === 'inspect') { await page.getByRole('button', { name: 'Metadata', exact: true }).click(); await page.getByPlaceholder('Filter columns…').fill('count'); }
  else if (destination === 'cluster') await page.getByLabel('PC Dimensions', { exact: true }).fill('12');
  else if (destination === 'expert-r') {
    await page.getByRole('textbox', { name: 'R script', exact: true }).fill('# UI revisit draft\nsummary(obj)');
    if (phase === 'after') await page.getByRole('button', { name: 'Run R analysis', exact: true }).click();
  }
  else if (destination === 'explore' && phase === 'after') await page.getByRole('button', { name: 'Run recipe', exact: true }).click();
  else if (destination === 'deg' && phase === 'after') await page.getByRole('button', { name: 'Run marker analysis', exact: true }).click();
  else if (destination === 'enrichment' && phase === 'after') {
    await page.getByRole('combobox', { name: /Target cluster or group/i }).selectOption('0');
    await page.getByRole('combobox', { name: /Species \(required\)/i }).selectOption('human');
    await page.getByRole('button', { name: 'Start Pathway Enrichment', exact: true }).click();
  }
  else if (destination === 'cellchat' && phase === 'after') {
    await page.getByRole('combobox', { name: /Group labels \(required\)/i }).selectOption('seurat_clusters');
    await page.getByRole('combobox', { name: /Species \(required\)/i }).selectOption('human');
    await page.getByRole('combobox', { name: /Database category \(required\)/i }).selectOption('all');
    await page.getByRole('combobox', { name: /Analysis intent \(required\)/i }).selectOption('single_context');
    await page.getByRole('button', { name: 'Start CellChat Inference', exact: true }).click();
  }
  else if (destination === 'team') {
    const email = page.getByPlaceholder('researcher@lab.edu'); if (await email.count()) await email.fill('draft@review.invalid');
  }
  await pause(400);
}
async function tour(browser, theme, width) {
  const label = `${theme}-${width}`;
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 },
    recordVideo: { dir: out, size: { width, height: width < 600 ? 844 : 1000 } } });
  const { page, consoleErrors, networkFailures, requests } = await fixture(context, theme);
  try {
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Add analysis', exact: true }).first().click();
    await page.getByRole('button', { name: /PBMC 3k Demo Dataset/ }).click();
    await page.getByText('PBMC3k · prepared real data', { exact: true }).first().waitFor();
    if (phase === 'after') {
      const connection = page.getByRole('button', { name: 'Connection details', exact: true });
      await connection.click();
      const readinessTrigger = page.getByRole('button', { name: 'Check server readiness', exact: true });
      await readinessTrigger.click();
      const dialog = page.getByRole('dialog', { name: 'Server readiness' });
      await dialog.waitFor();
      await pause(300);
      await capture(page, label + '-readiness');
      const box = await dialog.boundingBox();
      check(label + ': readiness dialog fits viewport', box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= page.viewportSize().height, box);
      await page.keyboard.press('Escape');
      check(label + ': readiness Escape restores trigger focus', await dialog.isHidden()
        && await connection.evaluate(el => el === document.activeElement));
    }
    const startAt = process.argv.find(arg => arg.startsWith('--from='))?.split('=')[1];
    for (const destination of destinations.slice(startAt ? destinations.indexOf(startAt) : 0)) {
      await navigate(page, destination);
      await prepareView(page, destination);
      await scrollBody(page, false);
      await capture(page, `${label}-${destination}`);
      check(`${label} ${destination}: fits viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      check(`${label} ${destination}: no error boundary`, !(await page.getByRole('heading', { name: 'Analysis unavailable', exact: true }).isVisible()));
      const audit = await new AxeBuilder({ page }).exclude('.scatterlayer,.heatmaplayer,.gl-container').withTags(['wcag2a','wcag2aa']).analyze();
      check(`${label} ${destination}: accessible`, !audit.violations.some(v => ['serious','critical'].includes(v.impact)),
        audit.violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => ({ id: v.id, nodes: v.nodes.map(n => n.html).slice(0,3) })));
      const before = await formState(page);
      const submitted = requests.filter(request => request.method === 'POST' && request.path.endsWith('/jobs')).length;
      const scroll = await scrollBody(page, true);
      await capture(page, `${label}-${destination}-lower`);
      await navigate(page, destination === 'qc' ? 'umap' : 'qc');
      await navigate(page, 'workspace');
      await navigate(page, destination);
      check(`${label} ${destination}: preserves inputs after earlier-tab round trip`, JSON.stringify(before) === JSON.stringify(await formState(page)));
      const preserved = await page.locator('main').evaluate(main => Math.max(0,...[...main.querySelectorAll('*')].filter(el => el.getBoundingClientRect().height > 0).map(el => el.scrollTop)));
      check(`${label} ${destination}: preserves scroll after returning`, Math.abs(preserved - scroll) < 2, { before: scroll, after: preserved });
      check(`${label} ${destination}: no leftover tooltip`, await page.locator('main .hoverlayer:visible').evaluateAll(els => els.every(el => !el.textContent.trim())));
      check(`${label} ${destination}: revisiting does not resubmit work`, requests.filter(request => request.method === 'POST' && request.path.endsWith('/jobs')).length === submitted);
      await capture(page, `${label}-${destination}-return`);
    }
    check(`${label}: no browser errors`, consoleErrors.length === 0, consoleErrors);
    check(`${label}: no failed requests`, networkFailures.length === 0, networkFailures);
  } finally {
    const video = page.video(); await context.close(); await video.saveAs(path.join(out, `tour-${label}.webm`));
  }
}
async function hoverPlot(page, name, pattern) {
  const plot = page.locator('.js-plotly-plot:visible').first();
  await plot.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('.js-plotly-plot')]
    .filter(el => el.getBoundingClientRect().height > 0).every(el => el._fullLayout));
  const target = await plot.evaluate(el => {
    const layout = el._fullLayout, rect = el.getBoundingClientRect();
    const trace = el._fullData.find(t => ['scatter', 'scattergl', 'heatmap'].includes(t.type) && t.hoverinfo !== 'skip');
    if (!trace) return null;
    const index = Math.min(10, trace.x.length - 1);
    const x = trace.type === 'heatmap' ? trace.x[1] : trace.x[index];
    const y = trace.type === 'heatmap' ? trace.y[1] : trace.y[index];
    const cells = el._fullData.filter(t => ['scatter','scattergl'].includes(t.type) && t.hoverinfo !== 'skip')
      .flatMap(t => t.x.map((v,i) => [layout.xaxis.d2p(v), layout.yaxis.d2p(t.y[i])]));
    let blank;
    for (const fx of [.02,.98,.5,.25,.75]) for (const fy of [.02,.98,.5,.25,.75]) {
      const px = layout.xaxis._length * fx, py = layout.yaxis._length * fy;
      if (!blank && cells.every(p => Math.hypot(p[0]-px,p[1]-py) > Math.max(20,layout.hoverdistance)+5)) blank={x:px,y:py};
    }
    return { x: rect.x+layout.xaxis._offset+layout.xaxis.d2p(x),
      y: rect.y+layout.yaxis._offset+layout.yaxis.d2p(y), type: trace.type,
      blankX: blank ? rect.x+layout.xaxis._offset+blank.x : rect.x+2,
      blankY: blank ? rect.y+layout.yaxis._offset+blank.y : rect.y+2 };
  });
  assert.ok(target, name + ': no hoverable measured point');
  await page.mouse.move(target.x,target.y,{steps:24});
  await pause(200);
  const text = (await plot.locator('.hoverlayer').allTextContents()).join(' ').trim();
  check(name+': concise tooltip',pattern.test(text) && !/trace \d|UMAP[123]:|percent\.mt|nFeature_RNA|nCount_RNA|Stdev|\bExpr:/.test(text),text);
  const color = await plot.evaluate(el => ({background:el._fullLayout.hoverlabel.bgcolor,font:el._fullLayout.hoverlabel.font.color}));
  check(name+': readable tooltip colors',color.background !== color.font,color);
  await capture(page,name+'-hover');
  for (let i=0;i<30;i++) {
    await page.mouse.move(target.x+Math.sin(i/3)*14,target.y+Math.cos(i/3)*14);
    await pause(18);
  }
  if (target.type !== 'heatmap') {
    await page.mouse.move(target.blankX,target.blankY,{steps:18}); await pause(180);
    check(name+': empty space clears hover',(await plot.locator('.hoverlayer').allTextContents()).join('').trim()==='');
  }
  await page.mouse.move(1,1,{steps:18}); await pause(150);
  check(name+': pointer exit clears hover',(await plot.locator('.hoverlayer').allTextContents()).join('').trim()==='');
  // Leaving while a label is visible must not leave an overlay on another page.
  await page.mouse.move(target.x,target.y,{steps:18}); await pause(150);
  await navigate(page,'workspace');
  check(name+': leaving a hovered page clears overlay',await page.locator('.hovertext:visible').count()===0);
}
async function interactionTour(browser,theme,width) {
  const label=`${theme}-${width}`;
  const viewport={width,height:width<600?844:1000};
  const context=await browser.newContext({viewport,hasTouch:width<600,acceptDownloads:true,recordVideo:{dir:out,size:viewport}});
  const {page,consoleErrors,networkFailures}=await fixture(context,theme);
  try {
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Add analysis',exact:true}).first().click();
    await page.getByRole('button',{name:/PBMC 3k Demo Dataset/}).click();
    await page.getByText('PBMC3k · prepared real data',{exact:true}).first().waitFor();
    for (const destination of ['qc','pca','umap','featureplot','geneviewer','heatmap','dotplot']) {
      await navigate(page,destination); await prepareView(page,destination); await scrollBody(page,false);
      const name=`${label}-${destination}`;
      const pattern=destination==='qc'?/Genes detected:/ : ['pca','umap'].includes(destination)?/^Cluster \d+$/
        : ['heatmap','dotplot'].includes(destination)?/Average expression:/ : /(?:CD3E|MS4A1).*Expression:/;
      await hoverPlot(page,name,pattern);
      await navigate(page,destination);
      check(name+': returning does not restore stale hover',await page.locator('.hovertext:visible').count()===0);
      if (destination==='qc') for (const view of ['Mitochondrial %','RNA counts','Feature Scatter']) {
        const button=page.getByRole('button',{name:view,exact:true});
        if (!await button.count()) continue;
        await button.click(); await pause(250);
        await hoverPlot(page,name+'-'+view.replaceAll(' ','-'),/Mitochondrial RNA:|RNA counts:|Genes detected:/);
        await navigate(page,destination);
      }
      if (destination==='umap') {
        const field=page.getByLabel('Minimum Distance',{exact:true});
        await field.fill('');
        check(name+': blank input blocks computation',await page.getByRole('button',{name:/compute UMAP|Run 2D UMAP/}).isDisabled());
        await field.pressSequentially('0.35',{delay:70});
        check(name+': decimal remains editable',await field.inputValue()==='0.35'); await field.fill('0.3');
        const plot=page.locator('.js-plotly-plot:visible').first(); await plot.scrollIntoViewIfNeeded();
        const before=await plot.evaluate(el=>JSON.stringify(el._fullLayout.xaxis.range));
        const drag=await plot.locator('.nsewdrag').first().boundingBox();
        await page.mouse.move(drag.x+drag.width*.2,drag.y+drag.height*.2); await page.mouse.down();
        await page.mouse.move(drag.x+drag.width*.7,drag.y+drag.height*.7,{steps:32}); await page.mouse.up(); await pause(300);
        const zoom=await plot.evaluate(el=>JSON.stringify(el._fullLayout.xaxis.range));
        check(name+': continuous drag zooms',before!==zoom);
        await navigate(page,'qc'); await navigate(page,'pca'); await navigate(page,'umap');
        check(name+': earlier-tab round trip preserves zoom',await plot.evaluate((el,expected)=>JSON.stringify(el._fullLayout.xaxis.range)===expected,zoom));
        check(name+': zoom tip does not follow to another tab',!/(?:Double-click to zoom back out|Double-click on legend)/i.test(
          (await page.locator('.plotly-notifier').allTextContents()).join(' ')));
        await capture(page,name+'-zoom-return');
        await plot.locator('.modebar-btn[data-title*="Reset"]').first().click(); await pause(250);
        const downloaded=page.waitForEvent('download'); await plot.locator('.modebar-btn[data-title*="Download"]').first().click();
        const file=await downloaded, filePath=path.join(out,name+'-export.png'); await file.saveAs(filePath);
        check(name+': export produces PNG',fs.readFileSync(filePath).subarray(1,4).toString()==='PNG');
        // Reuse the measured plot's exported pixels in the simulated figure-preview response.
        await page.route('**/export-preview*', route => route.fulfill({json:{result:{base64:'data:image/png;base64,'+fs.readFileSync(filePath).toString('base64')}}}));
        await scrollBody(page,false);
        const save=page.getByRole('button',{name:'Save Figure',exact:true}); await save.click();
        const dialog=page.getByRole('dialog',{name:'Save to Figure Gallery',exact:true}); await dialog.waitFor();
        const preview=dialog.getByRole('img',{name:'Plot preview',exact:true}); await preview.waitFor();
        check(name+': figure preview shows the measured plot',await preview.evaluate(el=>el.complete&&el.naturalWidth>100));
        check(name+': export notices stay below the editor',await page.locator('.plotly-notifier').evaluateAll(elements=>
          elements.every(el=>Number(getComputedStyle(el).zIndex)<50)));
        await page.keyboard.press('Shift+Tab');
        check(name+': figure editor keeps keyboard focus',await dialog.evaluate(el=>el.contains(document.activeElement)));
        await capture(page,name+'-figure-editor'); await page.keyboard.press('Escape');
        check(name+': figure Escape closes and restores focus',await dialog.isHidden()&&await save.evaluate(el=>el===document.activeElement));
      }
    }
    await navigate(page,'history');
    const history=page.getByRole('button',{name:/Execution history.*Show details/i});
    await history.click(); await capture(page,label+'-execution-details');
    await navigate(page,'expert-r'); await page.getByRole('button',{name:'Interactive console',exact:true}).click();
    check(label+': interactive console opens on request',await page.getByText('Interactive R console · reuse a private live session',{exact:true}).evaluate(el=>el.parentElement.open));
    await capture(page,label+'-interactive-console');
    await navigate(page,'history');
    check(label+': execution disclosure survives return',await page.getByRole('button',{name:/Execution history.*Hide details/i}).isVisible());
    await page.emulateMedia({reducedMotion:'reduce'});
    check(label+': reduced motion disables long button transitions',await page.getByRole('button',{name:'Connection details',exact:true}).evaluate(el=>getComputedStyle(el).transitionDuration.split(',').every(t=>parseFloat(t)<=.01)));
    check(label+': no browser errors',consoleErrors.length===0,consoleErrors);
    check(label+': no failed requests',networkFailures.length===0,networkFailures);
  } finally {
    const video=page.video(); await context.close(); await video.saveAs(path.join(out,`hover-and-transitions-${label}.webm`));
  }
}
async function authTour(browser,theme,width) {
  const label=`${theme}-${width}`;
  const viewport={width,height:width<600?844:1000};
  const context=await browser.newContext({viewport,recordVideo:{dir:out,size:viewport}});
  const {page,networkFailures}=await fixture(context,theme);
  await page.route('**/api/auth/session*',route=>route.fulfill({status:401,json:{error:'Not authenticated.'}}));
  await page.route('**/api/auth/login',route=>route.fulfill({status:401,json:{error:'Invalid email or password.'}}));
  const authCapture=async name=>{
    await page.screenshot({path:path.join(out,name+'.png')});
    observations.push({name,text:await page.locator('body').innerText()});
  };
  try {
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Open Workbench',exact:true}).waitFor();
    const email=page.getByLabel('Email',{exact:true}), password=page.getByLabel('Password',{exact:true});
    await email.fill('ui-review@example.invalid'); await password.fill('Review-only-123!');
    await page.getByRole('button',{name:'Show password',exact:true}).click();
    check(label+': password visibility control works',await password.getAttribute('type')==='text');
    await page.getByRole('button',{name:'Hide password',exact:true}).click();
    await page.getByRole('button',{name:'Sign Up',exact:true}).click();
    await page.getByLabel('Full name',{exact:true}).fill('UI review');
    await page.getByLabel('Confirm password',{exact:true}).fill('Different-value');
    check(label+': mismatched passwords prevent signup',await page.getByRole('button',{name:'Create Account',exact:true}).isDisabled());
    await authCapture(label+'-signup');
    await page.getByLabel('Confirm password',{exact:true}).fill('Review-only-123!');
    check(label+': valid signup draft remains usable',await page.getByRole('button',{name:'Create Account',exact:true}).isEnabled());
    await page.getByRole('button',{name:'Log In',exact:true}).click();
    check(label+': sign-in return preserves email',await email.inputValue()==='ui-review@example.invalid');
    await page.getByRole('button',{name:'Open Workbench',exact:true}).click();
    await page.getByRole('alert').waitFor();
    check(label+': sign-in error is short and actionable',await page.getByRole('alert').innerText()==='Invalid email or password.');
    check(label+': failed sign-in preserves editable email',await email.inputValue()==='ui-review@example.invalid'&&await email.isEditable());
    await authCapture(label+'-signin-error');
    check(label+': authentication page fits viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();
    check(label+': authentication labels and error contrast',!audit.violations.some(v=>['critical','serious'].includes(v.impact)),
      audit.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>({id:v.id,nodes:v.nodes.map(n=>n.html).slice(0,3)})));
    check(label+': only expected authentication rejections',networkFailures.length===2&&networkFailures.every(failure=>
      /\/api\/auth\/(?:session|login)/.test(failure)&&failure.includes('401')),networkFailures);
  } finally {
    const video=page.video();await context.close();await video.saveAs(path.join(out,`authentication-${label}.webm`));
  }
}
// A watchable tour: one recording, readable pauses, progressive scrolling,
// secondary views and dialogs. It reuses the measured-data UI fixtures above.
async function walkthrough(browser) {
  const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:out,size:{width:1440,height:1000}}});
  const started=Date.now();
  const {page,consoleErrors,networkFailures}=await fixture(context,'light');
  let signedIn=false;
  const user={id:1,email:'researcher@lab.edu',displayName:'Visual Tester'};
  await page.route('**/api/auth/session*',route=>route.fulfill(signedIn?{json:{user,authVia:'cookie'}}:{status:401,json:{error:'Not authenticated.'}}));
  await page.route('**/api/auth/login',route=>{signedIn=true;return route.fulfill({json:{user,authVia:'cookie'}});});
  const measuredPNG=fs.readFileSync(path.join(root,'playwright/report/ui-audit/interactions/light-1440-umap-export.png'));
  const preview='data:image/png;base64,'+measuredPNG.toString('base64');
  await page.route('**/export-preview*',route=>route.fulfill({json:{result:{base64:preview}}}));
  await page.route('**/api/db/figures*',route=>route.fulfill({json:[{
    id:'fig_walkthrough_pbmc',projectId,analysisObjectId:objectId,title:'PBMC3k clusters',plotType:'UMAP',fileFormat:'png',
    thumbnailB64:preview,createdAt:'2026-10-11T12:00:00Z',
  }]}));
  const chapter=async title=>{
    chapters.push({title,seconds:Number(((Date.now()-started)/1000).toFixed(2))});
    await page.evaluate(title=>{
      let label=document.getElementById('walkthrough-chapter');
      if(!label){label=document.createElement('div');label.id='walkthrough-chapter';label.setAttribute('aria-hidden','true');
        label.style.cssText='position:fixed;top:9px;left:50%;transform:translateX(-50%);z-index:2147483646;pointer-events:none;border:1px solid #cbd5e1;border-radius:6px;padding:5px 10px;background:#ffffffed;color:#334155;font:12px system-ui;white-space:nowrap';document.body.appendChild(label);}
      label.textContent=title;
    },title);
    console.log('SHOW '+title);
  };
  const humanClick=async locator=>{
    await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();assert.ok(box);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:24});await pause(180);await locator.click();
  };
  const read=async(ms=2600)=>{await page.mouse.move(1,1,{steps:20});await pause(ms);};
  const scrollThrough=async(container=page.locator('main'))=>{
    const body=await container.evaluateHandle(root=>[root,...root.querySelectorAll('*')]
      .filter(el=>el.getBoundingClientRect().height>0&&el.scrollHeight>el.clientHeight+30&&['auto','scroll'].includes(getComputedStyle(el).overflowY))
      .sort((a,b)=>b.clientHeight-a.clientHeight)[0]||null);
    try {
      const state=await body.evaluate(el=>el&&({max:el.scrollHeight-el.clientHeight,height:el.clientHeight,top:el.scrollTop,rect:el.getBoundingClientRect().toJSON()}));
      if(!state||state.max<30)return;
      await page.mouse.move(state.rect.x+state.rect.width*.88,state.rect.y+state.rect.height*.65,{steps:18});
      let top=state.top;
      for(let step=0;step<30&&top<state.max-2;step++){
        await page.mouse.wheel(0,Math.min(400,state.height*.65));await pause(700);
        const next=await body.evaluate(el=>el.scrollTop);
        if(next===top)break;
        top=next;await pause(700);
      }
      await read(1600);
    } finally {await body.dispose();}
  };
  const visit=async destination=>{
    const locator=destination==='account'?page.getByRole('button',{name:'Account security',exact:true}).last()
      :page.locator(`aside button[data-destination="${destination}"]`).first();
    const title=destination==='account'?'Account security':await locator.locator('span').first().innerText();
    await humanClick(locator);await pause(600);await scrollBody(page,false);return title;
  };
  const subview=async(title,name)=>{
    await chapter(title);await humanClick(page.getByRole('button',{name,exact:true}));await read(2200);await scrollThrough();
  };
  try{
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Open Workbench',exact:true}).waitFor();
    await chapter('Sign in');await read(3500);
    await humanClick(page.getByRole('button',{name:'Sign Up',exact:true}));await chapter('Sign up');await read(3500);
    await humanClick(page.getByRole('button',{name:'Log In',exact:true}));
    await page.getByLabel('Email',{exact:true}).pressSequentially(user.email,{delay:45});
    await page.getByLabel('Password',{exact:true}).pressSequentially('Review-only-123!',{delay:65});
    await humanClick(page.getByRole('button',{name:'Open Workbench',exact:true}));
    await page.getByRole('button',{name:'Add analysis',exact:true}).first().waitFor();
    await chapter('Load the measured PBMC3k analysis');
    await humanClick(page.getByRole('button',{name:'Add analysis',exact:true}).first());await read(1800);
    await humanClick(page.getByRole('button',{name:/PBMC 3k Demo Dataset/}));
    await page.getByText('PBMC3k · prepared real data',{exact:true}).first().waitFor();
    for(let i=0;i<destinations.length;i++){
      const destination=destinations[i],title=await visit(destination),label=`${i+1}/26 · ${title}`;
      await chapter(label);await prepareView(page,destination);await scrollBody(page,false);await read(3000);
      await capture(page,`page-${String(i+1).padStart(2,'0')}-${destination}`);
      check(title+': shown',!(await page.getByRole('heading',{name:'Analysis unavailable',exact:true}).isVisible()));
      await scrollThrough();await scrollBody(page,false);
      if(destination==='workspace'){
        await humanClick(page.getByRole('button',{name:'Dataset details',exact:true}));await chapter(label+' · Dataset details');await read(2800);await page.keyboard.press('Escape');
      }else if(destination==='history'){
        await humanClick(page.getByRole('button',{name:/Execution history.*Show details/i}));await chapter(label+' · Execution history');await read();await scrollThrough();
      }else if(destination==='expert-r'){
        await humanClick(page.getByRole('button',{name:'Interactive console',exact:true}));await chapter(label+' · Interactive console');await read(3000);await scrollThrough();
      }else if(destination==='inspect'){
        await page.getByPlaceholder('Filter columns…').fill('');
        for(const name of ['Overview','Add Metadata','Subset'])await subview(label+' · '+name,name);
      }else if(destination==='qc'){
        for(const name of ['Mitochondrial %','RNA counts','Feature Scatter','Distribution Summary'])await subview(label+' · '+name,name);
      }else if(destination==='pca'){
        for(const name of ['Elbow Plot','Gene Loadings'])await subview(label+' · '+name,name);
      }else if(destination==='umap'){
        await chapter(label+' · Cell hover');const point=page.locator('.js-plotly-plot:visible .scatterlayer .point').first();
        await point.scrollIntoViewIfNeeded();const pointBox=await point.boundingBox();assert.ok(pointBox);
        await page.mouse.move(pointBox.x+pointBox.width/2,pointBox.y+pointBox.height/2,{steps:24});await pause(1800);await read(1200);
        await scrollBody(page,false);await humanClick(page.getByRole('button',{name:'Save Figure',exact:true}));
        await chapter(label+' · Figure editor');const dialog=page.getByRole('dialog',{name:'Save to Figure Gallery',exact:true});
        await dialog.getByRole('img',{name:'Plot preview',exact:true}).waitFor();await read(3500);await scrollThrough(dialog);await page.keyboard.press('Escape');
      }else if(destination==='geneviewer'){
        await subview(label+' · Expression distribution','VlnPlot');
      }
      await read(1000);
    }
    await chapter('Connection details and server readiness');await humanClick(page.getByRole('button',{name:'Connection details',exact:true}));await read(3000);
    await humanClick(page.getByRole('button',{name:'Check server readiness',exact:true}));
    const readiness=page.getByRole('dialog',{name:'Server readiness'});await readiness.waitFor();await read(3500);await scrollThrough(readiness);await page.keyboard.press('Escape');
    await chapter('Dark theme · Workspace');await humanClick(page.getByRole('button',{name:'Switch to dark mode',exact:true}));await visit('workspace');await read(3500);
    await chapter('Dark theme · UMAP');await visit('umap');await read(4000);
    await chapter('Return to the workspace');await visit('workspace');await read(3500);
    check('All 26 full-app pages recorded',destinations.length===checks.filter(c=>c.name.endsWith(': shown')).length);
    check('No unexpected failed requests',networkFailures.every(f=>f.includes('/api/auth/session')&&f.includes('401')),networkFailures);
    check('No unexpected browser errors',consoleErrors.every(message=>/401|Unauthorized/.test(message)),consoleErrors);
  }finally{
    const video=page.video();await context.close();await video.saveAs(path.join(out,'all-pages-walkthrough.webm'));
    fs.writeFileSync(path.join(out,'chapters.json'),JSON.stringify(chapters,null,2));
  }
}
async function pipelineLayoutTour(browser, theme, width) {
  const label = `${theme}-${width}`, height = width < 600 ? 844 : 1000;
  const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: out, size: { width, height } } });
  const { page, consoleErrors, networkFailures, requests: pageRequests } = await fixture(context, theme);
  let opened = false;
  await page.route('**/api/projects/*/analysis-objects**', async route => {
    if (!new URL(route.request().url()).pathname.endsWith('/analysis-objects')) return route.fallback();
    if (route.request().method() === 'POST') opened = true;
    if (!opened && route.request().method() === 'GET') return route.fulfill({ json: [] });
    return route.fallback();
  });
  const datasets = ['control_1', 'control_2', 'treated_1', 'treated_2'].map((name, index) => ({
    id: `ds_layout_${index}`, projectId, fileType: 'tenx_h5', originalFilename: `${name}.h5`, uploadStatus: 'uploaded', validationStatus: 'valid',
  }));
  await page.route('**/api/projects/*/datasets*', route => route.fulfill({ json: new URL(route.request().url()).searchParams.get('fileType') === 'visium_zip' ? [] : datasets }));
  const submissions = [];
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/jobs')) submissions.push(request.postDataJSON()); });
  const ui = page.getByTestId('seurat-pipeline-panel');
  const automatic = ui.getByRole('tab', { name: 'Run whole pipeline', exact: true });
  const guided = ui.getByRole('tab', { name: 'Inspect step by step', exact: true });
  const shot = name => capture(page, `${label}-${name}`);
  const audit = async name => {
    const result = await new AxeBuilder({ page }).include('[data-testid="seurat-pipeline-panel"]').withTags(['wcag2a', 'wcag2aa']).analyze();
    const issues = result.violations.filter(v => ['serious', 'critical'].includes(v.impact));
    check(`${label} ${name}: accessible`, issues.length === 0, issues.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.html) })));
  };
  const click = async locator => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
    await pause(220); await locator.click(); await pause(350);
  };
  try {
    await page.goto(origin, { waitUntil: 'networkidle' });
    await navigate(page, 'pipeline-manager'); await scrollBody(page, false);
    await ui.getByText('control_1.h5', { exact: true }).waitFor();
    await pause(1000); await shot('complete-run');
    check(`${label}: empty run cards removed`, await ui.getByRole('heading', { name: 'Run status' }).count() === 0);
    check(`${label}: six ordered step groups`, await ui.locator('.pipeline-step-row').count() === 6);
    await audit('complete run');
    const settings = ui.locator('.pipeline-settings');
    if (width >= 600) await settings.screenshot({ path: path.join(out, `${label}-settings.png`) });
    else for (const name of ['Quality control', 'Normalization', 'PCA', 'Clustering', 'UMAP']) {
      await ui.getByRole('group', { name, exact: true }).scrollIntoViewIfNeeded();
      await shot('step-' + name.toLowerCase().replaceAll(' ', '-'));
    }
    const geometry = await settings.locator('.pipeline-step-row').evaluateAll(rows => rows.map(row => {
      const fields = [...row.querySelectorAll('.pipeline-parameter')].map(el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right }; });
      return { title: row.querySelector('h5').textContent, width: row.clientWidth, height: row.clientHeight,
        overflowing: row.scrollWidth > row.clientWidth + 1, lines: new Set(fields.map(f => Math.round(f.y))).size,
        outside: fields.some(f => f.x < 0 || f.right > innerWidth + 1) };
    }));
    check(`${label}: controls fit within step rows`, geometry.every(row => !row.overflowing && !row.outside), geometry);
    if (width < 600) check(`${label}: UMAP wraps when space is limited`, geometry.find(row => row.title === 'UMAP').lines > 1, geometry);
    await click(guided);
    check(`${label}: unopened analysis requires workspace selection`, await ui.getByRole('button', { name: 'Open Quality control' }).isDisabled());
    await click(ui.getByRole('button', { name: 'Choose / open analysis' }));
    await click(page.getByRole('button', { name: 'Add analysis', exact: true }).first());
    await click(page.getByRole('button', { name: /PBMC 3k Demo Dataset/ }));
    await page.getByText('PBMC3k · prepared real data', { exact: true }).first().waitFor();
    await navigate(page, 'pipeline-manager'); await scrollBody(page, false);
    check(`${label}: approach survives leaving and returning`, await guided.getAttribute('aria-selected') === 'true');
    check(`${label}: live analysis enables inspection`, await ui.getByRole('button', { name: 'Open Quality control' }).isEnabled());
    await shot('step-by-step'); await audit('step by step'); await pause(1400);
    for (const [name, route] of [['Inspect', 'inspect'], ['Quality control', 'qc'], ['Normalization', 'normalize'], ['Integration (optional)', 'integrate'], ['PCA', 'pca'], ['Clustering', 'cluster'], ['UMAP', 'umap']]) {
      await click(ui.getByRole('button', { name: `Open ${name}`, exact: true }));
      await prepareView(page, route); await pause(650);
      check(`${label}: opens ${name}`, !(await ui.isVisible()) && !(await page.getByRole('heading', { name: 'Analysis unavailable', exact: true }).isVisible()));
      if (route === 'qc' || route === 'pca' || route === 'umap') await shot('inspect-' + route);
      await navigate(page, 'pipeline-manager'); await scrollBody(page, false);
      check(`${label}: returns to inspection after ${name}`, await guided.getAttribute('aria-selected') === 'true');
    }
    check(`${label}: inspection navigation submits no jobs`, submissions.length === 0, submissions);
    await guided.focus(); await page.keyboard.press('Home');
    check(`${label}: Home selects and focuses complete-run tab`, await automatic.evaluate(el => el === document.activeElement && el.getAttribute('aria-selected') === 'true'));
    await page.keyboard.press('ArrowRight');
    check(`${label}: arrows select and focus inspection tab`, await guided.evaluate(el => el === document.activeElement && el.getAttribute('aria-selected') === 'true'));
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Tab');
    check(`${label}: Tab enters the active panel`, await page.evaluate(() => document.activeElement.closest('[role="tabpanel"]')?.getAttribute('hidden') === null));
    const resolution = ui.getByLabel('Resolution', { exact: true });
    await resolution.fill(''); await resolution.pressSequentially('0.65', { delay: 90 });
    check(`${label}: decimal typing preserves every digit`, await resolution.inputValue() === '0.65');
    await resolution.press('ArrowUp');
    check(`${label}: arrow keys increment the numeric step`, await resolution.inputValue() === '0.66');
    await resolution.press('ArrowDown');
    const components = ui.getByLabel('PCA components', { exact: true });
    await components.fill('35'); await components.press('ArrowUp'); await components.press('ArrowDown');
    check(`${label}: integer arrow round trip preserves value`, await components.inputValue() === '35');
    const mitochondrial = ui.getByLabel('Max mitochondrial RNA (%)', { exact: true });
    await mitochondrial.fill(''); await mitochondrial.pressSequentially('7.5', { delay: 90 });
    check(`${label}: QC decimal typing preserves the fraction`, await mitochondrial.inputValue() === '7.5');
    await click(ui.getByLabel('Apply QC filter', { exact: true }));
    check(`${label}: QC off hides unused thresholds`, await ui.getByLabel('Max mitochondrial RNA (%)', { exact: true }).count() === 0);
    await click(ui.getByLabel('Apply QC filter', { exact: true }));
    check(`${label}: QC thresholds retained`, await ui.getByLabel('Max mitochondrial RNA (%)', { exact: true }).inputValue() === '7.5');
    await ui.getByLabel('Scale factor', { exact: true }).fill('12000');
    const method = ui.getByRole('combobox', { name: 'Normalization', exact: true });
    await method.selectOption('SCTransform');
    check(`${label}: SCTransform hides log-only control`, await ui.getByLabel('Scale factor', { exact: true }).count() === 0);
    await method.selectOption('LogNormalize');
    check(`${label}: LogNormalize scale factor retained`, await ui.getByLabel('Scale factor', { exact: true }).inputValue() === '12000');
    await click(ui.getByText('Reproducibility', { exact: true }));
    await ui.getByLabel('Seed (optional)', { exact: true }).fill('42');
    await shot('edited-settings');
    await click(guided); await click(automatic);
    await navigate(page, 'qc'); await navigate(page, 'umap'); await navigate(page, 'pipeline-manager');
    check(`${label}: draft survives approach and page round trips`, await ui.getByLabel('Resolution', { exact: true }).inputValue() === '0.65'
      && await ui.getByLabel('PCA components', { exact: true }).inputValue() === '35' && await ui.getByLabel('Seed (optional)', { exact: true }).inputValue() === '42');
    for (const target of [automatic, guided, ui.getByRole('button', { name: 'Refresh datasets', exact: true })]) {
      await target.scrollIntoViewIfNeeded(); await page.mouse.move(1, 1); await pause(200);
      const before = await target.boundingBox(); await target.hover();
      for (const delay of [20, 80, 160]) {
        await pause(delay); const after = await target.boundingBox();
        check(`${label}: ${await target.innerText()} hover frame ${delay}ms keeps geometry`, ['x', 'y', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) < 0.5));
      }
    }
    await page.mouse.move(1, 1); await shot('tab-hover');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(`${label}: approach respects reduced motion`, await guided.evaluate(el => getComputedStyle(el).transitionDuration.split(',').every(value => parseFloat(value) <= 0.001)));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await click(ui.getByRole('button', { name: 'Multiple conditions', exact: true }));
    for (const dataset of datasets) await click(ui.getByRole('checkbox', { name: new RegExp(dataset.originalFilename.replace('.', '\\.')) }));
    for (const dataset of datasets) await ui.getByLabel(`Condition for ${dataset.originalFilename}`).fill(dataset.originalFilename.startsWith('control') ? 'control' : 'treated');
    check(`${label}: multi-condition design enables one run`, await ui.getByRole('button', { name: 'Prepare multi-condition analysis', exact: true }).isEnabled());
    await shot('multiple-conditions'); await audit('multiple conditions');
    await click(ui.getByRole('button', { name: 'Spatial transcriptomics (Visium)', exact: true }));
    check(`${label}: spatial selection preserves unsupported-format guidance`, await ui.getByText(/Visium HD and Xenium are not accepted/).isVisible());
    await shot('spatial');
    await click(ui.getByRole('button', { name: 'Single-cell RNA', exact: true }));
    await ui.getByText('control_1.h5', { exact: true }).waitFor();
    await click(ui.getByRole('button', { name: 'Run Seurat preprocessing', exact: true }));
    await ui.getByRole('heading', { name: 'Run status', exact: true }).waitFor();
    check(`${label}: complete run submits exactly one job`, submissions.length === 1 && submissions[0].jobType === 'seurat.pipeline.v1', submissions);
    check(`${label}: complete run carries edited numeric settings`, submissions[0]?.parameters?.clusterResolution === 0.65
      && submissions[0]?.parameters?.pcaDims === 35 && submissions[0]?.parameters?.seed === 42, submissions[0]);
    await click(guided);
    check(`${label}: active run remains available in inspection mode`, await ui.getByRole('heading', { name: 'Run status', exact: true }).isVisible());
    await ui.getByRole('heading', { name: 'Run status', exact: true }).scrollIntoViewIfNeeded(); await shot('run-status');
    await navigate(page, 'workspace'); await navigate(page, 'pipeline-manager');
    check(`${label}: returning does not resubmit the run`, submissions.length === 1);
    check(`${label}: page fits viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check(`${label}: no browser errors`, consoleErrors.length === 0, consoleErrors);
    check(`${label}: no failed requests`, networkFailures.length === 0, networkFailures);
    check(`${label}: recorded full-app pipeline review`, pageRequests.length > 0);
  } finally {
    const video = page.video(); await context.close(); await video.saveAs(path.join(out, `pipeline-${label}.webm`));
  }
}
let server, browser;
(async () => {
  fs.mkdirSync(out, { recursive: true });
  // Freeze assets for this recording so a later developer build cannot replace
  // lazy-loaded chunks partway through a long navigation tour.
  const reviewBuild = path.join(out, 'build');
  fs.cpSync(path.join(root,'dist'),reviewBuild,{recursive:true});
  server = spawn(process.execPath, [path.join(root,'node_modules/vite/bin/vite.js'),'preview','--outDir',reviewBuild,'--port',String(port),'--strictPort'], { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  await new Promise((resolve,reject) => {
    server.stdout.on('data', data => { if (data.toString().includes('Local:')) resolve(); });
    server.stderr.on('data', data => console.error(data.toString()));
    server.once('exit', code => reject(new Error('Vite exited '+code)));
    setTimeout(() => reject(new Error('Vite startup timeout')),30000).unref();
  });
  browser = await chromium.launch({ headless: true });
  if(walkthroughOnly){await walkthrough(browser);return;}
  const contexts=[];
  for (const theme of ['light','dark']) for (const width of [1440,390]) {
    if (phase === 'before' && (theme !== 'light' || width !== 1440)) continue;
    contexts.push({theme,width});
  }
  const tourResults=await Promise.allSettled(contexts.map(({theme,width}) =>
    (pipelineLayoutOnly ? pipelineLayoutTour : authOnly ? authTour : interactionsOnly ? interactionTour : tour)(browser,theme,width)));
  for (const result of tourResults) if (result.status==='rejected') throw result.reason;
})().catch(error => { console.error(error); check('Tour completed',false,error.message); process.exitCode=1; }).finally(async () => {
  if (browser) await browser.close(); if (server) server.kill();
  fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify({ source: measured.source, checks, requests },null,2));
  fs.writeFileSync(path.join(out,'observations.json'),JSON.stringify(observations,null,2));
  console.log(`${checks.filter(c=>c.passed).length}/${checks.length} passed: ${out}`);
  if (checks.some(c=>!c.passed)) process.exitCode=1;
});
