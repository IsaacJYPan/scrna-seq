import { describe, expect, it, vi } from 'vitest';

const bridge = require('./rWorkerBridge');
const {
  runRBridgeOperation,
  sanitizeCellChatSummary,
  sanitizeCellChatResultInfo,
  R_BRIDGE_OPERATIONS,
} = bridge;
const { cellChatInferenceHandler, DEFAULT_HANDLERS } = require('./jobWorker');

const CHECKSUM = 'a'.repeat(64);

function parameters(overrides = {}) {
  return {
    groupBy: 'seurat_clusters',
    assay: 'RNA',
    species: 'human',
    databaseCategory: 'all',
    analysisIntent: 'single_context',
    minCellsPerGroup: 10,
    maxCellsPerGroup: 1000,
    maxTotalCells: 10000,
    pValueCutoff: 0.05,
    topInteractions: 25,
    topPathways: 15,
    randomSeed: 1,
    ...overrides,
  };
}

function body(overrides = {}) {
  return {
    ok: true,
    summary: {
      method: 'CellChat',
      analysis_intent: 'single_context',
      group_by: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      database_category: 'all',
      p_value_cutoff: 0.05,
      input_cell_count: 250,
      analyzed_cell_count: 200,
      input_group_count: 3,
      analyzed_group_count: 2,
      excluded_group_count: 1,
      candidate_interaction_count: 20,
      retained_interaction_count: 3,
      retained_pathway_count: 2,
      groups: [
        { group: 'Group 1', input_cells: 120, analyzed_cells: 100 },
        { group: 'Group 2', input_cells: 130, analyzed_cells: 100 },
      ],
      excluded_groups: [
        { group: 'Group 3', input_cells: 10, reason: 'below_min_cells' },
      ],
      package_versions: {
        r: '4.5.3',
        seurat: '5.3.1',
        cellchat: '2.1.2',
        cellchat_db: 'CellChatDB.human',
      },
      top_interactions: [{
        source: 'Group 1',
        target: 'Group 2',
        interaction: 'TGFB1.TGFBR1_TGFBR2',
        pathway: 'TGFb',
        probability: 0.42,
        p_value: 0.001,
        category: 'secreted_signaling',
      }],
      top_pathways: [{
        source: 'Group 1',
        target: 'Group 2',
        pathway: 'TGFb',
        probability: 0.42,
        p_value: 0.001,
      }],
      warnings: ['Small groups were excluded before inference'],
    },
    result: { saved: true, checksum_sha256: CHECKSUM, size_bytes: 4096, n_rows: 20 },
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    id: 'job_abc123',
    jobType: 'cellchat.infer.v1',
    projectId: 'proj_abc123',
    analysisObjectId: 'ao_abc123',
    datasetId: null,
    ownerUserId: 7,
    parameters: parameters(),
    ...overrides,
  };
}

function handlerContext(parameterOverrides = {}) {
  const completion = vi.fn(async () => ({
    resultsArtifact: { id: 'art_results' },
    summaryArtifact: { id: 'art_summary' },
  }));
  const run = vi.fn(async () => ({
    artifactType: 'cellchat_summary',
    name: 'Cell-cell communication summary',
    description: 'Safe predicted-candidate summary',
    result: {
      saved: true,
      checksumSha256: CHECKSUM,
      sizeBytes: 4096,
      nRows: 20,
    },
    metadata: { summary: sanitizeCellChatSummary(body()) },
  }));
  return {
    ctx: {
      job: job({ parameters: parameters(parameterOverrides) }),
      workerId: 'worker_abc',
      heartbeat: vi.fn(async () => {}),
      log: vi.fn(async () => {}),
      getOwnedAnalysisObject: vi.fn(async () => ({ id: 'ao_abc123', ownerUserId: 7 })),
      deriveRObjectStateKey: vi.fn(() => 'user-7:obj-abc123'),
      removeDurableObject: vi.fn(async () => {}),
      runRBridgeOperation: run,
      completeCellChatInferenceResult: completion,
      logger: { info() {}, warn() {}, error() {} },
      callR: vi.fn(),
    },
    run,
    completion,
  };
}

