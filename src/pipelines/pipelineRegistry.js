const PIPELINE_ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const TAB_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const MAX_TABS = 40;

export const DEFAULT_PIPELINE_ID = 'default-seurat-scrna-v1';

export const PARAMETER_TEMPLATE_TYPES = Object.freeze([
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

export const RESULT_VIEW_TEMPLATES = Object.freeze([
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

export const PIPELINE_MODULES = Object.freeze({
  inspectObject: Object.freeze({
    moduleKey: 'inspectObject',
    routeId: 'inspect',
    componentKey: 'inspect',
    defaultLabel: 'Inspect',
    executable: false,
    requiresObject: true,
    resultViewTemplates: ['summaryMetrics'],
  }),
  seuratQc: Object.freeze({
    moduleKey: 'seuratQc',
    routeId: 'qc',
    componentKey: 'qualityControl',
    defaultLabel: 'Quality Control',
    jobType: 'seurat.qc.v1',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['number', 'integer', 'boolean', 'text'],
    resultArtifactTypes: ['qc_summary'],
    resultViewTemplates: ['plotlyViolin', 'summaryMetrics', 'jobLogs'],
  }),
  seuratNormalize: Object.freeze({
    moduleKey: 'seuratNormalize',
    routeId: 'normalize',
    componentKey: 'normalization',
    defaultLabel: 'Normalize',
    jobType: 'seurat.normalize.v1',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['enum', 'integer'],
    resultArtifactTypes: ['normalization_summary'],
    resultViewTemplates: ['summaryMetrics', 'jobLogs'],
  }),
  seuratIntegration: Object.freeze({
    moduleKey: 'seuratIntegration',
    routeId: 'integrate',
    componentKey: 'batchIntegration',
    defaultLabel: 'Integration',
    jobType: 'seurat.integrate.v1',
    executable: false,
    optional: true,
    requiresObject: true,
    parameterTemplates: ['enum', 'metadataColumn'],
    resultArtifactTypes: ['integration_summary'],
    resultViewTemplates: ['summaryMetrics', 'plotlyEmbedding', 'jobLogs'],
  }),
  seuratPca: Object.freeze({
    moduleKey: 'seuratPca',
    routeId: 'pca',
    componentKey: 'pca',
    defaultLabel: 'PCA',
    jobType: 'seurat.pca.v1',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['integer'],
    resultArtifactTypes: ['pca_summary'],
    resultViewTemplates: ['plotlyScatter', 'summaryMetrics', 'jobLogs'],
  }),
  seuratCluster: Object.freeze({
    moduleKey: 'seuratCluster',
    routeId: 'cluster',
    componentKey: 'clustering',
    defaultLabel: 'Cluster',
    jobType: 'seurat.cluster.v1',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['number', 'integer', 'enum'],
    resultArtifactTypes: ['cluster_summary'],
    resultViewTemplates: ['summaryMetrics', 'jobLogs'],
  }),
  seuratUmap: Object.freeze({
    moduleKey: 'seuratUmap',
    routeId: 'umap',
    componentKey: 'umap',
    defaultLabel: 'UMAP',
    jobType: 'seurat.umap.v1',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['integer', 'number'],
    resultArtifactTypes: ['umap_summary'],
    resultViewTemplates: ['plotlyEmbedding', 'summaryMetrics', 'jobLogs'],
  }),
  featurePlot: Object.freeze({
    moduleKey: 'featurePlot',
    routeId: 'featureplot',
    componentKey: 'featurePlot',
    defaultLabel: 'Feature Plot',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['geneList', 'metadataColumn'],
    resultViewTemplates: ['plotlyEmbedding'],
  }),
  geneExpression: Object.freeze({
    moduleKey: 'geneExpression',
    routeId: 'geneviewer',
    componentKey: 'geneViewer',
    defaultLabel: 'Gene Expression',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['geneList', 'metadataColumn'],
    resultViewTemplates: ['plotlyScatter', 'summaryMetrics'],
  }),
  heatmap: Object.freeze({
    moduleKey: 'heatmap',
    routeId: 'heatmap',
    componentKey: 'heatmap',
    defaultLabel: 'Heatmap',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['geneList', 'clusterSelector'],
    resultViewTemplates: ['plotlyHeatmap'],
  }),
  dotPlot: Object.freeze({
    moduleKey: 'dotPlot',
    routeId: 'dotplot',
    componentKey: 'dotPlot',
    defaultLabel: 'Dot Plot',
    executable: false,
    requiresObject: true,
    parameterTemplates: ['geneList', 'clusterSelector'],
    resultViewTemplates: ['plotlyDotPlot'],
  }),
  differentialExpression: Object.freeze({
    moduleKey: 'differentialExpression',
    routeId: 'deg',
    componentKey: 'differentialExpression',
    defaultLabel: 'Markers / DEG',
    jobType: 'deg.find_markers.v1',
    executable: true,
    requiresObject: true,
    parameterTemplates: ['enum', 'number', 'integer', 'boolean'],
    resultArtifactTypes: ['deg_summary', 'deg_markers'],
    resultViewTemplates: ['summaryMetrics', 'artifactTable', 'jobLogs'],
  }),
  projectHistory: Object.freeze({
    moduleKey: 'projectHistory',
    routeId: 'history',
    componentKey: 'projectHistory',
    defaultLabel: 'Jobs & Artifacts',
    executable: false,
    requiresProject: true,
    resultViewTemplates: ['artifactTable', 'jobLogs'],
  }),
});

const UNSAFE_MANIFEST_FIELDS = Object.freeze([
  'code',
  'rCode',
  'script',
  'command',
  'shell',
  'endpoint',
  'path',
  'url',
  'method',
  'storageKey',
  'storageUri',
  'stateKey',
  'icon',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
}

function assertNoUnsafeFields(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const field of UNSAFE_MANIFEST_FIELDS) {
    if (hasOwn(value, field)) {
      throw new Error(`${label}.${field} is not allowed in a pipeline manifest.`);
    }
  }
}

function validateParameterSchema(schema, label) {
  if (schema === undefined) return [];
  if (!Array.isArray(schema)) throw new Error(`${label}.parameterSchema must be an array.`);
  return schema.map((param, index) => {
    assertPlainObject(param, `${label}.parameterSchema[${index}]`);
    assertNoUnsafeFields(param, `${label}.parameterSchema[${index}]`);
    if (!TAB_ID_RE.test(param.key || '')) {
      throw new Error(`${label}.parameterSchema[${index}].key must be a slug-safe identifier.`);
    }
    if (!PARAMETER_TEMPLATE_TYPES.includes(param.type)) {
      throw new Error(`${label}.parameterSchema[${index}].type is not a supported parameter template.`);
    }
    if (param.label !== undefined && (typeof param.label !== 'string' || param.label.length > 80)) {
      throw new Error(`${label}.parameterSchema[${index}].label must be a short string.`);
    }
    if (param.type === 'enum') {
      if (!Array.isArray(param.options) || param.options.length === 0 || param.options.length > 40) {
        throw new Error(`${label}.parameterSchema[${index}].options must be a non-empty bounded array.`);
      }
      for (const option of param.options) {
        if (typeof option !== 'string' && typeof option !== 'number' && typeof option !== 'boolean') {
          throw new Error(`${label}.parameterSchema[${index}].options may only contain scalar values.`);
        }
      }
    }
    return clone(param);
  });
}

function validateResultViews(views, label, moduleDef) {
  if (views === undefined) return moduleDef.resultViewTemplates || [];
  if (!Array.isArray(views) || views.length === 0 || views.length > 12) {
    throw new Error(`${label}.resultViews must be a non-empty bounded array.`);
  }
  return views.map((view, index) => {
    const type = typeof view === 'string' ? view : view?.type;
    if (!RESULT_VIEW_TEMPLATES.includes(type)) {
      throw new Error(`${label}.resultViews[${index}] is not a supported result view template.`);
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
    throw new Error(`${label}.resultArtifactTypes must be a bounded array.`);
  }
  const allowed = new Set(moduleDef.resultArtifactTypes || []);
  return types.map((type, index) => {
    if (typeof type !== 'string' || !allowed.has(type)) {
      throw new Error(`${label}.resultArtifactTypes[${index}] is not produced by the registered module.`);
    }
    return type;
  });
}

export function validatePipelineManifest(input) {
  assertPlainObject(input, 'manifest');
  assertNoUnsafeFields(input, 'manifest');

  if (input.schemaVersion !== 1) {
    throw new Error('manifest.schemaVersion must be 1.');
  }
  if (!PIPELINE_ID_RE.test(input.id || '')) {
    throw new Error('manifest.id must be a slug-safe identifier.');
  }
  if (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.length > 100) {
    throw new Error('manifest.name must be a short string.');
  }
  if (input.modality !== undefined && !['scrna', 'spatial', 'multiomics', 'generic'].includes(input.modality)) {
    throw new Error('manifest.modality is not supported.');
  }
  if (!Array.isArray(input.tabs) || input.tabs.length === 0 || input.tabs.length > MAX_TABS) {
    throw new Error(`manifest.tabs must contain 1-${MAX_TABS} tabs.`);
  }

  const seen = new Set();
  const tabs = input.tabs.map((tab, index) => {
    assertPlainObject(tab, `manifest.tabs[${index}]`);
    assertNoUnsafeFields(tab, `manifest.tabs[${index}]`);
    if (!TAB_ID_RE.test(tab.id || '')) {
      throw new Error(`manifest.tabs[${index}].id must be a slug-safe identifier.`);
    }
    if (seen.has(tab.id)) throw new Error(`Duplicate pipeline tab id '${tab.id}'.`);
    seen.add(tab.id);

    const moduleDef = PIPELINE_MODULES[tab.moduleKey];
    if (!moduleDef) throw new Error(`manifest.tabs[${index}].moduleKey is not registered.`);
    if (tab.id !== moduleDef.routeId) {
      throw new Error(`manifest.tabs[${index}].id must be '${moduleDef.routeId}' for module '${moduleDef.moduleKey}'.`);
    }
    if (tab.componentKey !== undefined && tab.componentKey !== moduleDef.componentKey) {
      throw new Error(`manifest.tabs[${index}].componentKey does not match the registered module.`);
    }
    if (tab.jobType !== undefined && tab.jobType !== moduleDef.jobType) {
      throw new Error(`manifest.tabs[${index}].jobType does not match the registered module.`);
    }
    if (typeof tab.label !== 'string' || tab.label.trim().length < 2 || tab.label.length > 80) {
      throw new Error(`manifest.tabs[${index}].label must be a short string.`);
    }

    return {
      id: tab.id,
      label: tab.label.trim(),
      moduleKey: moduleDef.moduleKey,
      routeId: moduleDef.routeId,
      componentKey: moduleDef.componentKey,
      jobType: moduleDef.jobType || null,
      executable: moduleDef.executable === true,
      executableNow: moduleDef.executable === true,
      requiresObject: moduleDef.requiresObject === true,
      requiresProject: moduleDef.requiresProject === true,
      optional: tab.optional === true || moduleDef.optional === true,
      parameterSchema: validateParameterSchema(tab.parameterSchema, `manifest.tabs[${index}]`),
      resultArtifactTypes: validateResultArtifactTypes(tab.resultArtifactTypes, `manifest.tabs[${index}]`, moduleDef),
      resultViews: validateResultViews(tab.resultViews, `manifest.tabs[${index}]`, moduleDef),
    };
  });

  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name.trim(),
    description: typeof input.description === 'string' ? input.description.slice(0, 400) : '',
    modality: input.modality || 'scrna',
    builtin: input.builtin === true,
    tabs,
  };
}

export const DEFAULT_SEURAT_PIPELINE = validatePipelineManifest({
  schemaVersion: 1,
  id: DEFAULT_PIPELINE_ID,
  name: 'Default Seurat scRNA-seq Pipeline',
  description: 'Dataset-backed Seurat preprocessing, exploration, DEG, and project history using registered modules.',
  modality: 'scrna',
  builtin: true,
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

export function getDefaultPipelineManifest() {
  return clone(DEFAULT_SEURAT_PIPELINE);
}

export function resolvePipelineManifest(manifest) {
  if (!manifest || manifest.id === DEFAULT_PIPELINE_ID) return getDefaultPipelineManifest();
  return validatePipelineManifest(manifest);
}

export function buildPipelineSidebarSections(manifest, pipelineState = {}) {
  const safeManifest = resolvePipelineManifest(manifest);
  const exploreModuleKeys = new Set(['featurePlot', 'geneExpression', 'heatmap', 'dotPlot']);
  const outputModuleKeys = new Set(['differentialExpression', 'projectHistory']);
  const mainTabs = safeManifest.tabs.filter(tab => !exploreModuleKeys.has(tab.moduleKey) && !outputModuleKeys.has(tab.moduleKey));
  const exploreTabs = safeManifest.tabs.filter(tab => exploreModuleKeys.has(tab.moduleKey));
  const outputTabs = safeManifest.tabs.filter(tab => outputModuleKeys.has(tab.moduleKey));

  const toItem = tab => ({
    id: tab.id,
    label: tab.label,
    done: Boolean(pipelineState?.[tab.id]),
    status: tab.executable && !tab.executableNow ? 'Module pending' : undefined,
    requiresObject: tab.requiresObject,
    requiresProject: tab.requiresProject,
  });

  return [
    { id: 'pipeline-main', label: safeManifest.name, items: mainTabs.map(toItem) },
    { id: 'pipeline-explore', label: 'Explore', items: exploreTabs.map(toItem) },
    { id: 'pipeline-results', label: 'Results', items: outputTabs.map(toItem) },
  ].filter(section => section.items.length > 0);
}
