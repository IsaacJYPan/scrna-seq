// ── Minimal worker-to-R bridge ───────────────────────────────────────────────
//
// The smallest safe seam that lets a job worker invoke the R backend through
// SERVER-CONTROLLED code for exactly ONE explicitly allowlisted, read-only,
// metadata-only operation. It proves worker→R connectivity, explicit timeouts,
// sanitized errors, and the metadata-only artifact write path — WITHOUT opening a
// door to arbitrary R.
//
// HARD BOUNDARIES (do not weaken):
//   - This is NOT an HTTP route. It is an internal module called only by the
//     trusted worker handler. There is no public "run R bridge" endpoint.
//   - Only operations in R_BRIDGE_OPERATIONS may run. The operation NAME is the
//     only thing the caller chooses; the HTTP method + path are taken from the
//     server-defined spec, NEVER from caller input.
//   - No arbitrary R code, no client-controlled R path/endpoint/method/URL, no
//     client-controlled R state key. The `input` argument is intentionally
//     IGNORED for the one operation here (it is server-derived) — smuggling a
//     `code` / `path` / `endpoint` / `method` / `stateKey` field does nothing.
//   - Job/project/object identity is derived from the trusted `job` row, not from
//     caller input.
//   - Errors are sanitized before they can reach job logs / artifacts: raw R error
//     text, stacks, and internal URLs/hosts never escape (see sanitizeRBridgeError
//     and the default caller's catch). Thrown errors always carry a SAFE message.
//
// SCOPE: two read-only, metadata-only operations.
//   - `r.runtime.check` — a read-only call to the R `/health` endpoint recording
//     sanitized runtime metadata. Touches NO analysis object.
//   - `r.object.inspect` — a read-only inspection of ONE existing live analysis
//     object via the R `/object/inspect` endpoint. The object is identified by a
//     SERVER-DERIVED state key (X-Object-ID); the caller cannot choose it. It reads
//     a sanitized object summary (class/dimensions/assay+reduction+metadata-field
//     NAMES, runtime versions) and records it as metadata. It returns NO cell/gene/
//     expression/embedding data, mutates NOTHING in R, creates NO checkpoint/result
//     object, and produces NO download.
// Neither operation is real scientific pipeline execution. Object access is gated by
// the worker handler BEFORE the bridge is reached: only the live-R object owner may
// trigger an inspection (see jobWorker.js — verifyAnalysisObjectOwner). The bridge
// receives object context only as SERVER-DERIVED `objectContext` ({ objectId,
// stateKey }); `input` / job parameters can never choose the object, state key,
// method, or path.

const http = require('http');
const { PBMC_PIPELINE_PARAM_NAMES } = require('./pbmcPipeline');

/** Coded error helper (mirrors database.js so callers can branch on err.code). */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Default per-call timeout. Explicit and bounded so a hung/unreachable R backend
// can never wedge a worker tick indefinitely.
const DEFAULT_R_BRIDGE_TIMEOUT_MS = 10000;
// Hard ceiling for any single bridge call (incl. the longer pipeline op), so even a
// caller-supplied timeout can never make a worker tick unbounded.
const MAX_R_BRIDGE_TIMEOUT_MS = 600000;

