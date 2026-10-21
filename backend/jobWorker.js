// Claims queued jobs, renews leases, and publishes handler results through guarded database transitions.
// Cancellation ends the claim; in-flight R work is reconciled through completion receipts.

const crypto = require('crypto');
const database = require('./pgDatabase');
const rWorkerBridge = require('./rWorkerBridge');
const storage = require('./storage');
const { observedRuntimeMetadata } = require('./executionHistoryProjection');
const {
  genericNoopHandler,
  rRuntimeCheckHandler,
  rObjectInspectHandler,
} = require('./jobs/inspectionHandlers');
const {
  checkpointNoopHandler,
  checkpointSaveHandler,
  checkpointLoadHandler,
  checkpointForkHandler,
} = require('./jobs/checkpointHandlers');
const {
  pbmcPipelineHandler,
  seuratPipelineHandler,
  spatialSeuratPipelineHandler,
} = require('./jobs/pipelineHandlers');
const {
  degFindMarkersHandler,
  enrichmentGseaHandler,
  cellChatInferenceHandler,
  exploratoryAnalysisHandler,
  conditionComparisonHandler,
} = require('./jobs/analysisHandlers');
const { expertRHandler } = require('./jobs/expertRHandler');
const {
  safeDiagnosticCode,
  codedHandlerError,
  R_COMPLETION_PUBLICATION_INDETERMINATE,
  isIndeterminateRExecutionFailure,
  SAFE_HANDLER_DOMAIN_MESSAGES,
} = require('./jobs/jobErrors');
const {
  COMPLETION_RECEIPT_JOB_TYPES,
  bestEffortRemoveRecoveryObjects,
  bestEffortRemoveCompletionReceipt,
  completionReceiptExpectation,
} = require('./jobs/completionRecovery');

function generateWorkerId() {
  return `worker_${crypto.randomBytes(8).toString('hex')}`;
}

const UNSUPPORTED_JOB_TYPE = 'UNSUPPORTED_JOB_TYPE';

const R_TIMEOUT_INDETERMINATE = 'R_TIMEOUT_INDETERMINATE';

const R_TIMEOUT_RECOVERY_PENDING = 'R_TIMEOUT_RECOVERY_PENDING';

const R_RETRY_RECOVERY_PENDING = 'R_RETRY_RECOVERY_PENDING';

const COMMITTED_OUTPUT_RECOVERY_PENDING = 'COMMITTED_OUTPUT_RECOVERY_PENDING';

const R_TIMEOUT_RECOVERY_GRACE_SECONDS = 300;

const JOB_WORKER_DEFAULTS = Object.freeze({ pollIntervalMs: 1000, leaseSeconds: 120 });

const JOB_WORKER_MIN_LEASE_SECONDS = 10;

