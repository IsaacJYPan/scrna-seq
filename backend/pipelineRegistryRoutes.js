'use strict';

const express = require('express');

// Publishing a trusted pipeline manifest is a platform capability, not a
// project role. Authenticate before parsing the bounded body so cookie CSRF
// enforcement runs before any mutation work. Manifests are declarative only;
// this endpoint never accepts module code, R code, filesystem paths, or URLs.
const PIPELINE_REGISTRY_BODY_LIMIT = 70 * 1024;
const parsePipelineRegistryJson = express.json({
  limit: PIPELINE_REGISTRY_BODY_LIMIT,
  inflate: false,
  type: ['application/json', 'application/*+json'],
});

function parseBoundedPipelineRegistryJson(req, res, next) {
  if (String(req.method || '').toUpperCase() !== 'POST') return next();
  return parsePipelineRegistryJson(req, res, (error) => {
    if (!error) {
      if (req.body === undefined) {
        return res.status(400).json({ error: 'A JSON manifest body is required.' });
      }
      return next();
    }
    if (error.type === 'entity.too.large' || error.status === 413) {
      return res.status(413).json({ error: 'Pipeline manifest request exceeded the size limit.' });
    }
    if (error.type === 'encoding.unsupported' || error.status === 415) {
      return res.status(415).json({ error: 'Compressed pipeline manifest bodies are not accepted.' });
    }
    return res.status(400).json({ error: 'Pipeline manifest request body must be valid JSON.' });
  });
}

function sendPipelineRegistryError(res, error) {
  switch (error.code) {
    case 'FORBIDDEN':
      return res.status(403).json({ error: error.message });
    case 'PIPELINE_MANIFEST_EXISTS':
    case 'PIPELINE_REGISTRY_FULL':
      return res.status(409).json({ error: error.message });
    case 'INVALID_PIPELINE_DEFINITION':
    case 'INVALID_PIPELINE_MANIFEST':
      return res.status(400).json({ error: error.message });
    default:
      console.error('[PipelineRegistry]', error);
      return res.status(500).json({ error: 'Internal error.' });
  }
}

// Mounted at /api/pipeline-registry. Authentication runs before the bounded
// body parser so cookie CSRF enforcement happens before any mutation work.
function pipelineRegistryRoutes({ db, requireAuth }) {
  const router = express.Router();
  router.use(requireAuth);
  router.use(parseBoundedPipelineRegistryJson);

  router.get('/capabilities', async (req, res) => {
    try {
      res.json(await db.getPipelineRegistryCapabilities(req.user.id));
    } catch (error) {
      sendPipelineRegistryError(res, error);
    }
  });

  router.post('/definitions', async (req, res) => {
    try {
      const created = await db.createPipelineRegistryDefinition(req.user.id, req.body);
      res.status(201).json(created);
    } catch (error) {
      sendPipelineRegistryError(res, error);
    }
  });

  return router;
}

module.exports = { pipelineRegistryRoutes, PIPELINE_REGISTRY_BODY_LIMIT };
