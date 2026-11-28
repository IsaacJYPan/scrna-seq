'use strict';

const express = require('express');
const analysisBranches = require('./analysisBranches');
const { isValidAnalysisObjectIdFormat, isValidBranchIdFormat, isValidReviewIdFormat } = require('./resourceIds');
const { rejectProjectResourceFields, sendProjectResourceError } = require('./projectResourceHttp');

// Mounted at /api/projects/:projectId after authentication and JSON body parsing.
function analysisBranchRoutes() {
  const router = express.Router({ mergeParams: true });

  // Named private work refs over immutable analysis-object/checkpoint history.
  // Branch identity, owner, visibility, review decisions, and canonical pointers
  // are server-controlled; publishing is explicit and canonical promotion requires
  // an owner/admin decision on an approved review of the exact current head.
  router.post('/branches', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (rejectProjectResourceFields(req, res, {
      extra: ['visibility', 'status', 'headAnalysisObjectId', 'head_analysis_object_id', 'version'],
    })) return;
    if (!isValidAnalysisObjectIdFormat(body.baseAnalysisObjectId)) {
      return res.status(400).json({ error: 'Malformed base analysis object ID.' });
    }
    try {
      res.status(201).json(await analysisBranches.createBranch(req.user.id, req.params.projectId, {
        name: body.name,
        description: body.description,
        baseAnalysisObjectId: body.baseAnalysisObjectId,
      }));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranches');
    }
  });

  router.get('/branches', async (req, res) => {
    try {
      res.json(await analysisBranches.listBranches(req.user.id, req.params.projectId));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranches');
    }
  });

  router.patch('/branches/:branchId/head', async (req, res) => {
    if (!isValidBranchIdFormat(req.params.branchId)) {
      return res.status(400).json({ error: 'Malformed branch ID.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (rejectProjectResourceFields(req, res, {
      extra: ['visibility', 'status', 'baseAnalysisObjectId', 'base_analysis_object_id'],
    })) return;
    if (!isValidAnalysisObjectIdFormat(body.headAnalysisObjectId)) {
      return res.status(400).json({ error: 'Malformed head analysis object ID.' });
    }
    try {
      res.json(await analysisBranches.advanceBranch(
        req.user.id, req.params.projectId, req.params.branchId,
        { headAnalysisObjectId: body.headAnalysisObjectId, expectedVersion: body.expectedVersion }
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranches');
    }
  });

  router.post('/branches/:branchId/publish', async (req, res) => {
    if (!isValidBranchIdFormat(req.params.branchId)) {
      return res.status(400).json({ error: 'Malformed branch ID.' });
    }
    if (rejectProjectResourceFields(req, res)) return;
    try {
      res.json(await analysisBranches.publishBranch(req.user.id, req.params.projectId, req.params.branchId));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranches');
    }
  });

  router.get('/branches/:branchId/events', async (req, res) => {
    if (!isValidBranchIdFormat(req.params.branchId)) {
      return res.status(400).json({ error: 'Malformed branch ID.' });
    }
    try {
      res.json(await analysisBranches.listBranchEvents(req.user.id, req.params.projectId, req.params.branchId));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranches');
    }
  });

  router.post('/branches/:branchId/reviews', async (req, res) => {
    if (!isValidBranchIdFormat(req.params.branchId)) {
      return res.status(400).json({ error: 'Malformed branch ID.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (rejectProjectResourceFields(req, res, {
      extra: ['branchId', 'branch_id', 'headAnalysisObjectId', 'head_analysis_object_id', 'status'],
    })) return;
    try {
      res.status(201).json(await analysisBranches.requestReview(
        req.user.id, req.params.projectId, req.params.branchId,
        { title: body.title, summary: body.summary }
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranchReviews');
    }
  });

  router.get('/reviews', async (req, res) => {
    if (req.query.branchId !== undefined && !isValidBranchIdFormat(req.query.branchId)) {
      return res.status(400).json({ error: 'Malformed branch ID.' });
    }
    try {
      res.json(await analysisBranches.listReviews(req.user.id, req.params.projectId, {
        branchId: req.query.branchId,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
      }));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranchReviews');
    }
  });

  router.get('/reviews/:reviewId/comments', async (req, res) => {
    if (!isValidReviewIdFormat(req.params.reviewId)) {
      return res.status(400).json({ error: 'Malformed review ID.' });
    }
    try {
      res.json(await analysisBranches.listReviewComments(
        req.user.id, req.params.projectId, req.params.reviewId
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranchReviewComments');
    }
  });

  router.post('/reviews/:reviewId/comments', async (req, res) => {
    if (!isValidReviewIdFormat(req.params.reviewId)) {
      return res.status(400).json({ error: 'Malformed review ID.' });
    }
    if (rejectProjectResourceFields(req, res, {
      extra: ['reviewId', 'review_id', 'authorUserId', 'author_user_id'],
    })) return;
    try {
      res.status(201).json(await analysisBranches.addReviewComment(
        req.user.id, req.params.projectId, req.params.reviewId,
        { body: req.body?.body }
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranchReviewComments');
    }
  });

  router.patch('/reviews/:reviewId/decision', async (req, res) => {
    if (!isValidReviewIdFormat(req.params.reviewId)) {
      return res.status(400).json({ error: 'Malformed review ID.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (rejectProjectResourceFields(req, res, {
      extra: ['branchId', 'branch_id', 'headAnalysisObjectId', 'head_analysis_object_id'],
    })) return;
    try {
      res.json(await analysisBranches.decideReview(
        req.user.id, req.params.projectId, req.params.reviewId,
        { status: body.status, note: body.note }
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranchReviews');
    }
  });

  router.post('/branches/:branchId/promote', async (req, res) => {
    if (!isValidBranchIdFormat(req.params.branchId)) {
      return res.status(400).json({ error: 'Malformed branch ID.' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (rejectProjectResourceFields(req, res, {
      extra: ['analysisObjectId', 'analysis_object_id', 'version'],
    })) return;
    if (!isValidReviewIdFormat(body.reviewId)) {
      return res.status(400).json({ error: 'Malformed review ID.' });
    }
    try {
      res.json(await analysisBranches.promoteBranch(
        req.user.id, req.params.projectId, req.params.branchId, { reviewId: body.reviewId }
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectCanonicalAnalysis');
    }
  });

  router.get('/canonical-analysis', async (req, res) => {
    try {
      const canonical = await analysisBranches.getCanonical(req.user.id, req.params.projectId);
      if (!canonical) return res.status(404).json({ error: 'Canonical analysis not found.' });
      res.json(canonical);
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectCanonicalAnalysis');
    }
  });

  router.get('/branch-comparison', async (req, res) => {
    if (!isValidBranchIdFormat(req.query.leftBranchId)
        || !isValidBranchIdFormat(req.query.rightBranchId)) {
      return res.status(400).json({ error: 'Two valid branch IDs are required.' });
    }
    try {
      res.json(await analysisBranches.compareBranches(
        req.user.id, req.params.projectId, req.query.leftBranchId, req.query.rightBranchId
      ));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectBranchComparison');
    }
  });

  return router;
}

module.exports = { analysisBranchRoutes };
