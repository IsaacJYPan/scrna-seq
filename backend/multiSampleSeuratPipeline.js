'use strict';

const {
  SEURAT_PIPELINE_PARAM_NAMES,
  validateSeuratPipelineParams,
  assertSupportedSeuratPipelineDataset,
  allocateSeuratCheckpointStorageKey,
} = require('./seuratPipeline');

const MULTI_SAMPLE_JOB_TYPE = 'seurat.multisample.v1';
const MIN_MULTI_SAMPLE_INPUTS = 2;
const MAX_MULTI_SAMPLE_INPUTS = 48;
const MULTI_SAMPLE_PARAM_NAMES = Object.freeze(['samples', ...SEURAT_PIPELINE_PARAM_NAMES]);
const DATASET_ID_PATTERN = /^ds_[0-9a-f]+$/;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeRequiredLabel(value, label, maxLength = 80) {
  if (typeof value !== 'string') {
    throw codedError('INVALID_PARAMETER', `${label} must be text.`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maxLength || !SAFE_LABEL_PATTERN.test(normalized)) {
    throw codedError(
      'INVALID_PARAMETER',
      `${label} must be 1-${maxLength} characters using letters, numbers, spaces, periods, underscores, or hyphens.`
    );
  }
  return normalized;
}

function safeOptionalLabel(value, label, maxLength = 80) {
  if (value === undefined || value === null || value === '') return null;
  return safeRequiredLabel(value, label, maxLength);
}

function validateSampleInputs(rawSamples) {
  if (!Array.isArray(rawSamples)
      || rawSamples.length < MIN_MULTI_SAMPLE_INPUTS
      || rawSamples.length > MAX_MULTI_SAMPLE_INPUTS) {
    throw codedError(
      'INVALID_PARAMETER',
      `samples must contain ${MIN_MULTI_SAMPLE_INPUTS}-${MAX_MULTI_SAMPLE_INPUTS} uploaded datasets.`
    );
  }

  const datasetIds = new Set();
  const sampleNames = new Set();
  const samples = rawSamples.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw codedError('INVALID_PARAMETER', `samples[${index}] must be an object.`);
    }
    const allowed = new Set(['datasetId', 'sampleName', 'conditionName', 'donorCode', 'batch']);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        throw codedError('UNKNOWN_PARAMETER', `Unknown samples[${index}] field '${key}'.`);
      }
    }
    if (typeof raw.datasetId !== 'string' || !DATASET_ID_PATTERN.test(raw.datasetId)) {
      throw codedError('INVALID_PARAMETER', `samples[${index}].datasetId is malformed.`);
    }
    const sampleName = safeRequiredLabel(raw.sampleName, `samples[${index}].sampleName`);
    const conditionName = safeRequiredLabel(raw.conditionName, `samples[${index}].conditionName`);
    const sampleKey = sampleName.toLocaleLowerCase('en-US');
    if (datasetIds.has(raw.datasetId)) {
      throw codedError('INVALID_PARAMETER', 'Each uploaded dataset may be used only once per multi-sample run.');
    }
    if (sampleNames.has(sampleKey)) {
      throw codedError('INVALID_PARAMETER', 'Sample names must be unique within a multi-sample run.');
    }
    datasetIds.add(raw.datasetId);
    sampleNames.add(sampleKey);
    return {
      datasetId: raw.datasetId,
      sampleName,
      conditionName,
      donorCode: safeOptionalLabel(raw.donorCode, `samples[${index}].donorCode`),
      batch: safeOptionalLabel(raw.batch, `samples[${index}].batch`),
    };
  });

  const conditionNames = [...new Set(samples.map(sample => sample.conditionName.toLocaleLowerCase('en-US')))];
  if (conditionNames.length < 2) {
    throw codedError('INVALID_PARAMETER', 'A multi-condition run requires at least two distinct conditions.');
  }
  return samples;
}

function validateMultiSampleSeuratParams(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (!isPlainObject(raw)) {
    throw codedError('INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
  }
  for (const key of Object.keys(raw)) {
    if (!MULTI_SAMPLE_PARAM_NAMES.includes(key)) {
      throw codedError('UNKNOWN_PARAMETER', `Unknown parameter '${key}'.`);
    }
  }
  const samples = validateSampleInputs(raw.samples);
  const pipelineInput = {};
  for (const name of SEURAT_PIPELINE_PARAM_NAMES) {
    if (Object.prototype.hasOwnProperty.call(raw, name)) pipelineInput[name] = raw[name];
  }
  const { params, defaultsApplied } = validateSeuratPipelineParams(pipelineInput);
  return { params, defaultsApplied, samples };
}

function assertSupportedMultiSampleDatasets(datasets, samples) {
  if (!Array.isArray(datasets) || datasets.length !== samples.length) {
    throw codedError('DATASET_NOT_FOUND', 'One or more multi-sample datasets were not found.');
  }
  const byId = new Map(datasets.map(dataset => [dataset && dataset.id, dataset]));
  for (const sample of samples) {
    const dataset = byId.get(sample.datasetId);
    if (!dataset) throw codedError('DATASET_NOT_FOUND', 'One or more multi-sample datasets were not found.');
    assertSupportedSeuratPipelineDataset(dataset);
  }
}

module.exports = {
  MULTI_SAMPLE_JOB_TYPE,
  MIN_MULTI_SAMPLE_INPUTS,
  MAX_MULTI_SAMPLE_INPUTS,
  MULTI_SAMPLE_PARAM_NAMES,
  validateMultiSampleSeuratParams,
  assertSupportedMultiSampleDatasets,
  allocateMultiSampleSeuratCheckpointStorageKey: allocateSeuratCheckpointStorageKey,
};
