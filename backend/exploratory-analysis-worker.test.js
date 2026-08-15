import { describe, it, expect, beforeEach, afterAll } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const {
  validateExploratoryAnalysisParams,
} = require('./exploratoryAnalysis');
const {
  sanitizeExplorationSummary,
} = require('./rWorkerBridge');
const {
  createJobWorker,
  exploratoryAnalysisHandler,
  DEFAULT_HANDLERS,
} = require('./jobWorker');
const { deriveRObjectStateKey } = require('./rStateKeys');

const CONFIGURED = config.hasPostgresConnection();
const T0 = '2030-01-01 00:00:00';

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function hydrationBody() {
  return {
    loaded: true,
    runtime_instance_id: 'explore-private-runtime-0001',
    checksum_verified: true,
    class: 'Seurat',
    n_cells: 2700,
    n_features: 13714,
    assays: ['RNA'],
    reductions: ['pca', 'umap'],
    n_meta_fields: 3,
    meta_fields: ['orig.ident', 'percent.mt', 'seurat_clusters'],
    seurat_version: '5.0.1',
    r_version: 'R version 4.6.0',
  };
}

function explorationBody() {
  return {
    recipe: 'feature_by_group',
    n_cells: 2700,
    n_features: 13714,
    metadata_fields: ['orig.ident', 'seurat_clusters'],
    panels: [{
      type: 'feature_group',
      title: 'Marker expression by cluster',
      field: 'seurat_clusters',
      rows: [
        { feature: 'CD3D', group: '0', average: 2.4, pct_detected: 0.91 },
        { feature: 'MS4A1', group: '1', average: 3.1, pct_detected: 0.88 },
      ],
    }],
  };
}

async function seedCheckpoint() {
  const user = await db.createUser('explorer@example.com', 'password123', 'Explorer');
  const org = await db.createOrganizationForUser(user.id, { name: 'Exploration org' });
  const project = await db.createProjectForUser(user.id, {
    organizationId: org.id, name: 'Exploration project',
  });
  const parent = await db.createProjectAnalysisObject(user.id, project.id, {
    objectType: 'seurat', displayName: 'Input object',
  });
  const producer = await db.createProjectJob(user.id, project.id, {
    jobType: 'pbmc.pipeline.v1', analysisObjectId: parent.id, parameters: {},
  });
  const workerId = 'pool-1:exploration-checkpoint-seed';
  const claim = await db.claimNextJob(workerId, { now: T0, leaseSeconds: 30 });
  const committed = await db.completePbmcPipelineResultByWorker(
    producer.id,
    workerId,
    claim.claimToken,
    {
      result: { displayName: 'Checkpoint-backed object', metadata: {} },
      checkpointArtifact: {
        artifactType: 'checkpoint',
        storageKind: 'local_internal',
        internalStorageKey: `projects/${project.id}/checkpoints/${producer.id}/checkpoint.rds`,
        checksumSha256: '7'.repeat(64),
        sizeBytes: 2048,
        metadata: {},
      },
      summaryArtifact: {
        artifactType: 'pipeline_summary', storageKind: 'metadata_only', metadata: {},
      },
    },
    { now: T0 }
  );
  await db.completeJobByWorker(producer.id, workerId, claim.claimToken, {
    now: T0, resultAnalysisObjectId: committed.resultObject.id,
  });
  return { user, project, object: committed.resultObject };
}

async function runOnce(callR) {
  const runtime = createJobWorker({
    db,
    now: () => T0,
    logger: silentLogger(),
    callR,
    deriveRObjectStateKey,
  });
  return runtime.runOnce();
}

