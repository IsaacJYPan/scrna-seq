import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const {
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createDatasetForProject, saveProvenance, saveFigure,
  verifyAnalysisObjectOwner
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

// Project-scoped resource creation helpers (all return { status, data }).
async function createProv(projectId, token, body = {}) {
  return api(server, `/api/projects/${projectId}/provenance`, { method: 'POST', token, body });
}
async function createFig(projectId, token, body = {}) {
  return api(server, `/api/projects/${projectId}/figures`, { method: 'POST', token, body });
}
async function createAO(projectId, token, body = { objectType: 'seurat' }) {
  return api(server, `/api/projects/${projectId}/analysis-objects`, { method: 'POST', token, body });
}
async function createJob(projectId, token, body = { jobType: 'normalize' }) {
  return api(server, `/api/projects/${projectId}/jobs`, { method: 'POST', token, body });
}

// ── 1. Authentication ───────────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — authentication', () => {
  it('rejects unauthenticated access on every provenance/figure route', async () => {
    const routes = [
      ['GET', '/api/projects/proj_x/provenance'],
      ['POST', '/api/projects/proj_x/provenance'],
      ['GET', '/api/projects/proj_x/provenance/prov_abc'],
      ['GET', '/api/projects/proj_x/figures'],
      ['POST', '/api/projects/proj_x/figures'],
      ['GET', '/api/projects/proj_x/figures/fig_abc']
    ];
    for (const [method, path] of routes) {
      const res = await api(server, path, { method, body: method === 'POST' ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── 2. Non-member access → 404 (no existence leak) ──────────────────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — non-member access (404, no leak)', () => {
  it('non-member cannot list/read/create project provenance', async () => {
    const { alice, dave } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await createProv(proj.id, alice.token);
    expect((await api(server, `/api/projects/${proj.id}/provenance`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/provenance/${created.data.id}`, { token: dave.token })).status).toBe(404);
    expect((await createProv(proj.id, dave.token)).status).toBe(404);
  });

  it('non-member cannot list/read/create project figures', async () => {
    const { alice, dave } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await createFig(proj.id, alice.token, { plotType: 'UMAP' });
    expect((await api(server, `/api/projects/${proj.id}/figures`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/figures/${created.data.id}`, { token: dave.token })).status).toBe(404);
    expect((await createFig(proj.id, dave.token, { plotType: 'UMAP' })).status).toBe(404);
  });
});

// ── 3. Viewer read access (read yes, create no) ─────────────────────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — viewer read access', () => {
  it('viewer can list/read project provenance but cannot create (403)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    const created = await createProv(proj.id, alice.token, { operation: 'normalize', script: 'NormalizeData(obj)' });

    const list = await api(server, `/api/projects/${proj.id}/provenance`, { token: bob.token });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);

    const read = await api(server, `/api/projects/${proj.id}/provenance/${created.data.id}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.data.id).toBe(created.data.id);
    expect(read.data.projectId).toBe(proj.id);

    expect((await createProv(proj.id, bob.token)).status).toBe(403);
  });

  it('viewer can list/read project figures but cannot create (403)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');
    const created = await createFig(proj.id, alice.token, { plotType: 'UMAP', title: 'Clusters' });

    const list = await api(server, `/api/projects/${proj.id}/figures`, { token: bob.token });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);

    const read = await api(server, `/api/projects/${proj.id}/figures/${created.data.id}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.data.id).toBe(created.data.id);
    expect(read.data.projectId).toBe(proj.id);

    expect((await createFig(proj.id, bob.token, { plotType: 'UMAP' })).status).toBe(403);
  });
});

// ── 4. Create authorization by role ─────────────────────────────────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — create authorization', () => {
  it('owner/admin/analyst can create project provenance (201) with server-set identity', async () => {
    const { alice, bob, carol } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin');
    await addMember(proj.id, 'carol@example.com', 'analyst');
    for (const actor of [alice, bob, carol]) {
      const res = await createProv(proj.id, actor.token, { operation: 'cluster' });
      expect(res.status, actor.user.email).toBe(201);
      expect(res.data.id).toMatch(/^prov_[0-9a-f]+$/);
      expect(res.data.projectId).toBe(proj.id);
      expect(res.data.createdByUserId).toBe(actor.user.id);
    }
  });

  it('owner/admin/analyst can create project figures (201) with server-set identity', async () => {
    const { alice, bob, carol } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin');
    await addMember(proj.id, 'carol@example.com', 'analyst');
    for (const actor of [alice, bob, carol]) {
      const res = await createFig(proj.id, actor.token, { plotType: 'FeaturePlot' });
      expect(res.status, actor.user.email).toBe(201);
      expect(res.data.id).toMatch(/^fig_[0-9a-f]+$/);
      expect(res.data.projectId).toBe(proj.id);
      expect(res.data.createdByUserId).toBe(actor.user.id);
    }
  });
});

