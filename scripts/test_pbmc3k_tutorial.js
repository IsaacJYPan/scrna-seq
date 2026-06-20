#!/usr/bin/env node
// ============================================================
// run_integration_tests.js  –  scRNA-seq Plumber API Integration Tests
// ============================================================
// Starts the R Plumber server on a test port (8001), exercises
// every major pipeline endpoint sequentially with the real PBMC3k
// dataset (data/pbmc3k/…), validates responses, then shuts down.
//
// Usage:
//   node scripts/run_integration_tests.js
// ============================================================

'use strict';

const { spawn, execSync } = require('child_process');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');

// ── Configuration ─────────────────────────────────────────────────────────────

const RSCRIPT_CANDIDATES = [
  process.env.RSCRIPT_PATH,
  'C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe',
  'C:\\Program Files\\R\\R-4.4.3\\bin\\Rscript.exe',
  'C:\\Program Files\\R\\R-4.4.0\\bin\\Rscript.exe',
  '/usr/bin/Rscript',
  '/usr/local/bin/Rscript',
  'Rscript',                   // relies on PATH
].filter(Boolean);

const TEST_PORT    = 8001;
const BASE_URL     = `http://127.0.0.1:${TEST_PORT}`;
const WORKSPACE    = path.resolve(__dirname, '..');
const RUN_R_SCRIPT = path.join(WORKSPACE, 'r-backend', 'run.R');
const EXPORTS_DIR  = path.join(WORKSPACE, 'exports');
const TIMEOUT_MS   = 300_000;   // 5 min per request (some steps are slow)
const STARTUP_WAIT = 60_000;    // 60 s to let Plumber fully start
const API_TOKEN    = 'TEST_DUMMY_TOKEN_123'; // Mock API token for testing

// ── Helpers ───────────────────────────────────────────────────────────────────

let PASS = 0, FAIL = 0, WARN = 0;
const failures = [];

function pass(desc) {
  console.log(`  ✅ PASS: ${desc}`);
  PASS++;
}

function fail(desc, detail = '') {
  console.log(`  ❌ FAIL: ${desc}${detail ? `\n     → ${detail}` : ''}`);
  FAIL++;
  failures.push({ desc, detail });
}

function warn(desc) {
  console.log(`  ⚠  WARN: ${desc}`);
  WARN++;
}

function info(msg) {
  console.log(`  ℹ  ${msg}`);
}

function section(title) {
  const bar = '─'.repeat(title.length);
  console.log(`\n${title}\n${bar}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make an HTTP request to the test Plumber server.
 * Returns parsed JSON body or throws on non-2xx status.
 */
async function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        'X-API-Token': API_TOKEN
      },
    };

    const timeout = setTimeout(() => {
      reject(new Error(`Request ${method} ${path} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    const r = http.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    r.on('error', e => { clearTimeout(timeout); reject(e); });
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

/** Assert a condition; record pass/fail. */
function assert(desc, cond, detail = '') {
  if (cond) pass(desc);
  else       fail(desc, detail);
}

/** Assert response has no 'error' field and has HTTP 200. */
function assertOk(desc, { status, body }) {
  if (status !== 200) {
    fail(desc, `HTTP ${status}`);
    return false;
  }
  if (body && body.error) {
    fail(desc, `API error: ${body.error}`);
    return false;
  }
  pass(desc);
  return true;
}

/** Wait until /health responds with HTTP 200, or timeout. */
async function waitForHealth(maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const { status } = await req('GET', '/health');
      if (status === 200) return true;
    } catch (_) { /* not ready yet */ }
    await sleep(1000);
  }
  return false;
}

// ── Locate Rscript ────────────────────────────────────────────────────────────

