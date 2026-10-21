// Checkpoint-backed analyses that publish result tables or metadata summaries.

const { validateDegFindMarkersParams, allocateDegResultStorageKey } = require('../degFindMarkers');
const {
  validateEnrichmentGseaParams,
  allocateEnrichmentGseaResultStorageKey,
} = require('../enrichmentGsea');
const {
  validateCellChatInferenceParams,
  allocateCellChatInferenceResultStorageKey,
  MAX_CELLCHAT_RESULT_ROWS,
} = require('../cellChatInference');
const { validateExploratoryAnalysisParams } = require('../exploratoryAnalysis');
const {
  validateConditionComparisonParams,
  allocateConditionComparisonResultStorageKey,
} = require('../conditionComparison');
const {
  codedHandlerError,
  publicationIndeterminateError,
  SAFE_HANDLER_DOMAIN_MESSAGES,
} = require('./jobErrors');
const { removeRetryOrphanOutput, discardUnrecordedProjectOutput } = require('./completionRecovery');

async function hydrateIsolatedAnalysisObject(ctx, objectId) {
  const stateKey = ctx.deriveRObjectStateKey(ctx.job.ownerUserId, `${objectId}-job-${ctx.job.id}`);
  // A verified completion receipt proves the downstream scientific operation
  // already finished against this exact job/object binding. Recovery publishes
  // that immutable output through the handler's normal atomic DB path and must
  // never contact R or rebuild transient state a second time.
  if (ctx.recoveringCompletionReceipt === true) return stateKey;
  if (typeof ctx.getHydrationCheckpoint !== 'function') {
    throw codedHandlerError(
      'NO_CHECKPOINT_ARTIFACT',
      'This analysis requires a durable checkpoint.'
    );
  }
  const checkpoint = await ctx.getHydrationCheckpoint();
  if (
    !checkpoint ||
    checkpoint.analysisObjectId !== objectId ||
    typeof checkpoint.checkpointArtifactId !== 'string'
  ) {
    throw codedHandlerError(
      'NO_CHECKPOINT_ARTIFACT',
      'This analysis requires a durable checkpoint.'
    );
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
    throw codedHandlerError(
      'R_CHECKPOINT_LOAD_FAILED',
      'Private compute could not hydrate the checkpoint.'
    );
  }
  return stateKey;
}

async function degFindMarkersHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message: 'deg.find_markers.v1 handler: validating ownership + parameters before any R contact.',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an input analysis object. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'DEG job is missing its input analysis object.'
    );
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may run DEG.
  //    The worker-only resolver binds ownership and exact scope to this valid claim;
  //    a 404-style message avoids another user's object existence disclosure.
  if (
    typeof ctx.getOwnedAnalysisObject !== 'function' ||
    typeof ctx.deriveRObjectStateKey !== 'function'
  ) {
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

  await ctx.log({
    level: 'info',
    message:
      'deg.find_markers.v1 handler: parameters valid; running allowlisted DEG over private checkpoint-backed job state (no new object/edge).',
  });

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
  if (
    result.saved !== true ||
    typeof result.checksumSha256 !== 'string' ||
    result.checksumSha256 === ''
  ) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey);
    throw codedHandlerError(
      'DEG_RESULT_WRITE_FAILED',
      'DEG run did not produce a durable marker table.'
    );
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
        description:
          'Durable internal full DEG marker table. Controlled authenticated export only.',
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

  await ctx.log({
    level: 'info',
    message: `deg.find_markers.v1 handler: recorded marker table ${markersArtifact.id} + summary ${summaryArtifact.id} (object ${objectId} not mutated; no new object/edge).`,
  });

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