// ── Operation allowlist ──────────────────────────────────────────────────────
// The ONLY operations the bridge will run. Each entry fully describes the
// server-controlled request; nothing here is derived from caller input. To add an
// operation you must add an explicit, reviewed entry — there is no dynamic/
// pass-through path. `touchesAnalysisObject` documents (and is asserted in tests)
// that this op does not read or mutate analysis-object/live-R state.
const R_BRIDGE_OPERATIONS = Object.freeze({
  'r.runtime.check': Object.freeze({
    method: 'GET',
    path: '/health',
    artifactType: 'r_runtime_check',
    artifactName: 'R runtime check',
    artifactDescription:
      'Operational R runtime connectivity/health check. Metadata only — not a scientific result, no analysis-object data.',
    touchesAnalysisObject: false,
    requiresObjectContext: false,
    readOnly: true,
  }),
  // Read-only inspection of ONE existing live analysis object. The object is
  // addressed by a SERVER-DERIVED state key (X-Object-ID) supplied via
  // `objectContext`; it reads a sanitized summary only and mutates nothing. The
  // worker handler verifies live-R object ownership BEFORE this runs, so project
  // membership alone never reaches another user's live object.
  'r.object.inspect': Object.freeze({
    method: 'GET',
    path: '/object/inspect',
    artifactType: 'r_object_inspection',
    artifactName: 'R object inspection',
    artifactDescription:
      'Read-only inspection of a live analysis object. Metadata only — a sanitized object summary '
      + '(class, dimensions, assay/reduction/metadata-field names, runtime versions). Not a scientific '
      + 'result: no expression matrices, cell/gene data, embeddings, or serialized object contents.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    readOnly: true,
  }),
  // The first MUTATING bridge operation: run the existing PBMC/Seurat preprocessing
  // pipeline on a COPY of one live analysis object (the parent is never mutated) and
  // persist a durable checkpoint RDS to a SERVER-allocated internal vault key. The
  // request method/path are fixed; the X-Object-ID (parent) is server-derived; the
  // body is reconstructed by the bridge from ONLY the allowlisted, server-validated
  // params + the server-allocated checkpoint key (`carriesParams`). It returns a
  // sanitized, bounded summary — never matrices/cells/genes/embeddings. The worker
  // handler validates params + ownership BEFORE this runs; there is NO arbitrary R.
  'r.pbmc.pipeline.v1': Object.freeze({
    method: 'POST',
    path: '/object/pbmc-pipeline',
    artifactType: 'pipeline_summary',
    artifactName: 'PBMC pipeline summary',
    artifactDescription:
      'Sanitized summary of a PBMC/Seurat preprocessing run (normalize → variable features → scale → '
      + 'PCA → neighbors → clusters → UMAP) executed on a copy of the input object. Bounded counts, '
      + 'reduction names, resolved parameters, and runtime versions only — no expression matrices, '
      + 'cell/gene tables, embeddings, paths, or state keys.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesParams: true,
    mutating: true,
    readOnly: false,
    // Pipeline runs are far longer than a health/inspect call — explicit but bounded
    // so a hung R run can never wedge a worker indefinitely.
    defaultTimeoutMs: 120000,
  }),
});

// Defense-in-depth target allowlist for the default R caller: the EXACT
// "METHOD PATH" pairs the bridge is ever allowed to issue, derived from the
// operation specs above. The caller refuses anything else before any HTTP, so even
// a buggy/abused caller invocation cannot reach an arbitrary R endpoint/method.
const R_BRIDGE_ALLOWED_TARGETS = Object.freeze(
  new Set(Object.values(R_BRIDGE_OPERATIONS).map((s) => `${s.method} ${s.path}`))
);

function isAllowedRBridgeOperation(operation) {
  return typeof operation === 'string'
    && Object.prototype.hasOwnProperty.call(R_BRIDGE_OPERATIONS, operation);
}

function isAllowedRBridgeTarget(method, path) {
  return R_BRIDGE_ALLOWED_TARGETS.has(`${method} ${path}`);
}

// ── Sanitization ─────────────────────────────────────────────────────────────

// Reduce an arbitrary value to a short, safe descriptive string: keep only a
// conservative character set and cap the length, so an R response field can never
// carry a path, URL, stack, or oversized blob into public artifact metadata.
function sanitizeRuntimeField(value, maxLen = 64) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  const cleaned = String(value).replace(/[^A-Za-z0-9 ._:+-]/g, '').trim().slice(0, maxLen);
  return cleaned === '' ? null : cleaned;
}

// Reduce a non-negative count to a bounded integer, or null. Guards against
// non-numbers, negatives, NaN/Infinity, and absurd values so a hostile/garbage R
// response can never inject a huge or non-numeric "dimension" into metadata.
function sanitizeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  if (n < 0 || n > 1e12) return null;
  return n;
}

// Reduce an array of names (assays/reductions/metadata fields) to a bounded list of
// short, safe strings. Caps BOTH the number of items and each item's length, and
// drops anything non-scalar/unsafe — so a name list can never carry oversized,
// path-like, or hostile content (or a huge gene list) into artifact metadata.
function sanitizeNameList(value, maxItems = 64, maxLen = 64) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const s = sanitizeRuntimeField(v, maxLen);
    if (s) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Build a SAFE, bounded, metadata-only summary of an inspected analysis object from
 * the raw R `/object/inspect` body. Only a small allowlist of known structural fields
 * is kept; every value is sanitized and capped. Deliberately NEVER includes
 * expression matrices, cell-level rows, gene lists, embeddings, raw sample values,
 * file paths, the R state key, or serialized object contents — even if the R response
 * tried to include them, they are dropped because they are not on this allowlist.
 */
function sanitizeInspectionSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const summary = { exists: b.exists === true };
  if (!summary.exists) return summary;

  const cls = sanitizeRuntimeField(b.class);
  if (cls) summary.class = cls;

  const nCells = sanitizeCount(b.n_cells);
  if (nCells !== null) summary.nCells = nCells;
  const nFeatures = sanitizeCount(b.n_features);
  if (nFeatures !== null) summary.nFeatures = nFeatures;

  const assays = sanitizeNameList(b.assays);
  if (assays.length) summary.assays = assays;
  const reductions = sanitizeNameList(b.reductions);
  if (reductions.length) summary.reductions = reductions;

  const nMeta = sanitizeCount(b.n_meta_fields);
  if (nMeta !== null) summary.nMetaFields = nMeta;
  const metaFields = sanitizeNameList(b.meta_fields);
  if (metaFields.length) summary.metaFields = metaFields;

  const sv = sanitizeRuntimeField(b.seurat_version);
  if (sv) summary.seuratVersion = sv;
  const rv = sanitizeRuntimeField(b.r_version);
  if (rv) summary.rVersion = rv;

  return summary;
}

// A 64-char lowercase hex sha256, or null. Guards the checkpoint checksum so a garbage
// R response can never inject a non-hex / oversized value into artifact metadata.
function sanitizeChecksum(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/**
 * Build a SAFE, bounded, metadata-only summary of a PBMC pipeline run from the raw R
 * body. Only a small allowlist of structural counts / names survives; every value is
 * sanitized and capped. Deliberately NEVER includes expression matrices, per-cell or
 * per-gene tables, embeddings, raw sample values, file paths, or the R state key —
 * even if the R response tried to include them, they are dropped (not on the allowlist).
 */
function sanitizePipelineSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = b.summary && typeof b.summary === 'object' ? b.summary : {};
  const out = {};

  const nCells = sanitizeCount(s.n_cells);
  if (nCells !== null) out.nCells = nCells;
  const nFeatures = sanitizeCount(s.n_features);
  if (nFeatures !== null) out.nFeatures = nFeatures;
  const nVar = sanitizeCount(s.n_variable_features);
  if (nVar !== null) out.nVariableFeatures = nVar;
  const nPcs = sanitizeCount(s.n_pcs);
  if (nPcs !== null) out.nPcs = nPcs;
  const nClusters = sanitizeCount(s.n_clusters);
  if (nClusters !== null) out.nClusters = nClusters;

  const reductions = sanitizeNameList(s.reductions);
  if (reductions.length) out.reductions = reductions;

  // Cluster sizes: a bounded list of non-negative counts (never per-cell data).
  if (Array.isArray(s.cluster_sizes)) {
    const sizes = [];
    for (const v of s.cluster_sizes) {
      const n = sanitizeCount(v);
      if (n !== null) sizes.push(n);
      if (sizes.length >= 256) break;
    }
    if (sizes.length) out.clusterSizes = sizes;
  }

  const method = sanitizeRuntimeField(s.normalization_method);
  if (method) out.normalizationMethod = method;
  const res = (typeof s.resolution === 'number' && Number.isFinite(s.resolution)) ? s.resolution : null;
  if (res !== null) out.resolution = res;

  const sv = sanitizeRuntimeField(b.seurat_version || (b.versions && b.versions.seurat_version));
  if (sv) out.seuratVersion = sv;
  const rv = sanitizeRuntimeField(b.r_version || (b.versions && b.versions.r_version));
  if (rv) out.rVersion = rv;

  const usedSeed = sanitizeCount(s.used_seed);
  if (usedSeed !== null) out.usedSeed = usedSeed;

  return out;
}

/**
 * Build a SAFE checkpoint descriptor from the raw R body: did R save a durable
 * checkpoint, and (if so) its sanitized checksum + size. NEVER includes the storage
 * path/key — the worker already holds the SERVER-allocated key and records it
 * internally (stripped from public responses); R only echoes save success + integrity.
 */
function sanitizeCheckpointInfo(body) {
  const b = body && typeof body === 'object' ? body : {};
  const c = b.checkpoint && typeof b.checkpoint === 'object' ? b.checkpoint : {};
  return {
    saved: c.saved === true,
    checksumSha256: sanitizeChecksum(c.checksum_sha256),
    sizeBytes: sanitizeCount(c.size_bytes),
  };
}

/**
 * Map any thrown bridge/caller error to a SAFE { code, message } pair. Known coded
 * errors get a stable, generic message; anything else collapses to a single generic
 * message. We never echo err.message verbatim from lower layers, so a raw R error
 * string, internal URL/host, or stack can never leak through job logs/artifacts.
 */
