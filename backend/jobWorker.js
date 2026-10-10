// ── Minimal job worker drain loop ────────────────────────────────────────────
//
// The smallest production-oriented worker that consumes the durable job-worker
// coordination contract shipped in pgDatabase.js (claim / lease / heartbeat /
// complete / fail / release / reap). It proves a queued job can be claimed,
// heartbeated, completed or failed, protected from duplicate workers, and handled
// safely after cancellation or lease expiry — with durable status + logs.
//
// SCOPE: the registry has grown beyond a noop. Registered handlers now include a
// safe `generic` noop, a metadata-only `checkpoint.noop`, read-only R inspection
// (`r.runtime.check`, `r.object.inspect`), and REAL scientific/R work:
// `pbmc.pipeline.v1` and `seurat.pipeline.v1` (preprocessing with a durable
// checkpoint), `checkpoint.load.v1` (owner-only reattach), `checkpoint.fork.v1`
// (new loader-owned object), and `deg.find_markers.v1` (DEG/FindAllMarkers). See
// DEFAULT_HANDLERS below for the
// authoritative list. Every other (otherwise valid) job type is intentionally
// UNREGISTERED and is failed with UNSUPPORTED_JOB_TYPE — see the handler-registry
// policy below. NO handler executes arbitrary/client-supplied R, and every R-facing
// handler verifies live-object ownership BEFORE any R contact.
//
// HANDLER-REGISTRY POLICY (preferred policy from the contract):
//   The worker only runs job types present in its handler registry. An unknown /
//   unregistered job type is still CLAIMED, then immediately FAILED with a durable
//   `UNSUPPORTED_JOB_TYPE` error. This is deliberate: it prevents an unsupported
//   job from looping forever (claim → release → claim …) and records why it could
//   not run. Because claim consumes an attempt and failJobByWorker is terminal, an
//   unsupported job ends in `failed`, never re-queued.
//
// CANCELLATION (cooperative / status-level only): canceling a job
//   clears its claim_token + lease and moves it to a terminal status. The worker
//   therefore loses its claim; its next heartbeat/complete/fail throws CLAIM_LOST
//   and the worker stops touching the job (it is NEVER resurrected to completed).
//   This does NOT kill in-flight R work that a registered R-facing handler has
//   already started.

const crypto = require('crypto');
const database = require('./pgDatabase');
const rWorkerBridge = require('./rWorkerBridge');
const storage = require('./storage');
const { validatePbmcPipelineParams, allocateCheckpointStorageKey } = require('./pbmcPipeline');
const { validateDegFindMarkersParams, allocateDegResultStorageKey } = require('./degFindMarkers');
const {
  validateEnrichmentGseaParams,
  allocateEnrichmentGseaResultStorageKey,
} = require('./enrichmentGsea');
const {
  validateCellChatInferenceParams,
  allocateCellChatInferenceResultStorageKey,
  MAX_CELLCHAT_RESULT_ROWS,
} = require('./cellChatInference');
const {
  validateSeuratPipelineParams,
  allocateSeuratCheckpointStorageKey,
  assertSupportedSeuratPipelineDataset,
} = require('./seuratPipeline');
const {
  validateMultiSampleSeuratParams,
  allocateMultiSampleSeuratCheckpointStorageKey,
  assertSupportedMultiSampleDatasets,
} = require('./multiSampleSeuratPipeline');
const {
  validateSpatialSeuratParams,
  allocateSpatialSeuratCheckpointStorageKey,
  assertSupportedSpatialSeuratDataset,
} = require('./spatialPipeline');
const { validateExploratoryAnalysisParams } = require('./exploratoryAnalysis');
const { derivedAnalysisDisplayName } = require('./analysisDisplayName');
const {
  validateConditionComparisonParams,
  allocateConditionComparisonResultStorageKey,
} = require('./conditionComparison');
const {
  validateExpertRParams,
  allocateExpertRBundleStorageKey,
  MAX_EXPERT_R_OUTPUT_BYTES,
  MAX_EXPERT_R_BUNDLE_BYTES,
  EXPERT_R_RESOURCE_POLICY_VERSION,
} = require('./expertR');
const { assertEnvironmentMatches, MAX_ENVIRONMENT_BYTES } = require('./rEnvironment');
const { observedRuntimeMetadata } = require('./executionHistoryProjection');

/** Stable, header-safe worker id (`worker_` + hex). One per worker instance. */
function generateWorkerId() {
  return `worker_${crypto.randomBytes(8).toString('hex')}`;
}

// Error code recorded on a job whose type has no registered handler.
const UNSUPPORTED_JOB_TYPE = 'UNSUPPORTED_JOB_TYPE';
const R_TIMEOUT_INDETERMINATE = 'R_TIMEOUT_INDETERMINATE';
const R_TIMEOUT_RECOVERY_PENDING = 'R_TIMEOUT_RECOVERY_PENDING';
const R_RETRY_RECOVERY_PENDING = 'R_RETRY_RECOVERY_PENDING';
const COMMITTED_OUTPUT_RECOVERY_PENDING = 'COMMITTED_OUTPUT_RECOVERY_PENDING';
const R_COMPLETION_PUBLICATION_INDETERMINATE = 'R_COMPLETION_PUBLICATION_INDETERMINATE';
const R_TIMEOUT_RECOVERY_GRACE_SECONDS = 300;
const COMPLETION_RECEIPT_JOB_TYPES = new Set([
  'pbmc.pipeline.v1',
  'seurat.pipeline.v1',
  'seurat.multisample.v1',
  'spatial.seurat.v1',
  'checkpoint.save.v1',
  'deg.find_markers.v1',
  'enrichment.gsea.v1',
  'cellchat.infer.v1',
  'condition.pseudobulk_de.v1',
  'checkpoint.load.v1',
  'checkpoint.fork.v1',
]);
const SAFE_HANDLER_DOMAIN_MESSAGES = Object.freeze({
  ANALYSIS_OBJECT_NOT_FOUND: 'Analysis object not found.',
  CELLCHAT_PACKAGES_UNAVAILABLE: 'CellChat is unavailable in the current analysis runtime. Ask an operator to enable the required package profile.',
  CELLCHAT_GROUPING_UNAVAILABLE: 'CellChat needs valid clustering or identity labels. Run clustering or choose current identities and try again.',
  CELLCHAT_GROUP_COUNT_INVALID: 'CellChat needs between two and 32 populated groups. Review the selected grouping and try again.',
  CELLCHAT_MIN_GROUP_CELLS: 'At least two groups must meet the minimum cell threshold. Lower the threshold or revise the grouping.',
  CELLCHAT_ASSAY_UNAVAILABLE: 'CellChat requires an RNA assay in the saved analysis.',
  CELLCHAT_NORMALIZED_DATA_REQUIRED: 'CellChat requires normalized RNA data. Run normalization and try again.',
  CELLCHAT_DATABASE_OVERLAP_LOW: 'Too few signaling genes overlap the selected CellChat database. Check the species and RNA assay.',
  CELLCHAT_NO_ELIGIBLE_INTERACTIONS: 'No eligible ligand-receptor pairs remain for this input and database. No communication result was calculated.',
  CELLCHAT_INPUT_INVALID: 'CellChat could not construct a valid input. Review the grouping, assay, species, and saved analysis.',
  ENRICHMENT_PACKAGES_UNAVAILABLE: 'Pathway enrichment is unavailable in the current compute profile. Ask an operator to install the approved enrichment package profile.',
});

/** Coded handler error carrying a stable, SAFE message. Handlers throw these for
 *  pre-R validation failures; the message is durable (failHandlerError records it),
 *  so it must never contain secrets, paths, or another user's existence details. */
function codedHandlerError(code, message) {
  const err = new Error(message);
  err.code = code;
  Object.defineProperty(err, 'publicSafeHandlerError', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return err;
}

function safeDiagnosticCode(error) {
  if (!error || typeof error.code !== 'string') return 'UNCLASSIFIED';
  return error.code.replace(/[^A-Z0-9_:-]/gi, '').slice(0, 80) || 'UNCLASSIFIED';
}

function isIndeterminateRExecutionFailure(error) {
  // Once a receipt-backed R request has been marked for dispatch, no response-side
  // failure proves that synchronous R work stopped. This includes oversized or
  // malformed responses and non-200 statuses, not only timeouts/disconnects.
  return !!error && (error.rSideEffectsPossible === true
    || error.code === 'R_TIMEOUT'
    || error.code === 'R_UNREACHABLE'
    || error.code === R_COMPLETION_PUBLICATION_INDETERMINATE);
}

function publicationIndeterminateError(error) {
  if (error && (error.code === 'CLAIM_LOST' || error.code === 'JOB_NOT_FOUND')) return error;
  return codedHandlerError(
    R_COMPLETION_PUBLICATION_INDETERMINATE,
    'Completion publication outcome is indeterminate.'
  );
}

async function discardUnrecordedProjectOutput(ctx, key, cause = null) {
  // A local HTTP timeout or disconnect does not prove R stopped. Removing the server-owned
  // destination here can race an R process that is still publishing its output.
  // Preserve it for the bounded recovery-only pass instead.
  if (isIndeterminateRExecutionFailure(cause)) return;
  if (!storage.isProjectStorageKey(key) || typeof ctx.removeDurableObject !== 'function') return;
  try {
    await ctx.removeDurableObject(key);
  } catch {
    // Best effort only. Preserve the original handler error.
  }
}

async function removeRetryOrphanOutput(ctx, key) {
  if (ctx.recoveringCompletionReceipt
      || !ctx.job || Number(ctx.job.attempts || 0) <= 1) return;
  if (!storage.isProjectStorageKey(key) || typeof ctx.removeDurableObject !== 'function') {
    throw codedHandlerError('RETRY_CLEANUP_FAILED', 'A prior job attempt could not be prepared safely.');
  }
  try {
    await ctx.removeDurableObject(key);
  } catch {
    throw codedHandlerError('RETRY_CLEANUP_FAILED', 'A prior job attempt could not be prepared safely.');
  }
}

function deriveCheckpointForkResultObjectId(jobId) {
  if (typeof jobId !== 'string' || jobId === '') {
    throw codedHandlerError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  return `ao_${crypto.createHash('sha256')
    .update('checkpoint-fork-result-v1:')
    .update(jobId)
    .digest('hex')}`;
}

function deterministicCompletionOutputKey(job) {
  if (!job || !COMPLETION_RECEIPT_JOB_TYPES.has(job.jobType)) return null;
  if (job.jobType === 'pbmc.pipeline.v1') {
    return allocateCheckpointStorageKey(job.projectId, job.id);
  }
  if (job.jobType === 'seurat.pipeline.v1') {
    return allocateSeuratCheckpointStorageKey(job.projectId, job.id);
  }
  if (job.jobType === 'seurat.multisample.v1') {
    return allocateMultiSampleSeuratCheckpointStorageKey(job.projectId, job.id);
  }
  if (job.jobType === 'spatial.seurat.v1') {
    return allocateSpatialSeuratCheckpointStorageKey(job.projectId, job.id);
  }
  if (job.jobType === 'checkpoint.save.v1') {
    return allocateCheckpointStorageKey(job.projectId, job.id);
  }
  if (job.jobType === 'deg.find_markers.v1') {
    return allocateDegResultStorageKey(job.projectId, job.id);
  }
  if (job.jobType === 'enrichment.gsea.v1') {
    return allocateEnrichmentGseaResultStorageKey(job.projectId, job.id);
  }
  if (job.jobType === 'cellchat.infer.v1') {
    return allocateCellChatInferenceResultStorageKey(job.projectId, job.id);
  }
  if (job.jobType === 'condition.pseudobulk_de.v1') {
    return allocateConditionComparisonResultStorageKey(job.projectId, job.id);
  }
  return null;
}

async function completionReceiptExpectation(ctx) {
  const job = ctx.job;
  const outputStorageKey = deterministicCompletionOutputKey(job);
  if (outputStorageKey) return { outputStorageKey };
  if (job.jobType === 'checkpoint.load.v1') {
    const checkpoint = await ctx.getLoadableCheckpoint();
    if (!checkpoint || checkpoint.analysisObjectId !== job.analysisObjectId
        || checkpoint.projectId !== job.projectId
        || typeof checkpoint.checkpointArtifactId !== 'string') {
      throw codedHandlerError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      sourceCheckpointArtifactId: checkpoint.checkpointArtifactId,
      targetAnalysisObjectId: job.analysisObjectId,
    };
  }
  if (job.jobType === 'checkpoint.fork.v1') {
    const checkpoint = await ctx.getForkableCheckpoint();
    if (!checkpoint || checkpoint.analysisObjectId !== job.analysisObjectId
        || checkpoint.projectId !== job.projectId
        || typeof checkpoint.checkpointArtifactId !== 'string') {
      throw codedHandlerError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      sourceCheckpointArtifactId: checkpoint.checkpointArtifactId,
      targetAnalysisObjectId: deriveCheckpointForkResultObjectId(job.id),
    };
  }
  return null;
}

async function bestEffortRemoveCompletionReceipt(storageProvider, job) {
  if (!job || !COMPLETION_RECEIPT_JOB_TYPES.has(job.jobType)) return;
  try {
    await storageProvider.remove(storage.completionReceiptKey(job.projectId, job.id));
  } catch {
    // Receipt deletion is housekeeping after a guarded DB transition. Never
    // overwrite the authoritative outcome with a cleanup error.
  }
}

async function bestEffortRemoveRecoveryObjects(storageProvider, job, { output = true } = {}) {
  if (output) {
    const outputKey = deterministicCompletionOutputKey(job);
    if (outputKey) {
      try { await storageProvider.remove(outputKey); } catch { /* best effort */ }
    }
  }
  await bestEffortRemoveCompletionReceipt(storageProvider, job);
}

// Documented safe defaults for worker runtime config. These MUST match the values
// documented in .env.example (JOB_WORKER_POLL_MS / JOB_WORKER_LEASE_SECONDS) and the
// createJobWorker() option defaults above.
// leaseSeconds default is generous because real R compute jobs (Seurat pipeline,
// DEG, checkpoint load) run tens of seconds to minutes; the in-flight lease renewal
// in the runRBridgeOperation ctx seam keeps longer runs alive, and this default is the
// safety floor for the pre-handler window. Override with JOB_WORKER_LEASE_SECONDS.
const JOB_WORKER_DEFAULTS = Object.freeze({ pollIntervalMs: 1000, leaseSeconds: 120 });
const JOB_WORKER_MIN_LEASE_SECONDS = 10;

/**
 * Parse a value that must be a positive integer (poll ms / lease seconds). Returns
 * the integer, or null for anything invalid: undefined/null, blank, non-numeric,
 * NaN, Infinity, non-integer, zero, or negative. Callers decide the fallback/fail
 * policy. (Zero is rejected: a zero poll interval would busy-loop and a zero lease
 * would expire instantly, so neither is a meaningful runtime value here.)
 */
function parsePositiveIntOrNull(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Parse worker runtime config from an environment-like object, deterministically and
 * safely. Policy (also reflected in .env.example):
 *   - `enabled` is true ONLY for the exact string "true" on ENABLE_JOB_WORKER. Any
 *     other value ("TRUE", "1", "yes", blank, unset, …) means disabled.
 *   - JOB_WORKER_POLL_MS must be a positive integer; otherwise fall back to the
 *     documented default and warn (only if the var was present but invalid).
 *   - JOB_WORKER_LEASE_SECONDS must be an integer of at least 10 seconds; otherwise
 *     fall back to the documented default and warn (only if present but invalid).
 * Warnings name the variable and the default used — never the raw value — so no
 * secret or operator-supplied content is echoed. Returns
 * { enabled, pollIntervalMs, leaseSeconds }.
 */
function parseJobWorkerConfig(env = {}, opts = {}) {
  const defaults = opts.defaults || JOB_WORKER_DEFAULTS;
  const logger = opts.logger || console;
  const warn = (m) => { if (logger && typeof logger.warn === 'function') logger.warn(m); };

  const enabled = env.ENABLE_JOB_WORKER === 'true';

  const pollRaw = env.JOB_WORKER_POLL_MS;
  let pollIntervalMs = parsePositiveIntOrNull(pollRaw);
  if (pollIntervalMs === null) {
    if (pollRaw !== undefined) {
      warn(`[worker] JOB_WORKER_POLL_MS is not a positive integer; using default ${defaults.pollIntervalMs}ms.`);
    }
    pollIntervalMs = defaults.pollIntervalMs;
  }

  const leaseRaw = env.JOB_WORKER_LEASE_SECONDS;
  let leaseSeconds = parsePositiveIntOrNull(leaseRaw);
  if (leaseSeconds === null || leaseSeconds < JOB_WORKER_MIN_LEASE_SECONDS) {
    if (leaseRaw !== undefined) {
      warn(`[worker] JOB_WORKER_LEASE_SECONDS must be an integer of at least ${JOB_WORKER_MIN_LEASE_SECONDS}; using default ${defaults.leaseSeconds}s.`);
    }
    leaseSeconds = defaults.leaseSeconds;
  }

  return { enabled, pollIntervalMs, leaseSeconds };
}

/**
 * Safe, deterministic noop handler: it
 * heartbeats once (proving the cooperative heartbeat seam works), writes a durable
 * log line, and returns a tiny JSON result. It runs NO R/Seurat work and touches
 * NO shared state. Handlers receive a `ctx` with:
 *   - ctx.job       the claimed worker-job (includes jobType, parameters)
 *   - ctx.workerId  this worker's id
 *   - ctx.heartbeat()  extend the lease mid-run (throws CLAIM_LOST if claim is gone)
 *   - ctx.log(entry)   append a durable, claim-guarded progress log (best-effort)
 *   - ctx.logger    the process logger (non-durable)
 * A handler returns `{ result?, resultAnalysisObjectId? }` (or nothing). It must
 * NOT put secrets, tokens, or filesystem paths into thrown error messages or logs.
 */
async function genericNoopHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'noop handler: no pipeline execution in this branch.' });
  return { result: { ok: true, handled: 'generic', noop: true } };
}

