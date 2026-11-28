'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const {
  expertRSandboxEnabled, EXPERT_R_PROFILE, MAX_EXPERT_R_INPUT_BYTES, EXPERT_R_INPUT_EXTENSIONS,
  maxExpertRInputBytesForFilename, generateExpertRInputId, sanitizeExpertRInputFilename,
  allocateExpertRInputStorageKey,
} = require('./expertR');
const { sendProjectResourceError } = require('./projectResourceHttp');
const { cleanupUploadedFiles } = require('./uploadCleanup');

// Mounted at /api/expert-r after authentication. Private R requires a
// provisioned isolated runtime and the configured account or project-role
// policy. Project access, explicit denial and object ownership are enforced
// again when a job is submitted and at worker claim time.
function expertRRoutes({ db, config, durableStorage, uploadDir }) {
  const router = express.Router();
  const UPLOAD_DIR = uploadDir;

  router.get('/capabilities', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const projectId = req.query.projectId;
      if (projectId !== undefined && (typeof projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{3,128}$/.test(projectId))) {
        return res.status(400).json({ error: 'Choose a valid project to check R access.' });
      }
      const { probeExpertRRuntime, expertRStatus } = require('./expertRAccess');
      const { effectivePrivateRArtifactPolicy } = require('./privateRArtifactPolicy');
      const runtime = config.demoMode() ? { state: 'not-configured' } : await probeExpertRRuntime();
      const { canExecuteExpertR, expertRAccessRevoked } = await db.getExpertRCapabilities(req.user.id, projectId || null);
      const enabled = !config.demoMode() && runtime.state === 'ready' && canExecuteExpertR;
      res.json({
        expertREnabled: enabled,
        expertRProfile: enabled ? EXPERT_R_PROFILE : null,
        expertREnvironment: enabled ? runtime.environment || null : null,
        persistentKernel: enabled && runtime.persistentKernel === true,
        persistentKernelInterrupt: enabled && runtime.persistentKernelInterrupt === true,
        persistentKernelPublications: enabled && runtime.persistentKernelPublications === true,
        persistentKernelStreamedPublications: enabled && runtime.persistentKernelStreamedPublications === true,
        expertRArtifactPolicy: enabled ? effectivePrivateRArtifactPolicy(runtime) : null,
        expertRStatus: expertRStatus({ canExecuteExpertR, runtime,
          revoked: expertRAccessRevoked, demoMode: config.demoMode() }),
      });
    } catch (error) {
      console.error('[ExpertRCapabilities]', error);
      res.status(500).json({ error: 'Expert R access is temporarily unavailable.' });
    }
  });

  router.get('/environment', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const projectId = req.query.projectId;
    if (typeof projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{3,128}$/.test(projectId)) {
      return res.status(400).json({ error: 'Choose a valid project to inspect its R environment.' });
    }
    try {
      await db.requireProjectRole(req.user.id, projectId, ['owner', 'admin', 'analyst']);
      const capabilities = await db.getExpertRCapabilities(req.user.id, projectId);
      if (config.demoMode() || !capabilities.canExecuteExpertR) return res.status(403).json({ error: 'R environment access is not available for this project.' });
      const { getExpertREnvironment } = require('./expertSandboxClient');
      res.json(await getExpertREnvironment());
    } catch (error) {
      if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Project not found.' });
      if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Your project role cannot inspect the R environment.' });
      res.status(503).json({ error: 'The exact R environment is unavailable. Check the private runtime and retry.' });
    }
  });

  const expertRInputUpload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: MAX_EXPERT_R_INPUT_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!EXPERT_R_INPUT_EXTENSIONS.has(ext)) {
        return cb(new Error('Expert R inputs must be CSV, TSV, TXT, JSON, or RDS files.'));
      }
      cb(null, true);
    },
  });

  async function requireExpertRInputWriter(req, res, next) {
    if (!expertRSandboxEnabled()) {
      return res.status(403).json({ error: 'Expert R is not available for this deployment.' });
    }
    try {
      await db.requireProjectRole(req.user.id, req.params.projectId, ['owner', 'admin', 'analyst']);
      if (!(await db.hasExpertRExecuteCapability(req.user.id, req.params.projectId))) {
        return res.status(403).json({ error: 'Expert R access is not approved for this account.' });
      }
      return next();
    } catch (error) {
      return sendProjectResourceError(res, error, 'ExpertRInputs');
    }
  }

  function sendExpertRInputError(res, error) {
    if (['NOT_FOUND', 'EXPERT_R_INPUT_NOT_FOUND'].includes(error?.code)) {
      return res.status(404).json({ error: error.message });
    }
    if (error?.code === 'FORBIDDEN') return res.status(403).json({ error: error.message });
    if (['INVALID_EXPERT_R_INPUT', 'EXPERT_R_INPUT_QUOTA'].includes(error?.code)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('[ExpertRInputs]', error);
    return res.status(500).json({ error: 'Private input import failed.' });
  }

  router.get('/projects/:projectId/inputs', requireExpertRInputWriter, async (req, res) => {
    try {
      res.json(await db.listExpertRPrivateInputs(req.user.id, req.params.projectId));
    } catch (error) {
      sendExpertRInputError(res, error);
    }
  });

  router.post('/projects/:projectId/inputs', requireExpertRInputWriter, (req, res) => {
    expertRInputUpload.single('file')(req, res, async (uploadError) => {
      if (uploadError) return res.status(400).json({ error: uploadError.message });
      if (!req.file) return res.status(400).json({ error: 'Select one private input file.' });
      let stored = null;
      try {
        const id = generateExpertRInputId();
        const originalFilename = sanitizeExpertRInputFilename(req.file.originalname);
        if (req.file.size > maxExpertRInputBytesForFilename(originalFilename)) {
          const limitMiB = Math.floor(maxExpertRInputBytesForFilename(originalFilename) / (1024 * 1024));
          const error = new Error(`This Expert R input exceeds the ${limitMiB} MiB file limit.`);
          error.code = 'INVALID_EXPERT_R_INPUT';
          throw error;
        }
        const internalStorageKey = allocateExpertRInputStorageKey(
          req.params.projectId, id, originalFilename
        );
        stored = await durableStorage.putFileFromPath(req.file.path, internalStorageKey);
        const created = await db.createExpertRPrivateInput(req.user.id, req.params.projectId, {
          id,
          originalFilename,
          internalStorageKey,
          mimeType: req.file.mimetype || 'application/octet-stream',
          sizeBytes: stored.sizeBytes,
          checksumSha256: stored.checksumSha256,
        });
        res.status(201).json(created);
      } catch (error) {
        if (stored?.key) {
          try { await durableStorage.remove(stored.key); } catch { /* original error wins */ }
        }
        sendExpertRInputError(res, error);
      } finally {
        cleanupUploadedFiles([req.file]);
      }
    });
  });

  return router;
}

module.exports = { expertRRoutes };
