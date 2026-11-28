'use strict';

const express = require('express');
const experimentalDesign = require('./experimentalDesign');
const { isValidAnalysisObjectIdFormat, isValidConditionIdFormat, isValidDatasetIdFormat, isValidSampleIdFormat } = require('./resourceIds');
const { rejectProjectResourceFields, sendProjectResourceError } = require('./projectResourceHttp');

// Mounted at /api/projects/:projectId after authentication and JSON body parsing.
function experimentalDesignRoutes() {
  const router = express.Router({ mergeParams: true });

  // Explicit, project-scoped study design. These routes register metadata and
  // immutable contrast snapshots only; they never accept R code, state keys,
  // ownership fields, or an inferential result from the client.
  router.post('/conditions', async (req, res) => {
    if (rejectProjectResourceFields(req, res)) return;
    try {
      res.status(201).json(await experimentalDesign.createCondition(
        req.user.id, req.params.projectId, req.body || {}
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectConditions');
    }
  });

  router.get('/conditions', async (req, res) => {
    try {
      res.json(await experimentalDesign.listConditions(req.user.id, req.params.projectId));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectConditions');
    }
  });

  router.post('/samples', async (req, res) => {
    if (rejectProjectResourceFields(req, res, {
      extra: ['conditionName', 'condition_name', 'createdAt', 'created_at'],
    })) return;
    const body = req.body || {};
    if (!isValidConditionIdFormat(body.conditionId)) {
      return res.status(400).json({ error: 'Malformed condition ID.' });
    }
    if (body.datasetId != null && !isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
    try {
      res.status(201).json(await experimentalDesign.createSample(
        req.user.id, req.params.projectId, body
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectSamples');
    }
  });

  router.get('/samples', async (req, res) => {
    try {
      res.json(await experimentalDesign.listSamples(req.user.id, req.params.projectId));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectSamples');
    }
  });

  router.post('/analysis-objects/:objectId/sample-bindings', async (req, res) => {
    if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    if (rejectProjectResourceFields(req, res, {
      extra: ['analysisObjectId', 'analysis_object_id', 'conditionId', 'condition_id'],
    })) return;
    if (!isValidSampleIdFormat(req.body?.sampleId)) {
      return res.status(400).json({ error: 'Malformed sample ID.' });
    }
    try {
      res.status(201).json(await experimentalDesign.bindSample(
        req.user.id, req.params.projectId, req.params.objectId, req.body || {}
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectSampleBindings');
    }
  });

  router.get('/analysis-objects/:objectId/sample-bindings', async (req, res) => {
    if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    try {
      res.json(await experimentalDesign.listBindings(
        req.user.id, req.params.projectId, req.params.objectId
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectSampleBindings');
    }
  });

  router.post('/contrasts', async (req, res) => {
    if (rejectProjectResourceFields(req, res, {
      extra: ['status', 'validation', 'validationJson', 'validation_json'],
    })) return;
    const body = req.body || {};
    if (!isValidAnalysisObjectIdFormat(body.analysisObjectId)
        || !isValidConditionIdFormat(body.numeratorConditionId)
        || !isValidConditionIdFormat(body.denominatorConditionId)) {
      return res.status(400).json({ error: 'Malformed analysis object or condition ID.' });
    }
    try {
      res.status(201).json(await experimentalDesign.createContrast(
        req.user.id, req.params.projectId, body
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectContrasts');
    }
  });

  router.get('/contrasts', async (req, res) => {
    try {
      res.json(await experimentalDesign.listContrasts(req.user.id, req.params.projectId));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectContrasts');
    }
  });

  return router;
}

module.exports = { experimentalDesignRoutes };
