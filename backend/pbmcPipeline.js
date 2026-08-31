// Strict parameter validation and server-owned checkpoint-key allocation for
// `pbmc.pipeline.v1`. Values reach R only as typed, allowlisted arguments;
// storage paths are derived from server-generated identifiers.

const { projectStorageFileKey } = require('./storage');

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

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
  seed:               { type: 'intOrNull', min: 0, max: 2147483647, default: null },
});

const PBMC_PIPELINE_PARAM_NAMES = Object.freeze(Object.keys(PBMC_PIPELINE_PARAM_SPEC));

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateOne(name, spec, raw) {
  if (spec.type === 'enum') {
    if (!spec.values.includes(raw)) {
      throw codedError('INVALID_PARAMETER',
        `Parameter '${name}' must be one of: ${spec.values.join(', ')}.`);
    }
    return raw;
  }
  if (spec.type === 'intOrNull' && (raw === null)) {
    return null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a finite number.`);
  }
  if (spec.type === 'int' || spec.type === 'intOrNull') {
    if (!Number.isInteger(raw)) {
      throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be an integer.`);
    }
  }
  if (raw < spec.min || raw > spec.max) {
    throw codedError('INVALID_PARAMETER',
      `Parameter '${name}' must be between ${spec.min} and ${spec.max}.`);
  }
  return raw;
}

function validatePbmcPipelineParams(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (!isPlainObject(raw)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }

  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(PBMC_PIPELINE_PARAM_SPEC, key)) {
      throw codedError('UNKNOWN_PARAMETER', `Unknown parameter '${key}'.`);
    }
  }

  const params = {};
  const defaultsApplied = [];
  for (const name of PBMC_PIPELINE_PARAM_NAMES) {
    const spec = PBMC_PIPELINE_PARAM_SPEC[name];
    if (!Object.prototype.hasOwnProperty.call(raw, name) || raw[name] === undefined) {
      params[name] = spec.default;
      defaultsApplied.push(name);
    } else {
      params[name] = validateOne(name, spec, raw[name]);
    }
  }
  return { params, defaultsApplied };
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
