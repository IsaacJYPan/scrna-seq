'use strict';

const CONTRACT = require('../shared/pipelineRegistryContract.json');

const DEFAULT_PIPELINE_ID = CONTRACT.defaultPipelineId;
const MODULES = Object.freeze(CONTRACT.modules);
const PARAMETER_TEMPLATE_TYPES = Object.freeze([...CONTRACT.parameterTemplateTypes]);
const RESULT_VIEW_TEMPLATES = Object.freeze([...CONTRACT.resultViewTemplates]);
const PIPELINE_ID_RE = /^[a-z][a-z0-9-]{2,63}$/;
const TAB_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

const MANIFEST_FIELDS = new Set(['schemaVersion', 'id', 'name', 'description', 'modality', 'tabs']);
const TAB_FIELDS = new Set([
  'id', 'label', 'moduleKey', 'optional', 'parameterSchema',
  'resultArtifactTypes', 'resultViews',
]);
const COMMON_PARAMETER_FIELDS = ['key', 'type', 'label', 'description', 'required'];
const PARAMETER_FIELDS = Object.freeze({
  boolean: new Set([...COMMON_PARAMETER_FIELDS, 'default']),
  number: new Set([...COMMON_PARAMETER_FIELDS, 'default', 'min', 'max', 'step']),
  integer: new Set([...COMMON_PARAMETER_FIELDS, 'default', 'min', 'max', 'step']),
  enum: new Set([...COMMON_PARAMETER_FIELDS, 'default', 'options']),
  text: new Set([...COMMON_PARAMETER_FIELDS, 'default', 'placeholder', 'maxLength']),
});
const RESULT_VIEW_FIELDS = new Set(['type', 'title', 'artifactType']);

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function invalid(message) {
  throw codedError('INVALID_PIPELINE_MANIFEST', message);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object.`);
  }
}

function assertExactFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) invalid(`${label}.${field} is not allowed.`);
  }
}

function assertShortString(value, label, max, { min = 1 } = {}) {
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length < min || value.length > max) {
    invalid(`${label} must contain ${min}-${max} characters.`);
  }
  return trimmed;
}

function assertFiniteNumber(value, label, { integer = false, positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${label} must be a finite ${integer ? 'integer' : 'number'}.`);
  }
  if (integer && !Number.isInteger(value)) invalid(`${label} must be an integer.`);
  if (positive && value <= 0) invalid(`${label} must be positive.`);
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertManifestByteLimit(input) {
  let encoded;
  try {
    encoded = JSON.stringify(input);
  } catch {
    invalid('manifest must be JSON serializable.');
  }
  if (typeof encoded !== 'string'
      || Buffer.byteLength(encoded, 'utf8') > CONTRACT.limits.maxManifestBytes) {
    invalid(`manifest exceeds the ${CONTRACT.limits.maxManifestBytes}-byte limit.`);
  }
}

function validateParameterDefault(param, output, label) {
  if (param.default === undefined) return;
  switch (param.type) {
    case 'boolean':
      if (typeof param.default !== 'boolean') invalid(`${label}.default must be boolean.`);
      output.default = param.default;
      break;
    case 'number':
    case 'integer':
      output.default = assertFiniteNumber(param.default, `${label}.default`, {
        integer: param.type === 'integer',
      });
      break;
    case 'enum':
      if (typeof param.default !== 'string' || !output.options.includes(param.default)) {
        invalid(`${label}.default must match one of the enum options.`);
      }
      output.default = param.default;
      break;
    case 'text':
      if (typeof param.default !== 'string' || param.default.length > output.maxLength) {
        invalid(`${label}.default exceeds the text limit.`);
      }
      output.default = param.default;
      break;
    default:
      invalid(`${label}.type is not supported.`);
  }
}

