'use strict';

// The R runtime reports the parameters it actually used. A run is recorded only
// when they equal the validated request: the record must describe the
// computation. jsonlite prints at most four decimal digits, so non-integers
// compare within that precision; integers, booleans and strings must match.

const { codedError, markRSideEffectsPossible } = require('./errors');

function sameParameterValue(requested, effective) {
  if (typeof requested === 'number' && typeof effective === 'number') {
    if (Number.isInteger(requested)) return requested === effective;
    return Math.abs(requested - effective) <= 1e-4 * Math.max(1, Math.abs(requested));
  }
  return requested === effective;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Returns the requested parameters when R's effective parameters match them;
// otherwise throws. The R output exists at this point, so the error is marked as
// having possible side effects for the caller's cleanup.
function verifiedEffectiveParameters(requested, body) {
  const effective = body && body.effective_parameters;
  if (!isPlainObject(requested) || !isPlainObject(effective)) {
    throw markRSideEffectsPossible(
      codedError('R_PARAMETERS_UNVERIFIED', 'The analysis runtime did not report the parameters it used.')
    );
  }
  const mismatched = Object.keys(requested).filter((key) => !sameParameterValue(requested[key], effective[key]));
  if (mismatched.length) {
    throw markRSideEffectsPossible(
      codedError(
        'R_PARAMETERS_MISMATCH',
        `The analysis ran with different parameters than requested: ${mismatched.slice(0, 5).join(', ')}.`
      )
    );
  }
  return { ...requested };
}

// The validated parameters a pipeline job sends to R, as the bridge sends them.
function requestedPipelineParameters(job) {
  const raw = (job && job.parameters) || {};
  if (job.jobType === 'pbmc.pipeline.v1') return require('../pbmcPipeline').validatePbmcPipelineParams(raw).params;
  if (job.jobType === 'seurat.multisample.v1') {
    return require('../multiSampleSeuratPipeline').validateMultiSampleSeuratParams(raw).params;
  }
  return require('../seuratPipeline').validateSeuratPipelineParams(raw).params;
}

module.exports = { sameParameterValue, verifiedEffectiveParameters, requestedPipelineParameters };
