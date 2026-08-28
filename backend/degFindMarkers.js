// Strict parameter validation and server-owned result-key allocation for
// `deg.find_markers.v1`. Values reach R only as typed, allowlisted arguments;
// storage paths are derived from server-generated identifiers.

const { projectStorageFileKey } = require('./storage');

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The validator records defaults so every durable run retains its resolved inputs.
const DEG_FIND_MARKERS_PARAM_SPEC = Object.freeze({
  groupBy:              { type: 'enum', values: ['seurat_clusters', 'ident'], default: 'seurat_clusters' },
  assay:                { type: 'enum', values: ['RNA', 'SCT'],               default: 'RNA' },
  onlyPositive:         { type: 'bool',                                       default: true },
  minPct:               { type: 'number', min: 0,  max: 1,                    default: 0.1 },
  logfcThreshold:       { type: 'number', min: 0,  max: 10,                   default: 0.25 },
  testUse:              { type: 'enum', values: ['wilcox'],                   default: 'wilcox' },
  maxCellsPerIdent:     { type: 'intOrNull', min: 1, max: 100000,             default: null },
  randomSeed:           { type: 'intOrNull', min: 0, max: 2147483647,         default: null },
  topMarkersPerCluster: { type: 'int', min: 5, max: 50,                       default: 10 },
});

const DEG_FIND_MARKERS_PARAM_NAMES = Object.freeze(Object.keys(DEG_FIND_MARKERS_PARAM_SPEC));

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
  if (spec.type === 'bool') {
    if (typeof raw !== 'boolean') {
      throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a boolean.`);
    }
    return raw;
  }
  if (spec.type === 'intOrNull' && raw === null) {
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

function validateDegFindMarkersParams(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (!isPlainObject(raw)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }

  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DEG_FIND_MARKERS_PARAM_SPEC, key)) {
      throw codedError('UNKNOWN_PARAMETER', `Unknown parameter '${key}'.`);
    }
  }

  const params = {};
  const defaultsApplied = [];
  for (const name of DEG_FIND_MARKERS_PARAM_NAMES) {
    const spec = DEG_FIND_MARKERS_PARAM_SPEC[name];
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

function allocateDegResultStorageKey(projectId, jobId) {
  if (jobId === undefined) {
    jobId = projectId;
    projectId = null;
  }
  if (typeof jobId !== 'string' || !_JOB_ID_RE.test(jobId)) {
    throw codedError('INVALID_JOB_ID', 'A server-generated job id is required to allocate a DEG result key.');
  }
  if (projectId) {
    return projectStorageFileKey(String(projectId), 'artifacts', jobId, 'markers.csv');
  }
  return `vault/deg/${jobId}/markers.csv`;
}

module.exports = {
  DEG_FIND_MARKERS_PARAM_SPEC,
  DEG_FIND_MARKERS_PARAM_NAMES,
  validateDegFindMarkersParams,
  allocateDegResultStorageKey,
};
