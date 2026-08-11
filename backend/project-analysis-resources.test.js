import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const {
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  updateProjectMemberRole, removeProjectMember,
  createDatasetForProject, createAnalysisObjectForUser,
  verifyAnalysisObjectOwner, verifyJobOwner
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
  const erin = await createUserWithToken({ email: 'erin@example.com', displayName: 'Erin' });
  return { alice, bob, carol, dave, erin };
}

// Seed an org + project owned by `ownerUserId` (seeded as project 'owner').
async function seedProject(ownerUserId, name = 'Project X') {
  const org = await createOrganizationForUser(ownerUserId, { name: 'Acme Labs' });
  return createProjectForUser(ownerUserId, { organizationId: org.id, name });
}

function addMember(projectId, email, role) {
  return addProjectMemberByEmail(projectId, email, role, 'owner');
}

function datasetIn(userId, projectId, fileType = 'seurat_rds') {
  return createDatasetForProject(userId, projectId, { fileType });
}

// Create an analysis object through the project route, returning the parsed body.
async function createAO(projectId, token, body = { objectType: 'seurat' }) {
  return api(server, `/api/projects/${projectId}/analysis-objects`, { method: 'POST', token, body });
}
async function createJob(projectId, token, body = { jobType: 'normalize' }) {
  return api(server, `/api/projects/${projectId}/jobs`, { method: 'POST', token, body });
}

