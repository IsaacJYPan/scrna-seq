import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const { createJobWorker, checkpointForkHandler, DEFAULT_HANDLERS } = require('./jobWorker');
const { deriveRObjectStateKey } = require('../server');

const CONFIGURED = config.hasPostgresConnection();
const T0 = '2030-01-01 00:00:00';

function logger() {
  return { info() {}, warn() {}, error() {} };
}

function pipelineBody() {
  return {
    ok: true,
    summary: {
      n_cells: 100,
      n_features: 500,
      n_variable_features: 200,
      n_pcs: 10,
      n_clusters: 3,
      cluster_sizes: [40, 35, 25],
      reductions: ['pca', 'umap'],
      normalization_method: 'LogNormalize',
      resolution: 0.8,
      used_seed: 42,
    },
    checkpoint: {
      saved: true,
      checksum_sha256: 'a'.repeat(64),
      size_bytes: 1234,
    },
    versions: { seurat_version: '5.0.1', r_version: '4.5.3' },
  };
}

function loadBody(overrides = {}) {
  return {
    loaded: true,
    checksum_verified: true,
    class: 'Seurat',
    n_cells: 100,
    n_features: 500,
    assays: ['RNA'],
    reductions: ['pca', 'umap'],
    n_meta_fields: 2,
    meta_fields: ['orig.ident', 'seurat_clusters'],
    seurat_version: '5.0.1',
    r_version: '4.5.3',
    ...overrides,
  };
}

function caller(record, loadResponse = { status: 200, body: loadBody() }) {
  return async (request) => {
    record.push(request);
    if (request.path === '/object/pbmc-pipeline') {
      return { status: 200, body: pipelineBody() };
    }
    if (request.path === '/object/checkpoint-load') return loadResponse;
    return { status: 200, body: {} };
  };
}

async function drain(callR) {
  return createJobWorker({
    db,
    now: () => T0,
    logger: logger(),
    callR,
    deriveRObjectStateKey,
  }).runOnce();
}

async function seedProject() {
  const alice = await db.createUser('alice@example.com', 'password123', 'Alice');
  const org = await db.createOrganizationForUser(alice.id, { name: 'Lab' });
  const project = await db.createProjectForUser(alice.id, {
    organizationId: org.id,
    name: 'Study',
  });
  const parent = await db.createProjectAnalysisObject(alice.id, project.id, {
    objectType: 'seurat',
    displayName: 'Source input',
  });
  const pipelineJob = await db.createProjectJob(alice.id, project.id, {
    jobType: 'pbmc.pipeline.v1',
    analysisObjectId: parent.id,
    parameters: {},
  });
  expect((await drain(caller([]))).status).toBe('completed');
  const checkpoint = (await db.getJobArtifactsByJobId(pipelineJob.id))
    .find((artifact) => artifact.artifactType === 'checkpoint');
  expect(checkpoint).toBeTruthy();
  const source = await db.getProjectAnalysisObject(
    alice.id,
    project.id,
    checkpoint.resultAnalysisObjectId
  );
  return { alice, project, parent, source, checkpoint };
}

afterAll(async () => {
  if (CONFIGURED) await db.close();
});

