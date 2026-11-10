'use strict';

const express = require('express');
const {
  isValidArtifactIdFormat,
  isValidJobIdFormat,
} = require('./resourceIds');
const { sendProjectResourceError } = require('./projectResourceHttp');

// Durable artifact/checkpoint METADATA produced by jobs, readable by project
// members by role. There is intentionally NO create/mutate route (artifact
// creation is worker/helper-driven), and these endpoints return metadata only.
// The separate allowlisted download route in server.js provides authenticated exports for
// selected result tables; checkpoints remain non-downloadable. The serializer
// omits storage_uri, so no internal/local path or storage key is ever exposed;
// claim tokens / worker internals are not in the artifact model at all. Legacy
// NULL-project artifacts never appear (the helpers always pin a real project_id).

// Mounted at /api/projects/:projectId; serves only the read-only artifact metadata paths below.
function projectArtifactRoutes({ db }) {
  const router = express.Router({ mergeParams: true });

  router.get('/artifacts', async (req, res) => {
    const filters = {
      jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
      artifactType: typeof req.query.artifactType === 'string' ? req.query.artifactType : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
      resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined,
      datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
      provenanceId: typeof req.query.provenanceId === 'string' ? req.query.provenanceId : undefined,
      figureId: typeof req.query.figureId === 'string' ? req.query.figureId : undefined
    };
    try {
      res.json(await db.listProjectArtifacts(req.user.id, req.params.projectId, filters));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectArtifacts');
    }
  });

  router.get('/artifacts/:artifactId', async (req, res) => {
    if (!isValidArtifactIdFormat(req.params.artifactId)) {
      return res.status(400).json({ error: 'Malformed artifact ID.' });
    }
    try {
      const artifact = await db.getProjectArtifact(req.user.id, req.params.projectId, req.params.artifactId);
      if (!artifact) return res.status(404).json({ error: 'Artifact not found.' });
      res.json(artifact);
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectArtifacts');
    }
  });

  router.get('/jobs/:jobId/artifacts', async (req, res) => {
    if (!isValidJobIdFormat(req.params.jobId)) {
      return res.status(400).json({ error: 'Malformed job ID.' });
    }
    const filters = {
      artifactType: typeof req.query.artifactType === 'string' ? req.query.artifactType : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined
    };
    try {
      res.json(await db.listProjectJobArtifacts(req.user.id, req.params.projectId, req.params.jobId, filters));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectArtifacts');
    }
  });

  return router;
}

module.exports = { projectArtifactRoutes };