describe('cellchat.infer.v1 bridge contract', () => {
  it('is a fixed object-scoped, non-mutating CellChat operation', () => {
    expect(DEFAULT_HANDLERS['cellchat.infer.v1']).toBe(cellChatInferenceHandler);
    expect(R_BRIDGE_OPERATIONS['r.cellchat.infer.v1']).toMatchObject({
      method: 'POST',
      path: '/object/cellchat-infer',
      artifactType: 'cellchat_summary',
      requiresObjectContext: true,
      carriesCellChatParams: true,
      mutating: false,
      readOnly: false,
    });
  });

  it('rebuilds the R request from only validated fields and a server-owned result key', async () => {
    const calls = [];
    const source = job({ parameters: parameters({ code: 'system("whoami")' }) });
    const descriptor = await runRBridgeOperation({
      job: source,
      operation: 'r.cellchat.infer.v1',
      objectContext: { objectId: 'ao_abc123', stateKey: 'user-7:obj-abc123' },
      cellChat: {
        params: parameters({
          code: 'system("whoami")',
          metadataColumn: 'orig.ident',
          storageUri: 'C:\\private',
        }),
        resultStorageKey: 'projects/proj_abc123/artifacts/job_abc123/cellchat-inference.csv',
      },
      markRDispatchStarted: async () => {},
      callR: async (request) => {
        calls.push(request);
        return { status: 200, body: body() };
      },
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/object/cellchat-infer',
      objectStateKey: 'user-7:obj-abc123',
    });
    expect(calls[0].body.params).toEqual(parameters());
    expect(calls[0].body).not.toHaveProperty('code');
    expect(calls[0].body.params).not.toHaveProperty('metadataColumn');
    expect(calls[0].body.params).not.toHaveProperty('storageUri');
    expect(calls[0].body.completion_receipt).toMatchObject({
      job_id: 'job_abc123',
      job_type: 'cellchat.infer.v1',
      r_operation: 'r.cellchat.infer.v1',
      output_storage_key: 'projects/proj_abc123/artifacts/job_abc123/cellchat-inference.csv',
    });
    expect(descriptor.summary.topInteractions[0]).toEqual({
      source: 'Group 1',
      target: 'Group 2',
      interaction: 'TGFB1.TGFBR1_TGFBR2',
      pathway: 'TGFb',
      probability: 0.42,
      pValue: 0.001,
      category: 'secreted_signaling',
    });
    expect(descriptor.result).toEqual({
      saved: true,
      checksumSha256: CHECKSUM,
      sizeBytes: 4096,
      nRows: 20,
    });
  });

  it('accepts an independently aggregated pathway count', async () => {
    // Pathway source/target rows are an aggregation, not a subset of the
    // interaction-level candidate rows. Do not reject a valid CellChat output
    // merely because those two table cardinalities differ.
    const descriptor = await runRBridgeOperation({
      job: job(),
      operation: 'r.cellchat.infer.v1',
      objectContext: { objectId: 'ao_abc123', stateKey: 'user-7:obj-abc123' },
      cellChat: {
        params: parameters(),
        resultStorageKey: 'projects/proj_abc123/artifacts/job_abc123/cellchat-inference.csv',
      },
      markRDispatchStarted: async () => {},
      callR: async () => ({
        status: 200,
        body: body({
          summary: {
            ...body().summary,
            candidate_interaction_count: 1,
            retained_interaction_count: 1,
            retained_pathway_count: 7,
          },
        }),
      }),
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(descriptor.summary.retainedPathwayCount).toBe(7);
  });

  it('drops unapproved fields and caps every public preview list', () => {
    const interactions = Array.from({ length: 130 }, (_, index) => ({
      source: 'Group 1',
      target: 'Group 2',
      interaction: `LIGAND_${index}.RECEPTOR_${index}`,
      pathway: `Pathway_${index}`,
      probability: 0.1,
      p_value: 0.01,
      category: 'all',
      ligand: 'private_gene_list',
    }));
    const summary = sanitizeCellChatSummary(body({
      summary: {
        ...body().summary,
        top_interactions: interactions,
        expression_matrix: [[1, 2]],
        storage_key: 'projects/private.csv',
        r_state_key: 'user-7:obj-abc123',
      },
      storage_key: 'projects/private.csv',
    }));
    expect(summary.topInteractions).toHaveLength(100);
    expect(summary.topInteractions[0]).not.toHaveProperty('ligand');
    expect(JSON.stringify(summary)).not.toMatch(/expression_matrix|storage_key|r_state_key/i);
  });

  it('rejects safe-looking raw identity labels instead of persisting them as CellChat groups', async () => {
    const unsafeBody = body({
      summary: {
        ...body().summary,
        groups: [
          { group: 'Private donor', input_cells: 120, analyzed_cells: 100 },
          { group: 'Group 2', input_cells: 130, analyzed_cells: 100 },
        ],
        top_interactions: [{
          ...body().summary.top_interactions[0],
          source: 'Private donor',
          target: 'Group 2',
        }],
        top_pathways: [{
          ...body().summary.top_pathways[0],
          source: 'Private donor',
          target: 'Group 2',
        }],
      },
    });
    const summary = sanitizeCellChatSummary(unsafeBody);
    expect(JSON.stringify(summary)).not.toContain('Private donor');

    await expect(runRBridgeOperation({
      job: job(),
      operation: 'r.cellchat.infer.v1',
      objectContext: { objectId: 'ao_abc123', stateKey: 'user-7:obj-abc123' },
      cellChat: {
        params: parameters(),
        resultStorageKey: 'projects/proj_abc123/artifacts/job_abc123/cellchat-inference.csv',
      },
      markRDispatchStarted: async () => {},
      callR: async () => ({ status: 200, body: unsafeBody }),
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toMatchObject({ code: 'R_RESPONSE_INVALID' });
  });

  it('rejects oversized result descriptors before artifact publication', () => {
    expect(sanitizeCellChatResultInfo(body({
      result: { saved: true, checksum_sha256: CHECKSUM, size_bytes: 51 * 1024 * 1024, n_rows: 1 },
    })).saved).toBe(false);
    expect(sanitizeCellChatResultInfo(body({
      result: { saved: true, checksum_sha256: CHECKSUM, size_bytes: 100, n_rows: 50001 },
    })).saved).toBe(false);
  });
});

describe('cellchat.infer.v1 handler boundary', () => {
  it('validates and owns the object before calling R, then atomically publishes private results plus a metadata-only summary', async () => {
    const { ctx, run, completion } = handlerContext();
    const outcome = await cellChatInferenceHandler(ctx);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toMatchObject({
      operation: 'r.cellchat.infer.v1',
      objectContext: { objectId: 'ao_abc123', stateKey: 'user-7:obj-abc123' },
    });
    expect(completion).toHaveBeenCalledOnce();
    expect(completion.mock.calls[0][0].resultsArtifact).toMatchObject({
      artifactType: 'cellchat_results',
      storageKind: 'local_internal',
      internalStorageKey: 'projects/proj_abc123/artifacts/job_abc123/cellchat-inference.csv',
      mimeType: 'text/csv',
    });
    expect(completion.mock.calls[0][0].summaryArtifact).toMatchObject({
      artifactType: 'cellchat_summary',
      storageKind: 'metadata_only',
    });
    expect(outcome.result.handled).toBe('cellchat.infer.v1');
  });

  it('fails invalid parameters before R contact', async () => {
    const { ctx, run } = handlerContext({ databaseCategory: 'custom' });
    await expect(cellChatInferenceHandler(ctx)).rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
    expect(run).not.toHaveBeenCalled();
  });

  it('fails another owner boundary before R contact', async () => {
    const { ctx, run } = handlerContext();
    ctx.getOwnedAnalysisObject = vi.fn(async () => null);
    await expect(cellChatInferenceHandler(ctx)).rejects.toMatchObject({ code: 'R_OBJECT_NOT_FOUND' });
    expect(run).not.toHaveBeenCalled();
  });
});
