import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIPELINE_ID,
  buildPipelineSidebarSections,
  getDefaultPipelineManifest,
  resolvePipelineManifest,
  validatePipelineManifest,
} from './pipelineRegistry';

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'custom-seurat-view',
    name: 'Custom Seurat View',
    tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
    ...overrides,
  };
}

describe('pipelineRegistry', () => {
  it('defines the default Seurat pipeline as registered declarative tabs', () => {
    const definition = getDefaultPipelineManifest();

    expect(definition.id).toBe(DEFAULT_PIPELINE_ID);
    expect(definition.tabs.map(tab => tab.id)).toEqual([
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
    expect(definition.tabs.some(tab => Object.keys(tab).some(key => [
      'icon', 'routeId', 'componentKey', 'jobType', 'executable', 'endpoint', 'code',
    ].includes(key)))).toBe(false);
  });

  it('derives navigation and executable metadata only from the code-shipped registry', () => {
    const declarative = validatePipelineManifest(manifest({
      tabs: [{
        id: 'deg',
        label: 'Markers',
        moduleKey: 'differentialExpression',
        resultArtifactTypes: ['deg_markers'],
        resultViews: [{ type: 'artifactTable', title: 'Markers', artifactType: 'deg_markers' }],
      }],
    }));

    expect(declarative.tabs[0]).not.toHaveProperty('routeId');
    expect(declarative.tabs[0]).not.toHaveProperty('componentKey');
    expect(declarative.tabs[0]).not.toHaveProperty('jobType');
    expect(declarative.tabs[0]).not.toHaveProperty('executable');

    const resolved = resolvePipelineManifest(declarative);
    expect(resolved.tabs[0]).toEqual(expect.objectContaining({
      routeId: 'deg',
      componentKey: 'differentialExpression',
      jobType: 'deg.find_markers.v1',
      executable: true,
    }));
  });

  it('builds pipeline sidebar sections from validated manifest labels', () => {
    const definition = getDefaultPipelineManifest();
    const sections = buildPipelineSidebarSections(definition, { qc: true });

    expect(sections[0].label).toBe('Default Seurat scRNA-seq Pipeline');
    expect(sections.flatMap(section => section.items).map(item => item.label)).toContain('Quality Control');
    expect(sections.flatMap(section => section.items).find(item => item.id === 'qc')?.done).toBe(true);
    expect(sections.flatMap(section => section.items).some(item => item.icon)).toBe(false);
  });

  it('rejects every client-controlled execution or routing field', () => {
    for (const [field, value] of [
      ['icon', 'activity'],
      ['routeId', 'inspect'],
      ['componentKey', 'inspect'],
      ['jobType', 'arbitrary.r.v1'],
      ['executable', true],
      ['endpoint', '/api/r/deg'],
      ['code', 'RunPCA(global_obj)'],
    ]) {
      expect(() => validatePipelineManifest(manifest({
        tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', [field]: value }],
      }))).toThrow(new RegExp(`${field} is not allowed`, 'i'));
    }
  });

  it('rejects unknown modules, mismatched routes, and module-incompatible UI templates', () => {
    expect(() => validatePipelineManifest(manifest({
      tabs: [{ id: 'magic', label: 'Magic', moduleKey: 'arbitraryR' }],
    }))).toThrow(/moduleKey is not registered/i);

    expect(() => validatePipelineManifest(manifest({
      tabs: [{ id: 'my-qc', label: 'QC', moduleKey: 'seuratQc' }],
    }))).toThrow(/must be 'qc'/i);

    expect(() => validatePipelineManifest(manifest({
      tabs: [{
        id: 'qc',
        label: 'QC',
        moduleKey: 'seuratQc',
        parameterSchema: [{ key: 'method', label: 'Method', type: 'enum', options: ['a'] }],
      }],
    }))).toThrow(/type is not registered for this module/i);

    expect(() => validatePipelineManifest(manifest({
      tabs: [{
        id: 'qc',
        label: 'QC',
        moduleKey: 'seuratQc',
        resultViews: ['artifactTable'],
      }],
    }))).toThrow(/not registered for this module/i);

    expect(() => validatePipelineManifest(manifest({
      tabs: [{
        id: 'deg',
        label: 'Markers',
        moduleKey: 'differentialExpression',
        resultArtifactTypes: ['deg_markers'],
        resultViews: [{ type: 'artifactTable', artifactType: 'checkpoint' }],
      }],
    }))).toThrow(/artifactType is not available/i);
  });

  it('normalizes strict typed templates without preserving unknown nested fields', () => {
    const definition = validatePipelineManifest(manifest({
      tabs: [{
        id: 'qc',
        label: 'QC Review',
        moduleKey: 'seuratQc',
        parameterSchema: [
          { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
          { key: 'threshold', label: 'Threshold', type: 'number', min: 0, max: 5, step: 0.25, default: 1.5 },
          { key: 'features', label: 'Features', type: 'integer', min: 1, default: 200 },
          { key: 'genes', label: 'Genes', type: 'text', maxLength: 500, placeholder: 'MS4A1' },
        ],
        resultViews: ['summaryMetrics', { type: 'placeholder', title: 'QC plots' }],
      }],
    }));

    expect(definition.tabs[0]).toEqual(expect.objectContaining({
      id: 'qc',
      parameterSchema: [
        expect.objectContaining({ key: 'enabled', type: 'boolean', default: true }),
        expect.objectContaining({ key: 'threshold', type: 'number', step: 0.25 }),
        expect.objectContaining({ key: 'features', type: 'integer', default: 200 }),
        expect.objectContaining({ key: 'genes', type: 'text', maxLength: 500 }),
      ],
      resultViews: ['summaryMetrics', { type: 'placeholder', title: 'QC plots' }],
    }));

    expect(() => validatePipelineManifest(manifest({
      tabs: [{
        id: 'qc',
        label: 'QC',
        moduleKey: 'seuratQc',
        parameterSchema: [{ key: 'threshold', label: 'Threshold', type: 'number', min: 0, unsafe: { code: 'x' } }],
      }],
    }))).toThrow(/unsafe is not allowed/i);
  });

  it('falls back to the built-in sidebar when handed an invalid registry manifest', () => {
    const sections = buildPipelineSidebarSections({
      schemaVersion: 1,
      id: 'tampered-view',
      name: 'Tampered View',
      tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', endpoint: '/unsafe' }],
    });

    expect(sections[0].label).toBe('Default Seurat scRNA-seq Pipeline');
    expect(sections.flatMap(section => section.items).map(item => item.id)).toContain('deg');
  });
});
