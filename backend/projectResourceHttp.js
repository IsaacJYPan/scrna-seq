'use strict';

// HTTP helpers shared by the project-scoped resource routes.

// Ownership and authorship are taken from the session, never the request body.
const REJECTED_OWNER_FIELDS = ['userId', 'user_id', 'ownerUserId', 'owner_user_id'];
const REJECTED_CREATOR_FIELDS = ['createdByUserId', 'created_by_user_id'];

// Map the coded errors thrown by the project-scoped analysis-object/job helpers
// to HTTP statuses: 404 for unknown/not-accessible (no existence leak), 403 for a
// known member lacking the role, 409 for a non-cancelable (terminal) job, 400 for
// input validation.
function sendProjectResourceError(res, e, context) {
  if (e?.code === 'DEMO_COMPUTE_LIMIT') {
    res.setHeader('Retry-After', '10');
    return res.status(429).json({ error: e.message });
  }
  switch (e.code) {
    case 'EXPERT_R_UNAVAILABLE':
    case 'TARGET_UNAVAILABLE':
      return res.status(503).json({ error: e.message, ...(e.code === 'TARGET_UNAVAILABLE' ? { code: e.code } : {}) });
    case 'NOT_FOUND':
    case 'PARENT_NOT_FOUND':
    case 'DATASET_NOT_FOUND':
    case 'ANALYSIS_OBJECT_NOT_FOUND':
    case 'RESULT_OBJECT_NOT_FOUND':
    case 'JOB_NOT_FOUND':
    case 'SUBMISSION_NOT_FOUND':
    case 'PROVENANCE_NOT_FOUND':
    case 'FIGURE_NOT_FOUND':
    case 'PIPELINE_NOT_FOUND':
    case 'BRANCH_NOT_FOUND':
    case 'EXPERIMENTAL_DESIGN_NOT_FOUND':
    case 'CONTRAST_NOT_FOUND':
    case 'ARTIFACT_NOT_DOWNLOADABLE':
      return res.status(404).json({ error: e.message });
    case 'FORBIDDEN':
      return res.status(403).json({ error: e.message });
    case 'JOB_NOT_CANCELABLE':
    case 'JOB_NOT_RETRYABLE':
    case 'SUBMISSION_REQUEST_CONFLICT':
    case 'BRANCH_NAME_EXISTS':
    case 'BRANCH_ARCHIVED':
    case 'BRANCH_VERSION_CONFLICT':
    case 'BRANCH_NOT_REVIEWABLE':
    case 'REVIEW_NOT_OPEN':
    case 'REVIEW_NOT_APPROVED':
    case 'EXPERIMENTAL_DESIGN_CONFLICT':
    case 'METADATA_VALUE_ALREADY_BOUND':
    case 'SAMPLE_ALREADY_BOUND':
      return res.status(409).json({ error: e.message, code: e.code });
    case 'INVALID_OBJECT_TYPE':
    case 'INVALID_METADATA':
    case 'INVALID_JOB_TYPE':
    case 'INVALID_PARAMETERS':
    case 'INVALID_SUBMISSION_REQUEST':
    case 'UNKNOWN_PARAMETER':
    case 'INVALID_PARAMETER':
    case 'INVALID_PACKAGES':
    case 'INVALID_PARENT_IDS':
    case 'INVALID_PLOT_TYPE':
    case 'INVALID_OWNER':
    case 'INVALID_PIPELINE_DEFINITION':
    case 'INVALID_PIPELINE_MANIFEST':
    case 'INVALID_PIPELINE_SELECTION':
    case 'INVALID_BRANCH':
    case 'INVALID_BRANCH_HEAD':
    case 'INVALID_REVIEW':
    case 'INVALID_EXPERIMENTAL_DESIGN':
    case 'UNSUPPORTED_CONDITION_MODEL':
    case 'INVALID_AUDIT_CURSOR':
      return res.status(400).json({ error: e.message, ...(e.code === 'UNSUPPORTED_CONDITION_MODEL' ? { code: e.code } : {}) });
    default:
      console.error(`[${context}]`, e);
      return res.status(500).json({ error: 'Internal error.' });
  }
}

// Reject any client attempt to set a server-controlled field on a project-scoped
// analysis-object/job create. Returns true (and has sent a 400) when one is
// present. project_id is taken from the route, never the body.
function rejectProjectResourceFields(req, res, { extra = [] } = {}) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.id !== undefined) {
    res.status(400).json({ error: 'Id is server-assigned and must not be provided.' });
    return true;
  }
  const forbidden = [
    ...REJECTED_OWNER_FIELDS, ...REJECTED_CREATOR_FIELDS,
    'projectId', 'project_id', ...extra
  ];
  for (const field of forbidden) {
    if (body[field] !== undefined) {
      res.status(400).json({ error: `Field '${field}' is not allowed; it is server-controlled.` });
      return true;
    }
  }
  return false;
}

module.exports = {
  REJECTED_CREATOR_FIELDS,
  REJECTED_OWNER_FIELDS,
  rejectProjectResourceFields,
  sendProjectResourceError,
};
