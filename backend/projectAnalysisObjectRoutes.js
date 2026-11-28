'use strict';

const express = require('express');
const { isValidAnalysisObjectIdFormat, isValidDatasetIdFormat } = require('./resourceIds');
const { rejectProjectResourceFields, sendProjectResourceError } = require('./projectResourceHttp');
const {
  REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS, rejectAnalysisObjectStorageFields,
} = require('./analysisObjectFields');

// Mounted at /api/projects/:projectId after authentication and JSON body parsing.
// Object ids, owners, lineage roots and storage are server-controlled.
function projectAnalysisObjectRoutes({ db }) {
  const router = express.Router({ mergeParams: true });

  router.post('/analysis-objects', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // lineageRootId is server-derived; reject any client-supplied value alongside
    // the id/owner/creator/project fields.
    if (rejectProjectResourceFields(req, res, {
      extra: ['lineageRootId', 'lineage_root_id', ...REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS]
    })) return;
    if (rejectAnalysisObjectStorageFields(body, res)) return;

    // Validate reference id shapes → 400 before touching the DB.
    if (body.parentObjectId !== undefined && body.parentObjectId !== null &&
        !isValidAnalysisObjectIdFormat(body.parentObjectId)) {
      return res.status(400).json({ error: 'Malformed parent object ID.' });
    }
    if (body.datasetId !== undefined && body.datasetId !== null &&
        !isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
    // created-by provenance is user-scoped: the caller must own it (404 otherwise),
    // exactly as the owner-scoped route enforces. Provenance has no project.
    if (body.createdByProvenanceId !== undefined && body.createdByProvenanceId !== null) {
      if (typeof body.createdByProvenanceId !== 'string' || !(await db.getProvenance(body.createdByProvenanceId, req.user.email))) {
        return res.status(404).json({ error: 'Provenance record not found.' });
      }
    }

    try {
      const created = await db.createProjectAnalysisObject(req.user.id, req.params.projectId, {
        datasetId: body.datasetId,
        parentObjectId: body.parentObjectId,
        objectType: body.objectType,
        displayName: body.displayName,
        metadata: body.metadata,
        createdByProvenanceId: body.createdByProvenanceId
      });
      res.status(201).json(db.toPublicAnalysisObject(created));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
    }
  });

  router.get('/analysis-objects', async (req, res) => {
    const filters = {
      datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
      parentObjectId: typeof req.query.parentObjectId === 'string' ? req.query.parentObjectId : undefined,
      lineageRootId: typeof req.query.lineageRootId === 'string' ? req.query.lineageRootId : undefined,
      objectType: typeof req.query.objectType === 'string' ? req.query.objectType : undefined
    };
    try {
      res.json((await db.listProjectAnalysisObjects(req.user.id, req.params.projectId, filters)).map(db.toPublicAnalysisObject));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
    }
  });

  router.get('/analysis-objects/:objectId', async (req, res) => {
    if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    try {
      const obj = await db.getProjectAnalysisObject(req.user.id, req.params.projectId, req.params.objectId);
      if (!obj) return res.status(404).json({ error: 'Analysis object not found.' });
      res.json(db.toPublicAnalysisObject(obj));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
    }
  });

  // Persist a small, safe DISPLAY summary (cells / features / density) for a project
  // analysis object so the Workspace/Data Info card keeps accurate counts after a
  // browser refresh (live R counts are transient and never persisted elsewhere). This
  // is project METADATA only: it does NOT touch R state, does NOT make live R state
  // project-shared, and does NOT weaken verifyRObjectOwnership. Server-controlled
  // identity fields and any storage/state/path field are rejected; only finite numeric
  // cells/features/density are read. project_id/object_id come from the route, never
  // the body. Non-member → 404, member lacking a write role → 403.
  router.patch('/analysis-objects/:objectId/summary', async (req, res) => {
    if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (rejectProjectResourceFields(req, res)) return;
    if (rejectAnalysisObjectStorageFields(body, res)) return;
    try {
      const updated = await db.updateProjectAnalysisObjectSummary(
        req.user.id, req.params.projectId, req.params.objectId,
        { cells: body.cells, features: body.features, density: body.density }
      );
      res.json(db.toPublicAnalysisObject(updated));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
    }
  });

  // ── Read-only analysis-object lineage (DAG) routes ───────────────────────────
  // Role-checked, metadata-only lineage reads for project members (any role, incl.
  // viewer, may read). The edge table is the graph source; single-parent
  // parent_object_id / lineage_root_id remain compatibility/fast-path fields. There
  // is intentionally NO public edge-create route in this branch (edges are created by
  // the checkpoint helper / future server-side multi-parent operations). Responses
  // are public-safe (edge/graph metadata only): no storage uri/path, R state key,
  // claim token, or worker internal is ever in the edge or node projections. A
  // malformed object id is 400; an object in another project (or legacy NULL-project)
  // is 404; a non-member is 404; a member lacking the read role is 403.
  router.get('/analysis-objects/:objectId/parents', async (req, res) => {
    if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    try {
      res.json(await db.listProjectAnalysisObjectParents(req.user.id, req.params.projectId, req.params.objectId));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectLineage');
    }
  });

  router.get('/analysis-objects/:objectId/children', async (req, res) => {
    if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    try {
      res.json(await db.listProjectAnalysisObjectChildren(req.user.id, req.params.projectId, req.params.objectId));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectLineage');
    }
  });

  router.get('/analysis-objects/:objectId/lineage', async (req, res) => {
    if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    try {
      res.json(await db.getProjectAnalysisObjectLineage(req.user.id, req.params.projectId, req.params.objectId));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectLineage');
    }
  });

  return router;
}

module.exports = { projectAnalysisObjectRoutes };
