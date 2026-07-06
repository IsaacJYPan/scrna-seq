const DEFAULT_PIPELINE_ID = 'default-seurat-scrna-v1';

const PIPELINE_ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const TAB_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const MAX_TABS = 40;

const PARAMETER_TEMPLATE_TYPES = Object.freeze([
  'boolean',
  'number',
  'integer',
  'enum',
  'text',
  'geneList',
  'metadataColumn',
  'clusterSelector',
  'datasetSelector',
]);

const RESULT_VIEW_TEMPLATES = Object.freeze([
  'summaryMetrics',
  'artifactTable',
  'jobLogs',
  'plotlyEmbedding',
  'plotlyScatter',
  'plotlyViolin',
  'plotlyHeatmap',
  'plotlyDotPlot',
  'networkGraph',
  'placeholder',
]);

const MODULES = Object.freeze({
  inspectObject: Object.freeze({
    routeId: 'inspect',
    componentKey: 'inspect',
    resultViewTemplates: ['summaryMetrics'],
  }),
  seuratQc: Object.freeze({
    routeId: 'qc',
    componentKey: 'qualityControl',
    jobType: 'seurat.qc.v1',
    resultArtifactTypes: ['qc_summary'],
    resultViewTemplates: ['plotlyViolin', 'summaryMetrics', 'jobLogs'],
  }),
  seuratNormalize: Object.freeze({
    routeId: 'normalize',
    componentKey: 'normalization',
    jobType: 'seurat.normalize.v1',
    resultArtifactTypes: ['normalization_summary'],
    resultViewTemplates: ['summaryMetrics', 'jobLogs'],
  }),
  seuratIntegration: Object.freeze({
    routeId: 'integrate',
    componentKey: 'batchIntegration',
    jobType: 'seurat.integrate.v1',
    resultArtifactTypes: ['integration_summary'],
    resultViewTemplates: ['summaryMetrics', 'plotlyEmbedding', 'jobLogs'],
  }),
  seuratPca: Object.freeze({
    routeId: 'pca',
    componentKey: 'pca',
    jobType: 'seurat.pca.v1',
    resultArtifactTypes: ['pca_summary'],
    resultViewTemplates: ['plotlyScatter', 'summaryMetrics', 'jobLogs'],
  }),
  seuratCluster: Object.freeze({
    routeId: 'cluster',
    componentKey: 'clustering',
    jobType: 'seurat.cluster.v1',
    resultArtifactTypes: ['cluster_summary'],
    resultViewTemplates: ['summaryMetrics', 'jobLogs'],
  }),
  seuratUmap: Object.freeze({
    routeId: 'umap',
    componentKey: 'umap',
    jobType: 'seurat.umap.v1',
    resultArtifactTypes: ['umap_summary'],
    resultViewTemplates: ['plotlyEmbedding', 'summaryMetrics', 'jobLogs'],
  }),
  featurePlot: Object.freeze({
    routeId: 'featureplot',
    componentKey: 'featurePlot',
    resultViewTemplates: ['plotlyEmbedding'],
  }),
  geneExpression: Object.freeze({
    routeId: 'geneviewer',
    componentKey: 'geneViewer',
    resultViewTemplates: ['plotlyScatter', 'summaryMetrics'],
  }),
  heatmap: Object.freeze({
    routeId: 'heatmap',
    componentKey: 'heatmap',
    resultViewTemplates: ['plotlyHeatmap'],
  }),
  dotPlot: Object.freeze({
    routeId: 'dotplot',
    componentKey: 'dotPlot',
    resultViewTemplates: ['plotlyDotPlot'],
  }),
  differentialExpression: Object.freeze({
    routeId: 'deg',
    componentKey: 'differentialExpression',
    jobType: 'deg.find_markers.v1',
    resultArtifactTypes: ['deg_summary', 'deg_markers'],
    resultViewTemplates: ['summaryMetrics', 'artifactTable', 'jobLogs'],
  }),
  projectHistory: Object.freeze({
    routeId: 'history',
    componentKey: 'projectHistory',
    resultViewTemplates: ['artifactTable', 'jobLogs'],
  }),
});

