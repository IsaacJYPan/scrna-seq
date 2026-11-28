'use strict';

const express = require('express');

// Authenticated runtime metadata, mounted at /api/runtime. Reports what the
// backend detects; browser clients never choose an executable path.
function runtimeRoutes({ db, config, runtimeReadiness, buildRuntimeDiagnostics, toPublicRuntimeDiagnostics }) {
  const router = express.Router();

  router.get('/readiness', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const projectId = req.query.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{3,128}$/.test(projectId))) {
      return res.status(400).json({ error: 'A valid project id is required.' });
    }
    try {
      // Entitlement and membership are deliberately outside the shared probe
      // cache. A fresh request must reflect revocation or a changed project role.
      if (projectId && !(await db.getProjectForUser(projectId, req.user.id))) {
        return res.status(404).json({ error: 'Project not found.' });
      }
      return res.json(await runtimeReadiness.inspect({ resolveAccess: async () => {
        const access = await db.getExpertRCapabilities(req.user.id, projectId || null);
        if (projectId && !(await db.getProjectForUser(projectId, req.user.id))) {
          throw Object.assign(new Error('Project not found.'), { code: 'READINESS_PROJECT_NOT_FOUND' });
        }
        return { canExecuteExpertR: access.canExecuteExpertR,
          revoked: access.expertRAccessRevoked, demoMode: config.demoMode() };
      } }));
    } catch (error) {
      if (error?.code === 'READINESS_PROJECT_NOT_FOUND') return res.status(404).json({ error: 'Project not found.' });
      console.error('[Runtime] Readiness observation unavailable.');
      return res.status(503).json({ error: 'Server readiness could not be checked.' });
    }
  });
  router.get('/diagnostics', async (req, res) => {
    try {
      const diagnostics = await buildRuntimeDiagnostics();
      res.json(toPublicRuntimeDiagnostics(diagnostics));
    } catch (err) {
      console.error('[Diagnostics] Runtime diagnostics failed:', err);
      res.status(500).json({ error: 'Runtime diagnostics failed' });
    }
  });

  // Compute availability is projected from a short-lived DB heartbeat written by
  // the standalone worker. Do not proxy the private worker health port or expose
  // worker ids, paths, topology, R URLs, or raw errors to browser clients.
  router.get('/compute-status', async (req, res) => {
    try {
      const status = await db.getStandaloneWorkerRuntimeStatus();
      res.json(status);
    } catch {
      console.error('[Runtime] Compute status unavailable.');
      res.status(503).json({ status: 'unknown', updatedAt: null });
    }
  });

  return router;
}

module.exports = { runtimeRoutes };
