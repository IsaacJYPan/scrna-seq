/**
 * Postgres contract test — proves the hosted-service database foundation on a
 * REAL Postgres server (evidence label: "Postgres contract").
 *
 * It exercises backend/pgDatabase.js end-to-end against Postgres:
 *   - schema init from backend/pg/schema.sql,
 *   - auth (createUser + verifyUser, duplicate-email rejection),
 *   - project RBAC (org/project creation seeds an owner member; role reads),
 *   - server-generated ids (org_/proj_/ao_/job_/art_),
 *   - analysis object ownership scoping,
 *   - the job state machine (allowed vs rejected transitions, terminal jobs),
 *   - artifact result-checkpoint immutability (second checkpoint rejected),
 *   - public sanitization (claim_token/worker internals + storage_uri stripped).
 *
 * GATING: the whole suite is SKIPPED unless a Postgres connection is configured
 * (DATABASE_URL or PG* env). The app server itself requires Postgres to start;
 * the skip exists only so local test commands can run without a local database.
 * If DATABASE_URL is set but the server is unreachable, the suite FAILS loudly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const config = require('./config');
const pg = require('./pgDatabase');

const CONFIGURED = config.hasPostgresConnection();

describe.skipIf(!CONFIGURED)('Postgres contract (hosted-service database foundation)', () => {
  beforeAll(async () => {
    await pg.resetSchemaForTests();
  });

  afterAll(async () => {
    await pg.close();
  });

  it('initializes the schema and round-trips a user (auth contract)', async () => {
    const created = await pg.createUser('alice@example.com', 'password123', 'Alice');
    expect(created.error).toBeUndefined();
    expect(typeof created.id).toBe('number');

    const dup = await pg.createUser('alice@example.com', 'password123', 'Alice2');
    expect(dup.error).toMatch(/already exists/i);

    const good = await pg.verifyUser('alice@example.com', 'password123');
    expect(good.error).toBeUndefined();
    expect(good.email).toBe('alice@example.com');

    const bad = await pg.verifyUser('alice@example.com', 'wrong-password');
    expect(bad.error).toBeDefined();

    const missing = await pg.verifyUser('nobody@example.com', 'whatever');
    expect(missing.error).toBeDefined();
  });

  it('creates org/project with server ids and seeds an owner member (RBAC)', async () => {
    const owner = await pg.createUser('owner@example.com', 'password123', 'Owner');
    const org = await pg.createOrganization('Acme Lab', owner.id);
    expect(org.id).toMatch(/^org_[0-9a-f]+$/);

    const project = await pg.createProject(org.id, 'Project X', owner.id);
    expect(project.id).toMatch(/^proj_[0-9a-f]+$/);

    // Creator is auto-seeded as owner.
    expect(await pg.getProjectRole(project.id, owner.id)).toBe('owner');

    // A second member can be added with a constrained role; unknown roles reject.
    const analyst = await pg.createUser('analyst@example.com', 'password123', 'Analyst');
    await pg.addProjectMember(project.id, analyst.id, 'analyst');
    expect(await pg.getProjectRole(project.id, analyst.id)).toBe('analyst');
    await expect(pg.addProjectMember(project.id, analyst.id, 'superuser'))
      .rejects.toMatchObject({ code: 'INVALID_ROLE' });

    // A non-member has no role.
    const stranger = await pg.createUser('stranger@example.com', 'password123', 'Stranger');
    expect(await pg.getProjectRole(project.id, stranger.id)).toBeNull();
  });

  it('scopes analysis objects to their owner and generates server ids', async () => {
    const a = await pg.createUser('ao-a@example.com', 'password123', 'A');
    const b = await pg.createUser('ao-b@example.com', 'password123', 'B');

    const obj = await pg.createAnalysisObject(a.id, { objectType: 'seurat', displayName: 'obj1' });
    expect(obj.id).toMatch(/^ao_[0-9a-f]+$/);
    expect(obj.lineageRootId).toBe(obj.id); // root object is its own lineage root

    // Owner can read it; another user cannot (indistinguishable from not-found).
    expect(await pg.getAnalysisObjectForUser(obj.id, a.id)).not.toBeNull();
    expect(await pg.getAnalysisObjectForUser(obj.id, b.id)).toBeNull();

    await expect(pg.createAnalysisObject(a.id, { objectType: 'not-a-type' }))
      .rejects.toMatchObject({ code: 'INVALID_OBJECT_TYPE' });
  });

  it('enforces the job state machine and never exposes worker internals', async () => {
    const u = await pg.createUser('jobs@example.com', 'password123', 'J');
    const job = await pg.createJob(u.id, { jobType: 'generic' });
    expect(job.id).toMatch(/^job_[0-9a-f]+$/);
    expect(job.status).toBe('queued');

    // queued → running → completed is allowed.
    const running = await pg.transitionJobStatus(job.id, u.id, 'running');
    expect(running.status).toBe('running');
    const done = await pg.transitionJobStatus(job.id, u.id, 'completed');
    expect(done.status).toBe('completed');

    // Terminal job cannot transition further.
    await expect(pg.transitionJobStatus(job.id, u.id, 'running'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    // Illegal edge from a fresh job (queued → completed) is rejected.
    const job2 = await pg.createJob(u.id, { jobType: 'generic' });
    await expect(pg.transitionJobStatus(job2.id, u.id, 'completed'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    // Public projection strips claim_token / worker_id.
    const publicJob = pg.toPublicJob(done);
    expect(publicJob).not.toHaveProperty('claimToken');
    expect(publicJob).not.toHaveProperty('workerId');
    expect(publicJob.status).toBe('completed');
  });

  it('enforces one immutable result checkpoint per job and strips storage_uri', async () => {
    const u = await pg.createUser('art@example.com', 'password123', 'Art');
    const job = await pg.createJob(u.id, { jobType: 'checkpoint.noop' });

    const cp = await pg.createResultCheckpoint(job, {
      storageKind: 'local_internal',
      storageUri: '/vault/secret/internal-key.rds',
      checksumSha256: 'abc123',
      sizeBytes: 42
    });
    expect(cp.artifactType).toBe('result_checkpoint');

    // A second result checkpoint for the same job is rejected (immutability).
    await expect(pg.createResultCheckpoint(job, { storageUri: '/vault/other.rds' }))
      .rejects.toMatchObject({ code: 'CHECKPOINT_EXISTS' });

    // Public projection never exposes the internal storage path.
    const publicArtifact = pg.toPublicJobArtifact(cp);
    expect(publicArtifact).not.toHaveProperty('storageUri');
    expect(publicArtifact.checksumSha256).toBe('abc123'); // safe descriptive metadata kept
  });

  it('enforces project membership, dataset metadata safety, and public analysis-object projection', async () => {
    const owner = await pg.createUser('parity-owner@example.com', 'password123', 'Parity Owner');
    const viewer = await pg.createUser('parity-viewer@example.com', 'password123', 'Parity Viewer');
    const stranger = await pg.createUser('parity-stranger@example.com', 'password123', 'Parity Stranger');
    const org = await pg.createOrganization('Parity Lab', owner.id);
    const project = await pg.createProject(org.id, 'Parity Project', owner.id);
    await pg.addProjectMember(project.id, viewer.id, 'viewer');

    const dataset = await pg.createDatasetForProject(owner.id, project.id, {
      id: 'ds_client',
      ownerUserId: stranger.id,
      createdByUserId: stranger.id,
      originalFilename: '../matrix.h5',
      fileType: 'tenx_h5',
      uploadStatus: 'pending',
      validationStatus: 'pending',
      internalStorageKey: 'client/key',
      storageUri: '/client/path',
      metadata: { organism: 'human' }
    });
    expect(dataset.id).toMatch(/^ds_[0-9a-f]+$/);
    expect(dataset.ownerUserId).toBe(owner.id);
    expect(dataset.createdByUserId).toBe(owner.id);
    expect(dataset.originalFilename).toBe('matrix.h5');
    expect(dataset.internalStorageKey).toBeNull();
    expect(dataset.storageUri).toBeNull();

    const publicDataset = pg.toPublicDataset(dataset);
    expect(publicDataset).not.toHaveProperty('internalStorageKey');
    expect(publicDataset).not.toHaveProperty('storageUri');

    const readByViewer = await pg.getDatasetForProject(viewer.id, project.id, dataset.id);
    expect(readByViewer.id).toBe(dataset.id);

    await expect(pg.createDatasetForProject(viewer.id, project.id, {
      fileType: 'tenx_h5'
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(pg.listDatasetsForProject(stranger.id, project.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    const obj = await pg.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat',
      datasetId: dataset.id,
      displayName: 'Project object',
      storageUri: '/client/object.rds',
      objectHash: 'client-hash',
      metadata: { cells: 10 }
    });
    expect(obj.id).toMatch(/^ao_[0-9a-f]+$/);
    expect(obj.projectId).toBe(project.id);
    expect(obj.datasetId).toBe(dataset.id);
    expect(obj.ownerUserId).toBe(owner.id);
    expect(obj.storageUri).toBeNull();
    expect(obj.objectHash).toBeNull();

    const publicObj = pg.toPublicAnalysisObject(obj);
    expect(publicObj).not.toHaveProperty('storageUri');
    expect(publicObj).not.toHaveProperty('objectHash');

    const viewerObjects = await pg.listProjectAnalysisObjects(viewer.id, project.id);
    expect(viewerObjects.map(o => o.id)).toContain(obj.id);
    await expect(pg.getProjectAnalysisObject(stranger.id, project.id, obj.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('records project jobs, log transitions, and artifact metadata without public storage leaks', async () => {
    const owner = await pg.createUser('parity-jobs-owner@example.com', 'password123', 'Job Owner');
    const viewer = await pg.createUser('parity-jobs-viewer@example.com', 'password123', 'Job Viewer');
    const org = await pg.createOrganization('Job Lab', owner.id);
    const project = await pg.createProject(org.id, 'Job Project', owner.id);
    await pg.addProjectMember(project.id, viewer.id, 'viewer');
    const dataset = await pg.createDatasetForProject(owner.id, project.id, {
      fileType: 'tenx_h5',
      uploadStatus: 'pending',
      validationStatus: 'pending'
    });
    const obj = await pg.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat',
      datasetId: dataset.id
    });
    const otherProject = await pg.createProject(org.id, 'Other Job Project', owner.id);
    const otherObj = await pg.createProjectAnalysisObject(owner.id, otherProject.id, {
      objectType: 'seurat'
    });

    const job = await pg.createProjectJob(owner.id, project.id, {
      jobType: 'checkpoint.noop',
      analysisObjectId: obj.id,
      datasetId: dataset.id,
      status: 'completed',
      ownerUserId: viewer.id,
      parameters: { alpha: 1 }
    });
    expect(job.id).toMatch(/^job_[0-9a-f]+$/);
    expect(job.ownerUserId).toBe(owner.id);
    expect(job.projectId).toBe(project.id);
    expect(job.status).toBe('queued');

    const logged = await pg.appendJobLogForUser(owner.id, job.id, { level: 'warn', message: 'queued for worker' });
    expect(logged.logs).toHaveLength(1);
    expect(logged.logs[0].message).toBe('queued for worker');

    const running = await pg.updateJobStatusForUser(owner.id, job.id, 'running');
    expect(running.startedAt).toBeTruthy();
    await expect(pg.updateJobStatusForUser(owner.id, job.id, 'completed', {
      resultAnalysisObjectId: otherObj.id
    })).rejects.toMatchObject({ code: 'RESULT_OBJECT_NOT_FOUND' });
    const done = await pg.updateJobStatusForUser(owner.id, job.id, 'completed', {
      log: 'completed',
      resultAnalysisObjectId: obj.id
    });
    expect(done.status).toBe('completed');
    expect(done.logs.map(l => l.message)).toContain('completed');
    await expect(pg.updateJobStatusForUser(owner.id, job.id, 'running'))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    const artifact = await pg.createArtifact(done, {
      artifactType: 'metrics',
      name: 'metrics',
      storageKind: 'local_internal',
      storageUri: 'projects/internal/metrics.json',
      metadata: { rows: 3 }
    });
    const rawArtifacts = await pg.getJobArtifactsByJobId(job.id);
    expect(rawArtifacts[0].storageUri).toBe('projects/internal/metrics.json');

    const publicArtifacts = await pg.listProjectJobArtifacts(viewer.id, project.id, job.id);
    expect(publicArtifacts).toHaveLength(1);
    expect(publicArtifacts[0]).not.toHaveProperty('storageUri');
    const publicArtifact = await pg.getProjectArtifact(viewer.id, project.id, artifact.id);
    expect(publicArtifact).not.toHaveProperty('storageUri');
  });

  it('creates same-project lineage edges and rejects cycles and cross-project edges', async () => {
    const owner = await pg.createUser('parity-lineage-owner@example.com', 'password123', 'Lineage Owner');
    const viewer = await pg.createUser('parity-lineage-viewer@example.com', 'password123', 'Lineage Viewer');
    const org = await pg.createOrganization('Lineage Lab', owner.id);
    const project = await pg.createProject(org.id, 'Lineage Project', owner.id);
    const otherProject = await pg.createProject(org.id, 'Other Lineage Project', owner.id);
    await pg.addProjectMember(project.id, viewer.id, 'viewer');

    const root = await pg.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat',
      displayName: 'root'
    });
    const child = await pg.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat',
      parentObjectId: root.id,
      displayName: 'child'
    });
    const secondChild = await pg.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat',
      displayName: 'second child'
    });
    const otherObj = await pg.createProjectAnalysisObject(owner.id, otherProject.id, {
      objectType: 'seurat'
    });

    const parents = await pg.listProjectAnalysisObjectParents(viewer.id, project.id, child.id);
    expect(parents).toHaveLength(1);
    expect(parents[0].parentAnalysisObjectId).toBe(root.id);

    const edge = await pg.createLineageEdge(owner.id, {
      parentObjectId: root.id,
      childObjectId: secondChild.id,
      edgeType: 'branch',
      parentRole: 'primary',
      metadata: { reason: 'test' }
    });
    expect(edge.id).toMatch(/^aoe_[0-9a-f]+$/);
    expect(edge.projectId).toBe(project.id);

    await expect(pg.createLineageEdge(owner.id, {
      parentObjectId: child.id,
      childObjectId: root.id
    })).rejects.toMatchObject({ code: 'CYCLE' });
    await expect(pg.createLineageEdge(owner.id, {
      parentObjectId: root.id,
      childObjectId: otherObj.id
    })).rejects.toMatchObject({ code: 'CHILD_NOT_FOUND' });

    const graph = await pg.getProjectAnalysisObjectLineage(viewer.id, project.id, root.id);
    expect(graph.nodes.map(n => n.id)).toEqual(expect.arrayContaining([root.id, child.id, secondChild.id]));
    expect(graph.nodes.find(n => n.id === root.id)?.createdAt).toBeTruthy();
    expect(graph.edges.map(e => e.childAnalysisObjectId)).toEqual(expect.arrayContaining([child.id, secondChild.id]));
  });
});
