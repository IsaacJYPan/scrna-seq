// Dataset-backed Seurat pipeline v1: strict parameter validation + storage keys.
//
// This is deliberately narrow: v1 supports uploaded 10x Genomics HDF5 datasets
// (`tenx_h5`) only. Dataset identity/storage is resolved from trusted DB rows by
// the worker; clients never provide paths or storage keys.

const { isProjectStorageKey, projectStorageFileKey } = require('./storage');

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const SEURAT_PIPELINE_PARAM_SPEC = Object.freeze({
  minCells:          { type: 'int', min: 0, max: 10000, default: 3 },
  minFeatures:       { type: 'int', min: 0, max: 100000, default: 200 },
  applyQcFilter:     { type: 'bool', default: true },
  minFeaturesFilter: { type: 'int', min: 0, max: 100000, default: 200 },
  maxFeaturesFilter: { type: 'int', min: 1, max: 1000000, default: 2500 },
  maxPercentMt:      { type: 'number', min: 0, max: 100, default: 5 },
  normalizationMethod: { type: 'enum', values: ['LogNormalize', 'SCTransform'], default: 'LogNormalize' },
  scaleFactor:       { type: 'int', min: 1, max: 10000000, default: 10000 },
  variableFeatures:  { type: 'int', min: 50, max: 10000, default: 2000 },
  pcaDims:           { type: 'int', min: 2, max: 100, default: 50 },
  clusterDims:       { type: 'int', min: 2, max: 100, default: 15 },
  clusterResolution: { type: 'number', min: 0.01, max: 10, default: 0.8 },
  umapDims:          { type: 'int', min: 2, max: 100, default: 15 },
  umapComponents:    { type: 'enum', values: [2, 3], default: 2 },
  umapNeighbors:     { type: 'int', min: 2, max: 200, default: 30 },
  umapMinDist:       { type: 'number', min: 0, max: 1, default: 0.3 },
  seed:              { type: 'intOrNull', min: 0, max: 2147483647, default: null },
});

const SEURAT_PIPELINE_PARAM_NAMES = Object.freeze(Object.keys(SEURAT_PIPELINE_PARAM_SPEC));
const SEURAT_PIPELINE_SUPPORTED_DATASET_TYPES = Object.freeze(['tenx_h5']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateOne(name, spec, raw) {
  if (spec.type === 'enum') {
    if (!spec.values.includes(raw)) {
      throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be one of: ${spec.values.join(', ')}.`);
    }
    return raw;
  }
  if (spec.type === 'bool') {
    if (typeof raw !== 'boolean') {
      throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a boolean.`);
    }
    return raw;
  }
  if (spec.type === 'intOrNull' && raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a finite number.`);
  }
  if ((spec.type === 'int' || spec.type === 'intOrNull') && !Number.isInteger(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be an integer.`);
  }
  if (raw < spec.min || raw > spec.max) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be between ${spec.min} and ${spec.max}.`);
  }
  return raw;
}

function validateSeuratPipelineParams(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (!isPlainObject(raw)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(SEURAT_PIPELINE_PARAM_SPEC, key)) {
      throw codedError('UNKNOWN_PARAMETER', `Unknown parameter '${key}'.`);
    }
  }
  const params = {};
  const defaultsApplied = [];
  for (const name of SEURAT_PIPELINE_PARAM_NAMES) {
    const spec = SEURAT_PIPELINE_PARAM_SPEC[name];
    if (!Object.prototype.hasOwnProperty.call(raw, name) || raw[name] === undefined) {
      params[name] = spec.default;
      defaultsApplied.push(name);
    } else {
      params[name] = validateOne(name, spec, raw[name]);
    }
  }
  if (params.applyQcFilter && params.minFeaturesFilter > params.maxFeaturesFilter) {
    throw codedError('INVALID_PARAMETER', "Parameter 'minFeaturesFilter' must be <= 'maxFeaturesFilter'.");
  }
  return { params, defaultsApplied };
}

function allocateSeuratCheckpointStorageKey(projectId, jobId) {
  if (jobId === undefined) {
    jobId = projectId;
    projectId = null;
  }
  if (typeof jobId !== 'string' || !/^job_[0-9a-f]+$/.test(jobId)) {
    throw codedError('INVALID_JOB_ID', 'A server-generated job id is required to allocate a checkpoint key.');
  }
  if (projectId) {
    return projectStorageFileKey(String(projectId), 'checkpoints', jobId, 'checkpoint.rds');
  }
  return `vault/checkpoints/${jobId}/checkpoint.rds`;
}

function assertSupportedSeuratPipelineDataset(dataset) {
  if (!dataset || typeof dataset !== 'object') {
    throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
  }
  if (!SEURAT_PIPELINE_SUPPORTED_DATASET_TYPES.includes(dataset.fileType)) {
    throw codedError('INVALID_PARAMETERS', 'seurat.pipeline.v1 supports uploaded 10x HDF5 datasets only.');
  }
  if (dataset.uploadStatus !== 'uploaded' || dataset.validationStatus === 'invalid') {
    throw codedError('INVALID_PARAMETERS', 'Dataset is not ready for seurat.pipeline.v1.');
  }
  if (typeof dataset.internalStorageKey !== 'string' || dataset.internalStorageKey === '') {
    throw codedError('INVALID_PARAMETERS', 'Dataset storage is not available for seurat.pipeline.v1.');
  }
  const isLegacyVaultKey = /^vault\//.test(dataset.internalStorageKey);
  const isDurableProjectKey = dataset.projectId
    && isProjectStorageKey(dataset.internalStorageKey, {
      projectId: dataset.projectId,
      kind: 'datasets',
    });
  if (!isLegacyVaultKey && !isDurableProjectKey) {
    throw codedError('INVALID_PARAMETERS', 'Dataset storage is not in the expected project storage scope.');
  }
}

module.exports = {
  SEURAT_PIPELINE_PARAM_SPEC,
  SEURAT_PIPELINE_PARAM_NAMES,
  SEURAT_PIPELINE_SUPPORTED_DATASET_TYPES,
  validateSeuratPipelineParams,
  allocateSeuratCheckpointStorageKey,
  assertSupportedSeuratPipelineDataset,
};
