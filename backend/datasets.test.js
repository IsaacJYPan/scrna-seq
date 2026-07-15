import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const storage = require('./storage');
const {
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createDatasetForProject
} = db;
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();

let server;

beforeAll(async () => { if (!CONFIGURED) return; server = await startServer(); });
afterAll(async () => { if (!CONFIGURED) return; if (server) await new Promise((resolve) => server.close(resolve)); await db.close(); });

beforeEach(async () => { if (!CONFIGURED) return; await db.resetSchemaForTests(); });

async function users() {
  const alice = await createUserWithToken({ email: 'alice@example.com', displayName: 'Alice' }); // owner
  const bob = await createUserWithToken({ email: 'bob@example.com', displayName: 'Bob' });
  const carol = await createUserWithToken({ email: 'carol@example.com', displayName: 'Carol' });
  const dave = await createUserWithToken({ email: 'dave@example.com', displayName: 'Dave' }); // non-member
  return { alice, bob, carol, dave };
}

// Seed an org + project owned by `ownerUserId`. The owner is seeded as project
// 'owner'. Returns the project.
async function seedProject(ownerUserId) {
  const org = await createOrganizationForUser(ownerUserId, { name: 'Acme Labs' });
  return createProjectForUser(ownerUserId, { organizationId: org.id, name: 'Project X' });
}

function addMember(projectId, email, role) {
  return addProjectMemberByEmail(projectId, email, role, 'owner');
}

const validBody = (over = {}) => ({ fileType: 'seurat_rds', ...over });

// ── 1. Authentication ──────────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('datasets API — authentication', () => {
  it('rejects unauthenticated access on every dataset route', async () => {
    const routes = [
      ['GET', '/api/projects/proj_x/datasets'],
      ['POST', '/api/projects/proj_x/datasets'],
      ['GET', '/api/projects/proj_x/datasets/ds_abc'],
      ['PATCH', '/api/projects/proj_x/datasets/ds_abc']
    ];
    for (const [method, path] of routes) {
      const res = await api(server, path, { method, body: method === 'GET' ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 2–4. Create authorization by role ───────────────────────────────────────
describe.skipIf(!CONFIGURED)('datasets API — create authorization', () => {
  it('lets owner/admin/analyst create a dataset (201)', async () => {
    const { alice, bob, carol } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin');
    await addMember(proj.id, 'carol@example.com', 'analyst');

    for (const actor of [alice, bob, carol]) {
      const res = await api(server, `/api/projects/${proj.id}/datasets`, {
        method: 'POST', token: actor.token, body: validBody()
      });
      expect(res.status, actor.user.email).toBe(201);
    }
  });

  it('forbids a viewer from creating a dataset (403)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');

    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: bob.token, body: validBody()
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 (no existence leak) when a non-member creates in a project', async () => {
    const { alice, dave } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: dave.token, body: validBody()
    });
    expect(res.status).toBe(404);
  });
});

// ── 5–6. Read authorization ─────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('datasets API — read authorization', () => {
  it('lets any project member (incl. viewer) list/read dataset metadata', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    const created = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody()
    });
    const dsId = created.data.id;

    const list = await api(server, `/api/projects/${proj.id}/datasets`, { token: bob.token });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);

    const read = await api(server, `/api/projects/${proj.id}/datasets/${dsId}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.data.id).toBe(dsId);
  });

  it('returns 404 when a non-member lists/reads', async () => {
    const { alice, dave } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody()
    });
    expect((await api(server, `/api/projects/${proj.id}/datasets`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/datasets/${created.data.id}`, { token: dave.token })).status).toBe(404);
  });
});

