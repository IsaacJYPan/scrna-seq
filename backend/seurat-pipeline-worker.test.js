import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const dbmod = require('./pgDatabase');
const {
  createUser, createOrganizationForUser, createProjectForUser,
  createDatasetForProject, markDatasetUploaded, createProjectJob, createProjectAnalysisObject, getProjectJob,
  getProjectAnalysisObject, listProjectAnalysisObjectParents, getJobArtifactsByJobId,
  listProjectJobArtifacts, isValidJobType,
} = dbmod;

const CONFIGURED = config.hasPostgresConnection();
const {
  validateSeuratPipelineParams, SEURAT_PIPELINE_PARAM_NAMES,
} = require('./seuratPipeline');
const {
  runRBridgeOperation, R_BRIDGE_OPERATIONS, R_BRIDGE_ALLOWED_TARGETS,
} = require('./rWorkerBridge');
const worker = require('./jobWorker');
const { createJobWorker, DEFAULT_HANDLERS, seuratPipelineHandler } = worker;
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const T0 = '2030-01-01 00:00:00';

function silentLogger() { return { info() {}, warn() {}, error() {} }; }

let server;
beforeAll(async () => { if (!CONFIGURED) return; server = await startServer(); });
afterAll(async () => { if (!CONFIGURED) return; if (server) await new Promise((resolve) => server.close(resolve)); await dbmod.close(); });
beforeEach(async () => { if (!CONFIGURED) return; await dbmod.resetSchemaForTests(); });

async function seedProject(ownerUserId) {
  const org = await createOrganizationForUser(ownerUserId, { name: 'Org' });
  return createProjectForUser(ownerUserId, { organizationId: org.id, name: 'Project' });
}

async function seedUploadedTenxH5Job(params = {}) {
  const alice = await createUser('alice@example.com', 'password123', 'Alice');
  const proj = await seedProject(alice.id);
  const ds = await createDatasetForProject(alice.id, proj.id, {
    fileType: 'tenx_h5',
    originalFilename: 'sample_filtered_feature_bc_matrix.h5',
  });
  const uploaded = await markDatasetUploaded(proj.id, ds.id, {
    internalStorageKey: `vault/alice/datasets/${proj.id}/${ds.id}/sample.h5`,
    sha256: 'b'.repeat(64),
    fileSizeBytes: 1234,
  });
  const inputObject = await createProjectAnalysisObject(alice.id, proj.id, {
    objectType: 'matrix',
    datasetId: uploaded.id,
    displayName: 'Raw 10x HDF5 dataset',
    metadata: { source: 'dataset', fileType: 'tenx_h5' },
  });
  const job = await createProjectJob(alice.id, proj.id, {
    jobType: 'seurat.pipeline.v1',
    datasetId: uploaded.id,
    analysisObjectId: inputObject.id,
    parameters: params,
  });
  return { alice, proj, dataset: uploaded, inputObject, job };
}

function pipelineBody() {
  return {
    ok: true,
    summary: {
      n_cells: 100,
      n_features: 2000,
      n_variable_features: 1500,
      n_pcs: 20,
      n_clusters: 4,
      cluster_sizes: [25, 25, 25, 25],
      reductions: ['pca', 'umap'],
      normalization_method: 'LogNormalize',
      resolution: 0.8,
      used_seed: 9,
    },
    warnings: ['percent.mt could not be computed'],
    checkpoint: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 999 },
    versions: { seurat_version: '5.0.1', r_version: 'R version 4.5.3' },
  };
}

function recordingCaller(calls, body = pipelineBody()) {
  return async (req) => { calls.push(req); return { status: 200, body }; };
}

async function drain(callR) {
  const w = createJobWorker({ db: dbmod, now: () => T0, logger: silentLogger(), callR });
  return w.runOnce();
}

describe('seurat.pipeline.v1 inventory and validation', () => {
  it('registers one job handler and one allowlisted bridge target', () => {
    expect(isValidJobType('seurat.pipeline.v1')).toBe(true);
    expect(DEFAULT_HANDLERS['seurat.pipeline.v1']).toBe(seuratPipelineHandler);
    expect(R_BRIDGE_OPERATIONS['r.seurat.pipeline.v1'].path).toBe('/object/seurat-pipeline');
    expect([...R_BRIDGE_ALLOWED_TARGETS].sort()).toContain('POST /object/seurat-pipeline');
  });

  it('strictly validates known parameters and rejects unknown or string-smuggled values', () => {
    const { params, defaultsApplied } = validateSeuratPipelineParams({});
    expect(params.normalizationMethod).toBe('LogNormalize');
    expect(params.applyQcFilter).toBe(true);
    expect(defaultsApplied.sort()).toEqual(SEURAT_PIPELINE_PARAM_NAMES.slice().sort());
    expect(() => validateSeuratPipelineParams({ unknown: 1 })).toThrowError(/Unknown parameter/);
    expect(() => validateSeuratPipelineParams({ pcaDims: '50' })).toThrowError(/finite number/);
    expect(() => validateSeuratPipelineParams({ applyQcFilter: 'true' })).toThrowError(/boolean/);
    expect(() => validateSeuratPipelineParams({ minFeaturesFilter: 500, maxFeaturesFilter: 100 })).toThrowError(/must be <=/);
  });
});

