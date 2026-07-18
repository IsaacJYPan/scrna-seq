// ── Worker-to-R bridge ───────────────────────────────────────────────────────
//
// The safe seam that lets a job worker invoke the R backend through
// SERVER-CONTROLLED, explicitly allowlisted operations. It started with
// metadata-only runtime/inspection checks and now also carries selected
// owner-verified scientific workflow handlers. It still opens no dynamic route
// to arbitrary R.
//
// HARD BOUNDARIES (do not weaken):
//   - This is NOT an HTTP route. It is an internal module called only by the
//     trusted worker handler. There is no public "run R bridge" endpoint.
//   - Only operations in R_BRIDGE_OPERATIONS may run. The operation NAME is the
//     only thing the caller chooses; the HTTP method + path are taken from the
//     server-defined spec, NEVER from caller input.
//   - No arbitrary R code, no client-controlled R path/endpoint/method/URL, no
//     client-controlled R state key. Per-operation payloads are rebuilt by this
//     module from validated, server-derived inputs; smuggling a `code` / `path` /
//     `endpoint` / `method` / `stateKey` field does nothing.
//   - Job/project/object identity is derived from the trusted `job` row, not from
//     caller input.
//   - Errors are sanitized before they can reach job logs / artifacts: raw R error
//     text, stacks, and internal URLs/hosts never escape (see sanitizeRBridgeError
//     and the default caller's catch). Thrown errors always carry a SAFE message.
//
// SCOPE: fixed allowlisted operations only.
//   - `r.runtime.check` — a read-only call to the R `/health` endpoint recording
//     sanitized runtime metadata. Touches NO analysis object.
//   - `r.object.inspect` — a read-only inspection of ONE existing live analysis
//     object via the R `/object/inspect` endpoint. The object is identified by a
//     SERVER-DERIVED state key (X-Object-ID); the caller cannot choose it. It reads
//     a sanitized object summary (class/dimensions/assay+reduction+metadata-field
//     NAMES, runtime versions) and records it as metadata. It returns NO cell/gene/
//     expression/embedding data, mutates NOTHING in R, creates NO checkpoint/result
//     object, and produces NO download.
//   - `r.pbmc.pipeline.v1`, `r.checkpoint.load.v1`, and `r.deg.find_markers.v1`
//     are selected owner-verified workflow handlers with server-built payloads and
//     sanitized outputs. They are not a general execution/eval mechanism.
// Object access is gated by
// the worker handler BEFORE the bridge is reached: only the live-R object owner may
// trigger an inspection (see jobWorker.js — verifyAnalysisObjectOwner). The bridge
// receives object context only as SERVER-DERIVED `objectContext` ({ objectId,
// stateKey }); `input` / job parameters can never choose the object, state key,
// method, or path.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const storage = require('./storage');
const { PBMC_PIPELINE_PARAM_NAMES } = require('./pbmcPipeline');
const { DEG_FIND_MARKERS_PARAM_NAMES } = require('./degFindMarkers');
const { ENRICHMENT_GSEA_PARAM_NAMES } = require('./enrichmentGsea');
const { SEURAT_PIPELINE_PARAM_NAMES } = require('./seuratPipeline');

/** Coded error helper (mirrors database.js so callers can branch on err.code). */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Receipt-backed R calls cross a point after which every response-side failure is
 * ambiguous: R may already have committed its output and receipt before Node sees
 * a disconnect, oversized/malformed response, or non-200 status. Keep that fact
 * non-enumerable so callers can choose bounded recovery without exposing internal
 * execution state in serialized errors.
 */
function markRSideEffectsPossible(error) {
  const err = error instanceof Error
    ? error
    : codedError('R_BRIDGE_ERROR', 'R bridge operation failed.');
  Object.defineProperty(err, 'rSideEffectsPossible', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return err;
}

function sanitizeRDiagnosticCode(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^a-z0-9_.:-]/gi, '').slice(0, 80);
  return cleaned || null;
}

