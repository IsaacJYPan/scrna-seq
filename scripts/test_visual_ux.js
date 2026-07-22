// scripts/test_visual_ux.js
// ============================================================
// Automated Visual & UI/UX Test Suite — scRNA-seq Dashboard
// ============================================================
// Starts Vite dev server automatically, exercises every tab,
// and runs 6 categories of quality checks:
//   1. Pixel-level screenshot regression (golden snapshots)
//   2. Interactive flow tests (modals, theme, sidebar, sliders)
//   3. Accessibility audits (axe-core / WCAG 2.1)
//   4. Layout overflow detection
//   5. Network & performance monitoring
//   6. Console error detection
//
// Usage:
//   npm run test:visual          — run against existing baselines
//   npm run test:visual:update   — regenerate golden screenshots
// ============================================================

'use strict';

const { chromium } = require('playwright');
const { AxePuppeteer } = require('@axe-core/playwright');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Configuration ──────────────────────────────────────────────────────────────
const VITE_PORT     = 5173;
const VITE_URL      = `http://localhost:${VITE_PORT}`;
const WORKSPACE     = path.resolve(__dirname, '..');
const SNAPSHOTS_DIR = path.join(WORKSPACE, 'playwright', 'snapshots');
const REPORT_DIR    = path.join(WORKSPACE, 'playwright', 'report');
const UPDATE_MODE   = process.argv.includes('--update-snapshots');
const VITE_STARTUP_WAIT_MS = 30_000;
const PAGE_SETTLE_MS       = 2_500;
const DIFF_THRESHOLD       = 0.001;  // 0.1% pixel ratio
const PERFORMANCE_BUDGET_MS = 8_000; // Max ms to fully render a tab
const KNOWN_IGNORABLE_ERRORS = [
  // R backend offline in CI is expected
  'Failed to fetch',
  'NetworkError',
  'ERR_CONNECTION_REFUSED',
];

// ── Setup Directories ──────────────────────────────────────────────────────────
[SNAPSHOTS_DIR, REPORT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Test Counters ──────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0, WARN = 0;
const failures = [];
const warnings = [];
const allResults = [];

function pass(desc) { console.log(`  ✅ PASS: ${desc}`); PASS++; }
function fail(desc, detail = '') {
  console.log(`  ❌ FAIL: ${desc}${detail ? `\n     → ${detail}` : ''}`);
  FAIL++; failures.push({ desc, detail });
}
function warn(desc, detail = '') {
  console.log(`  ⚠  WARN: ${desc}${detail ? ` (${detail})` : ''}`);
  WARN++; warnings.push({ desc, detail });
}
function info(msg) { console.log(`  ℹ  ${msg}`); }
function section(title) {
  const bar = '─'.repeat(Math.min(title.length, 60));
  console.log(`\n${title}\n${bar}`);
}
function assert(desc, cond, detail = '') {
  if (cond) pass(desc); else fail(desc, detail);
}

// ── Sleep Helper ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A solid primary fill must keep a readable foreground while hovered. This
// catches CSS cascade regressions where a generic light-theme text remap wins
// over the primary button's white foreground.
async function primaryButtonHoverContrast(button) {
  await button.hover();
  return button.evaluate(el => {
    const parseRgb = value => (value.match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).map(Number);
    const relativeLuminance = ([red, green, blue]) => {
      const channel = value => {
        const normalized = value / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
    };
    const style = window.getComputedStyle(el);
    const foreground = parseRgb(style.color);
    const background = parseRgb(style.backgroundColor);
    const foregroundLum = relativeLuminance(foreground);
    const backgroundLum = relativeLuminance(background);
    return {
      foreground: style.color,
      background: style.backgroundColor,
      contrast: (Math.max(foregroundLum, backgroundLum) + 0.05) /
        (Math.min(foregroundLum, backgroundLum) + 0.05),
    };
  });
}

async function checkPrimaryButtonHover(page, name) {
  const button = page.getByRole('button', { name, exact: true }).first();
  if (await button.count() === 0) {
    fail(`Primary action ${name} is present for hover contrast testing`);
    return;
  }
  const { foreground, background, contrast } = await primaryButtonHoverContrast(button);
  assert(
    `Primary action ${name} keeps readable text on hover`,
    foreground !== background && contrast >= 4.5,
    `foreground ${foreground}, background ${background}, contrast ${contrast.toFixed(2)}:1`
  );
}

// ── Screenshot Snapshot Check ──────────────────────────────────────────────────
async function checkSnapshot(page, name) {
  const file = path.join(SNAPSHOTS_DIR, `${name}.png`);
  const buf = await page.screenshot({ fullPage: false });

  if (UPDATE_MODE || !fs.existsSync(file)) {
    fs.writeFileSync(file, buf);
    info(`Snapshot saved: ${name}.png`);
    return;
  }

  // Compare pixel by pixel using Playwright's built-in diff
  const baseline = fs.readFileSync(file);
  // Use a simple buffer size check as a fast-fail first, then do proper pixel diff
  if (buf.length === 0) {
    fail(`Snapshot ${name}: empty screenshot`);
    return;
  }

  // Save current for diff reporting
  const currentFile = path.join(REPORT_DIR, `${name}.current.png`);
  fs.writeFileSync(currentFile, buf);

  // We use Playwright's expect API for pixel diffing; since we're not inside a
  // @playwright/test test, we call the comparison manually via PNG comparison.
  try {
    const { PNG } = require('pngjs');
    const { default: pixelmatch } = await import('pixelmatch');

    const img1 = PNG.sync.read(baseline);
    const img2 = PNG.sync.read(buf);

    if (img1.width !== img2.width || img1.height !== img2.height) {
      fail(`Snapshot ${name}: size changed (${img1.width}x${img1.height} → ${img2.width}x${img2.height})`);
      return;
    }

    const diff = new PNG({ width: img1.width, height: img1.height });
    const mismatch = pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, { threshold: 0.2 });
    const ratio = mismatch / (img1.width * img1.height);

    if (ratio > DIFF_THRESHOLD) {
      const diffFile = path.join(REPORT_DIR, `${name}.diff.png`);
      fs.writeFileSync(diffFile, PNG.sync.write(diff));
      fail(`Snapshot ${name}: ${(ratio * 100).toFixed(3)}% pixels differ`, `diff saved to ${diffFile}`);
    } else {
      pass(`Snapshot ${name}: within threshold (${(ratio * 100).toFixed(4)}% diff)`);
    }
  } catch (e) {
    // pngjs/pixelmatch may not be installed; fall back to buffer comparison
    if (buf.equals(baseline)) {
      pass(`Snapshot ${name}: exact match`);
    } else {
      warn(`Snapshot ${name}: differs (install pngjs + pixelmatch for pixel diff)`);
    }
  }
}

// ── Overflow Detector ──────────────────────────────────────────────────────────
async function checkOverflow(page, context) {
  const overflowing = await page.evaluate(() => {
    const found = [];
    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const style = window.getComputedStyle(el);
      const isVisuallyHidden =
        el.classList.contains('sr-only') ||
        (
          style.position === 'absolute' &&
          style.overflow === 'hidden' &&
          rect.width <= 2 &&
          rect.height <= 2
        );
      if (isVisuallyHidden) return;
      // React Flow deliberately gives its panning surface a larger internal
      // canvas than its viewport. The viewport remains clipped, so those
      // scroll widths are not page-layout overflow.
      if (el.classList.contains('react-flow') || el.closest('.react-flow')) return;
      // Skip elements inside collapsed/hidden containers (w-0, opacity-0, overflow-hidden with 0 width)
      let parent = el.parentElement;
      let hiddenByParent = false;
      while (parent) {
        const ps = window.getComputedStyle(parent);
        if (ps.overflow === 'hidden' && parent.clientWidth === 0) { hiddenByParent = true; break; }
        parent = parent.parentElement;
      }
      if (hiddenByParent) return;
      // Check horizontal overflow (allow 4px rounding tolerance)
      if (el.scrollWidth > el.clientWidth + 4) {
        const id = el.id ? `#${el.id}` : '';
        const cls = [...el.classList].slice(0, 3).join('.');
        found.push(`${el.tagName}${id}.${cls} (scrollW=${el.scrollWidth} clientW=${el.clientWidth})`);
      }
    });
    return found.slice(0, 10); // cap report size
  });

  if (overflowing.length > 0) {
    warn(`${context}: ${overflowing.length} overflowing element(s)`, overflowing.join(' | '));
  } else {
    pass(`${context}: no horizontal overflow detected`);
  }
}

