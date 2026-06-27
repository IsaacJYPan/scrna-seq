import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const {
  initDatabase,
  closeDatabase,
  saveProvenance,
  getProvenance,
  getAllProvenance,
  getProvenanceChain,
  deleteProvenance,
  makeCacheKey,
  getCachedResult,
  setCachedResult,
  clearCache,
  saveFigure,
  assertSafeFigureFilePath,
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

  // ── Finding 6: owner-optional DB helper footguns ──────────────────────────
  // A user-owned helper called without an owner used to silently match every
  // row (e.g. getAllProvenance() returning all users' provenance). These now
  // fail loudly. This test would fail before the fix (the calls returned data
  // instead of throwing).
  it('refuses user-owned reads/writes when no owner identity is provided', () => {
    saveProvenance({ userEmail: 'alice@example.com', provenance: provenance('prov-alice') });
    saveProvenance({ userEmail: 'bob@example.com', provenance: provenance('prov-bob') });

    // The headline footgun: no longer returns every user's provenance.
    expect(() => getAllProvenance()).toThrow(/owner email is required/i);
    expect(() => getAllProvenance('')).toThrow(/owner email is required/i);
    expect(() => getAllProvenance('   ')).toThrow(/owner email is required/i);

    // The rest of the user-scoped family fails loudly too.
    expect(() => getProvenance('prov-alice')).toThrow(/owner email is required/i);
    expect(() => getProvenanceChain('prov-alice')).toThrow(/owner email is required/i);
    expect(() => deleteProvenance('prov-alice')).toThrow(/owner email is required/i);
    expect(() => getCachedResult('any-key')).toThrow(/owner email is required/i);
    expect(() => setCachedResult('any-key', 'prov-alice', {})).toThrow(/owner email is required/i);
    expect(() => clearCache()).toThrow(/owner email is required/i);
    expect(() => deleteFigure('fig-x')).toThrow(/owner email is required/i);

    // With an owner, the same helpers still work and stay user-scoped.
    expect(getAllProvenance('alice@example.com').map(p => p.id)).toEqual(['prov-alice']);
  });

  // ── Finding 5: constrain saved figure file_path ───────────────────────────
  // saveFigure stored client-supplied file_path verbatim. Traversal-like input
  // is now rejected. This test would fail before the fix (the unsafe paths were
  // accepted and persisted).
  it('rejects traversal-like saved figure file paths (any user)', () => {
    const unsafe = ['../../etc/passwd', 'a/../../b', 'foo/../bar', 'x\\..\\y', 'bad\0name'];
    for (const filePath of unsafe) {
      expect(() => assertSafeFigureFilePath(filePath), filePath).toThrow();
      expect(() => saveFigure({
        id: `fig-${Buffer.from(filePath).toString('hex').slice(0, 8)}`,
        userEmail: 'alice@example.com',
        plotType: 'UMAP', params: {}, filePath, fileFormat: 'png', thumbnailB64: ''
      }), filePath).toThrow();
    }
    // No unsafe figure was persisted.
    expect(getFiguresByUser('alice@example.com')).toHaveLength(0);

    // Safe relative and absolute server-written paths are still accepted.
    expect(() => saveFigure({
      id: 'fig-ok-rel', userEmail: 'alice@example.com', plotType: 'UMAP', params: {},
      filePath: 'exports/user-1/UMAP_20260101_000000_abcd.png', fileFormat: 'png', thumbnailB64: ''
    })).not.toThrow();
    expect(() => saveFigure({
      id: 'fig-ok-abs', userEmail: 'alice@example.com', plotType: 'UMAP', params: {},
      filePath: '/srv/app/exports/user-1/UMAP_20260101_000000_efgh.png', fileFormat: 'png', thumbnailB64: ''
    })).not.toThrow();
    expect(getFiguresByUser('alice@example.com')).toHaveLength(2);
  });
});
