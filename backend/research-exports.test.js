import { describe, expect, it } from 'vitest';

const audit = require('./projectAudit');
const exportsModule = require('./researchExports');

describe('research export security boundaries', () => {
  it('keeps the downloadable artifact surface exact and excludes checkpoints', () => {
    expect([...exportsModule.DOWNLOADABLE_ARTIFACT_TYPES].sort()).toEqual([
      'cellchat_results', 'condition_de_results', 'deg_markers',
      'enrichment_results', 'expert_r_bundle',
    ]);
    expect(exportsModule.DOWNLOADABLE_ARTIFACT_TYPES.has('result_checkpoint')).toBe(false);
    expect(exportsModule.DOWNLOADABLE_ARTIFACT_TYPES.has('checkpoint')).toBe(false);
  });

  it('sanitizes audit details to a small non-sensitive allowlist', () => {
    expect(audit.sanitizeDetails({
      artifactType: 'deg_markers',
      manifestVersion: 1,
      storageUri: 'projects/proj_secret/artifacts/job_secret/result.csv',
      script: 'system("bad")',
      token: 'secret',
      fromAnalysisObjectId: '../unsafe',
    })).toEqual({ artifactType: 'deg_markers', manifestVersion: 1 });
  });

  it('retains scientific versions while removing internal fields from manifest metadata', () => {
    expect(exportsModule.sanitizeManifestMetadata({
      rVersion: '4.5.3', packageVersions: { Seurat: '5.3.0' },
      storageKey: 'projects/private/result.csv', state_key: 'private-state',
      nested: { workerUrl: 'http://127.0.0.1', method: 'edgeR QL' },
    })).toEqual({
      rVersion: '4.5.3', packageVersions: { Seurat: '5.3.0' },
      nested: { method: 'edgeR QL' },
    });
  });
});
