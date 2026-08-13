import { describe, expect, it, vi } from 'vitest';

const bridge = require('./rWorkerBridge');
const {
  runRBridgeOperation,
  sanitizeEnrichmentSummary,
  sanitizeEnrichmentResultInfo,
  R_BRIDGE_OPERATIONS,
} = bridge;
const { enrichmentGseaHandler, DEFAULT_HANDLERS } = require('./jobWorker');

const CHECKSUM = 'a'.repeat(64);

function body(overrides = {}) {
  return {
    ok: true,
    summary: {
      method: 'gsea',
      comparison: { target_group: '0', reference: 'rest' },
      group_by: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      gene_set_collection: 'GO_BP',
      rank_metric: 'avg_log2FC',
      input_gene_count: 1000,
      mapped_gene_count: 800,
      mapping_rate: 0.8,
      tested_pathway_count: 120,
      significant_pathway_count: 2,
      package_versions: {
        r: '4.5.3', seurat: '5.3.1',
        annotation_dbi: '1.72.0', go_db: '3.22.0',
        cluster_profiler: '4.16.0',
        fgsea: '1.34.0', organism_db: '3.21.0',
      },
      top_pathways: [{
        pathway_id: 'GO:0006955',
        pathway_name: 'immune response',
        normalized_enrichment_score: 2.1,
        p_value: 0.0001,
        adjusted_p_value: 0.01,
        set_size: 85,
        significant: true,
        direction: 'positive',
      }],
      warnings: ['200 genes could not be mapped'],
    },
    result: { saved: true, checksum_sha256: CHECKSUM, size_bytes: 4096, n_rows: 120 },
    ...overrides,
  };
}

function job(parameters = {}) {
  return {
    id: 'job_abc123',
    jobType: 'enrichment.gsea.v1',
    projectId: 'proj_abc123',
    analysisObjectId: 'ao_abc123',
    datasetId: null,
    ownerUserId: 7,
    parameters: { targetGroup: '0', species: 'human', ...parameters },
  };
}

function handlerContext(parameters = {}) {
  const completion = vi.fn(async () => ({
    resultsArtifact: { id: 'art_results' },
    summaryArtifact: { id: 'art_summary' },
  }));
  const run = vi.fn(async (request) => request.operation === 'r.checkpoint.hydrate.v1'
    ? { loaded: { loaded: true } }
    : {
      artifactType: 'enrichment_summary',
      name: 'Ranked pathway-enrichment summary',
      description: 'Safe summary',
      result: { saved: true, checksumSha256: CHECKSUM, sizeBytes: 4096, nRows: 10 },
      metadata: { summary: sanitizeEnrichmentSummary(body()) },
    });
  return {
    ctx: {
      job: job(parameters),
      workerId: 'worker_abc',
      heartbeat: vi.fn(async () => {}),
      log: vi.fn(async () => {}),
      getOwnedAnalysisObject: vi.fn(async () => ({ id: 'ao_abc123', ownerUserId: 7 })),
      getHydrationCheckpoint: vi.fn(async () => ({
        analysisObjectId: 'ao_abc123', checkpointArtifactId: 'art_checkpoint',
        projectId: 'proj_abc123', storageUri: 'projects/proj_abc123/checkpoints/job_seed/checkpoint.rds',
      })),
      deriveRObjectStateKey: vi.fn(() => 'user-7:obj-abc123'),
      removeDurableObject: vi.fn(async () => {}),
      runRBridgeOperation: run,
      completeEnrichmentGseaResult: completion,
      logger: { info() {}, warn() {}, error() {} },
      callR: vi.fn(),
    },
    run,
    completion,
  };
}

