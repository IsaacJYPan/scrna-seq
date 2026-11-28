'use strict';

const express = require('express');
const { isValidDatasetIdFormat } = require('./resourceIds');
const { REJECTED_OWNER_FIELDS } = require('./projectResourceHttp');
const { rejectAnalysisObjectStorageFields } = require('./analysisObjectFields');

// Compatibility routes for private, projectless analysis objects, mounted at
// /api/analysis-objects after authentication and JSON body parsing. Object ids
// are server-issued; clients may never choose an id or assert ownership.
function privateAnalysisObjectRoutes({ db }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // Compatibility surface for genuinely private, projectless objects only.
    // Project data must use /api/projects/:projectId/analysis-objects so creator
    // identity can never bypass current project membership.

    // Object ids are server-issued. Reject any client attempt to choose one.
    if (body.id !== undefined) {
      return res.status(400).json({ error: 'Object id is server-assigned and must not be provided.' });
    }
    // Ownership is derived from the session only — never from the request body.
    for (const field of REJECTED_OWNER_FIELDS) {
      if (body[field] !== undefined) {
        return res.status(400).json({ error: `Field '${field}' is not allowed; ownership is derived from the session.` });
      }
    }
    if (rejectAnalysisObjectStorageFields(body, res)) return;

    // Validate linked-resource ownership before creating anything. 404 (not 403)
    // so we never reveal that another user's resource exists.
    if (body.parentObjectId !== undefined && body.parentObjectId !== null) {
      if (typeof body.parentObjectId !== 'string' || !(await db.getPrivateAnalysisObjectForUser(body.parentObjectId, req.user.id))) {
        return res.status(404).json({ error: 'Parent analysis object not found.' });
      }
    }
    if (body.createdByProvenanceId !== undefined && body.createdByProvenanceId !== null) {
      if (typeof body.createdByProvenanceId !== 'string' || !(await db.getProvenance(body.createdByProvenanceId, req.user.email))) {
        return res.status(404).json({ error: 'Provenance record not found.' });
      }
    }
    // Durable datasets are project-scoped and therefore unavailable here. Keep a
    // distinct 400 for malformed ids; any well-formed id is resolved as 404 by the
    // private-scope DB helper.
    if (body.datasetId !== undefined && body.datasetId !== null) {
      if (!isValidDatasetIdFormat(body.datasetId)) {
        return res.status(400).json({ error: 'Malformed dataset ID.' });
      }
    }
    try {
      const created = await db.createPrivateAnalysisObjectForUser(req.user.id, {
        datasetId: body.datasetId,
        parentObjectId: body.parentObjectId,
        objectType: body.objectType,
        displayName: body.displayName,
        metadata: body.metadata,
        createdByProvenanceId: body.createdByProvenanceId
      });
      res.status(201).json(db.toPublicAnalysisObject(created));
    } catch (e) {
      if (e.code === 'PARENT_NOT_FOUND' || e.code === 'DATASET_NOT_FOUND') return res.status(404).json({ error: e.message });
      if (e.code === 'FORBIDDEN') return res.status(403).json({ error: e.message });
      if (['INVALID_OBJECT_TYPE', 'INVALID_METADATA', 'INVALID_OWNER'].includes(e.code)) {
        return res.status(400).json({ error: e.message });
      }
      console.error('[AnalysisObjects] Create failed:', e);
      res.status(500).json({ error: 'Failed to create analysis object.' });
    }
  });

  router.get('/', async (req, res) => {
    const filters = {
      datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
      parentObjectId: typeof req.query.parentObjectId === 'string' ? req.query.parentObjectId : undefined,
      lineageRootId: typeof req.query.lineageRootId === 'string' ? req.query.lineageRootId : undefined,
      objectType: typeof req.query.objectType === 'string' ? req.query.objectType : undefined
    };
    res.json((await db.listPrivateAnalysisObjectsForUser(req.user.id, filters)).map(db.toPublicAnalysisObject));
  });

  router.get('/:id', async (req, res) => {
    const obj = await db.getPrivateAnalysisObjectForUser(req.params.id, req.user.id);
    if (!obj) return res.status(404).json({ error: 'Analysis object not found.' });
    res.json(db.toPublicAnalysisObject(obj));
  });

  return router;
}

