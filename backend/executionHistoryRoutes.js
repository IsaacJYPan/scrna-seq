'use strict';

const express = require('express');
const { createExecutionHistoryService } = require('./executionHistory');
function executionHistoryRoutes({ db, provider, requireAuth }) {
  const router = express.Router(); const service = createExecutionHistoryService(db, provider);
  router.use(requireAuth);
  const route = callback => async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try { res.json(await callback(req)); }
    catch (error) {
      const status = error.status || (/NOT_FOUND/.test(error.code || '') ? 404 : ['FORBIDDEN', 'PROJECT_ROLE_REQUIRED'].includes(error.code) ? 403 : 500);
      res.status(status).json({ error: status < 500 ? error.message : 'Execution history is unavailable. Please try again.', ...(status < 500 && error.code ? { code: error.code } : {}) });
    }
  };
  router.get('/:projectId', route(req => service.list(req.user.id, req.params.projectId, req.query)));
  router.get('/:projectId/:recordId', route(req => service.get(req.user.id, req.params.projectId, req.params.recordId)));
  router.get('/:projectId/:recordId/environment', route(req => service.environment(req.user.id, req.params.projectId, req.params.recordId)));
  return router;
}
module.exports = { executionHistoryRoutes };