describe('enrichment.gsea.v1 bridge contract', () => {
  it('is a fixed object-scoped, non-mutating operation', () => {
    expect(DEFAULT_HANDLERS['enrichment.gsea.v1']).toBe(enrichmentGseaHandler);
    expect(R_BRIDGE_OPERATIONS['r.enrichment.gsea.v1']).toMatchObject({
      method: 'POST',
      path: '/object/enrichment-gsea',
      artifactType: 'enrichment_summary',
      requiresObjectContext: true,
      carriesEnrichmentParams: true,
      mutating: false,
    });
  });

  it('rebuilds the R request from only validated fields and the server key', async () => {
    const calls = [];
    const source = job({ code: 'system("whoami")', targetGroup: '0' });
    const params = {
      groupBy: 'seurat_clusters', assay: 'RNA', targetGroup: '0', species: 'human',
      geneSetCollection: 'GO_BP', minGeneSetSize: 15, maxGeneSetSize: 500,
      adjustedPValueCutoff: 0.05, topPathways: 15,
      maxCellsPerIdent: 10000, randomSeed: 1,
      code: 'system("whoami")', storageUri: 'C:\\private',
    };
    const descriptor = await runRBridgeOperation({
      job: source,
      operation: 'r.enrichment.gsea.v1',
      objectContext: { objectId: 'ao_abc123', stateKey: 'user-7:obj-abc123' },
      enrichment: {
        params,
        resultStorageKey: 'projects/proj_abc123/artifacts/job_abc123/pathway-enrichment.csv',
      },
      markRDispatchStarted: async () => {},
      callR: async (request) => { calls.push(request); return { status: 200, body: body() }; },
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST', path: '/object/enrichment-gsea',
      objectStateKey: 'user-7:obj-abc123',
    });
    expect(calls[0].body.params).toEqual({
      groupBy: 'seurat_clusters', assay: 'RNA', targetGroup: '0', species: 'human',
      geneSetCollection: 'GO_BP', minGeneSetSize: 15, maxGeneSetSize: 500,
      adjustedPValueCutoff: 0.05, topPathways: 15,
      maxCellsPerIdent: 10000, randomSeed: 1,
    });
    expect(calls[0].body).not.toHaveProperty('code');
    expect(calls[0].body.params).not.toHaveProperty('storageUri');
    expect(calls[0].body.completion_receipt).toMatchObject({
      job_id: 'job_abc123',
      job_type: 'enrichment.gsea.v1',
      r_operation: 'r.enrichment.gsea.v1',
      output_storage_key: 'projects/proj_abc123/artifacts/job_abc123/pathway-enrichment.csv',
    });
    expect(descriptor.summary.topPathways[0]).toEqual({
      id: 'GO:0006955', name: 'immune response', normalizedEnrichmentScore: 2.1,
      pValue: 0.0001, adjustedPValue: 0.01, setSize: 85,
      significant: true, direction: 'positive',
    });
    expect(descriptor.result).toEqual({
      saved: true, checksumSha256: CHECKSUM, sizeBytes: 4096, nRows: 120,
    });
    expect(descriptor.summary.packageVersions).toEqual({
      r: '4.5.3', seurat: '5.3.1', annotationDbi: '1.72.0', goDb: '3.22.0',
      clusterProfiler: '4.16.0', fgsea: '1.34.0', organismDb: '3.21.0',
    });
  });

  it('drops unapproved fields and caps the public pathway preview', () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      pathway_id: `GO:${String(index).padStart(7, '0')}`,
      pathway_name: index === 0 ? 'name C:\\secret / stack' : `term ${index}`,
      normalized_enrichment_score: 1,
      p_value: 0.1,
      adjusted_p_value: 0.2,
      set_size: 10,
      significant: false,
      direction: 'positive',
      genes: ['private', 'gene', 'list'],
    }));
    const summary = sanitizeEnrichmentSummary(body({
      summary: { ...body().summary, top_pathways: rows, expression_matrix: [[1, 2]] },
      storage_key: 'projects/secret.csv',
    }));
    expect(summary.topPathways).toHaveLength(25);
    expect(JSON.stringify(summary)).not.toMatch(/secret|private|expression_matrix|storage/i);
    expect(summary.topPathways[0]).not.toHaveProperty('genes');
  });

  it('rejects oversized result descriptors', () => {
    expect(sanitizeEnrichmentResultInfo(body({
      result: { saved: true, checksum_sha256: CHECKSUM, size_bytes: 51 * 1024 * 1024, n_rows: 1 },
    })).saved).toBe(false);
    expect(sanitizeEnrichmentResultInfo(body({
      result: { saved: true, checksum_sha256: CHECKSUM, size_bytes: 100, n_rows: 100001 },
    })).saved).toBe(false);
  });
});

describe('enrichment.gsea.v1 handler boundary', () => {
  it('validates and owns the object before calling R, then publishes both artifacts', async () => {
    const { ctx, run, completion } = handlerContext();
    const outcome = await enrichmentGseaHandler(ctx);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toMatchObject({
      operation: 'r.checkpoint.hydrate.v1',
      objectContext: { objectId: 'ao_abc123', stateKey: 'user-7:obj-abc123' },
    });
    expect(ctx.deriveRObjectStateKey).toHaveBeenCalledWith(7, 'ao_abc123-job-job_abc123');
    expect(run.mock.calls[1][0]).toMatchObject({
      operation: 'r.enrichment.gsea.v1',
      objectContext: { objectId: 'ao_abc123', stateKey: 'user-7:obj-abc123' },
    });
    expect(completion).toHaveBeenCalledOnce();
    expect(completion.mock.calls[0][0].resultsArtifact).toMatchObject({
      artifactType: 'enrichment_results', storageKind: 'local_internal',
      internalStorageKey: 'projects/proj_abc123/artifacts/job_abc123/pathway-enrichment.csv',
    });
    expect(completion.mock.calls[0][0].summaryArtifact).toMatchObject({
      artifactType: 'enrichment_summary', storageKind: 'metadata_only',
    });
    expect(outcome.result.handled).toBe('enrichment.gsea.v1');
  });

  it('fails invalid parameters before R contact', async () => {
    const { ctx, run } = handlerContext({ targetGroup: '../private' });
    await expect(enrichmentGseaHandler(ctx)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails another owner boundary before R contact', async () => {
    const { ctx, run } = handlerContext();
    ctx.getOwnedAnalysisObject = vi.fn(async () => null);
    await expect(enrichmentGseaHandler(ctx)).rejects.toMatchObject({ code: 'R_OBJECT_NOT_FOUND' });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails immediately when the compute runtime lacks enrichment packages', async () => {
    const { ctx, run } = handlerContext();
    ctx.runtimeCapabilities = { pathwayEnrichment: false };
    await expect(enrichmentGseaHandler(ctx)).rejects.toMatchObject({
      code: 'ENRICHMENT_PACKAGES_UNAVAILABLE',
    });
    expect(run).not.toHaveBeenCalled();
  });
});
