import { describe, expect, it } from 'vitest';

const { isProjectStorageKey } = require('./storage');
const {
  ENRICHMENT_GSEA_JOB_TYPE,
  ENRICHMENT_GSEA_PARAM_SPEC,
  ENRICHMENT_GSEA_PARAM_NAMES,
  validateEnrichmentGseaParams,
  allocateEnrichmentGseaResultStorageKey,
} = require('./enrichmentGsea');

const requiredParams = (overrides = {}) => ({
  targetGroup: '0',
  species: 'human',
  ...overrides,
});

describe('enrichment.gsea.v1 parameter validation', () => {
  it('identifies the fixed job and exact parameter surface', () => {
    expect(ENRICHMENT_GSEA_JOB_TYPE).toBe('enrichment.gsea.v1');
    expect(ENRICHMENT_GSEA_PARAM_NAMES).toEqual([
      'groupBy',
      'assay',
      'targetGroup',
      'species',
      'geneSetCollection',
      'minGeneSetSize',
      'maxGeneSetSize',
      'adjustedPValueCutoff',
      'topPathways',
      'maxCellsPerIdent',
      'randomSeed',
    ]);
  });

  it('requires a target group and species, then applies every optional default', () => {
    expect(() => validateEnrichmentGseaParams({})).toThrowError(/targetGroup.*required/i);
    expect(() => validateEnrichmentGseaParams({ targetGroup: '0' })).toThrowError(/species.*required/i);

    const { params, defaultsApplied } = validateEnrichmentGseaParams(requiredParams());
    expect(params).toEqual({
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      targetGroup: '0',
      species: 'human',
      geneSetCollection: 'GO_BP',
      minGeneSetSize: 15,
      maxGeneSetSize: 500,
      adjustedPValueCutoff: 0.05,
      topPathways: 15,
      maxCellsPerIdent: 10000,
      randomSeed: 1,
    });
    expect(defaultsApplied).toEqual(
      ENRICHMENT_GSEA_PARAM_NAMES.filter((name) => !['targetGroup', 'species'].includes(name))
    );
  });

  it('accepts valid non-default values without coercion and trims the group label', () => {
    const { params, defaultsApplied } = validateEnrichmentGseaParams({
      groupBy: 'ident',
      assay: 'SCT',
      targetGroup: '  T cells (CD4+)  ',
      species: 'mouse',
      geneSetCollection: 'GO_BP',
      minGeneSetSize: 10,
      maxGeneSetSize: 2000,
      adjustedPValueCutoff: 0.000001,
      topPathways: 25,
      maxCellsPerIdent: 100000,
      randomSeed: 2147483647,
    });

    expect(params).toEqual({
      groupBy: 'ident',
      assay: 'SCT',
      targetGroup: 'T cells (CD4+)',
      species: 'mouse',
      geneSetCollection: 'GO_BP',
      minGeneSetSize: 10,
      maxGeneSetSize: 2000,
      adjustedPValueCutoff: 0.000001,
      topPathways: 25,
      maxCellsPerIdent: 100000,
      randomSeed: 2147483647,
    });
    expect(defaultsApplied).toEqual([]);
  });

  it('rejects unknown fields, including attempted code and path controls', () => {
    for (const input of [
      requiredParams({ rCode: 'system("whoami")' }),
      requiredParams({ outputPath: '../../outside.csv' }),
      requiredParams({ database: 'custom' }),
    ]) {
      expect(() => validateEnrichmentGseaParams(input)).toThrowError(/Unknown parameter/);
    }
  });

  it('requires a strict plain object', () => {
    for (const value of [undefined, null, [], '0', 1, new Date(), new (class Params {})()]) {
      expect(() => validateEnrichmentGseaParams(value)).toThrowError(/plain JSON object/);
    }
  });

  it('restricts every enum to its fixed allowlist', () => {
    for (const input of [
      requiredParams({ groupBy: 'orig.ident' }),
      requiredParams({ assay: 'integrated' }),
      requiredParams({ species: 'rat' }),
      requiredParams({ geneSetCollection: 'KEGG' }),
    ]) {
      expect(() => validateEnrichmentGseaParams(input)).toThrowError(/must be one of/);
    }
  });

  it('accepts the exact safe label alphabet at the 80-character boundary', () => {
    const eightyCharacters = `${'A'.repeat(65)} ._+()-12345678`;
    expect(eightyCharacters).toHaveLength(80);
    expect(
      validateEnrichmentGseaParams(requiredParams({ targetGroup: eightyCharacters })).params.targetGroup
    ).toBe(eightyCharacters);
  });

  it('rejects empty, too-long, hostile, control, path-like, and URL-like labels', () => {
    for (const label of [
      '',
      '   ',
      'A'.repeat(81),
      'T/cells',
      'T\\cells',
      '../outside',
      '..',
      '.',
      'https://example.com',
      'www.example.com',
      'T;system(whoami)',
      'T\ncell',
      'T\tcell',
      'T%2fcell',
      'T"cell',
    ]) {
      expect(() => validateEnrichmentGseaParams(requiredParams({ targetGroup: label }))).toThrowError();
    }
    expect(() => validateEnrichmentGseaParams(requiredParams({ targetGroup: 0 }))).toThrowError(/must be a string/);
  });

  it('enforces numeric types and all inclusive boundaries', () => {
    expect(ENRICHMENT_GSEA_PARAM_SPEC.adjustedPValueCutoff.min).toBe(0.000001);
    expect(validateEnrichmentGseaParams(requiredParams({
      minGeneSetSize: 10,
      maxGeneSetSize: 50,
      adjustedPValueCutoff: 1,
      topPathways: 5,
      maxCellsPerIdent: 10,
      randomSeed: 0,
    })).params).toMatchObject({
      minGeneSetSize: 10,
      maxGeneSetSize: 50,
      adjustedPValueCutoff: 1,
      topPathways: 5,
      maxCellsPerIdent: 10,
      randomSeed: 0,
    });

    for (const input of [
      { minGeneSetSize: 9 },
      { minGeneSetSize: 201 },
      { maxGeneSetSize: 49 },
      { maxGeneSetSize: 2001 },
      { adjustedPValueCutoff: 0 },
      { adjustedPValueCutoff: 1.000001 },
      { topPathways: 4 },
      { topPathways: 26 },
      { maxCellsPerIdent: 9 },
      { maxCellsPerIdent: 100001 },
      { randomSeed: -1 },
      { randomSeed: 2147483648 },
    ]) {
      expect(() => validateEnrichmentGseaParams(requiredParams(input)))
        .toThrowError(/between/);
    }
  });

  it('rejects strings, non-finite numbers, and fractional integers instead of coercing', () => {
    for (const input of [
      { minGeneSetSize: '15' },
      { maxGeneSetSize: NaN },
      { adjustedPValueCutoff: Infinity },
      { topPathways: 10.5 },
      { maxCellsPerIdent: '100' },
      { randomSeed: 1.5 },
    ]) {
      expect(() => validateEnrichmentGseaParams(requiredParams(input)))
        .toThrowError(/finite number|integer/);
    }
  });

  it('requires a bounded integer for maxCellsPerIdent', () => {
    expect(() => validateEnrichmentGseaParams(requiredParams({
      maxCellsPerIdent: null,
    }))).toThrowError(/finite number/);
    expect(() => validateEnrichmentGseaParams(requiredParams({
      maxCellsPerIdent: false,
    }))).toThrowError(/finite number/);
  });

  it('requires the minimum gene-set size to be smaller than the maximum', () => {
    for (const [minimum, maximum] of [[50, 50], [51, 50], [200, 200]]) {
      expect(() => validateEnrichmentGseaParams(requiredParams({
        minGeneSetSize: minimum,
        maxGeneSetSize: maximum,
      }))).toThrowError(/minGeneSetSize.*smaller.*maxGeneSetSize/);
    }
    expect(validateEnrichmentGseaParams(requiredParams({
      minGeneSetSize: 49,
      maxGeneSetSize: 50,
    })).params.maxGeneSetSize).toBe(50);
  });
});

