// ── DEG / marker finding: server-side parameter allowlist + result key ────────
//
// Pure, dependency-free server logic for the `deg.find_markers.v1` worker job. Like
// backend/pbmcPipeline.js it does NOT touch R, the DB, or the filesystem — it only
// (1) validates + resolves the caller's parameters against a FIXED allowlist, and
// (2) allocates a safe, server-controlled internal result storage key for the full
// marker table. Keeping this in one tested module makes the security properties
// auditable in isolation.
//
// HARD BOUNDARIES (do not weaken):
//   - Only the parameters named in DEG_FIND_MARKERS_PARAM_SPEC are accepted. Unknown
//     parameter names are REJECTED (strict policy), so a client can never smuggle an
//     extra field into the R call.
//   - Every value is type/range/enum checked and re-emitted as a plain number /
//     boolean / one of a fixed enum string set. No parameter is ever interpolated
//     into R code, used as a file path, or used to choose an R function — the R
//     endpoint consumes these as typed Seurat arguments only. The two string params
//     (`groupBy`, `assay`, `testUse`) are restricted to short, fixed enum allowlists,
//     so nothing string-like (which could carry code/path) ever flows to R.
//   - The result storage key is built from SERVER-controlled ids only (the job id +
//     server-generated random hex); no client input contributes to it, and it is a
//     relative, traversal-free path the R backend further confines to its vault.
//
// SCOPE: DEG is an OUTPUT-producing analysis over an EXISTING live object. It creates
// NO new analysis object and NO lineage edge. Pathway enrichment and CellChat are
// intentionally NOT integrated here.

const crypto = require('crypto');

/** Coded error so callers (route/handler) can branch + map to 400 / failed-job. */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ── Parameter allowlist ──────────────────────────────────────────────────────
// Each entry fully describes how one parameter is validated and defaulted. Types:
//   - 'enum'      : value must be one of `values`
//   - 'bool'      : strict JS boolean (true/false), no coercion
//   - 'number'    : finite number in [min, max]
//   - 'intOrNull' : null/absent → null; else integer in [min, max]
// `default` is applied (and recorded) when the parameter is absent. Defaults mirror the
// existing plumber.R `/deg` endpoint (FindAllMarkers only.pos=TRUE, min.pct=0.1,
// logfc.threshold=0.25, wilcox). `groupBy` is restricted to a SAFE identity allowlist:
//   - 'seurat_clusters' : group by the standard clustering metadata column (set Idents)
//   - 'ident'           : use the object's CURRENT active identities as-is (no group.by)
// Both are fixed identifiers — never an arbitrary client-supplied metadata column.
const DEG_FIND_MARKERS_PARAM_SPEC = Object.freeze({
  groupBy:              { type: 'enum', values: ['seurat_clusters', 'ident'], default: 'seurat_clusters' },
  assay:                { type: 'enum', values: ['RNA', 'SCT'],               default: 'RNA' },
  onlyPositive:         { type: 'bool',                                       default: true },
  minPct:               { type: 'number', min: 0,  max: 1,                    default: 0.1 },
  logfcThreshold:       { type: 'number', min: 0,  max: 10,                   default: 0.25 },
  // v1 supports ONLY the default Wilcoxon test — no client-chosen R test function.
  testUse:              { type: 'enum', values: ['wilcox'],                   default: 'wilcox' },
  maxCellsPerIdent:     { type: 'intOrNull', min: 1, max: 100000,             default: null },
  randomSeed:           { type: 'intOrNull', min: 0, max: 2147483647,         default: null },
  // Bounded count of top markers per group kept in the metadata-only summary artifact.
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
    // Strict: only a real JS boolean. We never coerce 'true'/1/'yes' etc., so a
    // string/number can never slip through a boolean flag.
    if (typeof raw !== 'boolean') {
      throw codedError('INVALID_PARAMETER', `Parameter '${name}' must be a boolean.`);
    }
    return raw;
  }
  if (spec.type === 'intOrNull' && raw === null) {
    return null;
  }
  // number / int / intOrNull(non-null): must be a finite real number (not a string,
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
 * Validate + resolve DEG find-markers parameters against the fixed allowlist.
 *
 * Policy (identical strictness to validatePbmcPipelineParams):
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
function validateDegFindMarkersParams(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (!isPlainObject(raw)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }

  // Strict: reject any parameter name not in the allowlist.
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

// ── Internal result storage key allocation ───────────────────────────────────
// The server allocates the internal vault key for a job's full DEG marker table. It is
// a RELATIVE, traversal-free path built ONLY from the (server-generated) job id and a
// fresh random hex token — no client input. The R backend additionally confines it to
// its vault via validate_path(). The full table is stored as `local_internal` only;
// there is NO public download route in this branch.
const _JOB_ID_RE = /^job_[0-9a-f]+$/;

function allocateDegResultStorageKey(jobId) {
  if (typeof jobId !== 'string' || !_JOB_ID_RE.test(jobId)) {
    // Defense-in-depth: only ever build a key from a well-formed server job id.
    throw codedError('INVALID_JOB_ID', 'A server-generated job id is required to allocate a DEG result key.');
  }
  const token = crypto.randomBytes(12).toString('hex');
  // R's validate_path(key, "vault") requires the key to resolve UNDER ANALYSIS_ROOT/vault;
  // a key without the `vault/` prefix is rejected as a path-traversal attempt, so the DEG
  // R run fails before writing. Prefix it, matching allocateSeuratCheckpointStorageKey.
  return `vault/deg/${jobId}/${token}.csv`;
}

module.exports = {
  DEG_FIND_MARKERS_PARAM_SPEC,
  DEG_FIND_MARKERS_PARAM_NAMES,
  validateDegFindMarkersParams,
  allocateDegResultStorageKey,
};
