import { describe, expect, it } from 'vitest';
import { buildProjectProvenancePayload } from './projectProvenance';

describe('project provenance compatibility payload', () => {
  it('connects a live operation to its durable analysis object', () => {
    expect(buildProjectProvenancePayload({
      timestamp: '2026-08-12T20:00:00-0700',
      language: 'R',
      languageVersion: '4.5.3',
      packages: ['Seurat'],
      script: 'obj <- NormalizeData(obj)',
      parameters: { method: 'LogNormalize' },
      operation: 'normalize',
      id: 'legacy-user-provenance-id',
      parentIds: ['legacy-parent-id'],
    }, 'ao_saved_1')).toEqual({
      analysisObjectId: 'ao_saved_1',
      timestamp: '2026-08-12T20:00:00-0700',
      language: 'R',
      languageVersion: '4.5.3',
      packages: ['Seurat'],
      script: 'obj <- NormalizeData(obj)',
      parameters: { method: 'LogNormalize' },
      operation: 'normalize',
    });
  });
});