function validateParameterSchema(schema, label, moduleDef) {
  if (schema === undefined) return [];
  if (!Array.isArray(schema) || schema.length > CONTRACT.limits.maxParametersPerTab) {
    invalid(`${label}.parameterSchema must contain at most ${CONTRACT.limits.maxParametersPerTab} parameters.`);
  }
  const seen = new Set();
  return schema.map((param, index) => {
    const paramLabel = `${label}.parameterSchema[${index}]`;
    assertPlainObject(param, paramLabel);
    if (!PARAMETER_TEMPLATE_TYPES.includes(param.type)
        || !(moduleDef.parameterTemplates || []).includes(param.type)) {
      invalid(`${paramLabel}.type is not registered for this module.`);
    }
    assertExactFields(param, PARAMETER_FIELDS[param.type], paramLabel);
    if (!TAB_ID_RE.test(param.key || '')) {
      invalid(`${paramLabel}.key must be a slug-safe identifier.`);
    }
    if (seen.has(param.key)) invalid(`${paramLabel}.key is duplicated.`);
    seen.add(param.key);
    if (param.required !== undefined && typeof param.required !== 'boolean') {
      invalid(`${paramLabel}.required must be boolean.`);
    }

    const output = {
      key: param.key,
      type: param.type,
      label: param.label === undefined
        ? param.key
        : assertShortString(param.label, `${paramLabel}.label`, 80),
      description: param.description === undefined
        ? ''
        : assertShortString(param.description, `${paramLabel}.description`, 240, { min: 0 }),
      required: param.required === true,
    };

    if (param.type === 'number' || param.type === 'integer') {
      const integer = param.type === 'integer';
      for (const field of ['min', 'max']) {
        if (param[field] !== undefined) {
          output[field] = assertFiniteNumber(param[field], `${paramLabel}.${field}`, { integer });
        }
      }
      if (output.min !== undefined && output.max !== undefined && output.min > output.max) {
        invalid(`${paramLabel}.min must not exceed max.`);
      }
      if (param.step !== undefined) {
        output.step = assertFiniteNumber(param.step, `${paramLabel}.step`, { integer, positive: true });
      }
    } else if (param.type === 'enum') {
      if (!Array.isArray(param.options) || param.options.length === 0
          || param.options.length > CONTRACT.limits.maxEnumOptions) {
        invalid(`${paramLabel}.options must be a non-empty bounded array.`);
      }
      const options = param.options.map((option, optionIndex) =>
        assertShortString(option, `${paramLabel}.options[${optionIndex}]`, 80));
      if (new Set(options).size !== options.length) invalid(`${paramLabel}.options must be unique.`);
      output.options = options;
    } else if (param.type === 'text') {
      const maxLength = param.maxLength === undefined ? 240 : param.maxLength;
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > CONTRACT.limits.maxTextLength) {
        invalid(`${paramLabel}.maxLength must be an integer between 1 and ${CONTRACT.limits.maxTextLength}.`);
      }
      output.maxLength = maxLength;
      if (param.placeholder !== undefined) {
        output.placeholder = assertShortString(param.placeholder, `${paramLabel}.placeholder`, 120, { min: 0 });
      }
    }

    validateParameterDefault(param, output, paramLabel);
    if ((param.type === 'number' || param.type === 'integer') && output.default !== undefined) {
      if (output.min !== undefined && output.default < output.min) invalid(`${paramLabel}.default is below min.`);
      if (output.max !== undefined && output.default > output.max) invalid(`${paramLabel}.default exceeds max.`);
    }
    return output;
  });
}

function validateResultArtifactTypes(types, label, moduleDef) {
  const source = types === undefined ? (moduleDef.resultArtifactTypes || []) : types;
  if (!Array.isArray(source) || source.length > CONTRACT.limits.maxArtifactTypesPerTab) {
    invalid(`${label}.resultArtifactTypes must be a bounded array.`);
  }
  const allowed = new Set(moduleDef.resultArtifactTypes || []);
  const output = source.map((type, index) => {
    if (typeof type !== 'string' || !allowed.has(type)) {
      invalid(`${label}.resultArtifactTypes[${index}] is not produced by the registered module.`);
    }
    return type;
  });
  if (new Set(output).size !== output.length) invalid(`${label}.resultArtifactTypes must be unique.`);
  return output;
}

function validateResultViews(views, label, moduleDef, artifactTypes) {
  const source = views === undefined ? (moduleDef.resultViewTemplates || []) : views;
  if (!Array.isArray(source) || source.length > CONTRACT.limits.maxResultViewsPerTab) {
    invalid(`${label}.resultViews must be a bounded array.`);
  }
  const moduleViews = new Set(moduleDef.resultViewTemplates || []);
  const allowedArtifacts = new Set(artifactTypes);
  return source.map((view, index) => {
    const viewLabel = `${label}.resultViews[${index}]`;
    const type = typeof view === 'string' ? view : view?.type;
    if (!RESULT_VIEW_TEMPLATES.includes(type) || !moduleViews.has(type)) {
      invalid(`${viewLabel} is not registered for this module.`);
    }
    if (typeof view === 'string') return type;
    assertPlainObject(view, viewLabel);
    assertExactFields(view, RESULT_VIEW_FIELDS, viewLabel);
    const output = { type };
    if (view.title !== undefined) {
      output.title = assertShortString(view.title, `${viewLabel}.title`, 80);
    }
    if (view.artifactType !== undefined) {
      if (typeof view.artifactType !== 'string' || !allowedArtifacts.has(view.artifactType)) {
        invalid(`${viewLabel}.artifactType is not available from this module.`);
      }
      output.artifactType = view.artifactType;
    }
    return output;
  });
}

