import { describe, expect, it, vi } from 'vitest';

const {
  validateConditionComparisonParams,
  allocateConditionComparisonResultStorageKey,
} = require('./conditionComparison');
const { conditionComparisonHandler } = require('./jobWorker');
const { runRBridgeOperation, R_BRIDGE_OPERATIONS } = require('./rWorkerBridge');

describe('condition pseudobulk worker contract', () => {
  it('accepts only a server-generated contrast reference', () => {
    expect(validateConditionComparisonParams({ contrastId: 'contrast_a1b2' }).params)
      .toEqual({ contrastId: 'contrast_a1b2' });
    expect(() => validateConditionComparisonParams({ contrastId: 'contrast_a1b2', code: 'system("x")' }))
      .toThrow(/Unknown parameter/);
    expect(allocateConditionComparisonResultStorageKey('proj_abc', 'job_def'))
      .toBe('projects/proj_abc/artifacts/job_def/condition-pseudobulk-de.csv');
  });

  it('rebuilds a fixed worker-only R request and sanitizes the public summary', async () => {
    expect(R_BRIDGE_OPERATIONS['r.condition.pseudobulk_de.v1']).toMatchObject({
      path: '/object/condition-pseudobulk-de', carriesConditionComparison: true,
      requiresObjectContext: true, mutating: false,
    });
    const calls = [];
    const design = {
      contrast: { unitOfReplication: 'sample', paired: false, cellTypeColumn: 'cell_type' },
      samples: [1, 2, 3, 4].map((index) => ({
        sampleId: `sample_${index}`, condition: index < 3 ? 'numerator' : 'denominator',
        donorCode: null, unitId: `sample_${index}`,
        cellMetadataColumn: 'orig.ident', cellMetadataValue: `s${index}`,
      })),
    };
    const descriptor = await runRBridgeOperation({
      job: {
        id: 'job_def', jobType: 'condition.pseudobulk_de.v1', projectId: 'proj_abc',
        analysisObjectId: 'ao_abc', datasetId: null,
      },
      operation: 'r.condition.pseudobulk_de.v1',
      objectContext: { objectId: 'ao_abc', stateKey: 'private-state' },
      conditionComparison: {
        design, resultStorageKey: 'projects/proj_abc/artifacts/job_def/condition-pseudobulk-de.csv',
      },
      markRDispatchStarted: async () => {},
      callR: async (request) => {
        calls.push(request);
        return { status: 200, body: {
          ok: true,
          summary: {
            method: 'edgeR quasi-likelihood pseudobulk', cell_type_column: 'cell_type',
            unit_of_replication: 'sample', paired: false, sample_count: 4,
            model_formula: '~ condition',
            tested_cell_type_count: 2, tested_gene_count: 1000, significant_result_count: 12,
            skipped_cell_types: [], warnings: [],
            package_versions: { r: '4.5.3', seurat: '5.3.1', edger: '4.8.0', limma: '3.66.0' },
            top_results: [{ cell_type: 'T', gene: 'IL7R', log_fc: 1.2, p_value: 0.001, fdr: 0.01 }],
            raw_counts: [[1, 2]], storage_key: 'secret',
          },
          result: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 500, n_rows: 2000 },
        } };
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/object/condition-pseudobulk-de', objectStateKey: 'private-state' });
    expect(calls[0].body.design.model_formula).toBe('~ condition');
    expect(calls[0].body.design.samples).toEqual(design.samples.map((sample) => ({
      sample_id: sample.sampleId, condition: sample.condition, donor_code: null,
      unit_id: sample.unitId, cell_metadata_column: 'orig.ident', cell_metadata_value: sample.cellMetadataValue,
    })));
    expect(calls[0].body.completion_receipt).toMatchObject({
      job_type: 'condition.pseudobulk_de.v1', output_storage_key: 'projects/proj_abc/artifacts/job_def/condition-pseudobulk-de.csv',
    });
    expect(descriptor.summary.topResults[0]).toEqual({
      cellType: 'T', gene: 'IL7R', logFc: 1.2, pValue: 0.001, fdr: 0.01,
    });
    expect(descriptor.summary.modelFormula).toBe('~ condition');
    expect(JSON.stringify(descriptor)).not.toContain('raw_counts');
    expect(JSON.stringify(descriptor)).not.toContain('secret');
  });

  it('treats the endpoint\'s explicit 400 input rejection as terminal, not indeterminate', async () => {
    const design = {
      contrast: { unitOfReplication: 'sample', paired: false, cellTypeColumn: 'cell_type' },
      samples: [1, 2, 3, 4].map((index) => ({
        sampleId: `sample_${index}`, condition: index < 3 ? 'numerator' : 'denominator',
        donorCode: null, unitId: `sample_${index}`,
        cellMetadataColumn: 'orig.ident', cellMetadataValue: `s${index}`,
      })),
    };
    let thrown;
    try {
      await runRBridgeOperation({
        job: {
          id: 'job_def', jobType: 'condition.pseudobulk_de.v1', projectId: 'proj_abc',
          analysisObjectId: 'ao_abc', datasetId: null,
        },
        operation: 'r.condition.pseudobulk_de.v1',
        objectContext: { objectId: 'ao_abc', stateKey: 'private-state' },
        conditionComparison: {
          design, resultStorageKey: 'projects/proj_abc/artifacts/job_def/condition-pseudobulk-de.csv',
        },
        markRDispatchStarted: async () => {},
        callR: async () => ({ status: 400, body: { error: 'invalid input' } }),
        logger: { info() {}, warn() {}, error() {} },
      });
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: 'R_CONDITION_COMPARISON_FAILED', rStatus: 400 });
    expect(thrown.rSideEffectsPossible).not.toBe(true);
  });

  it('resolves the trusted design before hydration and uses job-scoped private R state', async () => {
    const calls = [];
    const design = {
      analysisObjectId: 'ao_abc',
      contrast: {
        id: 'contrast_a1b2', unitOfReplication: 'sample', paired: false,
        cellTypeColumn: 'cell_type', status: 'valid',
      },
      samples: [1, 2, 3, 4].map((index) => ({
        sampleId: `sample_${index}`, condition: index < 3 ? 'numerator' : 'denominator',
        unitId: `sample_${index}`, donorCode: null,
        cellMetadataColumn: 'orig.ident', cellMetadataValue: `s${index}`,
      })),
    };
    const ctx = {
      job: {
        id: 'job_def', jobType: 'condition.pseudobulk_de.v1', ownerUserId: 7,
        projectId: 'proj_abc', analysisObjectId: 'ao_abc', attempts: 1,
        parameters: { contrastId: 'contrast_a1b2' },
      },
      workerId: 'worker_1', heartbeat: vi.fn(), log: vi.fn(), logger: {}, callR: vi.fn(),
      deriveRObjectStateKey: (userId, objectId) => `user-${userId}-${objectId}`,
      getOwnedAnalysisObject: vi.fn(async () => ({ id: 'ao_abc' })),
      getConditionComparisonInputs: vi.fn(async () => { calls.push('design'); return design; }),
      getHydrationCheckpoint: vi.fn(async () => ({ analysisObjectId: 'ao_abc', checkpointArtifactId: 'art_cp' })),
      removeDurableObject: vi.fn(),
      runRBridgeOperation: vi.fn(async (input) => {
        calls.push(input.operation);
        if (input.operation === 'r.checkpoint.hydrate.v1') return { loaded: { loaded: true } };
        expect(input.objectContext.stateKey).toBe('user-7-ao_abc-job-job_def');
        expect(input.conditionComparison.design).toEqual(design);
        return {
          name: 'Pseudobulk summary', description: 'Safe summary', metadata: { summary: {} },
          result: { saved: true, checksumSha256: 'a'.repeat(64), sizeBytes: 123, nRows: 20 },
        };
      }),
      completeConditionComparisonResult: vi.fn(async () => ({
        resultsArtifact: { id: 'art_results' }, summaryArtifact: { id: 'art_summary' },
      })),
    };
    const result = await conditionComparisonHandler(ctx);
    expect(calls).toEqual(['design', 'r.checkpoint.hydrate.v1', 'r.condition.pseudobulk_de.v1']);
    expect(result.result).toMatchObject({ resultsArtifactId: 'art_results', summaryArtifactId: 'art_summary' });
  });

  it('rejects invalid parameters before any R contact', async () => {
    const ctx = {
      job: { analysisObjectId: 'ao_abc', parameters: { contrastId: 'bad' } },
      heartbeat: vi.fn(), log: vi.fn(), runRBridgeOperation: vi.fn(),
      getConditionComparisonInputs: vi.fn(), getOwnedAnalysisObject: vi.fn(),
    };
    await expect(conditionComparisonHandler(ctx)).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
    expect(ctx.runRBridgeOperation).not.toHaveBeenCalled();
  });

  it('rejects persisted unsupported model terms before checkpoint hydration or R contact', async () => {
    const ctx = {
      job: {
        id: 'job_def', jobType: 'condition.pseudobulk_de.v1', ownerUserId: 7,
        projectId: 'proj_abc', analysisObjectId: 'ao_abc',
        parameters: { contrastId: 'contrast_a1b2' },
      },
      heartbeat: vi.fn(), log: vi.fn(), runRBridgeOperation: vi.fn(),
      getOwnedAnalysisObject: vi.fn(async () => ({ id: 'ao_abc' })),
      getConditionComparisonInputs: vi.fn(async () => ({
        analysisObjectId: 'ao_abc',
        contrast: {
          id: 'contrast_a1b2', status: 'valid', unitOfReplication: 'sample', paired: false,
          cellTypeColumn: 'cell_type', blockingFactor: 'batch', covariates: [],
        },
        samples: [],
      })),
      getHydrationCheckpoint: vi.fn(),
    };
    await expect(conditionComparisonHandler(ctx)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONDITION_MODEL',
    });
    expect(ctx.getHydrationCheckpoint).not.toHaveBeenCalled();
    expect(ctx.runRBridgeOperation).not.toHaveBeenCalled();
  });
});
