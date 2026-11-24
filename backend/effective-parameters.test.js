import { describe, it, expect } from 'vitest';

const { verifiedEffectiveParameters, requestedPipelineParameters } = require('./rBridge/effectiveParameters');
const { seuratPipelineDescriptor } = require('./rWorkerBridge');
const { validateSeuratPipelineParams } = require('./seuratPipeline');
const { validatePbmcPipelineParams } = require('./pbmcPipeline');

const reply = (effective) => ({
  ok: true,
  summary: { n_cells: 10, n_features: 20, n_clusters: 2, used_seed: 42 },
  warnings: [],
  ...(effective === undefined ? {} : { effective_parameters: effective }),
  checkpoint: { saved: true, checksum_sha256: 'a'.repeat(64), size_bytes: 10 },
  versions: { seurat_version: '5.3.0', r_version: '4.5.3' },
});

describe('effective parameters', () => {
  const requested = validateSeuratPipelineParams({ clusterResolution: 1.234567 }).params;

  it('records a run whose effective parameters equal the request', () => {
    const descriptor = seuratPipelineDescriptor('r.seurat.pipeline.v1', reply({ ...requested, clusterResolution: 1.2346 }), requested);
    expect(descriptor.metadata.effectiveParameters).toEqual(requested);
  });

  it('refuses a run that used a different value', () => {
    expect(() => seuratPipelineDescriptor('r.seurat.pipeline.v1', reply({ ...requested, pcaDims: 30 }), requested))
      .toThrow(expect.objectContaining({ code: 'R_PARAMETERS_MISMATCH' }));
    expect(() => verifiedEffectiveParameters(requested, reply({ ...requested, normalizationMethod: 'SCTransform' })))
      .toThrow(/normalizationMethod/);
    expect(() => verifiedEffectiveParameters(requested, reply({ ...requested, seed: 7 })))
      .toThrow(expect.objectContaining({ code: 'R_PARAMETERS_MISMATCH' }));
  });

  it('refuses a run that does not report its parameters', () => {
    expect(() => seuratPipelineDescriptor('r.seurat.pipeline.v1', reply(undefined), requested))
      .toThrow(expect.objectContaining({ code: 'R_PARAMETERS_UNVERIFIED' }));
  });

  it('uses a fixed default seed instead of a random one', () => {
    expect(validateSeuratPipelineParams({}).params.seed).toBe(42);
    expect(validateSeuratPipelineParams({ seed: null }).params.seed).toBe(42);
    expect(validatePbmcPipelineParams({ seed: null }).params.seed).toBe(42);
    expect(requestedPipelineParameters({ jobType: 'pbmc.pipeline.v1', parameters: {} }).seed).toBe(42);
  });
});
