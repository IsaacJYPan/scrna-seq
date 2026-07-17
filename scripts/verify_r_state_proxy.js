#!/usr/bin/env node
'use strict';

// Live integration check for per-user / per-object R session isolation.
//
// This drives a real Express server + real R Plumber backend and proves that
// object-specific R sessions ONLY work for database-backed analysis objects
// owned by the authenticated user. Object ids are no longer arbitrary client
// strings: each X-Object-ID used below is first created through the
// authenticated POST /api/analysis-objects route, and the server issues the id.
//
// It additionally proves that malformed, unknown, and cross-user object ids are
// rejected by Express *before* the request can reach R. (The same ownership
// rejection logic is unit-covered, without R, in backend/r-proxy-ownership.test.js.)

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../backend/config');

const WORKSPACE = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 18121);
const PLUMBER_PORT = Number(process.env.PLUMBER_TEST_PORT || 18122);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_EMAIL = `r-state-${Date.now()}@example.com`;
const OTHER_EMAIL = `r-state-other-${Date.now()}@example.com`;
const TEST_PASSWORD = 'RStateProxy123!';
const MALICIOUS_OBJECT_ID = 'user-999:obj-objectA/../../<script>';
const UNKNOWN_OBJECT_ID = 'ao_deadbeefdeadbeef';

let passCount = 0;

function sanitizeVaultSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '_');
}

function sanitizeObjectIdSegment(value) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return cleaned.replace(/^[._-]+/, '');
}

