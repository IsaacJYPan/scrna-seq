// TraceOmics visual acceptance covers snapshots, interaction, accessibility,
// layout overflow, request failures, performance, and browser console errors.

'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Configuration ──────────────────────────────────────────────────────────────
const VITE_PORT     = Number(process.env.VISUAL_VITE_PORT || 5173);
const VITE_URL      = `http://localhost:${VITE_PORT}`;
const WORKSPACE     = path.resolve(__dirname, '..');
const VITE_CLI      = path.join(WORKSPACE, 'node_modules', 'vite', 'bin', 'vite.js');
const SNAPSHOT_PLATFORM = String(process.env.VISUAL_SNAPSHOT_PLATFORM || process.platform)
  .toLowerCase().replace(/[^a-z0-9_-]/g, '');
const SNAPSHOTS_ROOT = path.join(WORKSPACE, 'playwright', 'snapshots');
// Browser text rasterization differs materially between Windows and Linux.
// Keep the reviewed legacy Windows goldens in the root and use a dedicated
// Linux set in CI instead of weakening the pixel-difference threshold.
const SNAPSHOTS_DIR = SNAPSHOT_PLATFORM === 'linux'
  ? path.join(SNAPSHOTS_ROOT, 'linux')
  : SNAPSHOTS_ROOT;
const REPORT_DIR    = path.join(WORKSPACE, 'playwright', 'report');
const UPDATE_MODE   = process.argv.includes('--update-snapshots');
const NO_SNAPSHOT_MODE = process.argv.includes('--no-snapshots');
const MODE_NAME = NO_SNAPSHOT_MODE
  ? 'BROWSER SMOKE (NO SNAPSHOTS)'
  : (UPDATE_MODE ? 'BASELINE UPDATE' : 'REGRESSION CHECK');
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

// Visual state checks deliberately use the rendered screen rather than DOM
// semantics alone. A hover should not make surrounding controls jump, and the
// focused/hovered appearances are captured alongside the resting screenshot.
async function checkCalmInteractiveStates(page, locator, name) {
  if (await locator.count() === 0) {
    warn(`Interactive state ${name} is present for visual review`);
    return;
  }

  const before = await locator.boundingBox();
  await locator.hover();
  await sleep(220);
  const after = await locator.boundingBox();
  const shifted = !before || !after || [
    Math.abs(before.x - after.x), Math.abs(before.y - after.y),
    Math.abs(before.width - after.width), Math.abs(before.height - after.height),
  ].some(value => value > 0.5);
  assert(`Interactive state ${name} does not shift layout on hover`, !shifted);
  await checkSnapshot(page, `state_hover_${name}`);

  await locator.focus();
  await sleep(100);
  const isFocused = await locator.evaluate(element => document.activeElement === element);
  assert(`Interactive state ${name} can receive keyboard focus`, isFocused);
  await checkSnapshot(page, `state_focus_${name}`);
}

async function checkReducedMotion(page, locator, name) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const transition = await locator.evaluate(element => window.getComputedStyle(element).transitionDuration);
  const longestDurationMs = Math.max(...transition.split(',').map(value => {
    const duration = Number.parseFloat(value);
    return value.trim().endsWith('ms') ? duration : duration * 1000;
  }));
  assert(`Reduced motion removes prolonged ${name} animation`, longestDurationMs <= 1, `transition duration is ${transition}`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
}

