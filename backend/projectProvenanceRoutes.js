'use strict';

const express = require('express');
const {
  isValidAnalysisObjectIdFormat,
  isValidDatasetIdFormat,
  isValidJobIdFormat,
  isValidProvenanceIdFormat,
} = require('./resourceIds');
const { rejectProjectResourceFields, sendProjectResourceError } = require('./projectResourceHttp');

// Append-only provenance records associated with a project, readable by project
// members by role. project_id comes from the route; the responsible actor from
// the session. There is no update/delete route (provenance is append-only). R
// execution/state is untouched — this is metadata only.

// Mounted at /api/projects/:projectId/provenance after authentication and JSON body parsing.
function projectProvenanceRoutes({ db }) {
  const router = express.Router({ mergeParams: true });

  router.post('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Reject server-controlled id/owner/creator/project fields, plus the actor email
    // (server-derived from the session, never the body).
    if (rejectProjectResourceFields(req, res, { extra: ['userEmail', 'user_email'] })) return;

    // Validate reference id shapes → 400 before touching the DB (well-formed-but-
    // unresolved / cross-project ids become 404 in the DB layer).
    if (body.datasetId !== undefined && body.datasetId !== null && !isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
    if (body.analysisObjectId !== undefined && body.analysisObjectId !== null && !isValidAnalysisObjectIdFormat(body.analysisObjectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    if (body.jobId !== undefined && body.jobId !== null && !isValidJobIdFormat(body.jobId)) {
      return res.status(400).json({ error: 'Malformed job ID.' });
    }
    if (body.resultAnalysisObjectId !== undefined && body.resultAnalysisObjectId !== null && !isValidAnalysisObjectIdFormat(body.resultAnalysisObjectId)) {
      return res.status(400).json({ error: 'Malformed result analysis object ID.' });
    }
    if (body.parentIds !== undefined && body.parentIds !== null) {
      if (!Array.isArray(body.parentIds)) {
        return res.status(400).json({ error: 'parentIds must be an array.' });
      }
      for (const parentRef of body.parentIds) {
        if (!isValidProvenanceIdFormat(parentRef)) {
          return res.status(400).json({ error: 'Malformed parent provenance ID.' });
        }
      }
    }

    try {
      const created = await db.createProjectProvenance(req.user.id, req.params.projectId, {
        datasetId: body.datasetId,
        analysisObjectId: body.analysisObjectId,
        jobId: body.jobId,
        resultAnalysisObjectId: body.resultAnalysisObjectId,
        parentIds: body.parentIds,
        timestamp: body.timestamp,
        language: body.language,
        languageVersion: body.languageVersion,
        packages: body.packages,
        script: body.script,
        parameters: body.parameters,
        operation: body.operation
      });
      res.status(201).json(created);
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectProvenance');
    }
  });

  router.get('/', async (req, res) => {
    const filters = {
      datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
      analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
      jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
      operation: typeof req.query.operation === 'string' ? req.query.operation : undefined
    };
    try {
      res.json(await db.listProjectProvenance(req.user.id, req.params.projectId, filters));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectProvenance');
    }
  });

  router.get('/:provenanceId', async (req, res) => {
    if (!isValidProvenanceIdFormat(req.params.provenanceId)) {
      return res.status(400).json({ error: 'Malformed provenance ID.' });
    }
    try {
      const prov = await db.getProjectProvenance(req.user.id, req.params.projectId, req.params.provenanceId);
      if (!prov) return res.status(404).json({ error: 'Provenance record not found.' });
      res.json(prov);
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectProvenance');
    }
  });

  return router;
}

module.exports = { projectProvenanceRoutes };
