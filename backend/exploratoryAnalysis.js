'use strict';

const EXPLORATORY_ANALYSIS_RECIPES = Object.freeze([
  'overview',
  'feature_by_group',
  'metadata_distribution',
]);
const EXPLORATORY_ANALYSIS_PARAM_NAMES = Object.freeze([
  'recipe',
  'features',
  'groupBy',
  'metadataField',
  'maxGroups',
  'histogramBins',
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requirePlainObject(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw codedError('INVALID_PARAMETER', 'Exploratory-analysis parameters must be an object.');
  }
  return value;
}

function boundedInteger(value, name, fallback, min, max) {
  const resolved = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw codedError('INVALID_PARAMETER', `${name} must be an integer between ${min} and ${max}.`);
  }
  return resolved;
}

function safeFieldName(value, name) {
  if (typeof value !== 'string') {
    throw codedError('INVALID_PARAMETER', `${name} must be a metadata field name.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    throw codedError('INVALID_PARAMETER', `${name} contains unsupported characters.`);
  }
  return trimmed;
}

function validateExploratoryAnalysisParams(input) {
  const raw = requirePlainObject(input);
  const unknown = Object.keys(raw).filter((key) => !EXPLORATORY_ANALYSIS_PARAM_NAMES.includes(key));
  if (unknown.length > 0) {
    throw codedError('UNKNOWN_PARAMETER', `Unknown exploratory-analysis parameter: ${unknown[0]}.`);
  }

  const recipe = raw.recipe === undefined ? 'overview' : String(raw.recipe).trim();
  if (!EXPLORATORY_ANALYSIS_RECIPES.includes(recipe)) {
    throw codedError('INVALID_PARAMETER', 'recipe must be overview, feature_by_group, or metadata_distribution.');
  }

  const params = {
    recipe,
    maxGroups: boundedInteger(raw.maxGroups, 'maxGroups', 24, 2, 32),
    histogramBins: boundedInteger(raw.histogramBins, 'histogramBins', 24, 8, 50),
  };

  if (recipe === 'feature_by_group') {
    if (!Array.isArray(raw.features) || raw.features.length < 1 || raw.features.length > 12) {
      throw codedError('INVALID_PARAMETER', 'feature_by_group requires 1-12 feature names.');
    }
    params.features = [...new Set(raw.features.map((value) => safeFieldName(value, 'features')))].slice(0, 12);
    params.groupBy = raw.groupBy === undefined ? 'seurat_clusters' : String(raw.groupBy).trim();
    if (!['seurat_clusters', 'ident'].includes(params.groupBy)) {
      throw codedError('INVALID_PARAMETER', 'groupBy must be seurat_clusters or ident.');
    }
  } else if (recipe === 'metadata_distribution') {
    params.metadataField = safeFieldName(raw.metadataField, 'metadataField');
  }

  return Object.freeze({ params: Object.freeze(params) });
}

module.exports = {
  EXPLORATORY_ANALYSIS_RECIPES,
  EXPLORATORY_ANALYSIS_PARAM_NAMES,
  validateExploratoryAnalysisParams,
};
