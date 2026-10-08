#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function assert(condition, message) { if (!condition) throw new Error(message); }
async function navigate(page, label) {
  await page.getByRole('button', { name: new RegExp('^' + label + '(?:,|$)', 'i') }).click();
}
async function read(page, objectId, endpoint) {
  return page.evaluate(({ id, route }) => window.electronAPI.apiRequest(route,
    { headers: { 'X-Object-ID': id } }), { id: objectId, route: endpoint });
}
async function plottedCoordinates(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('.js-plotly-plot')]
    .some(plot => plot.offsetWidth && plot.offsetHeight && plot.data?.some(trace => trace.x?.length && trace.y?.length)));
  return page.locator('.js-plotly-plot:visible').first().evaluate(plot => plot.data
    .map(trace => ({ x: Array.from(trace.x || []), y: Array.from(trace.y || []) })));
}

// Run after restoring a known checkpoint in the disposable real-service demo.
// Navigation and reload must only inspect the reductions already in R.
async function assertRestoredAnalysisResults({ page, objectId, artifactDirectory } = {}) {
  assert(page && objectId, 'A restored analysis page and object identifier are required.');
  const output = artifactDirectory || path.join(__dirname, '..', 'playwright', 'report',
    'restored-results-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(output, { recursive: true });
  const requests = [];
  const track = request => {
    const url = new URL(request.url());
    if (/^\/api\/r\/(pca|umap)$/.test(url.pathname)
        || (request.method() === 'POST' && /\/api\/(?:jobs(?:\/|$)|projects\/[^/]+\/provenance(?:\/|$))/.test(url.pathname))) {
      requests.push(request.method() + ' ' + url.pathname);
    }
  };
  page.on('request', track);
  try {
    const before = await read(page, objectId, '/pipeline-state');
    const pca = await read(page, objectId, '/reduction-results?reduction=pca');
    const umap = await read(page, objectId, '/reduction-results?reduction=umap');
    assert(before.exists && before.has_pca && before.has_umap, 'The fixture does not contain saved PCA and UMAP.');
    assert(pca.result?.n_points > 0 && umap.result?.n_points > 0, 'Restored reductions have no existing coordinates.');
    assert(!pca.provenance && !umap.provenance, 'Inspecting a reduction created new provenance.');

    await navigate(page, 'PCA');
    await page.getByText(/Showing the existing PCA from this analysis/).waitFor();
    await page.getByRole('button', { name: 'PC1 vs PC2', exact: true }).click();
    const pcaPlot = await plottedCoordinates(page);
    assert(JSON.stringify(pcaPlot) === JSON.stringify(pca.result.trace_data.map(trace => ({ x: trace.x, y: trace.y }))),
      'The PCA viewer changed the existing coordinates.');
    await page.screenshot({ path: path.join(output, 'restored-pca.png') });

    await navigate(page, 'UMAP');
    await page.getByText(/Showing the existing UMAP from this analysis/).waitFor();
    const initialUmapPlot = await plottedCoordinates(page);
    assert(JSON.stringify(initialUmapPlot) === JSON.stringify(umap.result.trace_data.map(trace => ({ x: trace.x, y: trace.y }))),
      'The UMAP viewer changed the existing coordinates.');
    if (umap.result.settings?.dims != null) {
      assert(Number(await page.getByLabel(/Input Dimensions/).inputValue()) === umap.result.settings.dims,
        'Restored UMAP controls do not describe the original PC count.');
    }
    await page.screenshot({ path: path.join(output, 'restored-umap.png') });

    // Clear plot preferences to establish that local parameter defaults/cache do
    // not supply the saved result. Authentication cookies and project selection
    // remain intact so the same owned object is reopened.
    await page.evaluate(() => Object.keys(localStorage).filter(key => /^traceomics_params_(umap|pca)/.test(key))
      .forEach(key => localStorage.removeItem(key)));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await navigate(page, 'UMAP');
    await page.getByText(/Showing the existing UMAP from this analysis/).waitFor();
    const reopened = await plottedCoordinates(page);
    assert(JSON.stringify(reopened) === JSON.stringify(initialUmapPlot), 'Reload replaced the saved UMAP coordinates.');
    const after = await read(page, objectId, '/pipeline-state');
    assert(after.live_revision === before.live_revision && after.saved_revision === before.saved_revision
      && after.has_unsaved_changes === before.has_unsaved_changes,
    'Viewing restored plots changed the authoritative saved/live state.');
    assert(requests.length === 0, 'Viewing restored plots requested computation: ' + requests.join(', '));
    const result = { completedAt: new Date().toISOString(), objectId,
      checks: ['existing PCA coordinates', 'existing UMAP coordinates and settings',
        'reload without local plot preferences', 'no compute requests, provenance, or live revision changes'] };
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
    return { artifactDirectory: output, ...result };
  } finally {
    page.off('request', track);
  }
}
module.exports = { assertRestoredAnalysisResults };