// ── 1. Authentication ───────────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — authentication', () => {
  it('rejects unauthenticated access on every project analysis-object/job route', async () => {
    const routes = [
      ['GET', '/api/projects/proj_x/analysis-objects'],
      ['POST', '/api/projects/proj_x/analysis-objects'],
      ['GET', '/api/projects/proj_x/analysis-objects/ao_abc'],
      ['GET', '/api/projects/proj_x/jobs'],
      ['POST', '/api/projects/proj_x/jobs'],
      ['GET', '/api/projects/proj_x/jobs/job_abc'],
      ['GET', '/api/projects/proj_x/jobs/job_abc/logs'],
      ['POST', '/api/projects/proj_x/jobs/job_abc/cancel']
    ];
    for (const [method, path] of routes) {
      const res = await api(server, path, { method, body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 2–3. Non-member cannot list/read ────────────────────────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — non-member access (404, no leak)', () => {
  it('non-member cannot list/read project analysis objects', async () => {
    const { alice, dave } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await createAO(proj.id, alice.token);
    expect((await api(server, `/api/projects/${proj.id}/analysis-objects`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/analysis-objects/${created.data.id}`, { token: dave.token })).status).toBe(404);
  });

  it('non-member cannot list/read project jobs', async () => {
    const { alice, dave } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await createJob(proj.id, alice.token);
    expect((await api(server, `/api/projects/${proj.id}/jobs`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/jobs/${created.data.id}`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/jobs/${created.data.id}/logs`, { token: dave.token })).status).toBe(404);
  });

  it('non-member cannot create in a project (404, no existence leak)', async () => {
    const { alice, dave } = await users();
    const proj = await seedProject(alice.user.id);
    expect((await createAO(proj.id, dave.token)).status).toBe(404);
    expect((await createJob(proj.id, dave.token)).status).toBe(404);
  });
});

// ── 4–5. Viewer read access ─────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — viewer read access', () => {
  it('viewer can list/read project analysis-object metadata', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    const created = await createAO(proj.id, alice.token);

    const list = await api(server, `/api/projects/${proj.id}/analysis-objects`, { token: bob.token });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);

    const read = await api(server, `/api/projects/${proj.id}/analysis-objects/${created.data.id}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.data.id).toBe(created.data.id);
    expect(read.data.projectId).toBe(proj.id);
  });

  it('viewer can list/read project job metadata and logs', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    const created = await createJob(proj.id, alice.token);

    const list = await api(server, `/api/projects/${proj.id}/jobs`, { token: bob.token });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);

    const read = await api(server, `/api/projects/${proj.id}/jobs/${created.data.id}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.data.id).toBe(created.data.id);

    const logs = await api(server, `/api/projects/${proj.id}/jobs/${created.data.id}/logs`, { token: bob.token });
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.data.logs)).toBe(true);
  });
});

// ── 6–9. Create authorization by role ───────────────────────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — create authorization', () => {
  it('viewer cannot create analysis objects (403)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    expect((await createAO(proj.id, bob.token)).status).toBe(403);
  });

  it('viewer cannot create jobs (403)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    expect((await createJob(proj.id, bob.token)).status).toBe(403);
  });

  it('owner/admin/analyst can create project analysis objects (201)', async () => {
    const { alice, bob, carol } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin');
    await addMember(proj.id, 'carol@example.com', 'analyst');
    for (const actor of [alice, bob, carol]) {
      const res = await createAO(proj.id, actor.token);
      expect(res.status, actor.user.email).toBe(201);
      expect(res.data.projectId).toBe(proj.id);
      expect(res.data.ownerUserId).toBe(actor.user.id);
    }
  });

  it('owner/admin/analyst can create project jobs (201)', async () => {
    const { alice, bob, carol } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin');
    await addMember(proj.id, 'carol@example.com', 'analyst');
    for (const actor of [alice, bob, carol]) {
      const res = await createJob(proj.id, actor.token);
      expect(res.status, actor.user.email).toBe(201);
      expect(res.data.projectId).toBe(proj.id);
      expect(res.data.ownerUserId).toBe(actor.user.id);
      expect(res.data.status).toBe('queued');
    }
  });
});

// ── 10–13. Server-controlled identity & rejected fields ─────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — server-controlled identity', () => {
  it('server sets project_id from the route; body-provided project fields are rejected (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);

    const ao = await createAO(proj.id, alice.token);
    expect(ao.data.projectId).toBe(proj.id);
    const job = await createJob(proj.id, alice.token);
    expect(job.data.projectId).toBe(proj.id);

    for (const field of ['projectId', 'project_id']) {
      expect((await createAO(proj.id, alice.token, { objectType: 'seurat', [field]: 'proj_other' })).status, `AO ${field}`).toBe(400);
      expect((await createJob(proj.id, alice.token, { jobType: 'normalize', [field]: 'proj_other' })).status, `job ${field}`).toBe(400);
    }
  });

  it('rejects a client-provided object/job id (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    expect((await createAO(proj.id, alice.token, { objectType: 'seurat', id: 'ao_clientchosen' })).status).toBe(400);
    expect((await createJob(proj.id, alice.token, { jobType: 'normalize', id: 'job_clientchosen' })).status).toBe(400);
  });

  it('rejects client-provided owner/user/creator fields (400)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    const fields = ['userId', 'user_id', 'ownerUserId', 'owner_user_id', 'createdByUserId', 'created_by_user_id'];
    for (const field of fields) {
      expect((await createAO(proj.id, alice.token, { objectType: 'seurat', [field]: bob.user.id })).status, `AO ${field}`).toBe(400);
      expect((await createJob(proj.id, alice.token, { jobType: 'normalize', [field]: bob.user.id })).status, `job ${field}`).toBe(400);
    }
  });

  it('rejects client-provided analysis object storage/state fields and omits storage metadata from responses', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);

    for (const field of ['storageUri', 'storage_uri', 'storageKey', 'storage_key', 'internalStorageKey', 'objectHash', 'path', 'stateKey']) {
      const res = await createAO(proj.id, alice.token, { objectType: 'seurat', [field]: 'vault/secret.rds' });
      expect(res.status, field).toBe(400);
    }
    const nested = await createAO(proj.id, alice.token, {
      objectType: 'seurat',
      metadata: { sourceType: 'pbmc3k_demo', nested: { storageKey: 'vault/secret.rds' } }
    });
    expect(nested.status).toBe(400);

    const created = await createAO(proj.id, alice.token, { objectType: 'seurat', metadata: { sourceType: 'pbmc3k_demo' } });
    expect(created.status).toBe(201);
    expect(created.data.id).toMatch(/^ao_[0-9a-f]+$/);
    expect(created.data.storageUri).toBeUndefined();
    expect(created.data.objectHash).toBeUndefined();

    const list = await api(server, `/api/projects/${proj.id}/analysis-objects`, { token: alice.token });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.data)).not.toContain('vault/');
    expect(list.data[0].storageUri).toBeUndefined();

    const read = await api(server, `/api/projects/${proj.id}/analysis-objects/${created.data.id}`, { token: alice.token });
    expect(read.status).toBe(200);
    expect(read.data.storageUri).toBeUndefined();
    expect(read.data.objectHash).toBeUndefined();
  });

  it('rejects a client-provided job status (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const res = await createJob(proj.id, alice.token, { jobType: 'normalize', status: 'completed' });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/status is server-managed/i);
  });
});

// ── Analysis-object display summary (cells/features/density) ─────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — display summary metadata', () => {
  function summaryPath(projectId, objectId) {
    return `/api/projects/${projectId}/analysis-objects/${objectId}/summary`;
  }
  async function patchSummary(projectId, objectId, token, body) {
    return api(server, summaryPath(projectId, objectId), { method: 'PATCH', token, body });
  }

  it('persists cells/features/density and exposes them via the public response (survives reload)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await createAO(proj.id, alice.token, { objectType: 'seurat', metadata: { sourceType: 'pbmc3k_demo' } });
    expect(created.status).toBe(201);
    const aoId = created.data.id;

    const patched = await patchSummary(proj.id, aoId, alice.token, { cells: 2700, features: 13714, density: 2.59 });
    expect(patched.status).toBe(200);
    expect(patched.data.metadata.summary).toEqual({ cells: 2700, features: 13714, density: 2.59 });
    // Original metadata is preserved, not clobbered.
    expect(patched.data.metadata.sourceType).toBe('pbmc3k_demo');

    // A fresh GET (simulating a reload) still sees the persisted counts.
    const reread = await api(server, `/api/projects/${proj.id}/analysis-objects/${aoId}`, { token: alice.token });
    expect(reread.status).toBe(200);
    expect(reread.data.metadata.summary).toEqual({ cells: 2700, features: 13714, density: 2.59 });

    const list = await api(server, `/api/projects/${proj.id}/analysis-objects`, { token: alice.token });
    expect(list.data[0].metadata.summary.cells).toBe(2700);
  });

  it('never exposes storage/hash/state/path fields and rejects attempts to set them', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await createAO(proj.id, alice.token, { objectType: 'seurat', metadata: { sourceType: 'pbmc3k_demo' } });
    const aoId = created.data.id;

    for (const field of ['storageUri', 'storage_uri', 'storageKey', 'storage_key', 'internalStorageKey', 'objectHash', 'path', 'stateKey', 'state_key']) {
      const res = await patchSummary(proj.id, aoId, alice.token, { cells: 10, [field]: 'vault/secret.rds' });
      expect(res.status, field).toBe(400);
    }
    // Server-controlled identity fields are also rejected.
    for (const field of ['id', 'projectId', 'ownerUserId', 'owner_user_id']) {
      const res = await patchSummary(proj.id, aoId, alice.token, { cells: 10, [field]: 'x' });
      expect(res.status, field).toBe(400);
    }

    const ok = await patchSummary(proj.id, aoId, alice.token, { cells: 2700, features: 13714, density: 2.59 });
    expect(ok.status).toBe(200);
    const raw = JSON.stringify(ok.data);
    expect(raw).not.toContain('vault/');
    expect(ok.data.storageUri).toBeUndefined();
    expect(ok.data.objectHash).toBeUndefined();
    expect(ok.data.metadata.summary.storageKey).toBeUndefined();
    expect(ok.data.metadata.summary.stateKey).toBeUndefined();
  });

  it('rejects non-numeric / negative summary values (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const aoId = (await createAO(proj.id, alice.token, { objectType: 'seurat' })).data.id;

    expect((await patchSummary(proj.id, aoId, alice.token, { cells: 'lots' })).status).toBe(400);
    expect((await patchSummary(proj.id, aoId, alice.token, { features: -5 })).status).toBe(400);
    expect((await patchSummary(proj.id, aoId, alice.token, { density: 'high' })).status).toBe(400);
  });

  it('400 on malformed object id, 404 on unknown object in the project', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    expect((await patchSummary(proj.id, 'not-an-ao-id', alice.token, { cells: 1 })).status).toBe(400);
    expect((await patchSummary(proj.id, 'ao_deadbeefdeadbeefdeadbeef', alice.token, { cells: 1 })).status).toBe(404);
  });

  it('non-member gets 404 and a viewer gets 403 (no RBAC weakening)', async () => {
    const { alice, bob, dave } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, bob.user.email, 'viewer');
    const aoId = (await createAO(proj.id, alice.token, { objectType: 'seurat' })).data.id;

    // Non-member: 404 (no existence leak).
    expect((await patchSummary(proj.id, aoId, dave.token, { cells: 1 })).status).toBe(404);
    // Viewer is a member but lacks a write role: 403.
    expect((await patchSummary(proj.id, aoId, bob.token, { cells: 1 })).status).toBe(403);
    // The object's summary was not mutated by the rejected calls.
    const reread = await api(server, `/api/projects/${proj.id}/analysis-objects/${aoId}`, { token: alice.token });
    expect(reread.data.metadata.summary).toBeUndefined();
  });
});

// ── 14–20. Cross-project reference confinement ──────────────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — references stay within the project', () => {
  it('dataset must belong to the same project as the route (analysis object)', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const dsA = await datasetIn(alice.user.id, projA.id);
    const dsB = await datasetIn(alice.user.id, projB.id);

    // same-project dataset → 201
    const ok = await createAO(projA.id, alice.token, { objectType: 'seurat', datasetId: dsA.id });
    expect(ok.status).toBe(201);
    expect(ok.data.datasetId).toBe(dsA.id);

    // cross-project dataset → 404 (even though Alice owns both projects)
    const cross = await createAO(projA.id, alice.token, { objectType: 'seurat', datasetId: dsB.id });
    expect(cross.status).toBe(404);
  });

  it('dataset must belong to the same project as the route (job)', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const dsA = await datasetIn(alice.user.id, projA.id);
    const dsB = await datasetIn(alice.user.id, projB.id);

    const ok = await createJob(projA.id, alice.token, { jobType: 'normalize', datasetId: dsA.id });
    expect(ok.status).toBe(201);
    expect(ok.data.datasetId).toBe(dsA.id);

    const cross = await createJob(projA.id, alice.token, { jobType: 'normalize', datasetId: dsB.id });
    expect(cross.status).toBe(404);
  });

  it('parent analysis object must belong to the same project as the route', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const rootB = await createAO(projB.id, alice.token);

    const cross = await createAO(projA.id, alice.token, { objectType: 'seurat', parentObjectId: rootB.data.id });
    expect(cross.status).toBe(404);
  });

  it('child lineage root is inherited within the project and cannot cross projects', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');

    // In-project lineage inheritance.
    const root = await createAO(projA.id, alice.token);
    expect(root.data.lineageRootId).toBe(root.data.id);
    const child = await createAO(projA.id, alice.token, { objectType: 'seurat', parentObjectId: root.data.id });
    expect(child.status).toBe(201);
    expect(child.data.lineageRootId).toBe(root.data.id);
    const grandchild = await createAO(projA.id, alice.token, { objectType: 'seurat', parentObjectId: child.data.id });
    expect(grandchild.data.lineageRootId).toBe(root.data.id);

    // A child in projB cannot adopt projA's object as a parent/lineage root.
    const crossChild = await createAO(projB.id, alice.token, { objectType: 'seurat', parentObjectId: root.data.id });
    expect(crossChild.status).toBe(404);
  });

  it('job analysisObjectId must belong to the same project as the route', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const aoA = await createAO(projA.id, alice.token);
    const aoB = await createAO(projB.id, alice.token);

    expect((await createJob(projA.id, alice.token, { jobType: 'normalize', analysisObjectId: aoA.data.id })).status).toBe(201);
    expect((await createJob(projA.id, alice.token, { jobType: 'normalize', analysisObjectId: aoB.data.id })).status).toBe(404);
  });

  it('job resultAnalysisObjectId must belong to the same project as the route', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const aoA = await createAO(projA.id, alice.token);
    const aoB = await createAO(projB.id, alice.token);

    expect((await createJob(projA.id, alice.token, { jobType: 'normalize', resultAnalysisObjectId: aoA.data.id })).status).toBe(201);
    expect((await createJob(projA.id, alice.token, { jobType: 'normalize', resultAnalysisObjectId: aoB.data.id })).status).toBe(404);
  });

  it('receipt-backed jobs reject incompatible references at HTTP and DB boundaries', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const source = await createAO(proj.id, alice.token);
    const forgedResult = await createAO(proj.id, alice.token);
    const dataset = await createDatasetForProject(alice.user.id, proj.id, { fileType: 'seurat_rds' });

    const receiptTypes = [
      'pbmc.pipeline.v1', 'seurat.pipeline.v1', 'spatial.seurat.v1', 'deg.find_markers.v1', 'enrichment.gsea.v1',
      'cellchat.infer.v1',
      'checkpoint.load.v1', 'checkpoint.fork.v1',
    ];
    const noDatasetTypes = [
      'pbmc.pipeline.v1', 'deg.find_markers.v1', 'enrichment.gsea.v1',
      'cellchat.infer.v1',
      'checkpoint.load.v1', 'checkpoint.fork.v1',
    ];
    const invalidBodies = [
      ...receiptTypes.flatMap((jobType) => [
        { jobType, analysisObjectId: source.data.id, resultAnalysisObjectId: forgedResult.data.id },
        { jobType, analysisObjectId: source.data.id, resultAnalysisObjectId: null },
        { jobType },
      ]),
      ...noDatasetTypes.flatMap((jobType) => [
        { jobType, analysisObjectId: source.data.id, datasetId: dataset.id },
        { jobType, analysisObjectId: source.data.id, datasetId: null },
      ]),
    ];
    for (const body of invalidBodies) {
      const response = await createJob(proj.id, alice.token, body);
      expect(response.status).toBe(400);
      expect(response.data.error).toMatch(/server-managed|derived from|requires a source/i);
    }

    for (const jobType of receiptTypes) {
      await expect(db.createProjectJob(alice.user.id, proj.id, {
        jobType,
        analysisObjectId: source.data.id,
        resultAnalysisObjectId: forgedResult.data.id,
      })).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
      await expect(db.createProjectJob(alice.user.id, proj.id, { jobType }))
        .rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
    }
    for (const jobType of noDatasetTypes) {
      await expect(db.createProjectJob(alice.user.id, proj.id, {
        jobType,
        analysisObjectId: source.data.id,
        datasetId: dataset.id,
      })).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
    }
  });

  it('accepts only the fixed CellChat parameter surface at the project HTTP boundary', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const source = await createAO(proj.id, alice.token);
    const parameters = {
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      databaseCategory: 'all',
      analysisIntent: 'single_context',
      minCellsPerGroup: 10,
      maxCellsPerGroup: 1000,
      maxTotalCells: 10000,
      pValueCutoff: 0.05,
      topInteractions: 25,
      topPathways: 15,
      randomSeed: 1,
    };
    const created = await createJob(proj.id, alice.token, {
      jobType: 'cellchat.infer.v1',
      analysisObjectId: source.data.id,
      parameters,
    });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({
      jobType: 'cellchat.infer.v1',
      analysisObjectId: source.data.id,
      parameters,
    });
    expect(JSON.stringify(created.data)).not.toMatch(/storage(?:Key|Uri)|stateKey/i);

    for (const rejected of [
      { ...parameters, metadataColumn: 'orig.ident' },
      { ...parameters, rCode: 'system("whoami")' },
      (() => {
        const missing = { ...parameters };
        delete missing.species;
        return missing;
      })(),
    ]) {
      const response = await createJob(proj.id, alice.token, {
        jobType: 'cellchat.infer.v1',
        analysisObjectId: source.data.id,
        parameters: rejected,
      });
      expect(response.status).toBe(400);
      expect(response.data.error).toMatch(/Unknown parameter|required/i);
    }
  });

  it('rejects a collaborator CellChat job against another owner\'s private live R object before queueing', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'analyst');
    const source = await createAO(proj.id, alice.token);
    const parameters = {
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      databaseCategory: 'all',
      analysisIntent: 'single_context',
      minCellsPerGroup: 10,
      maxCellsPerGroup: 1000,
      maxTotalCells: 10000,
      pValueCutoff: 0.05,
      topInteractions: 25,
      topPathways: 15,
      randomSeed: 1,
    };

    const httpResponse = await createJob(proj.id, bob.token, {
      jobType: 'cellchat.infer.v1',
      analysisObjectId: source.data.id,
      parameters,
    });
    expect(httpResponse.status).toBe(404);
    expect(httpResponse.data.error).toBe('Analysis object not found.');

    await expect(db.createProjectJob(bob.user.id, proj.id, {
      jobType: 'cellchat.infer.v1',
      analysisObjectId: source.data.id,
      parameters,
    })).rejects.toMatchObject({ code: 'ANALYSIS_OBJECT_NOT_FOUND' });
  });

  it('rejects collaborator DEG and enrichment jobs against another owner\'s private live R object before queueing', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'analyst');
    const source = await createAO(proj.id, alice.token);
    const privateLiveJobs = [
      { jobType: 'deg.find_markers.v1', parameters: {} },
      {
        jobType: 'enrichment.gsea.v1',
        parameters: { targetGroup: '0', species: 'human' },
      },
    ];

    for (const { jobType, parameters } of privateLiveJobs) {
      const httpResponse = await createJob(proj.id, bob.token, {
        jobType,
        analysisObjectId: source.data.id,
        parameters,
      });
      expect(httpResponse.status, jobType).toBe(404);
      expect(httpResponse.data.error, jobType).toBe('Analysis object not found.');

      await expect(db.createProjectJob(bob.user.id, proj.id, {
        jobType,
        analysisObjectId: source.data.id,
        parameters,
      })).rejects.toMatchObject({ code: 'ANALYSIS_OBJECT_NOT_FOUND' });

      const queued = await api(server, `/api/projects/${proj.id}/jobs`, { token: bob.token });
      expect(queued.status, jobType).toBe(200);
      expect(queued.data, jobType).toEqual([]);
    }
  });

  it('cross-project object/job reads return 404', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const aoB = await createAO(projB.id, alice.token);
    const jobB = await createJob(projB.id, alice.token);

    // projB resources are invisible through projA's route, even to the shared owner.
    expect((await api(server, `/api/projects/${projA.id}/analysis-objects/${aoB.data.id}`, { token: alice.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${projA.id}/jobs/${jobB.data.id}`, { token: alice.token })).status).toBe(404);
  });
});

// ── 21. Malformed ids → 400 ─────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — malformed ids', () => {
  it('returns 400 for malformed analysis object ids', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    for (const bad of ['not-an-id', 'ao_NOTHEX', 'ao_', 'job_abc']) {
      const res = await api(server, `/api/projects/${proj.id}/analysis-objects/${bad}`, { token: alice.token });
      expect(res.status, bad).toBe(400);
    }
    // Malformed reference ids in the create body are 400 too.
    expect((await createAO(proj.id, alice.token, { objectType: 'seurat', parentObjectId: 'bad' })).status).toBe(400);
    expect((await createAO(proj.id, alice.token, { objectType: 'seurat', datasetId: 'bad' })).status).toBe(400);
  });

  it('returns 400 for malformed job ids on every job sub-route', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    for (const bad of ['not-an-id', 'job_NOTHEX', 'job_', 'ao_abc']) {
      expect((await api(server, `/api/projects/${proj.id}/jobs/${bad}`, { token: alice.token })).status, `GET ${bad}`).toBe(400);
      expect((await api(server, `/api/projects/${proj.id}/jobs/${bad}/logs`, { token: alice.token })).status, `logs ${bad}`).toBe(400);
      expect((await api(server, `/api/projects/${proj.id}/jobs/${bad}/cancel`, { method: 'POST', token: alice.token })).status, `cancel ${bad}`).toBe(400);
    }
    expect((await createJob(proj.id, alice.token, { jobType: 'normalize', analysisObjectId: 'bad' })).status).toBe(400);
    expect((await createJob(proj.id, alice.token, { jobType: 'normalize', datasetId: 'bad' })).status).toBe(400);
  });
});

