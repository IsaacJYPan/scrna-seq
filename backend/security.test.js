import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const {
  initDatabase,
  closeDatabase,
  saveProvenance,
  getProvenance,
  getAllProvenance,
  deleteProvenance,
  makeCacheKey,
  getCachedResult,
  setCachedResult,
  clearCache,
  saveFigure,
  getFiguresByUser,
  deleteFigure
} = require('./database');

function provenance(id, operation = 'load') {
  return {
    id,
    timestamp: new Date().toISOString(),
    language: 'R',
    languageVersion: '4.4.0',
    packages: ['Seurat'],
    operation,
    parameters: {},
    script: 'obj <- CreateSeuratObject(counts)',
    parentIds: []
  };
}

describe('security data isolation', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('scopes provenance reads and deletes to the authenticated user', () => {
    saveProvenance({ userEmail: 'alice@example.com', provenance: provenance('prov-alice') });
    saveProvenance({ userEmail: 'bob@example.com', provenance: provenance('prov-bob') });

    expect(getAllProvenance('alice@example.com').map(p => p.id)).toEqual(['prov-alice']);
    expect(getProvenance('prov-bob', 'alice@example.com')).toBeNull();

    expect(deleteProvenance('prov-bob', 'alice@example.com')).toBe(false);
    expect(getProvenance('prov-bob', 'bob@example.com')).not.toBeNull();
  });

  it('keeps cache keys and cache rows isolated per user', () => {
    saveProvenance({ userEmail: 'alice@example.com', provenance: provenance('prov-alice') });
    saveProvenance({ userEmail: 'bob@example.com', provenance: provenance('prov-bob') });

    const aliceKey = makeCacheKey('umap', { dims: 15 }, 1, [], 'alice@example.com');
    const bobKey = makeCacheKey('umap', { dims: 15 }, 1, [], 'bob@example.com');

    expect(aliceKey).not.toBe(bobKey);

    setCachedResult(aliceKey, 'prov-alice', { points: [1, 2, 3] }, 'alice@example.com');
    expect(getCachedResult(aliceKey, 'alice@example.com')?.result).toEqual({ points: [1, 2, 3] });
    expect(getCachedResult(aliceKey, 'bob@example.com')).toBeNull();
    expect(() => setCachedResult(aliceKey, 'prov-bob', {}, 'alice@example.com')).toThrow(/another user/i);

    clearCache('bob@example.com');
    expect(getCachedResult(aliceKey, 'alice@example.com')).not.toBeNull();
  });

  it('prevents users from replacing or deleting another user figure', () => {
    saveFigure({
      id: 'fig-shared-id',
      userEmail: 'alice@example.com',
      objectId: 'obj-1',
      plotType: 'UMAP',
      title: 'Alice plot',
      params: {},
      filePath: 'vault/alice/fig.png',
      fileFormat: 'png',
      thumbnailB64: ''
    });

    expect(() => saveFigure({
      id: 'fig-shared-id',
      userEmail: 'bob@example.com',
      objectId: 'obj-2',
      plotType: 'FeaturePlot',
      title: 'Bob overwrite',
      params: {},
      filePath: 'vault/bob/fig.png',
      fileFormat: 'png',
      thumbnailB64: ''
    })).toThrow(/another user/i);

    expect(deleteFigure('fig-shared-id', 'bob@example.com')).toBe(false);
    expect(getFiguresByUser('alice@example.com')).toHaveLength(1);

    expect(deleteFigure('fig-shared-id', 'alice@example.com')).toBe(true);
    expect(getFiguresByUser('alice@example.com')).toHaveLength(0);
  });
});
