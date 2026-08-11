'use strict';

// First spatial workflow: one classic 10x Visium Space Ranger output bundle.
// The uploaded ZIP must contain filtered_feature_bc_matrix.h5 plus the spatial/
// image/coordinate files consumed by Seurat::Load10X_Spatial. Visium HD and
// image-based platforms remain separate future contracts.
const { validateSeuratPipelineParams } = require('./seuratPipeline');
const { isProjectStorageKey, projectStorageFileKey } = require('./storage');

const SPATIAL_SEURAT_JOB_TYPE = 'spatial.seurat.v1';
const SPATIAL_SEURAT_DATASET_TYPE = 'visium_zip';

function codedError(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function validateSpatialSeuratParams(input) {
  return validateSeuratPipelineParams(input);
}

function assertSupportedSpatialSeuratDataset(dataset) {
  if (!dataset || typeof dataset !== 'object') {
    throw codedError('DATASET_NOT_FOUND', 'Spatial dataset not found.');
  }
  if (dataset.fileType !== SPATIAL_SEURAT_DATASET_TYPE) {
    throw codedError('INVALID_PARAMETERS', 'spatial.seurat.v1 supports classic 10x Visium Space Ranger ZIP bundles only.');
  }
  if (dataset.uploadStatus !== 'uploaded' || dataset.validationStatus === 'invalid'
      || typeof dataset.internalStorageKey !== 'string'
      || !isProjectStorageKey(dataset.internalStorageKey, {
        projectId: dataset.projectId, kind: 'datasets',
      })) {
    throw codedError('INVALID_PARAMETERS', 'Spatial dataset is not ready for analysis.');
  }
}

function allocateSpatialSeuratCheckpointStorageKey(projectId, jobId) {
  if (typeof jobId !== 'string' || !/^job_[0-9a-f]+$/.test(jobId)) {
    throw codedError('INVALID_JOB_ID', 'A server-generated job ID is required.');
  }
  return projectStorageFileKey(String(projectId), 'checkpoints', jobId, 'spatial-checkpoint.rds');
}

module.exports = {
  SPATIAL_SEURAT_JOB_TYPE,
  SPATIAL_SEURAT_DATASET_TYPE,
  validateSpatialSeuratParams,
  assertSupportedSpatialSeuratDataset,
  allocateSpatialSeuratCheckpointStorageKey,
};