// ── 5. Server-controlled identity & rejected fields ─────────────────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — server-controlled identity', () => {
  it('provenance: rejects client-provided id/owner/creator/actor/project fields (400)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    const fields = {
      id: 'prov_clientchosen',
      projectId: 'proj_other', project_id: 'proj_other',
      userId: bob.user.id, user_id: bob.user.id,
      ownerUserId: bob.user.id, owner_user_id: bob.user.id,
      createdByUserId: bob.user.id, created_by_user_id: bob.user.id,
      userEmail: 'bob@example.com', user_email: 'bob@example.com'
    };
    for (const [field, value] of Object.entries(fields)) {
      const res = await createProv(proj.id, alice.token, { operation: 'normalize', [field]: value });
      expect(res.status, `provenance ${field}`).toBe(400);
    }
  });

  it('figure: rejects client-provided id/owner/creator/actor/project fields (400)', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    const fields = {
      id: 'fig_clientchosen',
      projectId: 'proj_other', project_id: 'proj_other',
      userId: bob.user.id, user_id: bob.user.id,
      ownerUserId: bob.user.id, owner_user_id: bob.user.id,
      createdByUserId: bob.user.id, created_by_user_id: bob.user.id,
      userEmail: 'bob@example.com', user_email: 'bob@example.com'
    };
    for (const [field, value] of Object.entries(fields)) {
      const res = await createFig(proj.id, alice.token, { plotType: 'UMAP', [field]: value });
      expect(res.status, `figure ${field}`).toBe(400);
    }
  });

  it('server sets project_id from the route, not the body', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const prov = await createProv(projA.id, alice.token);
    expect(prov.data.projectId).toBe(projA.id);
    const fig = await createFig(projA.id, alice.token, { plotType: 'UMAP' });
    expect(fig.data.projectId).toBe(projA.id);
    // (the projB id is never honored even when a client tries — covered above by
    // the projectId-rejection cases.)
    expect(projB.id).not.toBe(projA.id);
  });
});

// ── 6. SECURITY: figure file_path / storage key / raw path is never accepted ─
describe.skipIf(!CONFIGURED)('project figures — no file path / storage key surface', () => {
  it('rejects every client-supplied file path / storage key field (400)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const pathFields = [
      'filePath', 'file_path', 'storageKey', 'storage_key', 'storageUri', 'storage_uri',
      'internalStorageKey', 'internal_storage_key', 'path'
    ];
    for (const field of pathFields) {
      const res = await createFig(proj.id, alice.token, { plotType: 'UMAP', [field]: '/etc/passwd' });
      expect(res.status, `figure ${field}`).toBe(400);
    }
  });

  it('figure API responses never expose a raw filesystem path', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const created = await createFig(proj.id, alice.token, { plotType: 'UMAP', title: 'Clusters' });
    expect(created.status).toBe(201);

    const read = await api(server, `/api/projects/${proj.id}/figures/${created.data.id}`, { token: alice.token });
    const list = await api(server, `/api/projects/${proj.id}/figures`, { token: alice.token });

    // Assert specific forbidden keys are absent rather than scanning for '/',
    // since a legitimate base64 thumbnail can contain '/'.
    const forbiddenKeys = [
      'file_path', 'filePath', 'storageKey', 'storage_key', 'storageUri', 'storage_uri',
      'internalStorageKey', 'internal_storage_key', 'path'
    ];
    for (const fig of [created.data, read.data, ...list.data]) {
      for (const key of forbiddenKeys) {
        expect(key in fig, `figure exposes ${key}`).toBe(false);
      }
    }
  });
});