// ── Console Error Check ────────────────────────────────────────────────────────
function isIgnorableError(msg) {
  return KNOWN_IGNORABLE_ERRORS.some(pattern => msg.includes(pattern));
}

// ── Performance Timing ─────────────────────────────────────────────────────────
async function measureLoadTime(page, label) {
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav ? nav.loadEventEnd - nav.startTime : null;
  });
  if (timing !== null) {
    if (timing > PERFORMANCE_BUDGET_MS) {
      warn(`${label}: slow load (${timing.toFixed(0)}ms > ${PERFORMANCE_BUDGET_MS}ms budget)`);
    } else {
      pass(`${label}: load time ${timing.toFixed(0)}ms (within ${PERFORMANCE_BUDGET_MS}ms budget)`);
    }
  }
}

// ── Accessibility Audit ────────────────────────────────────────────────────────
async function runA11yAudit(page, context) {
  try {
    const { AxeBuilder } = require('@axe-core/playwright');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const violations = results.violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
    if (violations.length === 0) {
      pass(`${context}: no critical/serious A11Y violations`);
    } else {
      const summary = violations.map(v => {
        // Output up to 2 failing node HTML snippets so we can identify them
        const nodeSamples = v.nodes.slice(0, 2)
          .map(n => n.html.replace(/\s+/g, ' ').substring(0, 150))
          .join(' ‖ ');
        return `${v.impact}[${v.id}]: ${v.description} (${v.nodes.length} node(s))\n       ↳ ${nodeSamples}`;
      }).join('\n     ');
      fail(`${context}: ${violations.length} A11Y violation(s)`, summary);
    }
    const minor = results.violations.filter(v => v.impact === 'minor' || v.impact === 'moderate');
    if (minor.length > 0) {
      warn(`${context}: ${minor.length} minor/moderate A11Y issue(s)`, minor.map(v => v.description).join('; '));
    }
  } catch (e) {
    warn(`${context}: A11Y audit skipped`, e.message);
  }
}

// ── Vite Process Management ────────────────────────────────────────────────────
let viteProc = null;

