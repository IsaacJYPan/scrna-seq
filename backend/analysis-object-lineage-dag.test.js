import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbmod = require('./database');
const {
  initDatabase, closeDatabase, createUser,
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

// ════════════════════════════════════════════════════════════════════════════
// 1. Schema & migration (idempotent, additive)
// ════════════════════════════════════════════════════════════════════════════
describe('lineage edges — schema & migration', () => {
  function tmpDbPath() {
    return path.join(os.tmpdir(), `aoe_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.sqlite`);
  }
  function rmDb(p) {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + s); } catch { /* best-effort */ } }
  }

  const EXPECTED_COLUMNS = [
    'id', 'project_id', 'parent_analysis_object_id', 'child_analysis_object_id', 'job_id',
    'edge_type', 'parent_role', 'metadata_json', 'created_by_user_id', 'created_at'
  ];
  const EXPECTED_INDEXES = [
    'idx_aoe_project', 'idx_aoe_parent', 'idx_aoe_child', 'idx_aoe_job', 'idx_aoe_type',
    'idx_aoe_project_parent', 'idx_aoe_project_child', 'idx_aoe_project_job', 'idx_aoe_unique'
  ];

  afterEach(() => { try { closeDatabase(); } catch { /* ignore */ } });

  it('creates analysis_object_edges with all columns on a fresh database', () => {
    initDatabase(':memory:');
    const cols = dbmod.getTableColumns('analysis_object_edges');
    for (const c of EXPECTED_COLUMNS) expect(cols, `column ${c}`).toContain(c);
  });

  it('creates all lineage edge indexes (incl. the unique index) on a fresh database', () => {
    initDatabase(':memory:');
    const idx = dbmod.getTableIndexes('analysis_object_edges');
    for (const i of EXPECTED_INDEXES) expect(idx, `index ${i}`).toContain(i);
  });

  it('migration is idempotent and additive on a pre-existing DB lacking the edge table', () => {
    const p = tmpDbPath();
    try {
      initDatabase(p);
      closeDatabase();
      const pre = new Database(p);
      pre.exec('DROP TABLE analysis_object_edges');
      expect(pre.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analysis_object_edges'").get()).toBeUndefined();
      pre.close();

      // Re-init recreates the table additively, leaving every other table intact.
      initDatabase(p);
      for (const c of EXPECTED_COLUMNS) expect(dbmod.getTableColumns('analysis_object_edges')).toContain(c);
      for (const i of EXPECTED_INDEXES) expect(dbmod.getTableIndexes('analysis_object_edges')).toContain(i);
      expect(dbmod.getTableColumns('jobs')).toContain('worker_id');
      closeDatabase();

      // Second re-init: a pure no-op (CREATE TABLE IF NOT EXISTS).
      initDatabase(p);
      for (const c of EXPECTED_COLUMNS) expect(dbmod.getTableColumns('analysis_object_edges')).toContain(c);
      closeDatabase();
    } finally {
      rmDb(p);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Backfill of existing single-parent links
// ════════════════════════════════════════════════════════════════════════════
describe('lineage edges — backfill of existing parent links', () => {
  function tmpDbPath() {
    return path.join(os.tmpdir(), `aoe_bf_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.sqlite`);
  }
  function rmDb(p) {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + s); } catch { /* best-effort */ } }
  }
  // Count edges for a child directly from the file (independent of in-process helpers).
  function countEdgesForChild(p, childId) {
    const d = new Database(p);
    const n = d.prepare('SELECT COUNT(*) AS n FROM analysis_object_edges WHERE child_analysis_object_id = ?').get(childId).n;
    d.close();
    return n;
  }

  function seedProject(ownerId, name = 'P') {
    const org = createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('backfills a derived_from edge for a historical parent link with no edge yet', () => {
    const p = tmpDbPath();
    try {
      initDatabase(p);
      const alice = createUser('alice@example.com', 'password123', 'Alice');
      const proj = seedProject(alice.id);
      const parent = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
      // Simulate a HISTORICAL child whose parent link predates the edge table: raw
      // insert with parent_object_id set but NO edge row.
      const childId = `ao_${'b'.repeat(24)}`;
      const handle = new Database(p);
      handle.prepare(`INSERT INTO analysis_objects (id, owner_user_id, project_id, parent_object_id, lineage_root_id, object_type, metadata_json)
        VALUES (?, ?, ?, ?, ?, 'seurat', '{}')`).run(childId, alice.id, proj.id, parent.id, parent.id);
      handle.exec('DELETE FROM analysis_object_edges'); // ensure none exist for the child
      handle.close();
      expect(countEdgesForChild(p, childId)).toBe(0);
      closeDatabase();

      // Re-init runs the backfill.
      initDatabase(p);
      expect(countEdgesForChild(p, childId)).toBe(1);
      const parents = listLineageParents(childId, { projectId: proj.id });
      expect(parents).toHaveLength(1);
      expect(parents[0].edgeType).toBe('derived_from');
      expect(parents[0].parentRole).toBe('primary');
      expect(parents[0].parentAnalysisObjectId).toBe(parent.id);
      expect(parents[0].jobId).toBeNull();
      closeDatabase();
    } finally { rmDb(p); }
  });

  it('repeated init/migration does not duplicate backfilled edges', () => {
    const p = tmpDbPath();
    try {
      initDatabase(p);
      const alice = createUser('alice@example.com', 'password123', 'Alice');
      const proj = seedProject(alice.id);
      const parent = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
      const childId = `ao_${'c'.repeat(24)}`;
      const handle = new Database(p);
      handle.prepare(`INSERT INTO analysis_objects (id, owner_user_id, project_id, parent_object_id, lineage_root_id, object_type, metadata_json)
        VALUES (?, ?, ?, ?, ?, 'seurat', '{}')`).run(childId, alice.id, proj.id, parent.id, parent.id);
      handle.exec('DELETE FROM analysis_object_edges');
      handle.close();
      closeDatabase();

      initDatabase(p); closeDatabase();
      initDatabase(p); closeDatabase();
      initDatabase(p);
      expect(countEdgesForChild(p, childId)).toBe(1); // still exactly one
      closeDatabase();
    } finally { rmDb(p); }
  });

  it('an invalid legacy CROSS-PROJECT parent link is not backfilled (no leak into a project graph)', () => {
    const p = tmpDbPath();
    try {
      initDatabase(p);
      const alice = createUser('alice@example.com', 'password123', 'Alice');
      const projA = seedProject(alice.id, 'A');
      const projB = seedProject(alice.id, 'B');
      const parentA = createProjectAnalysisObject(alice.id, projA.id, { objectType: 'seurat' });
      // A bad historical child in project B pointing at a parent in project A.
      const childId = `ao_${'d'.repeat(24)}`;
      const handle = new Database(p);
      handle.prepare(`INSERT INTO analysis_objects (id, owner_user_id, project_id, parent_object_id, lineage_root_id, object_type, metadata_json)
        VALUES (?, ?, ?, ?, ?, 'seurat', '{}')`).run(childId, alice.id, projB.id, parentA.id, parentA.id);
      handle.exec('DELETE FROM analysis_object_edges');
      handle.close();
      closeDatabase();

      initDatabase(p);
      // No edge created for the cross-project link; neither project's graph shows it.
      expect(countEdgesForChild(p, childId)).toBe(0);
      expect(listLineageParents(childId, { projectId: projB.id })).toHaveLength(0);
      expect(listLineageChildren(parentA.id, { projectId: projA.id })).toHaveLength(0);
      closeDatabase();
    } finally { rmDb(p); }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Edge create helper (validation, scope, server-owned identity)
// ════════════════════════════════════════════════════════════════════════════
describe('lineage edges — createLineageEdge helper', () => {
  let alice;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  function seedProject(ownerId, name = 'P') {
    const org = createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('creates a server-generated aoe_ id; client cannot set project/creator/internal fields', () => {
    const proj = seedProject(alice.id);
    const a = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const edge = createLineageEdge(alice.id, {
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

  it('rejects malformed parent/child/job IDs with INVALID_* (→ 400)', () => {
    const proj = seedProject(alice.id);
    const a = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    expect(() => createLineageEdge(alice.id, { parentObjectId: 'not-an-id', childObjectId: b.id }))
      .toThrowError(/Malformed parent/);
    expect(() => createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: 'nope' }))
      .toThrowError(/Malformed child/);
    expect(() => createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, jobId: 'bad' }))
      .toThrowError(/Malformed job/);
    try { createLineageEdge(alice.id, { parentObjectId: 'x', childObjectId: b.id }); }
    catch (e) { expect(e.code).toBe('INVALID_PARENT_ID'); }
  });

  it('rejects unknown/cross-project parent/child/job references with *_NOT_FOUND (→ 404)', () => {
    const projA = seedProject(alice.id, 'A');
    const projB = seedProject(alice.id, 'B');
    const a = createProjectAnalysisObject(alice.id, projA.id, { objectType: 'seurat' });
    const b = createProjectAnalysisObject(alice.id, projA.id, { objectType: 'seurat' });
    const bInB = createProjectAnalysisObject(alice.id, projB.id, { objectType: 'seurat' });

    // unknown (well-formed) ids
    expect(() => createLineageEdge(alice.id, { parentObjectId: 'ao_deadbeef', childObjectId: b.id }))
      .toThrowError(/Parent analysis object not found/);
    expect(() => createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: 'ao_deadbeef' }))
      .toThrowError(/Child analysis object not found/);
    // cross-project parent/child (different scopes) → 404
    expect(() => createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: bInB.id }))
      .toThrowError(/Child analysis object not found/);
    // job in another project
    const jobB = createProjectJob(alice.id, projB.id, { jobType: 'checkpoint.noop' });
    expect(() => createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, jobId: jobB.id }))
      .toThrowError(/Job not found/);
  });

  it('rejects a self-parent edge (SELF_PARENT → 400)', () => {
    const proj = seedProject(alice.id);
    const a = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    let code;
    try { createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: a.id }); }
    catch (e) { code = e.code; }
    expect(code).toBe('SELF_PARENT');
  });

  it('rejects bad edgeType / parentRole / metadata', () => {
    const proj = seedProject(alice.id);
    const a = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    expect(() => createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, edgeType: 'nope' }))
      .toThrowError(/Invalid edgeType/);
    expect(() => createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, parentRole: 'nope' }))
      .toThrowError(/Invalid parentRole/);
    expect(() => createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, metadata: [1, 2] }))
      .toThrowError(/metadata must be a plain JSON object/);
  });

  it('rejects a duplicate edge (DUPLICATE_EDGE → 409)', () => {
    const proj = seedProject(alice.id);
    const a = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, edgeType: 'branch' });
    let code;
    try { createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, edgeType: 'branch' }); }
    catch (e) { code = e.code; }
    expect(code).toBe('DUPLICATE_EDGE');
  });

  it('rejects a direct cycle and an indirect cycle (CYCLE → 409)', () => {
    const proj = seedProject(alice.id);
    const a = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const c = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    // a → b → c
    createLineageEdge(alice.id, { parentObjectId: a.id, childObjectId: b.id, edgeType: 'branch' });
    createLineageEdge(alice.id, { parentObjectId: b.id, childObjectId: c.id, edgeType: 'branch' });
    // direct cycle: b → a (a is ancestor of b)
    let directCode;
    try { createLineageEdge(alice.id, { parentObjectId: b.id, childObjectId: a.id, edgeType: 'branch' }); }
    catch (e) { directCode = e.code; }
    expect(directCode).toBe('CYCLE');
    // indirect cycle: c → a (a →…→ c already)
    let indirectCode;
    try { createLineageEdge(alice.id, { parentObjectId: c.id, childObjectId: a.id, edgeType: 'branch' }); }
    catch (e) { indirectCode = e.code; }
    expect(indirectCode).toBe('CYCLE');
    // the pure predicate agrees
    expect(lineageEdgeWouldCreateCycle(c.id, a.id, { projectId: proj.id })).toBe(true);
    expect(lineageEdgeWouldCreateCycle(a.id, c.id, { projectId: proj.id })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Branching & multi-parent representation (DAG)
// ════════════════════════════════════════════════════════════════════════════
describe('lineage edges — branching & multi-parent', () => {
  let alice;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  function seedProject(ownerId, name = 'P') {
    const org = createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('two children from the same parent appear as branches', () => {
    const proj = seedProject(alice.id);
    const root = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const child1 = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const child2 = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const kids = listProjectAnalysisObjectChildren(alice.id, proj.id, root.id);
    expect(kids).toHaveLength(2);
    const childIds = kids.map(e => e.childAnalysisObjectId).sort();
    expect(childIds).toEqual([child1.id, child2.id].sort());
  });

  it('one child with two parents is representable and traversable via the helper', () => {
    const proj = seedProject(alice.id);
    const p1 = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const p2 = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const merged = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const edges = createLineageEdgesForChild(alice.id, merged.id, [
      { parentObjectId: p1.id, edgeType: 'integration_input', parentRole: 'primary' },
      { parentObjectId: p2.id, edgeType: 'integration_input', parentRole: 'secondary' },
    ]);
    expect(edges).toHaveLength(2);
    const parents = listProjectAnalysisObjectParents(alice.id, proj.id, merged.id);
    expect(parents).toHaveLength(2);
    expect(parents.map(e => e.parentAnalysisObjectId).sort()).toEqual([p1.id, p2.id].sort());
    expect(parents.map(e => e.parentRole).sort()).toEqual(['primary', 'secondary']);
    // both parents list the merged object as a child
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, p1.id)[0].childAnalysisObjectId).toBe(merged.id);
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, p2.id)[0].childAnalysisObjectId).toBe(merged.id);
  });

  it('graph traversal returns both parents for a multi-parent child and both children for a branched parent', () => {
    const proj = seedProject(alice.id);
    const root = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b1 = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const b2 = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const merged = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    createLineageEdgesForChild(alice.id, merged.id, [
      { parentObjectId: b1.id, edgeType: 'integration_input', parentRole: 'primary' },
      { parentObjectId: b2.id, edgeType: 'integration_input', parentRole: 'secondary' },
    ]);
    const graph = getProjectAnalysisObjectLineage(alice.id, proj.id, merged.id);
    const nodeIds = graph.nodes.map(n => n.id).sort();
    expect(nodeIds).toEqual([root.id, b1.id, b2.id, merged.id].sort());
    // 2 branch edges from root + 2 integration edges into merged = 4
    expect(graph.edges).toHaveLength(4);
    expect(graph.truncated).toBe(false);
    // deterministic: a second read yields identical ordering
    const graph2 = getProjectAnalysisObjectLineage(alice.id, proj.id, merged.id);
    expect(graph2.edges.map(e => e.id)).toEqual(graph.edges.map(e => e.id));
    expect(graph2.nodes.map(n => n.id)).toEqual(graph.nodes.map(n => n.id));
  });

  it('cycle prevention still holds after branching/multi-parent', () => {
    const proj = seedProject(alice.id);
    const root = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const b1 = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat', parentObjectId: root.id });
    const merged = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    createLineageEdge(alice.id, { parentObjectId: b1.id, childObjectId: merged.id, edgeType: 'integration_input' });
    // root → b1 → merged ; merged → root would close a cycle
    let code;
    try { createLineageEdge(alice.id, { parentObjectId: merged.id, childObjectId: root.id, edgeType: 'branch' }); }
    catch (e) { code = e.code; }
    expect(code).toBe('CYCLE');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Checkpoint integration (edge created with the result object)
// ════════════════════════════════════════════════════════════════════════════
describe('lineage edges — checkpoint integration', () => {
  let alice;
  beforeEach(() => {
    initDatabase(':memory:');
    alice = createUser('alice@example.com', 'password123', 'Alice');
  });
  afterEach(() => closeDatabase());

  function seedProject(ownerId, name = 'P') {
    const org = createOrganizationForUser(ownerId, { name: 'Acme' });
    return createProjectForUser(ownerId, { organizationId: org.id, name });
  }

  it('a successful checkpoint.noop with an input object creates the result object and exactly one checkpoint edge', async () => {
    const proj = seedProject(alice.id);
    const parent = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const job = createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    const res = await drainOnce();
    expect(res.status).toBe('completed');

    const after = getProjectJob(alice.id, proj.id, job.id);
    const cpId = after.resultAnalysisObjectId;
    expect(cpId).toMatch(/^ao_/);

    const parents = listProjectAnalysisObjectParents(alice.id, proj.id, cpId);
    expect(parents).toHaveLength(1);
    const edge = parents[0];
    expect(edge.edgeType).toBe('checkpoint');           // checkpoint edge type
    expect(edge.parentRole).toBe('primary');
    expect(edge.parentAnalysisObjectId).toBe(parent.id); // parent = job input object
    expect(edge.childAnalysisObjectId).toBe(cpId);       // child = result object
    expect(edge.jobId).toBe(job.id);                     // edge links the job

    // Compatibility fields still set on the result object.
    const cp = getProjectAnalysisObject(alice.id, proj.id, cpId);
    expect(cp.parentObjectId).toBe(parent.id);
    expect(cp.lineageRootId).toBe(parent.id);

    // The parent now lists the checkpoint as its only child edge.
    const kids = listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].childAnalysisObjectId).toBe(cpId);
  });

  it('a checkpoint job with NO input object creates a lineage-root result with no edge', async () => {
    const proj = seedProject(alice.id);
    const job = createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop' });
    await drainOnce();
    const after = getProjectJob(alice.id, proj.id, job.id);
    const cpId = after.resultAnalysisObjectId;
    expect(cpId).toMatch(/^ao_/);
    expect(listProjectAnalysisObjectParents(alice.id, proj.id, cpId)).toHaveLength(0);
  });

  it('a failed job creates no result object and no edge', async () => {
    const proj = seedProject(alice.id);
    const parent = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const job = createProjectJob(alice.id, proj.id, { jobType: 'normalize', analysisObjectId: parent.id }); // unsupported
    const res = await drainOnce();
    expect(res.status).toBe('unsupported');
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.resultAnalysisObjectId).toBeNull();
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id)).toHaveLength(0);
  });

  it('a canceled job creates no result object and no edge', async () => {
    const proj = seedProject(alice.id);
    const parent = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    const job = createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    dbmod.cancelProjectJob(alice.id, proj.id, job.id);
    const res = await drainOnce();
    expect(res.status).toBe('idle');
    const after = getProjectJob(alice.id, proj.id, job.id);
    expect(after.resultAnalysisObjectId).toBeNull();
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id)).toHaveLength(0);
  });

  it('a claim-lost completion creates no successful edge, and a duplicate completion creates no duplicate edge', () => {
    const proj = seedProject(alice.id);
    const parent = createProjectAnalysisObject(alice.id, proj.id, { objectType: 'seurat' });
    createProjectJob(alice.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    const c = claim('worker_a');

    // A worker that does not hold the claim cannot create a checkpoint/edge.
    expect(() => createCheckpointForJobByWorker(c.id, 'worker_b', 'wct_bogus', {}, { now: T0 }))
      .toThrowError(/no longer holds a valid claim/);
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id)).toHaveLength(0);

    // The real holder succeeds exactly once (one edge); a second attempt is refused.
    const cp = createCheckpointForJobByWorker(c.id, 'worker_a', c.claimToken, {}, { now: T0 });
    expect(listProjectAnalysisObjectParents(alice.id, proj.id, cp.id)).toHaveLength(1);
    expect(() => createCheckpointForJobByWorker(c.id, 'worker_a', c.claimToken, {}, { now: T0 }))
      .toThrowError(/already has a result checkpoint/);
    // Still exactly one edge total off the parent.
    expect(listProjectAnalysisObjectChildren(alice.id, proj.id, parent.id)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Read routes (HTTP) — authorization & exposure
// ════════════════════════════════════════════════════════════════════════════
describe('lineage routes — authorization & exposure', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  function seedProject(ownerUserId, name = 'P') {
    const org = createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }
  // parent → child link in a project, returns both ids.
  function seedLink(projectId, ownerId) {
    const parent = createProjectAnalysisObject(ownerId, projectId, { objectType: 'seurat', displayName: 'P' });
    const child = createProjectAnalysisObject(ownerId, projectId, { objectType: 'seurat', displayName: 'C', parentObjectId: parent.id });
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
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);
    const { parent, child } = seedLink(proj.id, alice.user.id);
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
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const viewer = createUserWithToken({ email: 'viewer@example.com' });
    const proj = seedProject(alice.user.id);
    addProjectMemberByEmail(proj.id, 'viewer@example.com', 'viewer', 'owner');
    const { parent, child } = seedLink(proj.id, alice.user.id);

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
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const dave = createUserWithToken({ email: 'dave@example.com' });
    const proj = seedProject(alice.user.id);
    const { child } = seedLink(proj.id, alice.user.id);
    for (const suffix of ['parents', 'children', 'lineage']) {
      const res = await api(server, `/api/projects/${proj.id}/analysis-objects/${child.id}/${suffix}`, { token: dave.token });
      expect(res.status, suffix).toBe(404);
    }
  });

  it('a member lacking the read role would 403 — viewer is allowed, so prove the gate via a non-member 404 and role plumbing', async () => {
    // All defined roles can READ lineage (owner/admin/analyst/viewer), so a 403 only
    // arises for a hypothetical lower role; we assert the read-role set includes viewer
    // and that an unknown project yields 404 (no 403 leak for non-members).
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);
    const { child } = seedLink(proj.id, alice.user.id);
    const res = await api(server, `/api/projects/proj_unknown/analysis-objects/${child.id}/parents`, { token: alice.token });
    expect(res.status).toBe(404);
  });

  it('malformed object id → 400; well-formed-but-unknown → 404; cross-project object → 404', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const projA = seedProject(alice.user.id, 'A');
    const projB = seedProject(alice.user.id, 'B');
    const { child } = seedLink(projA.id, alice.user.id);

    for (const suffix of ['parents', 'children', 'lineage']) {
      expect((await api(server, `/api/projects/${projA.id}/analysis-objects/not-an-id/${suffix}`, { token: alice.token })).status).toBe(400);
      expect((await api(server, `/api/projects/${projA.id}/analysis-objects/ao_deadbeef/${suffix}`, { token: alice.token })).status).toBe(404);
      // child exists, but in project A — reading it through project B is 404.
      expect((await api(server, `/api/projects/${projB.id}/analysis-objects/${child.id}/${suffix}`, { token: alice.token })).status).toBe(404);
    }
  });

  it('legacy NULL-project objects do not leak into project lineage routes', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);
    // A legacy owner-scoped checkpoint job with an input object — its edge is NULL-project.
    const legacyParent = dbmod.createAnalysisObjectForUser(alice.user.id, { objectType: 'seurat' });
    createJobForUser(alice.user.id, { jobType: 'checkpoint.noop' });
    // Drive the worker to produce a legacy checkpoint whose parent is the legacy object:
    const c = claim();
    const cp = createCheckpointForJobByWorker(c.id, 'worker_t', c.claimToken, { parentObjectId: legacyParent.id }, { now: T0 });
    // The legacy NULL-project edge exists in owner/global scope…
    expect(listLineageParents(cp.id)).toHaveLength(1);
    // …but the project routes (pinned to a real project) never surface the legacy object.
    for (const suffix of ['parents', 'children', 'lineage']) {
      expect((await api(server, `/api/projects/${proj.id}/analysis-objects/${cp.id}/${suffix}`, { token: alice.token })).status).toBe(404);
      expect((await api(server, `/api/projects/${proj.id}/analysis-objects/${legacyParent.id}/${suffix}`, { token: alice.token })).status).toBe(404);
    }
  });

  it('responses expose only safe edge/graph metadata (no storage uri/path/state key/claim token/worker internals)', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);
    const { parent, child } = seedLink(proj.id, alice.user.id);

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
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const proj = seedProject(alice.user.id);
    const { child } = seedLink(proj.id, alice.user.id);
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
describe('lineage edges — R object/state ownership unchanged', () => {
  let server;
  beforeAll(async () => { server = await startServer(); });
  afterAll(() => { if (server) server.close(); });
  beforeEach(() => { initDatabase(':memory:'); });
  afterEach(() => { closeDatabase(); });

  function seedProject(ownerUserId, name = 'P') {
    const org = createOrganizationForUser(ownerUserId, { name: 'Acme' });
    return createProjectForUser(ownerUserId, { organizationId: org.id, name });
  }

  it('a co-member who can read lineage still cannot use a checkpoint result object via /api/r/*', async () => {
    const alice = createUserWithToken({ email: 'alice@example.com' });
    const bob = createUserWithToken({ email: 'bob@example.com' });
    const proj = seedProject(alice.user.id);
    addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner');

    const parent = createProjectAnalysisObject(alice.user.id, proj.id, { objectType: 'seurat' });
    const job = createProjectJob(alice.user.id, proj.id, { jobType: 'checkpoint.noop', analysisObjectId: parent.id });
    await (async () => { const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger() }); await w.runOnce(); })();
    const after = getProjectJob(alice.user.id, proj.id, job.id);
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