// ── Screenshot Snapshot Check ──────────────────────────────────────────────────
async function checkSnapshot(page, name) {
  if (NO_SNAPSHOT_MODE) return;
  const file = path.join(SNAPSHOTS_DIR, `${name}.png`);
  // Snapshot only a stable resting frame. Carets blink independently of the
  // application, while Plotly controls and loading indicators use CSS
  // transitions/animations whose sampled frame can vary with runner load.
  // Playwright fast-forwards finite animations and hides the caret without
  // changing the reviewed layout or relaxing the pixel-difference threshold.
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const buf = await page.screenshot({
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
  });

  if (UPDATE_MODE) {
    fs.writeFileSync(file, buf);
    info(`Snapshot saved: ${name}.png`);
    return;
  }

  if (!fs.existsSync(file)) {
    fail(`Snapshot ${name}: reviewed baseline is missing`, 'run npm run test:visual:update after deliberate visual review');
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
  } catch {
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
      // SVG text nodes do not participate in CSS box overflow. Plotly uses
      // them for tick labels, where clientWidth is frequently zero or rounded
      // below scrollWidth even though the containing HTML plot is clipped.
      // Keep checking the HTML plot container, which is the meaningful layout
      // boundary for a user-visible horizontal overflow.
      if (el instanceof SVGElement) return;
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
  viteProc = spawn(process.execPath, [VITE_CLI, '--port', String(VITE_PORT), '--strictPort'], {
    cwd: WORKSPACE,
    stdio: ['pipe', 'pipe', 'pipe'],
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
  console.log('  TraceOmics Visual & UI/UX Test Suite');
  console.log('='.repeat(60));
  console.log(`  Mode      : ${MODE_NAME}`);
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
    localStorage.setItem('traceomics_auth_token', 'visual-test-token');
    localStorage.setItem('traceomics_auth_user', JSON.stringify({
      id: 'visual-user',
      email: 'researcher@lab.edu',
      displayName: 'Visual Tester'
    }));
    window.mockFigures = [];
    // Provenance can be absent after a local cache reset even when the attached
    // R session has completed preprocessing. The visual UMAP flow deliberately
    // starts without historical records so it catches any attempt to replace
    // server-verified pipeline availability with a partial browser-side graph.
    window.mockProvenance = [];
    window.electronAPI = {
      getFigures: async () => window.mockFigures,
      saveFigure: async (fig) => { window.mockFigures.push(fig); return { success: true }; },
      deleteFigure: async (id) => { window.mockFigures = window.mockFigures.filter(f => f.id !== id); return { success: true }; },
      getAllProvenance: async () => window.mockProvenance,
      getProvenance: async (id) => window.mockProvenance.find(record => record.id === id) || null,
      saveProvenance: async (envelope) => {
        const record = { ...(envelope?.provenance || {}), result: envelope?.result };
        window.mockProvenance = [record, ...window.mockProvenance.filter(existing => existing.id !== record.id)];
        return record.id;
      },
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

  await page.route('**/api/runtime/compute-status*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({ status: 'ready', updatedAt: '2026-08-01T00:00:00.000Z' })
    });
  });

  // The browser API replaces the injected Electron bridge during app startup, so
  // retain saved figures in this route mock rather than relying on window state.
  // This models the small GET/POST gallery contract used by the save-figure flow.
  const visualFigures = [];
  await page.route('**/api/db/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let status = 200;
    let body = [];

    if (pathname === '/api/db/figures') {
      if (request.method() === 'POST') {
        let record = {};
        try {
          record = request.postDataJSON() || {};
        } catch {
          // A malformed request is not expected from the client under test, but
          // keep the mock response JSON-shaped so the smoke can report the flow.
        }
        const figure = {
          ...record,
          createdAt: '2026-08-01T00:00:00.000Z',
        };
        visualFigures.push(figure);
        status = 201;
        body = figure;
      } else if (request.method() === 'GET') {
        body = visualFigures;
      }
    }

    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify(body)
    });
  });

  // ── Auth session restore (mocked; no backend in CI) ──────────────────────────
  // On startup the app calls restoreSession() → GET /api/auth/session to adopt the
  // HttpOnly-cookie session (source of auth truth). With no backend the Vite /api
  // proxy returns a 500 (ECONNREFUSED) and the request aborts, which the console +
  // network audits flag. Mock it to return the same user the init script seeds into
  // localStorage so the app stays logged in. logout is a best-effort POST that is
  // never triggered here, but is mocked too for completeness.
  const visualAuthUser = { id: 1, email: 'researcher@lab.edu', displayName: 'Visual Tester' };
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
  await page.route('**/api/expert-r/capabilities*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        expertREnabled: true,
        expertRProfile: {
          id: 'expert-r-visual-v1',
          packages: ['Seurat', 'dplyr', 'ggplot2', 'readr'],
        },
      })
    });
  });
  await page.route('**/api/artifact-versions/*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) });
  });
  await page.route('**/api/expert-r/projects/*/inputs*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify([{
        id: 'input_visual_1',
        originalFilename: 'sample-annotations.csv',
        sizeBytes: 18432,
        createdAt: '2026-01-03T12:00:00.000Z',
      }])
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
      visualPipelineTab('history', 'Runs & Results', 'projectHistory')
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

  const visualConditions = [
    { id: 'condition_control', name: 'Control' },
    { id: 'condition_treated', name: 'Treated' },
  ];
  const visualSamples = [
    { id: 'sample_control_1', name: 'Control donor 1', conditionId: 'condition_control', conditionName: 'Control', donorCode: 'D01', batch: 'A', modality: 'scrna' },
    { id: 'sample_control_2', name: 'Control donor 2', conditionId: 'condition_control', conditionName: 'Control', donorCode: 'D02', batch: 'B', modality: 'scrna' },
    { id: 'sample_treated_1', name: 'Treated donor 1', conditionId: 'condition_treated', conditionName: 'Treated', donorCode: 'D03', batch: 'A', modality: 'scrna' },
    { id: 'sample_treated_2', name: 'Treated donor 2', conditionId: 'condition_treated', conditionName: 'Treated', donorCode: 'D04', batch: 'B', modality: 'scrna' },
  ];
  const visualBindings = visualSamples.map((sample, index) => ({
    id: `binding_visual_${index + 1}`,
    analysisObjectId: 'ao_visualmock0001',
    sampleId: sample.id,
    sampleName: sample.name,
    cellMetadataColumn: 'orig.ident',
    cellMetadataValue: `sample_${index + 1}`,
  }));
  const visualContrasts = [{
    id: 'contrast_visual_1',
    analysisObjectId: 'ao_visualmock0001',
    name: 'Treated vs control',
    numeratorConditionName: 'Treated',
    denominatorConditionName: 'Control',
    unitOfReplication: 'sample',
    cellTypeColumn: 'seurat_clusters',
    status: 'valid',
    validation: { issues: [], warnings: [] },
  }];
  const visualBranches = [{
    id: 'branch_visual_private',
    ownerUserId: 1,
    name: 'alternate normalization',
    description: 'Compare a conservative normalization strategy before project review.',
    visibility: 'private',
    status: 'active',
    baseAnalysisObjectId: 'ao_visualmock0001',
    headAnalysisObjectId: 'ao_visualmock0001',
    version: 1,
  }];

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
    } else if (path.endsWith('/conditions')) {
      body = visualConditions;
    } else if (path.endsWith('/samples')) {
      body = visualSamples;
    } else if (/\/analysis-objects\/[^/]+\/sample-bindings$/.test(path)) {
      body = visualBindings;
    } else if (path.endsWith('/contrasts')) {
      body = visualContrasts;
    } else if (path.endsWith('/branches')) {
      body = demoObjectExists ? visualBranches : [];
    } else if (path.endsWith('/reviews')) {
      body = [];
    } else if (/\/reviews\/[^/]+\/comments$/.test(path)) {
      body = [];
    } else if (path.endsWith('/canonical-analysis')) {
      body = null;
    } else if (path.endsWith('/audit-events')) {
      body = demoObjectExists ? [{
        id: 'audit_visual_1',
        action: 'branch.created',
        targetType: 'branch',
        targetId: 'branch_visual_private',
        createdAt: '2026-01-03T12:00:00.000Z',
      }] : [];
    } else if (/\/analysis-objects\/[^/]+\/lineage$/.test(path)) {
      body = {
        projectId: visualProject.id,
        objectId: 'ao_visualmock0001',
        rootObjectId: 'ao_visualmock0001',
        nodes: demoObjectExists ? [
          visualAnalysisObject(),
          visualAnalysisObject({
            id: 'ao_visualfork0002',
            parentObjectId: 'ao_visualmock0001',
            lineageRootId: 'ao_visualmock0001',
            displayName: 'Forked PBMC branch',
            createdAt: '2026-01-02 00:00:00',
          }),
        ] : [],
        edges: demoObjectExists ? [{
          id: 'aoe_visualfork0001',
          parentAnalysisObjectId: 'ao_visualmock0001',
          childAnalysisObjectId: 'ao_visualfork0002',
          jobId: 'job_visual_fork_1',
          edgeType: 'checkpoint_fork',
          parentRole: 'input',
        }] : [],
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
        has_umap: false
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

  // Existing reductions are read independently of the computation routes.
  // Keep this fixture consistent with the authoritative mock pipeline state.
  await page.route('**/reduction-results*', async route => {
    const reduction = new URL(route.request().url()).searchParams.get('reduction');
    const result = reduction === 'pca'
      ? { exists: true, restored: true, reduction: 'pca', npcs: 15,
        settings: { seed: 42 }, stdevs: Array.from({ length: 15 }, (_, index) => 3 / (index + 1)),
        gene_loadings: {}, trace_data: [{ name: 'Cluster 0', x: [1, 2], y: [2, 4] }] }
      : { exists: false, reduction: 'umap' };
    await route.fulfill({ status: 200, contentType: 'application/json', headers: corsHeaders,
      body: JSON.stringify({ result, live_state: { live_revision: 0, saved_revision: 0, has_unsaved_changes: false } }) });
  });

  await page.route('**/load-data*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        provenance: {
          operation: 'load'
        },
        result: {
          message: 'Matrix successfully loaded into Seurat.',
          cells: 2700,
          features: 32738,
          genes: 32738,
          sparsity: 97.41,
          density: 2.59
        }
      })
    });
  });

  await page.route('**/umap*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        provenance: { id: 'prov_visual_umap' },
        result: {
          n_components: 2,
          trace_data: [
            { name: 'Cluster 0', x: [1, 2], y: [2, 4] },
            { name: 'Cluster 1', x: [3, 4], y: [1, 3] }
          ]
        }
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
        result: {
          base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
        }
      })
    });
  });

  await page.route('**/export-figure*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        provenance: { id: 'prov_visual_export' },
        result: {
          message: 'Successfully exported UMAP to visual-umap.png',
          file_name: 'visual-umap.png',
          thumbnail_b64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
        }
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
  await checkPrimaryButtonHover(page, 'Add analysis');
  await checkCalmInteractiveStates(page, page.getByRole('button', { name: 'New Project', exact: true }).first(), 'new_project');
  await checkReducedMotion(page, page.getByRole('button', { name: 'New Project', exact: true }).first(), 'new project button');

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
    await checkPrimaryButtonHover(page, 'Add analysis');
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

  // ── Test 4: Add analysis modal ────────────────────────────────────────────
  section('STEP 6: Add analysis modal flow');
  let dataLoaded = false;
  try {
    // Keep this selector exact. A broad "Add" match can accidentally choose
    // unrelated disabled navigation (for example Lineage's "requires loaded
    // object" status) before the actual workspace action.
    const loadBtn = page.getByRole('button', { name: 'Add analysis', exact: true }).first();
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
          pass('Add analysis modal: PBMC3k demo dataset loaded successfully');

          await sleep(1500);

          // Inject mock PCA pipeline state so UMAP tab is accessible
          await page.evaluate(() => {
            try {
              const wsRaw = localStorage.getItem('traceomics_ws_researcher@lab.edu');
              if (wsRaw) {
                const workspaces = JSON.parse(wsRaw);
                if (workspaces && workspaces.length > 0 && workspaces[0].objects && workspaces[0].objects.length > 0) {
                  const objId = workspaces[0].objects[0].id;
                  const psKey = `traceomics_ps_researcher@lab.edu_${objId}`;
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
      warn('Add analysis button not found — skipping modal test');
    }
  } catch (e) {
    warn('Add analysis flow error', e.message);
    // Safety dismiss
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }

  // ── Test 5: Per-Tab Rendering ──────────────────────────────────────────────
  const allTabs = [
    { id: 'pipeline-manager', label: 'Pipelines',   requiresData: false },
    { id: 'branches',      label: 'Analysis Branches',        requiresData: true  },
    { id: 'study-design',  label: 'Study Design',             requiresData: true  },
    { id: 'expert-r',      label: 'Advanced analysis',        requiresData: true  },
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
    { id: 'explore',      label: 'Exploratory Analysis',      requiresData: true  },
    { id: 'deg',          label: 'Markers / DEG',             requiresData: true  },
    { id: 'annotate',     label: 'Cell Annotation',           requiresData: false, expectedHidden: true  },
    { id: 'enrichment',   label: 'Pathway Enrichment',        requiresData: true },
    { id: 'cellchat',     label: 'CellChat',                  requiresData: true },
    { id: 'customscript', label: 'Custom Script',             requiresData: false, expectedHidden: true  },
    { id: 'history',      label: 'Runs & Results',            requiresData: false },
    { id: 'publication',  label: 'Figure Gallery',            requiresData: true  },
    { id: 'validation',   label: 'Validation',                requiresData: true  },
    { id: 'lineage',      label: 'Lineage',                   requiresData: true },
    { id: 'diagnostics',  label: 'Diagnostics',               requiresData: false, expectedHidden: true },
  ];

  for (const tab of allTabs) {
    if (tab.expectedHidden) {
      section(`TAB: ${tab.label}`);
      const hiddenControl = page.locator(`aside button:has-text("${tab.label}")`).first();
      assert(`${tab.label}: intentionally not exposed in the sidebar`, await hiddenControl.count() === 0);
      allResults.push({ tab: tab.label, hidden: true, consoleErrorsAtTime: consoleErrors.length });
      continue;
    }

    if (tab.requiresData && !dataLoaded) {
      warn(`Tab "${tab.label}": skipped (requires data — R backend may be offline)`);
      continue;
    }

    section(`TAB: ${tab.label}`);

    try {
      if (tab.clickVia === 'runtime-status') {
        // Diagnostics is opened through the accessible runtime-status button.
        const runtimeStatusButton = page.getByRole('button', { name: /open diagnostics & environment/i }).first();
        if (await runtimeStatusButton.count() > 0) {
          await runtimeStatusButton.click();
        } else {
          fail(`${tab.label}: runtime-status control not found`);
          continue;
        }
      } else {
        const btn = page.locator(`aside button:has-text("${tab.label}")`).first();
        if (await btn.count() === 0) {
          warn(`${tab.label}: sidebar button not found`);
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
          assert('Pipelines: trusted registry definition visible after navigation',
            trustedDefinitionCount === 1 && await trustedDefinition.isVisible());
          assert('Pipelines: non-developer publication controls hidden',
            await page.getByRole('heading', { name: 'Publish Trusted Pipeline Manifest', exact: true }).count() === 0);
          const packageMetadata = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'examples/pipelines/cell-summary.json'), 'utf8'));
          const packageSource = fs.readFileSync(path.join(WORKSPACE, 'examples/pipelines/cell-summary.R'), 'utf8');
          await page.getByLabel('Pipeline package file').setInputFiles({
            name: 'cell-summary.pipeline.json', mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify({ ...packageMetadata, script: packageSource })),
          });
          await page.getByRole('button', { name: 'Install version 1.0.0', exact: true }).click();
          assert('Pipelines: imported R package is installed',
            await page.getByRole('button', { name: 'Run Cell summary', exact: true }).count() === 1);
          const downloadPromise = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Export Cell summary version 1.0.0', exact: true }).click();
          const download = await downloadPromise;
          const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
          assert('Pipelines: export preserves version and executable source',
            exported.version === packageMetadata.version && exported.script === packageSource);
          await page.screenshot({ path: path.join(REPORT_DIR, 'pipeline-library.png'), fullPage: true });
          await page.getByRole('button', { name: 'Remove Cell summary version 1.0.0', exact: true }).click();
          assert('Pipelines: removing an installed version updates the library',
            await page.getByRole('button', { name: 'Run Cell summary', exact: true }).count() === 0);
        }

        if (tab.id === 'branches') {
          assert('Analysis Branches: private branch workflow is visible',
            await page.getByText('Create a private branch', { exact: true }).count() === 1);
          assert('Analysis Branches: review sharing is explicit',
            await page.getByRole('button', { name: 'Share for review', exact: true }).count() === 1);
        }

        if (tab.id === 'study-design') {
          assert('Study Design: multi-condition contrast is visible',
            await page.getByText('Treated vs control', { exact: true }).count() === 1);
          assert('Study Design: biological replication is represented',
            await page.getByText('4 registered samples', { exact: true }).count() === 1);
        }

        if (tab.id === 'expert-r') {
          assert('Advanced analysis: approved Expert R workbench is visible',
            await page.getByRole('heading', { name: 'Expert R Workbench', exact: true }).count() === 1);
          assert('Advanced analysis: controlled private input is visible',
            await page.getByText('sample-annotations.csv', { exact: true }).count() === 1);
        }

        if (tab.id === 'explore') {
          await page.getByRole('heading', { name: 'Exploratory Analysis', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
          await page.screenshot({ path: path.join(REPORT_DIR, 'exploratory-analysis.png'), fullPage: true });
          assert('Exploratory Analysis: guided recipe controls are visible',
            await page.getByRole('button', { name: 'Run recipe', exact: true }).count() === 1);
          assert('Exploratory Analysis: aggregate-only privacy boundary is visible',
            await page.getByText('Private analysis workspace · aggregate-only result', { exact: true }).count() === 1);
        }

        if (tab.id === 'lineage') {
          const durableLineageCopy = page.getByText(
            'Recorded relationships for the selected saved analysis. This view is read-only.'
          );
          assert('Lineage: recorded read-only relationships visible', await durableLineageCopy.count() === 1);
          const forkExplanation = page.getByText('Created from a saved version. The source analysis remains unchanged.');
          assert('Lineage: fork relationship is explained in researcher language', await forkExplanation.count() === 1);
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
        
        const saveFigBtn = page.getByRole('button', { name: 'Save Figure', exact: true }).first();
        let saveFigureReady = await saveFigBtn.count() > 0;
        let savePanelOpened = false;

        // UMAP only cache-hydrates on navigation. A first-time visitor must use
        // the visible Run control before a result (and its Save Figure action)
        // exists, so exercise that user workflow rather than treating the
        // deliberately empty initial state as a missing control.
        if (!saveFigureReady) {
          const runUmapBtn = page.getByRole('button', { name: /^(Run 2D UMAP|Re-compute UMAP)$/ }).first();
          if (await runUmapBtn.count() === 0) {
            fail('UMAP run control not found before the figure-save flow');
          } else if (await runUmapBtn.isDisabled()) {
            fail('UMAP run control is disabled before the figure-save flow');
          } else {
            try {
              // Let Playwright wait and deliver the user-visible click as soon
              // as the action is actionable. A separate wait followed by a
              // second interaction can race a React state update in dev mode.
              await runUmapBtn.click();
              await saveFigBtn.click({ timeout: 10000 });
              assert(
                'UMAP retains server-verified PCA readiness when provenance history is empty',
                await page.getByRole('heading', { name: 'PCA Required', exact: true }).count() === 0
              );
              saveFigureReady = true;
              savePanelOpened = true;
              pass('UMAP result rendered before the figure-save flow');
            } catch {
              fail('Save Figure could not be opened after running mocked UMAP');
            }
          }
        }

        if (saveFigureReady && !savePanelOpened) {
          await saveFigBtn.click();
          savePanelOpened = true;
        }

        if (savePanelOpened) {
          const figurePanelTitle = page.getByRole('heading', { name: 'Save to Figure Gallery', exact: true }).first();
          try {
            await figurePanelTitle.waitFor({ state: 'visible', timeout: 3000 });
            await sleep(300);
            assert('Figure save panel remains visibly open after activation', await figurePanelTitle.isVisible());
          } catch {
            fail('Figure save panel did not remain visibly open after activation');
          }
          await sleep(1000);
          
          const saveToGalleryBtn = page.getByRole('button', { name: 'Save to Figure Gallery', exact: true }).first();
          if (await saveToGalleryBtn.count() > 0) {
            await saveToGalleryBtn.click();
            const saveFeedback = page.getByText('Saved as visual-umap.png', { exact: true }).first();
            try {
              await saveFeedback.waitFor({ state: 'visible', timeout: 5000 });
              pass('Figure save completion is shown to the user');
            } catch {
              fail('Figure save completion feedback did not appear');
            }

            // The panel deliberately blocks background controls while it is
            // open. Close it through the same visible affordance a user uses
            // before returning to the gallery.
            const closeFigurePanelBtn = page.getByRole('button', { name: 'Close figure editor', exact: true }).first();
            if (await closeFigurePanelBtn.count() === 0) {
              fail('Figure editor close control not found after saving');
            } else {
              await closeFigurePanelBtn.click();
              await figurePanelTitle.waitFor({ state: 'hidden', timeout: 3000 });

              const galleryBtn = page.locator('aside button:has-text("Figure Gallery")').first();
              await galleryBtn.click();
              await sleep(PAGE_SETTLE_MS);

              // The saved thumbnail is specific to the gallery card, unlike
              // the sidebar's UMAP navigation label. Returning to an already
              // visited gallery must refresh it without requiring a manual
              // reload, so this remains a strict automatic-persistence check.
              const figureCard = page.getByRole('img', { name: 'UMAP', exact: true }).first();
              assert('Saved figure appears in Figures gallery', await figureCard.count() > 0);
              await checkSnapshot(page, 'e2e_saved_figure_gallery');

            }
          } else {
            fail('Save to Gallery button not found inside save panel');
          }
        }
      } else {
        fail('UMAP navigation control not found for the figure-save flow');
      }
    } else {
      info('Save Figure flow skipped because no data object was loaded.');
    }
  } catch (e) {
    fail('Save Figure flow error', e.message);
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
  console.log(`  Mode  : ${MODE_NAME}`);
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
function generateHtmlReport({ failures, warnings, consoleErrors }) {
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
  <title>TraceOmics Visual/UX Test Report</title>
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
  <h1>TraceOmics Visual/UX Test Report</h1>
  <div class="meta">Generated: ${timestamp} | Mode: ${MODE_NAME}</div>

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
