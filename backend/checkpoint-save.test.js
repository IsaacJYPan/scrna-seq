import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const storage = require('./storage');
const bridge = require('./rWorkerBridge');
const { checkpointSaveHandler, createJobWorker } = require('./jobWorker');
const { deriveRObjectStateKey } = require('./rStateKeys');

const CONFIGURED = config.hasPostgresConnection();
const T0 = '2032-01-01 00:00:00';

const job = {
  id: 'job_aaaaaaaaaaaaaaaaaaaaaaaa',
  jobType: 'checkpoint.save.v1',
  projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbb',
  analysisObjectId: 'ao_cccccccccccccccccccccccc',
  ownerUserId: 7,
  datasetId: null,
  parameters: {},
  attempts: 1,
};

function savedBody() {
  return {
    ok: true,
    summary: {
      n_cells: 2700,
      n_features: 13714,
      n_clusters: 9,
      cluster_sizes: [300],
      reductions: ['pca', 'umap'],
    },
    checkpoint: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 1234 },
    versions: { seurat_version: '5.3.1', r_version: '4.5.3' },
  };
}

describe('checkpoint.save.v1 bridge boundary', () => {
  it('builds an exact server-controlled request and drops arbitrary input', async () => {
    const checkpointStorageKey = storage.projectStorageFileKey(
      job.projectId, 'checkpoints', job.id, 'checkpoint.rds'
    );
    const calls = [];
    const descriptor = await bridge.runRBridgeOperation({
      job,
      operation: 'r.checkpoint.save.v1',
      objectContext: { objectId: job.analysisObjectId, stateKey: 'user-7:obj-ao_cccccccccccccccccccccccc' },
      checkpointSave: { checkpointStorageKey },
      input: { code: 'system("whoami")', storage_key: '../../outside' },
      markRDispatchStarted: vi.fn().mockResolvedValue(undefined),
      callR: vi.fn(async (request) => {
        calls.push(request);
        return { status: 200, body: savedBody() };
      }),
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/object/checkpoint-save',
      objectStateKey: 'user-7:obj-ao_cccccccccccccccccccccccc',
      body: { operation: 'r.checkpoint.save.v1', storage_key: checkpointStorageKey },
    });
    expect(JSON.stringify(calls[0])).not.toMatch(/whoami|\.\.\/outside/);
    expect(calls[0].body.completion_receipt).toMatchObject({
      job_id: job.id,
      job_type: job.jobType,
      source_analysis_object_id: job.analysisObjectId,
      output_storage_key: checkpointStorageKey,
    });
    expect(descriptor).toMatchObject({
      operation: 'r.checkpoint.save.v1',
      artifactType: 'checkpoint_save',
      checkpoint: { saved: true, checksumSha256: 'a'.repeat(64), sizeBytes: 1234 },
      summary: { nCells: 2700, nFeatures: 13714 },
    });
  });

  it('rejects a missing server checkpoint destination before R contact', async () => {
    const callR = vi.fn();
    await expect(bridge.runRBridgeOperation({
      job,
      operation: 'r.checkpoint.save.v1',
      objectContext: { objectId: job.analysisObjectId, stateKey: 'server-state-key' },
      checkpointSave: {},
      callR,
    })).rejects.toMatchObject({ code: 'R_CHECKPOINT_SAVE_REQUIRED' });
    expect(callR).not.toHaveBeenCalled();
  });
});

describe('checkpointSaveHandler', () => {
  function context(overrides = {}) {
    const checkpointStorageKey = storage.projectStorageFileKey(
      job.projectId, 'checkpoints', job.id, 'checkpoint.rds'
    );
    return {
      job: { ...job },
      workerId: 'worker_test',
      heartbeat: vi.fn().mockResolvedValue(undefined),
      log: vi.fn().mockResolvedValue(undefined),
      logger: { info() {}, warn() {}, error() {} },
      callR: vi.fn(),
      getOwnedAnalysisObject: vi.fn().mockResolvedValue({
        id: job.analysisObjectId, objectType: 'seurat', displayName: 'PBMC work', datasetId: 'ds_1',
      }),
      deriveRObjectStateKey: vi.fn().mockReturnValue('server-state-key'),
      runRBridgeOperation: vi.fn().mockResolvedValue({
        name: 'Saved analysis summary',
        description: 'Safe summary',
        summary: { nCells: 2700, nFeatures: 13714 },
        checkpoint: { saved: true, checksumSha256: 'b'.repeat(64), sizeBytes: 4321 },
        metadata: { operation: 'r.checkpoint.save.v1', kind: 'checkpoint_save' },
      }),
      completePbmcPipelineResult: vi.fn().mockResolvedValue({
        resultObject: { id: 'ao_dddddddddddddddddddddddd' },
        checkpointArtifact: { id: 'art_checkpoint' },
        summaryArtifact: { id: 'art_summary' },
      }),
      removeDurableObject: vi.fn().mockResolvedValue(undefined),
      checkpointStorageKey,
      ...overrides,
    };
  }

  it('publishes an immutable child and checkpoint only after a successful save', async () => {
    const ctx = context();
    const result = await checkpointSaveHandler(ctx);
    expect(ctx.getOwnedAnalysisObject).toHaveBeenCalledOnce();
    expect(ctx.runRBridgeOperation).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'r.checkpoint.save.v1',
      objectContext: { objectId: job.analysisObjectId, stateKey: 'server-state-key' },
      checkpointSave: { checkpointStorageKey: ctx.checkpointStorageKey },
    }));
    expect(ctx.completePbmcPipelineResult).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ objectType: 'seurat', displayName: 'Saved PBMC work' }),
      checkpointArtifact: expect.objectContaining({
        artifactType: 'checkpoint', internalStorageKey: ctx.checkpointStorageKey,
      }),
      summaryArtifact: expect.objectContaining({ artifactType: 'checkpoint_save' }),
    }));
    expect(result.resultAnalysisObjectId).toBe('ao_dddddddddddddddddddddddd');
  });

  it('rejects another user\'s live object before R contact or publication', async () => {
    const ctx = context({ getOwnedAnalysisObject: vi.fn().mockResolvedValue(null) });
    await expect(checkpointSaveHandler(ctx)).rejects.toMatchObject({ code: 'R_OBJECT_NOT_FOUND' });
    expect(ctx.runRBridgeOperation).not.toHaveBeenCalled();
    expect(ctx.completePbmcPipelineResult).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  if (CONFIGURED) await db.close();
});

