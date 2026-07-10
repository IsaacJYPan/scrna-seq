/**
 * HTTP-level auth & authorization tests.
 *
 * Unlike backend/security.test.js (which calls the DB layer directly), these
 * tests drive real Express routes over a real socket. They prove that:
 *   1. Protected routes reject missing/invalid auth (401).
 *   2. Routes actually pass req.user.email into the DB layer, so user A cannot
 *      read/delete/overwrite user B's provenance, cache, or figures.
 *
 * A route that forgets to scope a DB call by req.user.email would let these
 * cross-user assertions leak and the test would fail — that is the point.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import serverModule from '../server.js';

const config = require('./config');
const db = require('./pgDatabase');
const { app } = serverModule;

const CONFIGURED = config.hasPostgresConnection();

let server;
let baseUrl;

function url(path) {
  return `${baseUrl}${path}`;
}

async function http(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function signup(email) {
  const res = await http('POST', '/api/auth/signup', {
    body: { email, password: 'password123', displayName: email.split('@')[0] }
  });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

function provenanceEnvelope(id) {
  return {
    provenance: {
      id,
      timestamp: new Date().toISOString(),
      language: 'R',
      languageVersion: '4.4.0',
      packages: ['Seurat'],
      operation: 'load',
      parameters: {},
      script: 'obj <- CreateSeuratObject(counts)',
      parentIds: []
    }
  };
}

beforeAll(async () => {
  if (!CONFIGURED) return;
  // Start from a clean Postgres schema so all routes hit a known-empty DB.
  // server.js holds the database module (not a handle), so routes share this
  // same pgDatabase singleton/pool.
  await db.resetSchemaForTests();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (!CONFIGURED) return;
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

describe.skipIf(!CONFIGURED)('HTTP auth: protected routes reject unauthenticated access', () => {
  const protectedRoutes = [
    ['GET', '/api/db/provenance'],
    ['POST', '/api/db/provenance'],
    ['GET', '/api/db/provenance/some-id'],
    ['GET', '/api/db/provenance-chain/some-id'],
    ['DELETE', '/api/db/provenance/some-id'],
    ['GET', '/api/db/figures'],
    ['POST', '/api/db/figures'],
    ['DELETE', '/api/db/figures/some-id'],
    ['POST', '/api/db/cache-key'],
    ['GET', '/api/db/cache/some-key'],
    ['POST', '/api/db/cache/some-key'],
    ['DELETE', '/api/db/cache'],
    ['POST', '/api/upload'],
    ['POST', '/api/upload-directory'],
    ['GET', '/api/r/health'] // R proxy: requireAuth runs before the proxy, so no live R needed
  ];

  it.each(protectedRoutes)('rejects %s %s without a token', async (method, path) => {
    const res = await http(method, path, { body: method === 'GET' ? undefined : {} });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed/invalid token', async () => {
    const res = await http('GET', '/api/db/provenance', { token: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!CONFIGURED)('HTTP authorization: two-user route isolation', () => {
  let tokenA;
  let tokenB;

  beforeAll(async () => {
    tokenA = await signup('alice-http@example.com');
    tokenB = await signup('bob-http@example.com');

    // Each user creates a provenance record through the real HTTP route.
    expect((await http('POST', '/api/db/provenance', { token: tokenA, body: provenanceEnvelope('prov-a') })).status).toBe(200);
    expect((await http('POST', '/api/db/provenance', { token: tokenB, body: provenanceEnvelope('prov-b') })).status).toBe(200);
  });

  it('lists only the caller’s own provenance (fails if route drops req.user.email)', async () => {
    const res = await http('GET', '/api/db/provenance', { token: tokenA });
    expect(res.status).toBe(200);
    const ids = res.body.map((p) => p.id);
    expect(ids).toContain('prov-a');
    expect(ids).not.toContain('prov-b');
  });

  it('cannot read another user’s provenance by direct id', async () => {
    const res = await http('GET', '/api/db/provenance/prov-b', { token: tokenA });
    // Scoped read returns null for a record the caller does not own.
    expect(res.body).toBeNull();
  });

  it('cannot delete another user’s provenance by direct id', async () => {
    const del = await http('DELETE', '/api/db/provenance/prov-b', { token: tokenA });
    expect(del.body).toEqual({ success: false });
    // Bob can still read his own record afterwards.
    const owner = await http('GET', '/api/db/provenance/prov-b', { token: tokenB });
    expect(owner.body?.id).toBe('prov-b');
  });

  it('can read and delete its own provenance', async () => {
    await http('POST', '/api/db/provenance', { token: tokenA, body: provenanceEnvelope('prov-a-own') });
    const read = await http('GET', '/api/db/provenance/prov-a-own', { token: tokenA });
    expect(read.body?.id).toBe('prov-a-own');
    const del = await http('DELETE', '/api/db/provenance/prov-a-own', { token: tokenA });
    expect(del.body).toEqual({ success: true });
  });

  it('cannot read another user’s cache by direct key', async () => {
    // Alice creates a cache entry tied to her own provenance.
    const keyRes = await http('POST', '/api/db/cache-key', {
      token: tokenA,
      body: { operation: 'umap', params: { dims: 10 }, dataVersion: 1, parentIds: [] }
    });
    const key = keyRes.body.key;
    expect((await http('POST', `/api/db/cache/${key}`, {
      token: tokenA,
      body: { provenanceId: 'prov-a', resultData: { points: [1, 2, 3] } }
    })).status).toBe(200);

    // Alice reads it back; Bob cannot.
    const aliceRead = await http('GET', `/api/db/cache/${key}`, { token: tokenA });
    expect(aliceRead.body?.result).toEqual({ points: [1, 2, 3] });
    const bobRead = await http('GET', `/api/db/cache/${key}`, { token: tokenB });
    expect(bobRead.body).toBeNull();
  });

  it('cannot cache a result against another user’s provenance', async () => {
    // Alice tries to attach a cache entry to Bob's provenance id.
    const keyRes = await http('POST', '/api/db/cache-key', {
      token: tokenA,
      body: { operation: 'pca', params: {}, dataVersion: 1, parentIds: [] }
    });
    const res = await http('POST', `/api/db/cache/${keyRes.body.key}`, {
      token: tokenA,
      body: { provenanceId: 'prov-b', resultData: {} }
    });
    expect(res.status).toBe(403);
  });

  it('cannot delete or overwrite another user’s figure', async () => {
    // Alice saves a figure.
    expect((await http('POST', '/api/db/figures', {
      token: tokenA,
      body: { id: 'fig-http', plotType: 'UMAP', title: 'Alice', params: {}, filePath: 'vault/a/fig.png' }
    })).status).toBe(200);

    // Bob cannot delete it.
    const del = await http('DELETE', '/api/db/figures/fig-http', { token: tokenB });
    expect(del.body).toEqual({ success: false });

    // Bob cannot overwrite it (saveFigure throws -> 500).
    const overwrite = await http('POST', '/api/db/figures', {
      token: tokenB,
      body: { id: 'fig-http', plotType: 'FeaturePlot', title: 'Bob', params: {}, filePath: 'vault/b/fig.png' }
    });
    expect(overwrite.status).toBe(500);

    // Alice still owns it and can list it.
    const figs = await http('GET', '/api/db/figures', { token: tokenA });
    expect(figs.body.map((f) => f.id)).toContain('fig-http');
  });
});
