import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';

// Pins the CURRENT R-proxy path policy so future changes are deliberate and
// visible in review. Two classes of `/api/r/*` paths:
//
//   1. Internal worker-only endpoints — blocked from the public proxy BEFORE any
//      R contact (404, no existence leak). They run ONLY through the in-process
//      worker bridge (backend/rWorkerBridge.js), never through this proxy.
//
//   2. Legacy live-R analytical endpoints — still REACHABLE behind the
//      authenticated proxy (owner-scoped via a server-verified X-Object-ID).
//      This test documents that current legacy reachability; it is NOT an
//      endorsement of these as a supported/durable product workflow. See the
//      "Hidden/disabled features vs reachable R endpoints" section of README.md.
//
// The tests assert only what is deterministic at the Express layer (no live R
// backend is required or contacted): the pure path classifier, the 404 block on
// internal-only paths, and the auth-before-block ordering. We deliberately do
// NOT issue an authenticated request to a reachable legacy endpoint here, since
// that would attempt to proxy to a (non-running) R backend.

const config = require('./config');
const db = require('./pgDatabase');
const { startServer, createUserWithToken, api, serverModule } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
const TEST_SESSION_EPOCH = '4f8c2a6e1d9b3075c4e8a2f6d1b93570';

const {
  isInternalOnlyRProxyPath,
  R_PROXY_INTERNAL_ONLY_PATHS,
  isAllowedProductionRProxyRequest,
  R_PROXY_PRODUCTION_ALLOWLIST,
} = serverModule;

// Worker-only endpoints that must be blocked from the public /api/r/* proxy.
const INTERNAL_ONLY = [
  '/object/pbmc-pipeline',
  '/object/checkpoint-load',
  '/object/deg-find-markers',
  '/object/seurat-pipeline',
  '/object/inspect',
  '/internal/worker-readiness',
];

// Legacy live-R analytical endpoints that are currently reachable (owner-scoped)
// behind the authenticated proxy. Documented current behavior, not a product API.
const LEGACY_REACHABLE = [
  '/deg',
  '/cellchat',
  '/cellchat-infer',
  '/enrichment',
  '/annotate-clusters',
];

let server;
let prevTrustedRdsLoad;
let prevNodeEnv;
let prevSessionEpoch;

