#!/usr/bin/env node

'use strict';

// Focused Playwright browser contract for the durable CellChat UI. The browser
// talks to the actual React application served by Vite; project/job endpoints
// are deliberately mocked here so this test proves UI wiring and safe rendering
// independently from the separate real-R inference and receipt tests.

const assert = require('assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const WORKSPACE = path.resolve(__dirname, '..');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError || new Error('Timed out waiting for the browser flow.');
}

function jsonBody(request) {
  try {
    return JSON.parse(request.postData() || '{}');
  } catch {
    return {};
  }
}

async function fulfill(route, body, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });
}

async function main() {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  // Vite's package export map intentionally hides its CLI subpath. Resolve the
  // package entrypoint, then use its adjacent installed CLI with this Node
  // executable so the test is portable to Windows without spawning `npx.cmd`.
  const viteCli = path.resolve(path.dirname(require.resolve('vite')), '..', '..', 'bin', 'vite.js');
  const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: WORKSPACE,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let browser;
  const viteOutput = [];
  vite.stdout.on('data', chunk => viteOutput.push(chunk.toString()));
  vite.stderr.on('data', chunk => viteOutput.push(chunk.toString()));

  try {
    await waitFor(async () => {
      if (vite.exitCode !== null) {
        throw new Error(`Vite exited before the browser test started (code ${vite.exitCode}): ${viteOutput.join('')}`);
      }
      return (await fetch(origin)).ok;
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
      window.electronAPI = {
        getFigures: async () => [],
        saveFigure: async () => ({ success: true }),
        deleteFigure: async () => ({ success: true }),
        setTheme: () => {},
      };
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const requestFailures = [];
    const serverErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') {
        const location = message.location();
        consoleErrors.push(`${message.text()}${location?.url ? ` (${location.url}:${location.lineNumber || 0})` : ''}`);
      }
    });
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('requestfailed', request => requestFailures.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`
    ));
    page.on('response', response => {
      if (response.status() >= 500) {
        serverErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      }
    });

    const user = { id: 1, email: 'cellchat.browser@example.invalid', displayName: 'CellChat Browser' };
    const organization = { id: 'org_cellchat_browser', name: 'CellChat Browser Org', role: 'owner' };
    const project = {
      id: 'proj_cellchat_browser', organizationId: organization.id, name: 'CellChat Browser Project',
      description: '', role: 'owner', createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    };
    const object = {
      id: 'ao_c311ca7b0a1', ownerUserId: user.id, projectId: project.id,
      datasetId: null, parentObjectId: null, lineageRootId: 'ao_c311ca7b0a1', objectType: 'seurat',
      displayName: 'Browser CellChat object', metadata: { summary: { cells: 1200, features: 5000, density: 2.1 } },
      createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    };
    const defaultManifest = {
      schemaVersion: 1,
      id: 'default-seurat-scrna-v1',
      name: 'Default Seurat scRNA-seq Pipeline',
      modality: 'scrna',
      tabs: [
        { id: 'workspace', label: 'Workspace', moduleKey: 'workspace', optional: false, parameterSchema: [], resultArtifactTypes: [], resultViews: [] },
        { id: 'cellchat', label: 'CellChat', moduleKey: 'cellChat', optional: false, parameterSchema: [], resultArtifactTypes: [], resultViews: [] },
      ],
    };
    const pipelineDefinition = {
      id: defaultManifest.id, manifestId: defaultManifest.id, projectId: project.id, visibility: 'builtin',
      name: defaultManifest.name, manifest: defaultManifest, createdAt: null, updatedAt: null,
    };
    let createdJob = null;
    const launchBodies = [];
    const groupKeyRequests = [];
    const summary = {
      method: 'cellchat_v2_predicted_signaling', analysisIntent: 'single_context', groupBy: 'seurat_clusters',
      assay: 'RNA', species: 'human', databaseCategory: 'secreted_signaling', pValueCutoff: 0.05,
      inputCellCount: 1200, analyzedCellCount: 1000, inputGroupCount: 3, analyzedGroupCount: 2,
      excludedGroupCount: 1, candidateInteractionCount: 14, retainedInteractionCount: 3, retainedPathwayCount: 2,
      groups: [
        { group: 'Group 1', inputCells: 600, analyzedCells: 500 },
        { group: 'Group 2', inputCells: 600, analyzedCells: 500 },
      ],
      excludedGroups: [{ group: 'Group 3', inputCells: 4, reason: 'below_min_cells' }],
      packageVersions: { r: '4.5.3', seurat: '5.5.1', cellchat: '2.1.2', cellchatDb: 'CellChatDB.human 2.1.2' },
      topInteractions: [{
        source: 'Group 1', target: 'Group 2', interaction: 'TGFB1.TGFBR1_TGFBR2', pathway: 'TGFb',
        probability: 0.42, pValue: 0.001, category: 'secreted_signaling',
      }],
      topPathways: [{ source: 'Group 1', target: 'Group 2', pathway: 'TGFb', probability: 0.42, pValue: 0.001 }],
      warnings: ['Eligible groups were deterministically capped for bounded CellChat inference.'],
    };

    await page.route('**/health*', route => fulfill(route, { status: 'ok' }));
    await page.route('**/api/runtime/diagnostics*', route => fulfill(route, {
      supportedTarget: 'R 4.5.x', runtime: { status: 'ok', mode: 'mocked browser transport', rVersion: '4.5.3' },
      packages: { Seurat: true, CellChat: true, plumber: true, jsonlite: true },
    }));
    await page.route('**/api/auth/policy*', route => fulfill(route, {
      registrationEnabled: true, legacyLocalImportsEnabled: false, legacyLiveMutationToolsEnabled: false,
      serverFigureExportEnabled: false,
    }));
    await page.route('**/api/auth/session*', route => fulfill(route, { user, authVia: 'cookie' }));
    await page.route('**/api/pipeline-registry/capabilities*', route => fulfill(route, { canPublishPipelineManifests: false }));
    await page.route('**/api/organizations**', route => fulfill(route, [organization]));
    await page.route('**/api/db/**', route => fulfill(route, []));
    await page.route('**/session-id*', route => fulfill(route, { sessionId: 'cellchat-browser-session' }));
    await page.route('**/pipeline-state*', route => fulfill(route, {
      exists: true, has_qc: true, has_normalized: true, has_pca: true, pca_dims: 15,
      has_clusters: true, n_clusters: 3, has_umap: true,
    }));
    // The application keeps other analysis tabs mounted. Return their bounded
    // read-only data too, so accidental 5xx responses cannot be hidden by a
    // CellChat-focused browser test.
    await page.route('**/api/r/qc-distributions*', route => fulfill(route, {
      percent_mt: [1.2], nFeature_RNA: [1200], nCount_RNA: [3000],
      n_cells: 1200, n_values: 1, sampled: true,
    }));
    await page.route('**/api/r/object-info*', route => fulfill(route, {
      n_cells: 1200,
      n_features: 5000,
      meta_cols: [{ name: 'seurat_clusters', type: 'factor', n_unique: 3 }],
      assays: ['RNA'],
      reductions: ['pca', 'umap'],
    }));
    await page.route('**/api/r/heatmap*', route => fulfill(route, {
      genes: ['CD3E'], clusters: ['0'], z: [[1]],
      n_cells: 1200, analysis_cells: 1200, sampled: false,
    }));
    await page.route('**/api/r/genes*', route => fulfill(route, {
      genes: ['CD3E'], count: 1, returned_count: 1, truncated: false,
    }));
    await page.route('**/api/r/meta-values?column=seurat_clusters*', route => fulfill(route, {
      column: 'seurat_clusters', n_unique: 3, returned_count: 3, truncated: false,
      values: [
        { value: '0', count: 600 },
        { value: '1', count: 596 },
        { value: '2', count: 4 },
      ],
    }));
    await page.route('**/api/r/cellchat-group-map*', route => {
      groupKeyRequests.push({
        url: route.request().url(),
        objectId: route.request().headers()['x-object-id'],
      });
      return fulfill(route, {
        group_by: 'seurat_clusters',
        groups: [
          { group: 'Group 1', label: 'CD4 T cells', input_cells: 600 },
          { group: 'Group 2', label: 'B cells', input_cells: 600 },
          { group: 'Group 3', label: 'Rare cells', input_cells: 4 },
        ],
      });
    });

    await page.route('**/api/projects/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const jobBase = `/api/projects/${project.id}/jobs`;
      if (pathname === jobBase && request.method() === 'POST') {
        const payload = jsonBody(request);
        launchBodies.push(payload);
        createdJob = {
          id: 'job_cellchat_browser', status: 'completed', jobType: 'cellchat.infer.v1',
          analysisObjectId: object.id, datasetId: null, resultAnalysisObjectId: null,
          parameters: payload.parameters, createdAt: '2026-07-18T00:00:00.000Z',
        };
        return fulfill(route, createdJob, 201);
      }
      if (pathname === `${jobBase}/job_cellchat_browser`) return fulfill(route, createdJob || {});
      if (pathname === `${jobBase}/job_cellchat_browser/logs`) {
        return fulfill(route, { logs: [{
          ts: '2026-07-18T00:00:01.000Z', level: 'info',
          message: 'CellChat candidate inference completed through the durable worker.',
        }] });
      }
      if (pathname === `${jobBase}/job_cellchat_browser/artifacts`) {
        return fulfill(route, createdJob ? [
          {
            id: 'art_cellchat_summary_browser', artifactType: 'cellchat_summary', status: 'available',
            storageKind: 'metadata_only', metadata: {
              kind: 'cellchat_summary', scientific_output: true, downloadable: false,
              resolvedParams: createdJob.parameters, summary,
            },
          },
          {
            id: 'art_cellchat_results_browser', artifactType: 'cellchat_results', status: 'available',
            storageKind: 'local_internal', metadata: { scientific_output: true, downloadable: false, nRows: 3 },
          },
        ] : []);
      }
      if (pathname === jobBase) return fulfill(route, createdJob ? [createdJob] : []);
      if (pathname.endsWith('/pipeline-definitions')) return fulfill(route, [pipelineDefinition]);
      if (pathname.endsWith('/pipeline-selection')) {
        return fulfill(route, {
          projectId: project.id, userId: user.id, pipelineId: pipelineDefinition.id,
          definition: pipelineDefinition, selectionUnavailable: false, updatedAt: null,
        });
      }
      if (pathname.endsWith('/analysis-objects')) return fulfill(route, [object]);
      if (pathname.endsWith('/datasets') || pathname.endsWith('/artifacts') || pathname.endsWith('/provenance') || pathname.endsWith('/figures')) {
        return fulfill(route, []);
      }
      return fulfill(route, project);
    });
    await page.route('**/api/projects', route => fulfill(route, [project]));

    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Log out', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    const cellChatTab = page.locator('aside button:has-text("CellChat")').first();
    await cellChatTab.waitFor({ state: 'visible', timeout: 15000 });
    await cellChatTab.click();
    await page.getByRole('heading', { name: /CellChat communication candidates/i }).waitFor({ state: 'visible' });

    const start = page.getByRole('button', { name: 'Start CellChat Inference', exact: true });
    assert.equal(await start.isDisabled(), true, 'CellChat starts disabled until every scientific choice is explicit.');
    // Other hidden tabs may render similarly named template controls. Scope to
    // visible required fields from the active CellChat panel.
    await page.locator('label').filter({ hasText: 'Group labels (required)' }).locator('select:visible').selectOption('seurat_clusters');
    await page.locator('label').filter({ hasText: 'Species (required)' }).locator('select:visible').selectOption('human');
    await page.locator('label').filter({ hasText: 'Database category (required)' }).locator('select:visible').selectOption('secreted_signaling');
    await page.locator('label').filter({ hasText: 'Analysis intent (required)' }).locator('select:visible').selectOption('single_context');
    assert.equal(await start.isDisabled(), false, 'CellChat enables only after its fixed scope is confirmed.');
    await start.click();

    await page.getByText('art_cellchat_summary_browser', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(launchBodies.length, 1, 'CellChat created exactly one durable job.');
    assert.deepEqual(launchBodies[0], {
      jobType: 'cellchat.infer.v1', analysisObjectId: object.id,
      parameters: {
        groupBy: 'seurat_clusters', assay: 'RNA', species: 'human',
        databaseCategory: 'secreted_signaling', analysisIntent: 'single_context',
        minCellsPerGroup: 10, maxCellsPerGroup: 5000, maxTotalCells: 10000,
        pValueCutoff: 0.05, topInteractions: 25, topPathways: 15, randomSeed: 1,
      },
    });
    await page.getByText('TGFB1.TGFBR1_TGFBR2', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('CD4 T cells', { exact: true }).waitFor({ state: 'visible' });
    assert.deepEqual(groupKeyRequests, [{
      url: `${origin}/api/r/cellchat-group-map?group_by=seurat_clusters`,
      objectId: object.id,
    }], 'The owner-local group key stays scoped to the selected analysis object.');
    await page.getByText(/does not prove that cells communicated, physically contacted, or caused a response/i).waitFor({ state: 'visible' });
    const text = await page.locator('body').innerText();
    assert.doesNotMatch(text, /storage[_-]?(?:key|uri)|projects\/|user-\d+:obj-/i);
    assert.equal(serverErrors.length, 0, `Unexpected browser 5xx responses: ${serverErrors.join(' | ')}`);
    assert.equal(consoleErrors.length, 0, `Unexpected browser console errors: ${consoleErrors.join(' | ')}`);
    assert.equal(requestFailures.length, 0, `Unexpected browser network failures: ${requestFailures.join(' | ')}`);
    process.stdout.write('CELLCHAT PLAYWRIGHT BROWSER FLOW PASSED (mocked API transport; real R is covered separately)\n');
  } finally {
    await browser?.close();
    if (vite.exitCode === null) vite.kill('SIGTERM');
  }
}

main().catch(error => {
  process.stderr.write(`CellChat Playwright browser flow failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
