import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIPELINE_ID,
  buildPipelineSidebarSections,
  getDefaultPipelineManifest,
  validatePipelineManifest,
} from './pipelineRegistry';

describe('pipelineRegistry', () => {
  it('defines the default Seurat pipeline as registered module tabs without icons', () => {
    const manifest = getDefaultPipelineManifest();

    expect(manifest.id).toBe(DEFAULT_PIPELINE_ID);
    expect(manifest.tabs.map(tab => tab.id)).toEqual([
      'inspect',
      'qc',
      'normalize',
      'integrate',
      'pca',
      'cluster',
      'umap',
      'featureplot',
      'geneviewer',
      'heatmap',
      'dotplot',
      'deg',
      'history',
    ]);
    expect(manifest.tabs.some(tab => Object.prototype.hasOwnProperty.call(tab, 'icon'))).toBe(false);
  });

  it('builds pipeline sidebar sections from the manifest labels', () => {
    const manifest = getDefaultPipelineManifest();
    const sections = buildPipelineSidebarSections(manifest, { qc: true });

    expect(sections[0].label).toBe('Default Seurat scRNA-seq Pipeline');
    expect(sections.flatMap(section => section.items).map(item => item.label)).toContain('Quality Control');
    expect(sections.flatMap(section => section.items).find(item => item.id === 'qc')?.done).toBe(true);
    expect(sections.flatMap(section => section.items).some(item => item.icon)).toBe(false);
  });

  it('rejects uploaded manifests that try to provide execution fields or icons', () => {
    const base = {
      schemaVersion: 1,
      id: 'custom-seurat-view',
      name: 'Custom Seurat View',
      tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
    };

    expect(() => validatePipelineManifest({
      ...base,
      tabs: [{ ...base.tabs[0], icon: 'activity' }],
    })).toThrow(/icon is not allowed/i);

    expect(() => validatePipelineManifest({
      ...base,
      tabs: [{ ...base.tabs[0], endpoint: '/api/r/deg' }],
    })).toThrow(/endpoint is not allowed/i);

    expect(() => validatePipelineManifest({
      ...base,
      tabs: [{ ...base.tabs[0], code: 'RunPCA(global_obj)' }],
    })).toThrow(/code is not allowed/i);
  });

  it('rejects modules that are not registered in the app', () => {
    expect(() => validatePipelineManifest({
      schemaVersion: 1,
      id: 'custom-unknown',
      name: 'Custom Unknown',
      tabs: [{ id: 'magic', label: 'Magic', moduleKey: 'arbitraryR' }],
    })).toThrow(/moduleKey is not registered/i);
  });

  it('requires uploaded tabs to use registered route ids and preserves safe UI templates', () => {
    expect(() => validatePipelineManifest({
      schemaVersion: 1,
      id: 'custom-route-mismatch',
      name: 'Custom Route Mismatch',
      tabs: [{ id: 'my-qc', label: 'QC', moduleKey: 'seuratQc' }],
    })).toThrow(/must be 'qc'/i);

    expect(() => validatePipelineManifest({
      schemaVersion: 1,
      id: 'custom-artifact-mismatch',
      name: 'Custom Artifact Mismatch',
      tabs: [{ id: 'qc', label: 'QC', moduleKey: 'seuratQc', resultArtifactTypes: ['deg_markers'] }],
    })).toThrow(/not produced by the registered module/i);

    const manifest = validatePipelineManifest({
      schemaVersion: 1,
      id: 'custom-qc-view',
      name: 'Custom QC View',
      tabs: [{
        id: 'qc',
        label: 'QC Review',
        moduleKey: 'seuratQc',
        parameterSchema: [{ key: 'minfeatures', label: 'Minimum features', type: 'integer' }],
        resultViews: ['plotlyViolin', { type: 'summaryMetrics', title: 'Summary' }],
      }],
    });

    expect(manifest.tabs[0]).toEqual(expect.objectContaining({
      id: 'qc',
      routeId: 'qc',
      parameterSchema: [expect.objectContaining({ key: 'minfeatures', type: 'integer' })],
      resultViews: ['plotlyViolin', expect.objectContaining({ type: 'summaryMetrics' })],
    }));
  });
});