// ── 7–9. Server-controlled identity & rejected fields ───────────────────────
describe.skipIf(!CONFIGURED)('datasets API — server-controlled identity', () => {
  it('generates a ds_ id and never exposes the internal storage key', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody()
    });
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^ds_[0-9a-f]+$/);
    expect(res.data.projectId).toBe(proj.id);
    expect(res.data.ownerUserId).toBe(alice.user.id);
    expect(res.data.uploadStatus).toBe('pending');
    expect(res.data.validationStatus).toBe('pending');
    expect(res.data).not.toHaveProperty('internalStorageKey');
  });

  it('rejects a client-provided id (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody({ id: 'ds_clientchosen' })
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/server-controlled|server-assigned/i);
  });

  it('rejects client-provided owner/user/project/path/storage fields (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const fields = [
      'projectId', 'project_id', 'ownerUserId', 'owner_user_id',
      'createdByUserId', 'created_by_user_id', 'userId', 'user_id',
      'internalStorageKey', 'internal_storage_key', 'storageUri', 'storage_uri',
      'sha256', 'fileSizeBytes', 'file_size_bytes',
      'path', 'filePath', 'file_path', 'storagePath', 'storage_path'
    ];
    for (const field of fields) {
      const res = await api(server, `/api/projects/${proj.id}/datasets`, {
        method: 'POST', token: alice.token, body: validBody({ [field]: 'x' })
      });
      expect(res.status, `field ${field}`).toBe(400);
    }
  });
});

// ── 10–12. Enum validation ──────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('datasets API — enum validation', () => {
  it('rejects an invalid file_type (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: { fileType: 'exe' }
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/file_type/i);
  });

  it('rejects an invalid upload_status (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody({ uploadStatus: 'done' })
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/upload_status/i);
  });

  it('rejects an invalid validation_status (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody({ validationStatus: 'great' })
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/validation_status/i);
  });
});

// ── 13–15. Dataset resolution & malformed ids ───────────────────────────────
describe.skipIf(!CONFIGURED)('datasets API — resolution', () => {
  it('returns 404 for an unknown (well-formed) dataset id', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets/ds_deadbeefdeadbeefdeadbeef`, { token: alice.token });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a dataset that belongs to another project', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id);
    const orgB = await createOrganizationForUser(alice.user.id, { name: 'Org B' });
    const projB = await createProjectForUser(alice.user.id, { organizationId: orgB.id, name: 'Project B' });
    const inB = await api(server, `/api/projects/${projB.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody()
    });
    // Even though Alice owns both projects, the dataset is scoped to projB and
    // must not be readable through projA's path.
    const res = await api(server, `/api/projects/${projA.id}/datasets/${inB.data.id}`, { token: alice.token });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed dataset id', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    for (const bad of ['not-an-id', 'ao_abc', 'ds_NOTHEX', 'ds_']) {
      const res = await api(server, `/api/projects/${proj.id}/datasets/${bad}`, { token: alice.token });
      expect(res.status, bad).toBe(400);
    }
  });
});

// ── 21. List filtering is project-scoped ────────────────────────────────────
describe.skipIf(!CONFIGURED)('datasets API — list filtering', () => {
  it('filters within the project and cannot leak cross-project rows', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id);
    const orgB = await createOrganizationForUser(alice.user.id, { name: 'Org B' });
    const projB = await createProjectForUser(alice.user.id, { organizationId: orgB.id, name: 'Project B' });

    await api(server, `/api/projects/${projA.id}/datasets`, { method: 'POST', token: alice.token, body: validBody({ fileType: 'seurat_rds' }) });
    await api(server, `/api/projects/${projA.id}/datasets`, { method: 'POST', token: alice.token, body: validBody({ fileType: 'h5ad' }) });
    await api(server, `/api/projects/${projB.id}/datasets`, { method: 'POST', token: alice.token, body: validBody({ fileType: 'seurat_rds' }) });

    const all = await api(server, `/api/projects/${projA.id}/datasets`, { token: alice.token });
    expect(all.data).toHaveLength(2); // only projA's rows

    const filtered = await api(server, `/api/projects/${projA.id}/datasets?fileType=seurat_rds`, { token: alice.token });
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].fileType).toBe('seurat_rds');
    expect(filtered.data.every(d => d.projectId === projA.id)).toBe(true);

    const rejected = await api(server, `/api/projects/${projA.id}/datasets?uploadStatus=bogus`, { token: alice.token });
    expect(rejected.status).toBe(400);
  });
});