function sanitizeRBridgeError(err) {
  const code = err && typeof err.code === 'string' ? err.code : 'R_BRIDGE_ERROR';
  const SAFE_MESSAGES = {
    UNSUPPORTED_R_OPERATION: 'Requested R bridge operation is not allowlisted.',
    R_BRIDGE_TARGET_REJECTED: 'Requested R bridge target is not allowlisted.',
    R_BRIDGE_MISCONFIGURED: 'R bridge is not configured.',
    R_OBJECT_CONTEXT_REQUIRED: 'Server-derived object context is required for object inspection.',
    R_PIPELINE_PARAMS_REQUIRED: 'Server-validated pipeline parameters are required.',
    R_TIMEOUT: 'R runtime did not respond before the timeout.',
    R_UNREACHABLE: 'R runtime is unreachable.',
    R_RUNTIME_CHECK_FAILED: 'R runtime check failed.',
    R_OBJECT_INSPECT_FAILED: 'R object inspection failed.',
    R_PBMC_PIPELINE_FAILED: 'R PBMC pipeline run failed.',
    R_BRIDGE_ERROR: 'R bridge operation failed.',
  };
  return { code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.R_BRIDGE_ERROR };
}

// ── Default R caller (real HTTP) ─────────────────────────────────────────────
//
// Builds the function the bridge uses to actually reach R. It is intentionally
// narrow: it can only issue one of the server-defined { method, path } TARGETS
// (R_BRIDGE_ALLOWED_TARGETS) against the local Plumber backend with the API token,
// on a bounded timeout. Defense-in-depth: any non-allowlisted method/path is refused
// BEFORE any HTTP, so even a buggy/abused invocation can never reach an arbitrary R
// endpoint. The X-Object-ID header is sent ONLY when a server-derived `objectStateKey`
// is supplied (for r.object.inspect); the caller never accepts a client/raw state key,
// and r.runtime.check is always sent without one (it cannot touch per-object live R
// state). Every low-level failure (ECONNREFUSED, socket/host details, timeouts) is
// sanitized into a coded error with NO host/URL/stack, so nothing internal leaks.
function createDefaultRCaller(config = {}) {
  const host = '127.0.0.1';
  const port = Number(config.port) || Number(process.env.PLUMBER_PORT) || 8000;
  const token = config.token || process.env.API_TOKEN || '';

  return function callR({ method, path, timeoutMs, objectStateKey, body }) {
    return new Promise((resolve, reject) => {
      if (!token) {
        reject(codedError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.'));
        return;
      }
      // Defense-in-depth: only the known bridge targets may ever be issued.
      if (!isAllowedRBridgeTarget(method, path)) {
        reject(codedError('R_BRIDGE_TARGET_REJECTED', 'Requested R bridge target is not allowlisted.'));
        return;
      }
      let settled = false;
      const finishOk = (v) => { if (!settled) { settled = true; resolve(v); } };
      const finishErr = (e) => { if (!settled) { settled = true; reject(e); } };

      const headers = { 'X-API-Token': token, Accept: 'application/json' };
      // Server-derived object state key only (never client-controlled). Absent for
      // r.runtime.check, so that operation cannot reach per-object live R state.
      if (typeof objectStateKey === 'string' && objectStateKey !== '') {
        headers['X-Object-ID'] = objectStateKey;
      }

      // A request body is only ever sent for a POST target (the pipeline op). It is a
      // SERVER-built, JSON-serializable object (the bridge reconstructs it from the
      // allowlisted params + checkpoint key); raw client input never reaches here.
      let payload = null;
      if (method === 'POST' && body !== undefined && body !== null) {
        payload = Buffer.from(JSON.stringify(body), 'utf8');
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }

      let req;
      try {
        req = http.request(
          { host, port, method, path, headers },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              let resBody = null;
              try { resBody = raw ? JSON.parse(raw) : null; } catch { resBody = null; }
              finishOk({ status: res.statusCode, body: resBody });
            });
          }
        );
      } catch {
        // Never surface the raw construction error (could include host/port).
        finishErr(codedError('R_UNREACHABLE', 'R runtime is unreachable.'));
        return;
      }

      req.setTimeout(Number(timeoutMs) || DEFAULT_R_BRIDGE_TIMEOUT_MS, () => {
        req.destroy();
        finishErr(codedError('R_TIMEOUT', 'R runtime did not respond before the timeout.'));
      });
      // Collapse every transport-level error to a generic, host/URL-free code.
      req.on('error', () => finishErr(codedError('R_UNREACHABLE', 'R runtime is unreachable.')));
      if (payload) req.write(payload);
      req.end();
    });
  };
}