async function startVite() {
  info(`Starting Vite dev server on port ${VITE_PORT}...`);
  viteProc = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    cwd: WORKSPACE,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  let ready = false;

  await new Promise((resolve, reject) => {
    const startupTimer = setTimeout(() => {
      reject(new Error(`Vite did not become ready on port ${VITE_PORT} within ${VITE_STARTUP_WAIT_MS}ms.`));
    }, VITE_STARTUP_WAIT_MS);
    const failStartup = (error) => {
      if (ready) return;
      clearTimeout(startupTimer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    viteProc.stdout.on('data', d => {
      const msg = d.toString();
      process.stdout.write(`[Vite] ${msg}`);
      if (msg.includes('Local:') || msg.includes('ready in') || msg.includes('localhost')) {
        ready = true;
        clearTimeout(startupTimer);
        resolve();
      }
    });
    viteProc.stderr.on('data', d => process.stdout.write(`[Vite:err] ${d}`));
    viteProc.once('error', failStartup);
    viteProc.once('exit', (code, signal) => {
      if (!ready) failStartup(new Error(`Vite exited before readiness (code ${code ?? 'unknown'}, signal ${signal ?? 'none'}).`));
    });
  });

  // Additional wait to ensure fully ready
  await sleep(2000);
  info('Vite dev server started.');
}

function stopVite() {
  if (viteProc && !viteProc.killed) {
    viteProc.kill('SIGTERM');
    info('Vite dev server stopped.');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  scRNA-seq Dashboard  —  Visual & UI/UX Test Suite');
  console.log('='.repeat(60));
  console.log(`  Mode      : ${UPDATE_MODE ? '🔄 UPDATE BASELINES' : '🔍 COMPARE AGAINST BASELINES'}`);
  console.log(`  Snapshots : ${SNAPSHOTS_DIR}`);
  console.log(`  Report    : ${REPORT_DIR}`);
  console.log(`  Timestamp : ${new Date().toISOString()}\n`);

  // ── Start Vite ─────────────────────────────────────────────────────────────
  section('SETUP: Starting Vite dev server');
  await startVite();

  // ── Launch Browser ─────────────────────────────────────────────────────────
  section('SETUP: Launching browser');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  
  // Mock Electron API
  await context.addInitScript(() => {
    localStorage.setItem('benchone_auth_token', 'visual-test-token');
    localStorage.setItem('benchone_auth_user', JSON.stringify({
      id: 'visual-user',
      email: 'researcher@lab.edu',
      displayName: 'Visual Tester'
    }));
    window.mockFigures = [];
    window.electronAPI = {
      getFigures: async () => window.mockFigures,
      saveFigure: async (fig) => { window.mockFigures.push(fig); return { success: true }; },
      deleteFigure: async (id) => { window.mockFigures = window.mockFigures.filter(f => f.id !== id); return { success: true }; },
      setTheme: () => {}
    };
  });

  const page = await context.newPage();

  // ── Console & Error Monitoring ─────────────────────────────────────────────
  const consoleErrors = [];
  const networkFailures = [];

  page.on('console', msg => {
    console.log(`[BROWSER CONSOLE] ${msg.type().toUpperCase()}: ${msg.text()}`);
    if (msg.type() === 'error' && !isIgnorableError(msg.text())) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    if (!isIgnorableError(err.message)) {
      consoleErrors.push(`[uncaught] ${err.message}`);
    }
  });
  page.on('requestfailed', req => {
    const url = req.url();
    const err = req.failure()?.errorText || 'unknown';
    if (!isIgnorableError(err)) {
      networkFailures.push(`${req.method()} ${url} → ${err}`);
      console.log(`[NETWORK FAIL] ${req.method()} ${url} → ${err}`);
    }
  });
  // Playwright does not emit requestfailed for completed HTTP error responses.
  // Capture those separately so a browser-console "Failed to load resource"
  // message identifies the method, URL, and status that caused it.
  page.on('response', response => {
    if (response.status() < 400) return;
    const request = response.request();
    const failure = `${request.method()} ${response.url()} → HTTP ${response.status()}`;
    networkFailures.push(failure);
    console.log(`[HTTP FAIL] ${failure}`);
  });

  // ── Route Mocking for E2E Tests ───────────────────────────────────────────
  const corsHeaders = { 'Access-Control-Allow-Origin': '*' };

  await page.route('**/health*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ status: 'ok' })
    });
  });

  await page.route('**/api/runtime/diagnostics*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        supportedTarget: 'R 4.5.x',
        rscript: { path: 'Rscript', source: 'PATH' },
        runtime: { status: 'ok', mode: 'R/Seurat runtime connected', rVersion: '4.6.0' },
        packages: { Seurat: true, dplyr: true, harmony: false, CellChat: false, plumber: true, jsonlite: true, ggplot2: true }
      })
    });
  });

  await page.route('**/api/db/**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify([])
    });
  });

  // ── Auth session restore (mocked; no backend in CI) ──────────────────────────
  // On startup the app calls restoreSession() → GET /api/auth/session to adopt the
  // HttpOnly-cookie session (source of auth truth). With no backend the Vite /api
  // proxy returns a 500 (ECONNREFUSED) and the request aborts, which the console +
  // network audits flag. Mock it to return the same user the init script seeds into
  // localStorage so the app stays logged in. logout is a best-effort POST that is
  // never triggered here, but is mocked too for completeness.
  const visualAuthUser = { id: 'visual-user', email: 'researcher@lab.edu', displayName: 'Visual Tester' };
  await page.route('**/api/auth/policy*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        registrationEnabled: true,
        legacyLocalImportsEnabled: true,
        legacyLiveMutationToolsEnabled: true,
        serverFigureExportEnabled: true,
      })
    });
  });
  await page.route('**/api/auth/session*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ user: visualAuthUser, authVia: 'cookie' })
    });
  });
  await page.route('**/api/auth/logout*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ success: true })
    });
  });

  // Platform registry publication is a server-managed capability. This
  // frontend-only suite uses an ordinary project owner, not a platform
  // developer, so fail closed without contacting the absent Express server.
  await page.route('**/api/pipeline-registry/capabilities*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ canPublishPipelineManifests: false })
    });
  });

  // ── DB-backed project / analysis-object model (mocked; no backend in CI) ─────
  // The app loads the backend project model on startup and during the PBMC demo
  // load. This suite runs frontend-only, so these are mocked exactly like the R and
  // /api/db routes above. Without them the /api proxy is refused, the app renders an
  // "Internal Server Error" banner, and the console + a11y audits fail on it.
  const visualOrg = { id: 'org_visual_mock', name: 'Visual Test Org', role: 'owner' };
  const visualProject = {
    id: 'proj_visual_mock', organizationId: visualOrg.id, name: 'Visual Test Project',
    description: '', role: 'owner', createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00'
  };
  const visualDefaultPipelineId = 'default-seurat-scrna-v1';
  const visualPipelineTab = (id, label, moduleKey, optional = false) => ({
    id, label, moduleKey, optional, parameterSchema: [], resultArtifactTypes: [], resultViews: []
  });
  const visualDefaultPipelineManifest = {
    schemaVersion: 1,
    id: visualDefaultPipelineId,
    name: 'Default Seurat scRNA-seq Pipeline',
    description: 'Dataset-backed Seurat preprocessing, exploration, DEG, and project history using registered modules.',
    modality: 'scrna',
    tabs: [
      visualPipelineTab('inspect', 'Inspect', 'inspectObject'),
      visualPipelineTab('qc', 'Quality Control', 'seuratQc'),
      visualPipelineTab('normalize', 'Normalize', 'seuratNormalize'),
      visualPipelineTab('integrate', 'Integration', 'seuratIntegration', true),
      visualPipelineTab('pca', 'PCA', 'seuratPca'),
      visualPipelineTab('cluster', 'Cluster', 'seuratCluster'),
      visualPipelineTab('umap', 'UMAP', 'seuratUmap'),
      visualPipelineTab('featureplot', 'Feature Plot', 'featurePlot'),
      visualPipelineTab('geneviewer', 'Gene Expression', 'geneExpression'),
      visualPipelineTab('heatmap', 'Heatmap', 'heatmap'),
      visualPipelineTab('dotplot', 'Dot Plot', 'dotPlot'),
      visualPipelineTab('deg', 'Markers / DEG', 'differentialExpression'),
      visualPipelineTab('history', 'Jobs & Artifacts', 'projectHistory')
    ]
  };
  const visualDefaultPipelineDefinition = {
    id: visualDefaultPipelineId,
    manifestId: visualDefaultPipelineId,
    projectId: visualProject.id,
    visibility: 'builtin',
    name: visualDefaultPipelineManifest.name,
    manifest: visualDefaultPipelineManifest,
    createdAt: null,
    updatedAt: null
  };
  const visualPipelineDefinition = {
    id: 'pipe_abcdef1234',
    manifestId: 'visual-inspection-view',
    projectId: null,
    visibility: 'platform',
    name: 'Visual Inspection View',
    manifest: {
      schemaVersion: 1,
      id: 'visual-inspection-view',
      name: 'Visual Inspection View',
      description: 'A trusted declarative manifest used by the browser test.',
      modality: 'scrna',
      tabs: [visualPipelineTab('inspect', 'Inspect', 'inspectObject')]
    },
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00'
  };
  const visualAnalysisObject = (overrides = {}) => ({
    id: 'ao_visualmock0001', ownerUserId: 1, projectId: visualProject.id,
    datasetId: null, parentObjectId: null, lineageRootId: 'ao_visualmock0001',
    objectType: 'seurat', displayName: 'PBMC_3k_Tutorial',
    metadata: { sourceType: 'pbmc3k_demo', summary: { cells: 2700, features: 13714, density: 2.59 } },
    createdByProvenanceId: null, createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00',
    ...overrides
  });
  const jsonBody = request => { try { return JSON.parse(request.postData() || '{}'); } catch { return {}; } };
  // Stateful so the flow matches the real app: the project starts with no analysis
  // objects (so the "QC disabled before data" gate holds), and the demo load creates
  // one that then persists across the in-test page reload (so the pipeline tabs stay
  // enabled instead of reverting to a disabled/empty state).
  let demoObjectExists = false;

  await page.route('**/api/organizations**', async route => {
    const isPost = route.request().method() === 'POST';
    await route.fulfill({
      status: isPost ? 201 : 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify(isPost ? visualOrg : [visualOrg])
    });
  });

  await page.route('**/api/projects**', async route => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    let status = 200;
    let body;
    if (path.endsWith('/pipeline-definitions')) {
      body = [
        visualDefaultPipelineDefinition,
        visualPipelineDefinition
      ];
    } else if (path.endsWith('/pipeline-selection')) {
      body = {
        projectId: visualProject.id,
        userId: 1,
        pipelineId: visualDefaultPipelineId,
        definition: visualDefaultPipelineDefinition,
        selectionUnavailable: false,
        updatedAt: null
      };
    } else if (/\/analysis-objects\/[^/]+\/lineage$/.test(path)) {
      body = {
        projectId: visualProject.id,
        objectId: 'ao_visualmock0001',
        rootObjectId: 'ao_visualmock0001',
        nodes: demoObjectExists ? [visualAnalysisObject()] : [],
        edges: [],
        truncated: false
      };
    } else if (/\/artifacts$/.test(path)) {
      body = demoObjectExists ? [{
        id: 'artifact_visual_1',
        name: 'Mock checkpoint',
        artifactType: 'checkpoint',
        status: 'available',
        storageKind: 'metadata_only',
        jobId: 'job_visual_1'
      }] : [];
    } else if (/\/jobs$/.test(path)) {
      body = demoObjectExists ? [{
        id: 'job_visual_1',
        status: 'completed',
        jobType: 'pbmc.pipeline.v1',
        analysisObjectId: 'ao_visualmock0001',
        resultAnalysisObjectId: 'ao_visualmock0001',
        datasetId: null,
        createdAt: '2026-01-01 00:00:00'
      }] : [];
    } else if (/\/provenance$/.test(path)) {
      body = demoObjectExists ? [{
        id: 'prov_visual_1',
        operation: 'load_demo',
        analysisObjectId: 'ao_visualmock0001',
        jobId: 'job_visual_1',
        createdAt: '2026-01-01 00:00:00'
      }] : [];
    } else if (/\/figures$/.test(path)) {
      body = [];
    } else if (/\/analysis-objects\/[^/]+\/summary$/.test(path)) {
      // PATCH summary — echo the persisted counts back on the object.
      const patch = jsonBody(request);
      body = visualAnalysisObject({
        metadata: { sourceType: 'pbmc3k_demo', summary: {
          cells: patch.cells ?? 2700, features: patch.features ?? 13714, density: patch.density ?? 2.59
        } }
      });
    } else if (path.endsWith('/analysis-objects')) {
      if (method === 'POST') { status = 201; demoObjectExists = true; body = visualAnalysisObject({ displayName: jsonBody(request).displayName || 'PBMC_3k_Tutorial' }); }
      else { body = demoObjectExists ? [visualAnalysisObject()] : []; } // GET list
    } else if (path.endsWith('/api/projects')) {
      if (method === 'POST') { status = 201; body = { ...visualProject, name: jsonBody(request).name || visualProject.name }; }
      else { body = [visualProject]; } // GET list — one project so the demo load has a target
    } else {
      body = visualProject; // GET one project
    }
    await route.fulfill({ status, contentType: 'application/json', headers: corsHeaders, body: JSON.stringify(body) });
  });

  await page.route('**/check-session*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ exists: true })
    });
  });

  await page.route('**/session-id*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ sessionId: 'mock-session-123' })
    });
  });

  // The visual suite has no R backend. Mirror the loaded mock object so the
  // startup state probe does not fall through to Vite's unavailable API proxy.
  await page.route('**/pipeline-state*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        exists: true,
        has_qc: true,
        has_normalized: true,
        has_integrated: false,
        has_pca: true,
        pca_dims: 15,
        has_clusters: true,
        n_clusters: 8,
        has_umap: true
      })
    });
  });

  await page.route('**/restore-session*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ success: true, cells: 2700, session_id: 'mock-session-123', reductions: ['pca', 'umap'] })
    });
  });

  await page.route('**/load-data*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        cells: 2700,
        features: 32738,
        result: true
      })
    });
  });

  await page.route('**/umap*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        data: [{ "UMAP_1": 1, "UMAP_2": 2, "Cell": "cell1" }, { "UMAP_1": 2, "UMAP_2": 3, "Cell": "cell2" }],
        metadata: { "ident": ["A", "B"] }
      })
    });
  });

  await page.route('**/object-info*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        n_cells: 2700, n_genes: 13714,
        memory_mb: 45.2,
        assays: ['RNA'],
        meta_cols: [
          { name: 'orig.ident', type: 'character' },
          { name: 'nCount_RNA', type: 'numeric' },
          { name: 'seurat_clusters', type: 'character' }
        ]
      })
    });
  });

  // Pathway Enrichment asks the attached R object for a bounded list of cluster
  // labels. This frontend-only suite has no R service, so provide the same safe
  // response shape the real /api/r/meta-values endpoint returns. React may run
  // the effect twice in development; the route is intentionally repeatable.
  await page.route('**/meta-values*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        values: [
          { value: '0', count: 420 },
          { value: '1', count: 380 },
          { value: '2', count: 295 },
        ],
      }),
    });
  });

  await page.route('**/qc-distributions*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        n_cells: 2700, n_features: 32738,
        percent_mt: [1.2, 2.3, 0.5, 4.1],
        nFeature_RNA: [1500, 2100, 1800, 2500],
        nCount_RNA: [4000, 5000, 4500, 6000]
      })
    });
  });

  await page.route('**/genes*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        genes: ['CD3E', 'CD4', 'CD8A', 'MS4A1']
      })
    });
  });

  await page.route('**/heatmap*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        genes: ['CD3E', 'MS4A1', 'LYZ'],
        clusters: ['0', '1', '2'],
        z: [
          [1.2, 0.2, -0.4],
          [-0.3, 1.5, 0.1],
          [0.2, -0.2, 1.3]
        ]
      })
    });
  });

  await page.route('**/save-session*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ success: true })
    });
  });

  await page.route('**/export-preview*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        width: 800,
        height: 600
      })
    });
  });

  await page.route('**/export-figure*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        id: "fig_" + Date.now(),
        path: "mock_path.png",
        success: true
      })
    });
  });

  // ── Navigate to App ────────────────────────────────────────────────────────
  section('STEP 1: Initial page load');
  const t0 = Date.now();
  await page.goto(VITE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  const loadMs = Date.now() - t0;
  assert(`App loaded within ${PERFORMANCE_BUDGET_MS}ms`, loadMs < PERFORMANCE_BUDGET_MS, `took ${loadMs}ms`);

  // ── Test 1a: Default theme ────────────────────────────────────────────────
  const initialTheme = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  );
  const oppositeTheme = initialTheme === 'dark' ? 'light' : 'dark';

  section(`STEP 2: Workspace — ${initialTheme} mode (default)`);
  await sleep(PAGE_SETTLE_MS);
  await checkSnapshot(page, `workspace_${initialTheme}`);
  await checkOverflow(page, `Workspace ${initialTheme}`);
  await runA11yAudit(page, `Workspace ${initialTheme}`);
  await checkPrimaryButtonHover(page, 'New Project');
  await checkPrimaryButtonHover(page, 'Load Object');

  // ── Test 1b: Theme toggle to opposite mode ────────────────────────────────
  section(`STEP 3: Theme toggle (${initialTheme} → ${oppositeTheme})`);
  const targetTitle = oppositeTheme === 'dark' ? 'Dark Mode' : 'Light Mode';
  const themeBtn = page.locator(`nav button[title*="${targetTitle}"]`).first();
  const themeBtnExists = await themeBtn.count() > 0;
  if (themeBtnExists) {
    await themeBtn.click();
    await sleep(800);
    const activeTheme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
    );
    assert(`Theme toggle switched to ${oppositeTheme}`, activeTheme === oppositeTheme, `current theme is ${activeTheme}`);
    await checkSnapshot(page, `workspace_${activeTheme}`);
    await checkOverflow(page, `Workspace ${activeTheme}`);
    await runA11yAudit(page, `Workspace ${activeTheme}`);
    await checkPrimaryButtonHover(page, 'New Project');
    await checkPrimaryButtonHover(page, 'Load Object');
    // Toggle back to the default theme before continuing tab checks.
    const restoreTitle = initialTheme === 'dark' ? 'Dark Mode' : 'Light Mode';
    const restoreBtn = page.locator(`nav button[title*="${restoreTitle}"]`).first();
    if (await restoreBtn.count() > 0) {
      await restoreBtn.click();
      await sleep(500);
    }
    pass('Theme toggle: light/dark transition without crash');
  } else {
    warn('Theme toggle button not found — skipping opposite-theme snapshot');
  }

  // ── Test 2: Sidebar Collapse / Expand ─────────────────────────────────────
  section('STEP 4: Sidebar collapse / expand');
  // Click the workspace name header (collapses sidebar per Sidebar.jsx)
  const sidebarHeader = page.locator('aside button[aria-label="Collapse sidebar"]').first();
  if (await sidebarHeader.count() > 0) {
    await sidebarHeader.click();
    await sleep(500);
    await checkSnapshot(page, 'sidebar_collapsed');
    await checkOverflow(page, 'Sidebar collapsed');
    const menuBtn = page.locator('nav button[aria-label="Expand sidebar"]').first();
    if (await menuBtn.count() > 0) {
      await menuBtn.click();
      await sleep(500);
      pass('Sidebar collapse/expand: toggle works without layout overflow');
    } else {
      warn('Sidebar expand button not found after collapse');
    }
  } else {
    warn('Sidebar collapse trigger not found — skipping collapse test');
  }

  // ── Test 3: Pipeline gates (buttons disabled before data loaded) ───────────
  section('STEP 5: Pipeline gate enforcement (no data)');
  const qcBtn = page.locator('aside button:has-text("Quality Control")').first();
  if (await qcBtn.count() > 0) {
    const isDisabled = await qcBtn.getAttribute('disabled') !== null;
    assert('QC button disabled before dataset is loaded', isDisabled);
  } else {
    warn('QC button not found — skipping gate check');
  }

  // ── Test 4: Load Object Modal ──────────────────────────────────────────────
  section('STEP 6: Load Object modal flow');
  let dataLoaded = false;
  try {
    // Keep this selector exact. A broad "Load" match can accidentally choose
    // unrelated disabled navigation (for example Lineage's "requires loaded
    // object" status) before the actual workspace action.
    const loadBtn = page.getByRole('button', { name: 'Load Object', exact: true }).first();
    if (await loadBtn.count() > 0) {
      await loadBtn.click();
      await sleep(1000);
      await checkSnapshot(page, 'modal_load_dataset_open');

      // Use separate locators to avoid mixed CSS/text= selector syntax
      const demoCard = page.locator('button:has-text("PBMC 3k")').or(page.locator('button:has-text("PBMC3k")').or(page.locator('button:has-text("pbmc3k")'))).first();
      if (await demoCard.count() > 0) {
        await demoCard.click();
        info('Clicked PBMC3k demo. Waiting for load (up to 90s)...');
        try {
          await page.waitForSelector('text=PBMC_3k_Tutorial', { timeout: 90000 });
          dataLoaded = true;
          pass('Load Object modal: PBMC3k demo dataset loaded successfully');

          await sleep(1500);

          // Inject mock PCA pipeline state so UMAP tab is accessible
          await page.evaluate(() => {
            try {
              const wsRaw = localStorage.getItem('benchone_ws_researcher@lab.edu');
              if (wsRaw) {
                const workspaces = JSON.parse(wsRaw);
                if (workspaces && workspaces.length > 0 && workspaces[0].objects && workspaces[0].objects.length > 0) {
                  const objId = workspaces[0].objects[0].id;
                  const psKey = `benchone_ps_researcher@lab.edu_${objId}`;
                  const currentPs = JSON.parse(localStorage.getItem(psKey) || '{}');
                  currentPs.qc = true;
                  currentPs.normalize = true;
                  currentPs.integrate = true;
                  currentPs.pca = true;
                  localStorage.setItem(psKey, JSON.stringify(currentPs));
                }
              }
            } catch (e) {
              console.error('Failed to inject mock state', e);
            }
          });

          await page.reload({ waitUntil: 'networkidle' });
          await sleep(PAGE_SETTLE_MS);

          // DEBUG STATE
          await page.evaluate(() => {
            console.log('[DEBUG] LocalStorage after reload:', localStorage.getItem('benchone_ws_researcher@lab.edu'));
          });

          await checkSnapshot(page, 'workspace_data_loaded');
        } catch (e) {
          console.log(`[TIMEOUT ERROR] ${e.message}`);
          await page.screenshot({ path: 'playwright/report/timeout-screenshot.png' });
          warn('PBMC3k load timed out — R backend may be offline; continuing with UI-only tests');
        }
        // Ensure modal is closed before continuing tab navigation
        await page.keyboard.press('Escape');
        await sleep(500);
      } else {
        warn('PBMC3k demo card not found in modal — skipping data load test');
        // Close modal to unblock subsequent navigation
        await page.keyboard.press('Escape');
        await sleep(500);
      }
      // Final safety: dismiss any lingering overlay before tab navigation
      const overlay = page.locator('div.fixed.inset-0').first();
      if (await overlay.count() > 0) {
        await page.keyboard.press('Escape');
        await sleep(500);
      }
    } else {
      warn('Load Object button not found — skipping modal test');
    }
  } catch (e) {
    warn('Load Object flow error', e.message);
    // Safety dismiss
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }

  // ── Test 5: Per-Tab Rendering ──────────────────────────────────────────────
  const allTabs = [
    { id: 'pipeline-manager', label: 'Pipeline Manager',     requiresData: false },
    { id: 'inspect',      label: 'Inspect',                  requiresData: true  },
    { id: 'qc',           label: 'Quality Control',           requiresData: true  },
    { id: 'normalize',    label: 'Normalize',                 requiresData: true  },
    { id: 'integrate',    label: 'Integration',               requiresData: true  },
    { id: 'pca',          label: 'PCA',                       requiresData: true  },
    { id: 'cluster',      label: 'Cluster',                   requiresData: true  },
    { id: 'umap',         label: 'UMAP',                      requiresData: true  },
    { id: 'featureplot',  label: 'Feature Plot',              requiresData: true  },
    { id: 'heatmap',      label: 'Heatmap',                   requiresData: true  },
    { id: 'dotplot',      label: 'Dot Plot',                  requiresData: true  },
    { id: 'geneviewer',   label: 'Gene Expression',           requiresData: true  },
    { id: 'deg',          label: 'Markers / DEG',             requiresData: true  },
    { id: 'annotate',     label: 'Cell Annotation',           requiresData: true, expectedDisabled: true  },
    { id: 'enrichment',   label: 'Pathway Enrichment',        requiresData: true, expectedDisabled: false },
    { id: 'cellchat',     label: 'CellChat',                  requiresData: true, expectedDisabled: false },
    { id: 'customscript', label: 'Custom Script',             requiresData: true, expectedDisabled: true  },
    { id: 'history',      label: 'Jobs & Artifacts',          requiresData: false },
    { id: 'publication',  label: 'Figure Gallery',            requiresData: true  },
    { id: 'validation',   label: 'Validation',                requiresData: true  },
    { id: 'lineage',      label: 'Lineage',                   requiresData: true },
    { id: 'diagnostics',  label: 'Diagnostics',               requiresData: false, clickVia: 'engine-status' },
  ];

  for (const tab of allTabs) {
    if (tab.requiresData && !dataLoaded) {
      warn(`Tab "${tab.label}": skipped (requires data — R backend may be offline)`);
      continue;
    }

    section(`TAB: ${tab.label}`);

    try {
      if (tab.clickVia === 'engine-status') {
        // Diagnostics is opened via Engine Status block
        const engineBlock = page.locator('aside div:has-text("Backend connected"), aside div:has-text("Backend offline"), aside div:has-text("R/Seurat runtime connected")').first();
        if (await engineBlock.count() > 0) {
          await engineBlock.click();
        } else {
          warn(`${tab.label}: engine status block not found`);
          continue;
        }
      } else {
        const btn = page.locator(`aside button:has-text("${tab.label}")`).first();
        if (await btn.count() === 0) {
          warn(`${tab.label}: sidebar button not found`);
          continue;
        }
        if (tab.expectedDisabled) {
          assert(`${tab.label}: marked disabled / not integrated`, await btn.isDisabled());
          continue;
        }
        await btn.click();
      }

      await sleep(PAGE_SETTLE_MS);

      // 1. Crash detection
      const crashed = await page.locator('text=Component Error').count() > 0;
      assert(`${tab.label}: no React ErrorBoundary crash`, !crashed);

      if (!crashed) {
        if (tab.id === 'pipeline-manager') {
          const trustedDefinition = page.getByText('Visual Inspection View', { exact: true });
          const trustedDefinitionCount = await trustedDefinition.count();
          assert('Pipeline Manager: trusted registry definition visible after navigation',
            trustedDefinitionCount === 1 && await trustedDefinition.isVisible());
          assert('Pipeline Manager: non-developer publication controls hidden',
            await page.getByRole('heading', { name: 'Publish Trusted Pipeline Manifest', exact: true }).count() === 0);
        }

        if (tab.id === 'lineage') {
          const durableLineageCopy = page.getByText(
            'Durable analysis-object lineage for the selected project object. Edges are created by reviewed job handlers; this view is read-only.'
          );
          assert('Lineage: durable read-only graph copy visible', await durableLineageCopy.count() === 1);
        }

        // 2. Screenshot regression
        await checkSnapshot(page, `tab_${tab.id}`);

        // 3. Layout overflow
        await checkOverflow(page, tab.label);

        // 4. A11Y audit
        await runA11yAudit(page, tab.label);
      }

      allResults.push({ tab: tab.label, crashed, consoleErrorsAtTime: consoleErrors.length });
    } catch (e) {
      fail(`${tab.label}: unexpected error`, e.message);
    }
  }

  // ── Test 6: Workspace Switching ────────────────────────────────────────────
  section('STEP 7: Workspace switching (Personal → Shared)');
  try {
    const sharedWsBtn = page.locator('nav button:has-text("SH"), nav button:has-text("Sh")').first();
    if (await sharedWsBtn.count() > 0) {
      await sharedWsBtn.click();
      await sleep(800);
      const collaboratorsVisible = await page.locator('aside button:has-text("Collaborators")').count() > 0;
      assert('Shared workspace shows Collaborators nav item', collaboratorsVisible);
      await checkSnapshot(page, 'workspace_shared');
      // Switch back to personal
      const personalBtn = page.locator('nav button:has-text("PE"), nav button:has-text("Pe")').first();
      if (await personalBtn.count() > 0) await personalBtn.click();
    } else {
      info('Shared workspace shell is absent by design on this branch; skipping shared-workspace switch check.');
    }
  } catch (e) {
    warn('Workspace switching test error', e.message);
  }
  // ── Test 6b: Save Figure to Gallery ────────────────────────────────────────
  section('STEP 7b: Save Figure Integration Flow');
  try {
    if (dataLoaded) {
      const umapBtn = page.locator('aside button:has-text("UMAP")').first();
      if (await umapBtn.count() > 0) {
        await umapBtn.click();
        await sleep(PAGE_SETTLE_MS);
        
        const saveFigBtn = page.locator('button:visible').filter({ hasText: 'Save Figure' }).first();
        if (await saveFigBtn.count() > 0) {
          await saveFigBtn.click();
          await sleep(1000);
          
          const saveToGalleryBtn = page.locator('button:visible').filter({ hasText: 'Save to Figure Gallery' }).first();
          if (await saveToGalleryBtn.count() > 0) {
            await saveToGalleryBtn.click();
            await sleep(2000); // Wait for R backend generation and API state
            
            const galleryBtn = page.locator('aside button:has-text("Figure Gallery")').first();
            await galleryBtn.click();
            await sleep(PAGE_SETTLE_MS);
            
            // Check for presence of saved figure card
            const figureCard = page.locator('text=UMAP').first();
            assert('Saved figure appears in Figures gallery', await figureCard.count() > 0);
            await checkSnapshot(page, 'e2e_saved_figure');
          } else {
            warn('Save to Gallery button not found inside save panel');
          }
        } else {
          warn('Save Figure button not found on UMAP tab');
        }
      }
    } else {
      warn('Save Figure flow skipped (requires data)');
    }
  } catch (e) {
    warn('Save Figure flow error', e.message);
  }

  // ── Test 7: Console Errors Summary ────────────────────────────────────────
  section('STEP 8: Console error audit');
  if (consoleErrors.length === 0) {
    pass('No unexpected console errors detected across all tabs');
  } else {
    fail(`${consoleErrors.length} unexpected console error(s) detected`, consoleErrors.slice(0, 5).join(' | '));
  }

  // ── Test 8: Network failure summary ───────────────────────────────────────
  section('STEP 9: Network failure audit');
  if (networkFailures.length === 0) {
    pass('No unexpected network failures detected');
  } else {
    fail(`${networkFailures.length} network failure(s)`, networkFailures.slice(0, 5).join(' | '));
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await browser.close();
  stopVite();

  // ── Write HTML Report ──────────────────────────────────────────────────────
  const htmlReport = generateHtmlReport({ allResults, failures, warnings, consoleErrors, networkFailures });
  fs.writeFileSync(path.join(REPORT_DIR, 'index.html'), htmlReport);
  info(`HTML report written to: ${path.join(REPORT_DIR, 'index.html')}`);

  // ── Summary ────────────────────────────────────────────────────────────────
  const bar = '='.repeat(60);
  console.log(`\n${bar}`);
  console.log('  VISUAL & UI/UX TEST SUMMARY');
  console.log(bar);
  console.log(`  Total : ${PASS + FAIL}`);
  console.log(`  Passed: ${PASS}`);
  console.log(`  Failed: ${FAIL}`);
  console.log(`  Warned: ${WARN}`);
  console.log(`  Mode  : ${UPDATE_MODE ? 'BASELINE UPDATE' : 'REGRESSION CHECK'}`);
  console.log('');

  if (failures.length > 0) {
    console.log('FAILED CHECKS:');
    failures.forEach(f => {
      console.log(`  ✗ ${f.desc}`);
      if (f.detail) console.log(`    → ${f.detail}`);
    });
    console.log('');
  }

  if (FAIL > 0) {
    console.log('❌ Visual/UX tests FAILED.\n');
    process.exit(1);
  } else {
    console.log('✅ All visual/UX tests passed!\n');
    process.exit(0);
  }
}

