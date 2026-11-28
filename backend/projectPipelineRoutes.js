'use strict';

const express = require('express');
const { sendProjectResourceError } = require('./projectResourceHttp');

// Mounted at /api/projects/:projectId. Lists the pipeline definitions a
// project may use and reads or sets the project's selected pipeline; the
// selection scope always comes from the route and session.
function projectPipelineRoutes({ db }) {
  const router = express.Router({ mergeParams: true });

  router.get('/pipeline-definitions', async (req, res) => {
    try {
      res.json(await db.listProjectPipelineDefinitions(req.user.id, req.params.projectId));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectPipelines');
    }
  });

  router.get('/pipeline-selection', async (req, res) => {
    try {
      res.json(await db.getProjectPipelineSelection(req.user.id, req.params.projectId));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectPipelines');
    }
  });

  router.put('/pipeline-selection', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.projectId !== undefined || body.project_id !== undefined
        || body.userId !== undefined || body.user_id !== undefined
        || body.ownerUserId !== undefined || body.owner_user_id !== undefined) {
      return res.status(400).json({ error: 'Pipeline selection scope is server-controlled.' });
    }
    try {
      res.json(await db.setProjectPipelineSelection(req.user.id, req.params.projectId, body.pipelineId));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectPipelines');
    }
  });

  return router;
}

module.exports = { projectPipelineRoutes };