describe.skipIf(!CONFIGURED)('seurat.pipeline.v1 project job creation boundary', () => {
  it('rejects unknown params at the API before a job is created', async () => {
    const { user, token } = await createUserWithToken({ email: 'route-owner@example.com' });
    const proj = await seedProject(user.id);
    const ds = await createDatasetForProject(user.id, proj.id, { fileType: 'tenx_h5' });
    await markDatasetUploaded(proj.id, ds.id, {
      internalStorageKey: `vault/route/datasets/${proj.id}/${ds.id}/sample.h5`,
      sha256: 'c'.repeat(64),
      fileSizeBytes: 1,
    });
    const inputObject = await createProjectAnalysisObject(user.id, proj.id, {
      objectType: 'matrix',
      datasetId: ds.id,
    });
    const res = await api(server, `/api/projects/${proj.id}/jobs`, {
      method: 'POST',
      token,
      body: { jobType: 'seurat.pipeline.v1', datasetId: ds.id, analysisObjectId: inputObject.id, parameters: { evil: 1 } },
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/Unknown parameter/);
  });

  it('rejects legacy owner-scoped creation for the dataset-backed pipeline type', async () => {
    const { token } = await createUserWithToken({ email: 'legacy-owner@example.com' });
    const res = await api(server, '/api/jobs', {
      method: 'POST',
      token,
      body: { jobType: 'seurat.pipeline.v1', parameters: {} },
    });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!CONFIGURED)('seurat.pipeline.v1 bridge and worker outputs', () => {
  it('bridge builds a fixed R request from server-side dataset/checkpoint keys only', async () => {
    const { job, dataset } = await seedUploadedTenxH5Job({ pcaDims: 20 });
    const calls = [];
    let dispatchMarkers = 0;
    const descriptor = await runRBridgeOperation({
      job,
      operation: 'r.seurat.pipeline.v1',
      seuratPipeline: {
        params: validateSeuratPipelineParams(job.parameters).params,
        datasetStorageKey: dataset.internalStorageKey,
        datasetFileType: dataset.fileType,
        checkpointStorageKey: `projects/${job.projectId}/checkpoints/${job.id}/checkpoint.rds`,
      },
      input: { path: '../../escape', code: 'system("x")' },
      callR: recordingCaller(calls),
      markRDispatchStarted: async () => { dispatchMarkers += 1; },
      logger: silentLogger(),
    });
    expect(dispatchMarkers).toBe(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/object/seurat-pipeline');
    expect(calls[0].body.dataset_storage_key).toBe(dataset.internalStorageKey);
    expect(calls[0].body.storage_key).toBe(
      `projects/${job.projectId}/checkpoints/${job.id}/checkpoint.rds`
    );
    expect(calls[0].body.completion_receipt).toEqual({
      version: 1,
      job_id: job.id,
      job_type: 'seurat.pipeline.v1',
      r_operation: 'r.seurat.pipeline.v1',
      project_id: job.projectId,
      receipt_storage_key: `projects/${job.projectId}/artifacts/${job.id}/completion-receipt.json`,
      source_analysis_object_id: job.analysisObjectId,
      source_dataset_id: job.datasetId,
      source_checkpoint_artifact_id: null,
      target_analysis_object_id: null,
      output_storage_key: `projects/${job.projectId}/checkpoints/${job.id}/checkpoint.rds`,
    });
    expect(calls[0].body).not.toHaveProperty('path');
    expect(calls[0].body).not.toHaveProperty('code');
    expect(descriptor.checkpoint.saved).toBe(true);
  });

  it('worker success creates source object, result object, lineage edge, checkpoint, summary, and job link', async () => {
    const { alice, proj, dataset, inputObject, job } = await seedUploadedTenxH5Job({ seed: 9 });
    const calls = [];
    const res = await drain(recordingCaller(calls));
    expect(res.status).toBe('completed');

    const after = await getProjectJob(alice.id, proj.id, job.id);
    expect(after.resultAnalysisObjectId).toMatch(/^ao_/);
    const result = await getProjectAnalysisObject(alice.id, proj.id, after.resultAnalysisObjectId);
    expect(result.datasetId).toBe(dataset.id);
    expect(result.metadata.source).toBe('seurat.pipeline.v1');
    expect(result.metadata.resolvedParams.seed).toBe(9);

    const parents = await listProjectAnalysisObjectParents(alice.id, proj.id, result.id);
    expect(parents).toHaveLength(1);
    expect(parents[0].parentAnalysisObjectId).toBe(inputObject.id);
    expect(parents[0].edgeType).toBe('checkpoint');

    const artifacts = await getJobArtifactsByJobId(job.id);
    expect(artifacts.map(a => a.artifactType).sort()).toEqual(['checkpoint', 'pipeline_summary']);
    const publicArtifacts = await listProjectJobArtifacts(alice.id, proj.id, job.id);
    expect(JSON.stringify(publicArtifacts)).not.toContain(dataset.internalStorageKey);
    expect(JSON.stringify(publicArtifacts)).not.toContain('storageUri');
  });

  it('ambiguous worker response creates no successful outputs and logs safe R diagnostics', async () => {
    const { alice, proj, job } = await seedUploadedTenxH5Job({});
    const res = await drain(async () => ({ status: 500, body: { error: 'raw path /vault/x', code: 'missing_hdf5r' } }));
    expect(res.status).toBe('indeterminate');
    const failed = await getProjectJob(alice.id, proj.id, job.id);
    expect(failed.resultAnalysisObjectId).toBeFalsy();
    expect(JSON.stringify(failed.logs)).toContain('status=500');
    expect(JSON.stringify(failed.logs)).toContain('missing_hdf5r');
    expect(JSON.stringify(failed.logs)).not.toContain('/vault/x');
    expect(await getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });
});