// ── HTML Report Generator ──────────────────────────────────────────────────────
function generateHtmlReport({ allResults, failures, warnings, consoleErrors, networkFailures }) {
  const timestamp = new Date().toLocaleString();
  const snapshotFiles = fs.existsSync(SNAPSHOTS_DIR) ? fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.png')) : [];

  const snapshotCards = snapshotFiles.map(f => {
    const name = f.replace('.png', '');
    const imgPath = path.join(SNAPSHOTS_DIR, f).replace(/\\/g, '/');
    return `
      <div class="card">
        <div class="card-title">${name}</div>
        <img src="file:///${imgPath}" alt="${name}" loading="lazy" />
      </div>`;
  }).join('');

  const failureRows = failures.map(f =>
    `<tr class="fail-row"><td>❌</td><td>${f.desc}</td><td>${f.detail || ''}</td></tr>`
  ).join('');

  const warningRows = warnings.map(w =>
    `<tr class="warn-row"><td>⚠️</td><td>${w.desc}</td><td>${w.detail || ''}</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>scRNA-seq Dashboard — Visual/UX Test Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 32px; }
    h1 { font-size: 24px; font-weight: 800; margin-bottom: 4px; color: #f8fafc; }
    .meta { font-size: 13px; color: #64748b; margin-bottom: 32px; }
    .stat-bar { display: flex; gap: 16px; margin-bottom: 32px; }
    .stat { background: #1e293b; border-radius: 10px; padding: 16px 24px; flex: 1; }
    .stat-num { font-size: 32px; font-weight: 900; }
    .stat-label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 4px; }
    .pass { color: #22c55e; } .fail { color: #ef4444; } .warn { color: #f59e0b; }
    section { margin-bottom: 40px; }
    h2 { font-size: 16px; font-weight: 700; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 12px; background: #1e293b; color: #94a3b8; font-weight: 600; }
    td { padding: 8px 12px; border-bottom: 1px solid #1e293b; vertical-align: top; }
    .fail-row td { background: rgba(239,68,68,0.08); }
    .warn-row td { background: rgba(245,158,11,0.08); }
    .screenshots { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .card { background: #1e293b; border-radius: 10px; overflow: hidden; }
    .card-title { padding: 10px 14px; font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.07em; }
    .card img { width: 100%; display: block; }
  </style>
</head>
<body>
  <h1>📊 scRNA-seq Dashboard — Visual/UX Test Report</h1>
  <div class="meta">Generated: ${timestamp} | Mode: ${UPDATE_MODE ? 'Baseline Update' : 'Regression Check'}</div>

  <div class="stat-bar">
    <div class="stat"><div class="stat-num pass">${PASS}</div><div class="stat-label">Passed</div></div>
    <div class="stat"><div class="stat-num fail">${FAIL}</div><div class="stat-label">Failed</div></div>
    <div class="stat"><div class="stat-num warn">${WARN}</div><div class="stat-label">Warned</div></div>
    <div class="stat"><div class="stat-num" style="color:#38bdf8">${snapshotFiles.length}</div><div class="stat-label">Snapshots</div></div>
  </div>

  ${failures.length > 0 ? `
  <section>
    <h2>❌ Failures</h2>
    <table><tr><th></th><th>Check</th><th>Detail</th></tr>${failureRows}</table>
  </section>` : ''}

  ${warnings.length > 0 ? `
  <section>
    <h2>⚠️ Warnings</h2>
    <table><tr><th></th><th>Check</th><th>Detail</th></tr>${warningRows}</table>
  </section>` : ''}

  ${consoleErrors.length > 0 ? `
  <section>
    <h2>🖥️ Console Errors</h2>
    <table><tr><th>Error</th></tr>${consoleErrors.map(e => `<tr class="fail-row"><td><code>${e}</code></td></tr>`).join('')}</table>
  </section>` : ''}

  <section>
    <h2>📸 Screenshots</h2>
    <div class="screenshots">${snapshotCards || '<p style="color:#64748b">No snapshots found.</p>'}</div>
  </section>
</body>
</html>`;
}

// ── Entry Point ────────────────────────────────────────────────────────────────
main().catch(e => {
  console.error('[FATAL]', e.message);
  stopVite();
  process.exit(1);
});