// ── 22–26. Cancel policy ────────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — cancel policy', () => {
  async function projectWithAnalysts() {
    const u = await users();
    const proj = await seedProject(u.alice.user.id);          // alice owner
    await addMember(proj.id, 'bob@example.com', 'admin');     // bob admin
    await addMember(proj.id, 'carol@example.com', 'analyst'); // carol analyst
    await addMember(proj.id, 'erin@example.com', 'analyst');  // erin analyst
    return { ...u, proj };
  }

  it('analyst can cancel their own cancelable job (200)', async () => {
    const { carol, proj } = await projectWithAnalysts();
    const job = await createJob(proj.id, carol.token);
    const res = await api(server, `/api/projects/${proj.id}/jobs/${job.data.id}/cancel`, { method: 'POST', token: carol.token });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('canceled');
    expect(res.data.canceledAt).toBeTruthy();
  });

  it("analyst cannot cancel another analyst's job (403)", async () => {
    const { carol, erin, proj } = await projectWithAnalysts();
    const erinJob = await createJob(proj.id, erin.token);
    const res = await api(server, `/api/projects/${proj.id}/jobs/${erinJob.data.id}/cancel`, { method: 'POST', token: carol.token });
    expect(res.status).toBe(403);
    // Erin's job is untouched.
    const still = await api(server, `/api/projects/${proj.id}/jobs/${erinJob.data.id}`, { token: erin.token });
    expect(still.data.status).toBe('queued');
  });

  it('owner and admin can cancel any cancelable project job (200)', async () => {
    const { alice, bob, carol, erin, proj } = await projectWithAnalysts();
    const carolJob = await createJob(proj.id, carol.token);
    const erinJob = await createJob(proj.id, erin.token);

    // Owner cancels an analyst's job.
    const byOwner = await api(server, `/api/projects/${proj.id}/jobs/${carolJob.data.id}/cancel`, { method: 'POST', token: alice.token });
    expect(byOwner.status).toBe(200);
    expect(byOwner.data.status).toBe('canceled');

    // Admin cancels a different analyst's job.
    const byAdmin = await api(server, `/api/projects/${proj.id}/jobs/${erinJob.data.id}/cancel`, { method: 'POST', token: bob.token });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.data.status).toBe('canceled');
  });

  it('viewer cannot cancel jobs (403)', async () => {
    const { alice, dave } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'dave@example.com', 'viewer');
    const job = await createJob(proj.id, alice.token);
    const res = await api(server, `/api/projects/${proj.id}/jobs/${job.data.id}/cancel`, { method: 'POST', token: dave.token });
    expect(res.status).toBe(403);
  });

  it('canceling an already-terminal job returns 409', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const job = await createJob(proj.id, alice.token);
    expect((await api(server, `/api/projects/${proj.id}/jobs/${job.data.id}/cancel`, { method: 'POST', token: alice.token })).status).toBe(200);
    const again = await api(server, `/api/projects/${proj.id}/jobs/${job.data.id}/cancel`, { method: 'POST', token: alice.token });
    expect(again.status).toBe(409);
  });

  it('canceling an unknown/cross-project job returns 404', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const jobB = await createJob(projB.id, alice.token);
    expect((await api(server, `/api/projects/${projA.id}/jobs/${jobB.data.id}/cancel`, { method: 'POST', token: alice.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${projA.id}/jobs/job_deadbeefdeadbeefdeadbeef/cancel`, { method: 'POST', token: alice.token })).status).toBe(404);
  });
});

// ── 27–28. Existing owner-scoped routes still work ──────────────────────────
describe.skipIf(!CONFIGURED)('project analysis resources — owner-scoped routes unchanged', () => {
  it('existing owner-scoped analysis-object routes still function', async () => {
    const { alice } = await users();
    const created = await api(server, '/api/analysis-objects', { method: 'POST', token: alice.token, body: { objectType: 'seurat' } });
    expect(created.status).toBe(201);
    expect(created.data.id).toMatch(/^ao_[0-9a-f]+$/);
    expect(created.data.projectId).toBeNull(); // owner-scoped create leaves project_id NULL
    const read = await api(server, `/api/analysis-objects/${created.data.id}`, { token: alice.token });
    expect(read.status).toBe(200);
  });

  it('existing owner-scoped job routes still function', async () => {
    const { alice } = await users();
    const created = await api(server, '/api/jobs', { method: 'POST', token: alice.token, body: { jobType: 'normalize' } });
    expect(created.status).toBe(201);
    expect(created.data.projectId).toBeNull();
    expect((await api(server, `/api/jobs/${created.data.id}`, { token: alice.token })).status).toBe(200);
    expect((await api(server, `/api/jobs/${created.data.id}/cancel`, { method: 'POST', token: alice.token })).status).toBe(200);
  });
});

// ── 29. R state proxy / object ownership is UNCHANGED ────────────────────────
// The most important constraint of this branch: project-scoped metadata
// visibility must NOT widen R object/session ownership. A project member can see
// an object's metadata but does NOT become an owner of its R state.
describe.skipIf(!CONFIGURED)('project analysis resources — R state/object ownership unchanged', () => {
  it('project membership does not grant R object ownership', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin'); // even an admin member
    const ao = await createAO(proj.id, alice.token);
    const objId = ao.data.id;

    // Bob can read the metadata via the project route…
    const read = await api(server, `/api/projects/${proj.id}/analysis-objects/${objId}`, { token: bob.token });
    expect(read.status).toBe(200);

    // …but R object ownership is still creator-keyed, NOT project-member-keyed.
    expect(await verifyAnalysisObjectOwner(alice.user.id, objId)).toBe(true);
    expect(await verifyAnalysisObjectOwner(bob.user.id, objId)).toBe(false);
  });

  it('the R proxy object-ownership gate still rejects a project member (404 before reaching R)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'analyst');
    const ao = await createAO(proj.id, alice.token);

    // Bob is a project member who can read the object's metadata, but supplying
    // it as an X-Object-ID to the R proxy is rejected by verifyRObjectOwnership
    // before the request can reach R — proving R state stays owner-verified.
    const res = await api(server, '/api/r/health', { token: bob.token, headers: { 'X-Object-ID': ao.data.id } });
    expect(res.status).toBe(404);
  });

  it('project jobs retain creator ownership for owner-scoped helpers', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin');
    const job = await createJob(proj.id, alice.token);
    // The owner-scoped job-ownership helper is unchanged: the creator owns it,
    // a co-member does not.
    expect(await verifyJobOwner(alice.user.id, job.data.id)).toBe(true);
    expect(await verifyJobOwner(bob.user.id, job.data.id)).toBe(false);
  });
});

describe.skipIf(!CONFIGURED)('project analysis resources — immediate revocation boundaries', () => {
  it('keeps durable reads for viewers but blocks writes, live R use, and legacy route bypasses', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, bob.user.email, 'analyst');
    const object = await createAO(proj.id, bob.token);
    const job = await createJob(proj.id, bob.token, {
      jobType: 'r.object.inspect',
      analysisObjectId: object.data.id,
    });
    const legacyChild = await createAnalysisObjectForUser(bob.user.id, {
      objectType: 'seurat',
      parentObjectId: object.data.id,
    });
    const legacyGrandchild = await createAnalysisObjectForUser(bob.user.id, {
      objectType: 'seurat',
      parentObjectId: legacyChild.id,
    });
    const projectDataset = await createDatasetForProject(bob.user.id, proj.id, {
      fileType: 'seurat_rds',
    });
    const legacyDatasetObject = await createAnalysisObjectForUser(bob.user.id, {
      objectType: 'seurat',
      datasetId: projectDataset.id,
    });
    expect(object.status).toBe(201);
    expect(job.status).toBe(201);

    await updateProjectMemberRole(proj.id, bob.user.id, 'viewer', { userId: alice.user.id });

    expect((await api(server, `/api/projects/${proj.id}/analysis-objects/${object.data.id}`, { token: bob.token })).status).toBe(200);
    expect((await api(server, `/api/projects/${proj.id}/jobs/${job.data.id}`, { token: bob.token })).status).toBe(200);
    expect((await createAO(proj.id, bob.token)).status).toBe(403);
    expect((await createJob(proj.id, bob.token)).status).toBe(403);

    const previousDiagnostics = process.env.ENABLE_R_TEST_DIAGNOSTICS;
    process.env.ENABLE_R_TEST_DIAGNOSTICS = 'true';
    try {
      const r = await api(server, '/api/r/__test/state-key', {
        token: bob.token,
        headers: { 'X-Object-ID': object.data.id },
      });
      expect(r.status).toBe(403);

      const descendantProxy = await api(server, '/api/r/__test/state-key', {
        token: bob.token,
        headers: { 'X-Object-ID': legacyGrandchild.id },
      });
      expect(descendantProxy.status).toBe(404);

      const datasetProxy = await api(server, '/api/r/__test/state-key', {
        token: bob.token,
        headers: { 'X-Object-ID': legacyDatasetObject.id },
      });
      expect(datasetProxy.status).toBe(404);
    } finally {
      if (previousDiagnostics === undefined) delete process.env.ENABLE_R_TEST_DIAGNOSTICS;
      else process.env.ENABLE_R_TEST_DIAGNOSTICS = previousDiagnostics;
    }

    expect((await api(server, `/api/analysis-objects/${object.data.id}`, { token: bob.token })).status).toBe(404);
    expect((await api(server, `/api/analysis-objects/${legacyGrandchild.id}`, { token: bob.token })).status).toBe(404);
    expect((await api(server, `/api/analysis-objects/${legacyDatasetObject.id}`, { token: bob.token })).status).toBe(404);
    expect((await api(server, '/api/analysis-objects', { token: bob.token })).data).toEqual([]);
    expect((await api(server, `/api/jobs/${job.data.id}`, { token: bob.token })).status).toBe(404);
    expect((await api(server, `/api/jobs/${job.data.id}/logs`, { token: bob.token })).status).toBe(404);
    expect((await api(server, `/api/jobs/${job.data.id}/cancel`, { method: 'POST', token: bob.token })).status).toBe(404);
    expect((await api(server, '/api/jobs', { token: bob.token })).data).toEqual([]);
    expect((await api(server, '/api/jobs', {
      method: 'POST', token: bob.token,
      body: { jobType: 'r.object.inspect', analysisObjectId: object.data.id },
    })).status).toBe(404);
    expect((await api(server, '/api/analysis-objects', {
      method: 'POST', token: bob.token,
      body: { objectType: 'seurat', parentObjectId: object.data.id },
    })).status).toBe(404);

    await removeProjectMember(proj.id, bob.user.id, { userId: alice.user.id });
    expect((await api(server, `/api/projects/${proj.id}/analysis-objects/${object.data.id}`, { token: bob.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/jobs/${job.data.id}`, { token: bob.token })).status).toBe(404);

    const diagnosticsBeforeRemovalCheck = process.env.ENABLE_R_TEST_DIAGNOSTICS;
    process.env.ENABLE_R_TEST_DIAGNOSTICS = 'true';
    try {
      const r = await api(server, '/api/r/__test/state-key', {
        token: bob.token,
        headers: { 'X-Object-ID': object.data.id },
      });
      expect(r.status).toBe(404);
    } finally {
      if (diagnosticsBeforeRemovalCheck === undefined) delete process.env.ENABLE_R_TEST_DIAGNOSTICS;
      else process.env.ENABLE_R_TEST_DIAGNOSTICS = diagnosticsBeforeRemovalCheck;
    }
  });
});
