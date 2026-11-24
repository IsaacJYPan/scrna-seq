'use strict';

const express = require('express');
const {
  isValidAnalysisObjectIdFormat,
  isValidDatasetIdFormat,
  isValidFigureIdFormat,
  isValidJobIdFormat,
  isValidProvenanceIdFormat,
} = require('./resourceIds');
const { rejectProjectResourceFields, sendProjectResourceError } = require('./projectResourceHttp');
const figureBundles = require('./figureBundles');
const projectAudit = require('./projectAudit');

const FIGURE_EDIT_FIELDS = new Set(['title', 'collection', 'tags', 'notes']);

// Figure metadata associated with a project, readable by members by role.
// SECURITY: a client may NOT supply file_path / storage key / raw path here, and
// the API never returns one — figure metadata is decoupled from any file-access
// surface (there is intentionally no figure download route in this branch).
// project_id comes from the route; the responsible actor from the session.
const REJECTED_FIGURE_PATH_FIELDS = [
  'filePath', 'file_path', 'storageKey', 'storage_key', 'storageUri', 'storage_uri',
  'internalStorageKey', 'internal_storage_key', 'path'
];

// Mounted at /api/projects/:projectId/figures after authentication and JSON
// body parsing.
function projectFigureRoutes({ db }) {
  const router = express.Router({ mergeParams: true });

  router.post('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Reject server-controlled id/owner/creator/project fields, the actor email, and
    // — critically — any client-supplied file path / storage key.
    if (rejectProjectResourceFields(req, res, { extra: ['userEmail', 'user_email', ...REJECTED_FIGURE_PATH_FIELDS] })) return;

    if (body.analysisObjectId !== undefined && body.analysisObjectId !== null && !isValidAnalysisObjectIdFormat(body.analysisObjectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    if (body.jobId !== undefined && body.jobId !== null && !isValidJobIdFormat(body.jobId)) {
      return res.status(400).json({ error: 'Malformed job ID.' });
    }
    if (body.provenanceId !== undefined && body.provenanceId !== null && !isValidProvenanceIdFormat(body.provenanceId)) {
      return res.status(400).json({ error: 'Malformed provenance ID.' });
    }
    if (body.datasetId !== undefined && body.datasetId !== null && !isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }

    try {
      const created = await db.createProjectFigure(req.user.id, req.params.projectId, {
        analysisObjectId: body.analysisObjectId,
        jobId: body.jobId,
        provenanceId: body.provenanceId,
        datasetId: body.datasetId,
        plotType: body.plotType,
        title: body.title,
        params: body.params,
        fileFormat: body.fileFormat,
        thumbnailB64: body.thumbnailB64,
        collection: body.collection,
        tags: body.tags,
        notes: body.notes
      });
      res.status(201).json(created);
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectFigures');
    }
  });

  router.get('/', async (req, res) => {
    const filters = {
      analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
      jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
      provenanceId: typeof req.query.provenanceId === 'string' ? req.query.provenanceId : undefined,
      datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
      plotType: typeof req.query.plotType === 'string' ? req.query.plotType : undefined
    };
    try {
      res.json(await db.listProjectFigures(req.user.id, req.params.projectId, filters));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectFigures');
    }
  });

  // Selection export: only the objects, jobs and recorded steps the selected
  // figures depend on, in dependency order, plus one R script. format=r
  // returns just the script.
  router.post('/bundles', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const bundle = await figureBundles.buildFigureBundle(req.user.id, req.params.projectId, {
        figureIds: body.figureIds, analysisObjectIds: body.analysisObjectIds,
      });
      await projectAudit.recordEvent(db, {
        projectId: req.params.projectId, actorUserId: req.user.id,
        action: 'figure.bundle_exported', targetType: 'project', targetId: req.params.projectId,
        details: {
          bundleVersion: bundle.version, figureCount: bundle.figures.length,
          stepCount: bundle.steps.length, scriptSha256: bundle.scriptSha256,
        },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      if (body.format === 'r' || req.query.format === 'r') {
        res.setHeader('Content-Type', 'text/x-r; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="figure-bundle.R"');
        return res.send(bundle.script);
      }
      res.json(bundle);
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectFigureBundles');
    }
  });

  router.patch('/:figureId', async (req, res) => {
    if (!isValidFigureIdFormat(req.params.figureId)) {
      return res.status(400).json({ error: 'Malformed figure ID.' });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const unknown = Object.keys(body).filter((key) => !FIGURE_EDIT_FIELDS.has(key));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Figures accept only ${[...FIGURE_EDIT_FIELDS].join(', ')} edits.` });
    }
    try {
      const updated = await db.updateProjectFigure(req.user.id, req.params.projectId, req.params.figureId, body);
      await projectAudit.recordEvent(db, {
        projectId: req.params.projectId, actorUserId: req.user.id,
        action: 'figure.updated', targetType: 'figure', targetId: updated.id, details: {},
      });
      res.json(updated);
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectFigures');
    }
  });

  router.delete('/:figureId', async (req, res) => {
    if (!isValidFigureIdFormat(req.params.figureId)) {
      return res.status(400).json({ error: 'Malformed figure ID.' });
    }
    try {
      await db.removeProjectFigure(req.user.id, req.params.projectId, req.params.figureId);
      await projectAudit.recordEvent(db, {
        projectId: req.params.projectId, actorUserId: req.user.id,
        action: 'figure.removed', targetType: 'figure', targetId: req.params.figureId, details: {},
      });
      res.status(204).end();
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectFigures');
    }
  });

  router.get('/:figureId', async (req, res) => {
    if (!isValidFigureIdFormat(req.params.figureId)) {
      return res.status(400).json({ error: 'Malformed figure ID.' });
    }
    try {
      const fig = await db.getProjectFigure(req.user.id, req.params.projectId, req.params.figureId);
      if (!fig) return res.status(404).json({ error: 'Figure not found.' });
      res.json(fig);
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectFigures');
    }
  });

  return router;
}

module.exports = { projectFigureRoutes };