describe('enrichment.gsea.v1 output-key allocation', () => {
  it('builds the deterministic project-scoped CSV key', () => {
    const key = allocateEnrichmentGseaResultStorageKey('proj_abc123', 'job_abc123');
    expect(key).toBe(
      'projects/proj_abc123/artifacts/job_abc123/pathway-enrichment.csv'
    );
    expect(isProjectStorageKey(key, {
      projectId: 'proj_abc123',
      kind: 'artifacts',
    })).toBe(true);
    expect(allocateEnrichmentGseaResultStorageKey('proj_abc123', 'job_abc123')).toBe(key);
  });

  it('rejects malformed or client-controlled job ids', () => {
    for (const jobId of [
      undefined,
      null,
      1,
      '',
      'job_',
      'JOB_abc123',
      'job_ABC123',
      'job_abc-123',
      'job_../outside',
      '../job_abc123',
    ]) {
      expect(() => allocateEnrichmentGseaResultStorageKey('proj_abc123', jobId))
        .toThrowError(/server-generated job id/);
    }
  });

  it('delegates project-id path safety to the project storage boundary', () => {
    for (const projectId of ['', '..', '../outside', 'proj/x', 'proj\\x', 'proj%2fx']) {
      expect(() => allocateEnrichmentGseaResultStorageKey(projectId, 'job_abc123'))
        .toThrowError(/projectId|storage key/i);
    }
  });
});
