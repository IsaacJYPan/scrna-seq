// ── PBMC/Seurat pipeline: server-side parameter allowlist + checkpoint key ────
//
// Pure, dependency-free server logic for the `pbmc.pipeline.v1` worker job. It does
// NOT touch R, the DB, or the filesystem — it only (1) validates + resolves the
// caller's parameters against a FIXED allowlist, and (2) allocates a safe, server-
// controlled internal checkpoint storage key. Keeping this in one tested module makes
// the security properties auditable in isolation.
//
// HARD BOUNDARIES (do not weaken):
//   - Only the parameters named in PBMC_PIPELINE_PARAM_SPEC are accepted. Unknown
//     parameter names are REJECTED (documented strict policy), so a client can never
//     smuggle an extra field into the R call.
//   - Every value is type/range/enum checked and re-emitted as a plain number / one
//     of a fixed enum string set. No parameter is ever interpolated into R code, used
//     as a file path, or used to choose an R function — the R endpoint consumes these
//     as typed Seurat arguments only.
//   - The checkpoint storage key is built from the SERVER-controlled job id only;
//     no client input contributes to it. Its stable per-job filename lets a retry
//     remove a crashed attempt's unrecorded file safely before calling R again.

const { projectStorageFileKey } = require('./storage');

/** Coded error so callers (route/handler) can branch + map to 400 / failed-job. */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ── Parameter allowlist ──────────────────────────────────────────────────────
// Each entry fully describes how one parameter is validated and defaulted. Types:
//   - 'enum'  : value must be one of `values`
//   - 'int'   : integer in [min, max]
//   - 'number': finite number in [min, max]
//   - 'intOrNull' (seed): null/absent → null (R picks + records a seed); else int in range
// `default` is applied (and recorded) when the parameter is absent. These defaults
// mirror the existing plumber.R pipeline endpoints (/normalize, /pca, /cluster, /umap).
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
  // int / number / intOrNull(non-null): must be a finite real number (not a string,
  // not NaN/Infinity). We intentionally do NOT coerce strings — a string parameter is
  // rejected, so nothing string-like (which could carry code/path) ever flows to R.
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

/**
 * Validate + resolve PBMC pipeline parameters against the fixed allowlist.
 *
 * Policy:
 *   - input must be a plain JSON object (or undefined/null → all defaults).
 *   - UNKNOWN parameter names are REJECTED (strict) — never silently ignored.
 *   - each known parameter is type/range/enum checked; invalid → throws
 *     INVALID_PARAMETER (the handler/route maps this to a 400 / failed-before-R).
 *   - absent parameters get their documented default, recorded in `defaultsApplied`.
 *
 * @returns {{ params: object, defaultsApplied: string[] }} resolved params (all
 *          allowlisted keys present) + the list of names that fell back to a default.
 * @throws  coded INVALID_PARAMETERS / UNKNOWN_PARAMETER / INVALID_PARAMETER
 */
function validatePbmcPipelineParams(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (!isPlainObject(raw)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }

  // Strict: reject any parameter name not in the allowlist.
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

// ── Internal checkpoint storage key allocation ───────────────────────────────
// The server allocates the internal key for a job's checkpoint RDS. It is a
// relative, traversal-free path built only from the server-generated job id. The
// stable filename makes retry cleanup deterministic; the R backend independently
// confines it to internal storage.
const _JOB_ID_RE = /^job_[0-9a-f]+$/;

function allocateCheckpointStorageKey(projectId, jobId) {
  if (jobId === undefined) {
    jobId = projectId;
    projectId = null;
  }
  if (typeof jobId !== 'string' || !_JOB_ID_RE.test(jobId)) {
    // Defense-in-depth: only ever build a key from a well-formed server job id.
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