function parsePositiveIntOrNull(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Invalid poll/lease settings fall back to defaults. Only ENABLE_JOB_WORKER=true enables startup.
function parseJobWorkerConfig(env = {}, opts = {}) {
  const defaults = opts.defaults || JOB_WORKER_DEFAULTS;
  const logger = opts.logger || console;
  const warn = (m) => {
    if (logger && typeof logger.warn === 'function') logger.warn(m);
  };

  const enabled = env.ENABLE_JOB_WORKER === 'true';

  const pollRaw = env.JOB_WORKER_POLL_MS;
  let pollIntervalMs = parsePositiveIntOrNull(pollRaw);
  if (pollIntervalMs === null) {
    if (pollRaw !== undefined) {
      warn(
        `[worker] JOB_WORKER_POLL_MS is not a positive integer; using default ${defaults.pollIntervalMs}ms.`
      );
    }
    pollIntervalMs = defaults.pollIntervalMs;
  }

  const leaseRaw = env.JOB_WORKER_LEASE_SECONDS;
  let leaseSeconds = parsePositiveIntOrNull(leaseRaw);
  if (leaseSeconds === null || leaseSeconds < JOB_WORKER_MIN_LEASE_SECONDS) {
    if (leaseRaw !== undefined) {
      warn(
        `[worker] JOB_WORKER_LEASE_SECONDS must be an integer of at least ${JOB_WORKER_MIN_LEASE_SECONDS}; using default ${defaults.leaseSeconds}s.`
      );
    }
    leaseSeconds = defaults.leaseSeconds;
  }

  return { enabled, pollIntervalMs, leaseSeconds };
}

// Unregistered job types are claimed and failed once with UNSUPPORTED_JOB_TYPE.
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

// Dependencies and the clock are injectable for tests. Constructing a worker does
// not start polling; callers use runOnce() or start(), then await stop() on shutdown.
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
  const resolvedCallR =
    typeof callR === 'function' ? callR : rBridge.createDefaultRCaller(rBridgeConfig);

  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('pollIntervalMs must be a non-negative integer.');
  }

  let running = false;
  let timer = null;
  let tickInFlight = null;

  const log = {
    info: (m) => {
      if (logger && typeof logger.info === 'function') logger.info(m);
    },
    warn: (m) => {
      if (logger && typeof logger.warn === 'function') logger.warn(m);
    },
    error: (m) => {
      if (logger && typeof logger.error === 'function') logger.error(m);
    },
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
      log.warn(
        `[worker ${workerId}] could not append log to ${jobId}: ${err && err.code ? err.code : 'error'}`
      );
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
        )
          .catch(handleRenewalError)
          .finally(() => {
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
      job = await db.claimNextJob(
        workerId,
        withNow(
          {
            leaseSeconds,
            allowedJobTypes,
            maxConcurrentClaims,
          },
          nowTs
        )
      );
    } catch (err) {
      log.error(`[worker ${workerId}] claim failed: ${safeDiagnosticCode(err)}`);
      return { status: 'error', phase: 'claim', reaped };
    }
    if (!job) return { status: 'idle', reaped };

    const { id: jobId, jobType, claimToken } = job;
    await safeWorkerLog(
      jobId,
      claimToken,
      { level: 'info', message: `Claimed by worker (type=${jobType}).` },
      nowTs
    );
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
        const environment =
          runtimeKind === 'sandbox-r' && job.parameters?.environment
            ? { precision: 'pinned-request', reference: job.parameters.environment }
            : { precision: 'unavailable', reference: null };
        const receipt = await db.recordJobExecutionReceiptByWorker(
          jobId,
          workerId,
          claimToken,
          {
            operation,
            runtimeKind,
            runtimeGeneration:
              runtimeKind === 'guided-r' ? claimAdmission?.rRuntimeInstanceHash || null : null,
            environment,
          },
          withNow({}, resolveNowTs())
        );
        if (!receipt)
          throw codedHandlerError(
            'EXECUTION_RECEIPT_UNAVAILABLE',
            'The analysis execution target could not be recorded safely.'
          );
        return receipt;
      }
      async function runClaimedRBridge(bridgeArgs) {
        const recordedCallR = async (request) => {
          await recordExecutionDispatch(bridgeArgs.operation, 'guided-r');
          return resolvedCallR(request);
        };
        Object.assign(recordedCallR, resolvedCallR);
        const descriptor = await rBridge.runRBridgeOperation({
          ...bridgeArgs,
          callR: recordedCallR,
          markRDispatchStarted:
            typeof db.markRDispatchStartedByWorker === 'function'
              ? () =>
                  db.markRDispatchStartedByWorker(
                    jobId,
                    workerId,
                    claimToken,
                    withNow({}, resolveNowTs())
                  )
              : undefined,
        });
        if (
          COMPLETION_RECEIPT_JOB_TYPES.has(jobType) &&
          bridgeArgs.operation !== 'r.checkpoint.hydrate.v1'
        )
          receiptBackedRCompleted = true;
        observedREnvironment = observedRuntimeMetadata([
          descriptor,
          { environmentObserved: observedREnvironment },
        ]);
        if (descriptor.metadata && observedREnvironment) {
          return {
            ...descriptor,
            metadata: { ...descriptor.metadata, environmentObserved: observedREnvironment },
          };
        }
        return descriptor;
      }
      const runClaimedSandbox =
        typeof runExpertSandbox === 'function'
          ? async (input) => {
              const receipt = await recordExecutionDispatch(jobType, 'sandbox-r');
              return runExpertSandbox(
                /^[a-f0-9]{64}$/.test(receipt?.dispatchId || '')
                  ? {
                      ...input,
                      monitoring: {
                        jobId,
                        projectId: job.projectId,
                        ownerUserId: job.ownerUserId,
                        dispatchId: receipt.dispatchId,
                      },
                    }
                  : input
              );
            }
          : undefined;
      const makeClaimContext = (overrides = {}) => ({
        job,
        workerId,
        runtimeCapabilities: claimAdmission?.capabilities || {},
        heartbeat: () =>
          db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, resolveNowTs())),
        log: (entry) => safeWorkerLog(jobId, claimToken, entry, resolveNowTs()),
        createArtifact: (input) =>
          db.createJobArtifactByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        createCheckpointArtifact: (input) =>
          db.createCheckpointArtifactForJobByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        createCheckpoint: (input) =>
          db.createCheckpointForJobByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        completePbmcPipelineResult: (input) =>
          db.completePbmcPipelineResultByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        completeSeuratPipelineResult: (input) =>
          db.completeSeuratPipelineResultByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        completeDegFindMarkersResult: (input) =>
          db.completeDegFindMarkersResultByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        completeEnrichmentGseaResult: (input) =>
          db.completeEnrichmentGseaResultByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        completeCellChatInferenceResult: (input) =>
          db.completeCellChatInferenceResultByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        completeConditionComparisonResult: (input) =>
          db.completeConditionComparisonResultByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        completeExpertRResult: (input) =>
          db.completeExpertRResultByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        completeCheckpointFork: (input) =>
          db.completeCheckpointForkByWorker(
            jobId,
            workerId,
            claimToken,
            input,
            withNow({}, resolveNowTs())
          ),
        removeDurableObject: (key) => storageProvider.remove(key),
        runRBridgeOperation: runClaimedRBridge,
        callR: resolvedCallR,
        getOwnedAnalysisObject: () =>
          db.getOwnedAnalysisObjectForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        getSeuratPipelineInputs: () =>
          db.getSeuratPipelineInputsForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        getMultiSampleSeuratPipelineInputs: () =>
          db.getMultiSampleSeuratPipelineInputsForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        getSpatialPipelineInputs: () =>
          db.getSpatialPipelineInputsForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        getConditionComparisonInputs: () =>
          db.getConditionComparisonInputsForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        deriveRObjectStateKey:
          typeof deriveRObjectStateKey === 'function' ? deriveRObjectStateKey : undefined,
        getLoadableCheckpoint: () =>
          db.getLoadableCheckpointForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        getHydrationCheckpoint: () =>
          db.getHydrationCheckpointForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        getExpertRPrivateInputs: () =>
          db.getExpertRPrivateInputsForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        getForkableCheckpoint: () =>
          db.getForkableCheckpointForJobByWorker(
            jobId,
            workerId,
            claimToken,
            withNow({}, resolveNowTs())
          ),
        allocateAnalysisObjectId: () => db.generateAnalysisObjectId(),
        logger: log,
        runExpertSandbox: runClaimedSandbox,
        runWorkflow: (workflowCtx) =>
          require('./workflowWorker').runWorkflowJob(
            db,
            workflowCtx,
            workerId,
            claimToken,
            storageProvider
          ),
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
          try {
            authoritativeJob = await db.getWorkerJob(jobId);
          } catch {
            /* preserve */
          }
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
            withNow(
              {
                rRuntimeInstanceHash: claimAdmission && claimAdmission.rRuntimeInstanceHash,
                inspectStorageObject: (key, expected) => storageProvider.inspect(key, expected),
              },
              resolveNowTs()
            )
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
      if (
        COMPLETION_RECEIPT_JOB_TYPES.has(jobType) &&
        typeof storageProvider.readCompletionReceipt === 'function'
      ) {
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
            if (
              typeof resolvedCallR.verifyCompletionReceipt !== 'function' ||
              typeof rBridge.descriptorFromCompletionReceipt !== 'function' ||
              typeof rBridge.buildCompletionReceiptBinding !== 'function'
            ) {
              throw codedHandlerError(
                'R_COMPLETION_RECEIPT_INVALID',
                'Completion receipt is invalid.'
              );
            }
            const receipt = resolvedCallR.verifyCompletionReceipt(envelope);
            const expected = await completionReceiptExpectation(ctx);
            const descriptor = rBridge.descriptorFromCompletionReceipt(job, receipt, expected);

            if (expected.outputStorageKey) {
              if (typeof storageProvider.inspect !== 'function') {
                throw codedHandlerError(
                  'R_COMPLETION_RECEIPT_INVALID',
                  'Completion receipt is invalid.'
                );
              }
              const integrity = descriptor.checkpoint || descriptor.result;
              await storageProvider.inspect(expected.outputStorageKey, {
                checksumSha256: integrity && integrity.checksumSha256,
                sizeBytes: integrity && integrity.sizeBytes,
              });
            } else {
              const admittedRuntimeHash = claimAdmission && claimAdmission.rRuntimeInstanceHash;
              if (
                !admittedRuntimeHash ||
                !descriptor.loaded ||
                descriptor.loaded.runtimeInstanceHash !== admittedRuntimeHash
              ) {
                const runtimeError = codedHandlerError(
                  'LIVE_R_STATE_LOST',
                  'The private R runtime changed before completion could be recovered.'
                );
                throw runtimeError;
              }
            }

            const bindingMatches = (bridgeArgs) => {
              const actual = rBridge.buildCompletionReceiptBinding(
                bridgeArgs.job,
                bridgeArgs.operation,
                bridgeArgs
              );
              return (
                actual && Object.entries(actual).every(([key, value]) => receipt[key] === value)
              );
            };
            adoptedCompletionReceipt = { descriptor, receipt };
            ctx = makeClaimContext({
              recoveringCompletionReceipt: true,
              runRBridgeOperation: async (bridgeArgs) => {
                if (!bindingMatches(bridgeArgs)) {
                  throw codedHandlerError(
                    'R_COMPLETION_RECEIPT_INVALID',
                    'Completion receipt is invalid.'
                  );
                }
                return descriptor;
              },
            });
          } catch (error) {
            receiptFailure = error;
          }
        }

        if (receiptFailure) {
          const receiptErrorCode =
            receiptFailure.code === 'LIVE_R_STATE_LOST'
              ? 'LIVE_R_STATE_LOST'
              : 'R_COMPLETION_RECEIPT_INVALID';
          const error = {
            code: receiptErrorCode,
            message:
              receiptErrorCode === 'LIVE_R_STATE_LOST'
                ? 'The private R runtime changed before completion could be recovered.'
                : 'Completion receipt validation failed.',
          };
          try {
            await db.failJobByWorker(
              jobId,
              workerId,
              claimToken,
              error,
              withNow(
                {
                  log: {
                    level: 'error',
                    message:
                      receiptErrorCode === 'LIVE_R_STATE_LOST'
                        ? 'Completion receipt referred to private live state from a prior R runtime.'
                        : 'Completion receipt failed strict integrity or job binding validation; refusing to rerun R.',
                  },
                },
                resolveNowTs()
              )
            );
          } catch (claimError) {
            return asClaimLoss(
              claimError,
              'fail-invalid-completion-receipt',
              jobId,
              jobType,
              reaped
            );
          }
          return { status: 'failed', jobId, jobType, error, receiptInvalid: true, reaped };
        }
      }

      // Reaping or revoked-membership admission marks a single claim as
      // recovery-only. If exact committed output was not finalized above, stop
      // safely without invoking the handler or contacting R a second time.
      const recoveryOnlyMarker =
        job.lastWorkerError &&
        [
          R_TIMEOUT_RECOVERY_PENDING,
          R_RETRY_RECOVERY_PENDING,
          COMMITTED_OUTPUT_RECOVERY_PENDING,
        ].includes(job.lastWorkerError.code);
      if (!adoptedCompletionReceipt && recoveryOnlyMarker) {
        const hasSingletonRExecutionBarrier =
          claimAdmission &&
          claimAdmission.ready === true &&
          claimAdmission.recoveryBarrierSafe === true &&
          typeof claimAdmission.rRuntimeInstanceHash === 'string' &&
          claimAdmission.rRuntimeInstanceHash !== '';
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
              withNow(
                {
                  log: {
                    level: 'error',
                    message:
                      'The singleton R execution barrier completed without an exact output receipt; the job was stopped safely.',
                  },
                },
                resolveNowTs()
              )
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

      if (!adoptedCompletionReceipt)
        ctx = {
          job,
          workerId,
          // Preserve the claim gate's explicit worker capability report when the
          // normal execution context is rebuilt after recovery checks.
          runtimeCapabilities: claimAdmission?.capabilities || {},
          heartbeat: () =>
            db.heartbeatJob(jobId, workerId, claimToken, withNow({ leaseSeconds }, resolveNowTs())),
          log: (entry) => safeWorkerLog(jobId, claimToken, entry, resolveNowTs()),
          // Durable, claim-guarded metadata writers for handlers that record output.
          // Both are authorized by the live claim (worker_id + claim_token), so a handler
          // can only write to the job it currently holds. They create NO files and expose
          // NO paths — metadata only in this branch.
          createArtifact: (input) =>
            db.createJobArtifactByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          // Durable internal checkpoint artifact (server-set storageKind/key/checksum/size).
          // Distinct from createArtifact, whose generic input deliberately ignores storage
          // fields; used by reviewed handlers that publish local_internal storage.
          createCheckpointArtifact: (input) =>
            db.createCheckpointArtifactForJobByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          createCheckpoint: (input) =>
            db.createCheckpointForJobByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          // Atomic checkpoint-producing completion: result object + job link + lineage
          // edge + checkpoint artifact + summary artifact in ONE claim-guarded transaction,
          // so an artifact failure can't leave a partial result.
          completePbmcPipelineResult: (input) =>
            db.completePbmcPipelineResultByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          completeSeuratPipelineResult: (input) =>
            db.completeSeuratPipelineResultByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          // Atomic DEG completion: the local_internal marker-table artifact + the metadata-only
          // summary artifact in ONE claim-guarded transaction (used only by the deg.find_markers.v1
          // handler) so one artifact can't commit without the other. Creates NO result object/edge.
          completeDegFindMarkersResult: (input) =>
            db.completeDegFindMarkersResultByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          completeEnrichmentGseaResult: (input) =>
            db.completeEnrichmentGseaResultByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          completeCellChatInferenceResult: (input) =>
            db.completeCellChatInferenceResultByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          completeConditionComparisonResult: (input) =>
            db.completeConditionComparisonResultByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          completeExpertRResult: (input) =>
            db.completeExpertRResultByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
          completeCheckpointFork: (input) =>
            db.completeCheckpointForkByWorker(
              jobId,
              workerId,
              claimToken,
              input,
              withNow({}, resolveNowTs())
            ),
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
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          getSeuratPipelineInputs: () =>
            db.getSeuratPipelineInputsForJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          getMultiSampleSeuratPipelineInputs: () =>
            db.getMultiSampleSeuratPipelineInputsForJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          getSpatialPipelineInputs: () =>
            db.getSpatialPipelineInputsForJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          getConditionComparisonInputs: () =>
            db.getConditionComparisonInputsForJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          deriveRObjectStateKey:
            typeof deriveRObjectStateKey === 'function' ? deriveRObjectStateKey : undefined,
          // Server-selected checkpoint resolvers keep internal storage keys private
          // while binding selection to this job's valid claim and trusted source id.
          getLoadableCheckpoint: () =>
            db.getLoadableCheckpointForJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          getHydrationCheckpoint: () =>
            db.getHydrationCheckpointForJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          getExpertRPrivateInputs: () =>
            db.getExpertRPrivateInputsForJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          getForkableCheckpoint: () =>
            db.getForkableCheckpointForJobByWorker(
              jobId,
              workerId,
              claimToken,
              withNow({}, resolveNowTs())
            ),
          allocateAnalysisObjectId: () => db.generateAnalysisObjectId(),
          logger: log,
          runExpertSandbox: runClaimedSandbox,
          runWorkflow: (workflowCtx) =>
            require('./workflowWorker').runWorkflowJob(
              db,
              workflowCtx,
              workerId,
              claimToken,
              storageProvider
            ),
        };

      let outcome;
      try {
        outcome = await handler(ctx);
      } catch (handlerErr) {
        let effectiveHandlerErr = handlerErr;
        if (
          effectiveHandlerErr &&
          effectiveHandlerErr.code === R_COMPLETION_PUBLICATION_INDETERMINATE &&
          adoptedCompletionReceipt
        ) {
          let publicationRecovery = null;
          if (typeof db.resumeCommittedJobByWorker === 'function') {
            try {
              publicationRecovery = await db.resumeCommittedJobByWorker(
                jobId,
                workerId,
                claimToken,
                withNow(
                  {
                    rRuntimeInstanceHash: claimAdmission && claimAdmission.rRuntimeInstanceHash,
                    inspectStorageObject: (key, expected) => storageProvider.inspect(key, expected),
                  },
                  resolveNowTs()
                )
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
        const claimLostAfterReceiptBackedSuccess =
          effectiveHandlerErr &&
          (effectiveHandlerErr.code === 'CLAIM_LOST' ||
            effectiveHandlerErr.code === 'JOB_NOT_FOUND') &&
          (adoptedCompletionReceipt || receiptBackedRCompleted);
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
          jobId,
          jobType,
          claimToken,
          effectiveHandlerErr,
          resolveNowTs(),
          reaped
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
      const completeOpts = withNow(
        { log: { level: 'info', message: 'Handler completed.' } },
        completeNow
      );
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
    const opts = withNow(
      { log: { level: 'error', message: `Unsupported job type '${jobType}'.` } },
      nowTs
    );
    try {
      await db.failJobByWorker(
        jobId,
        workerId,
        claimToken,
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
      log.warn(
        `[worker ${workerId}] R execution outcome is indeterminate for ${jobId}; retaining the claim for bounded recovery.`
      );
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
    const stableDomainCode =
      handlerErr?.code === 'R_CELLCHAT_INFERENCE_FAILED' &&
      typeof handlerErr?.rCode === 'string' &&
      SAFE_HANDLER_DOMAIN_MESSAGES[handlerErr.rCode]
        ? handlerErr.rCode
        : handlerErr?.code;
    const domainMessage =
      typeof stableDomainCode === 'string' ? SAFE_HANDLER_DOMAIN_MESSAGES[stableDomainCode] : null;
    const message =
      domainMessage ||
      (handlerErr && handlerErr.publicSafeHandlerError === true
        ? String(handlerErr.message || 'Handler failed.').slice(0, 240)
        : 'Handler failed.');
    const diagnosticCode = safeDiagnosticCode(handlerErr);
    log.error(`[worker ${workerId}] handler error for ${jobId}: ${diagnosticCode}`);
    const opts = withNow({ log: { level: 'error', message: 'Handler failed.' } }, nowTs);
    try {
      await db.failJobByWorker(
        jobId,
        workerId,
        claimToken,
        { code: domainMessage ? stableDomainCode : 'HANDLER_ERROR', message },
        opts
      );
    } catch (err) {
      return asClaimLoss(err, 'fail-handler', jobId, jobType, reaped);
    }
    return {
      status: 'failed',
      jobId,
      jobType,
      error: { code: domainMessage ? stableDomainCode : 'HANDLER_ERROR', message },
      reaped,
    };
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
      .finally(() => {
        tickInFlight = null;
      });
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
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Let any in-flight tick settle so we never leave a half-finished claim behind.
    if (tickInFlight) {
      try {
        await tickInFlight;
      } catch {
        /* already logged */
      }
    }
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