// Default per-call timeout. Explicit and bounded so a hung/unreachable R backend
// can never wedge a worker tick indefinitely.
const DEFAULT_R_BRIDGE_TIMEOUT_MS = 10000;
// Hard ceiling for any single bridge call (incl. the longer pipeline op), so even a
// caller-supplied timeout can never make a worker tick unbounded.
const MAX_R_BRIDGE_TIMEOUT_MS = 600000;
const COMPLETION_RECEIPT_SIGNED_MAX_BYTES = 96 * 1024;
const COMPLETION_RECEIPT_ALGORITHM = 'hmac-sha256';
const COMPLETION_JOB_TO_R_OPERATION = Object.freeze({
  'pbmc.pipeline.v1': 'r.pbmc.pipeline.v1',
  'seurat.pipeline.v1': 'r.seurat.pipeline.v1',
  'deg.find_markers.v1': 'r.deg.find_markers.v1',
  'enrichment.gsea.v1': 'r.enrichment.gsea.v1',
  'checkpoint.load.v1': 'r.checkpoint.load.v1',
  'checkpoint.fork.v1': 'r.checkpoint.load.v1',
});

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
  // Checkpoint load / reattach: load a COMPLETED durable internal checkpoint RDS back
  // into the OWNER's private live R session under the canonical object key, so later
  // jobs can use it as live input. The request method/path are fixed; the X-Object-ID
  // (the owner's canonical object key) is server-derived; the body is reconstructed by
  // the bridge from ONLY the SERVER-selected checkpoint coordinates (`carriesCheckpoint`)
  // — the internal storage key + expected checksum/size, never any client input. It
  // mutates ONLY the target live object key and returns a sanitized, bounded summary
  // (never matrices/cells/genes/embeddings/path/state-key). The worker handler verifies
  // OWNERSHIP + selects the checkpoint BEFORE this runs; there is NO arbitrary R/path.
  'r.checkpoint.load.v1': Object.freeze({
    method: 'POST',
    path: '/object/checkpoint-load',
    artifactType: 'checkpoint_load',
    artifactName: 'Checkpoint load summary',
    artifactDescription:
      'Sanitized summary of loading a durable internal checkpoint back into the owner\'s private live R '
      + 'session (reattach). Bounded object summary (class, dimensions, assay/reduction/metadata-field '
      + 'names), checksum-verification flag, and runtime versions only — no expression matrices, '
      + 'cell/gene tables, embeddings, storage path/key, or R state key.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesCheckpoint: true,
    mutating: true,
    readOnly: false,
    // A checkpoint load reads + deserializes an RDS bundle and rebuilds the live object;
    // explicit but bounded so a hung load can never wedge a worker indefinitely.
    defaultTimeoutMs: 120000,
  }),
  // DEG / marker finding: run the existing FindAllMarkers path over ONE existing live
  // analysis object (the OWNER's, addressed by a SERVER-DERIVED X-Object-ID) and write the
  // full marker table to a SERVER-allocated internal vault key. DEG is an OUTPUT-producing
  // analysis, NOT a mutating transformation: it does NOT mutate the live object (any
  // temporary identity change is restored R-side) and creates NO new object. The request
  // method/path are fixed; the body is reconstructed by the bridge from ONLY the allowlisted,
  // server-validated params + the server-allocated result key (`carriesDegParams`). It returns
  // a sanitized, bounded marker SUMMARY (group counts, per-group counts, top-N preview with
  // safe columns) + the result-file integrity (saved/checksum/size) — never raw expression
  // matrices, cell metadata, embeddings, the storage path/key, or the R state key. The worker
  // handler verifies OWNERSHIP + validates params BEFORE this runs; there is NO arbitrary R.
  'r.deg.find_markers.v1': Object.freeze({
    method: 'POST',
    path: '/object/deg-find-markers',
    artifactType: 'deg_summary',
    artifactName: 'DEG marker summary',
    artifactDescription:
      'Sanitized, bounded summary of a DEG / FindAllMarkers run over an existing analysis object: '
      + 'resolved parameters, groups/clusters detected, total marker count + per-group counts, and a '
      + 'bounded top-N-per-group preview with safe columns only (group, gene, avg_log2FC, pct.1, pct.2, '
      + 'adjusted p-value, rank) plus runtime versions. No expression matrices, cell/gene tables, '
      + 'embeddings, storage path/key, or R state key.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesDegParams: true,
    // DEG does NOT mutate the live object (idents restored R-side); it only reads the object
    // and writes a separate output file. Marked non-mutating so the live-state invariant is
    // explicit and asserted in tests.
    mutating: false,
    readOnly: false,
    // FindAllMarkers over many clusters can run long; explicit but bounded so a hung run can
    // never wedge a worker indefinitely.
    defaultTimeoutMs: 120000,
  }),
  // Ranked GO enrichment for one selected identity versus all remaining cells. The
  // worker owns the object context, validated scientific parameters, and output key;
  // the browser cannot choose an R function, endpoint, path, or live-state key.
  'r.enrichment.gsea.v1': Object.freeze({
    method: 'POST',
    path: '/object/enrichment-gsea',
    artifactType: 'enrichment_summary',
    artifactName: 'Ranked pathway-enrichment summary',
    artifactDescription:
      'Sanitized, bounded summary of a cluster-versus-rest ranked Gene Ontology Biological Process enrichment run. '
      + 'The complete pathway table remains in private project storage; no expression matrix, cell-level data, '
      + 'storage key, R state key, or public download is included.',
    touchesAnalysisObject: true,
    requiresObjectContext: true,
    carriesEnrichmentParams: true,
    mutating: false,
    readOnly: false,
    defaultTimeoutMs: 300000,
  }),
  // Dataset-backed Seurat pipeline: load one server-resolved 10x HDF5 dataset,
  // create a Seurat object, run QC/preprocessing/clustering/UMAP, and save a
  // server-allocated checkpoint. Dataset and checkpoint storage keys are rebuilt
  // from trusted worker inputs only; clients cannot choose a path or R function.
  'r.seurat.pipeline.v1': Object.freeze({
    method: 'POST',
    path: '/object/seurat-pipeline',
    artifactType: 'pipeline_summary',
    artifactName: 'Seurat pipeline summary',
    artifactDescription:
      'Sanitized summary of a dataset-backed Seurat preprocessing run over one uploaded 10x HDF5 dataset. '
      + 'Bounded counts, reduction names, resolved parameters, warnings, and runtime versions only - no '
      + 'expression matrices, cell/gene tables, embeddings, paths, or state keys.',
    touchesAnalysisObject: false,
    requiresObjectContext: false,
    carriesSeuratDatasetParams: true,
    mutating: true,
    readOnly: false,
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
  const preFilterCells = sanitizeCount(s.pre_filter_cells);
  if (preFilterCells !== null) out.preFilterCells = preFilterCells;
  const postFilterCells = sanitizeCount(s.post_filter_cells);
  if (postFilterCells !== null) out.postFilterCells = postFilterCells;
  if (typeof s.percent_mt_available === 'boolean') out.percentMtAvailable = s.percent_mt_available;
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
 * Build a SAFE, bounded, metadata-only summary of a checkpoint LOAD/reattach from the
 * raw R body. Like sanitizeInspectionSummary, only a small allowlist of structural
 * fields survives; every value is sanitized and capped. It records WHETHER the load
 * succeeded, whether the checksum was verified, and a bounded object summary — NEVER
 * expression matrices, per-cell/gene tables, embeddings, raw sample values, the storage
 * path/key, or the R state key (none of those are on the allowlist, so even a hostile R
 * response cannot smuggle them through).
 */
function sanitizeLoadSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = { loaded: b.loaded === true };
  // Whether R re-verified the checkpoint file checksum before deserializing.
  out.checksumVerified = b.checksum_verified === true;
  if (!out.loaded) return out;

  const runtimeInstanceId = sanitizeRuntimeField(b.runtime_instance_id);
  if (runtimeInstanceId) {
    out.runtimeInstanceHash = crypto.createHash('sha256').update(runtimeInstanceId).digest('hex');
  }

  const cls = sanitizeRuntimeField(b.class);
  if (cls) out.class = cls;

  const nCells = sanitizeCount(b.n_cells);
  if (nCells !== null) out.nCells = nCells;
  const nFeatures = sanitizeCount(b.n_features);
  if (nFeatures !== null) out.nFeatures = nFeatures;

  const assays = sanitizeNameList(b.assays);
  if (assays.length) out.assays = assays;
  const reductions = sanitizeNameList(b.reductions);
  if (reductions.length) out.reductions = reductions;

  const nMeta = sanitizeCount(b.n_meta_fields);
  if (nMeta !== null) out.nMetaFields = nMeta;
  const metaFields = sanitizeNameList(b.meta_fields);
  if (metaFields.length) out.metaFields = metaFields;

  const sv = sanitizeRuntimeField(b.seurat_version);
  if (sv) out.seuratVersion = sv;
  const rv = sanitizeRuntimeField(b.r_version);
  if (rv) out.rVersion = rv;

  return out;
}

// A finite number kept to ~6 significant figures, or null. Guards numeric marker stats
// (avg_log2FC / pct / p-value) so a garbage R response can never inject NaN/Infinity or
// an oversized value into public summary metadata. We use significant figures (not fixed
// decimals) so very small adjusted p-values (e.g. 1e-12) are preserved rather than rounded
// to zero, while float noise is still trimmed.
function sanitizeStatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) > 1e12) return null;
  if (value === 0) return 0;
  return Number(value.toPrecision(6));
}

/**
 * Build a SAFE, bounded, metadata-only DEG marker SUMMARY from the raw R body. Only a
 * small allowlist of structural counts / safe stat columns survives; every value is
 * sanitized and capped. Deliberately NEVER includes raw expression matrices, full cell
 * metadata, embeddings, the storage path/key, or the R state key — even if the R response
 * tried to include them, they are dropped (not on this allowlist). The top-N preview is
 * doubly bounded: per-group by the validated topMarkersPerCluster and overall by a hard
 * row cap, so an unbounded marker table can never reach public metadata.
 */
function sanitizeDegSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = b.summary && typeof b.summary === 'object' ? b.summary : {};
  const out = {};

  const groupBy = sanitizeRuntimeField(s.group_by);
  if (groupBy) out.groupBy = groupBy;
  const testUse = sanitizeRuntimeField(s.test_use);
  if (testUse) out.testUse = testUse;
  const assay = sanitizeRuntimeField(s.assay);
  if (assay) out.assay = assay;

  const nGroups = sanitizeCount(s.n_groups);
  if (nGroups !== null) out.nGroups = nGroups;
  // Group LABELS only (e.g. cluster ids) — bounded list of short safe strings.
  const groups = sanitizeNameList(s.groups, 256);
  if (groups.length) out.groups = groups;

  const nMarkersTotal = sanitizeCount(s.n_markers_total);
  if (nMarkersTotal !== null) out.nMarkersTotal = nMarkersTotal;

  // Per-group marker counts: a bounded list of { group, n } (never per-cell data).
  if (Array.isArray(s.markers_per_group)) {
    const perGroup = [];
    for (const row of s.markers_per_group) {
      if (!row || typeof row !== 'object') continue;
      const g = sanitizeRuntimeField(row.group);
      const n = sanitizeCount(row.n);
      if (g !== null && n !== null) perGroup.push({ group: g, n });
      if (perGroup.length >= 256) break;
    }
    if (perGroup.length) out.markersPerGroup = perGroup;
  }

  // Top-N markers per group: SAFE columns only, doubly bounded (per-row sanitize + a hard
  // overall row cap). group/gene are name-safe strings; the rest are bounded numbers.
  if (Array.isArray(s.top_markers)) {
    const rows = [];
    // Must match R completion_receipt_safe_value() so normal publication and
    // receipt recovery persist the exact same bounded scientific summary.
    const MAX_TOP_ROWS = 256;
    for (const r of s.top_markers) {
      if (!r || typeof r !== 'object') continue;
      const group = sanitizeRuntimeField(r.group);
      const gene = sanitizeRuntimeField(r.gene);
      if (group === null || gene === null) continue;
      const safeRow = { group, gene };
      const avg = sanitizeStatNumber(r.avg_log2FC);
      if (avg !== null) safeRow.avgLog2FC = avg;
      const p1 = sanitizeStatNumber(r.pct_1);
      if (p1 !== null) safeRow.pct1 = p1;
      const p2 = sanitizeStatNumber(r.pct_2);
      if (p2 !== null) safeRow.pct2 = p2;
      const padj = sanitizeStatNumber(r.p_val_adj);
      if (padj !== null) safeRow.pValAdj = padj;
      const rank = sanitizeCount(r.rank);
      if (rank !== null) safeRow.rank = rank;
      rows.push(safeRow);
      if (rows.length >= MAX_TOP_ROWS) break;
    }
    if (rows.length) out.topMarkers = rows;
  }

  const sv = sanitizeRuntimeField(b.seurat_version || (b.versions && b.versions.seurat_version));
  if (sv) out.seuratVersion = sv;
  const rv = sanitizeRuntimeField(b.r_version || (b.versions && b.versions.r_version));
  if (rv) out.rVersion = rv;

  return out;
}

/**
 * Build a SAFE descriptor of the DEG full-table result FILE from the raw R body: did R
 * write the marker table, and (if so) its sanitized checksum + size + row count. Like
 * sanitizeCheckpointInfo it NEVER includes the storage path/key — the worker already holds
 * the SERVER-allocated key and records it internally (stripped from public responses).
 */
function sanitizeDegResultInfo(body) {
  const b = body && typeof body === 'object' ? body : {};
  const r = b.result && typeof b.result === 'object' ? b.result : {};
  return {
    saved: r.saved === true,
    checksumSha256: sanitizeChecksum(r.checksum_sha256),
    sizeBytes: sanitizeCount(r.size_bytes),
    nRows: sanitizeCount(r.n_rows),
  };
}

/**
 * Keep only a small, bounded pathway-enrichment preview. Full pathway and leading-
 * edge gene tables stay in the local_internal CSV artifact and never enter public
 * metadata. Unknown fields from R are dropped.
 */
function sanitizeEnrichmentSummary(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = b.summary && typeof b.summary === 'object' ? b.summary : {};
  const out = {};

  for (const [source, target] of [
    ['method', 'method'],
    ['group_by', 'groupBy'],
    ['assay', 'assay'],
    ['species', 'species'],
    ['gene_set_collection', 'geneSetCollection'],
    ['rank_metric', 'rankMetric'],
  ]) {
    const value = sanitizeRuntimeField(s[source], 80);
    if (value) out[target] = value;
  }

  if (s.comparison && typeof s.comparison === 'object') {
    const targetGroup = sanitizeRuntimeField(s.comparison.target_group, 80);
    const reference = sanitizeRuntimeField(s.comparison.reference, 80);
    if (targetGroup || reference) {
      out.comparison = {};
      if (targetGroup) out.comparison.targetGroup = targetGroup;
      if (reference) out.comparison.reference = reference;
    }
  }

  for (const [source, target] of [
    ['input_gene_count', 'inputGeneCount'],
    ['mapped_gene_count', 'mappedGeneCount'],
    ['tested_pathway_count', 'testedPathwayCount'],
    ['significant_pathway_count', 'significantPathwayCount'],
  ]) {
    const value = sanitizeCount(s[source]);
    if (value !== null) out[target] = value;
  }
  const mappingRate = sanitizeStatNumber(s.mapping_rate);
  if (mappingRate !== null && mappingRate >= 0 && mappingRate <= 1) {
    out.mappingRate = mappingRate;
  }

  if (s.package_versions && typeof s.package_versions === 'object') {
    const versions = {};
    for (const [source, target] of [
      ['r', 'r'],
      ['seurat', 'seurat'],
      ['annotation_dbi', 'annotationDbi'],
      ['go_db', 'goDb'],
      ['cluster_profiler', 'clusterProfiler'],
      ['fgsea', 'fgsea'],
      ['organism_db', 'organismDb'],
    ]) {
      const value = sanitizeRuntimeField(s.package_versions[source], 64);
      if (value) versions[target] = value;
    }
    if (Object.keys(versions).length) out.packageVersions = versions;
  }

  if (Array.isArray(s.top_pathways)) {
    const rows = [];
    for (const row of s.top_pathways) {
      if (!row || typeof row !== 'object') continue;
      const id = sanitizeRuntimeField(row.pathway_id, 80);
      const rawName = typeof row.pathway_name === 'string' ? row.pathway_name : '';
      const pathLikeName = /(?:[A-Za-z]:[\\/]|[\\/]|https?:|file:)/i.test(rawName);
      const name = pathLikeName ? null : sanitizeRuntimeField(rawName, 160);
      if (!id || !name) continue;
      const safe = { id, name };
      const nes = sanitizeStatNumber(row.normalized_enrichment_score);
      const pValue = sanitizeStatNumber(row.p_value);
      const adjustedPValue = sanitizeStatNumber(row.adjusted_p_value);
      const setSize = sanitizeCount(row.set_size);
      if (nes !== null) safe.normalizedEnrichmentScore = nes;
      if (pValue !== null && pValue >= 0 && pValue <= 1) safe.pValue = pValue;
      if (adjustedPValue !== null && adjustedPValue >= 0 && adjustedPValue <= 1) {
        safe.adjustedPValue = adjustedPValue;
      }
      if (setSize !== null) safe.setSize = setSize;
      if (typeof row.significant === 'boolean') safe.significant = row.significant;
      const direction = sanitizeRuntimeField(row.direction, 16);
      if (direction === 'positive' || direction === 'negative' || direction === 'neutral') {
        safe.direction = direction;
      }
      rows.push(safe);
      if (rows.length >= 25) break;
    }
    if (rows.length) out.topPathways = rows;
  }
  out.warnings = sanitizeNameList(s.warnings, 32, 160);
  return out;
}

