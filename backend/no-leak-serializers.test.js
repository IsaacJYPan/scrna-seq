/**
 * Public serializer no-leak contract (unit-only). These tests pin the exported
 * public projections that intentionally remove server-internal storage/R fields.
 */

import { describe, it, expect } from 'vitest';

const {
  toPublicAnalysisObject,
  toPublicDataset,
  toPublicJobArtifact
} = require('./database');

describe('public serializers no-leak contract', () => {
  it('analysis object projection strips storage URI and object hash', () => {
    const publicObject = toPublicAnalysisObject({
      id: 'ao_abc',
      ownerUserId: 1,
      projectId: 'proj_abc',
      objectType: 'seurat',
      storageUri: 'vault/alice/private/object.rds',
      objectHash: 'f'.repeat(64),
      metadata: { sourceType: 'pbmc3k_demo' }
    });

    expect(publicObject).not.toHaveProperty('storageUri');
    expect(publicObject).not.toHaveProperty('objectHash');
    expect(JSON.stringify(publicObject)).not.toContain('vault/');
    expect(JSON.stringify(publicObject)).not.toContain('f'.repeat(64));
  });

  it('dataset projection strips server-owned storage keys and URIs', () => {
    const publicDataset = toPublicDataset({
      id: 'ds_abc',
      projectId: 'proj_abc',
      ownerUserId: 1,
      internalStorageKey: 'projects/proj_abc/datasets/ds_abc',
      storageUri: 'vault/alice/private/dataset.h5',
      fileType: 'h5ad',
      uploadStatus: 'uploaded',
      validationStatus: 'valid'
    });

    expect(publicDataset).not.toHaveProperty('internalStorageKey');
    expect(publicDataset).not.toHaveProperty('storageUri');
    expect(JSON.stringify(publicDataset)).not.toContain('projects/proj_abc/datasets/ds_abc');
    expect(JSON.stringify(publicDataset)).not.toContain('vault/');
  });

  it('job artifact projection strips internal storage URI but keeps safe descriptors', () => {
    const publicArtifact = toPublicJobArtifact({
      id: 'art_abc',
      projectId: 'proj_abc',
      jobId: 'job_abc',
      artifactType: 'checkpoint',
      storageKind: 'local_internal',
      storageUri: 'vault/alice/checkpoints/job_abc/private.rds',
      checksumSha256: 'a'.repeat(64),
      sizeBytes: 123,
      status: 'available',
      metadata: { summary: true }
    });

    expect(publicArtifact).not.toHaveProperty('storageUri');
    expect(JSON.stringify(publicArtifact)).not.toContain('vault/');
    expect(publicArtifact.storageKind).toBe('local_internal');
    expect(publicArtifact.checksumSha256).toBe('a'.repeat(64));
    expect(publicArtifact.sizeBytes).toBe(123);
  });
});
