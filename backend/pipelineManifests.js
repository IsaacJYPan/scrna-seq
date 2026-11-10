'use strict';

// The manifest validator is shared with the browser; see shared/pipelineManifest.mjs.
const {
  PIPELINE_CONTRACT: CONTRACT,
  DEFAULT_PIPELINE_ID,
  PARAMETER_TEMPLATE_TYPES,
  RESULT_VIEW_TEMPLATES,
  validatePipelineManifest,
  getDefaultPipelineManifest,
  isBuiltInPipelineId,
} = require('../shared/pipelineManifest.mjs');

const MODULES = Object.freeze(CONTRACT.modules);

module.exports = {
  CONTRACT,
  DEFAULT_PIPELINE_ID,
  MODULES,
  PARAMETER_TEMPLATE_TYPES,
  RESULT_VIEW_TEMPLATES,
  validatePipelineManifest,
  getDefaultPipelineManifest,
  isBuiltInPipelineId,
};
