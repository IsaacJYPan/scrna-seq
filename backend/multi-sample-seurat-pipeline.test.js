import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const {
  validateMultiSampleSeuratParams,
  MAX_MULTI_SAMPLE_INPUTS,
} = require('./multiSampleSeuratPipeline');
const {
  runRBridgeOperation,
  R_BRIDGE_OPERATIONS,
} = require('./rWorkerBridge');
const {
  createJobWorker,
  DEFAULT_HANDLERS,
  seuratPipelineHandler,
} = require('./jobWorker');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
const T0 = '2030-01-01 00:00:00';
const silentLogger = () => ({ info() {}, warn() {}, error() {} });

let server;
beforeAll(async () => { if (CONFIGURED) server = await startServer(); });
afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise(resolve => server.close(resolve));
  await db.close();
});
beforeEach(async () => { if (CONFIGURED) await db.resetSchemaForTests(); });

function sample(datasetId, sampleName, conditionName, extra = {}) {
  return { datasetId, sampleName, conditionName, donorCode: null, batch: null, ...extra };
}

function validSamples(ids = ['ds_a1', 'ds_b2', 'ds_c3', 'ds_d4']) {
  return [
    sample(ids[0], 'control 1', 'control'),
    sample(ids[1], 'control 2', 'control'),
    sample(ids[2], 'treated 1', 'treated'),
    sample(ids[3], 'treated 2', 'treated'),
  ];
}

async function seedProject(ownerUserId, name = 'Project') {
  const org = await db.createOrganizationForUser(ownerUserId, { name: `${name} Org` });
  return db.createProjectForUser(ownerUserId, { organizationId: org.id, name });
}

async function seedUploadedDatasets(ownerUserId, projectId, count = 4) {
  const datasets = [];
  for (let index = 0; index < count; index += 1) {
    const created = await db.createDatasetForProject(ownerUserId, projectId, {
      fileType: 'tenx_h5',
      originalFilename: `sample_${index + 1}.h5`,
    });
    datasets.push(await db.markDatasetUploaded(projectId, created.id, {
      internalStorageKey: `projects/${projectId}/datasets/${created.id}/sample_${index + 1}.h5`,
      sha256: String(index + 1).repeat(64),
      fileSizeBytes: 1024 + index,
    }));
  }
  return datasets;
}

async function seedMultiSampleJob() {
  const owner = await db.createUser('multi-owner@example.com', 'password123', 'Owner');
  const project = await seedProject(owner.id);
  const datasets = await seedUploadedDatasets(owner.id, project.id);
  const samples = validSamples(datasets.map(dataset => dataset.id));
  const inputObject = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'matrix',
    datasetId: datasets[0].id,
    displayName: 'Primary multi-sample input',
  });
  const job = await db.createProjectJob(owner.id, project.id, {
    jobType: 'seurat.multisample.v1',
    datasetId: datasets[0].id,
    analysisObjectId: inputObject.id,
    parameters: { samples, seed: 11 },
  });
  return { owner, project, datasets, samples, inputObject, job };
}

function pipelineBody() {
  return {
    ok: true,
    summary: {
      n_cells: 400,
      n_features: 2000,
      pre_filter_cells: 400,
      post_filter_cells: 360,
      percent_mt_available: true,
      n_variable_features: 1500,
      n_pcs: 20,
      n_clusters: 4,
      cluster_sizes: [90, 90, 90, 90],
      reductions: ['pca', 'umap'],
      normalization_method: 'LogNormalize',
      resolution: 0.8,
      used_seed: 11,
      n_samples: 4,
      conditions: ['control', 'treated'],
      samples_per_condition: [
        { condition: 'control', n: 2 },
        { condition: 'treated', n: 2 },
      ],
    },
    warnings: [],
    checkpoint: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 4096 },
    versions: { seurat_version: '5.3.0', r_version: '4.5.3' },
  };
}

describe('seurat.multisample.v1 parameter contract', () => {
  it('is explicitly registered and normalizes a bounded sample design', () => {
    expect(db.isValidJobType('seurat.multisample.v1')).toBe(true);
    expect(DEFAULT_HANDLERS['seurat.multisample.v1']).toBe(seuratPipelineHandler);
    expect(R_BRIDGE_OPERATIONS['r.seurat.multisample.v1']).toMatchObject({
      path: '/object/seurat-pipeline',
      carriesMultiSampleSeuratParams: true,
      defaultTimeoutMs: 600000,
    });
    const validated = validateMultiSampleSeuratParams({
      samples: validSamples(),
      pcaDims: 20,
    });
    expect(validated.samples).toHaveLength(4);
    expect(validated.params.pcaDims).toBe(20);
    expect(validated.params.normalizationMethod).toBe('LogNormalize');
  });

  it('rejects duplicate datasets/names, unsafe labels, one condition, and oversized input lists', () => {
    const duplicateDataset = validSamples();
    duplicateDataset[1].datasetId = duplicateDataset[0].datasetId;
    expect(() => validateMultiSampleSeuratParams({ samples: duplicateDataset })).toThrow(/only once/);

    const duplicateName = validSamples();
    duplicateName[1].sampleName = 'CONTROL 1';
    expect(() => validateMultiSampleSeuratParams({ samples: duplicateName })).toThrow(/unique/);

    const unsafe = validSamples();
    unsafe[0].sampleName = '../../sample';
    expect(() => validateMultiSampleSeuratParams({ samples: unsafe })).toThrow(/must be 1-80/);

    expect(() => validateMultiSampleSeuratParams({
      samples: validSamples().map(row => ({ ...row, conditionName: 'control' })),
    })).toThrow(/two distinct conditions/);

    const tooMany = Array.from({ length: MAX_MULTI_SAMPLE_INPUTS + 1 }, (_, index) => (
      sample(`ds_${(index + 100).toString(16)}`, `sample ${index}`, index % 2 ? 'a' : 'b')
    ));
    expect(() => validateMultiSampleSeuratParams({ samples: tooMany })).toThrow(/2-48/);
  });
});