/**
 * Test-safe placeholder handler that exercises the durable artifact/checkpoint
 * wiring WITHOUT any R/Seurat work. It:
 *   - heartbeats (proving the cooperative seam),
 *   - creates a NEW immutable result analysis object (a checkpoint), atomically
 *     linked back to the job — the parent object is never mutated,
 *   - records a metadata-only `checkpoint` artifact referencing that result object,
 *   - writes durable progress logs.
 * Everything it writes is clearly labelled placeholder / metadata-only / test-safe:
 * it runs NO R, fabricates NO scientific metrics, creates NO downloadable file, and
 * exposes NO path. The result object's id is returned so the contract's
 * completeJobByWorker keeps the link the checkpoint helper already made.
 */
async function checkpointNoopHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'checkpoint.noop handler: creating placeholder, metadata-only checkpoint (no R/Seurat execution).' });

  const checkpoint = await ctx.createCheckpoint({
    objectType: 'generic',
    displayName: 'Placeholder checkpoint (no pipeline execution)',
    metadata: { placeholder: true, checkpoint: true, source: 'checkpoint.noop', scientific_output: false }
  });

  const artifact = await ctx.createArtifact({
    artifactType: 'checkpoint',
    resultAnalysisObjectId: checkpoint.id,
    name: 'Placeholder checkpoint metadata',
    description: 'Metadata-only checkpoint record. No raw artifact, no download, no real scientific output in this branch.',
    storageKind: 'metadata_only',
    metadata: { placeholder: true, scientific_output: false }
  });

  await ctx.log({ level: 'info', message: `checkpoint.noop handler: recorded checkpoint ${checkpoint.id} and artifact ${artifact.id} (metadata-only).` });

  // The checkpoint helper already linked result_analysis_object_id on the job; return
  // it so completion is explicit (completeJobByWorker re-validates the same id).
  return {
    resultAnalysisObjectId: checkpoint.id,
    result: { ok: true, handled: 'checkpoint.noop', placeholder: true, checkpointId: checkpoint.id, artifactId: artifact.id }
  };
}

/**
 * Minimal runtime-check bridge handler. It runs the allowlisted, read-only,
 * metadata-only `r.runtime.check` operation through the server-controlled bridge
 * (backend/rWorkerBridge.js)
 * and records a metadata-only `r_runtime_check` artifact describing the sanitized R
 * runtime status. It:
 *   - heartbeats (proving the cooperative seam),
 *   - invokes the bridge with a SERVER-DERIVED operation + job context — the job's
 *     own parameters are NOT used to choose the operation/path/code (the bridge
 *     ignores per-job input for this op),
 *   - records ONE metadata-only artifact on success,
 *   - creates NO checkpoint / result analysis object, touches NO analysis-object or
 *     live-R state, fabricates NO scientific metric, exposes NO path/download.
 * Bridge errors arrive pre-sanitized (safe message + code), so failing the job never
 * leaks raw R errors/stacks/internal URLs.
 */
async function rRuntimeCheckHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'r.runtime.check handler: invoking allowlisted, metadata-only R runtime check (no pipeline execution).' });

  const descriptor = await ctx.runRBridgeOperation({
    job: ctx.job,
    operation: 'r.runtime.check',
    // Actor/context derived from the trusted job row, never from client input.
    actor: { userId: ctx.job.ownerUserId, projectId: ctx.job.projectId || null },
    input: ctx.job.parameters, // passed for completeness; the bridge IGNORES it (server-derived).
    claimContext: { workerId: ctx.workerId },
    logger: ctx.logger,
    callR: ctx.callR,
  });

  const artifact = await ctx.createArtifact({
    artifactType: descriptor.artifactType, // 'r_runtime_check'
    name: descriptor.name,
    description: descriptor.description,
    storageKind: descriptor.storageKind, // 'metadata_only'
    metadata: descriptor.metadata,
  });

  await ctx.log({ level: 'info', message: `r.runtime.check handler: recorded metadata-only artifact ${artifact.id} (operational inspection, not a scientific output).` });

  // No result analysis object / checkpoint: this is a non-mutating inspection.
  return {
    result: { ok: true, handled: 'r.runtime.check', operation: 'r.runtime.check', artifactId: artifact.id }
  };
}

/**
 * Read-only worker-to-R object inspection handler. It inspects ONE existing object
 * via the allowlisted, read-only `r.object.inspect` bridge operation and records a
 * metadata-only `r_object_inspection` artifact (sanitized object summary).
 *
 * CENTRAL OWNERSHIP BOUNDARY (project membership ≠ live R access):
 *   The object id comes from the TRUSTED job row (job.analysisObjectId), never from
 *   client passthrough. Before ANY R contact, the handler verifies the JOB CREATOR
 *   (job.ownerUserId) OWNS that analysis object via a claim-authorized resolver that
 *   enforces the same ownership rule as the /api/r/* proxy. A project co-member (even an
 *   admin) who created a job against another member's object therefore FAILS here —
 *   owning the project metadata never grants live R object access. The R state key
 *   (X-Object-ID) is SERVER-DERIVED from the owner + object id (deriveRObjectStateKey,
 *   injected by the server) and never client-provided.
 *
 * It:
 *   - heartbeats (proving the cooperative seam),
 *   - validates object presence + owner BEFORE contacting R (fails safely otherwise),
 *   - invokes the bridge with a SERVER-DERIVED operation + object context,
 *   - records ONE metadata-only artifact on success,
 *   - mutates NOTHING in R, creates NO checkpoint / result analysis object, exposes
 *     NO path/download/state key, fabricates NO scientific metric.
 * Bridge errors arrive pre-sanitized (safe message + code).
 */
async function rObjectInspectHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'r.object.inspect handler: validating object ownership before any R contact (read-only inspection, no pipeline execution).' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an analysis object. Fail safely BEFORE any R contact.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Inspection job is missing its analysis object.');
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may inspect.
  //    The worker-only resolver binds the lookup to this job's valid claim and exact
  //    project scope without re-reading membership after claim. Uses a 404-style
  //    message so we never reveal another user's object exists.
  if (typeof ctx.getOwnedAnalysisObject !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }

  // 3. Derive the R state key (X-Object-ID) SERVER-SIDE from the verified owner +
  //    object id. Never client-provided. Injected by the server so deriveRStateKey
  //    stays the single source of truth (no client controls the user-prefix).
  if (typeof ctx.deriveRObjectStateKey !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  const descriptor = await ctx.runRBridgeOperation({
    job,
    operation: 'r.object.inspect',
    actor: { userId: job.ownerUserId, projectId: job.projectId || null },
    // SERVER-DERIVED object context: the bridge reads object id/state key only from
    // here, never from job parameters / client input.
    objectContext: { objectId, stateKey },
    input: job.parameters, // passed for completeness; the bridge IGNORES it for routing.
    claimContext: { workerId: ctx.workerId },
    logger: ctx.logger,
    callR: ctx.callR,
  });

  const artifact = await ctx.createArtifact({
    artifactType: descriptor.artifactType, // 'r_object_inspection'
    // Associate the artifact with the inspected object (defaults to the job's own
    // analysis object, which is already same-scope) — metadata link only, not access.
    name: descriptor.name,
    description: descriptor.description,
    storageKind: descriptor.storageKind, // 'metadata_only'
    metadata: descriptor.metadata,
  });

  await ctx.log({ level: 'info', message: `r.object.inspect handler: recorded metadata-only artifact ${artifact.id} (read-only inspection, not a scientific output).` });

  // No result analysis object / checkpoint: this is a non-mutating inspection.
  return {
    result: { ok: true, handled: 'r.object.inspect', operation: 'r.object.inspect', artifactId: artifact.id }
  };
}

/**
 * PBMC/Seurat pipeline handler: the FIRST handler that runs a real scientific pipeline
 * and produces a durable result. It wraps the existing plumber.R preprocessing path
 * (normalize → variable features → scale → PCA → neighbors → clusters → UMAP) as ONE
 * allowlisted, mutating bridge operation that runs on a COPY of the input object — the
 * parent is NEVER mutated and remains a stable checkpoint.
 *
 * SAME OWNERSHIP BOUNDARY as r.object.inspect (project membership ≠ live R access):
 *   the input object id comes from the TRUSTED job row; the job creator must OWN that
 *   live object through a claim-authorized, owner/project-bound resolver BEFORE R contact, and the R state key
 *   (X-Object-ID) is SERVER-DERIVED (deriveRObjectStateKey). A co-member/admin who
 *   created a job against another user's object FAILS here.
 *
 * Order (all DB result/edge/artifact records are created only AFTER R success):
 *   1. heartbeat; require + own the input object; derive its state key (all before R)
 *   2. validate parameters against the fixed allowlist (backend/pbmcPipeline.js) —
 *      invalid params fail the job here, BEFORE any R mutation
 *   3. allocate a SERVER-controlled internal checkpoint key (no client input)
 *   4. invoke the allowlisted `r.pbmc.pipeline.v1` bridge op (server-built body)
 *   5. require a durable checkpoint save (saved + checksum) — else fail (no result)
 *   6. create the result analysis object + checkpoint lineage edge (parent→result)
 *   7. record a local_internal `checkpoint` artifact (key/checksum/size internal) and
 *      a metadata-only `pipeline_summary` artifact (resolved params + summary)
 * On failure/cancel/claim-loss no successful result object/edge/artifact is created;
 * the claim guard makes two workers unable to duplicate any of them. Bridge errors
 * arrive pre-sanitized (no raw R error/stack/internal URL/state key).
 */
async function pbmcPipelineHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'pbmc.pipeline.v1 handler: validating ownership + parameters before any R contact.' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an input analysis object. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Pipeline job is missing its input analysis object.');
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may run the
  //    pipeline. The worker-only resolver also binds the lookup to this job's valid
  //    claim and exact project scope; 404-style message avoids existence disclosure.
  if (typeof ctx.getOwnedAnalysisObject !== 'function' || typeof ctx.deriveRObjectStateKey !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }

  // 3. Derive the input object's R state key (X-Object-ID) SERVER-SIDE. Never client-
  //    provided; identical to what /api/r/* would send for this owner+object.
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  // 4. Validate + resolve parameters against the fixed allowlist BEFORE any R mutation.
  //    Throws a coded, SAFE-message error (INVALID_PARAMETER / UNKNOWN_PARAMETER / …)
  //    that fails the job terminally without contacting R.
  const { params, defaultsApplied } = validatePbmcPipelineParams(job.parameters);

  // 5. Server-allocate the internal checkpoint storage key (no client input; relative,
  //    traversal-free; the R backend confines it to project storage). Never logged/exposed.
  const checkpointStorageKey = allocateCheckpointStorageKey(job.projectId, job.id);
  await removeRetryOrphanOutput(ctx, checkpointStorageKey);

  await ctx.log({ level: 'info', message: 'pbmc.pipeline.v1 handler: parameters valid; invoking allowlisted PBMC pipeline on a copy of the input object (parent unchanged).' });

  // 6. Run the allowlisted, mutating bridge op. Object context + params body are all
  //    server-derived; the bridge ignores raw job input for routing.
  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation: 'r.pbmc.pipeline.v1',
      actor: { userId: job.ownerUserId, projectId: job.projectId || null },
      objectContext: { objectId, stateKey },
      pipeline: { params, checkpointStorageKey },
      input: job.parameters, // passed for completeness; the bridge IGNORES it for routing.
      claimContext: { workerId: ctx.workerId },
      logger: ctx.logger,
      callR: ctx.callR,
    });
  } catch (err) {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey, err);
    throw err;
  }

  // 7. A durable checkpoint MUST have been saved (with integrity) for success. If not,
  //    fail BEFORE creating any DB result — so a missing/failed save leaves no result
  //    object, edge, or artifact behind (nothing to roll back).
  const checkpoint = descriptor.checkpoint || {};
  if (checkpoint.saved !== true || typeof checkpoint.checksumSha256 !== 'string' || checkpoint.checksumSha256 === '') {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey);
    throw codedHandlerError('CHECKPOINT_SAVE_FAILED', 'Pipeline did not produce a durable checkpoint.');
  }

  // 8. Create the result analysis object (a CHILD checkpoint of the input object), the
  //    job result link, the parent→result lineage edge, AND both required artifacts
  //    (local_internal checkpoint + metadata_only pipeline_summary) in ONE atomic,
  //    claim/lease-guarded DB transaction. Either all five durable records commit
  //    together or none do — a failure can never leave a failed job linked to a result
  //    object/edge with missing artifacts. The parent is never mutated; result metadata
  //    records provenance WITHOUT implying a download.
  let completion;
  try {
    completion = await ctx.completePbmcPipelineResult({
    result: {
      objectType: descriptor.resultObjectType || 'seurat',
      displayName: 'PBMC pipeline result',
      metadata: {
        source: 'pbmc.pipeline.v1',
        operation: 'r.pbmc.pipeline.v1',
        scientific_output: true,
        checkpoint: { available: true, storage_kind: 'local_internal', downloadable: false },
        resolvedParams: params,
        defaultsApplied,
        summary: descriptor.summary,
      },
    },
    // Durable checkpoint artifact (local_internal): server-allocated key (stored
    // internally, stripped from public responses) + integrity checksum/size.
    checkpointArtifact: {
      artifactType: 'checkpoint',
      name: 'PBMC pipeline checkpoint',
      description: 'Durable internal checkpoint of the PBMC pipeline result object. No public download in this branch.',
      storageKind: 'local_internal',
      internalStorageKey: checkpointStorageKey,
      checksumSha256: checkpoint.checksumSha256,
      sizeBytes: checkpoint.sizeBytes != null ? checkpoint.sizeBytes : 0,
      metadata: { operation: 'r.pbmc.pipeline.v1', scientific_output: true, downloadable: false },
    },
    // Metadata-only pipeline summary artifact (resolved params + sanitized summary).
    summaryArtifact: {
      artifactType: descriptor.artifactType, // 'pipeline_summary'
      name: descriptor.name,
      description: descriptor.description,
      storageKind: 'metadata_only',
      metadata: { ...descriptor.metadata, resolvedParams: params, defaultsApplied },
    },
    });
  } catch (err) {
    throw publicationIndeterminateError(err);
  }

  const resultObject = completion.resultObject;
  const checkpointArtifact = completion.checkpointArtifact;
  const summaryArtifact = completion.summaryArtifact;

  await ctx.log({ level: 'info', message: `pbmc.pipeline.v1 handler: result object ${resultObject.id} created with checkpoint ${checkpointArtifact.id} + summary ${summaryArtifact.id} (parent ${objectId} unchanged).` });

  return {
    resultAnalysisObjectId: resultObject.id,
    result: {
      ok: true,
      handled: 'pbmc.pipeline.v1',
      operation: 'r.pbmc.pipeline.v1',
      resultAnalysisObjectId: resultObject.id,
      checkpointArtifactId: checkpointArtifact.id,
      summaryArtifactId: summaryArtifact.id,
    },
  };
}

