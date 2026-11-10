'use strict';

// Shape checks for client-supplied resource ids. Server-generated ids are a
// fixed prefix plus lowercase hex; a value that does not match is a malformed
// request (400), distinct from a well-formed id that does not resolve (404).
// The X-Object-ID header uses the looser OBJECT_ID_PATTERN and is additionally
// verified against the database before it can influence R state.

const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;

function isValidObjectIdFormat(value) {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

// Dataset ids are server-generated as `ds_` + lowercase hex. A client that
// supplies a `datasetId` (on analysis-object/job creation, or in a dataset route
// path) must match this shape, else the request is malformed (400) — distinct
// from a well-formed id that simply does not resolve (404).
const DATASET_ID_PATTERN = /^ds_[0-9a-f]+$/;
function isValidDatasetIdFormat(value) {
  return typeof value === 'string' && DATASET_ID_PATTERN.test(value);
}

// Analysis-object and job ids are server-generated as `ao_`/`job_` + lowercase
// hex. A client supplying one (in a project route path, or as a reference field)
// must match the shape, else the request is malformed (400) — distinct from a
// well-formed id that simply does not resolve (404).
const ANALYSIS_OBJECT_ID_PATTERN = /^ao_[0-9a-f]+$/;
function isValidAnalysisObjectIdFormat(value) {
  return typeof value === 'string' && ANALYSIS_OBJECT_ID_PATTERN.test(value);
}
const JOB_ID_PATTERN = /^job_[0-9a-f]+$/;
function isValidJobIdFormat(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

// Project-scoped provenance/figure ids are server-generated as `prov_`/`fig_` +
// lowercase hex. A client supplying one (in a project route path, or as a
// reference field) must match the shape, else the request is malformed (400) —
// distinct from a well-formed id that simply does not resolve (404).
const PROVENANCE_ID_PATTERN = /^prov_[0-9a-f]+$/;
function isValidProvenanceIdFormat(value) {
  return typeof value === 'string' && PROVENANCE_ID_PATTERN.test(value);
}
const FIGURE_ID_PATTERN = /^fig_[0-9a-f]+$/;
function isValidFigureIdFormat(value) {
  return typeof value === 'string' && FIGURE_ID_PATTERN.test(value);
}
// Job-artifact ids are server-generated as `art_` + lowercase hex. A client
// supplying one in a project route path must match the shape, else 400 — distinct
// from a well-formed id that simply does not resolve (404).
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]+$/;
function isValidArtifactIdFormat(value) {
  return typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value);
}

function isValidBranchIdFormat(value) {
  return typeof value === 'string' && /^br_[0-9a-f]+$/.test(value);
}

function isValidReviewIdFormat(value) {
  return typeof value === 'string' && /^rev_[0-9a-f]+$/.test(value);
}

function isValidConditionIdFormat(value) {
  return typeof value === 'string' && /^cond_[0-9a-f]+$/.test(value);
}

function isValidSampleIdFormat(value) {
  return typeof value === 'string' && /^sample_[0-9a-f]+$/.test(value);
}

module.exports = {
  isValidObjectIdFormat,
  isValidDatasetIdFormat,
  isValidAnalysisObjectIdFormat,
  isValidJobIdFormat,
  isValidProvenanceIdFormat,
  isValidFigureIdFormat,
  isValidArtifactIdFormat,
  isValidBranchIdFormat,
  isValidReviewIdFormat,
  isValidConditionIdFormat,
  isValidSampleIdFormat,
};