// ── The bridge ───────────────────────────────────────────────────────────────

/**
 * Run one allowlisted, metadata-only R-backed operation and return a SAFE artifact
 * descriptor describing what to record. Does NOT write to the database itself — the
 * worker handler creates the artifact through the claim-guarded helper — so the
 * bridge stays a pure, testable seam.
 *
 * @param {object}   args
 * @param {object}   args.job           trusted job row (source of jobId/projectId/owner)
 * @param {string}   args.operation     MUST be an allowlisted operation name
 * @param {object}   [args.actor]       server-derived actor info (informational)
 * @param {object}   [args.input]       IGNORED for choosing op/path/method/key (server-derived)
 * @param {object}   [args.objectContext] SERVER-DERIVED { objectId, stateKey } for object
 *                                       operations. Required when spec.requiresObjectContext.
 *                                       Never sourced from input/job parameters — the worker
 *                                       handler builds it from the trusted job + owner-verified
 *                                       state-key derivation.
 * @param {object}   [args.claimContext] e.g. { workerId } (informational; never recorded)
 * @param {object}   [args.logger]      { info, warn, error }
 * @param {function} args.callR         injected R caller (default built per worker)
 * @param {number}   [args.timeoutMs]   explicit per-call timeout
 * @returns {Promise<{artifactType,storageKind,name,description,metadata}>}
 * @throws  coded, SAFE-message errors only (see sanitizeRBridgeError codes).
 */
