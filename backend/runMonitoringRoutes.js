'use strict';

const express = require('express');
const { createRunMonitoringService } = require('./runMonitoring');

function runMonitoringRoutes({ db, requireAuth, serviceOptions, service: suppliedService }) {
  const router = express.Router();
  const service = suppliedService || createRunMonitoringService(db, serviceOptions);
  router.use(requireAuth);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  const route = callback => async (req, res) => {
    try { res.json(await callback(req)); }
    catch (error) {
      const status = error.status || (/NOT_FOUND/.test(error.code || '') ? 404 : ['FORBIDDEN', 'PROJECT_ROLE_REQUIRED'].includes(error.code) ? 403 : 500);
      res.status(status).json({ error: status < 500 ? error.message : 'Run monitoring is temporarily unavailable. Refresh to inspect the retained state.',
        ...(status < 500 && error.code ? { code: error.code } : {}) });
    }
  };
  router.get('/:projectId', route(req => service.list(req.user.id, req.params.projectId, req.query)));
  router.get('/:projectId/:recordId', route(req => service.get(req.user.id, req.params.projectId, req.params.recordId)));
  return router;
}

module.exports = { runMonitoringRoutes };