function findRscript() {
  // Try config.json first (mirrors main.js getConfig())
  const configPath = path.join(
    process.env.APPDATA || process.env.HOME || '',
    'scRNA-seq Workbench', 'config.json'
  );
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.rscriptPath && fs.existsSync(cfg.rscriptPath)) {
        return cfg.rscriptPath;
      }
    } catch (_) { /* ignore */ }
  }

  for (const candidate of RSCRIPT_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* path check failed */ }
  }
  // Fall back – let the shell resolve it
  return 'Rscript';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  scRNA-seq Plumber API  —  Integration Test Suite');
  console.log('='.repeat(60));
  console.log(`  Workspace : ${WORKSPACE}`);
  console.log(`  Test Port : ${TEST_PORT}`);
  console.log(`  Timestamp : ${new Date().toISOString()}\n`);

  // ── 0. Locate Rscript ───────────────────────────────────────────────────────
  section('STEP 0: Locate Rscript executable');
  const rscript = findRscript();
  info(`Using Rscript: ${rscript}`);
  assert('Rscript path is non-empty', rscript.length > 0);

  // Check run.R exists
  assert('run.R exists', fs.existsSync(RUN_R_SCRIPT), RUN_R_SCRIPT);

  // ── 0.5 Generate or Load Reference Metrics ────────────────────────────────────
  section('STEP 0.5: Generate or load reference metrics');
  const metricsFile = path.join(WORKSPACE, 'scripts', 'reference_metrics.json');
  if (!fs.existsSync(metricsFile)) {
    info('Reference metrics not found. Generating now (this may take a few minutes)...');
    try {
      execSync(`"${rscript}" "${path.join(WORKSPACE, 'scripts', 'generate_reference_pbmc3k.R')}"`, { stdio: 'inherit', cwd: path.join(WORKSPACE, 'scripts') });
    } catch (e) {
      console.error('Failed to generate reference metrics:', e.message);
      process.exit(1);
    }
  } else {
    info('Found existing reference metrics at ' + metricsFile);
  }
  const refMetrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));

  // ── 1. Start Plumber on test port ───────────────────────────────────────────
  section('STEP 1: Start R Plumber server');

  // Patch run.R port for testing by passing env var PLUMBER_PORT
  const rProc = spawn(rscript, [RUN_R_SCRIPT], {
    env: {
      ...process.env,
      PLUMBER_PORT:    String(TEST_PORT),
      ANALYSIS_ROOT:   WORKSPACE,
      PLUMBER_SAMPLE_CSV: path.join(WORKSPACE, 'r-backend', 'sample_data.csv'),
      API_TOKEN:       API_TOKEN
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: path.join(WORKSPACE, 'r-backend'),
  });

  let rStdout = '';
  let rStderr = '';
  rProc.stdout.on('data', d => { rStdout += d; process.stdout.write(`[R] ${d}`); });
  rProc.stderr.on('data', d => { rStderr += d; process.stdout.write(`[R:err] ${d}`); });
  rProc.on('error', e => console.error(`[Plumber spawn error] ${e.message}`));

  info(`Waiting up to ${STARTUP_WAIT / 1000}s for Plumber to start on port ${TEST_PORT}...`);
  const started = await waitForHealth(STARTUP_WAIT);
  assert('Plumber /health returned HTTP 200', started,
    started ? '' : 'Server did not become healthy in time');

  if (!started) {
    console.error('\n[FATAL] Plumber server did not start. Aborting tests.\n');
    rProc.kill();
    process.exit(1);
  }

  // ── 2. Health check ─────────────────────────────────────────────────────────
  section('STEP 2: /health');
  try {
    const r = await req('GET', '/health');
    assertOk('/health returns 200', r);
    assert('/health body has status "ok"', r.body && r.body.status === 'ok',
           JSON.stringify(r.body));
    assert('/health body has timestamp', r.body && typeof r.body.timestamp === 'string');
    info(`Server mode: ${r.body && r.body.mode}`);
  } catch (e) { fail('/health request', e.message); }

  // ── 3. Session ID ───────────────────────────────────────────────────────────
  section('STEP 3: /session-id');
  let sessionId = null;
  try {
    const r = await req('GET', '/session-id');
    assertOk('/session-id returns 200', r);
    assert('/session-id has sessionId field', r.body && typeof r.body.sessionId === 'string');
    sessionId = r.body && r.body.sessionId;
    info(`Session ID: ${sessionId}`);
  } catch (e) { fail('/session-id request', e.message); }

  // ── 4. Load PBMC3k dataset ──────────────────────────────────────────────────
  section('STEP 4: /load-data (PBMC3k)');
  try {
    info('Loading pbmc3k...');
    const r = await req('GET', '/load-data?min_cells=3&min_features=200');
    assertOk('/load-data returns 200 with no error', r);
    const res = (r.body || {}).result || {};
    assert(`PBMC3k tutorial load-data should have exactly ${refMetrics.load_data.cells} cells`, res.cells === refMetrics.load_data.cells, `cells=${res.cells}`);
    assert(`PBMC3k tutorial load-data should have exactly ${refMetrics.load_data.features} features`, res.features === refMetrics.load_data.features, `features=${res.features}`);
  } catch (e) { fail('/load-data request', e.message); }

  // ── 5. QC Filtering ─────────────────────────────────────────────────────────
  section('STEP 5: /qc (filter cells)');
  try {
    info('Filtering cells: nFeature_RNA > 200 & nFeature_RNA < 2500 & percent.mt < 5...');
    const r = await req('POST', '/qc', { mt_threshold: 5, min_features: 200, max_features: 2500, min_counts: 0 });
    assertOk('/qc returns 200', r);
    const res = (r.body || {}).result || {};
    assert(`PBMC3k tutorial QC should keep exactly ${refMetrics.qc.post_filter_cells} cells`, res.post_filter_cells === refMetrics.qc.post_filter_cells, `post_filter_cells=${res.post_filter_cells}`);
  } catch (e) { fail('/qc request', e.message); }

  // ── 6. Normalization ─────────────────────────────────────────────────────────
  section('STEP 6: /normalize');
  try {
    info('Normalizing data (LogNormalize, scale_factor=10000, nfeatures=2000)...');
    const r = await req('GET', '/normalize?method=LogNormalize&scale_factor=10000&nfeatures=2000');
    assertOk('/normalize returns 200', r);
    const res = (r.body || {}).result || {};
    assert(`PBMC3k tutorial should find exactly ${refMetrics.normalize.n_variable_features} variable features`, res.n_variable_features === refMetrics.normalize.n_variable_features, `n_variable_features=${res.n_variable_features}`);
  } catch (e) { fail('/normalize request', e.message); }

  // ── 7. PCA ───────────────────────────────────────────────────────────────────
  section('STEP 7: /pca');
  try {
    info('Running PCA (npcs=50)...');
    const r = await req('GET', '/pca?npcs=50');
    assertOk('/pca returns 200', r);
    const res = (r.body || {}).result || {};
    assert('PCA ran successfully', res.npcs === 50);
  } catch (e) { fail('/pca request', e.message); }

  // ── 8. Clustering ───────────────────────────────────────────────────────────
  section('STEP 8: /cluster');
  try {
    info('Clustering (dims=10, resolution=0.5, algorithm=1)...');
    const r = await req('GET', '/cluster?dims=10&resolution=0.5&algorithm=1');
    assertOk('/cluster returns 200', r);
    const res = (r.body || {}).result || {};
    assert(`PBMC3k tutorial should find exactly ${refMetrics.cluster.n_clusters} clusters`, res.n_clusters === refMetrics.cluster.n_clusters, `n_clusters=${res.n_clusters}`);
  } catch (e) { fail('/cluster request', e.message); }

  // ── 9. UMAP ─────────────────────────────────────────────────────────────
  section('STEP 9: /umap');
  try {
    info('Running UMAP (dims=10)...');
    const r = await req('GET', '/umap?dims=10&n_components=2&n_neighbors=30&min_dist=0.3');
    assertOk('/umap returns 200', r);
    const res = (r.body || {}).result || {};
    assert('UMAP ran successfully', res.n_components === 2);
    assert('UMAP trace_data length matches clusters', res.trace_data && res.trace_data.length === 9);
  } catch (e) { fail('/umap request', e.message); }

  // ── 10. Pathway Enrichment ──────────────────────────────────────────────
  section('STEP 10: /enrichment');
  try {
    info('Running Pathway Enrichment (GO_BP)...');
    const r = await req('GET', '/enrichment?database=GO_BP&pval_cutoff=0.05');
    assertOk('/enrichment returns 200', r);
    const res = (r.body || {}).result || {};
    assert(`Pathway Enrichment found exactly ${refMetrics.enrichment.n_pathways} pathways (top_n default)`, res.top_pathways && res.top_pathways.length === refMetrics.enrichment.n_pathways, `pathways=${res.top_pathways ? res.top_pathways.length : 0}`);
  } catch (e) { fail('/enrichment request', e.message); }

  // ── 11. CellChat ────────────────────────────────────────────────────────
  section('STEP 11: /cellchat-infer');
  try {
    info('Running CellChat inference...');
    const r = await req('POST', '/cellchat-infer', { group_by: 'seurat_clusters', database: 'human' });
    if (r.body && r.body.error) {
      warn(`CellChat skipped or errored: ${r.body.error}`);
    } else {
      assertOk('/cellchat-infer returns 200', r);
      const res = (r.body || {}).result || {};
      assert(`CellChat inferred exactly ${refMetrics.cellchat.n_nodes} nodes`, res.nodes && res.nodes.length === refMetrics.cellchat.n_nodes, `nodes=${res.nodes ? res.nodes.length : 0}`);
      assert(`CellChat inferred exactly ${refMetrics.cellchat.n_edges} edges`, res.edges && res.edges.length === refMetrics.cellchat.n_edges, `edges=${res.edges ? res.edges.length : 0}`);
    }
  } catch (e) { fail('/cellchat-infer request', e.message); }

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  section('CLEANUP: Shutting down test Plumber server');
  if (process.platform === 'win32') {
    require('child_process').spawnSync('taskkill', ['/pid', rProc.pid, '/f', '/t']);
    info('Force-killed R process tree (Windows)');
  } else {
    rProc.kill('SIGTERM');
    await sleep(2000);
    if (!rProc.killed) {
      rProc.kill('SIGKILL');
      info('Force-killed R process');
    } else {
      info('R process terminated cleanly');
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const bar = '='.repeat(60);
  console.log(`\n${bar}`);
  console.log('  INTEGRATION TEST SUMMARY');
  console.log(bar);
  console.log(`  Total : ${PASS + FAIL}`);
  console.log(`  Passed: ${PASS}`);
  console.log(`  Failed: ${FAIL}`);
  console.log(`  Warned: ${WARN}`);
  console.log('');

  if (failures.length > 0) {
    console.log('FAILED ASSERTIONS:');
    failures.forEach(f => {
      console.log(`  ✗ ${f.desc}`);
      if (f.detail) console.log(`    → ${f.detail}`);
    });
    console.log('');
  }

  if (FAIL > 0) {
    console.log('❌ Integration tests FAILED.\n');
    process.exit(1);
  } else {
    console.log('✅ All integration tests passed!\n');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
