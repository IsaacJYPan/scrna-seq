// Save, load, and fork checkpoints through the worker claim and ownership context.

const { allocateCheckpointStorageKey } = require('../pbmcPipeline');
const { derivedAnalysisDisplayName } = require('../analysisDisplayName');
const { codedHandlerError, publicationIndeterminateError } = require('./jobErrors');
const {
  removeRetryOrphanOutput,
  discardUnrecordedProjectOutput,
  deriveCheckpointForkResultObjectId,
} = require('./completionRecovery');

async function checkpointNoopHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message:
      'checkpoint.noop handler: creating placeholder, metadata-only checkpoint (no R/Seurat execution).',
  });

  const checkpoint = await ctx.createCheckpoint({
    objectType: 'generic',
    displayName: 'Placeholder checkpoint (no pipeline execution)',
    metadata: {
      placeholder: true,
      checkpoint: true,
      source: 'checkpoint.noop',
      scientific_output: false,
    },
  });

  const artifact = await ctx.createArtifact({
    artifactType: 'checkpoint',
    resultAnalysisObjectId: checkpoint.id,
    name: 'Placeholder checkpoint metadata',
    description:
      'Metadata-only checkpoint record. No raw artifact, no download, no real scientific output in this branch.',
    storageKind: 'metadata_only',
    metadata: { placeholder: true, scientific_output: false },
  });

  await ctx.log({
    level: 'info',
    message: `checkpoint.noop handler: recorded checkpoint ${checkpoint.id} and artifact ${artifact.id} (metadata-only).`,
  });

  // The checkpoint helper already linked result_analysis_object_id on the job; return
  // it so completion is explicit (completeJobByWorker re-validates the same id).
  return {
    resultAnalysisObjectId: checkpoint.id,
    result: {
      ok: true,
      handled: 'checkpoint.noop',
      placeholder: true,
      checkpointId: checkpoint.id,
      artifactId: artifact.id,
    },
  };
}

async function checkpointSaveHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message: 'checkpoint.save.v1 handler: validating live-object ownership before saving.',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;
  if (!job.projectId || typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Save job is missing its analysis object.'
    );
  }
  if (job.parameters && Object.keys(job.parameters).length > 0) {
    throw codedHandlerError(
      'INVALID_PARAMETERS',
      'Save current analysis does not accept parameters.'
    );
  }
  if (
    typeof ctx.getOwnedAnalysisObject !== 'function' ||
    typeof ctx.deriveRObjectStateKey !== 'function' ||
    typeof ctx.completePbmcPipelineResult !== 'function'
  ) {
    throw codedHandlerError(
      'R_BRIDGE_MISCONFIGURED',
      'Saved-analysis persistence is not configured.'
    );
  }
  const ownedObject = await ctx.getOwnedAnalysisObject();
  if (!ownedObject || ownedObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, objectId);
  if (typeof stateKey !== 'string' || stateKey === '') {
    throw codedHandlerError(
      'R_BRIDGE_MISCONFIGURED',
      'Saved-analysis persistence is not configured.'
    );
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
  if (
    checkpoint.saved !== true ||
    typeof checkpoint.checksumSha256 !== 'string' ||
    checkpoint.checksumSha256 === ''
  ) {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey);
    throw codedHandlerError('CHECKPOINT_SAVE_FAILED', 'Current analysis was not saved.');
  }

  let completion;
  try {
    const inheritedSummary =
      ownedObject.metadata?.summary && typeof ownedObject.metadata.summary === 'object'
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
        description:
          'Durable internal checkpoint of an explicitly saved private analysis. Not downloadable.',
        storageKind: 'local_internal',
        internalStorageKey: checkpointStorageKey,
        checksumSha256: checkpoint.checksumSha256,
        sizeBytes: checkpoint.sizeBytes != null ? checkpoint.sizeBytes : 0,
        metadata: {
          operation: 'r.checkpoint.save.v1',
          scientific_output: true,
          downloadable: false,
        },
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

async function checkpointLoadHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message:
      'checkpoint.load.v1 handler: validating ownership + resolving checkpoint before any R contact.',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference the analysis object to load. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Checkpoint load job is missing its analysis object.'
    );
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may load. The
  //    claim-authorized checkpoint resolver verifies owner, exact project scope,
  //    artifact integrity, and this worker's live claim. Also require the server-
  //    injected state-key deriver.
  if (
    typeof ctx.deriveRObjectStateKey !== 'function' ||
    typeof ctx.getLoadableCheckpoint !== 'function'
  ) {
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
  if (
    !checkpoint ||
    checkpoint.analysisObjectId !== objectId ||
    (checkpoint.projectId || null) !== (job.projectId || null)
  ) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }

  await ctx.log({
    level: 'info',
    message:
      "checkpoint.load.v1 handler: checkpoint resolved; loading into the owner's private live R session (no new object/edge).",
  });

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
    throw codedHandlerError(
      'CHECKPOINT_LOAD_FAILED',
      'Checkpoint did not load into the live R session.'
    );
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

  await ctx.log({
    level: 'info',
    message: `checkpoint.load.v1 handler: recorded metadata-only artifact ${artifact.id} (live-state reattach; no new analysis object or lineage edge).`,
  });

  // No result analysis object / checkpoint / lineage edge: this is a live-state reattach.
  return {
    result: {
      ok: true,
      handled: 'checkpoint.load.v1',
      operation: 'r.checkpoint.load.v1',
      artifactId: artifact.id,
    },
  };
}

async function checkpointForkHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message: 'checkpoint.fork.v1 handler: resolving a project checkpoint before R contact.',
  });

  const job = ctx.job;
  const sourceObjectId = job.analysisObjectId;
  if (!job.projectId || !sourceObjectId) {
    throw codedHandlerError(
      'PROJECT_CONTEXT_REQUIRED',
      'Checkpoint fork requires a project and source object.'
    );
  }
  if (
    typeof ctx.getForkableCheckpoint !== 'function' ||
    typeof ctx.deriveRObjectStateKey !== 'function' ||
    typeof ctx.completeCheckpointFork !== 'function'
  ) {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'Checkpoint fork is not configured.');
  }

  const checkpoint = await ctx.getForkableCheckpoint();
  if (
    !checkpoint ||
    checkpoint.analysisObjectId !== sourceObjectId ||
    checkpoint.projectId !== job.projectId
  ) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const resultObjectId = deriveCheckpointForkResultObjectId(job.id);
  const stateKey = ctx.deriveRObjectStateKey(job.ownerUserId, resultObjectId);
  if (!stateKey)
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'Checkpoint fork is not configured.');

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
    throw codedHandlerError(
      'CHECKPOINT_LOAD_FAILED',
      'Checkpoint did not load into the new private live session.'
    );
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

module.exports = {
  checkpointNoopHandler,
  checkpointSaveHandler,
  checkpointLoadHandler,
  checkpointForkHandler,
};
