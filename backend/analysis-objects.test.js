import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const { initDatabase, closeDatabase, saveProvenance } = require('./database');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

let server;

beforeAll(async () => { server = await startServer(); });
afterAll(() => { if (server) server.close(); });

beforeEach(() => { initDatabase(':memory:'); });
afterEach(() => { closeDatabase(); });

function users() {
  const alice = createUserWithToken({ email: 'alice@example.com', displayName: 'Alice' });
  const bob = createUserWithToken({ email: 'bob@example.com', displayName: 'Bob' });
  return { alice, bob };
}

function makeProvenance(id) {
  return {
    id,
    timestamp: new Date().toISOString(),
    language: 'R',
    languageVersion: '4.4.0',
    packages: ['Seurat'],
    operation: 'load',
    parameters: {},
    script: 'obj <- CreateSeuratObject(counts)',
    parentIds: []
  };
}

describe('analysis-objects API', () => {
  it('requires auth on every route', async () => {
    expect((await api(server, '/api/analysis-objects')).status).toBe(401);
    expect((await api(server, '/api/analysis-objects', { method: 'POST', body: { objectType: 'seurat' } })).status).toBe(401);
    expect((await api(server, '/api/analysis-objects/ao_whatever')).status).toBe(401);
  });

  it('lets a user create an object with a server-assigned id', async () => {
    const { alice } = users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', displayName: 'QC filtered object' }
    });
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^ao_[0-9a-f]+$/);
    expect(res.data.ownerUserId).toBe(alice.user.id);
    expect(res.data.objectType).toBe('seurat');
    expect(res.data.displayName).toBe('QC filtered object');
  });

  it('rejects a client-provided object id', async () => {
    const { alice } = users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { id: 'ao_client_chosen', objectType: 'seurat' }
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/server-assigned/i);
  });

  it('rejects body-provided owner/user fields', async () => {
    const { alice, bob } = users();
    for (const field of ['userId', 'user_id', 'ownerUserId', 'owner_user_id']) {
      const res = await api(server, '/api/analysis-objects', {
        method: 'POST', token: alice.token,
        body: { objectType: 'seurat', [field]: bob.user.id }
      });
      expect(res.status, `field ${field}`).toBe(400);
    }
  });

  it('rejects an invalid object type', async () => {
    const { alice } = users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'not-a-real-type' }
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/objectType/i);
  });

  it('rejects invalid metadata (array, null, scalar)', async () => {
    const { alice } = users();
    for (const metadata of [[], null, 'string', 42]) {
      const res = await api(server, '/api/analysis-objects', {
        method: 'POST', token: alice.token,
        body: { objectType: 'seurat', metadata }
      });
      expect(res.status, `metadata=${JSON.stringify(metadata)}`).toBe(400);
    }
  });

  it('lists only the authenticated user objects', async () => {
    const { alice, bob } = users();
    await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'matrix' } });
    await api(server, '/api/analysis-objects', { method: 'POST', token: bob.token, body: { objectType: 'seurat' } });

    const aliceList = await api(server, '/api/analysis-objects', { token: alice.token });
    const bobList = await api(server, '/api/analysis-objects', { token: bob.token });

    expect(aliceList.data).toHaveLength(2);
    expect(aliceList.data.every(o => o.ownerUserId === alice.user.id)).toBe(true);
    expect(bobList.data).toHaveLength(1);
    expect(bobList.data.every(o => o.ownerUserId === bob.user.id)).toBe(true);
  });

  it('supports objectType filtering scoped to the user', async () => {
    const { alice } = users();
    await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'matrix' } });

    const filtered = await api(server, '/api/analysis-objects?objectType=matrix', { token: alice.token });
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].objectType).toBe('matrix');
  });

  it('lets a user read their own object but not another user object', async () => {
    const { alice, bob } = users();
    const created = await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    const id = created.data.id;

    const own = await api(server, `/api/analysis-objects/${id}`, { token: alice.token });
    expect(own.status).toBe(200);
    expect(own.data.id).toBe(id);

    const other = await api(server, `/api/analysis-objects/${id}`, { token: bob.token });
    expect(other.status).toBe(404);
  });

  it('sets lineage_root_id to the object own id for a root object', async () => {
    const { alice } = users();
    const created = await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    expect(created.data.lineageRootId).toBe(created.data.id);
    expect(created.data.parentObjectId).toBeNull();
  });

  it('inherits lineage root when creating a child of an owned parent', async () => {
    const { alice } = users();
    const root = await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    const child = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', parentObjectId: root.data.id }
    });
    const grandchild = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', parentObjectId: child.data.id }
    });

    expect(child.status).toBe(201);
    expect(child.data.parentObjectId).toBe(root.data.id);
    expect(child.data.lineageRootId).toBe(root.data.id);
    // Grandchild keeps the same lineage root as the whole chain.
    expect(grandchild.data.lineageRootId).toBe(root.data.id);
  });

  it('rejects a child whose parent belongs to another user', async () => {
    const { alice, bob } = users();
    const bobObj = await api(server, '/api/analysis-objects', { method: 'POST', token: bob.token, body: { objectType: 'seurat' } });

    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', parentObjectId: bobObj.data.id }
    });
    expect(res.status).toBe(404);
  });

  it('rejects a child with an unknown parent id', async () => {
    const { alice } = users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', parentObjectId: 'ao_does_not_exist' }
    });
    expect(res.status).toBe(404);
  });

  it('links a provenance record the user owns and rejects another user provenance', async () => {
    const { alice, bob } = users();
    saveProvenance({ userEmail: alice.user.email, provenance: makeProvenance('prov-alice') });
    saveProvenance({ userEmail: bob.user.email, provenance: makeProvenance('prov-bob') });

    const ok = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', createdByProvenanceId: 'prov-alice' }
    });
    expect(ok.status).toBe(201);
    expect(ok.data.createdByProvenanceId).toBe('prov-alice');

    const stolen = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', createdByProvenanceId: 'prov-bob' }
    });
    expect(stolen.status).toBe(404);
  });

  it('accepts datasetId as an opaque nullable tag (no datasets model yet)', async () => {
    const { alice } = users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', datasetId: 'dataset-abc' }
    });
    expect(res.status).toBe(201);
    expect(res.data.datasetId).toBe('dataset-abc');
  });

  // ── Finding 9: datasetId caveat ───────────────────────────────────────────
  // There is intentionally NO datasets table in this branch, so datasetId is an
  // unverified opaque string. This test pins the CURRENT behavior: two users
  // may carry the SAME datasetId, and datasetId-filtered listing is still
  // owner-scoped (Alice never sees Bob's object even though the tag matches).
  //
  // TODO(datasets-model): once a durable datasets table exists, datasetId MUST
  // be ownership-verified at creation/use the way parentObjectId and
  // createdByProvenanceId already are — a cross-owner datasetId must return 404
  // (no enumeration), not be silently accepted. When that lands, add a test
  // asserting Alice cannot create/list against Bob's datasetId, and tighten or
  // replace this test. See docs/architecture.md ("dataset_id ... opaque
  // nullable tag until a durable datasets/projects model lands").
  it('does not leak objects across users that share the same opaque datasetId', async () => {
    const { alice, bob } = users();
    const shared = 'dataset-shared-tag';

    await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token, body: { objectType: 'seurat', datasetId: shared }
    });
    await api(server, '/api/analysis-objects', {
      method: 'POST', token: bob.token, body: { objectType: 'matrix', datasetId: shared }
    });

    const aliceByDataset = await api(server, `/api/analysis-objects?datasetId=${shared}`, { token: alice.token });
    expect(aliceByDataset.data).toHaveLength(1);
    expect(aliceByDataset.data[0].ownerUserId).toBe(alice.user.id);
    expect(aliceByDataset.data[0].objectType).toBe('seurat');

    const bobByDataset = await api(server, `/api/analysis-objects?datasetId=${shared}`, { token: bob.token });
    expect(bobByDataset.data).toHaveLength(1);
    expect(bobByDataset.data[0].ownerUserId).toBe(bob.user.id);
  });
});
