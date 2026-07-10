import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');

const {
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
} = db;

const CONFIGURED = config.hasPostgresConnection();

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

describe.skipIf(!CONFIGURED)('security data isolation', () => {
  beforeAll(async () => {
    await db.resetSchemaForTests();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.resetSchemaForTests();
  });

  it('scopes provenance reads and deletes to the authenticated user', async () => {
    await saveProvenance({ userEmail: 'alice@example.com', provenance: provenance('prov-alice') });
    await saveProvenance({ userEmail: 'bob@example.com', provenance: provenance('prov-bob') });

    expect((await getAllProvenance('alice@example.com')).map(p => p.id)).toEqual(['prov-alice']);
    expect(await getProvenance('prov-bob', 'alice@example.com')).toBeNull();

    expect(await deleteProvenance('prov-bob', 'alice@example.com')).toBe(false);
    expect(await getProvenance('prov-bob', 'bob@example.com')).not.toBeNull();
  });

  it('keeps cache keys and cache rows isolated per user', async () => {
    await saveProvenance({ userEmail: 'alice@example.com', provenance: provenance('prov-alice') });
    await saveProvenance({ userEmail: 'bob@example.com', provenance: provenance('prov-bob') });

    const aliceKey = makeCacheKey('umap', { dims: 15 }, 1, [], 'alice@example.com');
    const bobKey = makeCacheKey('umap', { dims: 15 }, 1, [], 'bob@example.com');

    expect(aliceKey).not.toBe(bobKey);

    await setCachedResult(aliceKey, 'prov-alice', { points: [1, 2, 3] }, 'alice@example.com');
    expect((await getCachedResult(aliceKey, 'alice@example.com'))?.result).toEqual({ points: [1, 2, 3] });
    expect(await getCachedResult(aliceKey, 'bob@example.com')).toBeNull();
    await expect(await setCachedResult(aliceKey, 'prov-bob', {}, 'alice@example.com')).rejects.toThrow(/another user/i);

    await clearCache('bob@example.com');
    expect(await getCachedResult(aliceKey, 'alice@example.com')).not.toBeNull();
  });

  it('prevents users from replacing or deleting another user figure', async () => {
    await saveFigure({
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

    await expect(await saveFigure({
      id: 'fig-shared-id',
      userEmail: 'bob@example.com',
      objectId: 'obj-2',
      plotType: 'FeaturePlot',
      title: 'Bob overwrite',
      params: {},
      filePath: 'vault/bob/fig.png',
      fileFormat: 'png',
      thumbnailB64: ''
    })).rejects.toThrow(/another user/i);

    expect(await deleteFigure('fig-shared-id', 'bob@example.com')).toBe(false);
    expect(await getFiguresByUser('alice@example.com')).toHaveLength(1);

    expect(await deleteFigure('fig-shared-id', 'alice@example.com')).toBe(true);
    expect(await getFiguresByUser('alice@example.com')).toHaveLength(0);
  });

  // ── Finding 6: owner-optional DB helper footguns ──────────────────────────
  // A user-owned helper called without an owner used to silently match every
  // row (e.g. getAllProvenance() returning all users' provenance). These now
  // fail loudly. This test would fail before the fix (the calls returned data
  // instead of throwing).
  it('refuses user-owned reads/writes when no owner identity is provided', async () => {
    await saveProvenance({ userEmail: 'alice@example.com', provenance: provenance('prov-alice') });
    await saveProvenance({ userEmail: 'bob@example.com', provenance: provenance('prov-bob') });

    // The headline footgun: no longer returns every user's provenance.
    await expect(await getAllProvenance()).rejects.toThrow(/owner email is required/i);
    await expect(await getAllProvenance('')).rejects.toThrow(/owner email is required/i);
    await expect(await getAllProvenance('   ')).rejects.toThrow(/owner email is required/i);

    // The rest of the user-scoped family fails loudly too.
    await expect(await getProvenance('prov-alice')).rejects.toThrow(/owner email is required/i);
    await expect(await getProvenanceChain('prov-alice')).rejects.toThrow(/owner email is required/i);
    await expect(await deleteProvenance('prov-alice')).rejects.toThrow(/owner email is required/i);
    await expect(await getCachedResult('any-key')).rejects.toThrow(/owner email is required/i);
    await expect(await setCachedResult('any-key', 'prov-alice', {})).rejects.toThrow(/owner email is required/i);
    await expect(await clearCache()).rejects.toThrow(/owner email is required/i);
    await expect(await deleteFigure('fig-x')).rejects.toThrow(/owner email is required/i);

    // saveProvenance is owner-scoped too: an owner-less write must fail loudly
    // rather than persist an unreadable, orphaned row.
    await expect(saveProvenance({ provenance: provenance('prov-orphan') }))
      .rejects.toThrow(/owner email is required/i);
    await expect(saveProvenance({ userEmail: '   ', provenance: provenance('prov-orphan') }))
      .rejects.toThrow(/owner email is required/i);

    // With an owner, the same helpers still work and stay user-scoped.
    expect((await getAllProvenance('alice@example.com')).map(p => p.id)).toEqual(['prov-alice']);
  });

  // ── Finding 5: constrain saved figure file_path ───────────────────────────
  // saveFigure stored client-supplied file_path verbatim. Traversal-like input
  // is now rejected. This test would fail before the fix (the unsafe paths were
  // accepted and persisted).
  it('rejects traversal-like saved figure file paths (any user)', async () => {
    const unsafe = ['../../etc/passwd', 'a/../../b', 'foo/../bar', 'x\\..\\y', 'bad\0name'];
    for (const filePath of unsafe) {
      // assertSafeFigureFilePath is a synchronous guard.
      expect(() => assertSafeFigureFilePath(filePath), filePath).toThrow();
      await expect(saveFigure({
        id: `fig-${Buffer.from(filePath).toString('hex').slice(0, 8)}`,
        userEmail: 'alice@example.com',
        plotType: 'UMAP', params: {}, filePath, fileFormat: 'png', thumbnailB64: ''
      })).rejects.toThrow();
    }
    // No unsafe figure was persisted.
    expect(await getFiguresByUser('alice@example.com')).toHaveLength(0);

    // Safe relative and absolute server-written paths are still accepted.
    await expect(await saveFigure({
      id: 'fig-ok-rel', userEmail: 'alice@example.com', plotType: 'UMAP', params: {},
      filePath: 'exports/user-1/UMAP_20260101_000000_abcd.png', fileFormat: 'png', thumbnailB64: ''
    })).resolves.not.toThrow();
    await expect(await saveFigure({
      id: 'fig-ok-abs', userEmail: 'alice@example.com', plotType: 'UMAP', params: {},
      filePath: '/srv/app/exports/user-1/UMAP_20260101_000000_efgh.png', fileFormat: 'png', thumbnailB64: ''
    })).resolves.not.toThrow();
    expect(await getFiguresByUser('alice@example.com')).toHaveLength(2);
  });
});
