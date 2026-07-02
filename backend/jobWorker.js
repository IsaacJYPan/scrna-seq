// ── Minimal job worker drain loop ────────────────────────────────────────────
//
// The smallest production-oriented worker that consumes the durable job-worker
// coordination contract shipped in database.js (claim / lease / heartbeat /
// complete / fail / release / reap). It proves a queued job can be claimed,
// heartbeated, completed or failed, protected from duplicate workers, and handled
// safely after cancellation or lease expiry — with durable status + logs.
//
// SCOPE: the registry has grown beyond a noop. Registered handlers now include a
// safe `generic` noop, a metadata-only `checkpoint.noop`, read-only R inspection
// (`r.runtime.check`, `r.object.inspect`), and REAL scientific/R work:
// `pbmc.pipeline.v1` (Seurat preprocessing on a COPY of the input object, writes a
// checkpoint RDS), `checkpoint.load.v1` (mutates the OWNER's live R session), and
// `deg.find_markers.v1` (DEG/FindAllMarkers). See DEFAULT_HANDLERS below for the
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
const database = require('./database');
const rWorkerBridge = require('./rWorkerBridge');
const { validatePbmcPipelineParams, allocateCheckpointStorageKey } = require('./pbmcPipeline');
const { validateDegFindMarkersParams, allocateDegResultStorageKey } = require('./degFindMarkers');

/** Stable, header-safe worker id (`worker_` + hex). One per worker instance. */
function generateWorkerId() {
  return `worker_${crypto.randomBytes(8).toString('hex')}`;
}

// Error code recorded on a job whose type has no registered handler.
const UNSUPPORTED_JOB_TYPE = 'UNSUPPORTED_JOB_TYPE';

/** Coded handler error carrying a stable, SAFE message. Handlers throw these for
 *  pre-R validation failures; the message is durable (failHandlerError records it),
 *  so it must never contain secrets, paths, or another user's existence details. */