const UNSAFE_FIELDS = Object.freeze([
  'code', 'rCode', 'script', 'command', 'shell', 'endpoint', 'path', 'url',
  'method', 'storageKey', 'storageUri', 'stateKey', 'icon'
]);

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw codedError('INVALID_PIPELINE_MANIFEST', `${label} must be a plain object.`);
  }
}

function assertNoUnsafeFields(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const field of UNSAFE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.${field} is not allowed.`);
    }
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateParameterSchema(schema, label) {
  if (schema === undefined) return [];
  if (!Array.isArray(schema)) {
    throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.parameterSchema must be an array.`);
  }
  return schema.map((param, index) => {
    assertPlainObject(param, `${label}.parameterSchema[${index}]`);
    assertNoUnsafeFields(param, `${label}.parameterSchema[${index}]`);
    if (!TAB_ID_RE.test(param.key || '')) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.parameterSchema[${index}].key must be a slug-safe identifier.`);
    }
    if (!PARAMETER_TEMPLATE_TYPES.includes(param.type)) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.parameterSchema[${index}].type is not a supported parameter template.`);
    }
    if (param.label !== undefined && (typeof param.label !== 'string' || param.label.length > 80)) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.parameterSchema[${index}].label must be a short string.`);
    }
    if (param.type === 'enum') {
      if (!Array.isArray(param.options) || param.options.length === 0 || param.options.length > 40) {
        throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.parameterSchema[${index}].options must be a non-empty bounded array.`);
      }
      for (const option of param.options) {
        if (typeof option !== 'string' && typeof option !== 'number' && typeof option !== 'boolean') {
          throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.parameterSchema[${index}].options may only contain scalar values.`);
        }
      }
    }
    return clone(param);
  });
}

function validateResultViews(views, label, moduleDef) {
  if (views === undefined) return moduleDef.resultViewTemplates || [];
  if (!Array.isArray(views) || views.length === 0 || views.length > 12) {
    throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.resultViews must be a non-empty bounded array.`);
  }
  return views.map((view, index) => {
    const type = typeof view === 'string' ? view : view?.type;
    if (!RESULT_VIEW_TEMPLATES.includes(type)) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.resultViews[${index}] is not a supported result view template.`);
    }
    if (typeof view === 'object') {
      assertNoUnsafeFields(view, `${label}.resultViews[${index}]`);
      return clone(view);
    }
    return type;
  });
}

function validateResultArtifactTypes(types, label, moduleDef) {
  if (types === undefined) return moduleDef.resultArtifactTypes || [];
  if (!Array.isArray(types) || types.length > 20) {
    throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.resultArtifactTypes must be a bounded array.`);
  }
  const allowed = new Set(moduleDef.resultArtifactTypes || []);
  return types.map((type, index) => {
    if (typeof type !== 'string' || !allowed.has(type)) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `${label}.resultArtifactTypes[${index}] is not produced by the registered module.`);
    }
    return type;
  });
}

