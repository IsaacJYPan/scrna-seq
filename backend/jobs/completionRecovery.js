// Output allocation, retry cleanup, and receipt expectations for completed R work.

const storage = require('../storage');
const crypto = require('crypto');
const { allocateCheckpointStorageKey } = require('../pbmcPipeline');
const { allocateSeuratCheckpointStorageKey } = require('../seuratPipeline');
const { allocateMultiSampleSeuratCheckpointStorageKey } = require('../multiSampleSeuratPipeline');
const { allocateSpatialSeuratCheckpointStorageKey } = require('../spatialPipeline');
const { allocateDegResultStorageKey } = require('../degFindMarkers');
const { allocateEnrichmentGseaResultStorageKey } = require('../enrichmentGsea');
const { allocateCellChatInferenceResultStorageKey } = require('../cellChatInference');
const { allocateConditionComparisonResultStorageKey } = require('../conditionComparison');
const { isIndeterminateRExecutionFailure, codedHandlerError } = require('./jobErrors');

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
  if (ctx.recoveringCompletionReceipt || !ctx.job || Number(ctx.job.attempts || 0) <= 1) return;
  if (!storage.isProjectStorageKey(key) || typeof ctx.removeDurableObject !== 'function') {
    throw codedHandlerError(
      'RETRY_CLEANUP_FAILED',
      'A prior job attempt could not be prepared safely.'
    );
  }
  try {
    await ctx.removeDurableObject(key);
  } catch {
    throw codedHandlerError(
      'RETRY_CLEANUP_FAILED',
      'A prior job attempt could not be prepared safely.'
    );
  }
}

function deriveCheckpointForkResultObjectId(jobId) {
  if (typeof jobId !== 'string' || jobId === '') {
    throw codedHandlerError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
  }
  return `ao_${crypto
    .createHash('sha256')
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
    if (
      !checkpoint ||
      checkpoint.analysisObjectId !== job.analysisObjectId ||
      checkpoint.projectId !== job.projectId ||
      typeof checkpoint.checkpointArtifactId !== 'string'
    ) {
      throw codedHandlerError('R_COMPLETION_RECEIPT_INVALID', 'Completion receipt is invalid.');
    }
    return {
      sourceCheckpointArtifactId: checkpoint.checkpointArtifactId,
      targetAnalysisObjectId: job.analysisObjectId,
    };
  }
  if (job.jobType === 'checkpoint.fork.v1') {
    const checkpoint = await ctx.getForkableCheckpoint();
    if (
      !checkpoint ||
      checkpoint.analysisObjectId !== job.analysisObjectId ||
      checkpoint.projectId !== job.projectId ||
      typeof checkpoint.checkpointArtifactId !== 'string'
    ) {
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
      try {
        await storageProvider.remove(outputKey);
      } catch {
        /* best effort */
      }
    }
  }
  await bestEffortRemoveCompletionReceipt(storageProvider, job);
}

module.exports = {
  COMPLETION_RECEIPT_JOB_TYPES,
  discardUnrecordedProjectOutput,
  removeRetryOrphanOutput,
  deriveCheckpointForkResultObjectId,
  deterministicCompletionOutputKey,
  completionReceiptExpectation,
  bestEffortRemoveCompletionReceipt,
  bestEffortRemoveRecoveryObjects,
};