/**
 * Persist the owner's current private live object as a new immutable saved
 * analysis. This operation performs no scientific transformation: it snapshots
 * exactly the current object, writes to a server-allocated checkpoint key, and
 * publishes the child object, lineage edge, and two artifacts atomically.
 */
async function checkpointSaveHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'checkpoint.save.v1 handler: validating live-object ownership before saving.' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;
  if (!job.projectId || typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Save job is missing its analysis object.');
  }
  if (job.parameters && Object.keys(job.parameters).length > 0) {
    throw codedHandlerError('INVALID_PARAMETERS', 'Save current analysis does not accept parameters.');
  }
  if (typeof ctx.getOwnedAnalysisObject !== 'function'
      || typeof ctx.deriveRObjectStateKey !== 'function'
      || typeof ctx.completePbmcPipelineResult !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'Saved-analysis persistence is not configured.');
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'Saved-analysis persistence is not configured.');
  }

  const checkpointStorageKey = allocateCheckpointStorageKey(job.projectId, job.id);
  await removeRetryOrphanOutput(ctx, checkpointStorageKey);
  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation: 'r.checkpoint.save.v1',
      actor: { userId: job.ownerUserId, projectId: job.projectId },
      objectContext: { objectId, stateKey },
      checkpointSave: { checkpointStorageKey },
      claimContext: { workerId: ctx.workerId },
      logger: ctx.logger,
      callR: ctx.callR,
    });
  } catch (error) {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey, error);
    throw error;
  }

  const checkpoint = descriptor.checkpoint || {};
  if (checkpoint.saved !== true || typeof checkpoint.checksumSha256 !== 'string'
      || checkpoint.checksumSha256 === '') {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey);
    throw codedHandlerError('CHECKPOINT_SAVE_FAILED', 'Current analysis was not saved.');
  }

  let completion;
  try {
    const inheritedSummary = ownedObject.metadata?.summary && typeof ownedObject.metadata.summary === 'object'
      ? ownedObject.metadata.summary
      : {};
    const savedSummary = {
      ...descriptor.summary,
      cells: descriptor.summary?.nCells,
      features: descriptor.summary?.nFeatures,
      ...(Number.isFinite(inheritedSummary.density) ? { density: inheritedSummary.density } : {}),
    };
    completion = await ctx.completePbmcPipelineResult({
      result: {
        objectType: ownedObject.objectType || 'seurat',
        displayName: derivedAnalysisDisplayName(
          ownedObject.displayName || 'Analysis',
          'saved',
          job.createdAt
        ),
        metadata: {
          source: 'checkpoint.save.v1',
          operation: 'r.checkpoint.save.v1',
          scientific_output: true,
          checkpoint: { available: true, storage_kind: 'local_internal', downloadable: false },
          summary: savedSummary,
        },
      },
      checkpointArtifact: {
        artifactType: 'checkpoint',
        name: 'Saved analysis checkpoint',
        description: 'Durable internal checkpoint of an explicitly saved private analysis. Not downloadable.',
        storageKind: 'local_internal',
        internalStorageKey: checkpointStorageKey,
        checksumSha256: checkpoint.checksumSha256,
        sizeBytes: checkpoint.sizeBytes != null ? checkpoint.sizeBytes : 0,
        metadata: { operation: 'r.checkpoint.save.v1', scientific_output: true, downloadable: false },
      },
      summaryArtifact: {
        artifactType: 'checkpoint_save',
        name: descriptor.name,
        description: descriptor.description,
        storageKind: 'metadata_only',
        metadata: descriptor.metadata,
      },
    });
  } catch (error) {
    throw publicationIndeterminateError(error);
  }

  await ctx.log({
    level: 'info',
    message: `checkpoint.save.v1 handler: created saved analysis ${completion.resultObject.id} from ${objectId}.`,
  });
  return {
    resultAnalysisObjectId: completion.resultObject.id,
    result: {
      ok: true,
      handled: 'checkpoint.save.v1',
      operation: 'r.checkpoint.save.v1',
      resultAnalysisObjectId: completion.resultObject.id,
      checkpointArtifactId: completion.checkpointArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

async function seuratPipelineHandler(ctx) {
  await ctx.heartbeat();

  const job = ctx.job;
  const multiSample = job.jobType === 'seurat.multisample.v1';
  const handlerName = multiSample ? 'seurat.multisample.v1' : 'seurat.pipeline.v1';
  const operation = multiSample ? 'r.seurat.multisample.v1' : 'r.seurat.pipeline.v1';
  await ctx.log({ level: 'info', message: `${handlerName} handler: resolving dataset inputs + parameters before any R contact.` });
  const datasetId = job.datasetId;
  const objectId = job.analysisObjectId;
  if (typeof job.projectId !== 'string' || job.projectId === '') {
    throw codedHandlerError('PROJECT_CONTEXT_REQUIRED', 'Seurat pipeline job is missing its project context.');
  }
  if (typeof datasetId !== 'string' || datasetId === '') {
    throw codedHandlerError('DATASET_CONTEXT_REQUIRED', 'Seurat pipeline job is missing its input dataset.');
  }
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Seurat pipeline job is missing its raw dataset analysis object.');
  }
  const inputResolver = multiSample ? ctx.getMultiSampleSeuratPipelineInputs : ctx.getSeuratPipelineInputs;
  if (typeof inputResolver !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  const resolvedInputs = await inputResolver();
  const datasets = multiSample
    ? (resolvedInputs && resolvedInputs.datasets)
    : [resolvedInputs && resolvedInputs.dataset];
  const dataset = datasets && datasets[0];
  const inputObject = resolvedInputs && resolvedInputs.inputObject;
  if (!dataset || dataset.id !== datasetId) throw codedHandlerError('DATASET_NOT_FOUND', 'Dataset not found.');
  try {
    if (multiSample) {
      const validated = resolvedInputs && resolvedInputs.validated;
      assertSupportedMultiSampleDatasets(datasets, validated && validated.samples);
    } else {
      assertSupportedSeuratPipelineDataset(dataset);
    }
  } catch (err) {
    throw codedHandlerError(err.code || 'DATASET_NOT_READY', err.message || 'Dataset is not ready for analysis.');
  }
  if (!inputObject || inputObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  if (inputObject.datasetId !== datasetId) {
    throw codedHandlerError('INVALID_PARAMETERS', 'Seurat pipeline input object must reference the same dataset as the job.');
  }

  const validated = multiSample
    ? validateMultiSampleSeuratParams(job.parameters)
    : validateSeuratPipelineParams(job.parameters);
  const { params, defaultsApplied } = validated;
  const samples = multiSample ? validated.samples : [];
  const checkpointStorageKey = multiSample
    ? allocateMultiSampleSeuratCheckpointStorageKey(job.projectId, job.id)
    : allocateSeuratCheckpointStorageKey(job.projectId, job.id);
  await removeRetryOrphanOutput(ctx, checkpointStorageKey);

  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation,
      actor: { userId: job.ownerUserId, projectId: job.projectId },
      ...(multiSample ? { multiSampleSeuratPipeline: {
        params,
        inputs: samples.map((sample, index) => ({
          datasetStorageKey: datasets[index].internalStorageKey,
          datasetFileType: datasets[index].fileType,
          sampleName: sample.sampleName,
          conditionName: sample.conditionName,
          donorCode: sample.donorCode,
          batch: sample.batch,
        })),
        checkpointStorageKey,
      } } : { seuratPipeline: {
        params,
        datasetStorageKey: dataset.internalStorageKey,
        datasetFileType: dataset.fileType,
        checkpointStorageKey,
      } }),
      input: job.parameters,
      claimContext: { workerId: ctx.workerId },
      logger: ctx.logger,
      callR: ctx.callR,
    });
  } catch (err) {
    const status = Number.isInteger(err && err.rStatus) ? err.rStatus : null;
    const rCode = typeof (err && err.rCode) === 'string' && err.rCode ? err.rCode : null;
    await ctx.log({
      level: 'error',
      message: `${handlerName} handler: R bridge failed${status ? ` (status=${status})` : ''}${rCode ? ` (${rCode})` : ''}.`,
    });
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey, err);
    throw err;
  }

  const checkpoint = descriptor.checkpoint || {};
  if (checkpoint.saved !== true || typeof checkpoint.checksumSha256 !== 'string' || checkpoint.checksumSha256 === '') {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey);
    throw codedHandlerError('CHECKPOINT_SAVE_FAILED', 'Pipeline did not produce a durable checkpoint.');
  }

  let completion;
  try {
    completion = await ctx.completeSeuratPipelineResult({
      source: {
        displayName: multiSample ? 'Multi-sample dataset input' : 'Dataset input',
        metadata: {
          source: 'dataset',
          datasetId,
          ...(multiSample ? { datasetIds: samples.map(sample => sample.datasetId) } : {}),
          fileType: dataset.fileType,
          scientific_output: false,
        },
      },
      result: {
        objectType: descriptor.resultObjectType || 'seurat',
        displayName: multiSample ? 'Multi-condition Seurat result' : 'Seurat pipeline result',
        metadata: {
          source: handlerName,
          operation,
          scientific_output: true,
          datasetId,
          ...(multiSample ? {
            datasetIds: samples.map(sample => sample.datasetId),
            sampleDesign: samples,
            sampleMetadataColumn: 'sample_id',
            conditionMetadataColumn: 'condition',
          } : {}),
          checkpoint: { available: true, storage_kind: 'local_internal', downloadable: false },
          resolvedParams: params,
          defaultsApplied,
          summary: descriptor.summary,
          warnings: descriptor.metadata && descriptor.metadata.warnings ? descriptor.metadata.warnings : [],
        },
      },
      checkpointArtifact: {
        artifactType: 'checkpoint',
        name: 'Seurat pipeline checkpoint',
        description: 'Durable internal checkpoint of the Seurat pipeline result object. No public download in this branch.',
        storageKind: 'local_internal',
        internalStorageKey: checkpointStorageKey,
        checksumSha256: checkpoint.checksumSha256,
        sizeBytes: checkpoint.sizeBytes != null ? checkpoint.sizeBytes : 0,
        metadata: {
          operation,
          scientific_output: true,
          downloadable: false,
          datasetId,
          ...(multiSample ? { datasetIds: samples.map(sample => sample.datasetId) } : {}),
        },
      },
      summaryArtifact: {
        artifactType: descriptor.artifactType,
        name: descriptor.name,
        description: descriptor.description,
        storageKind: 'metadata_only',
        metadata: {
          ...descriptor.metadata,
          datasetId,
          ...(multiSample ? {
            datasetIds: samples.map(sample => sample.datasetId),
            sampleDesign: samples,
          } : {}),
          resolvedParams: params,
          defaultsApplied,
        },
      },
    });
  } catch (err) {
    throw publicationIndeterminateError(err);
  }

  const resultObject = completion.resultObject;
  const checkpointArtifact = completion.checkpointArtifact;
  const summaryArtifact = completion.summaryArtifact;

  await ctx.log({ level: 'info', message: `${handlerName} handler: result object ${resultObject.id} created with checkpoint ${checkpointArtifact.id} + summary ${summaryArtifact.id}.` });

  return {
    resultAnalysisObjectId: resultObject.id,
    result: {
      ok: true,
      handled: handlerName,
      operation,
      resultAnalysisObjectId: resultObject.id,
      checkpointArtifactId: checkpointArtifact.id,
      summaryArtifactId: summaryArtifact.id,
    },
  };
}

/**
 * Checkpoint load / reattach handler (`checkpoint.load.v1`): loads a COMPLETED durable
 * internal checkpoint (produced by pbmc.pipeline.v1) back into the job OWNER's PRIVATE
 * live R session under the canonical object key, so downstream jobs can use it as live
 * input. It is a live-state MUTATION of exactly one owner/object-keyed session — that is
 * the purpose of this branch — but it creates NO new analysis object, NO lineage edge,
 * and NO checkpoint artifact (it only reattaches an existing one).
 *
 * SAME OWNERSHIP BOUNDARY as r.object.inspect / pbmc.pipeline.v1 (project membership ≠
 * live R access), enforced before any R contact:
 *   - the object id comes from the TRUSTED job row; a claim-authorized resolver verifies
 *     the job creator owns the object in the exact job scope, and the X-Object-ID is SERVER-derived
 *     (deriveRObjectStateKey); a co-member/admin/viewer who created a job against another
 *     user's object FAILS here.
 *   - getLoadableCheckpoint verifies checkpoint storage metadata and returns the
 *     SERVER-selected internal storage key (never client input).
 *
 * Order (the metadata artifact is recorded only AFTER R reports a successful load):
 *   1. heartbeat; require + own the object; derive its canonical state key (all before R)
 *   2. resolve the SERVER-selected loadable checkpoint (owner/scope/metadata verified) —
 *      a missing/ambiguous/unsafe checkpoint fails the job here, BEFORE any R contact
 *   3. invoke the allowlisted `r.checkpoint.load.v1` bridge op (server-built body: the
 *      internal storage key + expected checksum/size only — no client storage key/path)
 *   4. require R to report loaded === true — else fail (no success artifact)
 *   5. record ONE metadata-only `checkpoint_load` summary artifact (no storage key/path/
 *      state key; checksum/size are the already-public integrity descriptors)
 * On failure/cancel/claim-loss no successful load artifact is created; the claim guard
 * makes two workers unable to duplicate it. Bridge errors arrive pre-sanitized.
 */
