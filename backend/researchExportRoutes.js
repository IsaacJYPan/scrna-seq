'use strict';

const express = require('express');
const researchExports = require('./researchExports');
const projectAudit = require('./projectAudit');
const methodsText = require('./methodsText');
const { methodByKey: trustedMethodByKey } = require('./workflowTrust/trustedMethods');
const { isValidArtifactIdFormat } = require('./resourceIds');
const { sendProjectResourceError } = require('./projectResourceHttp');

// Mounted at /api/projects/:projectId after authentication. Every export is
// recorded in the project audit log; no response exposes a storage key or path.
function researchExportRoutes({ db, durableStorage }) {
  const router = express.Router({ mergeParams: true });

  // Explicit authenticated export surfaces. Internal storage keys are resolved
  // only after project membership, artifact allowlist, private-work visibility,
  // size, and checksum checks. Neither response exposes a server path/key.
  router.get('/artifacts/:artifactId/download', async (req, res) => {
    if (!isValidArtifactIdFormat(req.params.artifactId)) {
      return res.status(400).json({ error: 'Malformed artifact ID.' });
    }
    let opened;
    try {
      const download = await researchExports.authorizeArtifactDownload(
        req.user.id, req.params.projectId, req.params.artifactId
      );
      opened = await durableStorage.openVerifiedRead(download.artifact.storageUri, {
        checksumSha256: download.artifact.checksumSha256,
        sizeBytes: download.artifact.sizeBytes,
      });
      await projectAudit.recordEvent(db, {
        projectId: req.params.projectId, actorUserId: req.user.id,
        action: 'artifact.downloaded', targetType: 'artifact', targetId: download.artifact.id,
        details: { artifactType: download.artifact.artifactType },
      });
      res.setHeader('Content-Type', download.mimeType);
      res.setHeader('Content-Length', String(opened.stat.size));
      res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      const stream = opened.handle.createReadStream({ autoClose: true });
      opened = null;
      stream.on('error', (error) => {
        console.error('[ProjectArtifactDownload]', error);
        if (!res.headersSent) res.status(500).json({ error: 'Artifact download failed.' });
        else res.destroy(error);
      });
      stream.pipe(res);
    } catch (error) {
      if (opened?.handle) await opened.handle.close();
      sendProjectResourceError(res, error, 'ProjectArtifactDownload');
    }
  });

  router.get('/reproducibility-manifest', async (req, res) => {
    try {
      const manifest = await researchExports.buildReproducibilityManifest(
        req.user.id,
        req.params.projectId,
        {
          branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
          analysisObjectId: typeof req.query.analysisObjectId === 'string'
            ? req.query.analysisObjectId : undefined,
        }
      );
      await projectAudit.recordEvent(db, {
        projectId: req.params.projectId, actorUserId: req.user.id,
        action: 'reproducibility.exported', targetType: 'analysis_object',
        targetId: manifest.exportedAnalysisObjectId,
        details: { manifestVersion: manifest.version },
      });
      res.setHeader('Content-Disposition',
        `attachment; filename="reproducibility-${manifest.exportedAnalysisObjectId}.json"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(manifest);
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectReproducibilityManifest');
    }
  });

  router.get('/methods-text', async (req, res) => {
    try {
      const manifest = await researchExports.buildReproducibilityManifest(
        req.user.id,
        req.params.projectId,
        {
          branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
          analysisObjectId: typeof req.query.analysisObjectId === 'string'
            ? req.query.analysisObjectId : undefined,
        }
      );
      const text = methodsText.renderMethodsText(manifest, { lookupMethod: trustedMethodByKey });
      await projectAudit.recordEvent(db, {
        projectId: req.params.projectId, actorUserId: req.user.id,
        action: 'methods.exported', targetType: 'analysis_object',
        targetId: manifest.exportedAnalysisObjectId,
        details: { manifestVersion: manifest.version, methodsVersion: methodsText.METHODS_TEXT_VERSION },
      });
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="methods-${manifest.exportedAnalysisObjectId}.md"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(text);
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectMethodsText');
    }
  });

  router.get('/audit-events', async (req, res) => {
    try {
      res.json(await projectAudit.listEvents(req.user.id, req.params.projectId, {
        limit: req.query.limit,
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
      }));
    } catch (error) {
      sendProjectResourceError(res, error, 'ProjectAudit');
    }
  });

  return router;
}

module.exports = { researchExportRoutes };