async function seedProject(owner, name = 'Saved analysis project') {
  const organization = await db.createOrganizationForUser(owner.id, { name: `${name} organization` });
  return db.createProjectForUser(owner.id, { organizationId: organization.id, name });
}

describe.skipIf(!CONFIGURED)('checkpoint.save.v1 database and worker contract', () => {
  beforeEach(async () => {
    await db.resetSchemaForTests();
  });

  it('admits only an owner-scoped, parameterless live-object save', async () => {
    const owner = await db.createUser('owner@example.com', 'password123', 'Owner');
    const collaborator = await db.createUser('collaborator@example.com', 'password123', 'Collaborator');
    const project = await seedProject(owner);
    await db.addProjectMemberByEmail(project.id, collaborator.email, 'analyst', 'owner');
    const source = await db.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat', displayName: 'Live work',
    });

    await expect(db.createProjectJob(collaborator.id, project.id, {
      jobType: 'checkpoint.save.v1', analysisObjectId: source.id, parameters: {},
    })).rejects.toMatchObject({ code: 'ANALYSIS_OBJECT_NOT_FOUND' });

    for (const extra of [
      { parameters: { path: 'C:/private/output.rds' } },
      { datasetId: null },
      { resultAnalysisObjectId: null },
    ]) {
      await expect(db.createProjectJob(owner.id, project.id, {
        jobType: 'checkpoint.save.v1', analysisObjectId: source.id, ...extra,
      })).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
    }

    await expect(db.createProjectJob(owner.id, project.id, {
      jobType: 'checkpoint.save.v1', analysisObjectId: source.id, parameters: {},
    })).resolves.toMatchObject({
      jobType: 'checkpoint.save.v1', analysisObjectId: source.id, datasetId: null, status: 'queued',
    });
  });

  it('atomically publishes a private immutable child, lineage edge, and bounded artifacts', async () => {
    const owner = await db.createUser('owner@example.com', 'password123', 'Owner');
    const project = await seedProject(owner);
    const dataset = await db.createDatasetForProject(owner.id, project.id, { fileType: 'seurat_rds' });
    const source = await db.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat', displayName: 'Live work', datasetId: dataset.id,
    });
    const saveJob = await db.createProjectJob(owner.id, project.id, {
      jobType: 'checkpoint.save.v1', analysisObjectId: source.id, parameters: {},
    });
    const calls = [];
    const worker = createJobWorker({
      db,
      now: () => T0,
      deriveRObjectStateKey,
      logger: { info() {}, warn() {}, error() {} },
      callR: async (request) => {
        calls.push(request);
        return { status: 200, body: savedBody() };
      },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      status: 'completed', jobId: saveJob.id, jobType: 'checkpoint.save.v1',
    });
    const completed = await db.getProjectJob(owner.id, project.id, saveJob.id);
    const saved = await db.getProjectAnalysisObject(
      owner.id, project.id, completed.resultAnalysisObjectId
    );
    expect(saved).toMatchObject({
      ownerUserId: owner.id,
      projectId: project.id,
      datasetId: dataset.id,
      parentObjectId: source.id,
      objectType: 'seurat',
    });
    expect(saved.displayName).toBe('Saved Live work');

    const children = await db.listProjectAnalysisObjectChildren(owner.id, project.id, source.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      childAnalysisObjectId: saved.id, jobId: saveJob.id, edgeType: 'checkpoint',
    });

    const artifacts = await db.getJobArtifactsByJobId(saveJob.id);
    expect(artifacts.map((artifact) => artifact.artifactType).sort())
      .toEqual(['checkpoint', 'checkpoint_save']);
    const checkpoint = artifacts.find((artifact) => artifact.artifactType === 'checkpoint');
    expect(checkpoint).toMatchObject({
      resultAnalysisObjectId: saved.id,
      storageKind: 'local_internal',
      checksumSha256: 'a'.repeat(64),
      sizeBytes: 1234,
    });
    expect(checkpoint.storageUri).toMatch(
      new RegExp(`^projects/${project.id}/checkpoints/${saveJob.id}/checkpoint\\.rds$`)
    );

    const publicArtifacts = await db.listProjectJobArtifacts(owner.id, project.id, saveJob.id);
    expect(JSON.stringify(publicArtifacts)).not.toMatch(/storageUri|storage_key|checkpoint\.rds/i);

    const saveRequests = calls.filter((request) => request.path === '/object/checkpoint-save');
    expect(saveRequests).toHaveLength(1);
    expect(saveRequests[0].objectStateKey).toBe(deriveRObjectStateKey(owner.id, source.id));
    expect(Object.keys(saveRequests[0].body).sort())
      .toEqual(['completion_receipt', 'operation', 'storage_key']);
  });
});
