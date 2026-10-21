'use strict';

const { projectStorageFileKey } = require('./storage');

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateConditionComparisonParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw codedError('INVALID_PARAMETERS', 'Condition-comparison parameters must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'contrastId') {
      throw codedError('UNKNOWN_PARAMETER', `Unknown parameter: ${key}.`);
    }
  }
  if (typeof input.contrastId !== 'string' || !/^contrast_[0-9a-f]+$/.test(input.contrastId)) {
    throw codedError('INVALID_PARAMETERS', 'contrastId must be a server-generated contrast ID.');
  }
  return { params: { contrastId: input.contrastId }, defaultsApplied: [] };
}

function allocateConditionComparisonResultStorageKey(projectId, jobId) {
  if (typeof jobId !== 'string' || !/^job_[0-9a-f]+$/.test(jobId)) {
    throw codedError('INVALID_JOB_ID', 'A server-generated job ID is required.');
  }
  return projectStorageFileKey(projectId, 'artifacts', jobId, 'condition-pseudobulk-de.csv');
}

module.exports = {
  CONDITION_COMPARISON_PARAM_NAMES: Object.freeze(['contrastId']),
  validateConditionComparisonParams,
  allocateConditionComparisonResultStorageKey,
};
