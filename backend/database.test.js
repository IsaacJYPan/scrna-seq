import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { 
  initDatabase, closeDatabase, saveProvenance, getProvenance, 
  saveFigure, getFiguresByUser, deleteFigure 
} = require('./database');

describe('database.js tests', () => {
  beforeEach(() => {
    // Initialize an in-memory database for testing
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('should initialize the database and create tables', () => {
    expect(() => {
      saveFigure({
        id: 'test-init-id',
        userEmail: 'test@example.com',
        objectId: 'obj-1',
        plotType: 'UMAP',
        title: 'Test UMAP',
        params: {},
        filePath: '/tmp/test.png',
        fileFormat: 'png',
        thumbnailB64: 'base64str'
      });
    }).not.toThrow();

    const figures = getFiguresByUser('test@example.com');
    expect(figures.length).toBe(1);
    expect(figures[0].id).toBe('test-init-id');
  });

  it('should save and retrieve a provenance record', () => {
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
    const insertedId = saveProvenance({ userEmail: 'owner@example.com', provenance: record, result: { message: "success" } });
    expect(insertedId).toBe('prov-1');

    const retrieved = getProvenance('prov-1', 'owner@example.com');
    expect(retrieved).not.toBeNull();
    expect(retrieved.id).toBe('prov-1');
    expect(retrieved.operation).toEqual('RunUMAP');
    expect(retrieved.parameters).toEqual({ dims: [1, 10] });
    // Note: getProvenance does not return the result (that goes to cache)
  });

  it('should perform CRUD on the figure gallery', () => {
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
    saveFigure(figure);
    
    // Read
    let figures = getFiguresByUser('test2@example.com', 'obj-1');
    expect(figures.length).toBe(1);
    expect(figures[0].plotType).toBe('FeaturePlot');

    // Delete (user-owned helper now requires an owner email — see finding 6)
    deleteFigure('fig-1', 'test2@example.com');
    
    // Verify Delete
    figures = getFiguresByUser('test2@example.com', 'obj-1');
    expect(figures.length).toBe(0);
  });
});