// ── 22. A pending/failed upload cannot be represented as valid ───────────────
describe.skipIf(!CONFIGURED)('datasets API — upload/validation status integrity', () => {
  it('refuses to create a dataset marked valid while upload is not uploaded (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token,
      body: validBody({ uploadStatus: 'pending', validationStatus: 'valid' })
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/valid/i);
  });

  it('a freshly registered dataset is pending/pending (not valid)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody()
    });
    expect(res.data.uploadStatus).toBe('pending');
    expect(res.data.validationStatus).not.toBe('valid');
  });

  it('PATCH refuses to set validation_status=valid while upload is failed (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody({ uploadStatus: 'failed' })
    });
    const res = await api(server, `/api/projects/${proj.id}/datasets/${created.data.id}`, {
      method: 'PATCH', token: alice.token, body: { validationStatus: 'valid' }
    });
    expect(res.status).toBe(400);
  });

  it('PATCH allows valid once upload_status is uploaded', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody()
    });
    const res = await api(server, `/api/projects/${proj.id}/datasets/${created.data.id}`, {
      method: 'PATCH', token: alice.token, body: { uploadStatus: 'uploaded', validationStatus: 'valid' }
    });
    expect(res.status).toBe(200);
    expect(res.data.uploadStatus).toBe('uploaded');
    expect(res.data.validationStatus).toBe('valid');
  });

  it('forbids a viewer from updating a dataset (403)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    const created = await api(server, `/api/projects/${proj.id}/datasets`, {
      method: 'POST', token: alice.token, body: validBody()
    });
    const res = await api(server, `/api/projects/${proj.id}/datasets/${created.data.id}`, {
      method: 'PATCH', token: bob.token, body: { metadata: { note: 'hi' } }
    });
    expect(res.status).toBe(403);
  });
});

// ── Multipart upload: server-chosen storage, sha256/size recorded ───────────
describe.skipIf(!CONFIGURED)('datasets API — file upload', () => {
  async function uploadFile(projectId, token, { content, filename, fileType }) {
    const { port } = server.address();
    const form = new FormData();
    form.append('file', new Blob([content]), filename);
    if (fileType) form.append('fileType', fileType);
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/datasets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  it('stores an uploaded file under a server-chosen key and records sha256 + size', async () => {
    const crypto = require('crypto');
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const content = 'gene,cell1,cell2\nGAPDH,1,2\n';
    const expectedSha = crypto.createHash('sha256').update(Buffer.from(content)).digest('hex');

    const res = await uploadFile(proj.id, alice.token, {
      content, filename: 'counts.csv', fileType: 'count_matrix_csv'
    });
    expect(res.status).toBe(201);
    expect(res.data.uploadStatus).toBe('uploaded');
    expect(res.data.sha256).toBe(expectedSha);
    expect(res.data.fileSizeBytes).toBe(Buffer.byteLength(content));
    expect(res.data.originalFilename).toBe('counts.csv');
    // The client never learns (or chooses) the server storage key.
    expect(res.data).not.toHaveProperty('internalStorageKey');

    const internal = await db.getDatasetForProject(alice.user.id, proj.id, res.data.id);
    expect(storage.isProjectStorageKey(internal.internalStorageKey, {
      projectId: proj.id,
      kind: 'datasets',
    })).toBe(true);
    const provider = storage.createLocalStorageProvider();
    expect(provider.inspect(internal.internalStorageKey, {
      checksumSha256: expectedSha,
      sizeBytes: Buffer.byteLength(content),
    })).toEqual(expect.objectContaining({ key: internal.internalStorageKey }));
  });

  it('forbids a viewer from uploading a dataset file (403)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    const res = await uploadFile(proj.id, bob.token, {
      content: 'x', filename: 'counts.csv', fileType: 'count_matrix_csv'
    });
    expect(res.status).toBe(403);
  });
});

