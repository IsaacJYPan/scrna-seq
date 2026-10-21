// Preprocessing jobs that publish a new Seurat checkpoint and its summary.

const { validatePbmcPipelineParams, allocateCheckpointStorageKey } = require('../pbmcPipeline');
const {
  validateMultiSampleSeuratParams,
  allocateMultiSampleSeuratCheckpointStorageKey,
  assertSupportedMultiSampleDatasets,
} = require('../multiSampleSeuratPipeline');
const {
  validateSeuratPipelineParams,
  allocateSeuratCheckpointStorageKey,
  assertSupportedSeuratPipelineDataset,
} = require('../seuratPipeline');
const {
  validateSpatialSeuratParams,
  allocateSpatialSeuratCheckpointStorageKey,
  assertSupportedSpatialSeuratDataset,
} = require('../spatialPipeline');
const { codedHandlerError, publicationIndeterminateError } = require('./jobErrors');
const { removeRetryOrphanOutput, discardUnrecordedProjectOutput } = require('./completionRecovery');

async function pbmcPipelineHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message: 'pbmc.pipeline.v1 handler: validating ownership + parameters before any R contact.',
  });

  const job = ctx.job;
  const objectId = job.analysisObjectId;

  // 1. The job MUST reference an input analysis object. Fail safely BEFORE any R.
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Pipeline job is missing its input analysis object.'
    );
  }

  // 2. CENTRAL GATE: only the live-R object owner (the job creator) may run the
  //    pipeline. The worker-only resolver also binds the lookup to this job's valid
  //    claim and exact project scope; 404-style message avoids existence disclosure.
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

  await ctx.log({
    level: 'info',
    message:
      'pbmc.pipeline.v1 handler: parameters valid; invoking allowlisted PBMC pipeline on a copy of the input object (parent unchanged).',
  });

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
  if (
    checkpoint.saved !== true ||
    typeof checkpoint.checksumSha256 !== 'string' ||
    checkpoint.checksumSha256 === ''
  ) {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey);
    throw codedHandlerError(
      'CHECKPOINT_SAVE_FAILED',
      'Pipeline did not produce a durable checkpoint.'
    );
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
        description:
          'Durable internal checkpoint of the PBMC pipeline result object. No public download in this branch.',
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

  await ctx.log({
    level: 'info',
    message: `pbmc.pipeline.v1 handler: result object ${resultObject.id} created with checkpoint ${checkpointArtifact.id} + summary ${summaryArtifact.id} (parent ${objectId} unchanged).`,
  });

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

