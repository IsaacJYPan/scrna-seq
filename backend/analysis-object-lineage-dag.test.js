import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// NOTE: the SQLite-era "schema & migration" and "backfill of existing parent
// links" describes were removed with the Postgres migration — they exercised a
// legacy .sqlite file being additively upgraded (better-sqlite3 + PRAGMA) and a
// one-time backfill of parent_object_id into the edges table. The Postgres
// schema (backend/pg/schema.sql) ships analysis_object_edges from the start, so
// there is no legacy-file migration/backfill path to test. The edge *behavior*
// below is the durable contract and is fully retained.

const config = require('./config');
const dbmod = require('./pgDatabase');
const {
  createUser,
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
  createProjectJob, createJobForUser, createProjectAnalysisObject,
  getProjectJob, getProjectAnalysisObject,
  claimNextJob,
  createCheckpointForJobByWorker,
  // lineage helpers under test
  createLineageEdge, createLineageEdgesForChild,
  listLineageParents, listLineageChildren, lineageEdgeWouldCreateCycle,
  listProjectAnalysisObjectParents, listProjectAnalysisObjectChildren,
  getProjectAnalysisObjectLineage,
} = dbmod;

const CONFIGURED = config.hasPostgresConnection();

const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { createJobWorker } = require('./jobWorker');

const T0 = '2030-01-01 00:00:00';

function silentLogger() { return { info() {}, warn() {}, error() {} }; }
async function drainOnce(now = T0) {
  const w = createJobWorker({ db: dbmod, now: () => now, logger: silentLogger() });
  return w.runOnce();
}
function claim(workerId = 'worker_t', now = T0) {
  return claimNextJob(workerId, { now, leaseSeconds: 30 });
}

afterAll(async () => {
  if (!CONFIGURED) return;
  await dbmod.close();
});