// ── 16–20. datasetId verification on analysis objects & jobs ────────────────
describe.skipIf(!CONFIGURED)('datasets — datasetId verification on analysis objects & jobs', () => {
  // Helper: create a dataset in a project the given user can write to.
  async function datasetFor(ownerUserId) {
    const project = await seedProject(ownerUserId);
    const dataset = await createDatasetForProject(ownerUserId, project.id, { fileType: 'seurat_rds' });
    return { project, dataset };
  }

  it('dataset-backed analysis object creation requires the project route', async () => {
    const { alice } = await users();
    const { project, dataset } = await datasetFor(alice.user.id);
    const legacy = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token, body: { objectType: 'seurat', datasetId: dataset.id }
    });
    expect(legacy.status).toBe(404);

    const scoped = await api(server, `/api/projects/${project.id}/analysis-objects`, {
      method: 'POST', token: alice.token, body: { objectType: 'seurat', datasetId: dataset.id }
    });
    expect(scoped.status).toBe(201);
    expect(scoped.data.datasetId).toBe(dataset.id);
  });

  it('analysis object creation fails (404) with an inaccessible datasetId', async () => {
    const { alice, bob } = await users();
    const { dataset: bobDs } = await datasetFor(bob.user.id);
    const res = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token, body: { objectType: 'seurat', datasetId: bobDs.id }
    });
    expect(res.status).toBe(404);
  });

  it('dataset-backed job creation requires the project route', async () => {
    const { alice } = await users();
    const { project, dataset } = await datasetFor(alice.user.id);
    const legacy = await api(server, '/api/jobs', {
      method: 'POST', token: alice.token, body: { jobType: 'normalize', datasetId: dataset.id }
    });
    expect(legacy.status).toBe(404);

    const scoped = await api(server, `/api/projects/${project.id}/jobs`, {
      method: 'POST', token: alice.token, body: { jobType: 'normalize', datasetId: dataset.id }
    });
    expect(scoped.status).toBe(201);
    expect(scoped.data.datasetId).toBe(dataset.id);
  });

  it('job creation fails (404) with an inaccessible datasetId', async () => {
    const { alice, bob } = await users();
    const { dataset: bobDs } = await datasetFor(bob.user.id);
    const res = await api(server, '/api/jobs', {
      method: 'POST', token: alice.token, body: { jobType: 'normalize', datasetId: bobDs.id }
    });
    expect(res.status).toBe(404);
  });

  it('a viewer cannot create an analysis object or job using the dataset (403)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    const ds = await createDatasetForProject(alice.user.id, proj.id, { fileType: 'seurat_rds' });

    const ao = await api(server, `/api/projects/${proj.id}/analysis-objects`, {
      method: 'POST', token: bob.token, body: { objectType: 'seurat', datasetId: ds.id }
    });
    expect(ao.status).toBe(403);

    const job = await api(server, `/api/projects/${proj.id}/jobs`, {
      method: 'POST', token: bob.token, body: { jobType: 'normalize', datasetId: ds.id }
    });
    expect(job.status).toBe(403);
  });

  it('a malformed datasetId on analysis object/job creation returns 400', async () => {
    const { alice } = await users();
    const ao = await api(server, '/api/analysis-objects', {
      method: 'POST', token: alice.token, body: { objectType: 'seurat', datasetId: 'bad-id' }
    });
    expect(ao.status).toBe(400);
    const job = await api(server, '/api/jobs', {
      method: 'POST', token: alice.token, body: { jobType: 'normalize', datasetId: 'bad-id' }
    });
    expect(job.status).toBe(400);
  });
});
