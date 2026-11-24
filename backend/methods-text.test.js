import { describe, expect, it } from 'vitest';

const { renderMethodsText, REFERENCES } = require('./methodsText');
const audit = require('./projectAudit');

function manifest(jobs, extra = {}) {
  return {
    schema: 'traceomics.reproducibility-manifest',
    version: 1,
    generatedAt: '2026-11-24T10:00:00.000Z',
    exportedAnalysisObjectId: 'ao_result',
    jobs,
    artifacts: [],
    experimentalDesign: { sampleBindings: [], contrasts: [] },
    ...extra,
  };
}

function job(jobType, parameters, overrides = {}) {
  return { id: `job_${jobType}`, jobType, status: 'completed', parameters, ...overrides };
}

describe('renderMethodsText', () => {
  it('describes a single-sample Seurat run with recorded and default parameters', () => {
    const text = renderMethodsText(manifest([
      job('seurat.pipeline.v1', { maxPercentMt: 10, clusterResolution: 0.5, seed: 7 }),
    ]));
    expect(text).toContain('# Methods (draft)');
    expect(text).toContain('analysis ao_result on 2026-11-24');
    expect(text).toContain('## Preprocessing and clustering');
    expect(text).toContain('Counts from a 10x Genomics HDF5 file were analysed with Seurat.');
    expect(text).toContain('between 200 and 2,500 detected genes, at most 10% of counts from mitochondrial genes');
    expect(text).toContain('LogNormalize, scale factor 10,000');
    expect(text).toContain('the 2,000 most variable genes');
    expect(text).toContain('computed 50 components');
    expect(text).toContain('the first 15 principal components');
    expect(text).toContain('at resolution 0.5');
    expect(text).toContain('30 neighbours, minimum distance 0.3');
    expect(text).toContain('The random seed was 7.');
    expect(text).toContain(REFERENCES.seurat);
    expect(text).toContain(REFERENCES.umap);
    expect(text).not.toContain('undefined');
  });

  it('stops the description at the recorded stage and cites SCTransform only when used', () => {
    const qcOnly = renderMethodsText(manifest([job('seurat.pipeline.v1', { stopAfter: 'qc' })]));
    expect(qcOnly).not.toContain('normalized');
    expect(qcOnly).not.toContain('UMAP');
    expect(qcOnly).not.toContain(REFERENCES.umap);

    const sct = renderMethodsText(manifest([
      job('seurat.pipeline.v1', { normalizationMethod: 'SCTransform', applyQcFilter: false }),
    ]));
    expect(sct).toContain('normalized and variance-stabilized with SCTransform');
    expect(sct).toContain('No additional cell-level quality-control filter was applied.');
    expect(sct).toContain(REFERENCES.sctransform);
  });

  it('describes multi-sample integration and the PBMC demo pipeline without inventing QC', () => {
    const multi = renderMethodsText(manifest([job('seurat.multisample.v1', {
      samples: [
        { datasetId: 'ds_a', sampleId: 's1' },
        { datasetId: 'ds_b', sampleId: 's2' },
      ],
      integrationMethod: 'rpca',
    })]));
    expect(multi).toContain('## Multi-sample preprocessing and clustering');
    expect(multi).toContain('Counts from 2 10x Genomics HDF5 samples');
    expect(multi).toContain('reciprocal PCA');
    expect(multi).toContain('of the integrated reduction');

    const pbmc = renderMethodsText(manifest([job('pbmc.pipeline.v1', {})]));
    expect(pbmc).toContain('PBMC 3k demonstration object');
    expect(pbmc).not.toContain('Cells were retained');
    expect(pbmc).not.toContain('At object creation');
    expect(pbmc).not.toContain('undefined');
  });

  it('describes downstream analyses with their statistical methods', () => {
    const text = renderMethodsText(manifest([
      job('deg.find_markers.v1', { minPct: 0.15 }),
      job('enrichment.gsea.v1', { targetGroup: '3', species: 'human' }),
      job('cellchat.infer.v1', {
        groupBy: 'seurat_clusters', species: 'mouse', databaseCategory: 'secreted_signaling',
        analysisIntent: 'single_context', minCellsPerGroup: 10, maxCellsPerGroup: 1000, maxTotalCells: 5000,
      }),
    ]));
    expect(text).toContain('Wilcoxon rank-sum test');
    expect(text).toContain('at least 15% of cells');
    expect(text).toContain('Bonferroni');
    expect(text).toContain('For cluster "3"');
    expect(text).toContain('Gene Ontology biological process gene sets (human)');
    expect(text).toContain('Benjamini-Hochberg');
    expect(text).toContain('mouse CellChatDB restricted to secreted-signalling interactions');
    expect(text).toContain('single biological context');
    for (const key of ['clusterProfiler', 'fgsea', 'cellchat']) expect(text).toContain(REFERENCES[key]);
  });

  it('names the contrast conditions for a pseudobulk comparison', () => {
    const text = renderMethodsText(manifest([job('condition.pseudobulk_de.v1', { contrastId: 'ct_1' })], {
      experimentalDesign: {
        sampleBindings: [
          { conditionId: 'cond_t', conditionName: 'treated' },
          { conditionId: 'cond_c', conditionName: 'control' },
        ],
        contrasts: [{
          id: 'ct_1', numeratorConditionId: 'cond_t', denominatorConditionId: 'cond_c',
          unitOfReplication: 'donor', paired: true, cellTypeColumn: 'cell_type',
        }],
      },
    }));
    expect(text).toContain('To compare treated with control, raw counts were summed per donor and cell type');
    expect(text).toContain('"cell_type" annotation');
    expect(text).toContain('paired by donor');
    expect(text).toContain('quasi-likelihood F-test');
    expect(text).toContain(REFERENCES.edgeR);
  });

  it('uses the pinned trusted-method release and its catalog citation', () => {
    const lookupMethod = (key) => (key === 'annotate-singler' ? {
      key: 'annotate-singler',
      title: 'Reference cell-type annotation (SingleR)',
      summary: 'Labels cells by correlation with a reference.',
      packages: ['SingleR', 'celldex'],
      deviations: ['Cluster mode aggregates cells first.'],
      parameters: [{ key: 'reference', label: 'Reference' }],
      provenance: { citation: 'Aran D et al. Nat Immunol 2019.', doi: '10.1038/s41590-018-0276-y' },
    } : null);
    const text = renderMethodsText(manifest([job('trusted.method.v1', {
      method: 'annotate-singler', methodVersion: '1.2.0',
      methodSourceSha256: 'abcdef0123456789abcdef', values: { reference: 'hpca' },
    })]), { lookupMethod });
    expect(text).toContain('## Reference cell-type annotation (SingleR)');
    expect(text).toContain('Labels cells by correlation with a reference.');
    expect(text).toContain('"annotate-singler" version 1.2.0 using SingleR, celldex (source SHA-256 abcdef012345)');
    expect(text).toContain('Parameters: Reference = hpca.');
    expect(text).toContain('Cluster mode aggregates cells first.');
    expect(text).toContain('Aran D et al. Nat Immunol 2019. doi:10.1038/s41590-018-0276-y');
  });

  it('skips checkpoint bookkeeping, unfinished jobs and exact repeats', () => {
    const text = renderMethodsText(manifest([
      job('checkpoint.save.v1', {}),
      job('deg.find_markers.v1', {}, { id: 'job_failed', status: 'failed' }),
      job('seurat.pipeline.v1', { seed: 1 }, { id: 'job_a' }),
      job('seurat.pipeline.v1', { seed: 1 }, { id: 'job_b' }),
    ]));
    expect(text.match(/## Preprocessing and clustering/g)).toHaveLength(1);
    expect(text).not.toContain('checkpoint');
    expect(text).not.toContain('Cluster marker genes');
  });

  it('lists the software versions the runtime reported and never leaks script content', () => {
    const text = renderMethodsText(manifest([
      job('expert.r.v1', { profileId: 'default', scriptSha256: 'ff00ff00ff00ff00' }),
    ], {
      artifacts: [
        { metadata: { rVersion: '4.5.3', seuratVersion: '5.3.0' } },
        { metadata: { packageVersions: { r: '4.5.3', edgeR: '4.4.0', limma: '3.62.1' } } },
      ],
    }));
    expect(text).toContain('Analyses used R 4.5.3, Seurat 5.3.0, edgeR 4.4.0, limma 3.62.1.');
    expect(text).toContain('script SHA-256 ff00ff00ff00');
    expect(text).not.toContain('profileId');
  });

  it('says plainly when nothing was recorded', () => {
    const text = renderMethodsText(manifest([]));
    expect(text).toContain('No completed analysis steps were recorded for this analysis.');
    expect(text).toContain('The runtime did not record software versions for these steps.');
    expect(text).not.toContain('## References');
  });
});

describe('methods export audit details', () => {
  it('records the methods template version and nothing else new', () => {
    expect(audit.sanitizeDetails({ manifestVersion: 1, methodsVersion: 1, text: 'secret' }))
      .toEqual({ manifestVersion: 1, methodsVersion: 1 });
  });
});