async function checkpointLoadHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'checkpoint.load.v1 handler: validating ownership + resolving checkpoint before any R contact.' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference the analysis object to load. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Checkpoint load job is missing its analysis object.');
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may load. The
  //    claim-authorized checkpoint resolver verifies owner, exact project scope,
  //    artifact integrity, and this worker's live claim. Also require the server-
  //    injected state-key deriver.
  if (typeof ctx.deriveRObjectStateKey !== 'function'
    || typeof ctx.getLoadableCheckpoint !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  // 3. Derive the canonical object state key (X-Object-ID) SERVER-SIDE from the verified
  //    owner + object id. Never client-provided; identical to what /api/r/* would send.
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  // 4. Resolve the SERVER-selected loadable checkpoint (re-verifies owner + project scope
  //    + checkpoint storage metadata). Throws coded SAFE-message errors
  //    (ANALYSIS_OBJECT_NOT_FOUND / NO_CHECKPOINT_ARTIFACT / AMBIGUOUS_CHECKPOINT /
  //    INVALID_*) that fail the job terminally WITHOUT contacting R. The internal storage
  //    key it returns is SECRET — it is passed only to the server-controlled bridge and
  //    is never logged or placed in artifact metadata.
  const checkpoint = await ctx.getLoadableCheckpoint();
  if (!checkpoint || checkpoint.analysisObjectId !== objectId
      || (checkpoint.projectId || null) !== (job.projectId || null)) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }

  await ctx.log({ level: 'info', message: 'checkpoint.load.v1 handler: checkpoint resolved; loading into the owner\'s private live R session (no new object/edge).' });

  // 5. Run the allowlisted, mutating bridge op. Object context + checkpoint coordinates
  //    are all server-derived; the bridge ignores raw job input for routing/storage key.
  const descriptor = await ctx.runRBridgeOperation({
    job,
    operation: 'r.checkpoint.load.v1',
    actor: { userId: job.ownerUserId, projectId: job.projectId || null },
    objectContext: { objectId, stateKey },
    checkpoint: {
      checkpointArtifactId: checkpoint.checkpointArtifactId,
      internalStorageKey: checkpoint.internalStorageKey,
      checksumSha256: checkpoint.checksumSha256,
      sizeBytes: checkpoint.sizeBytes,
    },
    input: job.parameters, // passed for completeness; the bridge IGNORES it for routing.
    claimContext: { workerId: ctx.workerId },
    logger: ctx.logger,
    callR: ctx.callR,
  });

  // 6. R MUST report a successful load for success. If not, fail BEFORE recording any
  //    success artifact (so a failed load leaves no checkpoint_load artifact behind).
  const loaded = descriptor.loaded || {};
  if (loaded.loaded !== true) {
    throw codedHandlerError('CHECKPOINT_LOAD_FAILED', 'Checkpoint did not load into the live R session.');
  }

  // 7. Record ONE metadata-only checkpoint_load summary artifact. The internal storage
  //    key/path and the R state key are NEVER placed in metadata; checksum/size are the
  //    already-public integrity descriptors of the source checkpoint artifact.
  let artifact;
  try {
    artifact = await ctx.createArtifact({
      artifactType: descriptor.artifactType, // 'checkpoint_load'
      name: descriptor.name,
      description: descriptor.description,
      storageKind: descriptor.storageKind, // 'metadata_only'
      metadata: {
        ...descriptor.metadata,
        sourceAnalysisObjectId: objectId,
        checkpointArtifactId: checkpoint.checkpointArtifactId,
        checksumSha256: checkpoint.checksumSha256,
        sizeBytes: checkpoint.sizeBytes,
      },
    });
  } catch (error) {
    throw publicationIndeterminateError(error);
  }

  await ctx.log({ level: 'info', message: `checkpoint.load.v1 handler: recorded metadata-only artifact ${artifact.id} (live-state reattach; no new analysis object or lineage edge).` });

  // No result analysis object / checkpoint / lineage edge: this is a live-state reattach.
  return {
    result: { ok: true, handled: 'checkpoint.load.v1', operation: 'r.checkpoint.load.v1', artifactId: artifact.id },
  };
}

async function spatialSeuratPipelineHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'spatial.seurat.v1 handler: resolving a Visium dataset before R contact.' });
  const job = ctx.job;
  if (!job.projectId || !job.datasetId || !job.analysisObjectId
      || typeof ctx.getSpatialPipelineInputs !== 'function') {
    throw codedHandlerError('INVALID_JOB_CONTEXT', 'Spatial pipeline inputs are incomplete.');
  }
  const resolved = await ctx.getSpatialPipelineInputs();
  const dataset = resolved?.dataset;
  const inputObject = resolved?.inputObject;
  if (!dataset || dataset.id !== job.datasetId) {
    throw codedHandlerError('DATASET_NOT_FOUND', 'Spatial dataset not found.');
  }
  try {
    assertSupportedSpatialSeuratDataset(dataset);
  } catch (error) {
    throw codedHandlerError(error.code || 'DATASET_NOT_READY', error.message || 'Spatial dataset is not ready.');
  }
  if (!inputObject || inputObject.id !== job.analysisObjectId
      || inputObject.datasetId !== dataset.id) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const { params, defaultsApplied } = validateSpatialSeuratParams(job.parameters);
  const checkpointStorageKey = allocateSpatialSeuratCheckpointStorageKey(job.projectId, job.id);
  await removeRetryOrphanOutput(ctx, checkpointStorageKey);

  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation: 'r.spatial.seurat.v1',
      actor: { userId: job.ownerUserId, projectId: job.projectId },
      spatialPipeline: {
        params,
        datasetStorageKey: dataset.internalStorageKey,
        datasetFileType: dataset.fileType,
        checkpointStorageKey,
      },
      claimContext: { workerId: ctx.workerId },
      logger: ctx.logger,
      callR: ctx.callR,
    });
  } catch (error) {
    const status = Number.isInteger(error?.rStatus) ? error.rStatus : null;
    const rCode = typeof error?.rCode === 'string' ? error.rCode : null;
    await ctx.log({
      level: 'error',
      message: `spatial.seurat.v1 handler: R bridge failed${status ? ` (status=${status})` : ''}${rCode ? ` (${rCode})` : ''}.`,
    });
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey, error);
    throw error;
  }
  const checkpoint = descriptor.checkpoint || {};
  if (checkpoint.saved !== true || !checkpoint.checksumSha256
      || !Number.isSafeInteger(checkpoint.sizeBytes) || checkpoint.sizeBytes < 0) {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey);
    throw codedHandlerError('CHECKPOINT_SAVE_FAILED', 'Spatial pipeline did not produce a durable checkpoint.');
  }
  let completion;
  try {
    completion = await ctx.completeSeuratPipelineResult({
      source: {
        displayName: 'Visium dataset input',
        metadata: {
          source: 'dataset', datasetId: dataset.id, fileType: dataset.fileType,
          modality: 'spatial', scientific_output: false,
        },
      },
      result: {
        objectType: 'seurat',
        displayName: 'Spatial Seurat pipeline result',
        metadata: {
          source: 'spatial.seurat.v1', operation: 'r.spatial.seurat.v1',
          modality: 'spatial', platform: '10x_visium', scientific_output: true,
          datasetId: dataset.id,
          checkpoint: { available: true, storage_kind: 'local_internal', downloadable: false },
          resolvedParams: params, defaultsApplied,
          summary: descriptor.summary,
          warnings: descriptor.metadata?.warnings || [],
        },
      },
      checkpointArtifact: {
        artifactType: 'checkpoint', name: 'Spatial Seurat checkpoint',
        description: 'Durable internal checkpoint containing the Seurat spatial assay and image coordinates.',
        storageKind: 'local_internal', internalStorageKey: checkpointStorageKey,
        checksumSha256: checkpoint.checksumSha256, sizeBytes: checkpoint.sizeBytes,
        metadata: {
          operation: 'r.spatial.seurat.v1', modality: 'spatial',
          platform: '10x_visium', scientific_output: true, downloadable: false,
          datasetId: dataset.id,
        },
      },
      summaryArtifact: {
        artifactType: descriptor.artifactType, name: descriptor.name,
        description: descriptor.description, storageKind: 'metadata_only',
        metadata: {
          ...descriptor.metadata, datasetId: dataset.id, modality: 'spatial',
          platform: '10x_visium', resolvedParams: params, defaultsApplied,
        },
      },
    });
  } catch (error) {
    throw publicationIndeterminateError(error);
  }
  await ctx.log({
    level: 'info',
    message: `spatial.seurat.v1 handler: result object ${completion.resultObject.id} and checkpoint ${completion.checkpointArtifact.id} created.`,
  });
  return {
    resultAnalysisObjectId: completion.resultObject.id,
    result: {
      ok: true, handled: 'spatial.seurat.v1', operation: 'r.spatial.seurat.v1',
      resultAnalysisObjectId: completion.resultObject.id,
      checkpointArtifactId: completion.checkpointArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

/**
 * Fork a project checkpoint into a new object owned by the job creator. The
 * source object is never attached to the creator's live key and is never changed.
 */
async function checkpointForkHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'checkpoint.fork.v1 handler: resolving a project checkpoint before R contact.' });

  const job = ctx.job;
  const sourceObjectId = job.analysisObjectId;
  if (!job.projectId || !sourceObjectId) {
    throw codedHandlerError('PROJECT_CONTEXT_REQUIRED', 'Checkpoint fork requires a project and source object.');
  }
  if (typeof ctx.getForkableCheckpoint !== 'function'
      || typeof ctx.deriveRObjectStateKey !== 'function'
      || typeof ctx.completeCheckpointFork !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'Checkpoint fork is not configured.');
  }

  const checkpoint = await ctx.getForkableCheckpoint();
  if (!checkpoint || checkpoint.analysisObjectId !== sourceObjectId
      || checkpoint.projectId !== job.projectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const resultObjectId = deriveCheckpointForkResultObjectId(job.id);
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, resultObjectId);
  if (!stateKey) throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'Checkpoint fork is not configured.');

  const descriptor = await ctx.runRBridgeOperation({
    job,
    operation: 'r.checkpoint.load.v1',
    actor: { userId: job.ownerUserId, projectId: job.projectId },
    objectContext: { objectId: resultObjectId, stateKey },
    checkpoint: {
      checkpointArtifactId: checkpoint.checkpointArtifactId,
      internalStorageKey: checkpoint.internalStorageKey,
      checksumSha256: checkpoint.checksumSha256,
      sizeBytes: checkpoint.sizeBytes,
    },
    claimContext: { workerId: ctx.workerId },
    logger: ctx.logger,
    callR: ctx.callR,
  });
  if (!descriptor.loaded || descriptor.loaded.loaded !== true) {
    throw codedHandlerError('CHECKPOINT_LOAD_FAILED', 'Checkpoint did not load into the new private live session.');
  }

  let completed;
  try {
    completed = await ctx.completeCheckpointFork({
      resultAnalysisObjectId: resultObjectId,
      checkpointArtifactId: checkpoint.checkpointArtifactId,
      loaded: descriptor.loaded,
    });
  } catch (error) {
    throw publicationIndeterminateError(error);
  }
  await ctx.log({
    level: 'info',
    message: `checkpoint.fork.v1 handler: created owned result object ${completed.resultObject.id} with source lineage.`,
  });
  return {
    resultAnalysisObjectId: completed.resultObject.id,
    result: {
      ok: true,
      handled: 'checkpoint.fork.v1',
      resultAnalysisObjectId: completed.resultObject.id,
      artifactId: completed.artifact.id,
    },
  };
}

/**
 * DEG / marker-finding handler (`deg.find_markers.v1`): runs the existing FindAllMarkers
 * path over the OWNER's existing live analysis object (usually one produced by
 * pbmc.pipeline.v1 → checkpoint.load.v1) as ONE allowlisted bridge operation. DEG is an
 * OUTPUT-producing analysis, NOT a mutating checkpoint transformation: it creates NO new
 * analysis object and NO lineage edge, and does not mutate the live object (any temporary
 * identity change is restored R-side). It writes (1) an internal full marker-table artifact
 * (local_internal; controlled authenticated export only) and (2) a metadata-only DEG summary artifact.
 *
 * SAME OWNERSHIP BOUNDARY as r.object.inspect / pbmc.pipeline.v1 / checkpoint.load.v1
 * (project membership ≠ live R access): the input object id comes from the TRUSTED job row;
 * a claim-authorized resolver verifies the job creator OWNS that live object in the
 * exact job scope BEFORE any R contact,
 * and the X-Object-ID is SERVER-derived (deriveRObjectStateKey). A co-member/admin/viewer who
 * created a job against another user's object FAILS here.
 *
 * Order (both DB artifacts are created only AFTER R success):
 *   1. heartbeat; require + own the input object; derive its state key (all before R)
 *   2. validate parameters against the fixed allowlist (backend/degFindMarkers.js) —
 *      invalid params fail the job here, BEFORE any R contact
 *   3. allocate a SERVER-controlled internal result storage key (no client input)
 *   4. invoke the allowlisted `r.deg.find_markers.v1` bridge op (server-built body)
 *   5. require R to have written the full table (saved + checksum/size) — else fail
 *      (no artifacts)
 *   6. record a local_internal `deg_markers` artifact (key/checksum/size internal) and a
 *      metadata-only `deg_summary` artifact in ONE atomic, claim-guarded transaction
 * On failure/cancel/claim-loss no successful DEG artifact is created; the claim guard +
 * DEG_RESULT_EXISTS guard make two workers unable to duplicate them. Bridge errors arrive
 * pre-sanitized (no raw R error/stack/internal URL/state key).
 */
async function hydrateIsolatedAnalysisObject(ctx, objectId) {
  const stateKey = ctx.deriveRObjectStateKey(ctx.job.ownerUserId, `${objectId}-job-${ctx.job.id}`);
  // A verified completion receipt proves the downstream scientific operation
  // already finished against this exact job/object binding. Recovery publishes
  // that immutable output through the handler's normal atomic DB path and must
  // never contact R or rebuild transient state a second time.
  if (ctx.recoveringCompletionReceipt === true) return stateKey;
  if (typeof ctx.getHydrationCheckpoint !== 'function') {
    throw codedHandlerError('NO_CHECKPOINT_ARTIFACT', 'This analysis requires a durable checkpoint.');
  }
  const checkpoint = await ctx.getHydrationCheckpoint();
  if (!checkpoint || checkpoint.analysisObjectId !== objectId
      || typeof checkpoint.checkpointArtifactId !== 'string') {
    throw codedHandlerError('NO_CHECKPOINT_ARTIFACT', 'This analysis requires a durable checkpoint.');
  }
  const hydrated = await ctx.runRBridgeOperation({
    job: ctx.job,
    operation: 'r.checkpoint.hydrate.v1',
    actor: { userId: ctx.job.ownerUserId, projectId: ctx.job.projectId || null },
    objectContext: { objectId, stateKey },
    checkpoint,
    claimContext: { workerId: ctx.workerId },
    logger: ctx.logger,
    callR: ctx.callR,
  });
  if (!hydrated || !hydrated.loaded || hydrated.loaded.loaded !== true) {
    throw codedHandlerError('R_CHECKPOINT_LOAD_FAILED', 'Private compute could not hydrate the checkpoint.');
  }
  return stateKey;
}

