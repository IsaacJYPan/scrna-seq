import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeCacheKey, buildPipelineScript } from './provenance';

describe('provenance.js logic', () => {
  beforeEach(() => {
    // Reset any global mocks if necessary
    global.window = {
      electronAPI: undefined // Fallback path
    };
  });

  it('should generate a deterministic cache key via fallback', async () => {
    const key = await makeCacheKey('RunUMAP', { dims: 10 }, 'v1', ['parent-id']);
    expect(key).toBe('RunUMAP-{"dims":10}-v1-["parent-id"]');
  });

  it('should build a deduplicated and ordered pipeline script', () => {
    const mockChain = [
      {
        id: '1',
        operation: 'NormalizeData',
        packages: ['Seurat'],
        script: 'obj <- NormalizeData(obj)'
      },
      {
        id: '2',
        operation: 'FindVariableFeatures',
        packages: ['Seurat'],
        script: 'obj <- FindVariableFeatures(obj)'
      },
      {
        id: '3',
        operation: 'CustomStep',
        packages: ['dplyr'],
        script: 'obj <- obj %>% filter()'
      }
    ];

    const script = buildPipelineScript(mockChain);

    // Should include library calls deduplicated
    expect(script).toContain('library(Seurat)');
    expect(script).toContain('library(dplyr)');

    // Ensure the library calls only appear once
    const seuratOccurrences = (script.match(/library\(Seurat\)/g) || []).length;
    expect(seuratOccurrences).toBe(1);

    // Should include all operation scripts in order
    expect(script.indexOf('NormalizeData(obj)')).toBeLessThan(script.indexOf('FindVariableFeatures(obj)'));
    expect(script.indexOf('FindVariableFeatures(obj)')).toBeLessThan(script.indexOf('filter()'));
  });
});