function sanitizeEnrichmentResultInfo(body) {
  const result = sanitizeDegResultInfo(body);
  if (result.sizeBytes !== null && result.sizeBytes > 50 * 1024 * 1024) {
    result.saved = false;
  }
  if (result.nRows !== null && result.nRows > 100000) result.saved = false;
  return result;
}

const COMPLETION_RECEIPT_BINDING_KEYS = Object.freeze([
  'version',
  'job_id',
  'job_type',
  'r_operation',
  'project_id',
  'receipt_storage_key',
  'source_analysis_object_id',
  'source_dataset_id',
  'source_checkpoint_artifact_id',
  'target_analysis_object_id',
  'output_storage_key',
]);
const COMPLETION_RECEIPT_KEYS = Object.freeze([
  ...COMPLETION_RECEIPT_BINDING_KEYS,
  'payload',
]);
// Printable domain separation is intentionally shared byte-for-byte with R.
// Avoid an embedded NUL because R character values cannot safely represent it.
const COMPLETION_RECEIPT_HMAC_DOMAIN = 'BENCHONE_R_COMPLETION_RECEIPT_V1:';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactObjectKeys(value, keys, code = 'R_COMPLETION_RECEIPT_INVALID') {
  if (!isPlainObject(value)) throw codedError(code, 'Completion receipt is invalid.');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw codedError(code, 'Completion receipt is invalid.');
  }
}

function assertAllowedObjectKeys(value, allowed, required = []) {
  if (!isPlainObject(value)) throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))
      || required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
}

function createCompletionReceiptEnvelope(receipt, secret) {
  if (!isPlainObject(receipt) || typeof secret !== 'string' || secret.length === 0) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  const signedReceipt = JSON.stringify(receipt);
  if (Buffer.byteLength(signedReceipt, 'utf8') > COMPLETION_RECEIPT_SIGNED_MAX_BYTES) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  const signature = crypto.createHmac('sha256', secret)
    .update(COMPLETION_RECEIPT_HMAC_DOMAIN, 'utf8')
    .update(signedReceipt, 'utf8')
    .digest('hex');
  return {
    algorithm: COMPLETION_RECEIPT_ALGORITHM,
    signed_receipt: signedReceipt,
    signature,
  };
}

function verifyCompletionReceiptEnvelope(envelope, secret) {
  assertExactObjectKeys(
    envelope,
    ['algorithm', 'signed_receipt', 'signature'],
    'R_COMPLETION_RECEIPT_INVALID'
  );
  if (envelope.algorithm !== COMPLETION_RECEIPT_ALGORITHM
      || typeof envelope.signed_receipt !== 'string'
      || Buffer.byteLength(envelope.signed_receipt, 'utf8') === 0
      || Buffer.byteLength(envelope.signed_receipt, 'utf8') > COMPLETION_RECEIPT_SIGNED_MAX_BYTES
      || typeof envelope.signature !== 'string'
      || !/^[0-9a-f]{64}$/.test(envelope.signature)
      || typeof secret !== 'string' || secret.length === 0) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  const supplied = Buffer.from(envelope.signature, 'hex');
  const expected = crypto.createHmac('sha256', secret)
    .update(COMPLETION_RECEIPT_HMAC_DOMAIN, 'utf8')
    .update(envelope.signed_receipt, 'utf8')
    .digest();
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  let receipt;
  try {
    receipt = JSON.parse(envelope.signed_receipt);
  } catch {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  if (!isPlainObject(receipt)) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  return receipt;
}

function buildCompletionReceiptBinding(job, operation, args = {}) {
  const jobType = job && job.jobType;
  const expectedOperation = COMPLETION_JOB_TO_R_OPERATION[jobType];
  if (!expectedOperation) return null;
  if (operation !== expectedOperation
      || typeof job.id !== 'string' || job.id === ''
      || typeof job.projectId !== 'string' || job.projectId === '') {
    throw codedError('R_COMPLETION_RECEIPT_CONTEXT_REQUIRED', 'Completion receipt context is invalid.');
  }

  let outputStorageKey = null;
  let outputKind = null;
  let sourceCheckpointArtifactId = null;
  let targetAnalysisObjectId = null;
  if (jobType === 'pbmc.pipeline.v1') {
    outputStorageKey = args.pipeline && args.pipeline.checkpointStorageKey;
    outputKind = 'checkpoints';
  } else if (jobType === 'seurat.pipeline.v1') {
    outputStorageKey = args.seuratPipeline && args.seuratPipeline.checkpointStorageKey;
    outputKind = 'checkpoints';
  } else if (jobType === 'deg.find_markers.v1') {
    outputStorageKey = args.deg && args.deg.resultStorageKey;
    outputKind = 'artifacts';
  } else if (jobType === 'enrichment.gsea.v1') {
    outputStorageKey = args.enrichment && args.enrichment.resultStorageKey;
    outputKind = 'artifacts';
  } else {
    sourceCheckpointArtifactId = args.checkpoint && args.checkpoint.checkpointArtifactId;
    targetAnalysisObjectId = args.objectContext && args.objectContext.objectId;
  }
  if (outputKind && !storage.isProjectStorageKey(outputStorageKey, {
    projectId: job.projectId,
    kind: outputKind,
  })) {
    throw codedError('R_COMPLETION_RECEIPT_CONTEXT_REQUIRED', 'Completion receipt context is invalid.');
  }
  if ((jobType === 'checkpoint.load.v1' || jobType === 'checkpoint.fork.v1')
      && (typeof sourceCheckpointArtifactId !== 'string' || sourceCheckpointArtifactId === ''
        || typeof targetAnalysisObjectId !== 'string' || targetAnalysisObjectId === '')) {
    throw codedError('R_COMPLETION_RECEIPT_CONTEXT_REQUIRED', 'Completion receipt context is invalid.');
  }

  return {
    version: storage.COMPLETION_RECEIPT_VERSION,
    job_id: job.id,
    job_type: jobType,
    r_operation: operation,
    project_id: job.projectId,
    receipt_storage_key: storage.completionReceiptKey(job.projectId, job.id),
    source_analysis_object_id: job.analysisObjectId || null,
    source_dataset_id: job.datasetId || null,
    source_checkpoint_artifact_id: sourceCheckpointArtifactId,
    target_analysis_object_id: targetAnalysisObjectId,
    output_storage_key: outputStorageKey,
  };
}

function validateBoundedReceiptValue(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  if (depth > 7 || state.nodes > 6000) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 160 || !/^[A-Za-z0-9 ._:+-]*$/.test(value)) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    for (const item of value) validateBoundedReceiptValue(item, depth + 1, state);
    return;
  }
  if (!isPlainObject(value) || Object.keys(value).length > 64) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    validateBoundedReceiptValue(child, depth + 1, state);
  }
}

