'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const { createArtifactVersionService } = require('./artifactVersions');

function artifactVersionRoutes({ db, provider, requireAuth, uploadDirectory } = {}) {
  const router = express.Router();
  const service = createArtifactVersionService(db, provider);
  const directory = uploadDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-artifacts-'));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const upload = multer({ dest: directory, limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 2, fieldSize: 1024 } });
  router.use(requireAuth, express.json({ limit: '16kb' }));

  const sendError = (res, error) => {
    const hidden = /NOT_FOUND/.test(error?.code || '');
    const forbidden = ['FORBIDDEN', 'PROJECT_ROLE_REQUIRED'].includes(error?.code);
    const status = error?.status || (hidden ? 404 : forbidden ? 403 : 500);
    const safe = status < 500 ? error.message : 'Artifact inspection is unavailable. Try again when storage is available.';
    res.status(status).json({ error: safe, ...(status < 500 && error.code ? { code: error.code } : {}) });
  };
  const route = callback => async (req, res) => {
    try { await callback(req, res); }
    catch (error) { if (!res.headersSent) sendError(res, error); else res.destroy(); }
  };
  router.get('/:projectId', route(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await service.list(req.user.id, req.params.projectId, req.query));
  }));
  router.get('/:projectId/:versionId', route(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await service.get(req.user.id, req.params.projectId, req.params.versionId));
  }));
  router.get('/:projectId/:versionId/preview', route(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await service.preview(req.user.id, req.params.projectId, req.params.versionId, req.query));
  }));
  router.get('/:projectId/:versionId/image', route(async (req, res) => {
    const version = await service.get(req.user.id, req.params.projectId, req.params.versionId);
    if (!version.previews.includes('image')) return res.status(404).json({ error: 'A bounded image preview is unavailable for this version.' });
    const opened = await service.resolveVerified(req.user.id, req.params.projectId, version.reference);
    try {
      res.setHeader('Content-Type', version.format.id === 'org.w3.png' ? 'image/png' : 'image/jpeg');
      res.setHeader('Content-Length', String(opened.stat.size));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      const stream = opened.handle.createReadStream({ start: 0, autoClose: true });
      res.once('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) { await opened.handle.close(); throw error; }
  }));

  async function writer(req, res, next) {
    try {
      if (config.demoMode() || req.user.isDemoGuest || req.user.is_demo_guest) return res.status(403).json({ error: 'Artifact imports are unavailable in the public demo.' });
      await db.requireProjectRole(req.user.id, req.params.projectId, ['owner', 'admin', 'analyst']);
      return next();
    } catch (error) { return sendError(res, error); }
  }
  const importFile = (req, res) => upload.single('file')(req, res, async uploadError => {
    try {
      if (uploadError) return res.status(uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: uploadError.message });
      if (!req.file) return res.status(400).json({ error: 'Select one artifact file.' });
      const unknown = Object.keys(req.body || {}).filter(key => !['name', 'artifactType'].includes(key));
      if (unknown.length) return res.status(400).json({ error: 'Artifact identity, ownership and storage are server-controlled.' });
      const version = await service.importFile(req.user.id, req.params.projectId, {
        path: req.file.path, originalFilename: req.file.originalname, name: req.body.name, artifactType: req.body.artifactType,
      }, req.params.versionId || null);
      res.status(201).json(version);
    } catch (error) { sendError(res, error); }
    finally { if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {}); }
  });
  router.post('/:projectId', writer, importFile);
  router.post('/:projectId/:versionId/versions', writer, importFile);
  return router;
}

module.exports = { artifactVersionRoutes };
