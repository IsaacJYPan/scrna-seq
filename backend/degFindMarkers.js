// Strict parameter validation and server-owned result-key allocation for
// `deg.find_markers.v1`. Values reach R only as typed, allowlisted arguments;
// storage paths are derived from server-generated identifiers.

const { projectStorageFileKey } = require('./storage');
const { codedError } = require('./codedError');
const { validateParamsAgainstSpec } = require('./paramSpec');

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

function validateDegFindMarkersParams(input) {
  return validateParamsAgainstSpec(input, DEG_FIND_MARKERS_PARAM_SPEC, DEG_FIND_MARKERS_PARAM_NAMES);
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