// Legacy compatibility API for private, projectless jobs, mounted at /api/jobs.
// Project jobs use the project RBAC routes. Job ids and status are server-managed.
function privateJobRoutes({ db }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // Receipt-backed scientific jobs require project-scoped durable storage and
    // recovery authorization. Do not accept them through this legacy projectless
    // compatibility route only to fail later in the worker.
    if (db.RETRYABLE_DURABLE_JOB_TYPES.has(body.jobType)) {
      return res.status(400).json({
        error: 'This durable scientific job type requires the project-scoped jobs API.',
      });
    }

    // Job ids are server-issued. Reject any client attempt to choose one.
    if (body.id !== undefined) {
      return res.status(400).json({ error: 'Job id is server-assigned and must not be provided.' });
    }
    // Ownership is derived from the session only — never from the request body.
    for (const field of REJECTED_OWNER_FIELDS) {
      if (body[field] !== undefined) {
        return res.status(400).json({ error: `Field '${field}' is not allowed; ownership is derived from the session.` });
      }
    }
    // Status is server-managed; a client cannot pick the initial status.
    if (body.status !== undefined) {
      return res.status(400).json({ error: 'Job status is server-managed and must not be provided.' });
    }
    if (body.retryOfJobId !== undefined || body.retry_of_job_id !== undefined) {
      return res.status(400).json({ error: 'Job retry linkage is server-managed and must not be provided.' });
    }
    // Durable datasets are project-scoped and therefore unavailable here. Keep a
    // distinct 400 for malformed ids; well-formed ids resolve as 404 below.
    if (body.datasetId !== undefined && body.datasetId !== null) {
      if (!isValidDatasetIdFormat(body.datasetId)) {
        return res.status(400).json({ error: 'Malformed dataset ID.' });
      }
    }

    try {
      const created = await db.createPrivateJobForUser(req.user.id, {
        analysisObjectId: body.analysisObjectId,
        datasetId: body.datasetId,
        jobType: body.jobType,
        parameters: body.parameters
      });
      res.status(201).json(db.toPublicJob(created));
    } catch (e) {
      if (e.code === 'ANALYSIS_OBJECT_NOT_FOUND' || e.code === 'DATASET_NOT_FOUND') return res.status(404).json({ error: e.message });
      if (e.code === 'FORBIDDEN') return res.status(403).json({ error: e.message });
      if (['INVALID_JOB_TYPE', 'INVALID_PARAMETERS', 'INVALID_OWNER'].includes(e.code)) {
        return res.status(400).json({ error: e.message });
      }
      console.error('[Jobs] Create failed:', e);
      res.status(500).json({ error: 'Failed to create job.' });
    }
  });

  router.get('/', async (req, res) => {
    const filters = {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      jobType: typeof req.query.jobType === 'string' ? req.query.jobType : undefined,
      analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
      resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined
    };
    res.json((await db.listPrivateJobsForUser(req.user.id, filters)).map(db.toPublicJob));
  });

  router.get('/:id', async (req, res) => {
    const job = await db.getPrivateJobForUser(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json(db.toPublicJob(job));
  });

  router.get('/:id/logs', async (req, res) => {
    const job = await db.getPrivateJobForUser(req.params.id, req.user.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const publicJob = db.toPublicJob(job);
    res.json({ id: publicJob.id, status: publicJob.status, logs: publicJob.logs, error: publicJob.error });
  });

  router.post('/:id/cancel', async (req, res) => {
    try {
      const job = await db.cancelPrivateJobForUser(req.user.id, req.params.id);
      res.json(db.toPublicJob(job));
    } catch (e) {
      if (e.code === 'JOB_NOT_FOUND') return res.status(404).json({ error: e.message });
      if (e.code === 'JOB_NOT_CANCELABLE') return res.status(409).json({ error: e.message });
      console.error('[Jobs] Cancel failed:', e);
      res.status(500).json({ error: 'Failed to cancel job.' });
    }
  });

  return router;
}

module.exports = { privateAnalysisObjectRoutes, privateJobRoutes };