describe.skipIf(!CONFIGURED)('checkpoint.fork.v1', () => {
  beforeEach(async () => {
    await db.resetSchemaForTests();
  });

  it('is an explicit worker job', () => {
    expect(db.isValidJobType('checkpoint.fork.v1')).toBe(true);
    expect(DEFAULT_HANDLERS['checkpoint.fork.v1']).toBe(checkpointForkHandler);
    expect(db.isValidArtifactType('checkpoint_fork')).toBe(true);
    expect(db.isValidEdgeType('checkpoint_fork')).toBe(true);
  });

  it('forks a co-member checkpoint into a new object owned by the loader', async () => {
    const { alice, project, source, checkpoint } = await seedProject();
    const carol = await db.createUser('carol@example.com', 'password123', 'Carol');
    await db.addProjectMemberByEmail(project.id, carol.email, 'analyst', 'owner');
    const job = await db.createProjectJob(carol.id, project.id, {
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const calls = [];

    const result = await drain(caller(calls));

    expect(result.status).toBe('completed');
    expect(result.jobId).toBe(job.id);
    const finished = await db.getProjectJob(carol.id, project.id, job.id);
    expect(finished.resultAnalysisObjectId).toMatch(/^ao_/);
    expect(finished.resultAnalysisObjectId).not.toBe(source.id);
    const fork = await db.getProjectAnalysisObject(
      carol.id,
      project.id,
      finished.resultAnalysisObjectId
    );
    expect(fork.ownerUserId).toBe(carol.id);
    expect(fork.parentObjectId).toBe(source.id);
    expect(fork.metadata).toEqual(expect.objectContaining({
      source: 'checkpoint.fork.v1',
      sourceAnalysisObjectId: source.id,
      sourceCheckpointArtifactId: checkpoint.id,
    }));

    const loadCall = calls.find((request) => request.path === '/object/checkpoint-load');
    expect(loadCall.body.storage_key).toBe(checkpoint.storageUri);
    expect(loadCall.objectStateKey).toBe(
      deriveRObjectStateKey(carol.id, finished.resultAnalysisObjectId)
    );
    expect(loadCall.objectStateKey).not.toBe(deriveRObjectStateKey(alice.id, source.id));

    const children = await db.listProjectAnalysisObjectChildren(alice.id, project.id, source.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toEqual(expect.objectContaining({
      childAnalysisObjectId: fork.id,
      edgeType: 'checkpoint_fork',
      jobId: job.id,
    }));
  });

  it('returns only safe fork metadata to project members', async () => {
    const { project, source, checkpoint } = await seedProject();
    const carol = await db.createUser('carol@example.com', 'password123', 'Carol');
    await db.addProjectMemberByEmail(project.id, carol.email, 'analyst', 'owner');
    const job = await db.createProjectJob(carol.id, project.id, {
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    await drain(caller([]));

    const publicArtifact = (await db.listProjectJobArtifacts(carol.id, project.id, job.id))[0];
    const serialized = JSON.stringify(publicArtifact);
    expect(publicArtifact.artifactType).toBe('checkpoint_fork');
    expect(publicArtifact).not.toHaveProperty('storageUri');
    expect(serialized).not.toContain(checkpoint.storageUri);
    expect(serialized).not.toMatch(/state.?key/i);
    expect(serialized).not.toMatch(/claim.?token/i);
  });

  it('keeps owner-only reattach separate from collaborator fork', async () => {
    const { project, source } = await seedProject();
    const carol = await db.createUser('carol@example.com', 'password123', 'Carol');
    await db.addProjectMemberByEmail(project.id, carol.email, 'analyst', 'owner');

    await expect(db.createProjectJob(carol.id, project.id, {
      jobType: 'checkpoint.load.v1',
      analysisObjectId: source.id,
      parameters: {},
    })).rejects.toMatchObject({ code: 'ANALYSIS_OBJECT_NOT_FOUND' });

    await expect(db.createProjectJob(carol.id, project.id, {
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: source.id,
      parameters: {},
    })).resolves.toMatchObject({ jobType: 'checkpoint.fork.v1' });
  });

  it('blocks viewers, non-members, cross-project sources, and client parameters', async () => {
    const { alice, project, source } = await seedProject();
    const viewer = await db.createUser('viewer@example.com', 'password123', 'Viewer');
    const stranger = await db.createUser('stranger@example.com', 'password123', 'Stranger');
    await db.addProjectMemberByEmail(project.id, viewer.email, 'viewer', 'owner');
    const otherOrg = await db.createOrganizationForUser(alice.id, { name: 'Other lab' });
    const otherProject = await db.createProjectForUser(alice.id, {
      organizationId: otherOrg.id,
      name: 'Other study',
    });

    await expect(db.createProjectJob(viewer.id, project.id, {
      jobType: 'checkpoint.fork.v1', analysisObjectId: source.id, parameters: {},
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(db.createProjectJob(stranger.id, project.id, {
      jobType: 'checkpoint.fork.v1', analysisObjectId: source.id, parameters: {},
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(db.createProjectJob(alice.id, otherProject.id, {
      jobType: 'checkpoint.fork.v1', analysisObjectId: source.id, parameters: {},
    })).rejects.toMatchObject({ code: 'ANALYSIS_OBJECT_NOT_FOUND' });
    await expect(db.createProjectJob(alice.id, project.id, {
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: source.id,
      parameters: { storageKey: 'projects/other/secret' },
    })).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
  });

  it('does not create durable fork records when R rejects the checkpoint', async () => {
    const { project, source } = await seedProject();
    const carol = await db.createUser('carol@example.com', 'password123', 'Carol');
    await db.addProjectMemberByEmail(project.id, carol.email, 'analyst', 'owner');
    const job = await db.createProjectJob(carol.id, project.id, {
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: source.id,
      parameters: {},
    });

    const result = await drain(caller([], { status: 500, body: { error: 'rejected' } }));

    expect(result.status).toBe('failed');
    expect((await db.getProjectJob(carol.id, project.id, job.id)).resultAnalysisObjectId)
      .toBeFalsy();
    expect(await db.listProjectJobArtifacts(carol.id, project.id, job.id)).toHaveLength(0);
    expect(await db.listProjectAnalysisObjectChildren(carol.id, project.id, source.id))
      .toHaveLength(0);
  });
});
