'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE = path.resolve(__dirname, '..');
const VITE_CLI = path.join(WORKSPACE, 'node_modules', 'vite', 'bin', 'vite.js');
const VITE_PORT = Number(process.env.DB_FLOW_VITE_PORT || 5174);
const FRONTEND_URL = `http://127.0.0.1:${VITE_PORT}`;
const REPORT_DIR = path.join(WORKSPACE, 'playwright', 'report');
const SCREENSHOT = path.join(REPORT_DIR, 'db-backed-object-flow.png');

fs.mkdirSync(REPORT_DIR, { recursive: true });

const state = {
  user: { id: 101, email: 'db-flow@example.com', displayName: 'DB Flow Tester' },
  authenticated: false,
  org: null,
  projects: [],
  objectsByProject: new Map(),
  verifiedObjectHeaders: [],
  apiResponseBodies: [],
  apiRequestUrls: [],
};

function log(message) {
  console.log(`[db-flow] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  fail(`Timed out waiting for Vite at ${url}`);
}

function startVite() {
  const child = spawn(process.execPath, [VITE_CLI, '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
    cwd: WORKSPACE,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  return child;
}

function stopVite(child) {
  return new Promise(resolve => {
    if (!child || child.killed) return resolve();
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
      return;
    }
    child.once('close', () => resolve());
    child.kill('SIGTERM');
    setTimeout(resolve, 2_000);
  });
}

async function fulfill(route, status, body) {
  const text = JSON.stringify(body);
  state.apiResponseBodies.push(text);
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: text,
  });
}

async function installRoutes(page) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    state.apiRequestUrls.push(request.url());

    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204 });
    }

    if (pathname === '/api/auth/signup' && request.method() === 'POST') {
      state.authenticated = true;
      return fulfill(route, 201, { success: true, user: state.user });
    }
    if (pathname === '/api/auth/session' && request.method() === 'GET') {
      return state.authenticated
        ? fulfill(route, 200, { user: state.user })
        : fulfill(route, 401, { error: 'Authentication required' });
    }
    if (pathname === '/api/auth/policy' && request.method() === 'GET') {
      return fulfill(route, 200, {
        registrationEnabled: true,
        legacyLocalImportsEnabled: true,
        legacyLiveMutationToolsEnabled: true,
        serverFigureExportEnabled: true,
      });
    }
    if (pathname === '/api/expert-r/capabilities' && request.method() === 'GET') {
      return fulfill(route, 200, { expertREnabled: false, expertRProfile: null });
    }
    if (pathname === '/api/db/figures' && request.method() === 'GET') {
      return fulfill(route, 200, []);
    }
    if (pathname === '/api/r/health') {
      return fulfill(route, 200, { mode: 'R/Seurat runtime connected' });
    }
    if (pathname === '/api/r/session-id') {
      return fulfill(route, 200, { sessionId: 'mock-r-session-1' });
    }
    if (pathname === '/api/organizations' && request.method() === 'GET') {
      return fulfill(route, 200, state.org ? [state.org] : []);
    }
    if (pathname === '/api/organizations' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.org = { id: 'org_mock', name: body.name, role: 'owner' };
      return fulfill(route, 201, state.org);
    }
    if (pathname === '/api/projects' && request.method() === 'GET') {
      return fulfill(route, 200, state.projects);
    }
    if (pathname === '/api/projects' && request.method() === 'POST') {
      const body = request.postDataJSON();
      const project = {
        id: 'proj_mock',
        organizationId: body.organizationId,
        name: body.name,
        description: body.description || '',
        role: 'owner',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
      };
      state.projects = [project];
      state.objectsByProject.set(project.id, []);
      return fulfill(route, 201, project);
    }

    const lineageMatch = pathname.match(/^\/api\/projects\/([^/]+)\/analysis-objects\/([^/]+)\/lineage$/);
    if (lineageMatch && request.method() === 'GET') {
      const [, projectId, objectId] = lineageMatch;
      return fulfill(route, 200, {
        projectId,
        objectId,
        rootObjectId: objectId,
        nodes: [{ id: objectId, label: 'PBMC_3k_Tutorial', objectType: 'seurat', lineageRootId: objectId }],
        edges: [],
        truncated: false,
      });
    }

    const historyListMatch = pathname.match(/^\/api\/projects\/([^/]+)\/(jobs|artifacts|provenance|figures)$/);
    if (historyListMatch && request.method() === 'GET') {
      return fulfill(route, 200, []);
    }

    const objectListMatch = pathname.match(/^\/api\/projects\/([^/]+)\/analysis-objects$/);
    if (objectListMatch && request.method() === 'GET') {
      return fulfill(route, 200, state.objectsByProject.get(objectListMatch[1]) || []);
    }
    if (objectListMatch && request.method() === 'POST') {
      const projectId = objectListMatch[1];
      const body = request.postDataJSON();
      const forbidden = ['id', 'projectId', 'project_id', 'ownerUserId', 'owner_user_id', 'createdByUserId', 'created_by_user_id', 'storageUri', 'storageKey', 'storage_key', 'internalStorageKey', 'objectHash', 'path', 'stateKey', 'status', 'lineageRootId'];
      for (const field of forbidden) {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
          return fulfill(route, 400, { error: `Forbidden field in mocked test: ${field}` });
        }
      }
      const object = {
        id: 'ao_mockdemo',
        projectId,
        objectType: body.objectType,
        displayName: body.displayName,
        metadata: body.metadata || {},
        parentObjectId: null,
        lineageRootId: 'ao_mockdemo',
        createdAt: '2026-06-30T00:00:01.000Z',
        updatedAt: '2026-06-30T00:00:01.000Z',
      };
      state.objectsByProject.set(projectId, [object]);
      return fulfill(route, 201, object);
    }

    if (pathname === '/api/r/load-data') {
      const objectId = request.headers()['x-object-id'];
      state.verifiedObjectHeaders.push({ endpoint: 'load-data', objectId });
      if (objectId !== 'ao_mockdemo') return fulfill(route, 404, { error: 'Analysis object not found.' });
      return fulfill(route, 200, {
        result: {
          message: 'PBMC demo loaded',
          cells: 2700,
          features: 13714,
          genes: 13714,
          density: 2.4,
          source: 'pbmc3k_demo',
        },
      });
    }

    if (pathname === '/api/r/qc-distributions') {
      const objectId = request.headers()['x-object-id'];
      state.verifiedObjectHeaders.push({ endpoint: 'qc-distributions', objectId });
      if (objectId !== 'ao_mockdemo') return fulfill(route, 404, { error: 'Analysis object not found.' });
      return fulfill(route, 200, {
        n_cells: 4,
        n_features: 13714,
        percent_mt: [1.2, 2.3, 0.5, 4.1],
        nFeature_RNA: [1500, 2100, 1800, 2500],
        nCount_RNA: [4000, 5000, 4500, 6000],
      });
    }

    if (pathname === '/api/r/pipeline-state') {
      const objectId = request.headers()['x-object-id'];
      state.verifiedObjectHeaders.push({ endpoint: 'pipeline-state', objectId });
      if (objectId !== 'ao_mockdemo') return fulfill(route, 404, { error: 'Analysis object not found.' });
      return fulfill(route, 200, {
        exists: true,
        has_qc: false,
        has_normalized: false,
        has_integrated: false,
        has_pca: false,
        has_clusters: false,
        has_umap: false,
        n_clusters: 0,
        pca_dims: 0,
      });
    }

    if (pathname === '/api/r/object-info') {
      return fulfill(route, 200, { n_cells: 2700, n_features: 13714, assays: ['RNA'], meta_cols: [] });
    }
    if (pathname === '/api/r/genes') {
      return fulfill(route, 200, { genes: ['CD3E', 'CD4', 'MS4A1'] });
    }

    return fulfill(route, 404, { error: `Unhandled mocked route: ${request.method()} ${pathname}` });
  });
}

async function waitUntil(message, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail(`Timed out waiting for ${message}`);
}

function assertNoLeaks() {
  const forbiddenBodyPatterns = [
    /vault\//i,
    /[A-Za-z]:\\/,
    /\/Users\//,
    /\/home\//,
    /internalStorageKey/i,
    /storage_key/i,
    /state_key/i,
    /user-\d+:obj-/i,
    /127\.0\.0\.1:8000/,
    /traceback/i,
    /Error in /,
  ];
  for (const body of state.apiResponseBodies) {
    for (const pattern of forbiddenBodyPatterns) {
      if (pattern.test(body)) fail(`Mocked public API response leaked pattern ${pattern}: ${body}`);
    }
  }
  for (const url of state.apiRequestUrls) {
    if (/token=/i.test(url) || /Authorization=/i.test(url)) {
      fail(`Token-like value appeared in request URL: ${url}`);
    }
  }
}

async function main() {
  log('Starting Vite for mocked DB-backed object workflow');
  const vite = startVite();
  try {
    await waitForServer(FRONTEND_URL);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await installRoutes(page);

    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^Sign Up$/ }).click();
    await page.locator('input[type="text"]').fill('DB Flow Tester');
    await page.locator('input[type="email"]').fill(state.user.email);
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-42');
    await page.getByLabel('Confirm password', { exact: true }).fill('correct-horse-42');
    await page.getByRole('button', { name: /Create Account/i }).click();

    await page.getByText('No projects yet').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /Create Project/i }).click();
    await page.getByPlaceholder('Project Name').fill('DB Flow Project');
    await page.getByRole('button', { name: /^Save$/ }).click();
    await page.getByText('DB Flow Project').first().waitFor({ timeout: 10_000 });

    await page.getByRole('button', { name: /Add analysis/i }).first().click();
    await page.getByRole('button', { name: /PBMC 3k Demo Dataset/i }).click();
    await page.locator('text=PBMC_3k_Tutorial').first().waitFor({ timeout: 10_000 });

    await page.getByRole('button', { name: /^Quality Control$/i }).click();
    await page.getByRole('heading', { name: /Quality Control/i }).waitFor({ timeout: 10_000 });
    const applyButton = page.getByRole('button', { name: /Apply QC Filters/i });
    await waitUntil('enabled QC button', async () => applyButton.isEnabled(), 10_000);

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('DB Flow Project').first().waitFor({ timeout: 10_000 });
    await page.locator('text=PBMC_3k_Tutorial').first().waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: /^Lineage/i }).click();
    await page.getByText('Recorded relationships for the selected saved analysis. This view is read-only.')
      .waitFor({ timeout: 10_000 });
    await page.screenshot({ path: SCREENSHOT, fullPage: false });

    const loadHeader = state.verifiedObjectHeaders.find(item => item.endpoint === 'load-data');
    const qcHeader = state.verifiedObjectHeaders.find(item => item.endpoint === 'qc-distributions');
    const pipelineHeader = state.verifiedObjectHeaders.find(item => item.endpoint === 'pipeline-state');
    if (loadHeader?.objectId !== 'ao_mockdemo') fail('PBMC load did not use the DB analysis object id');
    if (qcHeader?.objectId !== 'ao_mockdemo') fail('QC distributions did not use the DB analysis object id');
    if (pipelineHeader?.objectId !== 'ao_mockdemo') fail('Pipeline-state probe did not use the DB analysis object id');
    if (!state.apiRequestUrls.some(url => /\/api\/projects\/proj_mock\/analysis-objects\/ao_mockdemo\/lineage$/.test(url))) {
      fail('Lineage view did not request the selected project object DAG.');
    }
    assertNoLeaks();

    await page.close();
    await browser.close();
    log(`PASS mocked workflow. Frontend URL: ${FRONTEND_URL}`);
    log(`Screenshot: ${SCREENSHOT}`);
  } finally {
    await stopVite(vite);
  }
}

main().catch(err => {
  console.error(`[db-flow] FAIL ${err.stack || err.message}`);
  process.exit(1);
});
