import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const {
  saveProvenance,
  createOrganizationForUser, createProjectForUser, createDatasetForProject
} = db;
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();

// Create a project owned by `userId` plus a dataset in it.
async function makeDataset(userId, fileType = 'seurat_rds') {
  const org = await createOrganizationForUser(userId, { name: 'Org' });
  const project = await createProjectForUser(userId, { organizationId: org.id, name: 'Proj' });
  const dataset = await createDatasetForProject(userId, project.id, { fileType });
  return { dataset, project };
}

let server;

beforeAll(async () => { if (!CONFIGURED) return; server = await startServer(); });
afterAll(async () => { if (!CONFIGURED) return; if (server) await new Promise((resolve) => server.close(resolve)); await db.close(); });

beforeEach(async () => { if (!CONFIGURED) return; await db.resetSchemaForTests(); });

async function users() {
  const alice = await createUserWithToken({ email: 'alice@example.com', displayName: 'Alice' });
  const bob = await createUserWithToken({ email: 'bob@example.com', displayName: 'Bob' });
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

describe.skipIf(!CONFIGURED)('analysis-objects API', () => {
  it('requires auth on every route', async () => {
    expect((await api(server, '/api/analysis-objects')).status).toBe(401);
    expect((await api(server, '/api/analysis-objects', { method: 'POST', body: { objectType: 'seurat' } })).status).toBe(401);
    expect((await api(server, '/api/analysis-objects/ao_whatever')).status).toBe(401);
  });

  it('lets a user create an object with a server-assigned id', async () => {
    const { alice } = await users();
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
    const { alice } = await users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { id: 'ao_client_chosen', objectType: 'seurat' }
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/server-assigned/i);
  });

  it('rejects body-provided owner/user fields', async () => {
    const { alice, bob } = await users();
    for (const field of ['userId', 'user_id', 'ownerUserId', 'owner_user_id']) {
      const res = await api(server, '/api/analysis-objects', {
        method: 'POST', token: alice.token,
        body: { objectType: 'seurat', [field]: bob.user.id }
      });
      expect(res.status, `field ${field}`).toBe(400);
    }
  });

  it('rejects an invalid object type', async () => {
    const { alice } = await users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'not-a-real-type' }
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/objectType/i);
  });

  it('rejects invalid metadata (array, null, scalar)', async () => {
    const { alice } = await users();
    for (const metadata of [[], null, 'string', 42]) {
      const res = await api(server, '/api/analysis-objects', {
        method: 'POST', token: alice.token,
        body: { objectType: 'seurat', metadata }
      });
      expect(res.status, `metadata=${JSON.stringify(metadata)}`).toBe(400);
    }
  });

  it('lists only the authenticated user objects', async () => {
    const { alice, bob } = await users();
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
    const { alice } = await users();
    await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'matrix' } });

    const filtered = await api(server, '/api/analysis-objects?objectType=matrix', { token: alice.token });
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].objectType).toBe('matrix');
  });

  it('lets a user read their own object but not another user object', async () => {
    const { alice, bob } = await users();
    const created = await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    const id = created.data.id;

    const own = await api(server, `/api/analysis-objects/${id}`, { token: alice.token });
    expect(own.status).toBe(200);
    expect(own.data.id).toBe(id);

    const other = await api(server, `/api/analysis-objects/${id}`, { token: bob.token });
    expect(other.status).toBe(404);
  });

  it('sets lineage_root_id to the object own id for a root object', async () => {
    const { alice } = await users();
    const created = await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    expect(created.data.lineageRootId).toBe(created.data.id);
    expect(created.data.parentObjectId).toBeNull();
  });

  it('inherits lineage root when creating a child of an owned parent', async () => {
    const { alice } = await users();
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
    const { alice, bob } = await users();
    const bobObj = await api(server, '/api/analysis-objects', { method: 'POST', token: bob.token, body: { objectType: 'seurat' } });

    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', parentObjectId: bobObj.data.id }
    });
    expect(res.status).toBe(404);
  });

  it('rejects a child with an unknown parent id', async () => {
    const { alice } = await users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', parentObjectId: 'ao_does_not_exist' }
    });
    expect(res.status).toBe(404);
  });

  it('links a provenance record the user owns and rejects another user provenance', async () => {
    const { alice, bob } = await users();
    await saveProvenance({ userEmail: alice.user.email, provenance: makeProvenance('prov-alice') });
    await saveProvenance({ userEmail: bob.user.email, provenance: makeProvenance('prov-bob') });

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

  it('rejects client-provided storage/state fields and omits storage metadata from public responses', async () => {
    const { alice } = await users();
    for (const field of ['storageUri', 'storage_uri', 'storageKey', 'storage_key', 'internalStorageKey', 'objectHash', 'path', 'stateKey']) {
      const res = await api(server, '/api/analysis-objects', {
        method: 'POST', token: alice.token,
        body: { objectType: 'seurat', [field]: 'vault/secret.rds' }
      });
      expect(res.status, field).toBe(400);
    }
    const nested = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', metadata: { sourceType: 'pbmc3k_demo', nested: { storageKey: 'vault/secret.rds' } } }
    });
    expect(nested.status).toBe(400);

    const created = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', metadata: { sourceType: 'pbmc3k_demo' } }
    });
    expect(created.status).toBe(201);
    expect(created.data.storageUri).toBeUndefined();
    expect(created.data.objectHash).toBeUndefined();

    const list = await api(server, '/api/analysis-objects', { token: alice.token });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.data)).not.toContain('vault/');
    expect(list.data[0].storageUri).toBeUndefined();

    const read = await api(server, `/api/analysis-objects/${created.data.id}`, { token: alice.token });
    expect(read.status).toBe(200);
    expect(read.data.storageUri).toBeUndefined();
    expect(read.data.objectHash).toBeUndefined();
  });

  // ── datasetId is now verified against the durable datasets model ───────────
  // Durable datasets are always project-scoped. The legacy owner route remains
  // private-scope-only so a removed project member cannot bypass project RBAC.
  it('accepts a null/absent datasetId (still optional)', async () => {
    const { alice } = await users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token, body: { objectType: 'seurat' }
    });
    expect(res.status).toBe(201);
    expect(res.data.datasetId).toBeNull();
  });

  it('rejects a project dataset on the private route and accepts it on the project route', async () => {
    const { alice } = await users();
    const { dataset, project } = await makeDataset(alice.user.id);
    const privateResult = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', datasetId: dataset.id }
    });
    expect(privateResult.status).toBe(404);

    const projectResult = await api(server, `/api/projects/${project.id}/analysis-objects`, {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', datasetId: dataset.id }
    });
    expect(projectResult.status).toBe(201);
    expect(projectResult.data.datasetId).toBe(dataset.id);
  });

  it('rejects a malformed datasetId with 400', async () => {
    const { alice } = await users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', datasetId: 'dataset-abc' }
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/malformed dataset/i);
  });

  it('rejects a well-formed but unknown datasetId with 404', async () => {
    const { alice } = await users();
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', datasetId: 'ds_deadbeefdeadbeefdeadbeef' }
    });
    expect(res.status).toBe(404);
  });

  it('rejects a datasetId from another user\'s project with 404 (no leak)', async () => {
    const { alice, bob } = await users();
    const { dataset: bobDs } = await makeDataset(bob.user.id);
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token,
      body: { objectType: 'seurat', datasetId: bobDs.id }
    });
    expect(res.status).toBe(404);
  });

  it('never exposes project objects through legacy owner-scoped reads', async () => {
    const { alice } = await users();
    const { dataset, project } = await makeDataset(alice.user.id);
    const created = await api(server, `/api/projects/${project.id}/analysis-objects`, {
      method: 'POST', token: alice.token, body: { objectType: 'seurat', datasetId: dataset.id }
    });
    expect(created.status).toBe(201);

    const byDataset = await api(server, `/api/analysis-objects?datasetId=${dataset.id}`, { token: alice.token });
    expect(byDataset.status).toBe(200);
    expect(byDataset.data).toEqual([]);
    expect((await api(server, `/api/analysis-objects/${created.data.id}`, { token: alice.token })).status).toBe(404);
  });
});
