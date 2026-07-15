import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const { createJobWorker } = require('./jobWorker');

const CONFIGURED = config.hasPostgresConnection();
const T0 = '2030-01-01 00:00:00';
const T0_PLUS_10 = '2030-01-01 00:00:10';
const EXPIRED = '2030-01-01 00:01:00';

function logger() {
  return { info() {}, warn() {}, error() {} };
}

function deriveRObjectStateKey(ownerUserId, objectId) {
  return `user-${ownerUserId}:obj-${objectId}`;
}

function pbmcResponse() {
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

function seuratResponse() {
  return {
    ...pbmcResponse(),
    warnings: [],
  };
}

function checkpointLoadResponse() {
  return {
    loaded: true,
    checksum_verified: true,
    class: 'Seurat',
    n_cells: 100,
    n_features: 500,
    assays: ['RNA'],
    reductions: ['pca', 'umap'],
    n_meta_fields: 1,
    meta_fields: ['seurat_clusters'],
    seurat_version: '5.0.1',
    r_version: '4.5.3',
  };
}

function rCaller(calls) {
  return async (request) => {
    calls.push(request);
    if (request.path === '/object/pbmc-pipeline') {
      return { status: 200, body: pbmcResponse() };
    }
    if (request.path === '/object/seurat-pipeline') {
      return { status: 200, body: seuratResponse() };
    }
    if (request.path === '/object/checkpoint-load') {
      return { status: 200, body: checkpointLoadResponse() };
    }
    throw new Error(`Unexpected R request: ${request.path}`);
  };
}

function worker(dbImpl, calls, workerId = 'worker_claim_rbac') {
  return createJobWorker({
    db: dbImpl,
    workerId,
    now: () => T0,
    logger: logger(),
    callR: rCaller(calls),
    deriveRObjectStateKey,
  });
}

async function createProject(owner, name = 'Study') {
  const org = await db.createOrganizationForUser(owner.id, { name: `${name} org` });
  return db.createProjectForUser(owner.id, { organizationId: org.id, name });
}

async function createUploadedSeuratJob(ownerUserId, projectId) {
  const dataset = await db.createDatasetForProject(ownerUserId, projectId, {
    fileType: 'tenx_h5',
    originalFilename: 'sample.h5',
  });
  const uploaded = await db.markDatasetUploaded(projectId, dataset.id, {
    internalStorageKey: `vault/tests/datasets/${projectId}/${dataset.id}/sample.h5`,
    sha256: 'b'.repeat(64),
    fileSizeBytes: 1234,
  });
  const inputObject = await db.createProjectAnalysisObject(ownerUserId, projectId, {
    objectType: 'matrix',
    datasetId: uploaded.id,
    displayName: 'Raw dataset',
  });
  const job = await db.createProjectJob(ownerUserId, projectId, {
    jobType: 'seurat.pipeline.v1',
    datasetId: uploaded.id,
    analysisObjectId: inputObject.id,
    parameters: {},
  });
  return { dataset: uploaded, inputObject, job };
}

async function createCheckpointSource(owner, project) {
  const parent = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'seurat',
    displayName: 'Checkpoint parent',
  });
  const pipelineJob = await db.createProjectJob(owner.id, project.id, {
    jobType: 'pbmc.pipeline.v1',
    analysisObjectId: parent.id,
    parameters: {},
  });
  expect(await worker(db, []).runOnce()).toMatchObject({
    status: 'completed',
    jobId: pipelineJob.id,
  });
  const checkpoint = (await db.getJobArtifactsByJobId(pipelineJob.id))
    .find((artifact) => artifact.artifactType === 'checkpoint');
  const source = await db.getProjectAnalysisObject(
    owner.id, project.id, checkpoint.resultAnalysisObjectId
  );
  return { parent, pipelineJob, source, checkpoint };
}

afterAll(async () => {
  if (CONFIGURED) await db.close();
});

