'use strict';

const express = require('express');
const config = require('./config');
const { validateSeuratPipelineParams } = require('./seuratPipeline');
const { validateMultiSampleSeuratParams } = require('./multiSampleSeuratPipeline');
const { validateSpatialSeuratParams } = require('./spatialPipeline');
const { validateEnrichmentGseaParams } = require('./enrichmentGsea');
const { validateCellChatInferenceParams } = require('./cellChatInference');
const { validateExploratoryAnalysisParams } = require('./exploratoryAnalysis');
const { DEMO_JOB_TYPES } = require('./demoExperiencePolicy');
const { isValidAnalysisObjectIdFormat, isValidDatasetIdFormat, isValidJobIdFormat } = require('./resourceIds');
const { rejectProjectResourceFields, sendProjectResourceError } = require('./projectResourceHttp');

// Mounted at /api/projects/:projectId after authentication and JSON body
// parsing. Status, owners and storage are server-managed; a submission is
// idempotent by its client request id.
function projectJobRoutes({ db, guidedDemoMode }) {
  const router = express.Router({ mergeParams: true });

  router.post('/jobs', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Status is server-managed; a client cannot pick the initial status.
    if (body.status !== undefined) {
      return res.status(400).json({ error: 'Job status is server-managed and must not be provided.' });
    }
    if (body.retryOfJobId !== undefined || body.retry_of_job_id !== undefined) {
      return res.status(400).json({ error: 'Job retry linkage is server-managed and must not be provided.' });
    }
    if (rejectProjectResourceFields(req, res)) return;

    // A repeated accepted request is a read of the original submission, even
    // after its inputs or runtime have changed. It never dispatches another run.
    let submissionHash = null;
    if (body.requestId !== undefined) {
      try {
        const existing = await db.resolveProjectJobSubmission(req.user.id, req.params.projectId, body);
        if (existing) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json(db.toPublicJob(existing)); }
        submissionHash = require('./submissionIdentity').projectSubmissionHash(body);
      } catch (error) { return sendProjectResourceError(res, error, 'ProjectJobSubmission'); }
    }

    if (body.analysisObjectId !== undefined && body.analysisObjectId !== null &&
        !isValidAnalysisObjectIdFormat(body.analysisObjectId)) {
      return res.status(400).json({ error: 'Malformed analysis object ID.' });
    }
    if (body.resultAnalysisObjectId !== undefined && body.resultAnalysisObjectId !== null &&
        !isValidAnalysisObjectIdFormat(body.resultAnalysisObjectId)) {
      return res.status(400).json({ error: 'Malformed result analysis object ID.' });
    }
    if (body.datasetId !== undefined && body.datasetId !== null &&
        !isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }

    // Receipt-backed handlers bind their exact source and output shape before R
    // contact. Reject incompatible client references synchronously so they cannot
    // manufacture partial-output/recovery states after dispatch.
    const serverManagedResultTypes = [
      'pbmc.pipeline.v1', 'seurat.pipeline.v1', 'seurat.multisample.v1', 'deg.find_markers.v1', 'enrichment.gsea.v1',
      'cellchat.infer.v1', 'explore.summarize.v1',
      'condition.pseudobulk_de.v1', 'expert.r.v1',
      'spatial.seurat.v1',
      'checkpoint.save.v1', 'checkpoint.load.v1', 'checkpoint.fork.v1',
    ];
    const noDatasetBindingTypes = [
      'pbmc.pipeline.v1', 'deg.find_markers.v1', 'enrichment.gsea.v1', 'cellchat.infer.v1',
      'explore.summarize.v1',
      'condition.pseudobulk_de.v1', 'expert.r.v1',
      'checkpoint.save.v1', 'checkpoint.load.v1', 'checkpoint.fork.v1',
    ];
    if (serverManagedResultTypes.includes(body.jobType)
        && body.resultAnalysisObjectId !== undefined) {
      return res.status(400).json({
        error: `${body.jobType} result analysis object is server-managed and must not be provided.`,
      });
    }
    if (noDatasetBindingTypes.includes(body.jobType) && body.datasetId !== undefined) {
      return res.status(400).json({
        error: `${body.jobType} dataset is derived from its source analysis object and must not be provided.`,
      });
    }
    if (serverManagedResultTypes.includes(body.jobType)
        && (body.analysisObjectId === undefined || body.analysisObjectId === null)) {
      return res.status(400).json({
        error: `${body.jobType} requires a source analysisObjectId.`,
      });
    }

    // Durable dataset-backed Seurat pipeline has a strict server-side parameter
    // allowlist. Reject unknown/bad params at job creation, before any worker claim
    // or R contact can happen.
    if (body.jobType === 'seurat.pipeline.v1') {
      try {
        validateSeuratPipelineParams(body.parameters);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Invalid seurat.pipeline.v1 parameters.' });
      }
      if (body.datasetId === undefined || body.datasetId === null) {
        return res.status(400).json({ error: 'seurat.pipeline.v1 requires datasetId.' });
      }
    }
    if (body.jobType === 'seurat.multisample.v1') {
      let validated;
      try {
        validated = validateMultiSampleSeuratParams(body.parameters);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Invalid seurat.multisample.v1 parameters.' });
      }
      if (body.datasetId === undefined || body.datasetId === null) {
        return res.status(400).json({ error: 'seurat.multisample.v1 requires a primary datasetId.' });
      }
      if (validated.samples[0].datasetId !== body.datasetId) {
        return res.status(400).json({ error: 'Primary datasetId must match the first multi-sample input.' });
      }
    }
    if (body.jobType === 'spatial.seurat.v1') {
      try {
        validateSpatialSeuratParams(body.parameters);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Invalid spatial.seurat.v1 parameters.' });
      }
      if (body.datasetId === undefined || body.datasetId === null) {
        return res.status(400).json({ error: 'spatial.seurat.v1 requires datasetId.' });
      }
    }

    if (body.jobType === 'enrichment.gsea.v1') {
      try {
        validateEnrichmentGseaParams(body.parameters);
      } catch (e) {
        return res.status(400).json({
          error: e && e.message ? e.message : 'Invalid enrichment.gsea.v1 parameters.',
        });
      }
    }
    if (body.jobType === 'cellchat.infer.v1') {
      try {
        validateCellChatInferenceParams(body.parameters);
      } catch (e) {
        return res.status(400).json({
          error: e && e.message ? e.message : 'Invalid cellchat.infer.v1 parameters.',
        });
      }
    }
    if (body.jobType === 'explore.summarize.v1') {
      try {
        validateExploratoryAnalysisParams(body.parameters);
      } catch (e) {
        return res.status(400).json({
          error: e && e.message ? e.message : 'Invalid explore.summarize.v1 parameters.',
        });
      }
    }

    if (config.demoMode()) {
      if (!req.user.isDemoGuest) {
        return res.status(403).json({ error: 'Only an active demo guest may launch demo compute.' });
      }
      if (guidedDemoMode() && !DEMO_JOB_TYPES.includes(body.jobType)) {
        return res.status(403).json({ error: 'This capability is disabled for the demo. Try the standard Seurat workflow.' });
      }
      if (body.jobType === 'expert.r.v1') {
        return res.status(403).json({ error: 'Expert R is disabled in the public demo.' });
      }
      const heavyTypes = [
        'pbmc.pipeline.v1', 'seurat.pipeline.v1', 'seurat.multisample.v1', 'deg.find_markers.v1',
        'enrichment.gsea.v1', 'cellchat.infer.v1', 'explore.summarize.v1',
        'condition.pseudobulk_de.v1',
        'spatial.seurat.v1',
      ];
      if (heavyTypes.includes(body.jobType) && body.requestId === undefined) {
        const { rows } = await db.query(
          `SELECT
             COUNT(*) FILTER (WHERE owner_user_id = $1)::int AS guest_active,
             COUNT(*)::int AS global_active
           FROM jobs job JOIN users owner ON owner.id = job.owner_user_id
          WHERE owner.is_demo_guest = TRUE AND job.status IN ('queued', 'running')
            AND job.job_type = ANY($2::text[])`,
          [Number(req.user.id), heavyTypes]
        );
        if (Number(rows[0]?.guest_active) >= 1 || Number(rows[0]?.global_active) >= config.demoMaxGlobalHeavyJobs()) {
          res.setHeader('Retry-After', '10');
          return res.status(429).json({
            error: Number(rows[0]?.guest_active) >= 1
              ? 'This demo session already has an active compute job.'
              : 'The public demo compute pool is currently full.',
          });
        }
      }
    }

    try {
      let jobParameters = body.parameters;
      if (body.jobType === 'expert.r.v1') {
        await db.requireProjectRole(req.user.id, req.params.projectId, ['owner', 'admin', 'analyst']);
        const access = await db.getExpertRCapabilities(req.user.id, req.params.projectId);
        if (!access.canExecuteExpertR) return res.status(403).json({ error: 'Expert R access is not enabled for this account and project.' });
        if (!require('./expertR').expertRSandboxEnabled()) return res.status(403).json({ error: 'Expert R is disabled for this installation.' });
        let validated;
        try { validated = require('./expertR').validateExpertRParams(body.parameters).params; }
        catch { return res.status(400).json({ error: 'Expert R parameters are invalid. Check the script, input references and environment.' }); }
        try {
          const manifest = await require('./expertSandboxClient').getExpertREnvironment();
          jobParameters = require('./rEnvironment').pinExpertREnvironment(validated, manifest);
        } catch (error) {
          const mismatch = error.code === 'R_ENVIRONMENT_MISMATCH' || error.code === 'R_ENVIRONMENT_INVALID';
          return res.status(mismatch ? 409 : 503).json({ error: mismatch
            ? 'The selected exact R environment is unavailable. Refresh its recorded environment before submitting.'
            : 'The exact R environment could not be verified. Check the private runtime and retry.' });
        }
      }
      const created = await db.createProjectJob(req.user.id, req.params.projectId, {
        analysisObjectId: body.analysisObjectId,
        resultAnalysisObjectId: body.resultAnalysisObjectId,
        datasetId: body.datasetId,
        jobType: body.jobType,
        parameters: jobParameters,
        ...(body.executionTarget === undefined ? {} : { executionTarget: body.executionTarget }),
        ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
      }, submissionHash);
      res.setHeader('Cache-Control', 'no-store');
      res.status(created.submissionCreated === false ? 200 : 201).json(db.toPublicJob(created));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectJobs');
    }
  });

  router.get('/job-submissions/:requestId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const receipt = await db.getProjectJobSubmission(req.user.id, req.params.projectId, req.params.requestId);
      if (!receipt) return res.status(404).json({ error: 'Submission receipt not found.' });
      res.json(receipt);
    } catch (error) { sendProjectResourceError(res, error, 'ProjectJobSubmission'); }
  });

  router.get('/jobs', async (req, res) => {
    const filters = {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      jobType: typeof req.query.jobType === 'string' ? req.query.jobType : undefined,
      analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
      resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined,
      datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined
    };
    try {
      res.json((await db.listProjectJobs(req.user.id, req.params.projectId, filters)).map(db.toPublicJob));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectJobs');
    }
  });

  router.get('/jobs/:jobId', async (req, res) => {
    if (!isValidJobIdFormat(req.params.jobId)) {
      return res.status(400).json({ error: 'Malformed job ID.' });
    }
    try {
      const job = await db.getProjectJob(req.user.id, req.params.projectId, req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found.' });
      res.json(db.toPublicJob(job));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectJobs');
    }
  });

  router.get('/jobs/:jobId/logs', async (req, res) => {
    if (!isValidJobIdFormat(req.params.jobId)) {
      return res.status(400).json({ error: 'Malformed job ID.' });
    }
    try {
      const job = await db.getProjectJob(req.user.id, req.params.projectId, req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found.' });
      const publicJob = db.toPublicJob(job);
      res.json({ id: publicJob.id, status: publicJob.status, logs: publicJob.logs, error: publicJob.error });
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectJobs');
    }
  });

  router.post('/jobs/:jobId/retry', async (req, res) => {
    if (!isValidJobIdFormat(req.params.jobId)) {
      return res.status(400).json({ error: 'Malformed job ID.' });
    }
    const bodyIsEmptyObject = req.body === undefined || (
      req.body !== null
        && typeof req.body === 'object'
        && !Array.isArray(req.body)
        && Object.keys(req.body).length === 0
    );
    if (!bodyIsEmptyObject) {
      return res.status(400).json({
        error: 'Retry uses the recorded run inputs and does not accept request fields.',
      });
    }
    try {
      const result = await db.retryProjectJob(req.user.id, req.params.projectId, req.params.jobId);
      res.status(result.created ? 201 : 200).json(db.toPublicJob(result.job));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectJobRetry');
    }
  });

  router.post('/jobs/:jobId/cancel', async (req, res) => {
    if (!isValidJobIdFormat(req.params.jobId)) {
      return res.status(400).json({ error: 'Malformed job ID.' });
    }
    try {
      const job = await db.cancelProjectJob(req.user.id, req.params.projectId, req.params.jobId);
      res.json(db.toPublicJob(job));
    } catch (e) {
      sendProjectResourceError(res, e, 'ProjectJobs');
    }
  });

  return router;
}

module.exports = { projectJobRoutes };
