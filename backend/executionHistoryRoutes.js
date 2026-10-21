'use strict';

const express = require('express');
const { createExecutionHistoryService } = require('./executionHistory');

function executionHistoryRoutes({ db, provider, requireAuth }) {
  const router = express.Router();
  const service = createExecutionHistoryService(db, provider);
  router.use(requireAuth);

  const route = callback => async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      res.json(await callback(req));
    } catch (error) {
      let status = error.status;
      if (!status) {
        if (/NOT_FOUND/.test(error.code || '')) status = 404;
        else if (['FORBIDDEN', 'PROJECT_ROLE_REQUIRED'].includes(error.code)) status = 403;
        else status = 500;
      }

      if (status < 500) {
        const body = { error: error.message };
        if (error.code) body.code = error.code;
        res.status(status).json(body);
      } else {
        res.status(status).json({ error: 'Execution history is unavailable. Please try again.' });
      }
    }
  };

  router.get('/:projectId', route(req => service.list(req.user.id, req.params.projectId, req.query)));
  router.get('/:projectId/:recordId', route(req => service.get(req.user.id, req.params.projectId, req.params.recordId)));
  router.get('/:projectId/:recordId/environment', route(req => service.environment(req.user.id, req.params.projectId, req.params.recordId)));
  return router;
}

module.exports = { executionHistoryRoutes };
