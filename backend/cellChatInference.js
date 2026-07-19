'use strict';

// Pure validation and server-owned output-key allocation for the fixed,
// single-context `cellchat.infer.v1` worker job. This module intentionally has
// no R, database, or filesystem access: routes and workers use it to reject
// unsafe or scientifically ambiguous requests before any CellChat computation.

const { projectStorageFileKey } = require('./storage');

const CELLCHAT_INFERENCE_JOB_TYPE = 'cellchat.infer.v1';
// The R-side bounded extractor and every durable publication boundary use the
// same maximum. Keep this in the pure contract module so storage, worker, and
// response validation cannot silently drift apart.
const MAX_CELLCHAT_RESULT_ROWS = 50000;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function enumSpec(values, { required = false, defaultValue } = {}) {
  return Object.freeze({
    type: 'enum',
    values: Object.freeze([...values]),
    ...(required ? { required: true } : { default: defaultValue }),
  });
}

const CELLCHAT_INFERENCE_PARAM_SPEC = Object.freeze({
  // `ident` means the current Seurat identities, not an arbitrary metadata
  // column. This keeps the bridge from becoming a generic metadata execution
  // surface while making the selected grouping explicit and durable.
  groupBy: enumSpec(['seurat_clusters', 'ident'], { required: true }),
  // CellChat v1/v2 expects normalized expression. v1 fixes this to the normal
  // RNA assay rather than accepting arbitrary assay or layer names.
  assay: enumSpec(['RNA'], { defaultValue: 'RNA' }),
  species: enumSpec(['human', 'mouse'], { required: true }),
  databaseCategory: enumSpec([
    'all',
    'secreted_signaling',
    'ecm_receptor',
    'cell_cell_contact',
  ], { required: true }),
  // The application has no donor/sample/condition model yet. Require callers
  // to affirm the only supported intent instead of silently treating pooled
  // cells as an across-condition comparison.
  analysisIntent: enumSpec(['single_context'], { required: true }),
  minCellsPerGroup: Object.freeze({ type: 'int', min: 5, max: 200, required: true }),
  maxCellsPerGroup: Object.freeze({ type: 'int', min: 100, max: 10000, required: true }),
  // The supported singleton R service has an intentionally conservative
  // deployment envelope. Keep total cells at or below 10k until a larger
  // limit is demonstrated against the production resource budget.
  maxTotalCells: Object.freeze({ type: 'int', min: 1000, max: 10000, required: true }),
  pValueCutoff: Object.freeze({ type: 'number', min: 0.000001, max: 0.1, default: 0.05 }),
  topInteractions: Object.freeze({ type: 'int', min: 5, max: 100, default: 25 }),
  topPathways: Object.freeze({ type: 'int', min: 5, max: 100, default: 15 }),
  randomSeed: Object.freeze({ type: 'int', min: 0, max: 2147483647, default: 1 }),
});

const CELLCHAT_INFERENCE_PARAM_NAMES = Object.freeze(
  Object.keys(CELLCHAT_INFERENCE_PARAM_SPEC)
);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateOne(name, spec, raw) {
  if (spec.type === 'enum') {
    if (!spec.values.includes(raw)) {
      throw codedError(
        'INVALID_PARAMETER',
        `Parameter '${name}' must be one of: ${spec.values.join(', ')}.`
      );
    }
    return raw;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a finite number.`);
  }
  if (spec.type === 'int' && !Number.isInteger(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be an integer.`);
  }
  if (raw < spec.min || raw > spec.max) {
    throw codedError(
      'INVALID_PARAMETER',
      `Parameter '${name}' must be between ${spec.min} and ${spec.max}.`
    );
  }
  return raw;
}

/**
 * Resolve CellChat v1 parameters against the exact allowlist. No input is
 * coerced, no arbitrary metadata field can cross the boundary, and every
 * capacity/scientific choice is durable on the job record.
 */
function validateCellChatInferenceParams(input) {
  if (!isPlainObject(input)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(CELLCHAT_INFERENCE_PARAM_SPEC, key)) {
      throw codedError('UNKNOWN_PARAMETER', `Unknown parameter '${key}'.`);
    }
  }

  const params = {};
  const defaultsApplied = [];
  for (const name of CELLCHAT_INFERENCE_PARAM_NAMES) {
    const spec = CELLCHAT_INFERENCE_PARAM_SPEC[name];
    const absent = !Object.prototype.hasOwnProperty.call(input, name) || input[name] === undefined;
    if (absent) {
      if (spec.required) {
        throw codedError('INVALID_PARAMETER', `Parameter '${name}' is required.`);
      }
      params[name] = spec.default;
      defaultsApplied.push(name);
      continue;
    }
    params[name] = validateOne(name, spec, input[name]);
  }

  if (params.maxCellsPerGroup < params.minCellsPerGroup) {
    throw codedError(
      'INVALID_PARAMETER',
      "Parameter 'maxCellsPerGroup' must be at least 'minCellsPerGroup'."
    );
  }
  if (params.maxTotalCells < params.minCellsPerGroup * 2) {
    throw codedError(
      'INVALID_PARAMETER',
      "Parameter 'maxTotalCells' must accommodate at least two minimum-size groups."
    );
  }
  return { params, defaultsApplied };
}

const JOB_ID_RE = /^job_[0-9a-f]+$/;

function allocateCellChatInferenceResultStorageKey(projectId, jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw codedError(
      'INVALID_JOB_ID',
      'A server-generated job id is required to allocate a cell-communication result key.'
    );
  }
  return projectStorageFileKey(projectId, 'artifacts', jobId, 'cellchat-inference.csv');
}

module.exports = {
  CELLCHAT_INFERENCE_JOB_TYPE,
  CELLCHAT_INFERENCE_PARAM_SPEC,
  CELLCHAT_INFERENCE_PARAM_NAMES,
  MAX_CELLCHAT_RESULT_ROWS,
  validateCellChatInferenceParams,
  allocateCellChatInferenceResultStorageKey,
};
