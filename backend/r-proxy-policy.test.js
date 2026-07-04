import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

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

const { initDatabase, closeDatabase } = require('./database');
const { startServer, createUserWithToken, api, serverModule } = require('./_http-test-utils');

const { isInternalOnlyRProxyPath, R_PROXY_INTERNAL_ONLY_PATHS } = serverModule;

// Worker-only endpoints that must be blocked from the public /api/r/* proxy.
const INTERNAL_ONLY = [
  '/object/pbmc-pipeline',
  '/object/checkpoint-load',
  '/object/deg-find-markers',
  '/object/seurat-pipeline',
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

beforeAll(async () => {
  prevTrustedRdsLoad = process.env.ALLOW_TRUSTED_RDS_LOAD;
  server = await startServer();
});

afterAll(() => {
  if (server) server.close();
  if (prevTrustedRdsLoad === undefined) delete process.env.ALLOW_TRUSTED_RDS_LOAD;
  else process.env.ALLOW_TRUSTED_RDS_LOAD = prevTrustedRdsLoad;
});

beforeEach(() => {
  initDatabase(':memory:');
  delete process.env.ALLOW_TRUSTED_RDS_LOAD;
});
afterEach(() => { closeDatabase(); });

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

describe('R proxy HTTP policy', () => {
  it('blocks internal worker-only endpoints with a no-leak 404 for an authenticated user', async () => {
    const { token } = createUserWithToken({ email: 'owner@example.com' });
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

  it('blocks public RDS loading by default before any R contact', async () => {
    const { user, token } = createUserWithToken({ email: 'owner@example.com' });
    const res = await api(server, '/api/r/load-rds', {
      method: 'POST',
      token,
      body: { path: `vault/${serverModule.sanitizeVaultSegment(user.email)}/trusted-local.rds` }
    });
    expect(res.status).toBe(403);
    expect(res.data.error).toMatch(/RDS loading is disabled/i);
  });

  it('does not reveal path-validation details when RDS loading is disabled', async () => {
    const { token } = createUserWithToken({ email: 'owner@example.com' });
    const res = await api(server, '/api/r/load-rds', {
      method: 'POST',
      token,
      body: { path: '../outside.rds' }
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