function validatePipelineManifest(input, options = {}) {
  assertPlainObject(input, 'manifest');
  assertManifestByteLimit(input);
  assertExactFields(input, MANIFEST_FIELDS, 'manifest');
  if (input.schemaVersion !== CONTRACT.schemaVersion) {
    invalid(`manifest.schemaVersion must be ${CONTRACT.schemaVersion}.`);
  }
  if (!PIPELINE_ID_RE.test(input.id || '')) {
    invalid('manifest.id must be a slug-safe identifier.');
  }
  if (input.id === DEFAULT_PIPELINE_ID && options.allowBuiltInId !== true) {
    invalid('manifest.id is reserved for the built-in pipeline.');
  }
  const name = assertShortString(input.name, 'manifest.name', 100, { min: 2 });
  const description = input.description === undefined
    ? ''
    : assertShortString(input.description, 'manifest.description', 400, { min: 0 });
  const modality = input.modality === undefined ? 'scrna' : input.modality;
  if (!CONTRACT.modalities.includes(modality)) invalid('manifest.modality is not supported.');
  if (!Array.isArray(input.tabs) || input.tabs.length === 0
      || input.tabs.length > CONTRACT.limits.maxTabs) {
    invalid(`manifest.tabs must contain 1-${CONTRACT.limits.maxTabs} tabs.`);
  }

  const seen = new Set();
  const tabs = input.tabs.map((tab, index) => {
    const label = `manifest.tabs[${index}]`;
    assertPlainObject(tab, label);
    assertExactFields(tab, TAB_FIELDS, label);
    if (!TAB_ID_RE.test(tab.id || '')) invalid(`${label}.id must be a slug-safe identifier.`);
    if (seen.has(tab.id)) invalid(`Duplicate pipeline tab id '${tab.id}'.`);
    seen.add(tab.id);
    const moduleDef = MODULES[tab.moduleKey];
    if (!moduleDef) invalid(`${label}.moduleKey is not registered.`);
    if (tab.id !== moduleDef.routeId) {
      invalid(`${label}.id must be '${moduleDef.routeId}' for module '${tab.moduleKey}'.`);
    }
    if (tab.optional !== undefined && typeof tab.optional !== 'boolean') {
      invalid(`${label}.optional must be boolean.`);
    }
    const resultArtifactTypes = validateResultArtifactTypes(tab.resultArtifactTypes, label, moduleDef);
    return {
      id: tab.id,
      label: assertShortString(tab.label, `${label}.label`, 80, { min: 2 }),
      moduleKey: tab.moduleKey,
      optional: tab.optional === true || moduleDef.optional === true,
      parameterSchema: validateParameterSchema(tab.parameterSchema, label, moduleDef),
      resultArtifactTypes,
      resultViews: validateResultViews(tab.resultViews, label, moduleDef, resultArtifactTypes),
    };
  });

  return {
    schemaVersion: CONTRACT.schemaVersion,
    id: input.id,
    name,
    description,
    modality,
    tabs,
  };
}

const DEFAULT_SEURAT_PIPELINE = validatePipelineManifest({
  schemaVersion: CONTRACT.schemaVersion,
  id: DEFAULT_PIPELINE_ID,
  name: 'Default Seurat scRNA-seq Pipeline',
  description: 'Dataset-backed Seurat preprocessing, exploration, DEG, pathway enrichment, and project history using registered modules.',
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
    { id: 'enrichment', label: 'Pathway Enrichment', moduleKey: 'pathwayEnrichment' },
    { id: 'history', label: 'Jobs & Artifacts', moduleKey: 'projectHistory' },
  ],
}, { allowBuiltInId: true });

function getDefaultPipelineManifest() {
  return clone(DEFAULT_SEURAT_PIPELINE);
}

function isBuiltInPipelineId(id) {
  return id === DEFAULT_PIPELINE_ID;
}

module.exports = {
  CONTRACT,
  DEFAULT_PIPELINE_ID,
  MODULES,
  PARAMETER_TEMPLATE_TYPES,
  RESULT_VIEW_TEMPLATES,
  validatePipelineManifest,
  getDefaultPipelineManifest,
  isBuiltInPipelineId,
};