async function runRBridgeOperation(args = {}) {
  const { job, operation, callR } = args;
  const logger = args.logger || console;

  // 1. Operation must be explicitly allowlisted. Arbitrary names are refused here,
  //    before any R contact.
  if (!isAllowedRBridgeOperation(operation)) {
    throw codedError('UNSUPPORTED_R_OPERATION', 'Requested R bridge operation is not allowlisted.');
  }
  if (!job || typeof job !== 'object') {
    throw codedError('R_BRIDGE_ERROR', 'A trusted job context is required.');
  }
  if (typeof callR !== 'function') {
    throw codedError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  // 2. The request method/path are built ENTIRELY from the server-defined spec.
  //    `args.input` is deliberately never read: the caller cannot choose method/path/
  //    code/endpoint/state key.
  const spec = R_BRIDGE_OPERATIONS[operation];
  // Timeout: an explicit caller value wins, else the op's own default (the pipeline op
  // is longer), else the global default — always clamped to a hard ceiling so no call
  // can run unbounded.
  const requestedTimeout = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
    ? args.timeoutMs
    : (Number.isInteger(spec.defaultTimeoutMs) && spec.defaultTimeoutMs > 0
      ? spec.defaultTimeoutMs : DEFAULT_R_BRIDGE_TIMEOUT_MS);
  const timeoutMs = Math.min(requestedTimeout, MAX_R_BRIDGE_TIMEOUT_MS);
  const request = { method: spec.method, path: spec.path, timeoutMs };

  // 2a. Object operations need SERVER-DERIVED object context (never from input). The
  //     state key is the X-Object-ID the bridge sends; it is derived by the worker
  //     handler from the trusted job + owner-verified deriver, never client-provided.
  let objectContext = null;
  if (spec.requiresObjectContext) {
    objectContext = args.objectContext;
    if (!objectContext || typeof objectContext !== 'object'
      || typeof objectContext.stateKey !== 'string' || objectContext.stateKey === ''
      || typeof objectContext.objectId !== 'string' || objectContext.objectId === '') {
      throw codedError('R_OBJECT_CONTEXT_REQUIRED',
        'Server-derived object context is required for object inspection.');
    }
    request.objectStateKey = objectContext.stateKey;
  }

  // 2b. Operations that carry parameters (the pipeline op) get a SERVER-BUILT JSON body
  //     reconstructed from ONLY the allowlisted param names + the server-allocated
  //     checkpoint key. `args.pipeline` is supplied by the worker handler AFTER it has
  //     validated the params (backend/pbmcPipeline.js) and allocated the key; raw
  //     client input is never forwarded. Re-whitelisting here is defense-in-depth: a
  //     stray/hostile field on the params object can never reach R.
  if (spec.carriesParams) {
    const pipeline = args.pipeline;
    const params = pipeline && typeof pipeline === 'object' ? pipeline.params : null;
    const checkpointStorageKey = pipeline && typeof pipeline === 'object' ? pipeline.checkpointStorageKey : null;
    if (!params || typeof params !== 'object'
      || typeof checkpointStorageKey !== 'string' || checkpointStorageKey === '') {
      throw codedError('R_PIPELINE_PARAMS_REQUIRED', 'Server-validated pipeline parameters are required.');
    }
    const safeParams = {};
    for (const name of PBMC_PIPELINE_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    // `storage_key` is a TOP-LEVEL body field (matches R's validate_path arg + the
    // Node proxy's R_PROXY_VALIDATED_PATH_FIELDS allowlist).
    request.body = { operation, params: safeParams, storage_key: checkpointStorageKey };
  }

  if (logger && typeof logger.info === 'function') {
    // NB: never log the state key (an R state key); only the safe method/path.
    logger.info(`[r-bridge] running allowlisted operation '${operation}' (${spec.method} ${spec.path}).`);
  }

  // 3. Call R, mapping any failure to a sanitized, coded error.
  let response;
  try {
    response = await callR(request);
  } catch (err) {
    const safe = sanitizeRBridgeError(err);
    throw codedError(safe.code, safe.message);
  }

  if (!response || response.status !== 200) {
    // Never include the raw body/status text — only a generic, stable message.
    let failCode = 'R_RUNTIME_CHECK_FAILED';
    if (spec.carriesParams) failCode = 'R_PBMC_PIPELINE_FAILED';
    else if (spec.requiresObjectContext) failCode = 'R_OBJECT_INSPECT_FAILED';
    throw codedError(failCode, sanitizeRBridgeError({ code: failCode }).message);
  }

  // 4. Build SAFE, metadata-only artifact metadata. Only a small, sanitized allowlist
  //    of fields is kept; everything else from the R response is dropped.
  const body = response.body && typeof response.body === 'object' ? response.body : {};

  if (operation === 'r.pbmc.pipeline.v1') {
    // The bridge returns the SANITIZED pieces the worker needs; the worker (not the
    // bridge) writes the DB result object + artifacts. checkpoint carries only save
    // success + integrity (checksum/size) — never the storage path/key.
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    return {
      operation,
      artifactType: spec.artifactType, // 'pipeline_summary'
      name: spec.artifactName,
      description: spec.artifactDescription,
      resultObjectType: 'seurat',
      parentObjectId: objectContext.objectId,
      summary,
      checkpoint,
      // Metadata for the metadata-only pipeline_summary artifact (resolved params are
      // added by the worker, which holds the validated set).
      metadata: {
        operation,
        kind: 'pipeline',
        scientific_output: true,
        ranAt: new Date().toISOString(),
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.object.inspect') {
    const metadata = {
      operation,
      kind: 'inspection',
      scientific_output: false,
      read_only: true,
      inspectedAt: new Date().toISOString(),
      // The analysis object id is a normal (already member-visible) resource id, NOT
      // the R state key — the state key is never placed in metadata.
      objectId: objectContext.objectId,
      object: sanitizeInspectionSummary(body),
    };
    return {
      operation,
      artifactType: spec.artifactType,
      storageKind: 'metadata_only',
      name: spec.artifactName,
      description: spec.artifactDescription,
      metadata,
    };
  }

  // r.runtime.check
  const runtime = {};
  const status = sanitizeRuntimeField(body.status);
  const mode = sanitizeRuntimeField(body.mode);
  if (status) runtime.status = status;
  if (mode) runtime.mode = mode;

  const metadata = {
    operation,
    kind: 'operational',
    scientific_output: false,
    checkedAt: new Date().toISOString(),
    runtime,
  };

  return {
    operation,
    artifactType: spec.artifactType,
    storageKind: 'metadata_only',
    name: spec.artifactName,
    description: spec.artifactDescription,
    metadata,
  };
}

module.exports = {
  DEFAULT_R_BRIDGE_TIMEOUT_MS,
  MAX_R_BRIDGE_TIMEOUT_MS,
  R_BRIDGE_OPERATIONS,
  R_BRIDGE_ALLOWED_TARGETS,
  isAllowedRBridgeOperation,
  isAllowedRBridgeTarget,
  sanitizeRuntimeField,
  sanitizeCount,
  sanitizeNameList,
  sanitizeInspectionSummary,
  sanitizeChecksum,
  sanitizePipelineSummary,
  sanitizeCheckpointInfo,
  sanitizeRBridgeError,
  createDefaultRCaller,
  runRBridgeOperation,
};