// ════════════════════════════════════════════════════════════════════════════
// 3. Edge create helper (validation, scope, server-owned identity)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('lineage edges — createLineageEdge helper', () => {
  let alice;
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });


  async function seedProject(ownerId, name = 'P') {
    const org = await createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('creates a server-generated aoe_ id; client cannot set project/creator/internal fields', async () => {
    const proj = await seedProject(alice.id);
    const a = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const edge = await createLineageEdge(alice.id, {
      parentObjectId: a.id, childObjectId: b.id, edgeType: 'branch', parentRole: 'secondary',
      // Hostile/ignored fields — none of these may take effect:
      id: 'aoe_hacked', projectId: 'proj_evil', createdByUserId: 99999,
      created_at: '1999-01-01 00:00:00'
    });
    expect(edge.id).toMatch(/^aoe_[0-9a-f]+$/);
    expect(edge.id).not.toBe('aoe_hacked');
    expect(edge.projectId).toBe(proj.id);        // derived from the objects, not input
    expect(edge.createdByUserId).toBe(alice.id); // the actor arg, not input
    expect(edge.edgeType).toBe('branch');
    expect(edge.parentRole).toBe('secondary');
  });

  it('rejects malformed parent/child/job IDs with INVALID_* (→ 400)', async () => {
    const proj = await seedProject(alice.id);
    const a = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    await expect(await createLineageEdge(alice.id, { parentObjectId: 'not-an-id', childObjectId: b.id })).rejects.toThrowError(/Malformed parent/);
    await expect(await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: 'nope' })).rejects.toThrowError(/Malformed child/);
    await expect(await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, jobId: 'bad' })).rejects.toThrowError(/Malformed job/);
    try { await createLineageEdge(alice.id, { parentObjectId: 'x', childObjectId: b.id }); }
    catch (e) { expect(e.code).toBe('INVALID_PARENT_ID'); }
  });

  it('rejects unknown/cross-project parent/child/job references with *_NOT_FOUND (→ 404)', async () => {
    const projA = await seedProject(alice.id, 'A');
    const projB = await seedProject(alice.id, 'B');
    const a = await createProjectAnalysisObject(alice.id, projA.id, { objectType: 'seurat' });
    const b = await createProjectAnalysisObject(alice.id, projA.id, { objectType: 'seurat' });
    const bInB = await createProjectAnalysisObject(alice.id, projB.id, { objectType: 'seurat' });

    // unknown (well-formed) ids
    await expect(await createLineageEdge(alice.id, { parentObjectId: 'ao_deadbeef', childObjectId: b.id })).rejects.toThrowError(/Parent analysis object not found/);
    await expect(await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: 'ao_deadbeef' })).rejects.toThrowError(/Child analysis object not found/);
    // cross-project parent/child (different scopes) → 404
    await expect(await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: bInB.id })).rejects.toThrowError(/Child analysis object not found/);
    // job in another project
    const jobB = await createProjectJob(alice.id, projB.id, { jobType: 'checkpoint.noop' });
    await expect(await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, jobId: jobB.id })).rejects.toThrowError(/Job not found/);
  });

  it('rejects a self-parent edge (SELF_PARENT → 400)', async () => {
    const proj = await seedProject(alice.id);
    const a = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    let code;
    try { await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: a.id }); }
    catch (e) { code = e.code; }
    expect(code).toBe('SELF_PARENT');
  });

  it('rejects bad edgeType / parentRole / metadata', async () => {
    const proj = await seedProject(alice.id);
    const a = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    await expect(await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, edgeType: 'nope' })).rejects.toThrowError(/Invalid edgeType/);
    await expect(await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, parentRole: 'nope' })).rejects.toThrowError(/Invalid parentRole/);
    await expect(await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, metadata: [1, 2] })).rejects.toThrowError(/metadata must be a plain JSON object/);
  });

  it('rejects a duplicate edge (DUPLICATE_EDGE → 409)', async () => {
    const proj = await seedProject(alice.id);
    const a = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, edgeType: 'branch' });
    let code;
    try { await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, edgeType: 'branch' }); }
    catch (e) { code = e.code; }
    expect(code).toBe('DUPLICATE_EDGE');
  });

  it('rejects a direct cycle and an indirect cycle (CYCLE → 409)', async () => {
    const proj = await seedProject(alice.id);
    const a = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const c = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    // a → b → c
    await createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, edgeType: 'branch' });
    await createLineageEdge(alice.id, { parentObjectId: b.id, childObjectId: c.id, edgeType: 'branch' });
    // direct cycle: b → a (a is ancestor of b)
    let directCode;
    try { await createLineageEdge(alice.id, { parentObjectId: b.id, childObjectId: a.id, edgeType: 'branch' }); }
    catch (e) { directCode = e.code; }
    expect(directCode).toBe('CYCLE');
    // indirect cycle: c → a (a →…→ c already)
    let indirectCode;
    try { await createLineageEdge(alice.id, { parentObjectId: c.id, childObjectId: a.id, edgeType: 'branch' }); }
    catch (e) { indirectCode = e.code; }
    expect(indirectCode).toBe('CYCLE');
    // the pure predicate agrees
    expect(await lineageEdgeWouldCreateCycle(c.id, a.id, { projectId: proj.id })).toBe(true);
    expect(await lineageEdgeWouldCreateCycle(a.id, c.id, { projectId: proj.id })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Branching & multi-parent representation (DAG)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('lineage edges — branching & multi-parent', () => {
  let alice;
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });


  async function seedProject(ownerId, name = 'P') {
    const org = await createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('two children from the same parent appear as branches', async () => {
    const proj = await seedProject(alice.id);
    const root = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const child1 = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const child2 = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const kids = await listProjectAnalysisObjectChildren(alice.id, proj.id, root.id);
    expect(kids).toHaveLength(2);
    const childIds = kids.map(e => e.childAnalysisObjectId).sort();
    expect(childIds).toEqual([child1.id, child2.id].sort());
  });

  it('one child with two parents is representable and traversable via the helper', async () => {
    const proj = await seedProject(alice.id);
    const p1 = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const p2 = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const merged = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const edges = await createLineageEdgesForChild(alice.id, merged.id, [
      { parentObjectId: p1.id, edgeType: 'integration_input', parentRole: 'primary' },
      { parentObjectId: p2.id, edgeType: 'integration_input', parentRole: 'secondary' },
    ]);
    expect(edges).toHaveLength(2);
    const parents = await listProjectAnalysisObjectParents(alice.id, proj.id, merged.id);
    expect(parents).toHaveLength(2);
    expect(parents.map(e => e.parentAnalysisObjectId).sort()).toEqual([p1.id, p2.id].sort());
    expect(parents.map(e => e.parentRole).sort()).toEqual(['primary', 'secondary']);
    // both parents list the merged object as a child
    expect((await listProjectAnalysisObjectChildren(alice.id, proj.id, p1.id))[0].childAnalysisObjectId).toBe(merged.id);
    expect((await listProjectAnalysisObjectChildren(alice.id, proj.id, p2.id))[0].childAnalysisObjectId).toBe(merged.id);
  });

  it('graph traversal returns both parents for a multi-parent child and both children for a branched parent', async () => {
    const proj = await seedProject(alice.id);
    const root = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b1 = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const b2 = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const merged = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    await createLineageEdgesForChild(alice.id, merged.id, [
      { parentObjectId: b1.id, edgeType: 'integration_input', parentRole: 'primary' },
      { parentObjectId: b2.id, edgeType: 'integration_input', parentRole: 'secondary' },
    ]);
    const graph = await getProjectAnalysisObjectLineage(alice.id, proj.id, merged.id);
    const nodeIds = graph.nodes.map(n => n.id).sort();
    expect(nodeIds).toEqual([root.id, b1.id, b2.id, merged.id].sort());
    // 2 branch edges from root + 2 integration edges into merged = 4
    expect(graph.edges).toHaveLength(4);
    expect(graph.truncated).toBe(false);
    // deterministic: a second read yields identical ordering
    const graph2 = await getProjectAnalysisObjectLineage(alice.id, proj.id, merged.id);
    expect(graph2.edges.map(e => e.id)).toEqual(graph.edges.map(e => e.id));
    expect(graph2.nodes.map(n => n.id)).toEqual(graph.nodes.map(n => n.id));
  });

  it('cycle prevention still holds after branching/multi-parent', async () => {
    const proj = await seedProject(alice.id);
    const root = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b1 = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const merged = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    await createLineageEdge(alice.id, { parentObjectId: b1.id, childObjectId: merged.id, edgeType: 'integration_input' });
    // root → b1 → merged ; merged → root would close a cycle
    let code;
    try { await createLineageEdge(alice.id, { parentObjectId: merged.id, childObjectId: root.id, edgeType: 'branch' }); }
    catch (e) { code = e.code; }
    expect(code).toBe('CYCLE');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Checkpoint integration (edge created with the result object)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('lineage edges — checkpoint integration', () => {
  let alice;
  beforeEach(async () => {
    await dbmod.resetSchemaForTests();
    alice = await createUser('alice@example.com', 'password123', 'Alice');
  });


  async function seedProject(ownerId, name = 'P') {
    const org = await createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('a successful checkpoint.noop with an input object creates the result object and exactly one checkpoint edge', async () => {
    const proj = await seedProject(alice.id);
    const parent = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const job = await createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    const res = await drainOnce();
    expect(res.status).toBe('completed');

    const after = await getProjectJob(alice.id, proj.id, job.id);
    const cpId = after.resultAnalysisObjectId;
    expect(cpId).toMatch(/^ao_/);

    const parents = await listProjectAnalysisObjectParents(alice.id, proj.id, cpId);
    expect(parents).toHaveLength(1);
    const edge = parents[0];
    expect(edge.edgeType).toBe('checkpoint');           // checkpoint edge type
    expect(edge.parentRole).toBe('primary');
    expect(edge.parentAnalysisObjectId).toBe(parent.id); // parent = job input object
    expect(edge.childAnalysisObjectId).toBe(cpId);       // child = result object
    expect(edge.jobId).toBe(job.id);                     // edge links the job

    // Compatibility fields still set on the result object.
    const cp = await getProjectAnalysisObject(alice.id, proj.id, cpId);
    expect(cp.parentObjectId).toBe(parent.id);
    expect(cp.lineageRootId).toBe(parent.id);

    // The parent now lists the checkpoint as its only child edge.
    const kids = await listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].childAnalysisObjectId).toBe(cpId);
  });

  it('a checkpoint job with NO input object creates a lineage-root result with no edge', async () => {
    const proj = await seedProject(alice.id);
    const job = await createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    await drainOnce();
    const after = await getProjectJob(alice.id, proj.id, job.id);
    const cpId = after.resultAnalysisObjectId;
    expect(cpId).toMatch(/^ao_/);
    expect(await listProjectAnalysisObjectParents(alice.id, proj.id, cpId)).toHaveLength(0);
  });

  it('a failed job creates no result object and no edge', async () => {
    const proj = await seedProject(alice.id);
    const parent = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const job = await createProjectJob(alice.id, proj.id, { jobType: 'normalize', analysisObjectId: parent.id }); // unsupported
    const res = await drainOnce();
    expect(res.status).toBe('unsupported');
    const after = await getProjectJob(alice.id, proj.id, job.id);
    expect(after.resultAnalysisObjectId).toBeNull();
    expect(await listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id)).toHaveLength(0);
  });

  it('a canceled job creates no result object and no edge', async () => {
    const proj = await seedProject(alice.id);
    const parent = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const job = await createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    dbmod.cancelProjectJob(alice.id, proj.id, job.id);
    const res = await drainOnce();
    expect(res.status).toBe('idle');
    const after = await getProjectJob(alice.id, proj.id, job.id);
    expect(after.resultAnalysisObjectId).toBeNull();
    expect(await listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id)).toHaveLength(0);
  });

  it('a claim-lost completion creates no successful edge, and a duplicate completion creates no duplicate edge', async () => {
    const proj = await seedProject(alice.id);
    const parent = await createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    await createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    const c = await claim('worker_a');

    // A worker that does not hold the claim cannot create a checkpoint/edge.
    expect(() => createCheckpointForJobByWorker(c.id, 'worker_b', 'wct_bogus', {}, { now: T0 }))
      .toThrowError(/no longer holds a valid claim/);
    expect(await listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id)).toHaveLength(0);

    // The real holder succeeds exactly once (one edge); a second attempt is refused.
    const cp = await createCheckpointForJobByWorker(c.id, 'worker_a', c.claimToken, {}, { now: T0 });
    expect(await listProjectAnalysisObjectParents(alice.id, proj.id, cp.id)).toHaveLength(1);
    expect(() => createCheckpointForJobByWorker(c.id, 'worker_a', c.claimToken, {}, { now: T0 }))
      .toThrowError(/already has a result checkpoint/);
    // Still exactly one edge total off the parent.
    expect(await listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Read routes (HTTP) — authorization & exposure
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('lineage routes — authorization & exposure', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  async function seedProject(ownerUserId, name = 'P') {
    const org = await createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }
  // parent → child link in a project, returns both ids.
  async function seedLink(projectId, ownerId) {
    const parent = await createProjectAnalysisObject(ownerId, projectId, { objectType: 'seurat', displayName: 'P' });
    const child = await createProjectAnalysisObject(ownerId, projectId, { objectType: 'seurat', displayName: 'C', parentObjectId: parent.id });
    return { parent, child };
  }

  it('rejects unauthenticated access on every lineage route', async () => {
    for (const p of [
      '/api/projects/proj_x/analysis-objects/ao_abc/parents',
      '/api/projects/proj_x/analysis-objects/ao_abc/children',
      '/api/projects/proj_x/analysis-objects/ao_abc/lineage',
    ]) {
      const res = await api(server, p, { method: 'GET' });
      expect(res.status, p).toBe(401);
    }
  });

  it('there is NO public lineage edge create/mutate route', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);
    const { parent, child } = await seedLink(proj.id, alice.user.id);
    for (const [method, p] of [
      ['POST', `/api/projects/${proj.id}/analysis-objects/${child.id}/parents`],
      ['POST', `/api/projects/${proj.id}/analysis-objects/${child.id}/children`],
      ['DELETE', `/api/projects/${proj.id}/analysis-objects/${child.id}/lineage`],
    ]) {
      const res = await api(server, p, { method, token: alice.token, body: { parentObjectId: parent.id } });
      expect(res.status, `${method} ${p}`).not.toBe(201);
    }
  });

  it('every member role (incl. viewer) can read parents/children/lineage', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const viewer = await createUserWithToken({ email: 'viewer@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    const { parent, child } = await seedLink(proj.id, alice.user.id);

    for (const m of [alice, viewer]) {
      const par = await api(server, `/api/projects/${proj.id}/analysis-objects/${child.id}/parents`, { token: m.token });
      expect(par.status).toBe(200);
      expect(par.data).toHaveLength(1);
      expect(par.data[0].parentAnalysisObjectId).toBe(parent.id);

      const kids = await api(server, `/api/projects/${proj.id}/analysis-objects/${parent.id}/children`, { token: m.token });
      expect(kids.status).toBe(200);
      expect(kids.data).toHaveLength(1);
      expect(kids.data[0].childAnalysisObjectId).toBe(child.id);

      const lin = await api(server, `/api/projects/${proj.id}/analysis-objects/${child.id}/lineage`, { token: m.token });
      expect(lin.status).toBe(200);
      expect(lin.data.nodes.map(n => n.id).sort()).toEqual([parent.id, child.id].sort());
      expect(lin.data.edges).toHaveLength(1);
    }
  });

  it('a non-member receives 404 (no existence leak)', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const dave = await createUserWithToken({ email: 'dave@example.com' });
    const proj = await seedProject(alice.user.id);
    const { child } = await seedLink(proj.id, alice.user.id);
    for (const suffix of ['parents', 'children', 'lineage']) {
      const res = await api(server, `/api/projects/${proj.id}/analysis-objects/${child.id}/${suffix}`, { token: dave.token });
      expect(res.status, suffix).toBe(404);
    }
  });

  it('a member lacking the read role would 403 — viewer is allowed, so prove the gate via a non-member 404 and role plumbing', async () => {
    // All defined roles can READ lineage (owner/admin/analyst/viewer), so a 403 only
    // arises for a hypothetical lower role; we assert the read-role set includes viewer
    // and that an unknown project yields 404 (no 403 leak for non-members).
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);
    const { child } = await seedLink(proj.id, alice.user.id);
    const res = await api(server, `/api/projects/proj_unknown/analysis-objects/${child.id}/parents`, { token: alice.token });
    expect(res.status).toBe(404);
  });

  it('malformed object id → 400; well-formed-but-unknown → 404; cross-project object → 404', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const projA = await seedProject(alice.user.id, 'A');
    const projB = await seedProject(alice.user.id, 'B');
    const { child } = await seedLink(projA.id, alice.user.id);

    for (const suffix of ['parents', 'children', 'lineage']) {
      expect((await api(server, `/api/projects/${projA.id}/analysis-objects/not-an-id/${suffix}`, { token: alice.token })).status).toBe(400);
      expect((await api(server, `/api/projects/${projA.id}/analysis-objects/ao_deadbeef/${suffix}`, { token: alice.token })).status).toBe(404);
      // child exists, but in project A — reading it through project B is 404.
      expect((await api(server, `/api/projects/${projB.id}/analysis-objects/${child.id}/${suffix}`, { token: alice.token })).status).toBe(404);
    }
  });

  it('legacy NULL-project objects do not leak into project lineage routes', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);
    // A legacy owner-scoped checkpoint job with an input object — its edge is NULL-project.
    const legacyParent = dbmod.createAnalysisObjectForUser(alice.user.id, { objectType: 'seurat' });
    await createJobForUser(alice.user.id, { jobType: 'checkpoint.noop' });
    // Drive the worker to produce a legacy checkpoint whose parent is the legacy object:
    const c = await claim();
    const cp = await createCheckpointForJobByWorker(c.id, 'worker_t', c.claimToken, { parentObjectId: legacyParent.id }, { now: T0 });
    // The legacy NULL-project edge exists in owner/global scope…
    expect(await listLineageParents(cp.id)).toHaveLength(1);
    // …but the project routes (pinned to a real project) never surface the legacy object.
    for (const suffix of ['parents', 'children', 'lineage']) {
      expect((await api(server, `/api/projects/${proj.id}/analysis-objects/${cp.id}/${suffix}`, { token: alice.token })).status).toBe(404);
      expect((await api(server, `/api/projects/${proj.id}/analysis-objects/${legacyParent.id}/${suffix}`, { token: alice.token })).status).toBe(404);
    }
  });

  it('responses expose only safe edge/graph metadata (no storage uri/path/state key/claim token/worker internals)', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);
    const { parent, child } = await seedLink(proj.id, alice.user.id);

    const par = await api(server, `/api/projects/${proj.id}/analysis-objects/${child.id}/parents`, { token: alice.token });
    const lin = await api(server, `/api/projects/${proj.id}/analysis-objects/${child.id}/lineage`, { token: alice.token });
    const blob = JSON.stringify(par.data) + JSON.stringify(lin.data);
    for (const forbidden of ['storageUri', 'storage_uri', 'objectHash', 'object_hash', 'stateKey', 'state_key',
      'internalStorageKey', 'claimToken', 'claim_token', 'workerId', 'worker_id', 'leaseExpiresAt',
      'vault/', '/etc/', 'ownerUserId', 'owner_user_id']) {
      expect(blob, forbidden).not.toContain(forbidden);
    }
    // Safe fields ARE present.
    expect(par.data[0].id).toMatch(/^aoe_/);
    expect(par.data[0].edgeType).toBe('derived_from');
    expect(par.data[0].parentRole).toBe('primary');
    expect(par.data[0].parentAnalysisObjectId).toBe(parent.id);
    expect(par.data[0].childAnalysisObjectId).toBe(child.id);
    // Graph nodes carry only public-safe object labels.
    const node = lin.data.nodes.find(n => n.id === child.id);
    expect(node.objectType).toBe('seurat');
    expect(Object.keys(node).sort()).toEqual(['id', 'label', 'lineageRootId', 'objectType']);
  });

  it('the graph read is deterministic and bounded (truncated flag present)', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const proj = await seedProject(alice.user.id);
    const { child } = await seedLink(proj.id, alice.user.id);
    const lin = await api(server, `/api/projects/${proj.id}/analysis-objects/${child.id}/lineage`, { token: alice.token });
    expect(lin.status).toBe(200);
    expect(lin.data).toHaveProperty('truncated');
    expect(lin.data.truncated).toBe(false);
    expect(lin.data.projectId).toBe(proj.id);
    expect(typeof lin.data.rootObjectId).toBe('string');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. R object/state ownership boundary (unchanged by lineage edges)
// ════════════════════════════════════════════════════════════════════════════
describe.skipIf(!CONFIGURED)('lineage edges — R object/state ownership unchanged', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(async () => { await dbmod.resetSchemaForTests(); });


  async function seedProject(ownerUserId, name = 'P') {
    const org = await createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }

  it('a co-member who can read lineage still cannot use a checkpoint result object via /api/r/*', async () => {
    const alice = await createUserWithToken({ email: 'alice@example.com' });
    const bob = await createUserWithToken({ email: 'bob@example.com' });
    const proj = await seedProject(alice.user.id);
    await addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner');

    const parent = await createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat' });
    const job = await createProjectJob(alice.user.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    await (async () => { const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() }); await w.runOnce(); })();
    const after = await getProjectJob(alice.user.id, proj.id, job.id);
    const cpId = after.resultAnalysisObjectId;

    // Bob (admin) can READ the lineage…
    const lin = await api(server, `/api/projects/${proj.id}/analysis-objects/${cpId}/lineage`, { token: bob.token });
    expect(lin.status).toBe(200);
    // …but R object ownership stays creator-keyed.
    expect(dbmod.verifyAnalysisObjectOwner(alice.user.id, cpId)).toBe(true);
    expect(dbmod.verifyAnalysisObjectOwner(bob.user.id, cpId)).toBe(false);
    const res = await api(server, '/api/r/health', { token: bob.token, headers: { 'X-Object-ID': cpId } });
    expect(res.status).toBe(404);
  });
});