describe('exploratory analysis validation and sanitization', () => {
  it('accepts only reviewed bounded recipes and parameters', () => {
    expect(validateExploratoryAnalysisParams({
      recipe: 'feature_by_group', features: ['CD3D', 'MS4A1', 'CD3D'], maxGroups: 12,
    }).params).toEqual({
      recipe: 'feature_by_group',
      features: ['CD3D', 'MS4A1'],
      groupBy: 'seurat_clusters',
      maxGroups: 12,
      histogramBins: 24,
    });
    expect(() => validateExploratoryAnalysisParams({ code: 'system("id")' }))
      .toThrowError(/unknown exploratory-analysis parameter/i);
    expect(() => validateExploratoryAnalysisParams({
      recipe: 'metadata_distribution', metadataField: '../../secret',
    })).toThrowError(/unsupported characters/i);
  });

  it('drops raw cells, paths, code, and unknown panel fields from R output', () => {
    const safe = sanitizeExplorationSummary({
      ...explorationBody(),
      raw_matrix: [[1, 2]],
      path: 'C:\\private\\checkpoint.rds',
      code: 'system("id")',
      panels: [{
        ...explorationBody().panels[0],
        rows: [{
          feature: 'CD3D', group: '0', average: 2.4, barcode: 'AAAC', raw_counts: [1, 2],
        }],
      }],
    });
    expect(safe.panels).toHaveLength(1);
    expect(safe.panels[0].rows[0]).toEqual({ feature: 'CD3D', group: '0', average: 2.4 });
    expect(JSON.stringify(safe)).not.toMatch(/raw_matrix|checkpoint|system|barcode|raw_counts/i);
  });
});

describe.skipIf(!CONFIGURED)('explore.summarize.v1 worker contract', () => {
  beforeEach(async () => { await db.resetSchemaForTests(); });
  afterAll(async () => { await db.close(); });

  it('is registered as the reviewed exploratory handler', () => {
    expect(DEFAULT_HANDLERS['explore.summarize.v1']).toBe(exploratoryAnalysisHandler);
  });

  it('rejects invalid parameters before checkpoint hydration or any R contact', async () => {
    const { user, project, object } = await seedCheckpoint();
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'explore.summarize.v1',
      analysisObjectId: object.id,
      parameters: { recipe: 'arbitrary_r', code: 'system("id")' },
    });
    const calls = [];
    const result = await runOnce(async (request) => {
      calls.push(request);
      return { status: 200, body: {} };
    });

    expect(result.status).toBe('failed');
    expect(calls).toHaveLength(0);
    expect(await db.getJobArtifactsByJobId(job.id)).toHaveLength(0);
  });

  it('hydrates job-scoped state, runs one aggregate recipe, and stores only a safe summary', async () => {
    const { user, project, object } = await seedCheckpoint();
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'explore.summarize.v1',
      analysisObjectId: object.id,
      parameters: { recipe: 'feature_by_group', features: ['CD3D', 'MS4A1'] },
    });
    const calls = [];
    const result = await runOnce(async (request) => {
      calls.push(request);
      if (request.path === '/object/checkpoint-load') {
        return { status: 200, body: hydrationBody() };
      }
      if (request.path === '/object/explore-summary') {
        return { status: 200, body: explorationBody() };
      }
      return { status: 404, body: {} };
    });

    expect(result.status).toBe('completed');
    expect(calls.map((call) => call.path)).toEqual([
      '/object/checkpoint-load', '/object/explore-summary',
    ]);
    const expectedStateKey = deriveRObjectStateKey(user.id, `${object.id}-job-${job.id}`);
    expect(calls.every((call) => call.objectStateKey === expectedStateKey)).toBe(true);
    const artifacts = await db.getJobArtifactsByJobId(job.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifactType).toBe('exploration_summary');
    expect(artifacts[0].storageKind).toBe('metadata_only');
    expect(artifacts[0].metadata.aggregate_only).toBe(true);
    expect(artifacts[0].metadata.summary.panels[0].rows).toHaveLength(2);
    expect(JSON.stringify(db.toPublicJobArtifact(artifacts[0])))
      .not.toMatch(/checkpoint\.rds|runtime-0001|user-[0-9]+:obj-|storageUri/i);
  });
});