async function degFindMarkersHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({ level: 'info', message: 'deg.find_markers.v1 handler: validating ownership + parameters before any R contact.' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an input analysis object. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'DEG job is missing its input analysis object.');
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may run DEG.
  //    The worker-only resolver binds ownership and exact scope to this valid claim;
  //    a 404-style message avoids another user's object existence disclosure.
  if (typeof ctx.getOwnedAnalysisObject !== 'function' || typeof ctx.deriveRObjectStateKey !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }

  // 3. Validate and resolve parameters before checkpoint hydration or scientific R contact.
  const { params, defaultsApplied } = validateDegFindMarkersParams(job.parameters);

  // 4. Derive a job-scoped R state key server-side and hydrate the exact trusted checkpoint.
  const stateKey = await hydrateIsolatedAnalysisObject(ctx, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  // 5. Server-allocate the internal result storage key (no client input; relative,
  //    traversal-free; the R backend confines it to project storage). Never logged/exposed.
  const resultStorageKey = allocateDegResultStorageKey(job.projectId, job.id);
  await removeRetryOrphanOutput(ctx, resultStorageKey);

  await ctx.log({ level: 'info', message: 'deg.find_markers.v1 handler: parameters valid; running allowlisted DEG over private checkpoint-backed job state (no new object/edge).' });

  // 6. Run the allowlisted DEG bridge op. Object context + params body are all server-
  //    derived; the bridge ignores raw job input for routing/storage key.
  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation: 'r.deg.find_markers.v1',
      actor: { userId: job.ownerUserId, projectId: job.projectId || null },
      objectContext: { objectId, stateKey },
      deg: { params, resultStorageKey },
      input: job.parameters, // passed for completeness; the bridge IGNORES it for routing.
      claimContext: { workerId: ctx.workerId },
      logger: ctx.logger,
      callR: ctx.callR,
    });
  } catch (err) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey, err);
    throw err;
  }

  // 7. The full marker table MUST have been written (with integrity) for success. If not,
  //    fail BEFORE creating any DB artifact — so a missing/failed write leaves nothing behind.
  const result = descriptor.result || {};
  if (result.saved !== true || typeof result.checksumSha256 !== 'string' || result.checksumSha256 === '') {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey);
    throw codedHandlerError('DEG_RESULT_WRITE_FAILED', 'DEG run did not produce a durable marker table.');
  }

  // 8. Record BOTH artifacts in ONE atomic, claim/lease-guarded transaction: the
  //    local_internal full-table artifact (server-allocated key + checksum/size, key stripped
  //    from public reads) and the metadata-only summary artifact (resolved params + bounded
  //    summary). NO result analysis object and NO lineage edge are created.
  let completion;
  try {
    completion = await ctx.completeDegFindMarkersResult({
    markersArtifact: {
      artifactType: 'deg_markers',
      name: 'DEG marker table',
      description: 'Durable internal full DEG marker table. Controlled authenticated export only.',
      storageKind: 'local_internal',
      mimeType: 'text/csv',
      internalStorageKey: resultStorageKey,
      checksumSha256: result.checksumSha256,
      sizeBytes: result.sizeBytes != null ? result.sizeBytes : 0,
      metadata: {
        operation: 'r.deg.find_markers.v1',
        scientific_output: true,
        downloadable: false,
        resolvedParams: params,
        defaultsApplied,
        nRows: result.nRows != null ? result.nRows : null,
      },
    },
    summaryArtifact: {
      artifactType: descriptor.artifactType, // 'deg_summary'
      name: descriptor.name,
      description: descriptor.description,
      storageKind: 'metadata_only',
      metadata: {
        ...descriptor.metadata,
        kind: 'deg_summary',
        scientific_output: true,
        downloadable: false,
        resolvedParams: params,
        defaultsApplied,
      },
    },
    });
  } catch (err) {
    throw publicationIndeterminateError(err);
  }

  const markersArtifact = completion.markersArtifact;
  const summaryArtifact = completion.summaryArtifact;

  await ctx.log({ level: 'info', message: `deg.find_markers.v1 handler: recorded marker table ${markersArtifact.id} + summary ${summaryArtifact.id} (object ${objectId} not mutated; no new object/edge).` });

  // No result analysis object / checkpoint / lineage edge: DEG is an output-producing analysis.
  return {
    result: {
      ok: true,
      handled: 'deg.find_markers.v1',
      operation: 'r.deg.find_markers.v1',
      markersArtifactId: markersArtifact.id,
      summaryArtifactId: summaryArtifact.id,
    },
  };
}

/**
 * Ranked Gene Ontology pathway enrichment for one selected identity versus the
 * remaining cells. Like DEG, this is a read-only analysis over an owner-verified
 * live object: it writes a private result table and a bounded public summary, but
 * creates no new analysis object or lineage edge.
 */
async function enrichmentGseaHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message: 'enrichment.gsea.v1 handler: validating ownership and parameters before any R contact.',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Pathway-enrichment job is missing its input analysis object.'
    );
  }
  if (typeof ctx.getOwnedAnalysisObject !== 'function'
      || typeof ctx.deriveRObjectStateKey !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  if (ctx.runtimeCapabilities?.pathwayEnrichment !== true) {
    throw codedHandlerError(
      'ENRICHMENT_PACKAGES_UNAVAILABLE',
      SAFE_HANDLER_DOMAIN_MESSAGES.ENRICHMENT_PACKAGES_UNAVAILABLE
    );
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const { params, defaultsApplied } = validateEnrichmentGseaParams(job.parameters);
  const stateKey = await hydrateIsolatedAnalysisObject(ctx, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  const resultStorageKey = allocateEnrichmentGseaResultStorageKey(job.projectId, job.id);
  await removeRetryOrphanOutput(ctx, resultStorageKey);
  await ctx.log({
    level: 'info',
    message: 'enrichment.gsea.v1 handler: running the allowlisted cluster-versus-rest ranked GO analysis.',
  });

  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation: 'r.enrichment.gsea.v1',
      actor: { userId: job.ownerUserId, projectId: job.projectId || null },
      objectContext: { objectId, stateKey },
      enrichment: { params, resultStorageKey },
      input: job.parameters,
      claimContext: { workerId: ctx.workerId },
      logger: ctx.logger,
      callR: ctx.callR,
    });
  } catch (err) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey, err);
    throw err;
  }

  const result = descriptor.result || {};
  if (result.saved !== true || typeof result.checksumSha256 !== 'string'
      || result.checksumSha256 === '' || !Number.isInteger(result.sizeBytes)
      || result.sizeBytes < 0 || result.sizeBytes > 50 * 1024 * 1024
      || !Number.isInteger(result.nRows) || result.nRows < 0 || result.nRows > 100000) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey);
    throw codedHandlerError(
      'ENRICHMENT_RESULT_WRITE_FAILED',
      'Pathway enrichment did not produce a valid durable result table.'
    );
  }

  let completion;
  try {
    completion = await ctx.completeEnrichmentGseaResult({
      resultsArtifact: {
        artifactType: 'enrichment_results',
        name: 'Ranked pathway-enrichment table',
        description: 'Private full cluster-versus-rest GO Biological Process enrichment table.',
        storageKind: 'local_internal',
        mimeType: 'text/csv',
        internalStorageKey: resultStorageKey,
        checksumSha256: result.checksumSha256,
        sizeBytes: result.sizeBytes,
        metadata: {
          operation: 'r.enrichment.gsea.v1',
          scientific_output: true,
          downloadable: false,
          resolvedParams: params,
          defaultsApplied,
          nRows: result.nRows,
        },
      },
      summaryArtifact: {
        artifactType: descriptor.artifactType,
        name: descriptor.name,
        description: descriptor.description,
        storageKind: 'metadata_only',
        metadata: {
          ...descriptor.metadata,
          kind: 'enrichment_summary',
          scientific_output: true,
          downloadable: false,
          resolvedParams: params,
          defaultsApplied,
        },
      },
    });
  } catch (err) {
    throw publicationIndeterminateError(err);
  }

  await ctx.log({
    level: 'info',
    message: `enrichment.gsea.v1 handler: recorded result ${completion.resultsArtifact.id} and summary ${completion.summaryArtifact.id}.`,
  });
  return {
    result: {
      ok: true,
      handled: 'enrichment.gsea.v1',
      operation: 'r.enrichment.gsea.v1',
      resultsArtifactId: completion.resultsArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

/**
 * Infer ligand-receptor signaling candidates within exactly one selected
 * biological context. This is an output-producing, read-only CellChat analysis:
 * it never mutates the owner-attached live object, never compares conditions,
 * and writes its complete candidate table only to private project storage.
 */
async function cellChatInferenceHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message: 'cellchat.infer.v1 handler: validating ownership and fixed single-context parameters before any R contact.',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Cell-communication job is missing its input analysis object.'
    );
  }
  if (typeof ctx.getOwnedAnalysisObject !== 'function'
      || typeof ctx.deriveRObjectStateKey !== 'function'
      || typeof ctx.completeCellChatInferenceResult !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const { params, defaultsApplied } = validateCellChatInferenceParams(job.parameters);
  const stateKey = await hydrateIsolatedAnalysisObject(ctx, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  const resultStorageKey = allocateCellChatInferenceResultStorageKey(job.projectId, job.id);
  await removeRetryOrphanOutput(ctx, resultStorageKey);
  await ctx.log({
    level: 'info',
    message: 'cellchat.infer.v1 handler: running the allowlisted CellChat candidate-inference workflow.',
  });

  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation: 'r.cellchat.infer.v1',
      actor: { userId: job.ownerUserId, projectId: job.projectId || null },
      objectContext: { objectId, stateKey },
      cellChat: { params, resultStorageKey },
      input: job.parameters,
      claimContext: { workerId: ctx.workerId },
      logger: ctx.logger,
      callR: ctx.callR,
    });
  } catch (err) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey, err);
    throw err;
  }

  const result = descriptor.result || {};
  if (descriptor.artifactType !== 'cellchat_summary'
      || result.saved !== true || typeof result.checksumSha256 !== 'string'
      || result.checksumSha256 === '' || !Number.isInteger(result.sizeBytes)
      || result.sizeBytes < 0 || result.sizeBytes > 50 * 1024 * 1024
      || !Number.isInteger(result.nRows) || result.nRows < 0 || result.nRows > MAX_CELLCHAT_RESULT_ROWS) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey);
    throw codedHandlerError(
      'CELLCHAT_RESULT_WRITE_FAILED',
      'Cell-communication inference did not produce a valid durable result table.'
    );
  }

  let completion;
  try {
    completion = await ctx.completeCellChatInferenceResult({
      resultsArtifact: {
        artifactType: 'cellchat_results',
        name: 'Cell-cell communication candidate table',
        description: 'Private full CellChat ligand-receptor signaling candidate table for one selected biological context.',
        storageKind: 'local_internal',
        mimeType: 'text/csv',
        internalStorageKey: resultStorageKey,
        checksumSha256: result.checksumSha256,
        sizeBytes: result.sizeBytes,
        metadata: {
          operation: 'r.cellchat.infer.v1',
          scientific_output: true,
          downloadable: false,
          resolvedParams: params,
          defaultsApplied,
          nRows: result.nRows,
        },
      },
      summaryArtifact: {
        artifactType: descriptor.artifactType,
        name: descriptor.name,
        description: descriptor.description,
        storageKind: 'metadata_only',
        metadata: {
          ...descriptor.metadata,
          kind: 'cellchat_summary',
          scientific_output: true,
          downloadable: false,
          resolvedParams: params,
          defaultsApplied,
        },
      },
    });
  } catch (err) {
    throw publicationIndeterminateError(err);
  }

  await ctx.log({
    level: 'info',
    message: `cellchat.infer.v1 handler: recorded candidate table ${completion.resultsArtifact.id} and summary ${completion.summaryArtifact.id}.`,
  });
  return {
    result: {
      ok: true,
      handled: 'cellchat.infer.v1',
      operation: 'r.cellchat.infer.v1',
      resultsArtifactId: completion.resultsArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

async function exploratoryAnalysisHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message: 'explore.summarize.v1 handler: validating a reviewed aggregate recipe and hydrating a private checkpoint.',
  });
  const job = ctx.job;
  const objectId = job.analysisObjectId;
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Exploratory analysis is missing its input object.');
  }
  if (typeof ctx.getOwnedAnalysisObject !== 'function'
      || typeof ctx.deriveRObjectStateKey !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const { params } = validateExploratoryAnalysisParams(job.parameters);
  const stateKey = await hydrateIsolatedAnalysisObject(ctx, objectId);
  const descriptor = await ctx.runRBridgeOperation({
    job,
    operation: 'r.explore.summarize.v1',
    actor: { userId: job.ownerUserId, projectId: job.projectId || null },
    objectContext: { objectId, stateKey },
    exploration: { params },
    claimContext: { workerId: ctx.workerId },
    logger: ctx.logger,
    callR: ctx.callR,
  });
  const artifact = await ctx.createArtifact({
    artifactType: 'exploration_summary',
    name: descriptor.name,
    description: descriptor.description,
    storageKind: 'metadata_only',
    metadata: {
      ...descriptor.metadata,
      resolvedParams: params,
      downloadable: false,
    },
  });
  await ctx.log({
    level: 'info',
    message: `explore.summarize.v1 handler: recorded aggregate summary ${artifact.id}.`,
  });
  return {
    result: {
      ok: true,
      handled: 'explore.summarize.v1',
      summaryArtifactId: artifact.id,
    },
  };
}

