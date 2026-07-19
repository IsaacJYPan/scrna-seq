import { describe, expect, it } from 'vitest';

const { isProjectStorageKey } = require('./storage');
const {
  CELLCHAT_INFERENCE_JOB_TYPE,
  CELLCHAT_INFERENCE_PARAM_SPEC,
  CELLCHAT_INFERENCE_PARAM_NAMES,
  MAX_CELLCHAT_RESULT_ROWS,
  validateCellChatInferenceParams,
  allocateCellChatInferenceResultStorageKey,
} = require('./cellChatInference');

const requiredParams = (overrides = {}) => ({
  groupBy: 'seurat_clusters',
  species: 'human',
  databaseCategory: 'all',
  analysisIntent: 'single_context',
  minCellsPerGroup: 10,
  maxCellsPerGroup: 1000,
  maxTotalCells: 10000,
  ...overrides,
});

describe('cellchat.infer.v1 parameter validation', () => {
  it('identifies the fixed job and exact parameter surface', () => {
    expect(CELLCHAT_INFERENCE_JOB_TYPE).toBe('cellchat.infer.v1');
    expect(MAX_CELLCHAT_RESULT_ROWS).toBe(50000);
    expect(CELLCHAT_INFERENCE_PARAM_NAMES).toEqual([
      'groupBy',
      'assay',
      'species',
      'databaseCategory',
      'analysisIntent',
      'minCellsPerGroup',
      'maxCellsPerGroup',
      'maxTotalCells',
      'pValueCutoff',
      'topInteractions',
      'topPathways',
      'randomSeed',
    ]);
  });

  it('requires every scientifically material choice and applies only optional defaults', () => {
    for (const name of [
      'groupBy', 'species', 'databaseCategory', 'analysisIntent',
      'minCellsPerGroup', 'maxCellsPerGroup', 'maxTotalCells',
    ]) {
      const params = requiredParams();
      delete params[name];
      expect(() => validateCellChatInferenceParams(params))
        .toThrowError(new RegExp(`${name}.*required`, 'i'));
    }

    const { params, defaultsApplied } = validateCellChatInferenceParams(requiredParams());
    expect(params).toEqual({
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
    });
    expect(defaultsApplied).toEqual([
      'assay', 'pValueCutoff', 'topInteractions', 'topPathways', 'randomSeed',
    ]);
  });

  it('accepts valid explicit values without coercion', () => {
    const { params, defaultsApplied } = validateCellChatInferenceParams(requiredParams({
      groupBy: 'ident',
      assay: 'RNA',
      species: 'mouse',
      databaseCategory: 'cell_cell_contact',
      analysisIntent: 'single_context',
      minCellsPerGroup: 5,
      maxCellsPerGroup: 10000,
      maxTotalCells: 10000,
      pValueCutoff: 0.000001,
      topInteractions: 100,
      topPathways: 100,
      randomSeed: 2147483647,
    }));

    expect(params).toEqual({
      groupBy: 'ident',
      assay: 'RNA',
      species: 'mouse',
      databaseCategory: 'cell_cell_contact',
      analysisIntent: 'single_context',
      minCellsPerGroup: 5,
      maxCellsPerGroup: 10000,
      maxTotalCells: 10000,
      pValueCutoff: 0.000001,
      topInteractions: 100,
      topPathways: 100,
      randomSeed: 2147483647,
    });
    expect(defaultsApplied).toEqual([]);
  });

  it('rejects unknown fields, including arbitrary code, metadata, ownership, and output controls', () => {
    for (const input of [
      requiredParams({ rCode: 'system("whoami")' }),
      requiredParams({ metadataColumn: 'orig.ident' }),
      requiredParams({ ownerUserId: 999 }),
      requiredParams({ storageKey: '../../outside.csv' }),
      requiredParams({ condition: 'treated' }),
    ]) {
      expect(() => validateCellChatInferenceParams(input)).toThrowError(/Unknown parameter/);
    }
  });

  it('requires a strict plain object', () => {
    for (const value of [undefined, null, [], 'parameters', 1, new Date(), new (class Params {})()]) {
      expect(() => validateCellChatInferenceParams(value)).toThrowError(/plain JSON object/);
    }
  });

  it('keeps group, assay, species, database, and intent on their exact allowlists', () => {
    for (const input of [
      requiredParams({ groupBy: 'orig.ident' }),
      requiredParams({ assay: 'SCT' }),
      requiredParams({ species: 'rat' }),
      requiredParams({ databaseCategory: 'custom' }),
      requiredParams({ analysisIntent: 'condition_comparison' }),
    ]) {
      expect(() => validateCellChatInferenceParams(input)).toThrowError(/must be one of/);
    }
  });

  it('enforces numeric types and all inclusive boundaries without coercion', () => {
    expect(CELLCHAT_INFERENCE_PARAM_SPEC.pValueCutoff.min).toBe(0.000001);
    expect(validateCellChatInferenceParams(requiredParams({
      minCellsPerGroup: 5,
      maxCellsPerGroup: 100,
      maxTotalCells: 1000,
      pValueCutoff: 0.1,
      topInteractions: 5,
      topPathways: 5,
      randomSeed: 0,
    })).params).toMatchObject({
      minCellsPerGroup: 5,
      maxCellsPerGroup: 100,
      maxTotalCells: 1000,
      pValueCutoff: 0.1,
      topInteractions: 5,
      topPathways: 5,
      randomSeed: 0,
    });

    for (const input of [
      { minCellsPerGroup: 4 }, { minCellsPerGroup: 201 },
      { maxCellsPerGroup: 99 }, { maxCellsPerGroup: 10001 },
      { maxTotalCells: 999 }, { maxTotalCells: 10001 },
      { pValueCutoff: 0 }, { pValueCutoff: 0.100001 },
      { topInteractions: 4 }, { topInteractions: 101 },
      { topPathways: 4 }, { topPathways: 101 },
      { randomSeed: -1 }, { randomSeed: 2147483648 },
    ]) {
      expect(() => validateCellChatInferenceParams(requiredParams(input)))
        .toThrowError(/between/);
    }
    for (const input of [
      { minCellsPerGroup: '10' }, { maxCellsPerGroup: Infinity },
      { maxTotalCells: 1000.5 }, { pValueCutoff: NaN },
      { topInteractions: 10.5 }, { topPathways: false }, { randomSeed: 1.5 },
    ]) {
      expect(() => validateCellChatInferenceParams(requiredParams(input)))
        .toThrowError(/finite number|integer/);
    }
  });

  it('enforces coherent group capacity and the fixed total-cell floor before R contact', () => {
    expect(() => validateCellChatInferenceParams(requiredParams({
      minCellsPerGroup: 101,
      maxCellsPerGroup: 100,
    }))).toThrowError(/maxCellsPerGroup.*at least.*minCellsPerGroup/i);
    // The fixed 1,000-cell lower bound already accommodates two maximum-size
    // (200-cell) minimum groups. Keep that relationship pinned so future bound
    // changes cannot silently make the single-context analysis under-provisioned.
    expect(validateCellChatInferenceParams(requiredParams({
      minCellsPerGroup: 200,
      maxCellsPerGroup: 1000,
      maxTotalCells: 1000,
    })).params.maxTotalCells).toBe(1000);
  });
});