describe.skipIf(!CONFIGURED)('seurat.multisample.v1 project and worker boundary', () => {
  it('rejects cross-project sample datasets and primary-dataset mismatches before queueing', async () => {
    const { user, token } = await createUserWithToken({ email: 'route-multi@example.com' });
    const projectA = await seedProject(user.id, 'A');
    const projectB = await seedProject(user.id, 'B');
    const datasetsA = await seedUploadedDatasets(user.id, projectA.id, 4);
    const datasetsB = await seedUploadedDatasets(user.id, projectB.id, 1);
    const inputObject = await db.createProjectAnalysisObject(user.id, projectA.id, {
      objectType: 'matrix', datasetId: datasetsA[0].id,
    });
    const samples = validSamples(datasetsA.map(dataset => dataset.id));

    const mismatch = await api(server, `/api/projects/${projectA.id}/jobs`, {
      method: 'POST', token,
      body: {
        jobType: 'seurat.multisample.v1', datasetId: datasetsA[0].id,
        analysisObjectId: inputObject.id,
        parameters: { samples: [samples[1], samples[0], samples[2], samples[3]] },
      },
    });
    expect(mismatch.status).toBe(400);

    samples[3].datasetId = datasetsB[0].id;
    const crossProject = await api(server, `/api/projects/${projectA.id}/jobs`, {
      method: 'POST', token,
      body: {
        jobType: 'seurat.multisample.v1', datasetId: datasetsA[0].id,
        analysisObjectId: inputObject.id, parameters: { samples },
      },
    });
    expect(crossProject.status).toBe(404);
    expect(crossProject.data.error).toBe('One or more multi-sample datasets were not found.');
  });

  it('builds the R request only from claim-resolved storage keys and publishes a reusable result', async () => {
    const seeded = await seedMultiSampleJob();
    const calls = [];
    const worker = createJobWorker({
      db,
      now: () => T0,
      logger: silentLogger(),
      callR: async (request) => {
        calls.push(request);
        return { status: 200, body: pipelineBody() };
      },
    });
    const outcome = await worker.runOnce();
    expect(outcome.status).toBe('completed');
    expect(calls).toHaveLength(1);
    expect(calls[0].body.dataset_inputs).toEqual(seeded.samples.map((row, index) => ({
      storage_key: seeded.datasets[index].internalStorageKey,
      file_type: 'tenx_h5',
      sample_name: row.sampleName,
      condition_name: row.conditionName,
      donor_code: null,
      batch: null,
    })));
    expect(calls[0].body).not.toHaveProperty('dataset_storage_key');
    expect(calls[0].body.completion_receipt).toMatchObject({
      job_type: 'seurat.multisample.v1',
      r_operation: 'r.seurat.multisample.v1',
      source_dataset_id: seeded.datasets[0].id,
    });

    const completed = await db.getProjectJob(seeded.owner.id, seeded.project.id, seeded.job.id);
    const result = await db.getProjectAnalysisObject(
      seeded.owner.id, seeded.project.id, completed.resultAnalysisObjectId
    );
    expect(result.metadata.source).toBe('seurat.multisample.v1');
    expect(result.metadata.datasetIds).toEqual(seeded.datasets.map(dataset => dataset.id));
    expect(result.metadata.sampleMetadataColumn).toBe('sample_id');
    expect(result.metadata.conditionMetadataColumn).toBe('condition');
    expect(result.metadata.summary).toMatchObject({ nSamples: 4, conditions: ['control', 'treated'] });
    expect(await db.listProjectAnalysisObjectParents(seeded.owner.id, seeded.project.id, result.id))
      .toHaveLength(1);
  });
});

describe.skipIf(!CONFIGURED)('seurat.multisample.v1 bridge request construction', () => {
  it('drops arbitrary input fields and carries bounded server-resolved sample metadata', async () => {
    const { job, datasets, samples } = await seedMultiSampleJob();
    const calls = [];
    await runRBridgeOperation({
      job,
      operation: 'r.seurat.multisample.v1',
      multiSampleSeuratPipeline: {
        params: validateMultiSampleSeuratParams(job.parameters).params,
        inputs: samples.map((row, index) => ({
          datasetStorageKey: datasets[index].internalStorageKey,
          datasetFileType: datasets[index].fileType,
          sampleName: row.sampleName,
          conditionName: row.conditionName,
          donorCode: row.donorCode,
          batch: row.batch,
        })),
        checkpointStorageKey: `projects/${job.projectId}/checkpoints/${job.id}/checkpoint.rds`,
      },
      input: { path: '../../escape', code: 'system("x")' },
      markRDispatchStarted: async () => {},
      callR: async request => { calls.push(request); return { status: 200, body: pipelineBody() }; },
      logger: silentLogger(),
    });
    expect(JSON.stringify(calls[0].body)).not.toContain('../../escape');
    expect(JSON.stringify(calls[0].body)).not.toContain('system');
  });
});
