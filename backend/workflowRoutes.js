'use strict';

const express = require('express');
const { createWorkflowRuntime } = require('./workflowRuntime');

function workflowRoutes({ db, provider, requireAuth }) {
  const router = express.Router();
  const runtime = createWorkflowRuntime(db, provider);
  let lastCleanup = 0;
  router.use(requireAuth, express.json({ limit: '2mb' }));
  router.use((req, res, next) => {
    if (Date.now() - lastCleanup > 60 * 60 * 1000) {
      lastCleanup = Date.now();
      runtime.expire().catch(() => { lastCleanup = 0; });
    }
    next();
  });
  const route = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const status = error.status || (['FORBIDDEN', 'PROJECT_ROLE_REQUIRED'].includes(error.code) ? 403 : /NOT_FOUND/.test(error.code || '') ? 404 : 400);
      const message = error.code && !['FORBIDDEN', 'PROJECT_ROLE_REQUIRED'].includes(error.code) ? 'The workflow request could not be completed.' : error.message;
      res.status(status).json({ error: message });
    }
  };
  router.post('/:projectId/open', route(async (req, res) => res.json(await runtime.open(req.user.id, req.params.projectId, req.body.analysisObjectId, req.body.source))));
  router.get('/:projectId/snapshots', route(async (req, res) => res.json(await runtime.snapshots(req.user.id, req.params.projectId))));
  router.post('/:projectId/snapshots/:snapshotId/open', route(async (req, res) => res.json(await runtime.restore(req.user.id, req.params.projectId, req.params.snapshotId))));
  router.delete('/:projectId/snapshots/:snapshotId', route(async (req, res) => { await runtime.removeSnapshot(req.user.id, req.params.projectId, req.params.snapshotId); res.json({ ok: true }); }));
  router.get('/:projectId/instances/:instanceId', route(async (req, res) => res.json(await runtime.get(req.user.id, req.params.projectId, req.params.instanceId))));
  router.post('/:projectId/instances/:instanceId/run', route(async (req, res) => res.json(await runtime.run(req.user.id, req.params.projectId, req.params.instanceId, req.body))));
  router.post('/:projectId/instances/:instanceId/cancel', route(async (req, res) => res.json(await runtime.cancel(req.user.id, req.params.projectId, req.params.instanceId))));
  router.post('/:projectId/instances/:instanceId/save', route(async (req, res) => res.json(await runtime.save(req.user.id, req.params.projectId, req.params.instanceId, req.body.name))));
  router.delete('/:projectId/instances/:instanceId', route(async (req, res) => { await runtime.close(req.user.id, req.params.projectId, req.params.instanceId); res.json({ ok: true }); }));
  router.get('/:projectId/artifacts/:artifactId', route(async (req, res) => {
    const artifact = await runtime.artifact(req.user.id, req.params.projectId, req.params.artifactId);
    const descriptor = artifact.descriptor_json;
    const opened = await provider.openVerifiedRead(artifact.storage_key, { sizeBytes: descriptor.sizeBytes, checksumSha256: descriptor.sha256 });
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(descriptor.type === 'figure' ? 'image/png' : descriptor.type === 'rds' ? 'application/octet-stream' : 'application/json');
    if (descriptor.type === 'rds' || req.query.download === '1') res.attachment(`result.${descriptor.type === 'figure' ? 'png' : descriptor.type === 'rds' ? 'rds' : 'json'}`);
    const stream = opened.handle.createReadStream({ autoClose: true });
    res.once('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }));
  return router;
}

module.exports = { workflowRoutes };