describe('cellchat.infer.v1 output-key allocation', () => {
  it('builds the deterministic project-scoped private CSV key', () => {
    const key = allocateCellChatInferenceResultStorageKey('proj_abc123', 'job_abc123');
    expect(key).toBe('projects/proj_abc123/artifacts/job_abc123/cellchat-inference.csv');
    expect(isProjectStorageKey(key, {
      projectId: 'proj_abc123',
      kind: 'artifacts',
    })).toBe(true);
    expect(allocateCellChatInferenceResultStorageKey('proj_abc123', 'job_abc123')).toBe(key);
  });

  it('rejects malformed or client-controlled job ids', () => {
    for (const jobId of [
      undefined, null, 1, '', 'job_', 'JOB_abc123', 'job_ABC123',
      'job_abc-123', 'job_../outside', '../job_abc123',
    ]) {
      expect(() => allocateCellChatInferenceResultStorageKey('proj_abc123', jobId))
        .toThrowError(/server-generated job id/);
    }
  });

  it('delegates project-id path safety to the project storage boundary', () => {
    for (const projectId of ['', '..', '../outside', 'proj/x', 'proj\\x', 'proj%2fx']) {
      expect(() => allocateCellChatInferenceResultStorageKey(projectId, 'job_abc123'))
        .toThrowError(/projectId|storage key/i);
    }
  });
});
