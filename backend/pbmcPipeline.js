// Strict parameter validation and server-owned checkpoint-key allocation for
// `pbmc.pipeline.v1`. Values reach R only as typed, allowlisted arguments;
// storage paths are derived from server-generated identifiers.

const { projectStorageFileKey } = require('./storage');
const { codedError } = require('./codedError');
const { validateParamsAgainstSpec } = require('./paramSpec');

// The validator records defaults so every durable run retains its resolved inputs.
const PBMC_PIPELINE_PARAM_SPEC = Object.freeze({
  normalizationMethod: { type: 'enum', values: ['LogNormalize', 'SCTransform'], default: 'LogNormalize' },
  scaleFactor:        { type: 'int',    min: 1,    max: 10000000, default: 10000 },
  variableFeatures:   { type: 'int',    min: 50,   max: 10000,    default: 2000 },
  pcaDims:            { type: 'int',    min: 2,    max: 100,      default: 50 },
  clusterDims:        { type: 'int',    min: 2,    max: 100,      default: 15 },
  clusterResolution:  { type: 'number', min: 0.01, max: 10,       default: 0.8 },
  umapDims:           { type: 'int',    min: 2,    max: 100,      default: 15 },
  umapComponents:     { type: 'enum',   values: [2, 3],           default: 2 },
  umapNeighbors:      { type: 'int',    min: 2,    max: 200,      default: 30 },
  umapMinDist:        { type: 'number', min: 0,    max: 1,        default: 0.3 },
  seed:               { type: 'int', min: 0, max: 2147483647, default: 42, nullMeansDefault: true },
});

const PBMC_PIPELINE_PARAM_NAMES = Object.freeze(Object.keys(PBMC_PIPELINE_PARAM_SPEC));

function validatePbmcPipelineParams(input) {
  return validateParamsAgainstSpec(input, PBMC_PIPELINE_PARAM_SPEC, PBMC_PIPELINE_PARAM_NAMES);
}

const _JOB_ID_RE = /^job_[0-9a-f]+$/;

function allocateCheckpointStorageKey(projectId, jobId) {
  if (jobId === undefined) {
    jobId = projectId;
    projectId = null;
  }
  if (typeof jobId !== 'string' || !_JOB_ID_RE.test(jobId)) {
    throw codedError('INVALID_JOB_ID', 'A server-generated job id is required to allocate a checkpoint key.');
  }
  if (projectId) {
    return projectStorageFileKey(String(projectId), 'checkpoints', jobId, 'checkpoint.rds');
  }
  return `vault/checkpoints/${jobId}/checkpoint.rds`;
}

module.exports = {
  PBMC_PIPELINE_PARAM_SPEC,
  PBMC_PIPELINE_PARAM_NAMES,
  validatePbmcPipelineParams,
  allocateCheckpointStorageKey,
};