async function seuratPipelineHandler(ctx) {
  await ctx.heartbeat();

  const job = ctx.job;
  const multiSample = job.jobType === 'seurat.multisample.v1';
  const handlerName = multiSample ? 'seurat.multisample.v1' : 'seurat.pipeline.v1';
  const operation = multiSample ? 'r.seurat.multisample.v1' : 'r.seurat.pipeline.v1';
  await ctx.log({
    level: 'info',
    message: `${handlerName} handler: resolving dataset inputs + parameters before any R contact.`,
  });
  const datasetId = job.datasetId;
  const objectId = job.analysisObjectId;
  if (typeof job.projectId !== 'string' || job.projectId === '') {
    throw codedHandlerError(
      'PROJECT_CONTEXT_REQUIRED',
      'Seurat pipeline job is missing its project context.'
    );
  }
  if (typeof datasetId !== 'string' || datasetId === '') {
    throw codedHandlerError(
      'DATASET_CONTEXT_REQUIRED',
      'Seurat pipeline job is missing its input dataset.'
    );
  }
  if (typeof objectId !== 'string' || objectId === '') {
    throw codedHandlerError(
      'R_OBJECT_CONTEXT_REQUIRED',
      'Seurat pipeline job is missing its raw dataset analysis object.'
    );
  }
  const inputResolver = multiSample
    ? ctx.getMultiSampleSeuratPipelineInputs
    : ctx.getSeuratPipelineInputs;
  if (typeof inputResolver !== 'function') {
    throw codedHandlerError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  const resolvedInputs = await inputResolver();
  const datasets = multiSample
    ? resolvedInputs && resolvedInputs.datasets
    : [resolvedInputs && resolvedInputs.dataset];
  const dataset = datasets && datasets[0];
  const inputObject = resolvedInputs && resolvedInputs.inputObject;
  if (!dataset || dataset.id !== datasetId)
    throw codedHandlerError('DATASET_NOT_FOUND', 'Dataset not found.');
  try {
    if (multiSample) {
      const validated = resolvedInputs && resolvedInputs.validated;
      assertSupportedMultiSampleDatasets(datasets, validated && validated.samples);
    } else {
      assertSupportedSeuratPipelineDataset(dataset);
    }
  } catch (err) {
    throw codedHandlerError(
      err.code || 'DATASET_NOT_READY',
      err.message || 'Dataset is not ready for analysis.'
    );
  }
  if (!inputObject || inputObject.id !== objectId) {
    throw codedHandlerError('R_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  if (inputObject.datasetId !== datasetId) {
    throw codedHandlerError(
      'INVALID_PARAMETERS',
      'Seurat pipeline input object must reference the same dataset as the job.'
    );
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
      ...(multiSample
        ? {
            multiSampleSeuratPipeline: {
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
            },
          }
        : {
            seuratPipeline: {
              params,
              datasetStorageKey: dataset.internalStorageKey,
              datasetFileType: dataset.fileType,
              checkpointStorageKey,
            },
          }),
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
  if (
    checkpoint.saved !== true ||
    typeof checkpoint.checksumSha256 !== 'string' ||
    checkpoint.checksumSha256 === ''
  ) {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey);
    throw codedHandlerError(
      'CHECKPOINT_SAVE_FAILED',
      'Pipeline did not produce a durable checkpoint.'
    );
  }

  let completion;
  try {
    completion = await ctx.completeSeuratPipelineResult({
      source: {
        displayName: multiSample ? 'Multi-sample dataset input' : 'Dataset input',
        metadata: {
          source: 'dataset',
          datasetId,
          ...(multiSample ? { datasetIds: samples.map((sample) => sample.datasetId) } : {}),
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
          ...(multiSample
            ? {
                datasetIds: samples.map((sample) => sample.datasetId),
                sampleDesign: samples,
                sampleMetadataColumn: 'sample_id',
                conditionMetadataColumn: 'condition',
              }
            : {}),
          checkpoint: { available: true, storage_kind: 'local_internal', downloadable: false },
          resolvedParams: params,
          defaultsApplied,
          summary: descriptor.summary,
          warnings:
            descriptor.metadata && descriptor.metadata.warnings ? descriptor.metadata.warnings : [],
        },
      },
      checkpointArtifact: {
        artifactType: 'checkpoint',
        name: 'Seurat pipeline checkpoint',
        description:
          'Durable internal checkpoint of the Seurat pipeline result object. No public download in this branch.',
        storageKind: 'local_internal',
        internalStorageKey: checkpointStorageKey,
        checksumSha256: checkpoint.checksumSha256,
        sizeBytes: checkpoint.sizeBytes != null ? checkpoint.sizeBytes : 0,
        metadata: {
          operation,
          scientific_output: true,
          downloadable: false,
          datasetId,
          ...(multiSample ? { datasetIds: samples.map((sample) => sample.datasetId) } : {}),
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
          ...(multiSample
            ? {
                datasetIds: samples.map((sample) => sample.datasetId),
                sampleDesign: samples,
              }
            : {}),
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

  await ctx.log({
    level: 'info',
    message: `${handlerName} handler: result object ${resultObject.id} created with checkpoint ${checkpointArtifact.id} + summary ${summaryArtifact.id}.`,
  });

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

async function spatialSeuratPipelineHandler(ctx) {
  await ctx.heartbeat();
  await ctx.log({
    level: 'info',
    message: 'spatial.seurat.v1 handler: resolving a Visium dataset before R contact.',
  });
  const job = ctx.job;
  if (
    !job.projectId ||
    !job.datasetId ||
    !job.analysisObjectId ||
    typeof ctx.getSpatialPipelineInputs !== 'function'
  ) {
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
    throw codedHandlerError(
      error.code || 'DATASET_NOT_READY',
      error.message || 'Spatial dataset is not ready.'
    );
  }
  if (
    !inputObject ||
    inputObject.id !== job.analysisObjectId ||
    inputObject.datasetId !== dataset.id
  ) {
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
  if (
    checkpoint.saved !== true ||
    !checkpoint.checksumSha256 ||
    !Number.isSafeInteger(checkpoint.sizeBytes) ||
    checkpoint.sizeBytes < 0
  ) {
    await discardUnrecordedProjectOutput(ctx, checkpointStorageKey);
    throw codedHandlerError(
      'CHECKPOINT_SAVE_FAILED',
      'Spatial pipeline did not produce a durable checkpoint.'
    );
  }
  let completion;
  try {
    completion = await ctx.completeSeuratPipelineResult({
      source: {
        displayName: 'Visium dataset input',
        metadata: {
          source: 'dataset',
          datasetId: dataset.id,
          fileType: dataset.fileType,
          modality: 'spatial',
          scientific_output: false,
        },
      },
      result: {
        objectType: 'seurat',
        displayName: 'Spatial Seurat pipeline result',
        metadata: {
          source: 'spatial.seurat.v1',
          operation: 'r.spatial.seurat.v1',
          modality: 'spatial',
          platform: '10x_visium',
          scientific_output: true,
          datasetId: dataset.id,
          checkpoint: { available: true, storage_kind: 'local_internal', downloadable: false },
          resolvedParams: params,
          defaultsApplied,
          summary: descriptor.summary,
          warnings: descriptor.metadata?.warnings || [],
        },
      },
      checkpointArtifact: {
        artifactType: 'checkpoint',
        name: 'Spatial Seurat checkpoint',
        description:
          'Durable internal checkpoint containing the Seurat spatial assay and image coordinates.',
        storageKind: 'local_internal',
        internalStorageKey: checkpointStorageKey,
        checksumSha256: checkpoint.checksumSha256,
        sizeBytes: checkpoint.sizeBytes,
        metadata: {
          operation: 'r.spatial.seurat.v1',
          modality: 'spatial',
          platform: '10x_visium',
          scientific_output: true,
          downloadable: false,
          datasetId: dataset.id,
        },
      },
      summaryArtifact: {
        artifactType: descriptor.artifactType,
        name: descriptor.name,
        description: descriptor.description,
        storageKind: 'metadata_only',
        metadata: {
          ...descriptor.metadata,
          datasetId: dataset.id,
          modality: 'spatial',
          platform: '10x_visium',
          resolvedParams: params,
          defaultsApplied,
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
      ok: true,
      handled: 'spatial.seurat.v1',
      operation: 'r.spatial.seurat.v1',
      resultAnalysisObjectId: completion.resultObject.id,
      checkpointArtifactId: completion.checkpointArtifact.id,
      summaryArtifactId: completion.summaryArtifact.id,
    },
  };
}

module.exports = {
  pbmcPipelineHandler,
  seuratPipelineHandler,
  spatialSeuratPipelineHandler,
};
