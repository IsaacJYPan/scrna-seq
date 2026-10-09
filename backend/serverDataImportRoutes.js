'use strict';

const express = require('express');
const { createServerDataImportService } = require('./serverDataImports');

function serverDataImportRoutes({ db, provider, requireAuth, service: suppliedService } = {}) {
  const router = express.Router();
  const service = suppliedService || createServerDataImportService(db, provider);
  router.use(requireAuth, express.json({ limit: '16kb' }));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  const route = callback => async (req, res) => {
    try { await callback(req, res); }
    catch (error) {
      const hidden = /NOT_FOUND/.test(error?.code || '');
      const forbidden = ['FORBIDDEN', 'PROJECT_ROLE_REQUIRED'].includes(error?.code);
      const status = error?.status || (hidden ? 404 : forbidden ? 403 : 500);
      const message = status < 500 ? error.message : 'Server data imports are temporarily unavailable. Check the current request status before starting another import.';
      if (!res.headersSent) res.status(status).json({ error: message, ...(status < 500 && error.code ? { code: error.code } : {}) });
      else res.destroy();
    }
  };
  router.get('/:projectId/roots', route(async (req, res) => res.json(await service.roots(req.user.id, req.params.projectId))));
  router.get('/:projectId/roots/:rootId/files', route(async (req, res) => res.json(await service.list(req.user.id, req.params.projectId, req.params.rootId, req.query))));
  router.post('/:projectId/imports', route(async (req, res) => {
    const result = await service.start(req.user.id, req.params.projectId, req.body);
    res.status(result.status === 'pending' ? 202 : 200).json(result);
  }));
  router.get('/:projectId/imports/:requestId', route(async (req, res) => res.json(await service.get(req.user.id, req.params.projectId, req.params.requestId))));
  return router;
}

module.exports = { serverDataImportRoutes };
