import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');

const {
  saveProvenance, getProvenance,
  saveFigure, getFiguresByUser, deleteFigure
} = db;

const CONFIGURED = config.hasPostgresConnection();

describe.skipIf(!CONFIGURED)('pgDatabase.js tests', () => {
  beforeAll(async () => {
    await db.resetSchemaForTests();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.resetSchemaForTests();
  });

  it('should initialize the database and create tables', async () => {
    await expect(await saveFigure({
      id: 'test-init-id',
      userEmail: 'test@example.com',
      objectId: 'obj-1',
      plotType: 'UMAP',
      title: 'Test UMAP',
      params: {},
      filePath: '/tmp/test.png',
      fileFormat: 'png',
      thumbnailB64: 'base64str'
    })).resolves.not.toThrow();

    const figures = await getFiguresByUser('test@example.com');
    expect(figures.length).toBe(1);
    expect(figures[0].id).toBe('test-init-id');
  });

  it('should save and retrieve a provenance record', async () => {
    const record = {
      id: 'prov-1',
      timestamp: new Date().toISOString(),
      language: 'R',
      languageVersion: '4.3.0',
      packages: ['Seurat', 'dplyr'],
      operation: 'RunUMAP',
      parameters: { dims: [1, 10] },
      script: 'obj <- RunUMAP(obj, dims = 1:10)',
      results: ['umap_coords.csv'],
      environment: { os: 'Windows' },
      parentIds: ['prov-0'],
      user_id: 'user-1'
    };

    // user-owned helpers now require an owner email (see finding 6).
    const insertedId = await saveProvenance({ userEmail: 'owner@example.com', provenance: record, result: { message: "success" } });
    expect(insertedId).toBe('prov-1');

    const retrieved = await getProvenance('prov-1', 'owner@example.com');
    expect(retrieved).not.toBeNull();
    expect(retrieved.id).toBe('prov-1');
    expect(retrieved.operation).toEqual('RunUMAP');
    expect(retrieved.parameters).toEqual({ dims: [1, 10] });
    // Note: getProvenance does not return the result (that goes to cache)
  });

  it('should perform CRUD on the figure gallery', async () => {
    const figure = {
      id: 'fig-1',
      userEmail: 'test2@example.com',
      objectId: 'obj-1',
      plotType: 'FeaturePlot',
      title: 'CD8A Expression',
      params: { features: ['CD8A'] },
      filePath: '/tmp/cd8a.pdf',
      fileFormat: 'pdf',
      thumbnailB64: 'thumbnail_base64'
    };

    // Create
    await saveFigure(figure);

    // Read
    let figures = await getFiguresByUser('test2@example.com', 'obj-1');
    expect(figures.length).toBe(1);
    expect(figures[0].plotType).toBe('FeaturePlot');

    // Delete (user-owned helper now requires an owner email — see finding 6)
    await deleteFigure('fig-1', 'test2@example.com');

    // Verify Delete
    figures = await getFiguresByUser('test2@example.com', 'obj-1');
    expect(figures.length).toBe(0);
  });
});