function codedHandlerError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Documented safe defaults for worker runtime config. These MUST match the values
// documented in .env.example (JOB_WORKER_POLL_MS / JOB_WORKER_LEASE_SECONDS) and the
// createJobWorker() option defaults above.
const JOB_WORKER_DEFAULTS = Object.freeze({ pollIntervalMs: 1000, leaseSeconds: 30 });

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
 *   - JOB_WORKER_LEASE_SECONDS must be a positive integer; otherwise fall back to the
 *     documented default and warn (only if present but invalid).
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
  if (leaseSeconds === null) {
    if (leaseRaw !== undefined) {
      warn(`[worker] JOB_WORKER_LEASE_SECONDS is not a positive integer; using default ${defaults.leaseSeconds}s.`);
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
  ctx.heartbeat();
  ctx.log({ level: 'info', message: 'noop handler: no pipeline execution in this branch.' });
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
  ctx.heartbeat();
  ctx.log({ level: 'info', message: 'checkpoint.noop handler: creating placeholder, metadata-only checkpoint (no R/Seurat execution).' });

  const checkpoint = ctx.createCheckpoint({
    objectType: 'generic',
    displayName: 'Placeholder checkpoint (no pipeline execution)',
    metadata: { placeholder: true, checkpoint: true, source: 'checkpoint.noop', scientific_output: false }
  });

  const artifact = ctx.createArtifact({
    artifactType: 'checkpoint',
    resultAnalysisObjectId: checkpoint.id,
    name: 'Placeholder checkpoint metadata',
    description: 'Metadata-only checkpoint record. No raw artifact, no download, no real scientific output in this branch.',
    storageKind: 'metadata_only',
    metadata: { placeholder: true, scientific_output: false }
  });

  ctx.log({ level: 'info', message: `checkpoint.noop handler: recorded checkpoint ${checkpoint.id} and artifact ${artifact.id} (metadata-only).` });

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
  ctx.heartbeat();
  ctx.log({ level: 'info', message: 'r.runtime.check handler: invoking allowlisted, metadata-only R runtime check (no pipeline execution).' });

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

  const artifact = ctx.createArtifact({
    artifactType: descriptor.artifactType, // 'r_runtime_check'
    name: descriptor.name,
    description: descriptor.description,
    storageKind: descriptor.storageKind, // 'metadata_only'
    metadata: descriptor.metadata,
  });

  ctx.log({ level: 'info', message: `r.runtime.check handler: recorded metadata-only artifact ${artifact.id} (operational inspection, not a scientific output).` });

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
 *   (job.ownerUserId) OWNS that analysis object via the same owner-verified check the
 *   /api/r/* proxy uses (verifyAnalysisObjectOwner). A project co-member (even an
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
  ctx.heartbeat();
  ctx.log({ level: 'info', message: 'r.object.inspect handler: validating object ownership before any R contact (read-only inspection, no pipeline execution).' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an analysis object. Fail safely BEFORE any R contact.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Inspection job is missing its analysis object.');
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may inspect. This
  //    is the same owner-verified check the /api/r/* proxy uses, so project membership
  //    alone can never reach another user's live object. Uses a 404-style message so
  //    we never reveal another user's object exists.
  if (typeof ctx.verifyAnalysisObjectOwner !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  if (!ctx.verifyAnalysisObjectOwner(job.ownerUserId, objectId)) {
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

  const artifact = ctx.createArtifact({
    artifactType: descriptor.artifactType, // 'r_object_inspection'
    // Associate the artifact with the inspected object (defaults to the job's own
    // analysis object, which is already same-scope) — metadata link only, not access.
    name: descriptor.name,
    description: descriptor.description,
    storageKind: descriptor.storageKind, // 'metadata_only'
    metadata: descriptor.metadata,
  });

  ctx.log({ level: 'info', message: `r.object.inspect handler: recorded metadata-only artifact ${artifact.id} (read-only inspection, not a scientific output).` });

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
 *   live object (verifyAnalysisObjectOwner) BEFORE any R contact, and the R state key
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
  ctx.heartbeat();
  ctx.log({ level: 'info', message: 'pbmc.pipeline.v1 handler: validating ownership + parameters before any R contact.' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an input analysis object. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Pipeline job is missing its input analysis object.');
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may run the
  //    pipeline. Same owner-verified check the /api/r/* proxy uses; 404-style message
  //    so another user's object existence is never revealed.
  if (typeof ctx.verifyAnalysisObjectOwner !== 'function' || typeof ctx.deriveRObjectStateKey !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  if (!ctx.verifyAnalysisObjectOwner(job.ownerUserId, objectId)) {
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
  //    traversal-free; the R backend confines it to its vault). Never logged/exposed.
  const checkpointStorageKey = allocateCheckpointStorageKey(job.id);

  ctx.log({ level: 'info', message: 'pbmc.pipeline.v1 handler: parameters valid; invoking allowlisted PBMC pipeline on a copy of the input object (parent unchanged).' });

  // 6. Run the allowlisted, mutating bridge op. Object context + params body are all
  //    server-derived; the bridge ignores raw job input for routing.
  const descriptor = await ctx.runRBridgeOperation({
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

  // 7. A durable checkpoint MUST have been saved (with integrity) for success. If not,
  //    fail BEFORE creating any DB result — so a missing/failed save leaves no result
  //    object, edge, or artifact behind (nothing to roll back).
  const checkpoint = descriptor.checkpoint || {};
  if (checkpoint.saved !== true || typeof checkpoint.checksumSha256 !== 'string' || checkpoint.checksumSha256 === '') {
    throw codedHandlerError('CHECKPOINT_SAVE_FAILED', 'Pipeline did not produce a durable checkpoint.');
  }

  // 8. Create the result analysis object (a CHILD checkpoint of the input object), the
  //    job result link, the parent→result lineage edge, AND both required artifacts
  //    (local_internal checkpoint + metadata_only pipeline_summary) in ONE atomic,
  //    claim/lease-guarded DB transaction. Either all five durable records commit
  //    together or none do — a failure can never leave a failed job linked to a result
  //    object/edge with missing artifacts. The parent is never mutated; result metadata
  //    records provenance WITHOUT implying a download.
  const completion = ctx.completePbmcPipelineResult({
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
      description: 'Durable internal checkpoint of the PBMC pipeline result object (RDS on the R backend vault). No public download in this branch.',
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

  const resultObject = completion.resultObject;
  const checkpointArtifact = completion.checkpointArtifact;
  const summaryArtifact = completion.summaryArtifact;

  ctx.log({ level: 'info', message: `pbmc.pipeline.v1 handler: result object ${resultObject.id} created with checkpoint ${checkpointArtifact.id} + summary ${summaryArtifact.id} (parent ${objectId} unchanged).` });

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
 * Checkpoint load / reattach handler (`checkpoint.load.v1`): loads a COMPLETED durable
 * internal checkpoint (produced by pbmc.pipeline.v1) back into the job OWNER's PRIVATE
 * live R session under the canonical object key, so downstream jobs can use it as live
 * input. It is a live-state MUTATION of exactly one owner/object-keyed session — that is
 * the purpose of this branch — but it creates NO new analysis object, NO lineage edge,
 * and NO checkpoint artifact (it only reattaches an existing one).
 *
 * SAME OWNERSHIP BOUNDARY as r.object.inspect / pbmc.pipeline.v1 (project membership ≠
 * live R access), enforced TWICE before any R contact:
 *   - the object id comes from the TRUSTED job row; the job creator must OWN the live
 *     object (verifyAnalysisObjectOwner), and the X-Object-ID is SERVER-derived
 *     (deriveRObjectStateKey); a co-member/admin/viewer who created a job against another
 *     user's object FAILS here.
 *   - getLoadableCheckpoint re-verifies ownership + project scope + checkpoint storage
 *     metadata and returns the SERVER-selected internal storage key (never client input).
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
  ctx.heartbeat();
  ctx.log({ level: 'info', message: 'checkpoint.load.v1 handler: validating ownership + resolving checkpoint before any R contact.' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference the analysis object to load. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'Checkpoint load job is missing its analysis object.');
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may load. Same
  //    owner-verified check the /api/r/* proxy uses; 404-style message so another
  //    user's object existence is never revealed. Also require the server-injected
  //    deriver + loadable-checkpoint resolver.
  if (typeof ctx.verifyAnalysisObjectOwner !== 'function'
    || typeof ctx.deriveRObjectStateKey !== 'function'
    || typeof ctx.getLoadableCheckpoint !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  if (!ctx.verifyAnalysisObjectOwner(job.ownerUserId, objectId)) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
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
  const checkpoint = ctx.getLoadableCheckpoint(job.projectId || null, objectId, job.ownerUserId);

  ctx.log({ level: 'info', message: 'checkpoint.load.v1 handler: checkpoint resolved; loading into the owner\'s private live R session (no new object/edge).' });

  // 5. Run the allowlisted, mutating bridge op. Object context + checkpoint coordinates
  //    are all server-derived; the bridge ignores raw job input for routing/storage key.
  const descriptor = await ctx.runRBridgeOperation({
    job,
    operation: 'r.checkpoint.load.v1',
    actor: { userId: job.ownerUserId, projectId: job.projectId || null },
    objectContext: { objectId, stateKey },
    checkpoint: {
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
  const artifact = ctx.createArtifact({
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

  ctx.log({ level: 'info', message: `checkpoint.load.v1 handler: recorded metadata-only artifact ${artifact.id} (live-state reattach; no new analysis object or lineage edge).` });

  // No result analysis object / checkpoint / lineage edge: this is a live-state reattach.
  return {
    result: { ok: true, handled: 'checkpoint.load.v1', operation: 'r.checkpoint.load.v1', artifactId: artifact.id },
  };
}

/**
 * DEG / marker-finding handler (`deg.find_markers.v1`): runs the existing FindAllMarkers
 * path over the OWNER's existing live analysis object (usually one produced by
 * pbmc.pipeline.v1 → checkpoint.load.v1) as ONE allowlisted bridge operation. DEG is an
 * OUTPUT-producing analysis, NOT a mutating checkpoint transformation: it creates NO new
 * analysis object and NO lineage edge, and does not mutate the live object (any temporary
 * identity change is restored R-side). It writes (1) an internal full marker-table artifact
 * (local_internal; no public download) and (2) a metadata-only DEG summary artifact.
 *
 * SAME OWNERSHIP BOUNDARY as r.object.inspect / pbmc.pipeline.v1 / checkpoint.load.v1
 * (project membership ≠ live R access): the input object id comes from the TRUSTED job row;
 * the job creator must OWN that live object (verifyAnalysisObjectOwner) BEFORE any R contact,
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
async function degFindMarkersHandler(ctx) {
  ctx.heartbeat();
  ctx.log({ level: 'info', message: 'deg.find_markers.v1 handler: validating ownership + parameters before any R contact.' });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an input analysis object. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError('R_OBJECT_CONTEXT_REQUIRED', 'DEG job is missing its input analysis object.');
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may run DEG. Same
  //    owner-verified check the /api/r/* proxy uses; 404-style message so another user's
  //    object existence is never revealed. Also require the server-injected deriver.
  if (typeof ctx.verifyAnalysisObjectOwner !== 'function' || typeof ctx.deriveRObjectStateKey !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }
  if (!ctx.verifyAnalysisObjectOwner(job.ownerUserId, objectId)) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }

  // 3. Derive the input object's R state key (X-Object-ID) SERVER-SIDE. Never client-
  //    provided; identical to what /api/r/* would send for this owner+object.
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  // 4. Validate + resolve parameters against the fixed allowlist BEFORE any R contact.
  //    Throws a coded, SAFE-message error (INVALID_PARAMETER / UNKNOWN_PARAMETER / …)
  //    that fails the job terminally without contacting R.
  const { params, defaultsApplied } = validateDegFindMarkersParams(job.parameters);

  // 5. Server-allocate the internal result storage key (no client input; relative,
  //    traversal-free; the R backend confines it to its vault). Never logged/exposed.
  const resultStorageKey = allocateDegResultStorageKey(job.id);

  ctx.log({ level: 'info', message: 'deg.find_markers.v1 handler: parameters valid; running allowlisted DEG over the existing live object (no new object/edge, object not mutated).' });

  // 6. Run the allowlisted DEG bridge op. Object context + params body are all server-
  //    derived; the bridge ignores raw job input for routing/storage key.
  const descriptor = await ctx.runRBridgeOperation({
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

  // 7. The full marker table MUST have been written (with integrity) for success. If not,
  //    fail BEFORE creating any DB artifact — so a missing/failed write leaves nothing behind.
  const result = descriptor.result || {};
  if (result.saved !== true || typeof result.checksumSha256 !== 'string' || result.checksumSha256 === '') {
    throw codedHandlerError('DEG_RESULT_WRITE_FAILED', 'DEG run did not produce a durable marker table.');
  }

  // 8. Record BOTH artifacts in ONE atomic, claim/lease-guarded transaction: the
  //    local_internal full-table artifact (server-allocated key + checksum/size, key stripped
  //    from public reads) and the metadata-only summary artifact (resolved params + bounded
  //    summary). NO result analysis object and NO lineage edge are created.
  const completion = ctx.completeDegFindMarkersResult({
    markersArtifact: {
      artifactType: 'deg_markers',
      name: 'DEG marker table',
      description: 'Durable internal full DEG marker table (CSV on the R backend vault). No public download in this branch.',
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

  const markersArtifact = completion.markersArtifact;
  const summaryArtifact = completion.summaryArtifact;

  ctx.log({ level: 'info', message: `deg.find_markers.v1 handler: recorded marker table ${markersArtifact.id} + summary ${summaryArtifact.id} (object ${objectId} not mutated; no new object/edge).` });

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

// Default registry: `generic` (a pure noop), the test-safe `checkpoint.noop`
// placeholder that exercises the artifact/checkpoint metadata wiring, the minimal
// `r.runtime.check` worker-to-R bridge, the read-only `r.object.inspect` object
// inspection bridge, and allowlisted R/scientific handlers: `pbmc.pipeline.v1`,
// `checkpoint.load.v1`, and `deg.find_markers.v1`. Other analytical job types
// (normalize/qc_filter/pca/cluster/umap/integrate, pathway enrichment, CellChat)
// remain deliberately UNREGISTERED so the worker fails them (UNSUPPORTED_JOB_TYPE)
// instead of pretending to run them.
const DEFAULT_HANDLERS = Object.freeze({
  generic: genericNoopHandler,
  'checkpoint.noop': checkpointNoopHandler,
  'r.runtime.check': rRuntimeCheckHandler,
  'r.object.inspect': rObjectInspectHandler,
  'pbmc.pipeline.v1': pbmcPipelineHandler,
  'checkpoint.load.v1': checkpointLoadHandler,
  'deg.find_markers.v1': degFindMarkersHandler,
});

/**
 * Create a job worker. Returns a runner with `runOnce()`, `start()`, `stop()`,
 * `isRunning()`, and `workerId`. Nothing starts automatically — `start()` must be
 * called explicitly (server startup does this only when ENABLE_JOB_WORKER=true).
 *
 * Options:
 *   - db                 coordination helpers (defaults to ./database); injectable for tests
 *   - workerId           this worker's id (defaults to a fresh generated id)
 *   - pollIntervalMs     delay between idle ticks in start() (default 1000)
 *   - leaseSeconds       claim lease length passed to claim/heartbeat (default 30)
 *   - handlers           job_type → async handler registry (default DEFAULT_HANDLERS)
 *   - rBridge            R-bridge module seam (default ./rWorkerBridge); injectable for tests
 *   - callR              R caller used by the bridge; injectable for tests. Defaults to a
 *                        real local-HTTP caller built from rBridgeConfig (used by every
 *                        R-facing handler — r.runtime.check, r.object.inspect,
 *                        pbmc.pipeline.v1, checkpoint.load.v1, deg.find_markers.v1;
 *                        generic/checkpoint.noop never call R)
 *   - rBridgeConfig      { port, token } for the default R caller (server wires PLUMBER_PORT
 *                        + API_TOKEN here so the in-process worker can reach the local R backend)
 *   - logger             { info, warn, error } (default console)
 *   - now                optional clock: a function (or string) returning a SQLite
 *                        'YYYY-MM-DD HH:MM:SS' timestamp, so tests drive lease timing
 *                        deterministically. Omit in production to use the DB clock.
 */
function createJobWorker(options = {}) {
  const {
    db = database,
    workerId = generateWorkerId(),
    pollIntervalMs = 1000,
    leaseSeconds = 30,
    handlers = DEFAULT_HANDLERS,
    rBridge = rWorkerBridge,
    callR,
    rBridgeConfig = {},
    // Server-derived R state-key deriver (ownerUserId, objectId) → X-Object-ID. Used
    // by owner-verified live-object handlers. Injected by the server from its canonical
    // deriveRStateKey so the client never controls the key. Tests inject a deriver
    // (the real server one or a deterministic fake).
    deriveRObjectStateKey,
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
  function safeWorkerLog(jobId, claimToken, entry, nowTs) {
    try {
      db.appendJobLogByWorker(jobId, workerId, claimToken, entry, withNow({}, nowTs));
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

  /**
   * One drain tick: reap expired leases, claim one eligible job, run its handler
   * (or fail it as unsupported), and complete/fail it through the contract. Returns
   * a small result object describing what happened — never throws for the normal
   * idle/claim-loss/handler-failure paths.
   */
  async function runOnce() {
    const nowTs = resolveNowTs();

    // 1. Recover expired leases FIRST so a crashed worker's job becomes claimable.
    let reaped = { requeued: [], failed: [] };
    try {
      reaped = db.reapExpiredJobs(withNow({}, nowTs));
    } catch (err) {
      log.error(`[worker ${workerId}] reap failed: ${err && err.code ? err.code : err.message}`);
    }

    // 2. Claim one eligible queued job (single-winner; null if none available).
    let job;
    try {
      job = db.claimNextJob(workerId, withNow({ leaseSeconds }, nowTs));
    } catch (err) {
      log.error(`[worker ${workerId}] claim failed: ${err && err.code ? err.code : err.message}`);
      return { status: 'error', phase: 'claim', reaped };
    }
    if (!job) return { status: 'idle', reaped };

    const { id: jobId, jobType, claimToken } = job;
    safeWorkerLog(jobId, claimToken, { level: 'info', message: `Claimed by worker (type=${jobType}).` }, nowTs);
    log.info(`[worker ${workerId}] claimed ${jobId} (${jobType})`);

    const handler = handlers[jobType];
    if (typeof handler !== 'function') {
      return failUnsupported(jobId, jobType, claimToken, nowTs, reaped);
    }

    // Heartbeat once up front so the lease covers the handler's run. If the claim is
    // already gone (canceled/reaped between claim and now), bail without resurrecting.
    try {
      db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, nowTs));
    } catch (err) {
      return asClaimLoss(err, 'pre-handler-heartbeat', jobId, jobType, reaped);
    }

    safeWorkerLog(jobId, claimToken, { level: 'info', message: 'Handler started.' }, nowTs);

    const ctx = {
      job,
      workerId,
      heartbeat: () => db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, resolveNowTs())),
      log: (entry) => safeWorkerLog(jobId, claimToken, entry, resolveNowTs()),
      // Durable, claim-guarded metadata writers for handlers that record output.
      // Both are authorized by the live claim (worker_id + claim_token), so a handler
      // can only write to the job it currently holds. They create NO files and expose
      // NO paths — metadata only in this branch.
      createArtifact: (input) => db.createJobArtifactByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      // Durable internal checkpoint artifact (server-set storageKind/key/checksum/size).
      // Distinct from createArtifact, whose generic input deliberately ignores storage
      // fields; used only by the pbmc.pipeline.v1 handler for local_internal storage.
      createCheckpointArtifact: (input) => db.createCheckpointArtifactForJobByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      createCheckpoint: (input) => db.createCheckpointForJobByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      // Atomic PBMC completion: result object + job link + lineage edge + checkpoint
      // artifact + summary artifact in ONE claim-guarded transaction (used only by the
      // pbmc.pipeline.v1 handler) so an artifact failure can't leave a partial result.
      completePbmcPipelineResult: (input) => db.completePbmcPipelineResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      // Atomic DEG completion: the local_internal marker-table artifact + the metadata-only
      // summary artifact in ONE claim-guarded transaction (used only by the deg.find_markers.v1
      // handler) so one artifact can't commit without the other. Creates NO result object/edge.
      completeDegFindMarkersResult: (input) => db.completeDegFindMarkersResultByWorker(jobId, workerId, claimToken, input, withNow({}, resolveNowTs())),
      // R-bridge seam (used by every R-facing handler: r.runtime.check,
      // r.object.inspect, pbmc.pipeline.v1, checkpoint.load.v1, deg.find_markers.v1).
      // The bridge is a pure function; the resolved R caller is injected so it cannot
      // reach R by any path other than this server-controlled one.
      runRBridgeOperation: (bridgeArgs) => rBridge.runRBridgeOperation(bridgeArgs),
      callR: resolvedCallR,
      // Owner-verified gate + server-derived state-key deriver for r.object.inspect.
      // verifyAnalysisObjectOwner is the SAME owner check the /api/r/* proxy uses, so
      // project membership alone never reaches another user's live R object. The
      // deriver is injected (server's canonical deriveRStateKey); the client never
      // controls the X-Object-ID.
      verifyAnalysisObjectOwner: (ownerUserId, objectId) => db.verifyAnalysisObjectOwner(ownerUserId, objectId),
      deriveRObjectStateKey: typeof deriveRObjectStateKey === 'function' ? deriveRObjectStateKey : undefined,
      // Server-selected loadable-checkpoint resolver for checkpoint.load.v1 ONLY. It
      // re-verifies object ownership + project scope + checkpoint storage metadata and
      // returns the SERVER-controlled internal storage key (never client input). The
      // worker keeps that key private (it is not logged or placed in artifact metadata).
      getLoadableCheckpoint: (projectId, objectId, ownerUserId) =>
        db.getLoadableCheckpointForAnalysisObject(projectId, objectId, ownerUserId),
      logger: log,
    };

    let outcome;
    try {
      outcome = await handler(ctx);
    } catch (handlerErr) {
      return failHandlerError(jobId, jobType, claimToken, handlerErr, resolveNowTs(), reaped);
    }

    // 3. Success → complete through the contract (guarded UPDATE; will not resurrect
    //    a job canceled mid-run — that surfaces as CLAIM_LOST).
    const completeNow = resolveNowTs();
    const completeOpts = withNow({ log: { level: 'info', message: 'Handler completed.' } }, completeNow);
    if (outcome && typeof outcome === 'object' && outcome.resultAnalysisObjectId) {
      completeOpts.resultAnalysisObjectId = outcome.resultAnalysisObjectId;
    }
    try {
      db.completeJobByWorker(jobId, workerId, claimToken, completeOpts);
    } catch (err) {
      return asClaimLoss(err, 'complete', jobId, jobType, reaped);
    }
    log.info(`[worker ${workerId}] completed ${jobId} (${jobType})`);
    return { status: 'completed', jobId, jobType, result: outcome && outcome.result, reaped };
  }

  function failUnsupported(jobId, jobType, claimToken, nowTs, reaped) {
    log.warn(`[worker ${workerId}] unsupported job type '${jobType}' for ${jobId}; failing.`);
    const opts = withNow({ log: { level: 'error', message: `Unsupported job type '${jobType}'.` } }, nowTs);
    try {
      db.failJobByWorker(
        jobId, workerId, claimToken,
        { code: UNSUPPORTED_JOB_TYPE, message: `No handler registered for job type '${jobType}'.` },
        opts
      );
    } catch (err) {
      return asClaimLoss(err, 'fail-unsupported', jobId, jobType, reaped);
    }
    return { status: 'unsupported', jobId, jobType, reaped };
  }

  function failHandlerError(jobId, jobType, claimToken, handlerErr, nowTs, reaped) {
    // If the handler failed BECAUSE the claim was lost (e.g. a cooperative
    // ctx.heartbeat() detected cancellation), do not try to fail the job — it is no
    // longer ours.
    if (handlerErr && (handlerErr.code === 'CLAIM_LOST' || handlerErr.code === 'JOB_NOT_FOUND')) {
      log.warn(`[worker ${workerId}] claim lost during handler for ${jobId}; not resurrecting.`);
      return { status: 'claim_lost', jobId, jobType, phase: 'handler', reaped };
    }
    // Record a sanitized message only — never a stack/path. Handlers are responsible
    // for not embedding secrets in their error messages.
    const message = handlerErr && handlerErr.message ? String(handlerErr.message) : 'Handler error.';
    log.error(`[worker ${workerId}] handler error for ${jobId}: ${message}`);
    const opts = withNow({ log: { level: 'error', message: 'Handler failed.' } }, nowTs);
    try {
      db.failJobByWorker(jobId, workerId, claimToken, { code: 'HANDLER_ERROR', message }, opts);
    } catch (err) {
      return asClaimLoss(err, 'fail-handler', jobId, jobType, reaped);
    }
    return { status: 'failed', jobId, jobType, error: { code: 'HANDLER_ERROR', message }, reaped };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  // start() runs a self-rescheduling setTimeout loop (NOT setInterval) so a slow
  // tick never overlaps itself and stop() can deterministically clear the single
  // pending timer — no leaked timers.
  async function tick() {
    timer = null;
    if (!running) return;
    tickInFlight = runOnce()
      .catch((err) => log.error(`[worker ${workerId}] tick error: ${err && err.message ? err.message : err}`))
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
  checkpointLoadHandler,
  degFindMarkersHandler,
  DEFAULT_HANDLERS,
  UNSUPPORTED_JOB_TYPE,
  JOB_WORKER_DEFAULTS,
  parseJobWorkerConfig,
  parsePositiveIntOrNull,
};