describe.skipIf(!CONFIGURED)('running project job claim authorization', () => {
  beforeEach(async () => {
    await db.resetSchemaForTests();
  });

  it('executes a claimed Seurat handler after the creator is demoted below analyst', async () => {
    const owner = await db.createUser('owner@example.com', 'password123', 'Owner');
    const analyst = await db.createUser('analyst@example.com', 'password123', 'Analyst');
    const project = await createProject(owner);
    await db.addProjectMemberByEmail(project.id, analyst.email, 'analyst', { userId: owner.id });
    const { dataset, inputObject, job } = await createUploadedSeuratJob(analyst.id, project.id);
    let claimedId = null;
    const postClaimDemotionDb = {
      ...db,
      claimNextJob: async (...args) => {
        const claimed = await db.claimNextJob(...args);
        claimedId = claimed && claimed.id;
        await db.updateProjectMemberRole(
          project.id, analyst.id, 'viewer', { userId: owner.id }
        );
        return claimed;
      },
    };
    const calls = [];

    const result = await worker(postClaimDemotionDb, calls).runOnce();

    expect(claimedId).toBe(job.id);
    expect(result).toMatchObject({ status: 'completed', jobId: job.id });
    expect(calls.map((call) => call.path)).toEqual(['/object/seurat-pipeline']);
    expect(calls[0].body.dataset_storage_key).toBe(dataset.internalStorageKey);
    const finished = await db.getProjectJob(owner.id, project.id, job.id);
    const resultObject = await db.getProjectAnalysisObject(
      owner.id, project.id, finished.resultAnalysisObjectId
    );
    expect(resultObject).toMatchObject({
      ownerUserId: analyst.id,
      projectId: project.id,
      datasetId: dataset.id,
      parentObjectId: inputObject.id,
    });
    expect(await db.getProjectMember(project.id, analyst.id)).toMatchObject({ role: 'viewer' });
  });

  it('executes a claimed checkpoint fork after creator removal but keeps output project-scoped', async () => {
    const owner = await db.createUser('owner@example.com', 'password123', 'Owner');
    const analyst = await db.createUser('analyst@example.com', 'password123', 'Analyst');
    const project = await createProject(owner);
    const { source, checkpoint } = await createCheckpointSource(owner, project);
    await db.addProjectMemberByEmail(project.id, analyst.email, 'analyst', { userId: owner.id });
    const job = await db.createProjectJob(analyst.id, project.id, {
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    let claimedId = null;
    const postClaimRemovalDb = {
      ...db,
      claimNextJob: async (...args) => {
        const claimed = await db.claimNextJob(...args);
        claimedId = claimed && claimed.id;
        await db.removeProjectMember(project.id, analyst.id, { userId: owner.id });
        return claimed;
      },
    };
    const calls = [];

    const result = await worker(postClaimRemovalDb, calls).runOnce();

    expect(claimedId).toBe(job.id);
    expect(result).toMatchObject({ status: 'completed', jobId: job.id });
    expect(calls.map((call) => call.path)).toEqual(['/object/checkpoint-load']);
    expect(calls[0].body.storage_key).toBe(checkpoint.storageUri);
    const finished = await db.getProjectJob(owner.id, project.id, job.id);
    const fork = await db.getProjectAnalysisObject(
      owner.id, project.id, finished.resultAnalysisObjectId
    );
    expect(fork).toMatchObject({
      ownerUserId: analyst.id,
      projectId: project.id,
      parentObjectId: source.id,
    });
    expect(await db.getProjectMember(project.id, analyst.id)).toBeNull();
    await expect(db.getProjectJob(analyst.id, project.id, job.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await db.getPrivateJobForUser(job.id, analyst.id)).toBeNull();
    expect(await db.getPrivateAnalysisObjectForUser(fork.id, analyst.id)).toBeNull();
  });

  it('rejects wrong workers, wrong tokens, expired leases, and wrong resolver/job bindings', async () => {
    const owner = await db.createUser('owner@example.com', 'password123', 'Owner');
    const project = await createProject(owner);
    const { dataset, inputObject, job } = await createUploadedSeuratJob(owner.id, project.id);
    const claimed = await db.claimNextJob('worker_valid', { now: T0, leaseSeconds: 30 });

    await expect(db.getSeuratPipelineInputsForJobByWorker(
      job.id, 'worker_other', claimed.claimToken, { now: T0_PLUS_10 }
    )).rejects.toMatchObject({ code: 'CLAIM_LOST' });
    await expect(db.getSeuratPipelineInputsForJobByWorker(
      job.id, 'worker_valid', 'wct_wrong', { now: T0_PLUS_10 }
    )).rejects.toMatchObject({ code: 'CLAIM_LOST' });
    await expect(db.getSeuratPipelineInputsForJobByWorker(
      job.id, 'worker_valid', claimed.claimToken, { now: EXPIRED }
    )).rejects.toMatchObject({ code: 'CLAIM_LOST' });
    await expect(db.getForkableCheckpointForJobByWorker(
      job.id, 'worker_valid', claimed.claimToken, { now: T0_PLUS_10 }
    )).rejects.toMatchObject({ code: 'INVALID_JOB_TYPE' });

    await expect(db.getSeuratPipelineInputsForJobByWorker(
      job.id, 'worker_valid', claimed.claimToken, { now: T0_PLUS_10 }
    )).resolves.toEqual({ dataset, inputObject });
  });

  it('rejects cross-project object, dataset, and checkpoint artifact bindings before R contact', async () => {
    const owner = await db.createUser('owner@example.com', 'password123', 'Owner');
    const project = await createProject(owner, 'Primary');
    const otherProject = await createProject(owner, 'Other');

    const otherSource = await db.createProjectAnalysisObject(owner.id, otherProject.id, {
      objectType: 'seurat',
      displayName: 'Other project source',
    });
    const crossObjectJob = await db.createJobForUser(owner.id, {
      jobType: 'checkpoint.fork.v1',
      projectId: project.id,
      analysisObjectId: otherSource.id,
      parameters: {},
    });
    const crossObjectCalls = [];
    expect(await worker(db, crossObjectCalls, 'worker_cross_object').runOnce())
      .toMatchObject({ status: 'failed', jobId: crossObjectJob.id });
    expect(crossObjectCalls).toHaveLength(0);

    const { job: seuratJob } = await createUploadedSeuratJob(owner.id, project.id);
    const otherDataset = await db.createDatasetForProject(owner.id, otherProject.id, {
      fileType: 'tenx_h5',
      originalFilename: 'other.h5',
    });
    await db.query('UPDATE jobs SET dataset_id = $1 WHERE id = $2', [otherDataset.id, seuratJob.id]);
    const crossDatasetCalls = [];
    expect(await worker(db, crossDatasetCalls, 'worker_cross_dataset').runOnce())
      .toMatchObject({ status: 'failed', jobId: seuratJob.id });
    expect(crossDatasetCalls).toHaveLength(0);

    const { source, checkpoint } = await createCheckpointSource(owner, project);
    await db.query('UPDATE job_artifacts SET project_id = $1 WHERE id = $2', [
      otherProject.id,
      checkpoint.id,
    ]);
    const crossArtifactJob = await db.createProjectJob(owner.id, project.id, {
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: source.id,
      parameters: {},
    });
    const crossArtifactCalls = [];
    expect(await worker(db, crossArtifactCalls, 'worker_cross_artifact').runOnce())
      .toMatchObject({ status: 'failed', jobId: crossArtifactJob.id });
    expect(crossArtifactCalls).toHaveLength(0);
  });
});