// Mirror of server.js deriveRStateKey for the verified-id case.
function expectedKey(userId, clientObjectId) {
  const base = `user-${userId}`;
  const segment = sanitizeObjectIdSegment(clientObjectId);
  return segment ? `${base}:obj-${segment}` : base;
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function assert(condition, message, detail = '') {
  if (!condition) {
    throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
  }
  passCount += 1;
  console.log(`PASS ${message}`);
}

function request(method, requestPath, { token, objectId, body } = {}) {
  return new Promise((resolve, reject) => {
    const bodyText = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      ...(bodyText ? { 'Content-Length': Buffer.byteLength(bodyText) } : {}),
      ...(token ? {
        Cookie: `${config.sessionCookieName()}=${encodeURIComponent(token)}`,
        Origin: BASE_URL,
      } : {}),
      ...(objectId ? { 'X-Object-ID': objectId } : {}),
    };

    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: requestPath,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

async function retry(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastError = err;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function stopProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function createTinyRdsFixtures(objectAPath, objectBPath) {
  fs.mkdirSync(path.dirname(objectAPath), { recursive: true });

  const script = `
suppressPackageStartupMessages({
  library(Seurat)
  library(Matrix)
})

make_obj <- function(output_path, project, n_cells, n_genes) {
  set.seed(n_cells + n_genes)
  mat <- matrix(rpois(n_cells * n_genes, lambda = 5), nrow = n_genes, ncol = n_cells)
  rownames(mat) <- c(paste0("MT-G", seq_len(2)), paste0(project, "-Gene", seq_len(n_genes - 2)))
  colnames(mat) <- paste0(project, "-Cell", seq_len(n_cells))
  obj <- CreateSeuratObject(counts = as(mat, "dgCMatrix"), project = project, min.cells = 0, min.features = 0)
  obj[["source_label"]] <- project
  saveRDS(obj, output_path)
}

make_obj("${toPosix(objectAPath)}", "ObjectA", 12, 30)
make_obj("${toPosix(objectBPath)}", "ObjectB", 16, 34)
`;

  const tmpScript = path.join(os.tmpdir(), `make-r-state-fixtures-${Date.now()}.R`);
  fs.writeFileSync(tmpScript, script);
  const result = spawnSync('Rscript', [tmpScript], { cwd: WORKSPACE, encoding: 'utf8' });
  fs.rmSync(tmpScript, { force: true });
  if (result.status !== 0) {
    throw new Error(`Failed to create RDS fixtures\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
}

function resultPayload(body) {
  return body && body.result ? body.result : body;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'object') return Object.values(value);
  return [];
}

async function signup(email) {
  const res = await retry(async () => {
    const response = await request('POST', '/api/auth/signup', {
      body: { email, password: TEST_PASSWORD, displayName: 'R State Proxy Test' },
    });
    if (response.status === 201) return response;
    return false;
  }, 60000);
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const encoded = String(setCookie || '').split(';')[0].split('=').slice(1).join('=');
  return { token: decodeURIComponent(encoded), userId: res.body.user.id };
}

async function createAnalysisObject(token) {
  const res = await request('POST', '/api/analysis-objects', { token, body: { objectType: 'seurat' } });
  if (res.status !== 201) throw new Error(`create analysis object failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

async function main() {
  const safeEmail = sanitizeVaultSegment(TEST_EMAIL);
  const fixtureDir = path.join(WORKSPACE, 'vault', safeEmail, 'state-proxy-smoke');
  const objectAPath = path.join(fixtureDir, 'objectA.rds');
  const objectBPath = path.join(fixtureDir, 'objectB.rds');
  const sessionPath = path.join(fixtureDir, 'objectA-session.rds');
  createTinyRdsFixtures(objectAPath, objectBPath);

  const relObjectA = toPosix(path.relative(WORKSPACE, objectAPath));
  const relObjectB = toPosix(path.relative(WORKSPACE, objectBPath));
  const relSession = toPosix(path.relative(WORKSPACE, sessionPath));

  const server = spawn('node', ['server.js'], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      PORT: String(PORT),
      PLUMBER_PORT: String(PLUMBER_PORT),
      ENABLE_R_TEST_DIAGNOSTICS: 'true',
      ALLOW_TRUSTED_RDS_LOAD: 'true',
      NODE_ENV: 'test',
      SESSION_SECRET: 'r-state-proxy-test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  server.stderr.on('data', chunk => { serverOutput += chunk.toString(); });

  try {
    const { token, userId } = await signup(TEST_EMAIL);
    assert(Boolean(token), 'created authenticated test user');
    assert(Number.isInteger(userId), 'test user has numeric id', String(userId));

    // A second user, used to prove cross-user object ids are rejected.
    const other = await signup(OTHER_EMAIL);
    const otherObjectId = await createAnalysisObject(other.token);

    // Object ids are created through the authenticated API and issued by the
    // server. These DB-backed ids are what we use as X-Object-ID below.
    const objectA = await createAnalysisObject(token);
    const objectB = await createAnalysisObject(token);
    const objectC = await createAnalysisObject(token);
    assert(/^ao_[0-9a-f]+$/.test(objectA), 'server issued DB-backed object id A', objectA);
    assert(objectA !== objectB && objectB !== objectC, 'distinct DB-backed object ids', `${objectA},${objectB},${objectC}`);

    const unauth = await request('GET', '/api/r/health');
    assert(unauth.status === 401 || unauth.status === 403, 'unauthenticated /api/r request is rejected', `HTTP ${unauth.status}`);

    await retry(async () => {
      const health = await request('GET', '/api/r/health', { token });
      return health.status === 200 ? health : false;
    }, 60000);
    console.log(`INFO Express ${BASE_URL} -> Plumber ${PLUMBER_PORT} is healthy`);

    // ── Ownership rejection: these never reach R ──────────────────────────
    const malicious = await request('GET', '/api/r/__test/session-state', { token, objectId: MALICIOUS_OBJECT_ID });
    assert(malicious.status === 400, 'malformed object id is rejected before reaching R', `HTTP ${malicious.status}`);

    const unknown = await request('GET', '/api/r/__test/session-state', { token, objectId: UNKNOWN_OBJECT_ID });
    assert(unknown.status === 404, 'unknown (non-DB) object id is rejected before reaching R', `HTTP ${unknown.status}`);

    const crossUser = await request('GET', '/api/r/__test/session-state', { token, objectId: otherObjectId });
    assert(crossUser.status === 404, 'another user object id is rejected before reaching R', `HTTP ${crossUser.status}`);

    // ── No X-Object-ID: legacy user-scoped key ────────────────────────────
    const noObject = await request('GET', '/api/r/__test/session-state', { token });
    assert(noObject.status === 200, 'authenticated diagnostic request without object id reaches R', `HTTP ${noObject.status}`);
    assert(noObject.body.x_object_id === expectedKey(userId), 'no X-Object-ID maps to user-scoped key', noObject.body.x_object_id);

    // ── Per-object isolation across two DB-backed objects ─────────────────
    const loadA = await request('POST', '/api/r/load-rds', { token, objectId: objectA, body: { path: relObjectA } });
    assert(loadA.status === 200 && !loadA.body.error, 'objectA loads through authenticated proxy', JSON.stringify(loadA.body));
    const infoA = resultPayload((await request('GET', '/api/r/object-info', { token, objectId: objectA })).body);
    assert(infoA.n_cells === 12, 'objectA inspect reports 12 cells', JSON.stringify(infoA));
    const qcA = await request('GET', '/api/r/qc-distributions', { token, objectId: objectA });
    assert(qcA.status === 200 && qcA.body.n_cells === 12, 'objectA QC distributions report 12 cells', JSON.stringify(qcA.body));

    const normA = await request('GET', '/api/r/normalize?nfeatures=10', { token, objectId: objectA });
    assert(normA.status === 200 && !normA.body.error, 'objectA normalization succeeds', JSON.stringify(normA.body));
    const pcaA = await request('GET', '/api/r/pca?npcs=5&seed=123', { token, objectId: objectA });
    assert(pcaA.status === 200 && !pcaA.body.error, 'objectA PCA succeeds', JSON.stringify(pcaA.body));

    const beforeB = await request('GET', '/api/r/__test/session-state', { token, objectId: objectB });
    assert(beforeB.body.x_object_id === expectedKey(userId, objectB), 'objectB maps to distinct user/object key', beforeB.body.x_object_id);
    assert(beforeB.body.has_global_obj === false, 'objectB starts with no R object before load');

    const loadB = await request('POST', '/api/r/load-rds', { token, objectId: objectB, body: { path: relObjectB } });
    assert(loadB.status === 200 && !loadB.body.error, 'objectB loads through authenticated proxy', JSON.stringify(loadB.body));
    const infoB = resultPayload((await request('GET', '/api/r/object-info', { token, objectId: objectB })).body);
    assert(infoB.n_cells === 16, 'objectB inspect reports 16 cells', JSON.stringify(infoB));
    const normB = await request('GET', '/api/r/normalize?nfeatures=10', { token, objectId: objectB });
    assert(normB.status === 200 && !normB.body.error, 'objectB normalization succeeds', JSON.stringify(normB.body));

    const stateB = await request('GET', '/api/r/__test/session-state', { token, objectId: objectB });
    const reductionsB = asArray(stateB.body.reductions);
    assert(stateB.body.has_global_obj === true && stateB.body.n_cells === 16, 'objectB retains its own loaded state', JSON.stringify(stateB.body));
    assert(!reductionsB.includes('pca'), 'objectB does not inherit objectA PCA state', JSON.stringify(stateB.body.reductions));

    const stateA = await request('GET', '/api/r/__test/session-state', { token, objectId: objectA });
    const reductionsA = asArray(stateA.body.reductions);
    assert(stateA.body.has_global_obj === true && stateA.body.n_cells === 12, 'objectA still has its own loaded state after objectB operations', JSON.stringify(stateA.body));
    assert(reductionsA.includes('pca'), 'objectA keeps PCA state after objectB operations', JSON.stringify(stateA.body.reductions));

    const saveA = await request('POST', '/api/r/save-session', { token, objectId: objectA, body: { path: relSession } });
    assert(saveA.status === 200 && saveA.body.success === true, 'objectA save-session succeeds', JSON.stringify(saveA.body));
    const restoreC = await request('POST', '/api/r/restore-session', { token, objectId: objectC, body: { path: relSession } });
    assert(restoreC.status === 200 && restoreC.body.success === true, 'objectC restore-session from objectA succeeds', JSON.stringify(restoreC.body));
    const stateC = await request('GET', '/api/r/__test/session-state', { token, objectId: objectC });
    assert(stateC.body.n_cells === 12 && asArray(stateC.body.reductions).includes('pca'), 'restored objectC has objectA cells and PCA state', JSON.stringify(stateC.body));

    const defaultLoad = await request('POST', '/api/r/load-rds', { token, body: { path: relObjectA } });
    assert(defaultLoad.status === 200 && !defaultLoad.body.error, 'single-object behavior without X-Object-ID still loads', JSON.stringify(defaultLoad.body));
    const defaultState = await request('GET', '/api/r/__test/session-state', { token });
    assert(defaultState.body.x_object_id === expectedKey(userId), 'single-object behavior uses base user key', defaultState.body.x_object_id);
    assert(defaultState.body.n_cells === 12, 'single-object behavior keeps its own base-key state', JSON.stringify(defaultState.body));

    console.log(`SUMMARY passed=${passCount} userId=${userId} objectAKey=${expectedKey(userId, objectA)} objectBKey=${expectedKey(userId, objectB)}`);
  } catch (err) {
    console.error('\nVERIFY_R_STATE_PROXY_FAILED');
    console.error(err.stack || err.message);
    console.error('\nSERVER_OUTPUT');
    console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    stopProcessTree(server);
  }
}

main().then(() => {
  process.exit(process.exitCode || 0);
});