// ── 7. References cannot cross the project ──────────────────────────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — references stay within the project', () => {
  it('provenance same-project dataset/object/job/result references succeed (201)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const ds = await datasetIn(alice.user.id, proj.id);
    const ao = await createAO(proj.id, alice.token);
    const job = await createJob(proj.id, alice.token);
    const res = await createProv(proj.id, alice.token, {
      operation: 'normalize',
      datasetId: ds.id,
      analysisObjectId: ao.data.id,
      jobId: job.data.id,
      resultAnalysisObjectId: ao.data.id
    });
    expect(res.status).toBe(201);
    expect(res.data.datasetId).toBe(ds.id);
    expect(res.data.analysisObjectId).toBe(ao.data.id);
    expect(res.data.jobId).toBe(job.data.id);
    expect(res.data.resultAnalysisObjectId).toBe(ao.data.id);
  });

  it('a two-project member cannot reference project B dataset/object/job from project A provenance (404)', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const dsB = await datasetIn(alice.user.id, projB.id);
    const aoB = await createAO(projB.id, alice.token);
    const jobB = await createJob(projB.id, alice.token);

    expect((await createProv(projA.id, alice.token, { datasetId: dsB.id })).status).toBe(404);
    expect((await createProv(projA.id, alice.token, { analysisObjectId: aoB.data.id })).status).toBe(404);
    expect((await createProv(projA.id, alice.token, { jobId: jobB.data.id })).status).toBe(404);
    expect((await createProv(projA.id, alice.token, { resultAnalysisObjectId: aoB.data.id })).status).toBe(404);
  });

  it('provenance parentIds must be same-project provenance', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const parentA = await createProv(projA.id, alice.token);
    const parentB = await createProv(projB.id, alice.token);

    const ok = await createProv(projA.id, alice.token, { parentIds: [parentA.data.id] });
    expect(ok.status).toBe(201);
    expect(ok.data.parentIds).toEqual([parentA.data.id]);

    expect((await createProv(projA.id, alice.token, { parentIds: [parentB.data.id] })).status).toBe(404);
  });

  it('figure same-project object/job/provenance/dataset references succeed (201)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const ds = await datasetIn(alice.user.id, proj.id);
    const ao = await createAO(proj.id, alice.token);
    const job = await createJob(proj.id, alice.token);
    const prov = await createProv(proj.id, alice.token);
    const res = await createFig(proj.id, alice.token, {
      plotType: 'UMAP',
      analysisObjectId: ao.data.id,
      jobId: job.data.id,
      provenanceId: prov.data.id,
      datasetId: ds.id
    });
    expect(res.status).toBe(201);
    expect(res.data.analysisObjectId).toBe(ao.data.id);
    expect(res.data.jobId).toBe(job.data.id);
    expect(res.data.provenanceId).toBe(prov.data.id);
    expect(res.data.datasetId).toBe(ds.id);
  });

  it('a two-project member cannot reference project B object/job/provenance from project A figure (404)', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const aoB = await createAO(projB.id, alice.token);
    const jobB = await createJob(projB.id, alice.token);
    const provB = await createProv(projB.id, alice.token);

    expect((await createFig(projA.id, alice.token, { plotType: 'UMAP', analysisObjectId: aoB.data.id })).status).toBe(404);
    expect((await createFig(projA.id, alice.token, { plotType: 'UMAP', jobId: jobB.data.id })).status).toBe(404);
    expect((await createFig(projA.id, alice.token, { plotType: 'UMAP', provenanceId: provB.data.id })).status).toBe(404);
  });

  it('unknown (well-formed) references return 404', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    expect((await createProv(proj.id, alice.token, { datasetId: 'ds_deadbeefdeadbeefdeadbeef' })).status).toBe(404);
    expect((await createProv(proj.id, alice.token, { analysisObjectId: 'ao_deadbeefdeadbeefdeadbeef' })).status).toBe(404);
    expect((await createProv(proj.id, alice.token, { jobId: 'job_deadbeefdeadbeefdeadbeef' })).status).toBe(404);
    expect((await createProv(proj.id, alice.token, { parentIds: ['prov_deadbeefdeadbeefdeadbeef'] })).status).toBe(404);
    expect((await createFig(proj.id, alice.token, { plotType: 'UMAP', provenanceId: 'prov_deadbeefdeadbeefdeadbeef' })).status).toBe(404);
  });

  it('cross-project reads return 404', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const provB = await createProv(projB.id, alice.token);
    const figB = await createFig(projB.id, alice.token, { plotType: 'UMAP' });

    expect((await api(server, `/api/projects/${projA.id}/provenance/${provB.data.id}`, { token: alice.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${projA.id}/figures/${figB.data.id}`, { token: alice.token })).status).toBe(404);
  });
});

// ── 8. Malformed ids → 400 ──────────────────────────────────────────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — malformed ids', () => {
  it('returns 400 for malformed provenance ids (path + reference fields)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    for (const bad of ['not-an-id', 'prov_NOTHEX', 'prov_', 'fig_abc']) {
      expect((await api(server, `/api/projects/${proj.id}/provenance/${bad}`, { token: alice.token })).status, bad).toBe(400);
    }
    expect((await createProv(proj.id, alice.token, { datasetId: 'bad' })).status).toBe(400);
    expect((await createProv(proj.id, alice.token, { analysisObjectId: 'bad' })).status).toBe(400);
    expect((await createProv(proj.id, alice.token, { jobId: 'bad' })).status).toBe(400);
    expect((await createProv(proj.id, alice.token, { resultAnalysisObjectId: 'bad' })).status).toBe(400);
    expect((await createProv(proj.id, alice.token, { parentIds: ['bad'] })).status).toBe(400);
    expect((await createProv(proj.id, alice.token, { parentIds: 'notarray' })).status).toBe(400);
  });

  it('returns 400 for malformed figure ids (path + reference fields)', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    for (const bad of ['not-an-id', 'fig_NOTHEX', 'fig_', 'prov_abc']) {
      expect((await api(server, `/api/projects/${proj.id}/figures/${bad}`, { token: alice.token })).status, bad).toBe(400);
    }
    expect((await createFig(proj.id, alice.token, { plotType: 'UMAP', analysisObjectId: 'bad' })).status).toBe(400);
    expect((await createFig(proj.id, alice.token, { plotType: 'UMAP', jobId: 'bad' })).status).toBe(400);
    expect((await createFig(proj.id, alice.token, { plotType: 'UMAP', provenanceId: 'bad' })).status).toBe(400);
    expect((await createFig(proj.id, alice.token, { plotType: 'UMAP', datasetId: 'bad' })).status).toBe(400);
  });
});

// ── 9. Legacy NULL project_id rows do not leak into project routes ──────────
describe.skipIf(!CONFIGURED)('project provenance/figures — legacy NULL-project rows do not leak', () => {
  it('legacy user-scoped provenance (NULL project_id) is invisible to project routes', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    // Seed a legacy, owner-scoped provenance row (no project_id) directly.
    const legacyId = 'prov_deadbeefdeadbeefdeadbeef';
    await saveProvenance({
      userEmail: 'alice@example.com',
      provenance: {
        id: legacyId, timestamp: 't', language: 'R', languageVersion: '4.5',
        packages: ['Seurat'], script: 's', parameters: {}, parentIds: [], operation: 'normalize'
      }
    });
    // A project-scoped record exists in the project so the list is non-trivially filtered.
    const projRow = await createProv(proj.id, alice.token);

    const list = await api(server, `/api/projects/${proj.id}/provenance`, { token: alice.token });
    expect(list.status).toBe(200);
    expect(list.data.map(p => p.id)).toEqual([projRow.data.id]);
    expect(list.data.map(p => p.id)).not.toContain(legacyId);

    // Direct read through the project route is 404 (NULL project_id never matches).
    expect((await api(server, `/api/projects/${proj.id}/provenance/${legacyId}`, { token: alice.token })).status).toBe(404);
  });

  it('legacy user-scoped figure (NULL project_id, with a file_path) is invisible to project routes', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    const legacyId = 'fig_deadbeefdeadbeefdeadbeef';
    await saveFigure({
      id: legacyId, userEmail: 'alice@example.com', plotType: 'UMAP', params: {},
      filePath: 'exports/user-1/UMAP_20260101_000000_abcd.png', fileFormat: 'png', thumbnailB64: ''
    });
    const projRow = await createFig(proj.id, alice.token, { plotType: 'UMAP' });

    const list = await api(server, `/api/projects/${proj.id}/figures`, { token: alice.token });
    expect(list.status).toBe(200);
    expect(list.data.map(f => f.id)).toEqual([projRow.data.id]);
    expect(list.data.map(f => f.id)).not.toContain(legacyId);

    expect((await api(server, `/api/projects/${proj.id}/figures/${legacyId}`, { token: alice.token })).status).toBe(404);
  });
});

// ── 10. Project list/read returns only that project's records ───────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — project isolation of list/read', () => {
  it('list returns only the route project\'s provenance and figures', async () => {
    const { alice } = await users();
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const provA = await createProv(projA.id, alice.token);
    await createProv(projB.id, alice.token);
    const figA = await createFig(projA.id, alice.token, { plotType: 'UMAP' });
    await createFig(projB.id, alice.token, { plotType: 'UMAP' });

    const provList = await api(server, `/api/projects/${projA.id}/provenance`, { token: alice.token });
    expect(provList.data.map(p => p.id)).toEqual([provA.data.id]);
    const figList = await api(server, `/api/projects/${projA.id}/figures`, { token: alice.token });
    expect(figList.data.map(f => f.id)).toEqual([figA.data.id]);
  });
});

// ── 11. R boundary regression ───────────────────────────────────────────────
// The most important constraint: associating an analysis object with a project
// provenance/figure record (metadata) must NOT widen R object/session ownership.
describe.skipIf(!CONFIGURED)('project provenance/figures — R object/state ownership unchanged', () => {
  it('a co-member who can read figure metadata referencing an object still cannot use it via /api/r/*', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin'); // even an admin co-member
    const ao = await createAO(proj.id, alice.token);

    // Bob (admin) creates a figure referencing Alice's object — allowed as metadata.
    const fig = await createFig(proj.id, bob.token, { plotType: 'UMAP', analysisObjectId: ao.data.id });
    expect(fig.status).toBe(201);
    expect(fig.data.analysisObjectId).toBe(ao.data.id);

    // R object ownership is still creator-keyed, NOT project-member-keyed.
    expect(await verifyAnalysisObjectOwner(alice.user.id, ao.data.id)).toBe(true);
    expect(await verifyAnalysisObjectOwner(bob.user.id, ao.data.id)).toBe(false);

    // Supplying that object id as an X-Object-ID to the R proxy is rejected before
    // the request can reach R — metadata visibility is not live R state access.
    const res = await api(server, '/api/r/health', { token: bob.token, headers: { 'X-Object-ID': ao.data.id } });
    expect(res.status).toBe(404);
  });
});

// ── 12. Owner-scoped provenance/figure routes unchanged ─────────────────────
describe.skipIf(!CONFIGURED)('project provenance/figures — owner-scoped routes unchanged', () => {
  it('existing owner-scoped provenance routes still function and stay disjoint', async () => {
    const { alice } = await users();
    const proj = await seedProject(alice.user.id);
    // Owner-scoped create (client-supplied id, user_email-keyed).
    const env = {
      provenance: {
        id: 'prov_legacyowner0001', timestamp: 't', language: 'R', languageVersion: '4.5',
        packages: [], script: 's', parameters: {}, parentIds: [], operation: 'normalize'
      }
    };
    const saved = await api(server, '/api/db/provenance', { method: 'POST', token: alice.token, body: env });
    expect(saved.status).toBe(200);
    const ownerList = await api(server, '/api/db/provenance', { token: alice.token });
    expect(ownerList.data.map(p => p.id)).toContain('prov_legacyowner0001');

    // The owner-scoped row does NOT appear in the project route (NULL project_id).
    const projList = await api(server, `/api/projects/${proj.id}/provenance`, { token: alice.token });
    expect(projList.data.map(p => p.id)).not.toContain('prov_legacyowner0001');
  });

  it('existing owner-scoped figure routes still function', async () => {
    const { alice } = await users();
    const saved = await api(server, '/api/db/figures', {
      method: 'POST', token: alice.token,
      body: { id: 'fig_legacyowner0001', plotType: 'UMAP', params: {}, fileFormat: 'png' }
    });
    expect(saved.status).toBe(200);
    const list = await api(server, '/api/db/figures', { token: alice.token });
    expect(list.data.map(f => f.id)).toContain('fig_legacyowner0001');
  });
});

// ── 13. Legacy owner-scoped save cannot clobber project-scoped provenance ────
// Regression for the B-1 finding: `_insertProv` is INSERT OR REPLACE keyed on
// the primary key alone, so without an ownership guard the legacy owner-scoped
// `POST /api/db/provenance` could overwrite a project-scoped row (user_email = '')
// — or another user's row — and re-home it onto the caller's owner-scoped surface.
function legacyProvBody(id, script, operation = 'pwned') {
  return {
    provenance: {
      id, timestamp: 't', language: 'R', languageVersion: '4.5',
      packages: [], script, parameters: {}, parentIds: [], operation
    }
  };
}

describe.skipIf(!CONFIGURED)('project provenance — legacy owner-scoped save cannot clobber project rows', () => {
  it('a project viewer cannot overwrite/hijack a project provenance record via legacy POST /api/db/provenance', async () => {
    const { alice, bob } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'viewer');

    const created = await createProv(proj.id, alice.token, { operation: 'normalize', script: 'NormalizeData(obj)' });
    expect(created.status).toBe(201);
    const provId = created.data.id;

    // viewer can read/list the project provenance through the project route …
    const list = await api(server, `/api/projects/${proj.id}/provenance`, { token: bob.token });
    expect(list.status).toBe(200);
    expect(list.data.map(p => p.id)).toContain(provId);
    expect((await api(server, `/api/projects/${proj.id}/provenance/${provId}`, { token: bob.token })).status).toBe(200);

    // … but cannot create project provenance through the project route.
    expect((await createProv(proj.id, bob.token, { operation: 'x' })).status).toBe(403);

    // viewer attempts the legacy route reusing the project provenance id → 404.
    const clobber = await api(server, '/api/db/provenance', {
      method: 'POST', token: bob.token, body: legacyProvBody(provId, 'HIJACKED')
    });
    expect(clobber.status).toBe(404);

    // original project provenance still exists and is byte-for-byte unchanged.
    const after = await api(server, `/api/projects/${proj.id}/provenance/${provId}`, { token: alice.token });
    expect(after.status).toBe(200);
    expect(after.data.id).toBe(provId);
    expect(after.data.projectId).toBe(proj.id);
    expect(after.data.script).toBe('NormalizeData(obj)');
    expect(after.data.operation).toBe('normalize');

    // viewer's owner-scoped provenance list does not contain the hijacked row.
    const bobOwned = await api(server, '/api/db/provenance', { token: bob.token });
    expect(bobOwned.status).toBe(200);
    expect(bobOwned.data.map(p => p.id)).not.toContain(provId);
  });

  it('even the creating owner/admin/analyst cannot mutate a project provenance row via the legacy route', async () => {
    const { alice, bob, carol } = await users();
    const proj = await seedProject(alice.user.id);
    await addMember(proj.id, 'bob@example.com', 'admin');
    await addMember(proj.id, 'carol@example.com', 'analyst');

    for (const actor of [alice, bob, carol]) {
      const created = await createProv(proj.id, actor.token, { operation: 'cluster', script: 'orig' });
      expect(created.status, actor.user.email).toBe(201);
      const provId = created.data.id;

      // The actor created it through the project route, yet the legacy owner-scoped
      // route still refuses to touch it (project provenance is append-only there).
      const clobber = await api(server, '/api/db/provenance', {
        method: 'POST', token: actor.token, body: legacyProvBody(provId, 'HIJACKED')
      });
      expect(clobber.status, actor.user.email).toBe(404);

      const after = await api(server, `/api/projects/${proj.id}/provenance/${provId}`, { token: actor.token });
      expect(after.data.script, actor.user.email).toBe('orig');
      const owned = await api(server, '/api/db/provenance', { token: actor.token });
      expect(owned.data.map(p => p.id), actor.user.email).not.toContain(provId);
    }
  });

  it('legacy owner-scoped provenance create/update still works, but cross-user overwrite is blocked', async () => {
    const { alice, bob } = await users();
    const legacyId = 'prov_legacyowner0002';

    // Create own owner-scoped row, then update it (same id, same owner) — both 200.
    expect((await api(server, '/api/db/provenance', { method: 'POST', token: alice.token, body: legacyProvBody(legacyId, 'v1', 'normalize') })).status).toBe(200);
    expect((await api(server, '/api/db/provenance', { method: 'POST', token: alice.token, body: legacyProvBody(legacyId, 'v2', 'normalize') })).status).toBe(200);
    const aliceList = await api(server, '/api/db/provenance', { token: alice.token });
    expect(aliceList.data.find(p => p.id === legacyId).script).toBe('v2');

    // A different user cannot overwrite it by reusing the id → 404; original preserved.
    expect((await api(server, '/api/db/provenance', { method: 'POST', token: bob.token, body: legacyProvBody(legacyId, 'bob-overwrite', 'normalize') })).status).toBe(404);
    const aliceList2 = await api(server, '/api/db/provenance', { token: alice.token });
    expect(aliceList2.data.find(p => p.id === legacyId).script).toBe('v2');
    expect((await api(server, '/api/db/provenance', { token: bob.token })).data.map(p => p.id)).not.toContain(legacyId);
  });
});