function validatePipelineManifest(input) {
  assertPlainObject(input, 'manifest');
  assertNoUnsafeFields(input, 'manifest');
  if (input.schemaVersion !== 1) {
    throw codedError('INVALID_PIPELINE_MANIFEST', 'manifest.schemaVersion must be 1.');
  }
  if (!PIPELINE_ID_RE.test(input.id || '')) {
    throw codedError('INVALID_PIPELINE_MANIFEST', 'manifest.id must be a slug-safe identifier.');
  }
  if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 100) {
    throw codedError('INVALID_PIPELINE_MANIFEST', 'manifest.name must be a short string.');
  }
  if (input.modality !== undefined && !['scrna', 'spatial', 'multiomics', 'generic'].includes(input.modality)) {
    throw codedError('INVALID_PIPELINE_MANIFEST', 'manifest.modality is not supported.');
  }
  if (!Array.isArray(input.tabs) || input.tabs.length === 0 || input.tabs.length > MAX_TABS) {
    throw codedError('INVALID_PIPELINE_MANIFEST', `manifest.tabs must contain 1-${MAX_TABS} tabs.`);
  }

  const seen = new Set();
  const tabs = input.tabs.map((tab, idx) => {
    assertPlainObject(tab, `manifest.tabs[${idx}]`);
    assertNoUnsafeFields(tab, `manifest.tabs[${idx}]`);
    if (!TAB_ID_RE.test(tab.id || '')) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `manifest.tabs[${idx}].id must be a slug-safe identifier.`);
    }
    if (seen.has(tab.id)) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `Duplicate pipeline tab id '${tab.id}'.`);
    }
    seen.add(tab.id);
    const moduleDef = MODULES[tab.moduleKey];
    if (!moduleDef) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `manifest.tabs[${idx}].moduleKey is not registered.`);
    }
    if (tab.id !== moduleDef.routeId) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `manifest.tabs[${idx}].id must be '${moduleDef.routeId}' for module '${tab.moduleKey}'.`);
    }
    if (tab.componentKey !== undefined && tab.componentKey !== moduleDef.componentKey) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `manifest.tabs[${idx}].componentKey does not match the registered module.`);
    }
    if (tab.jobType !== undefined && tab.jobType !== moduleDef.jobType) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `manifest.tabs[${idx}].jobType does not match the registered module.`);
    }
    if (typeof tab.label !== 'string' || tab.label.trim().length < 2 || tab.label.length > 80) {
      throw codedError('INVALID_PIPELINE_MANIFEST', `manifest.tabs[${idx}].label must be a short string.`);
    }
    return {
      id: tab.id,
      label: tab.label.trim(),
      moduleKey: tab.moduleKey,
      routeId: moduleDef.routeId,
      componentKey: moduleDef.componentKey,
      jobType: moduleDef.jobType || null,
      optional: tab.optional === true,
      parameterSchema: validateParameterSchema(tab.parameterSchema, `manifest.tabs[${idx}]`),
      resultArtifactTypes: validateResultArtifactTypes(tab.resultArtifactTypes, `manifest.tabs[${idx}]`, moduleDef),
      resultViews: validateResultViews(tab.resultViews, `manifest.tabs[${idx}]`, moduleDef),
    };
  });

  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name.trim(),
    description: typeof input.description === 'string' ? input.description.slice(0, 400) : '',
    modality: input.modality || 'scrna',
    tabs,
  };
}

const DEFAULT_SEURAT_PIPELINE = validatePipelineManifest({
  schemaVersion: 1,
  id: DEFAULT_PIPELINE_ID,
  name: 'Default Seurat scRNA-seq Pipeline',
  description: 'Dataset-backed Seurat preprocessing, exploration, DEG, and project history using registered modules.',
  modality: 'scrna',
  tabs: [
    { id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' },
    { id: 'qc', label: 'Quality Control', moduleKey: 'seuratQc' },
    { id: 'normalize', label: 'Normalize', moduleKey: 'seuratNormalize' },
    { id: 'integrate', label: 'Integration', moduleKey: 'seuratIntegration', optional: true },
    { id: 'pca', label: 'PCA', moduleKey: 'seuratPca' },
    { id: 'cluster', label: 'Cluster', moduleKey: 'seuratCluster' },
    { id: 'umap', label: 'UMAP', moduleKey: 'seuratUmap' },
    { id: 'featureplot', label: 'Feature Plot', moduleKey: 'featurePlot' },
    { id: 'geneviewer', label: 'Gene Expression', moduleKey: 'geneExpression' },
    { id: 'heatmap', label: 'Heatmap', moduleKey: 'heatmap' },
    { id: 'dotplot', label: 'Dot Plot', moduleKey: 'dotPlot' },
    { id: 'deg', label: 'Markers / DEG', moduleKey: 'differentialExpression' },
    { id: 'history', label: 'Jobs & Artifacts', moduleKey: 'projectHistory' },
  ],
});

function getDefaultPipelineManifest() {
  return JSON.parse(JSON.stringify(DEFAULT_SEURAT_PIPELINE));
}

function isBuiltInPipelineId(id) {
  return id === DEFAULT_PIPELINE_ID;
}

module.exports = {
  DEFAULT_PIPELINE_ID,
  MODULES,
  validatePipelineManifest,
  getDefaultPipelineManifest,
  isBuiltInPipelineId,
};