function validateReceiptPayloadSchema(jobType, payload) {
  validateBoundedReceiptValue(payload);
  if (jobType === 'pbmc.pipeline.v1' || jobType === 'seurat.pipeline.v1') {
    const topKeys = jobType === 'seurat.pipeline.v1'
      ? ['ok', 'summary', 'checkpoint', 'versions', 'warnings']
      : ['ok', 'summary', 'checkpoint', 'versions'];
    assertExactObjectKeys(payload, topKeys);
    if (payload.ok !== true) throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    assertAllowedObjectKeys(payload.summary, [
      'n_cells', 'n_features', 'pre_filter_cells', 'post_filter_cells',
      'percent_mt_available', 'n_variable_features', 'n_pcs', 'n_clusters',
      'cluster_sizes', 'reductions', 'normalization_method', 'resolution', 'used_seed',
    ], ['n_cells', 'n_features']);
    assertExactObjectKeys(payload.checkpoint, ['saved', 'checksum_sha256', 'size_bytes']);
    assertExactObjectKeys(payload.versions, ['seurat_version', 'r_version']);
    if (jobType === 'seurat.pipeline.v1' && !Array.isArray(payload.warnings)) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return;
  }
  if (jobType === 'deg.find_markers.v1') {
    assertExactObjectKeys(payload, ['ok', 'summary', 'result', 'versions']);
    if (payload.ok !== true) throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    assertExactObjectKeys(payload.summary, [
      'group_by', 'test_use', 'assay', 'n_groups', 'groups',
      'n_markers_total', 'markers_per_group', 'top_markers',
    ]);
    assertExactObjectKeys(payload.result, ['saved', 'checksum_sha256', 'size_bytes', 'n_rows']);
    assertExactObjectKeys(payload.versions, ['seurat_version', 'r_version']);
    if (!Array.isArray(payload.summary.groups)
        || !Array.isArray(payload.summary.markers_per_group)
        || !Array.isArray(payload.summary.top_markers)) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    for (const row of payload.summary.markers_per_group) assertExactObjectKeys(row, ['group', 'n']);
    for (const row of payload.summary.top_markers) {
      assertExactObjectKeys(row, ['group', 'gene', 'avg_log2FC', 'pct_1', 'pct_2', 'p_val_adj', 'rank']);
    }
    return;
  }
  if (jobType === 'enrichment.gsea.v1') {
    assertExactObjectKeys(payload, ['ok', 'summary', 'result']);
    if (payload.ok !== true) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    assertExactObjectKeys(payload.summary, [
      'method', 'comparison', 'group_by', 'assay', 'species',
      'gene_set_collection', 'rank_metric', 'input_gene_count',
      'mapped_gene_count', 'mapping_rate', 'tested_pathway_count',
      'significant_pathway_count', 'package_versions', 'top_pathways', 'warnings',
    ]);
    assertExactObjectKeys(payload.summary.comparison, ['target_group', 'reference']);
    assertExactObjectKeys(payload.summary.package_versions, [
      'r', 'seurat', 'annotation_dbi', 'go_db', 'cluster_profiler', 'fgsea',
      'organism_db',
    ]);
    assertExactObjectKeys(payload.result, ['saved', 'checksum_sha256', 'size_bytes', 'n_rows']);
    if (!Array.isArray(payload.summary.top_pathways)
        || !Array.isArray(payload.summary.warnings)
        || payload.summary.top_pathways.length > 25) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    for (const row of payload.summary.top_pathways) {
      assertExactObjectKeys(row, [
        'pathway_id', 'pathway_name', 'normalized_enrichment_score', 'p_value',
        'adjusted_p_value', 'set_size', 'significant', 'direction',
      ]);
    }
    return;
  }
  assertExactObjectKeys(payload, [
    'loaded', 'runtime_instance_id', 'checksum_verified', 'class', 'n_cells',
    'n_features', 'assays', 'reductions', 'n_meta_fields', 'meta_fields',
    'seurat_version', 'r_version',
  ]);
  if (payload.loaded !== true || payload.checksum_verified !== true) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  if (!Array.isArray(payload.assays) || !Array.isArray(payload.reductions)
      || !Array.isArray(payload.meta_fields)
      || typeof payload.runtime_instance_id !== 'string'
      || payload.runtime_instance_id.length === 0) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
}