async function conditionComparisonHandler(ctx) {
  await ctx.heartbeat();
  const job = ctx.job;
  if (!job.analysisObjectId || typeof ctx.getConditionComparisonInputs !== 'function') {
    throw codedHandlerError('INVALID_CONTRAST', 'Condition-comparison context is incomplete.');
  }
  const { params } = validateConditionComparisonParams(job.parameters);
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== job.analysisObjectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  // Resolve the contrast snapshot before hydration. Invalid designs cannot make
  // contact with R and all sample mappings come from trusted project rows.
  const design = await ctx.getConditionComparisonInputs();
  if (!design || design.analysisObjectId !== job.analysisObjectId
      || design.contrast.id !== params.contrastId) {
    throw codedHandlerError('INVALID_CONTRAST', 'Condition contrast is invalid.');
  }
  if (design.contrast.blockingFactor
      || (Array.isArray(design.contrast.covariates) && design.contrast.covariates.length > 0)) {
    throw codedHandlerError(
      'UNSUPPORTED_CONDITION_MODEL',
      'Batch, blocking-factor, and covariate-adjusted condition models are not supported yet.'
    );
  }
  const stateKey = await hydrateIsolatedAnalysisObject(ctx, job.analysisObjectId);
  const resultStorageKey = allocateConditionComparisonResultStorageKey(job.projectId, job.id);
  await removeRetryOrphanOutput(ctx, resultStorageKey);
  await ctx.log({
    level: 'info',
    message: 'condition.pseudobulk_de.v1 handler: running replicate-aware edgeR pseudobulk over a private checkpoint.',
  });
  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation: 'r.condition.pseudobulk_de.v1',
      actor: { userId: job.ownerUserId, projectId: job.projectId },
      objectContext: { objectId: job.analysisObjectId, stateKey },
      conditionComparison: { design, resultStorageKey },
      claimContext: { workerId: ctx.workerId }, logger: ctx.logger, callR: ctx.callR,
    });
  } catch (error) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey, error);
    throw error;
  }
  const result = descriptor.result || {};
  if (result.saved !== true || !result.checksumSha256
      || !Number.isInteger(result.nRows) || result.nRows < 0 || result.nRows > 500000) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey);
    throw codedHandlerError('CONDITION_COMPARISON_WRITE_FAILED', 'Condition comparison did not produce a durable result.');
  }
  let completion;
  try {
    completion = await ctx.completeConditionComparisonResult({
      resultsArtifact: {
        artifactType: 'condition_de_results', name: 'Pseudobulk condition DE table',
        description: 'Private replicate-aware edgeR pseudobulk differential-expression table.',
        storageKind: 'local_internal', mimeType: 'text/csv', internalStorageKey: resultStorageKey,
        checksumSha256: result.checksumSha256, sizeBytes: result.sizeBytes,
        metadata: { operation: 'r.condition.pseudobulk_de.v1', contrastId: params.contrastId, nRows: result.nRows },
      },
      summaryArtifact: {
        artifactType: 'condition_de_summary', name: descriptor.name,
        description: descriptor.description, storageKind: 'metadata_only',
        metadata: { ...descriptor.metadata, contrastId: params.contrastId, downloadable: false },
      },
    });
  } catch (error) { throw publicationIndeterminateError(error); }
  return {
    result: {
      ok: true, handled: 'condition.pseudobulk_de.v1',
      resultsArtifactId: completion.resultsArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

async function expertRHandler(ctx) {
  await ctx.heartbeat();
  if (ctx.runWorkflow) {
    const workflow = await ctx.runWorkflow(ctx);
    if (workflow) return workflow;
  }
  const job = ctx.job;
  const { params, scriptSha256 } = validateExpertRParams(job.parameters, { allowStoredHash: true });
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== job.analysisObjectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  if (typeof ctx.runExpertSandbox !== 'function') {
    throw codedHandlerError('EXPERT_R_UNAVAILABLE', 'Expert R sandbox is unavailable.');
  }
  const checkpoint = await ctx.getHydrationCheckpoint();
  if (!checkpoint || checkpoint.analysisObjectId !== job.analysisObjectId
      || typeof checkpoint.internalStorageKey !== 'string'
      || typeof checkpoint.checkpointArtifactId !== 'string'
      || !/^[0-9a-f]{64}$/.test(String(checkpoint.checksumSha256 || ''))
      || !Number.isSafeInteger(checkpoint.sizeBytes) || checkpoint.sizeBytes < 0) {
    throw codedHandlerError('NO_CHECKPOINT_ARTIFACT', 'Expert R requires a durable checkpoint.');
  }
  if (typeof ctx.getExpertRPrivateInputs !== 'function') {
    throw codedHandlerError('EXPERT_R_UNAVAILABLE', 'Expert R private inputs are unavailable.');
  }
  const privateInputs = await ctx.getExpertRPrivateInputs();
  const privateInputProvenance = privateInputs.map((input) => ({
    id: input.id,
    sizeBytes: input.sizeBytes,
    checksumSha256: input.checksumSha256,
  }));
  const outputStorageKey = allocateExpertRBundleStorageKey(job.projectId, job.id);
  const sandbox = await ctx.runExpertSandbox({
    jobId: job.id, projectId: job.projectId, profileId: params.profileId,
    ...(params.environment ? { environment: params.environment } : {}),
    script: params.script, checkpointStorageKey: checkpoint.internalStorageKey,
    checkpointChecksumSha256: checkpoint.checksumSha256,
    checkpointSizeBytes: checkpoint.sizeBytes,
    privateInputs: privateInputs.map((input) => ({
      id: input.id,
      originalFilename: input.originalFilename,
      internalStorageKey: input.internalStorageKey,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
    })),
    outputStorageKey,
  });
  const outputFiles = Array.isArray(sandbox?.files) ? sandbox.files : [];
  const environmentStorageKey = `${outputStorageKey}.environment.json`;
  let validEnvironment = !params.environment;
  if (params.environment) {
    try {
      assertEnvironmentMatches(params.environment, sandbox?.environment);
      validEnvironment = sandbox.environment.imageDigest === sandbox.sandboxImageDigest
        && sandbox.environmentArtifact?.internalStorageKey === environmentStorageKey
        && sandbox.environmentArtifact.checksumSha256 === params.environment.manifestSha256
        && Number.isSafeInteger(sandbox.environmentArtifact.sizeBytes)
        && sandbox.environmentArtifact.sizeBytes > 0 && sandbox.environmentArtifact.sizeBytes <= MAX_ENVIRONMENT_BYTES;
    } catch { validEnvironment = false; }
  }
  const validFiles = outputFiles.length === sandbox?.nFiles && outputFiles.every((file) => (
    file && typeof file.name === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(file.name)
    && !file.name.split('/').some((part) => part === '.' || part === '..' || part === '')
    && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0
    && /^[0-9a-f]{64}$/.test(String(file.checksumSha256 || ''))
  ));
  const validSandbox = sandbox && sandbox.saved === true
      && /^[0-9a-f]{64}$/.test(String(sandbox.checksumSha256 || ''))
      && Number.isSafeInteger(sandbox.sizeBytes) && sandbox.sizeBytes >= 0
      && sandbox.sizeBytes <= MAX_EXPERT_R_BUNDLE_BYTES
      && Number.isInteger(sandbox.nFiles) && sandbox.nFiles >= 0 && sandbox.nFiles <= 50
      && Number.isSafeInteger(sandbox.outputBytes) && sandbox.outputBytes >= 0
      && sandbox.outputBytes <= MAX_EXPERT_R_OUTPUT_BYTES
      && outputFiles.reduce((total, file) => total + (Number(file?.sizeBytes) || 0), 0) === sandbox.outputBytes
      && validFiles
      && sandbox.profileId === params.profileId
      && sandbox.scriptSha256 === scriptSha256
      && sandbox.checkpointChecksumSha256 === checkpoint.checksumSha256
      && JSON.stringify(sandbox.privateInputs || []) === JSON.stringify(privateInputProvenance)
      && /^sha256:[0-9a-f]{64}$/.test(String(sandbox.sandboxImageDigest || ''))
      && sandbox.resourcePolicyVersion === EXPERT_R_RESOURCE_POLICY_VERSION;
  if (!validSandbox || !validEnvironment) {
    if (typeof ctx.removeDurableObject === 'function') {
      try { await ctx.removeDurableObject(outputStorageKey); } catch { /* validation error wins */ }
      if (params.environment) try { await ctx.removeDurableObject(environmentStorageKey); } catch { /* validation error wins */ }
    }
    throw codedHandlerError('EXPERT_R_RESULT_INVALID', 'Expert R sandbox output is invalid.');
  }
  const files = outputFiles.map((file) => ({
    name: file.name,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
  }));
  const provenance = {
    ...(params.environment ? { environment: params.environment } : {}),
    packageProfileId: params.profileId,
    sandboxImageDigest: sandbox.sandboxImageDigest,
    resourcePolicyVersion: sandbox.resourcePolicyVersion,
    scriptSha256,
    input: {
      analysisObjectId: job.analysisObjectId,
      checkpointArtifactId: checkpoint.checkpointArtifactId,
      checkpointChecksumSha256: checkpoint.checksumSha256,
      checkpointSizeBytes: checkpoint.sizeBytes,
      privateInputs: privateInputProvenance,
    },
  };
  let completion;
  try {
    completion = await ctx.completeExpertRResult({
      ...(params.environment ? { environmentArtifact: {
        artifactType: 'expert_r_environment', name: 'Exact R environment',
        description: 'Verified package lock and immutable container userspace identity.',
        storageKind: 'local_internal', mimeType: 'application/json',
        ...sandbox.environmentArtifact, metadata: { environment: params.environment },
      } } : {}),
      result: {
        objectType: 'generic',
        displayName: 'Expert R result',
        metadata: {
          analysisKind: 'expert_r',
          ...provenance,
          outputBundleChecksumSha256: sandbox.checksumSha256,
          nFiles: sandbox.nFiles,
        },
      },
      bundleArtifact: {
        artifactType: 'expert_r_bundle', name: 'Expert R output bundle',
        description: 'Private outputs from an ephemeral no-network Expert R sandbox.',
        storageKind: 'local_internal', mimeType: 'application/gzip',
        internalStorageKey: outputStorageKey, checksumSha256: sandbox.checksumSha256,
        sizeBytes: sandbox.sizeBytes, metadata: {
          nFiles: sandbox.nFiles, outputBytes: sandbox.outputBytes,
          ...provenance, files,
        },
      },
      summaryArtifact: {
        artifactType: 'expert_r_summary', name: 'Expert R execution summary',
        description: 'Bounded manifest for isolated Expert R outputs.', storageKind: 'metadata_only',
        metadata: {
          ...provenance,
          outputBundleChecksumSha256: sandbox.checksumSha256,
          outputBundleSizeBytes: sandbox.sizeBytes,
          nFiles: sandbox.nFiles,
          files,
          downloadable: false,
        },
      },
    });
  } catch (error) {
    // Definite pre-commit failures leave an orphaned bundle and are safe to
    // remove. A lost COMMIT acknowledgement is different: the database may
    // already reference this exact object, so preserve it for operator repair.
    if (error?.completionMayHaveCommitted !== true
        && typeof ctx.removeDurableObject === 'function') {
      try { await ctx.removeDurableObject(outputStorageKey); } catch { /* original publication error wins */ }
      if (params.environment) try { await ctx.removeDurableObject(environmentStorageKey); } catch { /* original publication error wins */ }
    }
    throw error;
  }
  return {
    resultAnalysisObjectId: completion.resultObject.id,
    result: {
      ok: true,
      handled: 'expert.r.v1',
      resultAnalysisObjectId: completion.resultObject.id,
      bundleArtifactId: completion.bundleArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

// Default registry: `generic` (a pure noop), the test-safe `checkpoint.noop`
// placeholder that exercises the artifact/checkpoint metadata wiring, the minimal
// `r.runtime.check` worker-to-R bridge, the read-only `r.object.inspect` object
// inspection bridge, and allowlisted R/scientific handlers: `pbmc.pipeline.v1`,
// `seurat.pipeline.v1`, `checkpoint.save.v1`, `checkpoint.load.v1`, `checkpoint.fork.v1`,
// `deg.find_markers.v1`, `enrichment.gsea.v1`, and `cellchat.infer.v1`. Other analytical job types
// (normalize/qc_filter/pca/cluster/umap/integrate and cross-condition CellChat)
// remain deliberately UNREGISTERED so the worker fails them (UNSUPPORTED_JOB_TYPE)
// instead of pretending to run them.
const DEFAULT_HANDLERS = Object.freeze({
  generic: genericNoopHandler,
  'checkpoint.noop': checkpointNoopHandler,
  'r.runtime.check': rRuntimeCheckHandler,
  'r.object.inspect': rObjectInspectHandler,
  'pbmc.pipeline.v1': pbmcPipelineHandler,
  'seurat.pipeline.v1': seuratPipelineHandler,
  'seurat.multisample.v1': seuratPipelineHandler,
  'spatial.seurat.v1': spatialSeuratPipelineHandler,
  'checkpoint.save.v1': checkpointSaveHandler,
  'checkpoint.load.v1': checkpointLoadHandler,
  'checkpoint.fork.v1': checkpointForkHandler,
  'deg.find_markers.v1': degFindMarkersHandler,
  'enrichment.gsea.v1': enrichmentGseaHandler,
  'cellchat.infer.v1': cellChatInferenceHandler,
  'explore.summarize.v1': exploratoryAnalysisHandler,
  'condition.pseudobulk_de.v1': conditionComparisonHandler,
  'expert.r.v1': expertRHandler,
});

/**
 * Create a job worker. Returns a runner with `runOnce()`, `start()`, `stop()`,
 * `isRunning()`, and `workerId`. Nothing starts automatically — `start()` must be
 * called explicitly (server startup does this only when ENABLE_JOB_WORKER=true).
 *
 * Options:
 *   - db                 coordination helpers (defaults to ./pgDatabase); injectable for tests
 *   - workerId           this worker's id (defaults to a fresh generated id)
 *   - pollIntervalMs     delay between idle ticks in start() (default 1000)
 *   - leaseSeconds       claim lease length passed to claim/heartbeat (default 120)
 *   - handlers           job_type → async handler registry (default DEFAULT_HANDLERS)
 *   - rBridge            R-bridge module seam (default ./rWorkerBridge); injectable for tests
 *   - callR              R caller used by the bridge; injectable for tests. Defaults to a
 *                        real local-HTTP caller built from rBridgeConfig (used by every
 *                        R-facing handler — r.runtime.check, r.object.inspect,
 *                        pbmc.pipeline.v1, seurat.pipeline.v1, checkpoint.save.v1, checkpoint.load.v1,
 *                        checkpoint.fork.v1, deg.find_markers.v1;
 *                        generic/checkpoint.noop never call R)
 *   - rBridgeConfig      { port, token } for the default R caller (server wires PLUMBER_PORT
 *                        + API_TOKEN here so the in-process worker can reach the local R backend)
 *   - logger             { info, warn, error } (default console)
 *   - now                optional clock: a function (or string) returning a timestamp,
 *                        so tests drive lease timing deterministically. Omit in
 *                        production to use the DB clock.
 */
function createJobWorker(options = {}) {
  const {
    db = database,
    workerId = generateWorkerId(),
    pollIntervalMs = 1000,
    leaseSeconds = JOB_WORKER_DEFAULTS.leaseSeconds,
    handlers = DEFAULT_HANDLERS,
    allowedJobTypes,
    maxConcurrentClaims = 1,
    claimGate,
    rBridge = rWorkerBridge,
    callR,
    rBridgeConfig = {},
    // Server-derived R state-key deriver (ownerUserId, objectId) → X-Object-ID. Used
    // by owner-verified live-object handlers. Injected by the server from its canonical
    // deriveRStateKey so the client never controls the key. Tests inject a deriver
    // (the real server one or a deterministic fake).
    deriveRObjectStateKey,
    runExpertSandbox,
    storageProvider = storage.createLocalStorageProvider(),
    logger = console,
    now,
  } = options;

  // Resolve the R caller once. Tests inject `callR` directly (a fake) so no real
  // HTTP happens; in production the server passes rBridgeConfig (PLUMBER_PORT +
  // API_TOKEN) and we build the narrow local-HTTP caller. Building it eagerly is
  // harmless: it is only invoked when a registered R-facing handler runs.
  const resolvedCallR = typeof callR === 'function'
    ? callR
    : rBridge.createDefaultRCaller(rBridgeConfig);

  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('pollIntervalMs must be a non-negative integer.');
  }

  let running = false;
  let timer = null;
  let tickInFlight = null;

  const log = {
    info: (m) => { if (logger && typeof logger.info === 'function') logger.info(m); },
    warn: (m) => { if (logger && typeof logger.warn === 'function') logger.warn(m); },
    error: (m) => { if (logger && typeof logger.error === 'function') logger.error(m); },
  };

  function resolveNowTs() {
    if (typeof now === 'function') return now();
    if (typeof now === 'string') return now;
    return undefined;
  }

  /** Best-effort durable progress log; swallows CLAIM_LOST so logging never crashes
   *  a tick (the job may have been canceled/reaped between claim and log). */
  async function safeWorkerLog(jobId, claimToken, entry, nowTs) {
    try {
      await db.appendJobLogByWorker(jobId, workerId, claimToken, entry, withNow({}, nowTs));
      return true;
    } catch (err) {
      if (err && (err.code === 'CLAIM_LOST' || err.code === 'JOB_NOT_FOUND')) return false;
      log.warn(`[worker ${workerId}] could not append log to ${jobId}: ${err && err.code ? err.code : 'error'}`);
      return false;
    }
  }

  function withNow(extra, nowTs) {
    return nowTs === undefined ? { ...extra } : { ...extra, now: nowTs };
  }

  // A CLAIM_LOST / JOB_NOT_FOUND while completing/failing means the job was
  // canceled or reaped out from under us: do NOT resurrect it. Re-throw anything
  // else so genuine bugs surface.
  function asClaimLoss(err, phase, jobId, jobType, reaped) {
    if (err && (err.code === 'CLAIM_LOST' || err.code === 'JOB_NOT_FOUND')) {
      log.warn(`[worker ${workerId}] claim lost before ${phase} of ${jobId}; not resurrecting.`);
      return { status: 'claim_lost', jobId, jobType, phase, reaped };
    }
    throw err;
  }

  // Renew from immediately after the initial heartbeat until the claimed
  // lifecycle reaches a guarded terminal/deferred transition. This includes
  // committed-output inspection and hashing, handler validation, R I/O, durable
  // publication, and the final status update.
  function startClaimRenewal(jobId, claimToken) {
    // Renew at one third of the lease. Half-lease cadence leaves only one useful
    // retry window when a container is briefly CPU-starved or Postgres has a
    // transient delay; a delayed first timer can then cross the expiry boundary
    // even though the handler is still making legitimate progress. One-third
    // cadence preserves two renewal opportunities without creating a tight loop.
    const renewEveryMs = Math.max(1000, Math.floor((leaseSeconds * 1000) / 3));
    let stopped = false;
    let renewalInFlight = null;
    let renewTimer = null;

    const stopTimer = () => {
      stopped = true;
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
    };
    const handleRenewalError = (error) => {
      if (error && (error.code === 'CLAIM_LOST' || error.code === 'JOB_NOT_FOUND')) {
        stopTimer();
        return;
      }
      log.warn(`[worker ${workerId}] lease renewal temporarily failed for ${jobId}.`);
    };
    const renew = () => {
      if (stopped || renewalInFlight) return;
      let tracked;
      try {
        tracked = Promise.resolve(
          db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, resolveNowTs()))
        ).catch(handleRenewalError).finally(() => {
          if (renewalInFlight === tracked) renewalInFlight = null;
        });
        renewalInFlight = tracked;
      } catch (error) {
        handleRenewalError(error);
      }
    };

    renewTimer = setInterval(renew, renewEveryMs);
    if (typeof renewTimer.unref === 'function') renewTimer.unref();
    return async () => {
      stopTimer();
      const pending = renewalInFlight;
      if (pending) await pending;
    };
  }

  /**
   * One drain tick: reap expired leases, claim one eligible job, run its handler
   * (or fail it as unsupported), and complete/fail it through the contract. Returns
   * a small result object describing what happened — never throws for the normal
   * idle/claim-loss/handler-failure paths.
   */
  async function runOnce() {
    const nowTs = resolveNowTs();
    let claimAdmission = null;

    // 1. Recover expired leases FIRST so a crashed worker's job becomes claimable.
    let reaped = { requeued: [], failed: [] };
    try {
      reaped = await db.reapExpiredJobs(withNow({}, nowTs));
    } catch (err) {
      log.error(`[worker ${workerId}] reap failed: ${safeDiagnosticCode(err)}`);
    }

    // Pause without claiming when a standalone runtime reports that its private R
    // service, shared storage, or memory admission gate is unavailable. Reaping is
    // intentionally still performed so crashed claims can recover while paused.
    if (typeof claimGate === 'function') {
      try {
        claimAdmission = await claimGate();
        if (!claimAdmission || claimAdmission.ready !== true) {
          return {
            status: 'paused',
            reason: claimAdmission && claimAdmission.reason ? claimAdmission.reason : 'NOT_READY',
            reaped,
          };
        }
      } catch {
        return { status: 'paused', reason: 'NOT_READY', reaped };
      }
    }

    // 2. Claim one eligible queued job (single-winner; null if none available).
    let job;
    try {
      job = await db.claimNextJob(workerId, withNow({
        leaseSeconds,
        allowedJobTypes,
        maxConcurrentClaims,
      }, nowTs));
    } catch (err) {
      log.error(`[worker ${workerId}] claim failed: ${safeDiagnosticCode(err)}`);
      return { status: 'error', phase: 'claim', reaped };
    }
    if (!job) return { status: 'idle', reaped };

    const { id: jobId, jobType, claimToken } = job;
    await safeWorkerLog(jobId, claimToken, { level: 'info', message: `Claimed by worker (type=${jobType}).` }, nowTs);
    log.info(`[worker ${workerId}] claimed ${jobId} (${jobType})`);

    // Heartbeat once up front so the lease covers the handler's run. If the claim is
    // already gone (canceled/reaped between claim and now), bail without resurrecting.
    try {
      await db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, nowTs));
    } catch (err) {
      return asClaimLoss(err, 'pre-handler-heartbeat', jobId, jobType, reaped);
    }

    const stopClaimRenewal = startClaimRenewal(jobId, claimToken);
    try {
      const handler = handlers[jobType];
      if (typeof handler !== 'function') {
        return failUnsupported(jobId, jobType, claimToken, nowTs, reaped);
      }

      let receiptBackedRCompleted = false;
      let observedREnvironment = null;
      async function recordExecutionDispatch(operation, runtimeKind) {
        // Older injected DB mocks have no receipt writer. The production DB
        // always supplies this claim-fenced writer; a persistence failure stops
        // the dispatch before any R or sandbox request can leave the worker.
        if (typeof db.recordJobExecutionReceiptByWorker !== 'function') return;
        const environment = runtimeKind === 'sandbox-r' && job.parameters?.environment
          ? { precision: 'pinned-request', reference: job.parameters.environment }
          : { precision: 'unavailable', reference: null };
        const receipt = await db.recordJobExecutionReceiptByWorker(
          jobId, workerId, claimToken,
          { operation, runtimeKind,
            runtimeGeneration: runtimeKind === 'guided-r' ? claimAdmission?.rRuntimeInstanceHash || null : null,
            environment },
          withNow({}, resolveNowTs())
        );
        if (!receipt) throw codedHandlerError(
          'EXECUTION_RECEIPT_UNAVAILABLE',
          'The analysis execution target could not be recorded safely.'
        );
        return receipt;
      }
      async function runClaimedRBridge(bridgeArgs) {
        const recordedCallR = async request => {
          await recordExecutionDispatch(bridgeArgs.operation, 'guided-r');
          return resolvedCallR(request);
        };
        Object.assign(recordedCallR, resolvedCallR);
        const descriptor = await rBridge.runRBridgeOperation({
          ...bridgeArgs,
          callR: recordedCallR,
          markRDispatchStarted: typeof db.markRDispatchStartedByWorker === 'function'
            ? () => db.markRDispatchStartedByWorker(
              jobId, workerId, claimToken, withNow({}, resolveNowTs())
            )
            : undefined,
        });
        if (COMPLETION_RECEIPT_JOB_TYPES.has(jobType)
            && bridgeArgs.operation !== 'r.checkpoint.hydrate.v1') receiptBackedRCompleted = true;
        observedREnvironment = observedRuntimeMetadata([descriptor, { environmentObserved: observedREnvironment }]);
        if (descriptor.metadata && observedREnvironment) {
          return { ...descriptor, metadata: { ...descriptor.metadata, environmentObserved: observedREnvironment } };
        }
        return descriptor;
      }
      const runClaimedSandbox = typeof runExpertSandbox === 'function' ? async input => {
        const receipt = await recordExecutionDispatch(jobType, 'sandbox-r');
        return runExpertSandbox(/^[a-f0-9]{64}$/.test(receipt?.dispatchId || '') ? {
          ...input, monitoring: { jobId, projectId: job.projectId, ownerUserId: job.ownerUserId, dispatchId: receipt.dispatchId },
        } : input);
      } : undefined;
      const makeClaimContext = (overrides = {}) => ({
        job,
        workerId,
        runtimeCapabilities: claimAdmission?.capabilities || {},
        heartbeat: () => db.heartbeatJob(
          jobId, workerId, claimToken, withNow({ leaseSeconds }, resolveNowTs())
        ),
        log: (entry) => safeWorkerLog(jobId, claimToken, entry, resolveNowTs()),
        createArtifact: (input) => db.createJobArtifactByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        createCheckpointArtifact: (input) => db.createCheckpointArtifactForJobByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        createCheckpoint: (input) => db.createCheckpointForJobByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        completePbmcPipelineResult: (input) => db.completePbmcPipelineResultByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        completeSeuratPipelineResult: (input) => db.completeSeuratPipelineResultByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        completeDegFindMarkersResult: (input) => db.completeDegFindMarkersResultByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        completeEnrichmentGseaResult: (input) => db.completeEnrichmentGseaResultByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        completeCellChatInferenceResult: (input) => db.completeCellChatInferenceResultByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        completeConditionComparisonResult: (input) => db.completeConditionComparisonResultByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        completeExpertRResult: (input) => db.completeExpertRResultByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        completeCheckpointFork: (input) => db.completeCheckpointForkByWorker(
          jobId, workerId, claimToken, input, withNow({}, resolveNowTs())
        ),
        removeDurableObject: (key) => storageProvider.remove(key),
        runRBridgeOperation: runClaimedRBridge,
        callR: resolvedCallR,
        getOwnedAnalysisObject: () => db.getOwnedAnalysisObjectForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        getSeuratPipelineInputs: () => db.getSeuratPipelineInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        getMultiSampleSeuratPipelineInputs: () => db.getMultiSampleSeuratPipelineInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        getSpatialPipelineInputs: () => db.getSpatialPipelineInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        getConditionComparisonInputs: () => db.getConditionComparisonInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        deriveRObjectStateKey: typeof deriveRObjectStateKey === 'function'
          ? deriveRObjectStateKey : undefined,
        getLoadableCheckpoint: () => db.getLoadableCheckpointForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        getHydrationCheckpoint: () => db.getHydrationCheckpointForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        getExpertRPrivateInputs: () => db.getExpertRPrivateInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        getForkableCheckpoint: () => db.getForkableCheckpointForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
        allocateAnalysisObjectId: () => db.generateAnalysisObjectId(),
        logger: log,
        runExpertSandbox: runClaimedSandbox,
        runWorkflow: workflowCtx => require('./workflowWorker').runWorkflowJob(db, workflowCtx, workerId, claimToken, storageProvider),
        recoveringCompletionReceipt: false,
        ...overrides,
      });
      let ctx = makeClaimContext();
      let adoptedCompletionReceipt = null;

      async function cleanupRecoveryEvidenceAfterClaimLoss() {
        // CLAIM_LOST can mean cancellation OR lease expiry/reaping. Deleting on an
        // ambiguous lease loss destroys the only recovery evidence, so consult the
        // authoritative row. Only explicit cancellation makes full cleanup safe;
        // completed output keeps its file but no longer needs the receipt. Missing,
        // running, queued, failed, or unreadable state preserves all evidence.
        let authoritativeJob = null;
        if (typeof db.getWorkerJob === 'function') {
          try { authoritativeJob = await db.getWorkerJob(jobId); } catch { /* preserve */ }
        }
        if (authoritativeJob && authoritativeJob.status === 'canceled') {
          await bestEffortRemoveRecoveryObjects(storageProvider, job);
        } else if (authoritativeJob && authoritativeJob.status === 'completed') {
          await bestEffortRemoveCompletionReceipt(storageProvider, job);
        }
      }

    // If a previous process committed this job's exact atomic output set and then
    // died before the terminal status update, finalize that existing output instead
    // of invoking R again. The DB helper fails closed on partial/ambiguous output.
    if (typeof db.resumeCommittedJobByWorker === 'function') {
      let recovery;
      try {
        recovery = await db.resumeCommittedJobByWorker(
          jobId,
          workerId,
          claimToken,
          withNow({
            rRuntimeInstanceHash: claimAdmission && claimAdmission.rRuntimeInstanceHash,
            inspectStorageObject: (key, expected) => storageProvider.inspect(key, expected),
          }, resolveNowTs())
        );
      } catch (err) {
        if (err && (err.code === 'CLAIM_LOST' || err.code === 'JOB_NOT_FOUND')) {
          await cleanupRecoveryEvidenceAfterClaimLoss();
        }
        return asClaimLoss(err, 'recover-committed-output', jobId, jobType, reaped);
      }
      if (recovery && recovery.resumed) {
        await bestEffortRemoveCompletionReceipt(storageProvider, job);
        log.info(`[worker ${workerId}] recovered committed output for ${jobId} (${jobType})`);
        return { status: 'completed', jobId, jobType, recovered: true, reaped };
      }
      if (recovery && recovery.failed) {
        const recoveryCode = recovery.errorCode || 'INCOMPLETE_COMMITTED_OUTPUT';
        return {
          status: 'failed',
          jobId,
          jobType,
          error: { code: recoveryCode },
          reaped,
        };
      }
    }

    // R writes a private, signed receipt only after its deterministic file output
    // or private live-state mutation succeeds. Probe it before any retry handler is
    // invoked. A present-but-invalid receipt is terminal: falling through to R would
    // risk duplicating an operation whose outcome is already ambiguous.
    if (COMPLETION_RECEIPT_JOB_TYPES.has(jobType)
        && typeof storageProvider.readCompletionReceipt === 'function') {
      let envelope = null;
      let receiptFailure = null;
      try {
        envelope = await storageProvider.readCompletionReceipt(
          storage.completionReceiptKey(job.projectId, job.id)
        );
      } catch (error) {
        if (!error || error.code !== 'STORAGE_OBJECT_MISSING') receiptFailure = error;
      }

      if (envelope && !receiptFailure) {
        try {
          if (typeof resolvedCallR.verifyCompletionReceipt !== 'function'
              || typeof rBridge.descriptorFromCompletionReceipt !== 'function'
              || typeof rBridge.buildCompletionReceiptBinding !== 'function') {
            throw codedHandlerError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
          }
          const receipt = resolvedCallR.verifyCompletionReceipt(envelope);
          const expected = await completionReceiptExpectation(ctx);
          const descriptor = rBridge.descriptorFromCompletionReceipt(job, receipt, expected);

          if (expected.outputStorageKey) {
            if (typeof storageProvider.inspect !== 'function') {
              throw codedHandlerError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
            }
            const integrity = descriptor.checkpoint || descriptor.result;
            await storageProvider.inspect(expected.outputStorageKey, {
              checksumSha256: integrity && integrity.checksumSha256,
              sizeBytes: integrity && integrity.sizeBytes,
            });
          } else {
            const admittedRuntimeHash = claimAdmission && claimAdmission.rRuntimeInstanceHash;
            if (!admittedRuntimeHash || !descriptor.loaded
                || descriptor.loaded.runtimeInstanceHash !== admittedRuntimeHash) {
              const runtimeError = codedHandlerError(
                'LIVE_R_STATE_LOST',
                'The private R runtime changed before completion could be recovered.'
              );
              throw runtimeError;
            }
          }

          const bindingMatches = (bridgeArgs) => {
            const actual = rBridge.buildCompletionReceiptBinding(
              bridgeArgs.job, bridgeArgs.operation, bridgeArgs
            );
            return actual && Object.entries(actual).every(
              ([key, value]) => receipt[key] === value
            );
          };
          adoptedCompletionReceipt = { descriptor, receipt };
          ctx = makeClaimContext({
            recoveringCompletionReceipt: true,
            runRBridgeOperation: async (bridgeArgs) => {
              if (!bindingMatches(bridgeArgs)) {
                throw codedHandlerError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
              }
              return descriptor;
            },
          });
        } catch (error) {
          receiptFailure = error;
        }
      }

      if (receiptFailure) {
        const receiptErrorCode = receiptFailure.code === 'LIVE_R_STATE_LOST'
          ? 'LIVE_R_STATE_LOST' : 'R_COMPLETION_RECEIPT_INVALID';
        const error = {
          code: receiptErrorCode,
          message: receiptErrorCode === 'LIVE_R_STATE_LOST'
            ? 'The private R runtime changed before completion could be recovered.'
            : 'Completion receipt validation failed.',
        };
        try {
          await db.failJobByWorker(
            jobId,
            workerId,
            claimToken,
            error,
            withNow({
              log: {
                level: 'error',
                message: receiptErrorCode === 'LIVE_R_STATE_LOST'
                  ? 'Completion receipt referred to private live state from a prior R runtime.'
                  : 'Completion receipt failed strict integrity or job binding validation; refusing to rerun R.',
              },
            }, resolveNowTs())
          );
        } catch (claimError) {
          return asClaimLoss(claimError, 'fail-invalid-completion-receipt', jobId, jobType, reaped);
        }
        return { status: 'failed', jobId, jobType, error, receiptInvalid: true, reaped };
      }
    }

    // Reaping or revoked-membership admission marks a single claim as
    // recovery-only. If exact committed output was not finalized above, stop
    // safely without invoking the handler or contacting R a second time.
    const recoveryOnlyMarker = job.lastWorkerError && [
      R_TIMEOUT_RECOVERY_PENDING,
      R_RETRY_RECOVERY_PENDING,
      COMMITTED_OUTPUT_RECOVERY_PENDING,
    ].includes(job.lastWorkerError.code);
    if (!adoptedCompletionReceipt && recoveryOnlyMarker) {
      const hasSingletonRExecutionBarrier = claimAdmission
        && claimAdmission.ready === true
        && claimAdmission.recoveryBarrierSafe === true
        && typeof claimAdmission.rRuntimeInstanceHash === 'string'
        && claimAdmission.rRuntimeInstanceHash !== '';
      if (hasSingletonRExecutionBarrier) {
        // Supported production topology uses one synchronous Plumber process. Its
        // authenticated readiness response cannot complete while an earlier handler
        // is still running, and a changed runtime identity means the old process is
        // gone. This is the only proof that makes terminal cleanup safe.
        const error = {
          code: 'R_COMPLETION_RECEIPT_MISSING',
          message: 'R execution stopped without a recoverable completion receipt.',
        };
        try {
          await db.failJobByWorker(
            jobId,
            workerId,
            claimToken,
            error,
            withNow({
              log: {
                level: 'error',
                message: 'The singleton R execution barrier completed without an exact output receipt; the job was stopped safely.',
              },
            }, resolveNowTs())
          );
        } catch (err) {
          return asClaimLoss(err, 'fail-missing-receipt-after-r-barrier', jobId, jobType, reaped);
        }
        await bestEffortRemoveRecoveryObjects(storageProvider, job);
        return { status: 'failed', jobId, jobType, error, recoveryOnly: true, reaped };
      }

      // Absence is not failure: the original synchronous R request may still be
      // executing after Node timed out or crashed. Return to another bounded,
      // receipt-only observation window forever (or until an operator intervenes),
      // preserving both deterministic paths and never dispatching R again.
      await stopClaimRenewal();
      try {
        await db.deferIndeterminateRTimeoutByWorker(
          jobId,
          workerId,
          claimToken,
          withNow({ recoveryDelaySeconds: R_TIMEOUT_RECOVERY_GRACE_SECONDS }, resolveNowTs())
        );
      } catch (err) {
        return asClaimLoss(err, 'defer-unrecovered-r-observation', jobId, jobType, reaped);
      }
      return {
        status: 'indeterminate',
        jobId,
        jobType,
        error: { code: R_TIMEOUT_INDETERMINATE },
        recoveryOnly: true,
        recoveryAfterSeconds: R_TIMEOUT_RECOVERY_GRACE_SECONDS,
        reaped,
      };
    }

    await safeWorkerLog(jobId, claimToken, { level: 'info', message: 'Handler started.' }, nowTs);

    if (!adoptedCompletionReceipt) ctx = {
      job,
      workerId,
      // Preserve the claim gate's explicit worker capability report when the
      // normal execution context is rebuilt after recovery checks.
      runtimeCapabilities: claimAdmission?.capabilities || {},
      heartbeat: () => db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, resolveNowTs())),
      log: (entry) => safeWorkerLog(jobId, claimToken, entry, resolveNowTs()),
      // Durable, claim-guarded metadata writers for handlers that record output.
      // Both are authorized by the live claim (worker_id + claim_token), so a handler
      // can only write to the job it currently holds. They create NO files and expose
      // NO paths — metadata only in this branch.
      createArtifact: (input) => db.createJobArtifactByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      // Durable internal checkpoint artifact (server-set storageKind/key/checksum/size).
      // Distinct from createArtifact, whose generic input deliberately ignores storage
      // fields; used by reviewed handlers that publish local_internal storage.
      createCheckpointArtifact: (input) => db.createCheckpointArtifactForJobByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      createCheckpoint: (input) => db.createCheckpointForJobByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      // Atomic checkpoint-producing completion: result object + job link + lineage
      // edge + checkpoint artifact + summary artifact in ONE claim-guarded transaction,
      // so an artifact failure can't leave a partial result.
      completePbmcPipelineResult: (input) => db.completePbmcPipelineResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      completeSeuratPipelineResult: (input) => db.completeSeuratPipelineResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      // Atomic DEG completion: the local_internal marker-table artifact + the metadata-only
      // summary artifact in ONE claim-guarded transaction (used only by the deg.find_markers.v1
      // handler) so one artifact can't commit without the other. Creates NO result object/edge.
      completeDegFindMarkersResult: (input) => db.completeDegFindMarkersResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      completeEnrichmentGseaResult: (input) => db.completeEnrichmentGseaResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      completeCellChatInferenceResult: (input) => db.completeCellChatInferenceResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      completeConditionComparisonResult: (input) => db.completeConditionComparisonResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      completeExpertRResult: (input) => db.completeExpertRResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      completeCheckpointFork: (input) => db.completeCheckpointForkByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      removeDurableObject: (key) => storageProvider.remove(key),
      // R-bridge seam (used by every R-facing handler: r.runtime.check,
      // r.object.inspect, pbmc.pipeline.v1, seurat.pipeline.v1,
      // checkpoint.save.v1, checkpoint.load.v1, checkpoint.fork.v1, deg.find_markers.v1).
      // The bridge is a pure function; the resolved R caller is injected so it cannot
      // reach R by any path other than this server-controlled one.
      //
      // Real R compute (Seurat preprocessing, FindAllMarkers, checkpoint load) is a
      // single blocking bridge call that can run tens of seconds to minutes — longer
      // than the claim lease. The worker is single-threaded, but the R call is awaited
      // (I/O-bound), so we renew the lease from a timer while it is in flight. Without
      // this the lease expires mid-run, the job is reaped and retried, and overlapping
      // retries run concurrent heavy R (memory-driven 500s) until max_attempts fails
      // the job. Cancellation stays cooperative: a heartbeat that loses the claim is
      // swallowed here and surfaces at the guarded completion after R returns.
      // The surrounding claimed-lifecycle timer also covers recovery hashing and
      // durable publication before/after this bridge call.
      runRBridgeOperation: runClaimedRBridge,
      callR: resolvedCallR,
      // Claim-authorized resource resolvers derive every id from the trusted job
      // row and validate this worker's live lease/token. They deliberately do not
      // re-read project membership after claim: claim-time eligibility is the
      // authorization boundary for an already-running job. Object ownership and
      // exact project/dataset/checkpoint scope remain mandatory.
      getOwnedAnalysisObject: () =>
        db.getOwnedAnalysisObjectForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      getSeuratPipelineInputs: () =>
        db.getSeuratPipelineInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      getMultiSampleSeuratPipelineInputs: () =>
        db.getMultiSampleSeuratPipelineInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      getSpatialPipelineInputs: () =>
        db.getSpatialPipelineInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      getConditionComparisonInputs: () =>
        db.getConditionComparisonInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      deriveRObjectStateKey: typeof deriveRObjectStateKey === 'function' ? deriveRObjectStateKey : undefined,
      // Server-selected checkpoint resolvers keep internal storage keys private
      // while binding selection to this job's valid claim and trusted source id.
      getLoadableCheckpoint: () =>
        db.getLoadableCheckpointForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      getHydrationCheckpoint: () =>
        db.getHydrationCheckpointForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      getExpertRPrivateInputs: () =>
        db.getExpertRPrivateInputsForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      getForkableCheckpoint: () =>
        db.getForkableCheckpointForJobByWorker(
          jobId, workerId, claimToken, withNow({}, resolveNowTs())
        ),
      allocateAnalysisObjectId: () => db.generateAnalysisObjectId(),
      logger: log,
      runExpertSandbox: runClaimedSandbox,
      runWorkflow: workflowCtx => require('./workflowWorker').runWorkflowJob(db, workflowCtx, workerId, claimToken, storageProvider),
    };

    let outcome;
    try {
      outcome = await handler(ctx);
    } catch (handlerErr) {
      let effectiveHandlerErr = handlerErr;
      if (effectiveHandlerErr
          && effectiveHandlerErr.code === R_COMPLETION_PUBLICATION_INDETERMINATE
          && adoptedCompletionReceipt) {
        let publicationRecovery = null;
        if (typeof db.resumeCommittedJobByWorker === 'function') {
          try {
            publicationRecovery = await db.resumeCommittedJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({
                rRuntimeInstanceHash: claimAdmission && claimAdmission.rRuntimeInstanceHash,
                inspectStorageObject: (key, expected) => storageProvider.inspect(key, expected),
              }, resolveNowTs())
            );
          } catch (error) {
            if (error && (error.code === 'CLAIM_LOST' || error.code === 'JOB_NOT_FOUND')) {
              effectiveHandlerErr = error;
              publicationRecovery = { claimLost: true };
            } else {
              throw error;
            }
          }
        }
        if (publicationRecovery && publicationRecovery.resumed) {
          await bestEffortRemoveCompletionReceipt(storageProvider, job);
          return {
            status: 'completed',
            jobId,
            jobType,
            recovered: true,
            publicationRecovered: true,
            reaped,
          };
        }
        if (publicationRecovery && publicationRecovery.failed) {
          await bestEffortRemoveRecoveryObjects(storageProvider, job);
          return {
            status: 'failed',
            jobId,
            jobType,
            error: { code: publicationRecovery.errorCode || 'INCOMPLETE_COMMITTED_OUTPUT' },
            reaped,
          };
        }
        if (!publicationRecovery || !publicationRecovery.claimLost) {
          // One receipt-only publication retry has now returned an error and an
          // exact DB re-read found no committed output. Bound the ambiguity here.
          effectiveHandlerErr = codedHandlerError(
            'R_COMPLETION_PUBLICATION_FAILED',
            'Completion publication could not be recovered.'
          );
        }
      }
      const claimLostAfterReceiptBackedSuccess = effectiveHandlerErr
        && (effectiveHandlerErr.code === 'CLAIM_LOST'
          || effectiveHandlerErr.code === 'JOB_NOT_FOUND')
        && (adoptedCompletionReceipt || receiptBackedRCompleted);
      if (isIndeterminateRExecutionFailure(effectiveHandlerErr)) {
        // Fence the recovery grace against a timer heartbeat already in flight.
        await stopClaimRenewal();
      } else if (claimLostAfterReceiptBackedSuccess) {
        await cleanupRecoveryEvidenceAfterClaimLoss();
      } else if (adoptedCompletionReceipt || receiptBackedRCompleted) {
        await bestEffortRemoveRecoveryObjects(storageProvider, job);
      } else {
        await bestEffortRemoveCompletionReceipt(storageProvider, job);
      }
      return failHandlerError(
        jobId, jobType, claimToken, effectiveHandlerErr, resolveNowTs(), reaped
      );
    }

    // Handler publication is claim-guarded and authoritative. A crash before the
    // generic terminal update still converges through committed-output recovery.
    await bestEffortRemoveCompletionReceipt(storageProvider, job);

    // 3. Success → complete through the contract (guarded UPDATE; will not resurrect
    //    a job canceled mid-run — that surfaces as CLAIM_LOST).
    if (outcome?.workflowCommitted) {
      return { status: 'completed', jobId, jobType, result: outcome.result, reaped };
    }
    const completeNow = resolveNowTs();
    const completeOpts = withNow({ log: { level: 'info', message: 'Handler completed.' } }, completeNow);
    if (outcome && typeof outcome === 'object' && outcome.resultAnalysisObjectId) {
      completeOpts.resultAnalysisObjectId = outcome.resultAnalysisObjectId;
    }
    try {
      await db.completeJobByWorker(jobId, workerId, claimToken, completeOpts);
    } catch (err) {
      return asClaimLoss(err, 'complete', jobId, jobType, reaped);
    }
    log.info(`[worker ${workerId}] completed ${jobId} (${jobType})`);
    return { status: 'completed', jobId, jobType, result: outcome && outcome.result, reaped };
    } finally {
      await stopClaimRenewal();
    }
  }

  async function failUnsupported(jobId, jobType, claimToken, nowTs, reaped) {
    log.warn(`[worker ${workerId}] unsupported job type '${jobType}' for ${jobId}; failing.`);
    const opts = withNow({ log: { level: 'error', message: `Unsupported job type '${jobType}'.` } }, nowTs);
    try {
      await db.failJobByWorker(
        jobId, workerId, claimToken,
        { code: UNSUPPORTED_JOB_TYPE, message: `No handler registered for job type '${jobType}'.` },
        opts
      );
    } catch (err) {
      return asClaimLoss(err, 'fail-unsupported', jobId, jobType, reaped);
    }
    return { status: 'unsupported', jobId, jobType, reaped };
  }

  async function failHandlerError(jobId, jobType, claimToken, handlerErr, nowTs, reaped) {
    // If the handler failed BECAUSE the claim was lost (e.g. a cooperative
    // ctx.heartbeat() detected cancellation), do not try to fail the job — it is no
    // longer ours.
    if (handlerErr && (handlerErr.code === 'CLAIM_LOST' || handlerErr.code === 'JOB_NOT_FOUND')) {
      log.warn(`[worker ${workerId}] claim lost during handler for ${jobId}; not resurrecting.`);
      return { status: 'claim_lost', jobId, jobType, phase: 'handler', reaped };
    }
    if (isIndeterminateRExecutionFailure(handlerErr)) {
      log.warn(`[worker ${workerId}] R execution outcome is indeterminate for ${jobId}; retaining the claim for bounded recovery.`);
      try {
        await db.deferIndeterminateRTimeoutByWorker(
          jobId,
          workerId,
          claimToken,
          withNow({ recoveryDelaySeconds: R_TIMEOUT_RECOVERY_GRACE_SECONDS }, nowTs)
        );
      } catch (err) {
        return asClaimLoss(err, 'defer-r-timeout', jobId, jobType, reaped);
      }
      return {
        status: 'indeterminate',
        jobId,
        jobType,
        error: { code: R_TIMEOUT_INDETERMINATE },
        recoveryAfterSeconds: R_TIMEOUT_RECOVERY_GRACE_SECONDS,
        reaped,
      };
    }
    // Record a sanitized message only — never a stack/path. Handlers are responsible
    // for not embedding secrets in their error messages.
    const stableDomainCode = handlerErr?.code === 'R_CELLCHAT_INFERENCE_FAILED'
      && typeof handlerErr?.rCode === 'string'
      && SAFE_HANDLER_DOMAIN_MESSAGES[handlerErr.rCode]
      ? handlerErr.rCode
      : handlerErr?.code;
    const domainMessage = typeof stableDomainCode === 'string'
      ? SAFE_HANDLER_DOMAIN_MESSAGES[stableDomainCode]
      : null;
    const message = domainMessage || (handlerErr && handlerErr.publicSafeHandlerError === true
      ? String(handlerErr.message || 'Handler failed.').slice(0, 240)
      : 'Handler failed.');
    const diagnosticCode = safeDiagnosticCode(handlerErr);
    log.error(`[worker ${workerId}] handler error for ${jobId}: ${diagnosticCode}`);
    const opts = withNow({ log: { level: 'error', message: 'Handler failed.' } }, nowTs);
    try {
      await db.failJobByWorker(jobId, workerId, claimToken, { code: domainMessage ? stableDomainCode : 'HANDLER_ERROR', message }, opts);
    } catch (err) {
      return asClaimLoss(err, 'fail-handler', jobId, jobType, reaped);
    }
    return { status: 'failed', jobId, jobType, error: { code: domainMessage ? stableDomainCode : 'HANDLER_ERROR', message }, reaped };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  // start() runs a self-rescheduling setTimeout loop (NOT setInterval) so a slow
  // tick never overlaps itself and stop() can deterministically clear the single
  // pending timer — no leaked timers.
  async function tick() {
    timer = null;
    if (!running) return;
    tickInFlight = runOnce()
      .catch((err) => log.error(`[worker ${workerId}] tick error: ${safeDiagnosticCode(err)}`))
      .finally(() => { tickInFlight = null; });
    await tickInFlight;
    if (running) timer = setTimeout(tick, pollIntervalMs);
  }

  function start() {
    if (running) return;
    running = true;
    timer = setTimeout(tick, 0);
  }

  async function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    // Let any in-flight tick settle so we never leave a half-finished claim behind.
    if (tickInFlight) { try { await tickInFlight; } catch { /* already logged */ } }
  }

  function isRunning() {
    return running;
  }

  return { runOnce, start, stop, isRunning, workerId, leaseSeconds };
}

module.exports = {
  createJobWorker,
  generateWorkerId,
  genericNoopHandler,
  checkpointNoopHandler,
  rRuntimeCheckHandler,
  rObjectInspectHandler,
  pbmcPipelineHandler,
  seuratPipelineHandler,
  spatialSeuratPipelineHandler,
  checkpointSaveHandler,
  checkpointLoadHandler,
  checkpointForkHandler,
  degFindMarkersHandler,
  enrichmentGseaHandler,
  cellChatInferenceHandler,
  exploratoryAnalysisHandler,
  conditionComparisonHandler,
  expertRHandler,
  DEFAULT_HANDLERS,
  UNSUPPORTED_JOB_TYPE,
  JOB_WORKER_DEFAULTS,
  JOB_WORKER_MIN_LEASE_SECONDS,
  parseJobWorkerConfig,
  parsePositiveIntOrNull,
};