async function enrichmentGseaHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message:
      'enrichment.gsea.v1 handler: validating ownership and parameters before any R contact.',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Pathway-enrichment job is missing its input analysis object.'
    );
  }
  if (
    typeof ctx.getOwnedAnalysisObject !== 'function' ||
    typeof ctx.deriveRObjectStateKey !== 'function'
  ) {
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
    message:
      'enrichment.gsea.v1 handler: running the allowlisted cluster-versus-rest ranked GO analysis.',
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
  if (
    result.saved !== true ||
    typeof result.checksumSha256 !== 'string' ||
    result.checksumSha256 === '' ||
    !Number.isInteger(result.sizeBytes) ||
    result.sizeBytes < 0 ||
    result.sizeBytes > 50 * 1024 * 1024 ||
    !Number.isInteger(result.nRows) ||
    result.nRows < 0 ||
    result.nRows > 100000
  ) {
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

async function cellChatInferenceHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message:
      'cellchat.infer.v1 handler: validating ownership and fixed single-context parameters before any R contact.',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Cell-communication job is missing its input analysis object.'
    );
  }
  if (
    typeof ctx.getOwnedAnalysisObject !== 'function' ||
    typeof ctx.deriveRObjectStateKey !== 'function' ||
    typeof ctx.completeCellChatInferenceResult !== 'function'
  ) {
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
    message:
      'cellchat.infer.v1 handler: running the allowlisted CellChat candidate-inference workflow.',
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
  if (
    descriptor.artifactType !== 'cellchat_summary' ||
    result.saved !== true ||
    typeof result.checksumSha256 !== 'string' ||
    result.checksumSha256 === '' ||
    !Number.isInteger(result.sizeBytes) ||
    result.sizeBytes < 0 ||
    result.sizeBytes > 50 * 1024 * 1024 ||
    !Number.isInteger(result.nRows) ||
    result.nRows < 0 ||
    result.nRows > MAX_CELLCHAT_RESULT_ROWS
  ) {
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
        description:
          'Private full CellChat ligand-receptor signaling candidate table for one selected biological context.',
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
    message:
      'explore.summarize.v1 handler: validating a reviewed aggregate recipe and hydrating a private checkpoint.',
  });
  const job = ctx.job;
  const objectId = job.analysisObjectId;
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Exploratory analysis is missing its input object.'
    );
  }
  if (
    typeof ctx.getOwnedAnalysisObject !== 'function' ||
    typeof ctx.deriveRObjectStateKey !== 'function'
  ) {
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
  if (
    !design ||
    design.analysisObjectId !== job.analysisObjectId ||
    design.contrast.id !== params.contrastId
  ) {
    throw codedHandlerError('INVALID_CONTRAST', 'Condition contrast is invalid.');
  }
  if (
    design.contrast.blockingFactor ||
    (Array.isArray(design.contrast.covariates) && design.contrast.covariates.length > 0)
  ) {
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
    message:
      'condition.pseudobulk_de.v1 handler: running replicate-aware edgeR pseudobulk over a private checkpoint.',
  });
  let descriptor;
  try {
    descriptor = await ctx.runRBridgeOperation({
      job,
      operation: 'r.condition.pseudobulk_de.v1',
      actor: { userId: job.ownerUserId, projectId: job.projectId },
      objectContext: { objectId: job.analysisObjectId, stateKey },
      conditionComparison: { design, resultStorageKey },
      claimContext: { workerId: ctx.workerId },
      logger: ctx.logger,
      callR: ctx.callR,
    });
  } catch (error) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey, error);
    throw error;
  }
  const result = descriptor.result || {};
  if (
    result.saved !== true ||
    !result.checksumSha256 ||
    !Number.isInteger(result.nRows) ||
    result.nRows < 0 ||
    result.nRows > 500000
  ) {
    await discardUnrecordedProjectOutput(ctx, resultStorageKey);
    throw codedHandlerError(
      'CONDITION_COMPARISON_WRITE_FAILED',
      'Condition comparison did not produce a durable result.'
    );
  }
  let completion;
  try {
    completion = await ctx.completeConditionComparisonResult({
      resultsArtifact: {
        artifactType: 'condition_de_results',
        name: 'Pseudobulk condition DE table',
        description: 'Private replicate-aware edgeR pseudobulk differential-expression table.',
        storageKind: 'local_internal',
        mimeType: 'text/csv',
        internalStorageKey: resultStorageKey,
        checksumSha256: result.checksumSha256,
        sizeBytes: result.sizeBytes,
        metadata: {
          operation: 'r.condition.pseudobulk_de.v1',
          contrastId: params.contrastId,
          nRows: result.nRows,
        },
      },
      summaryArtifact: {
        artifactType: 'condition_de_summary',
        name: descriptor.name,
        description: descriptor.description,
        storageKind: 'metadata_only',
        metadata: { ...descriptor.metadata, contrastId: params.contrastId, downloadable: false },
      },
    });
  } catch (error) {
    throw publicationIndeterminateError(error);
  }
  return {
    result: {
      ok: true,
      handled: 'condition.pseudobulk_de.v1',
      resultsArtifactId: completion.resultsArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

module.exports = {
  degFindMarkersHandler,
  enrichmentGseaHandler,
  cellChatInferenceHandler,
  exploratoryAnalysisHandler,
  conditionComparisonHandler,
};
