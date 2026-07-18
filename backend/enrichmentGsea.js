'use strict';

// Pure validation and server-owned output-key allocation for the fixed
// `enrichment.gsea.v1` worker job. This module does not call R, the database, or
// the filesystem. Keeping the boundary small makes it possible for routes and
// workers to reject unsafe input before any scientific computation starts.

const { projectStorageFileKey } = require('./storage');

const ENRICHMENT_GSEA_JOB_TYPE = 'enrichment.gsea.v1';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function enumSpec(values, defaultValue) {
  return Object.freeze({
    type: 'enum',
    values: Object.freeze([...values]),
    default: defaultValue,
  });
}

const ENRICHMENT_GSEA_PARAM_SPEC = Object.freeze({
  groupBy: enumSpec(['seurat_clusters', 'ident'], 'seurat_clusters'),
  assay: enumSpec(['RNA', 'SCT'], 'RNA'),
  targetGroup: Object.freeze({
    type: 'safeLabel',
    required: true,
    minLength: 1,
    maxLength: 80,
  }),
  species: Object.freeze({
    type: 'enum',
    values: Object.freeze(['human', 'mouse']),
    required: true,
  }),
  geneSetCollection: enumSpec(['GO_BP'], 'GO_BP'),
  minGeneSetSize: Object.freeze({ type: 'int', min: 10, max: 200, default: 15 }),
  maxGeneSetSize: Object.freeze({ type: 'int', min: 50, max: 2000, default: 500 }),
  adjustedPValueCutoff: Object.freeze({
    type: 'number',
    min: 0.000001,
    max: 1,
    default: 0.05,
  }),
  topPathways: Object.freeze({ type: 'int', min: 5, max: 25, default: 15 }),
  maxCellsPerIdent: Object.freeze({
    type: 'int',
    min: 10,
    max: 100000,
    default: 10000,
  }),
  randomSeed: Object.freeze({
    type: 'int',
    min: 0,
    max: 2147483647,
    default: 1,
  }),
});

const ENRICHMENT_GSEA_PARAM_NAMES = Object.freeze(
  Object.keys(ENRICHMENT_GSEA_PARAM_SPEC)
);

const SAFE_GROUP_LABEL_RE = /^[A-Za-z0-9 ._+()-]+$/;
const URL_LIKE_RE = /^(?:www\.|(?:https?|file):)/i;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}

function validateSafeLabel(name, spec, raw) {
  if (typeof raw !== 'string') {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a string.`);
  }
  if (hasControlCharacter(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' contains unsupported characters.`);
  }

  const value = raw.trim();
  if (value.length < spec.minLength || value.length > spec.maxLength) {
    throw codedError(
      'INVALID_PARAMETER',
      `Parameter '${name}' must contain between ${spec.minLength} and ${spec.maxLength} characters.`
    );
  }
  if (!SAFE_GROUP_LABEL_RE.test(value)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' contains unsupported characters.`);
  }
  if (value === '.' || value === '..' || URL_LIKE_RE.test(value)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a group label, not a path or URL.`);
  }
  return value;
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
  if (spec.type === 'safeLabel') {
    return validateSafeLabel(name, spec, raw);
  }
  if (spec.type === 'intOrNull' && raw === null) {
    return null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a finite number.`);
  }
  if ((spec.type === 'int' || spec.type === 'intOrNull') && !Number.isInteger(raw)) {
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
 * Resolve job parameters against the exact allowlist above. Values are never
 * coerced. Unknown fields and malformed values are rejected before R contact.
 */
function validateEnrichmentGseaParams(input) {
  if (!isPlainObject(input)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }

  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(ENRICHMENT_GSEA_PARAM_SPEC, key)) {
      throw codedError('UNKNOWN_PARAMETER', `Unknown parameter '${key}'.`);
    }
  }

  const params = {};
  const defaultsApplied = [];
  for (const name of ENRICHMENT_GSEA_PARAM_NAMES) {
    const spec = ENRICHMENT_GSEA_PARAM_SPEC[name];
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

  if (params.minGeneSetSize >= params.maxGeneSetSize) {
    throw codedError(
      'INVALID_PARAMETER',
      "Parameter 'minGeneSetSize' must be smaller than 'maxGeneSetSize'."
    );
  }

  return { params, defaultsApplied };
}

const JOB_ID_RE = /^job_[0-9a-f]+$/;

function allocateEnrichmentGseaResultStorageKey(projectId, jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
    throw codedError(
      'INVALID_JOB_ID',
      'A server-generated job id is required to allocate a pathway-enrichment result key.'
    );
  }
  return projectStorageFileKey(
    projectId,
    'artifacts',
    jobId,
    'pathway-enrichment.csv'
  );
}

module.exports = {
  ENRICHMENT_GSEA_JOB_TYPE,
  ENRICHMENT_GSEA_PARAM_SPEC,
  ENRICHMENT_GSEA_PARAM_NAMES,
  validateEnrichmentGseaParams,
  allocateEnrichmentGseaResultStorageKey,
};