function rawRRequest({ method, path, token, headers = {}, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: {
        ...(token ? {
          Cookie: `${config.sessionCookieName()}=${encodeURIComponent(token)}`,
          Origin: 'http://localhost:5173',
        } : {}),
        ...headers,
      },
    }, (res) => {
      const body = [];
      res.on('data', (chunk) => body.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(body).toString('utf8');
        resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

beforeAll(async () => {
  if (!CONFIGURED) return;
  prevTrustedRdsLoad = process.env.ALLOW_TRUSTED_RDS_LOAD;
  prevNodeEnv = process.env.NODE_ENV;
  prevSessionEpoch = process.env.SESSION_EPOCH;
  process.env.SESSION_EPOCH = TEST_SESSION_EPOCH;
  server = await startServer();
});

afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  if (prevTrustedRdsLoad === undefined) delete process.env.ALLOW_TRUSTED_RDS_LOAD;
  else process.env.ALLOW_TRUSTED_RDS_LOAD = prevTrustedRdsLoad;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  if (prevSessionEpoch === undefined) delete process.env.SESSION_EPOCH;
  else process.env.SESSION_EPOCH = prevSessionEpoch;
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  process.env.NODE_ENV = prevNodeEnv || 'test';
  process.env.SESSION_EPOCH = TEST_SESSION_EPOCH;
  await db.resetSchemaForTests();
  delete process.env.ALLOW_TRUSTED_RDS_LOAD;
});

afterEach(() => {
  // Production HTTP-policy cases model the supported TLS reverse proxy. Restore
  // the ordinary test setting so forwarded headers cannot affect later cases.
  serverModule.app.set('trust proxy', 0);
});

describe('production R proxy exact allowlist', () => {
  it('contains only reviewed method/path pairs and rejects unknown or wrong-method variants', () => {
    expect(R_PROXY_PRODUCTION_ALLOWLIST.GET.has('/normalize')).toBe(true);
    expect(R_PROXY_PRODUCTION_ALLOWLIST.POST.has('/export-preview')).toBe(true);
    expect(isAllowedProductionRProxyRequest('GET', '/normalize', { NODE_ENV: 'production' })).toBe(true);
    expect(isAllowedProductionRProxyRequest('POST', '/normalize', { NODE_ENV: 'production' })).toBe(false);
    expect(isAllowedProductionRProxyRequest('GET', '/Normalize', { NODE_ENV: 'production' })).toBe(false);
    expect(isAllowedProductionRProxyRequest('GET', '/unknown', { NODE_ENV: 'production' })).toBe(false);
    expect(isAllowedProductionRProxyRequest('GET', '%252Fnormalize', { NODE_ENV: 'production' })).toBe(false);
    for (const [method, path] of [
      ['GET', '/load-local-10x'], ['GET', '/load-h5ad'], ['POST', '/load-multi-10x'],
      ['GET', '/csv-columns'], ['GET', '/add-metadata'], ['POST', '/subset'],
      ['GET', '/integrate'],
    ]) {
      expect(isAllowedProductionRProxyRequest(method, path, { NODE_ENV: 'production' })).toBe(false);
    }
  });
});

describe('isInternalOnlyRProxyPath classifier (source of truth for the block)', () => {
  it('exposes exactly the worker-only paths', () => {
    expect([...R_PROXY_INTERNAL_ONLY_PATHS].sort()).toEqual([...INTERNAL_ONLY].sort());
  });

  it('classifies internal-only paths (and odd spellings) as blocked', () => {
    for (const p of INTERNAL_ONLY) {
      expect(isInternalOnlyRProxyPath(p)).toBe(true);
      expect(isInternalOnlyRProxyPath(`${p}/`)).toBe(true);            // trailing slash
      expect(isInternalOnlyRProxyPath(p.replace('/object/', '/object//'))).toBe(true); // doubled slash
      expect(isInternalOnlyRProxyPath(p.replace(/\//g, '\\'))).toBe(true);             // backslashes
      expect(isInternalOnlyRProxyPath(encodeURIComponent(p))).toBe(true);              // %2F-encoded
    }
  });

  it('classifies legacy live-R analytical paths as NOT blocked (reachable)', () => {
    for (const p of LEGACY_REACHABLE) {
      expect(isInternalOnlyRProxyPath(p)).toBe(false);
    }
  });
});

describe.skipIf(!CONFIGURED)('R proxy HTTP policy', () => {
  it('blocks internal worker-only endpoints with a no-leak 404 for an authenticated user', async () => {
    const { token } = await createUserWithToken({ email: 'owner@example.com' });
    for (const p of INTERNAL_ONLY) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const res = await api(server, `/api/r${p}`, { method, token });
        expect(res.status).toBe(404);
        expect(res.data).toEqual({ error: 'Not found' });
      }
      // Odd spelling (trailing slash) is blocked the same way.
      const res = await api(server, `/api/r${p}/`, { method: 'POST', token });
      expect(res.status).toBe(404);
    }
  });

  it('requires auth before the internal-only block (unauthenticated is 401, not 404)', async () => {
    for (const p of INTERNAL_ONLY) {
      const res = await api(server, `/api/r${p}`, { method: 'POST' });
      expect(res.status).toBe(401);
    }
  });

  it('gates legacy live-R endpoints behind auth (unauthenticated is 401)', async () => {
    // Documents that the ONLY gate on these legacy endpoints is authentication —
    // there is no path-level block. We assert the auth boundary rather than
    // proxying to a live R backend.
    for (const p of LEGACY_REACHABLE) {
      const res = await api(server, `/api/r${p}`, { method: 'GET' });
      expect(res.status).toBe(401);
    }
  });

  it('blocks legacy heavy routes, unknown paths, and wrong methods in production', async () => {
    process.env.NODE_ENV = 'production';
    serverModule.app.set('trust proxy', 1);
    const { token } = await createUserWithToken({ email: 'production-policy@example.com' });
    for (const [method, path] of [
      ['GET', '/deg'], ['POST', '/cellchat'], ['GET', '/unknown-route'],
      ['POST', '/normalize'], ['GET', '/Normalize'],
      ['GET', '/load-local-10x'], ['GET', '/load-h5ad'], ['POST', '/load-multi-10x'],
      ['GET', '/csv-columns'], ['GET', '/add-metadata'], ['POST', '/subset'],
      ['GET', '/integrate'],
    ]) {
      const res = await api(server, `/api/r${path}`, {
        method,
        token,
        headers: { 'X-Forwarded-Proto': 'https' },
      });
      expect(res.status).toBe(404);
      expect(res.data).toEqual({ error: 'Not found' });
    }
  });

  it('rejects body-bearing GET, non-JSON POST, malformed JSON, and oversized chunked JSON before R contact', async () => {
    const { token } = await createUserWithToken({ email: 'r-request-shape@example.com' });
    const getWithBody = await rawRRequest({
      method: 'GET', path: '/api/r/health', token,
      headers: { 'Content-Length': '1' }, chunks: ['x'],
    });
    expect(getWithBody.status).toBe(400);

    const textPost = await rawRRequest({
      method: 'POST', path: '/api/r/qc', token,
      headers: { 'Content-Type': 'text/plain' }, chunks: ['{}'],
    });
    expect(textPost.status).toBe(415);

    const malformed = await rawRRequest({
      method: 'POST', path: '/api/r/qc', token,
      headers: { 'Content-Type': 'application/json' }, chunks: ['{"broken":'],
    });
    expect(malformed.status).toBe(400);
    expect(malformed.data).toEqual({ error: 'R request body must be valid JSON.' });

    const oversized = await rawRRequest({
      method: 'POST', path: '/api/r/qc', token,
      headers: { 'Content-Type': 'application/json' },
      chunks: ['{"value":"', 'a'.repeat(256 * 1024 + 1), '"}'],
    });
    expect(oversized.status).toBe(413);
    expect(oversized.data).toEqual({ error: 'R request body exceeded the configured size limit.' });
  });

  it('never enables public RDS deserialization in production', async () => {
    process.env.NODE_ENV = 'production';
    serverModule.app.set('trust proxy', 1);
    process.env.ALLOW_TRUSTED_RDS_LOAD = 'true';
    const { token } = await createUserWithToken({ email: 'production-rds@example.com' });
    for (const path of ['/load-rds', '/restore-session']) {
      const res = await api(server, `/api/r${path}`, {
        method: 'POST',
        token,
        headers: { 'X-Forwarded-Proto': 'https' },
        body: { path: 'vault/ignored.rds' },
      });
      expect(res.status).toBe(404);
      expect(res.data).toEqual({ error: 'Not found' });
    }
  });

  it('requires an allowed origin for every cookie-authenticated R method', async () => {
    const { token } = await createUserWithToken({ email: 'r-csrf@example.com' });
    const cookie = `${config.sessionCookieName()}=${encodeURIComponent(token)}`;
    const missing = await api(server, '/api/r/object/inspect', {
      method: 'GET', headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(403);
    expect(missing.data.error).toMatch(/CSRF/i);

    const crossSite = await api(server, '/api/r/object/inspect', {
      method: 'GET', headers: { Cookie: cookie, Origin: 'https://evil.example' },
    });
    expect(crossSite.status).toBe(403);

    const badHeader = await api(server, '/api/r/object/inspect', {
      method: 'GET', headers: { Cookie: cookie, 'X-BenchOne-CSRF': '0' },
    });
    expect(badHeader.status).toBe(403);

    const firstPartyHeader = await api(server, '/api/r/object/inspect', {
      method: 'GET', headers: { Cookie: cookie, 'X-BenchOne-CSRF': '1' },
    });
    expect(firstPartyHeader.status).toBe(404);

    const allowed = await api(server, '/api/r/object/inspect', {
      method: 'GET', headers: { Cookie: cookie, Origin: config.allowedOrigins()[0] },
    });
    expect(allowed.status).toBe(404);
    const cookieHelper = await api(server, '/api/r/object/inspect', { method: 'GET', token });
    expect(cookieHelper.status).toBe(404);
  });

  it('blocks public RDS loading by default before any R contact', async () => {
    const { user, token } = await createUserWithToken({ email: 'owner@example.com' });
    const res = await api(server, '/api/r/load-rds', {
      method: 'POST',
      token,
      body: { path: `vault/${serverModule.sanitizeVaultSegment(user.email)}/trusted-local.rds` }
    });
    expect(res.status).toBe(403);
    expect(res.data.error).toMatch(/RDS loading is disabled/i);
  });

  it('blocks legacy session restore by the same default RDS trust gate', async () => {
    const { user, token } = await createUserWithToken({ email: 'restore-owner@example.com' });
    const res = await api(server, '/api/r/restore-session', {
      method: 'POST',
      token,
      body: { path: `vault/${serverModule.sanitizeVaultSegment(user.email)}/uploaded.rds` },
    });
    expect(res.status).toBe(403);
    expect(res.data.error).toMatch(/RDS loading is disabled/i);
  });

  it('does not reveal path-validation details when RDS loading is disabled', async () => {
    const { token } = await createUserWithToken({ email: 'owner@example.com' });
    const res = await api(server, '/api/r/load-rds', {
      method: 'POST',
      token,
      body: { path: '../outside.rds' }
    });
    expect(res.status).toBe(403);
    expect(res.data.error).toMatch(/RDS loading is disabled/i);
  });

  it('does not reveal restore path details while the RDS trust gate is closed', async () => {
    const { token } = await createUserWithToken({ email: 'restore-owner@example.com' });
    const res = await api(server, '/api/r/restore-session', {
      method: 'POST',
      token,
      body: { path: '../outside.rds' },
    });
    expect(res.status).toBe(403);
    expect(res.data.error).toMatch(/RDS loading is disabled/i);
  });

  it('requires auth before the RDS trust gate', async () => {
    const res = await api(server, '/api/r/load-rds', {
      method: 'POST',
      body: { path: 'vault/owner_example_com/trusted-local.rds' }
    });
    expect(res.status).toBe(401);
  });
});