function descriptorFromCompletionReceipt(job, receipt, expected = {}) {
  assertExactObjectKeys(receipt, COMPLETION_RECEIPT_KEYS);
  const jobType = job && job.jobType;
  const rOperation = COMPLETION_JOB_TO_R_OPERATION[jobType];
  const receiptKey = storage.completionReceiptKey(job.projectId, job.id);
  const parsedReceiptKey = storage.parseProjectStorageKey(receipt.receipt_storage_key);
  const commonMatches = receipt.version === storage.COMPLETION_RECEIPT_VERSION
    && receipt.job_id === job.id
    && receipt.job_type === jobType
    && receipt.r_operation === rOperation
    && receipt.project_id === job.projectId
    && receipt.receipt_storage_key === receiptKey
    && parsedReceiptKey && parsedReceiptKey.projectId === job.projectId
    && parsedReceiptKey.kind === 'artifacts' && parsedReceiptKey.resourceId === job.id
    && receipt.source_analysis_object_id === (job.analysisObjectId || null)
    && receipt.source_dataset_id === (job.datasetId || null)
    && receipt.source_checkpoint_artifact_id === (expected.sourceCheckpointArtifactId || null)
    && receipt.target_analysis_object_id === (expected.targetAnalysisObjectId || null)
    && receipt.output_storage_key === (expected.outputStorageKey || null);
  if (!commonMatches) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  validateReceiptPayloadSchema(jobType, receipt.payload);
  const body = receipt.payload;
  const spec = R_BRIDGE_OPERATIONS[rOperation];
  if (jobType === 'pbmc.pipeline.v1' || jobType === 'seurat.pipeline.v1') {
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    if (!checkpoint.saved || !checkpoint.checksumSha256 || checkpoint.sizeBytes === null) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      operation: rOperation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      resultObjectType: 'seurat',
      summary,
      checkpoint,
      metadata: {
        operation: rOperation,
        kind: 'pipeline',
        scientific_output: true,
        ranAt: new Date().toISOString(),
        ...(job.analysisObjectId ? { objectId: job.analysisObjectId } : {}),
        summary,
        ...(jobType === 'seurat.pipeline.v1'
          ? { warnings: sanitizeNameList(body.warnings, 32, 160) } : {}),
      },
    };
  }
  if (jobType === 'enrichment.gsea.v1') {
    const summary = sanitizeEnrichmentSummary(body);
    const result = sanitizeEnrichmentResultInfo(body);
    if (!result.saved || !result.checksumSha256 || result.sizeBytes === null
        || result.nRows === null) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      operation: rOperation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: job.analysisObjectId,
      summary,
      result,
      metadata: {
        operation: rOperation,
        kind: 'enrichment_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: job.analysisObjectId,
        summary,
      },
    };
  }
  if (jobType === 'deg.find_markers.v1') {
    const summary = sanitizeDegSummary(body);
    const result = sanitizeDegResultInfo(body);
    if (!result.saved || !result.checksumSha256 || result.sizeBytes === null
        || result.nRows === null) {
      throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      operation: rOperation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: job.analysisObjectId,
      summary,
      result,
      metadata: {
        operation: rOperation,
        kind: 'deg_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: job.analysisObjectId,
        summary,
      },
    };
  }
  const loaded = sanitizeLoadSummary(body);
  if (!loaded.loaded || !loaded.checksumVerified || !loaded.runtimeInstanceHash) {
    throw codedError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  return {
    operation: rOperation,
    artifactType: spec.artifactType,
    storageKind: 'metadata_only',
    name: spec.artifactName,
    description: spec.artifactDescription,
    objectId: expected.targetAnalysisObjectId,
    loaded,
    metadata: {
      operation: rOperation,
      kind: 'checkpoint_load',
      scientific_output: false,
      live_state_mutation: true,
      loadedAt: new Date().toISOString(),
      objectId: expected.targetAnalysisObjectId,
      loaded,
    },
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
    R_DEG_PARAMS_REQUIRED: 'Server-validated DEG parameters and result key are required.',
    R_ENRICHMENT_PARAMS_REQUIRED: 'Server-validated pathway-enrichment parameters and result key are required.',
    R_CHECKPOINT_REQUIRED: 'A server-selected checkpoint is required for a checkpoint load.',
    R_TIMEOUT: 'R runtime did not respond before the timeout.',
    R_RESPONSE_TOO_LARGE: 'R runtime response exceeded its safe limit.',
    R_RESPONSE_INVALID: 'R runtime returned an invalid response.',
    R_UNREACHABLE: 'R runtime is unreachable.',
    R_RUNTIME_CHECK_FAILED: 'R runtime check failed.',
    R_OBJECT_INSPECT_FAILED: 'R object inspection failed.',
    R_PBMC_PIPELINE_FAILED: 'R PBMC pipeline run failed.',
    R_CHECKPOINT_LOAD_FAILED: 'R checkpoint load failed.',
    R_DEG_FIND_MARKERS_FAILED: 'R DEG / marker finding run failed.',
    R_ENRICHMENT_GSEA_FAILED: 'R ranked pathway-enrichment run failed.',
    R_SEURAT_PIPELINE_FAILED: 'R Seurat pipeline run failed.',
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
  let endpoint = null;
  try {
    endpoint = new URL(
      config.baseUrl || process.env.R_BACKEND_URL
      || `http://127.0.0.1:${Number(config.port) || Number(process.env.PLUMBER_PORT) || 8000}`
    );
    if (!['http:', 'https:'].includes(endpoint.protocol)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || (endpoint.pathname && endpoint.pathname !== '/')) {
      endpoint = null;
    }
  } catch {
    endpoint = null;
  }
  const token = config.token || process.env.API_TOKEN || '';
  const maxResponseBytes = Number.isInteger(Number(config.maxResponseBytes))
    && Number(config.maxResponseBytes) > 0
    ? Math.min(Number(config.maxResponseBytes), 4 * 1024 * 1024)
    : 1024 * 1024;

  const callR = function callR({ method, path, timeoutMs, objectStateKey, body }) {
    return new Promise((resolve, reject) => {
      if (!token || !endpoint) {
        reject(codedError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.'));
        return;
      }
      // Defense-in-depth: only the known bridge targets may ever be issued.
      if (!isAllowedRBridgeTarget(method, path)) {
        reject(codedError('R_BRIDGE_TARGET_REJECTED', 'Requested R bridge target is not allowlisted.'));
        return;
      }
      let settled = false;
      let deadline = null;
      const finishOk = (v) => {
        if (!settled) {
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve(v);
        }
      };
      const finishErr = (e) => {
        if (!settled) {
          settled = true;
          if (deadline) clearTimeout(deadline);
          reject(e);
        }
      };

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
        const transport = endpoint.protocol === 'https:' ? https : http;
        req = transport.request(
          {
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
            method,
            path,
            headers,
          },
          (res) => {
            const chunks = [];
            let responseBytes = 0;
            res.on('data', (c) => {
              responseBytes += c.length;
              if (responseBytes > maxResponseBytes) {
                req.destroy();
                finishErr(codedError('R_RESPONSE_TOO_LARGE', 'R runtime response exceeded its safe limit.'));
                return;
              }
              chunks.push(c);
            });
            res.on('end', () => {
              if (settled) return;
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

      // Total wall-clock deadline, not merely an idle-socket timeout. A peer that
      // slowly streams bytes therefore cannot keep a heavy-job claim alive forever.
      deadline = setTimeout(() => {
        req.destroy();
        finishErr(codedError('R_TIMEOUT', 'R runtime did not respond before the timeout.'));
      }, Number(timeoutMs) || DEFAULT_R_BRIDGE_TIMEOUT_MS);
      if (typeof deadline.unref === 'function') deadline.unref();
      // Collapse every transport-level error to a generic, host/URL-free code.
      req.on('error', () => finishErr(codedError('R_UNREACHABLE', 'R runtime is unreachable.')));
      if (payload) req.write(payload);
      req.end();
    });
  };
  // Keep the shared secret closed over by the caller. Recovery receives only a
  // verifier capability; the API token is never copied into worker state or logs.
  Object.defineProperty(callR, 'verifyCompletionReceipt', {
    value: (envelope) => verifyCompletionReceiptEnvelope(envelope, token),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return callR;
}

// ── The bridge ───────────────────────────────────────────────────────────────

/**
 * Run one allowlisted R-backed operation and return a SAFE descriptor describing
 * what to record. Does NOT write to the database itself — the worker handler
 * creates artifacts/results through claim-guarded helpers — so the bridge stays a
 * pure, testable seam.
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

  // 2c. Checkpoint-load op: a SERVER-BUILT body reconstructed from ONLY the server-
  //     SELECTED checkpoint coordinates (the internal storage key + expected integrity).
  //     `args.checkpoint` is supplied by the worker handler AFTER it has verified
  //     ownership and resolved the loadable checkpoint (database.js
  //     getLoadableCheckpointForAnalysisObject); raw client input is never forwarded and
  //     there is NO client-controlled storage key/path. The expected checksum/size let R
  //     re-verify file integrity before deserializing.
  if (spec.carriesCheckpoint) {
    const cp = args.checkpoint;
    const storageKey = cp && typeof cp === 'object' ? cp.internalStorageKey : null;
    if (!cp || typeof cp !== 'object'
      || typeof storageKey !== 'string' || storageKey === '') {
      throw codedError('R_CHECKPOINT_REQUIRED', 'A server-selected checkpoint is required for a checkpoint load.');
    }
    // `storage_key` is the TOP-LEVEL body field R confines via validate_path() and the
    // Node proxy's R_PROXY_VALIDATED_PATH_FIELDS allowlist already covers.
    const loadBody = { operation, storage_key: storageKey };
    if (typeof cp.checksumSha256 === 'string' && cp.checksumSha256 !== '') {
      loadBody.expected_checksum_sha256 = cp.checksumSha256;
    }
    if (Number.isFinite(cp.sizeBytes) && cp.sizeBytes >= 0) {
      loadBody.expected_size_bytes = cp.sizeBytes;
    }
    request.body = loadBody;
  }

  // 2d. DEG op: a SERVER-BUILT body reconstructed from ONLY the allowlisted, server-
  //     validated DEG params + the SERVER-allocated result storage key. `args.deg` is
  //     supplied by the worker handler AFTER it has validated the params
  //     (backend/degFindMarkers.js) and allocated the key; raw client input is never
  //     forwarded and there is NO client-controlled storage key/path. Re-whitelisting the
  //     param names here is defense-in-depth: a stray/hostile field can never reach R.
  if (spec.carriesDegParams) {
    const deg = args.deg;
    const params = deg && typeof deg === 'object' ? deg.params : null;
    const resultStorageKey = deg && typeof deg === 'object' ? deg.resultStorageKey : null;
    if (!params || typeof params !== 'object'
      || typeof resultStorageKey !== 'string' || resultStorageKey === '') {
      throw codedError('R_DEG_PARAMS_REQUIRED', 'Server-validated DEG parameters and result key are required.');
    }
    const safeParams = {};
    for (const name of DEG_FIND_MARKERS_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    // `storage_key` is a TOP-LEVEL body field (matches R's validate_path arg + the Node
    // proxy's R_PROXY_VALIDATED_PATH_FIELDS allowlist).
    request.body = { operation, params: safeParams, storage_key: resultStorageKey };
  }

  // 2e. Ranked enrichment: only the dedicated validator's fields and the
  // server-allocated output key can cross the worker/R boundary.
  if (spec.carriesEnrichmentParams) {
    const enrichment = args.enrichment;
    const params = enrichment && typeof enrichment === 'object' ? enrichment.params : null;
    const resultStorageKey = enrichment && typeof enrichment === 'object'
      ? enrichment.resultStorageKey : null;
    if (!params || typeof params !== 'object'
        || typeof resultStorageKey !== 'string' || resultStorageKey === '') {
      throw codedError(
        'R_ENRICHMENT_PARAMS_REQUIRED',
        'Server-validated pathway-enrichment parameters and result key are required.'
      );
    }
    const safeParams = {};
    for (const name of ENRICHMENT_GSEA_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    request.body = { operation, params: safeParams, storage_key: resultStorageKey };
  }

  // 2f. Dataset-backed Seurat pipeline op: body reconstructed from ONLY
  // server-validated params and DB-resolved storage coordinates.
  if (spec.carriesSeuratDatasetParams) {
    const seurat = args.seuratPipeline;
    const params = seurat && typeof seurat === 'object' ? seurat.params : null;
    const datasetStorageKey = seurat && typeof seurat === 'object' ? seurat.datasetStorageKey : null;
    const datasetFileType = seurat && typeof seurat === 'object' ? seurat.datasetFileType : null;
    const checkpointStorageKey = seurat && typeof seurat === 'object' ? seurat.checkpointStorageKey : null;
    if (!params || typeof params !== 'object'
      || typeof datasetStorageKey !== 'string' || datasetStorageKey === ''
      || typeof datasetFileType !== 'string' || datasetFileType === ''
      || typeof checkpointStorageKey !== 'string' || checkpointStorageKey === '') {
      throw codedError('R_SEURAT_PIPELINE_PARAMS_REQUIRED',
        'Server-validated Seurat pipeline parameters and storage keys are required.');
    }
    const safeParams = {};
    for (const name of SEURAT_PIPELINE_PARAM_NAMES) {
      if (Object.prototype.hasOwnProperty.call(params, name)) safeParams[name] = params[name];
    }
    request.body = {
      operation,
      params: safeParams,
      dataset_storage_key: datasetStorageKey,
      dataset_file_type: datasetFileType,
      storage_key: checkpointStorageKey,
    };
  }

  // Every real output/live-state worker operation carries one deterministic,
  // server-derived receipt binding. R writes this receipt only after its atomic
  // output or live-state mutation succeeds. Raw job parameters are never read
  // for any binding field.
  const completionReceipt = buildCompletionReceiptBinding(job, operation, args);
  if (completionReceipt) {
    if (!request.body || typeof request.body !== 'object') {
      throw codedError('R_COMPLETION_RECEIPT_CONTEXT_REQUIRED', 'Completion receipt context is invalid.');
    }
    request.body.completion_receipt = completionReceipt;
  }

  if (logger && typeof logger.info === 'function') {
    // NB: never log the state key (an R state key); only the safe method/path.
    logger.info(`[r-bridge] running allowlisted operation '${operation}' (${spec.method} ${spec.path}).`);
  }

  // 3. Persist the no-safe-retry boundary immediately before the actual HTTP
  // dispatch. A process crash after this point must become receipt-only recovery,
  // never a second scientific execution. The callback is claim-guarded by the DB.
  if (completionReceipt) {
    if (typeof args.markRDispatchStarted !== 'function') {
      throw codedError(
        'R_DISPATCH_MARKER_REQUIRED',
        'Receipt-backed R dispatch could not be marked safely.'
      );
    }
    await args.markRDispatchStarted();
  }

  // Call R, mapping any failure to a sanitized, coded error. Once the durable
  // marker has been written, every caller/response failure is side-effect-possible.
  let response;
  try {
    response = await callR(request);
  } catch (err) {
    const safe = sanitizeRBridgeError(err);
    // Server-side diagnostic: the low-level code (timeout/ECONNREFUSED/etc.) for the
    // operation. Never the raw error text; the thrown/public message stays sanitized.
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[r-bridge] operation '${operation}' (${spec.method} ${spec.path}) call failed: ${safe.code}.`);
    }
    const bridgeError = codedError(safe.code, safe.message);
    throw completionReceipt ? markRSideEffectsPossible(bridgeError) : bridgeError;
  }

  if (!response || response.status !== 200) {
    // Never include the raw body/status text — only a generic, stable message.
    let failCode = 'R_RUNTIME_CHECK_FAILED';
    if (spec.carriesParams) failCode = 'R_PBMC_PIPELINE_FAILED';
    else if (spec.carriesCheckpoint) failCode = 'R_CHECKPOINT_LOAD_FAILED';
    else if (spec.carriesDegParams) failCode = 'R_DEG_FIND_MARKERS_FAILED';
    else if (spec.carriesEnrichmentParams) failCode = 'R_ENRICHMENT_GSEA_FAILED';
    else if (spec.carriesSeuratDatasetParams) failCode = 'R_SEURAT_PIPELINE_FAILED';
    else if (spec.requiresObjectContext) failCode = 'R_OBJECT_INSPECT_FAILED';
    // Server-side diagnostic: the R HTTP status + our coded reason (never the R body,
    // which the R endpoint already logs in full to its own stderr). Pairs with the
    // plumber-side message() so a failure is traceable across both processes.
    const rStatus = response ? response.status : null;
    const rCode = sanitizeRDiagnosticCode(response && response.body && response.body.code);
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[r-bridge] operation '${operation}' (${spec.method} ${spec.path}) got R status ${rStatus || 'none'}${rCode ? ` (${rCode})` : ''} -> ${failCode}.`);
    }
    const err = codedError(failCode, sanitizeRBridgeError({ code: failCode }).message);
    err.rStatus = rStatus;
    err.rCode = rCode;
    throw completionReceipt ? markRSideEffectsPossible(err) : err;
  }

  // 4. Build SAFE, metadata-only artifact metadata. Only a small, sanitized allowlist
  //    of fields is kept; everything else from the R response is dropped.
  if (completionReceipt && !isPlainObject(response.body)) {
    throw markRSideEffectsPossible(codedError(
      'R_RESPONSE_INVALID',
      'R runtime returned an invalid response.'
    ));
  }
  const body = response.body && typeof response.body === 'object' ? response.body : {};

  if (operation === 'r.pbmc.pipeline.v1') {
    // The bridge returns the SANITIZED pieces the worker needs; the worker (not the
    // bridge) writes the DB result object + artifacts. checkpoint carries only save
    // success + integrity (checksum/size) — never the storage path/key.
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    if (checkpoint.saved === true && !checkpoint.checksumSha256) {
      throw markRSideEffectsPossible(codedError(
        'R_RESPONSE_INVALID',
        'R runtime returned an invalid response.'
      ));
    }
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

  if (operation === 'r.checkpoint.load.v1') {
    // The bridge returns the SANITIZED load summary the worker needs; the worker (not
    // the bridge) writes the metadata-only checkpoint_load artifact. The summary carries
    // only load success + verification + a bounded object summary — never the storage
    // path/key (the worker already holds it internally and keeps it private).
    const loaded = sanitizeLoadSummary(body);
    if (loaded.loaded === true && (loaded.checksumVerified !== true
        || !loaded.runtimeInstanceHash)) {
      throw markRSideEffectsPossible(codedError(
        'R_RESPONSE_INVALID',
        'R runtime returned an invalid response.'
      ));
    }
    return {
      operation,
      artifactType: spec.artifactType, // 'checkpoint_load'
      storageKind: 'metadata_only',
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: objectContext.objectId,
      loaded,
      metadata: {
        operation,
        kind: 'checkpoint_load',
        scientific_output: false,
        live_state_mutation: true,
        loadedAt: new Date().toISOString(),
        // The analysis object id is a normal member-visible resource id — NOT the R
        // state key (the state key is never placed in metadata).
        objectId: objectContext.objectId,
        loaded,
      },
    };
  }

  if (operation === 'r.deg.find_markers.v1') {
    // The bridge returns the SANITIZED pieces the worker needs; the worker (not the bridge)
    // writes the DB artifacts. `result` carries only file save success + integrity
    // (checksum/size/rows) — never the storage path/key. `summary` is a bounded, safe-column
    // marker summary. Resolved params are added by the worker (which holds the validated set).
    const summary = sanitizeDegSummary(body);
    const result = sanitizeDegResultInfo(body);
    if (result.saved === true && !result.checksumSha256) {
      throw markRSideEffectsPossible(codedError(
        'R_RESPONSE_INVALID',
        'R runtime returned an invalid response.'
      ));
    }
    return {
      operation,
      artifactType: spec.artifactType, // 'deg_summary'
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: objectContext.objectId,
      summary,
      result,
      metadata: {
        operation,
        kind: 'deg_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        // The analysis object id is a normal member-visible resource id — NOT the R state key.
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.enrichment.gsea.v1') {
    const summary = sanitizeEnrichmentSummary(body);
    const result = sanitizeEnrichmentResultInfo(body);
    if (result.saved === true && (!result.checksumSha256
        || result.sizeBytes === null || result.nRows === null)) {
      throw markRSideEffectsPossible(codedError(
        'R_RESPONSE_INVALID',
        'R runtime returned an invalid response.'
      ));
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      objectId: objectContext.objectId,
      summary,
      result,
      metadata: {
        operation,
        kind: 'enrichment_summary',
        scientific_output: true,
        downloadable: false,
        ranAt: new Date().toISOString(),
        objectId: objectContext.objectId,
        summary,
      },
    };
  }

  if (operation === 'r.seurat.pipeline.v1') {
    const summary = sanitizePipelineSummary(body);
    const checkpoint = sanitizeCheckpointInfo(body);
    if (checkpoint.saved === true && !checkpoint.checksumSha256) {
      throw markRSideEffectsPossible(codedError(
        'R_RESPONSE_INVALID',
        'R runtime returned an invalid response.'
      ));
    }
    return {
      operation,
      artifactType: spec.artifactType,
      name: spec.artifactName,
      description: spec.artifactDescription,
      resultObjectType: 'seurat',
      summary,
      checkpoint,
      metadata: {
        operation,
        kind: 'pipeline',
        scientific_output: true,
        ranAt: new Date().toISOString(),
        summary,
        warnings: sanitizeNameList(body.warnings, 32, 160),
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
  sanitizeLoadSummary,
  sanitizeStatNumber,
  sanitizeDegSummary,
  sanitizeDegResultInfo,
  sanitizeEnrichmentSummary,
  sanitizeEnrichmentResultInfo,
  createCompletionReceiptEnvelope,
  verifyCompletionReceiptEnvelope,
  buildCompletionReceiptBinding,
  descriptorFromCompletionReceipt,
  sanitizeRBridgeError,
  createDefaultRCaller,
  runRBridgeOperation,
};
