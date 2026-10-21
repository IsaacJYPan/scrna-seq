'use strict';

const express = require('express');

function provenanceRoutes({ db, requireAuth }) {
  const router = express.Router();
  // Database API endpoints.
  router.use(express.json());
  router.use(requireAuth);

  router.get('/provenance', async (req, res) => {
    res.json(await db.getAllProvenance(req.user.email));
  });

  router.post('/provenance', async (req, res) => {
    const env = { ...req.body, userEmail: req.user.email };
    try {
      const id = await db.saveProvenance(env);
      res.json({ id });
    } catch (e) {
      // A row owned by another user — or a project-scoped row — is reported as a
      // generic 404 (no cross-user/project existence leak), not a raw 500.
      if (e.code === 'PROVENANCE_NOT_FOUND') {
        return res.status(404).json({ error: 'Provenance record not found.' });
      }
      if (e.code === 'INVALID_PROVENANCE') {
        return res.status(400).json({ error: 'Invalid provenance record.' });
      }
      console.error('[Provenance] Save failed (PROVENANCE_SAVE_FAILED).');
      return res.status(500).json({ error: 'Provenance save failed.' });
    }
  });

  router.get('/provenance/:id', async (req, res) => {
    res.json(await db.getProvenance(req.params.id, req.user.email));
  });

  router.get('/provenance-chain/:id', async (req, res) => {
    res.json(await db.getProvenanceChain(req.params.id, req.user.email));
  });

  router.delete('/provenance/:id', async (req, res) => {
    res.json({ success: await db.deleteProvenance(req.params.id, req.user.email) });
  });

  router.get('/figures', async (req, res) => {
    res.json(await db.getFiguresByUser(req.user.email));
  });

  router.post('/figures', async (req, res) => {
    try {
      const id = await db.saveFigure({ ...req.body, userEmail: req.user.email });
      res.json({ id });
    } catch (e) {
      if (e.code === 'FIGURE_NOT_FOUND') {
        return res.status(404).json({ error: 'Figure not found.' });
      }
      console.error('[Figures] Save failed (FIGURE_SAVE_FAILED).');
      return res.status(500).json({ error: 'Figure save failed.' });
    }
  });

  router.delete('/figures/:id', async (req, res) => {
    res.json({ success: await db.deleteFigure(req.params.id, req.user.email) });
  });

  // Cache Endpoints
  router.post('/cache-key', (req, res) => {
    const { operation, params, dataVersion, parentIds } = req.body;
    res.json({ key: db.makeCacheKey(operation, params, dataVersion, parentIds, req.user.email) });
  });

  router.get('/cache/:key', async (req, res) => {
    res.json(await db.getCachedResult(req.params.key, req.user.email));
  });

  router.post('/cache/:key', async (req, res) => {
    const { provenanceId, resultData } = req.body;
    try {
      await db.setCachedResult(req.params.key, provenanceId, resultData, req.user.email);
      res.json({ success: true });
    } catch (e) {
      if (e.code === 'CACHE_NOT_FOUND') {
        return res.status(404).json({ error: 'Cache record not found.' });
      }
      return res.status(403).json({ error: 'Cache write is not permitted.' });
    }
  });

  router.delete('/cache', async (req, res) => {
    await db.clearCache(req.user.email);
    res.json({ success: true });
  });
  return router;
}

module.exports = { provenanceRoutes };
