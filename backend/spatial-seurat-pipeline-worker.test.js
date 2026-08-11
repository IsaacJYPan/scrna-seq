import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const {
  validateSpatialSeuratParams,
  assertSupportedSpatialSeuratDataset,
} = require('./spatialPipeline');
const {
  R_BRIDGE_ALLOWED_TARGETS,
  R_BRIDGE_OPERATIONS,
} = require('./rWorkerBridge');
const {
  DEFAULT_HANDLERS,
  createJobWorker,
  spatialSeuratPipelineHandler,
} = require('./jobWorker');

const CONFIGURED = config.hasPostgresConnection();
const T0 = '2030-01-01 00:00:00';

function silentLogger() { return { info() {}, warn() {}, error() {} }; }

beforeEach(async () => { if (CONFIGURED) await db.resetSchemaForTests(); });
afterAll(async () => { if (CONFIGURED) await db.close(); });

function spatialResponse() {
  return {
    ok: true,
    summary: {
      n_cells: 120,
      n_features: 18000,
      n_variable_features: 2000,
      n_pcs: 30,
      n_clusters: 5,
      cluster_sizes: [24, 24, 24, 24, 24],
      reductions: ['pca', 'umap'],
      normalization_method: 'LogNormalize',
      resolution: 0.8,
      used_seed: 17,
    },
    warnings: [],
    checkpoint: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 12345 },
    versions: { seurat_version: '5.3.0', r_version: 'R version 4.5.3' },
  };
}

async function seedSpatialJob() {
  const owner = await db.createUser('spatial-owner@example.com', 'password123', 'Spatial Owner');
  const org = await db.createOrganizationForUser(owner.id, { name: 'Spatial Org' });
  const project = await db.createProjectForUser(owner.id, { organizationId: org.id, name: 'Spatial Project' });
  const dataset = await db.createDatasetForProject(owner.id, project.id, {
    fileType: 'visium_zip',
    originalFilename: 'sample_outs.zip',
  });
  const uploaded = await db.markDatasetUploaded(project.id, dataset.id, {
    internalStorageKey: `projects/${project.id}/datasets/${dataset.id}/sample_outs.zip`,
    sha256: 'b'.repeat(64),
    fileSizeBytes: 4096,
  });
  await db.setDatasetValidationResult(project.id, dataset.id, 'valid');
  const inputObject = await db.createProjectAnalysisObject(owner.id, project.id, {
    datasetId: uploaded.id,
    objectType: 'matrix',
    displayName: 'Raw Visium dataset',
    metadata: { source: 'dataset', fileType: 'visium_zip' },
  });
  const job = await db.createProjectJob(owner.id, project.id, {
    jobType: 'spatial.seurat.v1',
    datasetId: uploaded.id,
    analysisObjectId: inputObject.id,
    parameters: { seed: 17 },
  });
  return { owner, project, dataset: uploaded, inputObject, job };
}

describe('spatial.seurat.v1 contract', () => {
  it('registers only the fixed worker and bridge operation', () => {
    expect(db.isValidJobType('spatial.seurat.v1')).toBe(true);
    expect(DEFAULT_HANDLERS['spatial.seurat.v1']).toBe(spatialSeuratPipelineHandler);
    expect(R_BRIDGE_OPERATIONS['r.spatial.seurat.v1'].path).toBe('/object/spatial-seurat-pipeline');
    expect([...R_BRIDGE_ALLOWED_TARGETS]).toContain('POST /object/spatial-seurat-pipeline');
  });

  it('reuses strict Seurat parameters and admits only uploaded classic Visium bundles', () => {
    expect(validateSpatialSeuratParams({ normalizationMethod: 'SCTransform' }).params.normalizationMethod)
      .toBe('SCTransform');
    expect(() => validateSpatialSeuratParams({ arbitrary: true })).toThrow(/Unknown parameter/);
    expect(() => assertSupportedSpatialSeuratDataset({ fileType: 'tenx_h5' }))
      .toThrow(/classic 10x Visium/);
    expect(() => assertSupportedSpatialSeuratDataset({
      fileType: 'visium_zip', uploadStatus: 'uploaded', validationStatus: 'pending',
      projectId: 'proj_abc', internalStorageKey: 'projects/proj_abc/datasets/ds_abc/input.zip',
    })).toThrow(/validation must pass/i);
  });
});

describe.skipIf(!CONFIGURED)('spatial.seurat.v1 durable worker path', () => {
  it('sends a server-selected Visium ZIP and publishes a spatial checkpoint lineage result', async () => {
    const { owner, project, dataset, inputObject, job } = await seedSpatialJob();
    const calls = [];
    const worker = createJobWorker({
      db,
      now: () => T0,
      logger: silentLogger(),
      callR: async (request) => {
        calls.push(request);
        return { status: 200, body: spatialResponse() };
      },
    });

    expect((await worker.runOnce()).status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/object/spatial-seurat-pipeline');
    expect(calls[0].body.dataset_file_type).toBe('visium_zip');
    expect(calls[0].body.dataset_storage_key).toBe(dataset.internalStorageKey);
    expect(calls[0].body.completion_receipt.job_type).toBe('spatial.seurat.v1');

    const completed = await db.getProjectJob(owner.id, project.id, job.id);
    const result = await db.getProjectAnalysisObject(owner.id, project.id, completed.resultAnalysisObjectId);
    expect(result.datasetId).toBe(dataset.id);
    expect(result.metadata.source).toBe('spatial.seurat.v1');
    expect(result.metadata.modality).toBe('spatial');
    const parents = await db.listProjectAnalysisObjectParents(owner.id, project.id, result.id);
    expect(parents.map((edge) => edge.parentAnalysisObjectId)).toEqual([inputObject.id]);
    expect((await db.getJobArtifactsByJobId(job.id)).map((artifact) => artifact.artifactType).sort())
      .toEqual(['checkpoint', 'pipeline_summary']);
  });

  it('rejects a non-Visium dataset before any R request', async () => {
    const owner = await db.createUser('wrong-format@example.com', 'password123', 'Wrong Format');
    const org = await db.createOrganizationForUser(owner.id, { name: 'Org' });
    const project = await db.createProjectForUser(owner.id, { organizationId: org.id, name: 'Project' });
    const dataset = await db.createDatasetForProject(owner.id, project.id, { fileType: 'tenx_h5' });
    await db.markDatasetUploaded(project.id, dataset.id, {
      internalStorageKey: `projects/${project.id}/datasets/${dataset.id}/sample.h5`,
      sha256: 'c'.repeat(64), fileSizeBytes: 4,
    });
    const inputObject = await db.createProjectAnalysisObject(owner.id, project.id, {
      datasetId: dataset.id, objectType: 'matrix',
    });
    await expect(db.createProjectJob(owner.id, project.id, {
      jobType: 'spatial.seurat.v1', datasetId: dataset.id,
      analysisObjectId: inputObject.id, parameters: {},
    })).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
  });
});
