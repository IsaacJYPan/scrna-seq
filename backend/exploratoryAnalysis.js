'use strict';

const { codedError } = require('./codedError');

const EXPLORATORY_ANALYSIS_RECIPES = Object.freeze([
  'figure_qc','figure_pca','figure_umap','figure_heatmap','figure_dot','figure_feature',
  'overview',
  'feature_by_group',
  'metadata_distribution',
  'study_composition','study_expression','study_qc','study_de','study_pathways','study_communication',
]);
const EXPLORATORY_ANALYSIS_PARAM_NAMES = Object.freeze([
  'recipe',
  'features',
  'groupBy',
  'metadataField',
  'maxGroups',
  'histogramBins',
  'featureNames',
  'groupMap',
  'conditionName',
  'contrastId',
  'targetGroup',
  'species',
]);
// Recipes that test a condition contrast. They run on a person-registered
// contrast (resolved and pinned server side), never on labels in cell metadata.
const CONTRAST_RECIPES = Object.freeze(['study_de', 'study_pathways']);
// Recipes that use an organism's annotation (GO, ligand-receptor databases).
// The organism is never assumed.
const SPECIES_RECIPES = Object.freeze(['study_pathways', 'study_communication']);
const SPECIES = Object.freeze(['human', 'mouse']);

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
  for (const [name, kind] of [
    ['featureNames', 'geneList'],
    ['groupMap', 'groupMap']
  ])
    if (raw[name] !== undefined) params[name] = require('./scientificChoices').scientificText(kind, raw[name]);
  for (const name of ['conditionName', 'targetGroup'])
    if (raw[name] !== undefined) {
      if (typeof raw[name] !== 'string' || (raw[name] !== '' && !/^[A-Za-z0-9_.-]{1,80}$/.test(raw[name])))
        throw codedError('INVALID_PARAMETER', `Invalid ${name}.`);
      params[name] = raw[name];
    }
  if (CONTRAST_RECIPES.includes(recipe)) {
    if (typeof raw.contrastId !== 'string' || !/^contrast_[a-f0-9]+$/.test(raw.contrastId)) {
      throw codedError('INVALID_PARAMETER', `${recipe} requires contrastId, a registered condition contrast.`);
    }
    params.contrastId = raw.contrastId;
  } else if (raw.contrastId !== undefined) {
    throw codedError('INVALID_PARAMETER', `contrastId applies only to ${CONTRAST_RECIPES.join(' and ')}.`);
  }
  if (SPECIES_RECIPES.includes(recipe)) {
    if (!SPECIES.includes(raw.species)) {
      throw codedError('INVALID_PARAMETER', `${recipe} requires species: ${SPECIES.join(' or ')}.`);
    }
    params.species = raw.species;
  } else if (raw.species !== undefined) {
    throw codedError('INVALID_PARAMETER', `species applies only to ${SPECIES_RECIPES.join(' and ')}.`);
  }

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
  CONTRAST_RECIPES,
  SPECIES_RECIPES,
  EXPLORATORY_ANALYSIS_RECIPES,
  EXPLORATORY_ANALYSIS_PARAM_NAMES,
  validateExploratoryAnalysisParams,
};
