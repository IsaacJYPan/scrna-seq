'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');
const storage = require('./storage');
const { isValidDatasetIdFormat } = require('./resourceIds');
const { validateStoredDataset } = require('./datasetValidation');
const { cleanupUploadedFiles } = require('./uploadCleanup');

// Mounted at /api/projects/:projectId after authentication and JSON parsing.
function projectDatasetRoutes({ db, config, durableStorage, serverDataImports, uploadDir }) {
  const router = express.Router({ mergeParams: true });
  const UPLOAD_DIR = uploadDir;

  // Sanitize a server-generated id (proj_.../ds_...) into a single safe path
  // segment. The ids are already server-controlled and hex-suffixed, but we strip
  // anything non-alphanumeric/._- defensively before using them in a path.
  function sanitizeIdSegment(value) {
    const seg = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!seg || seg === '.' || seg === '..') throw new Error('Invalid storage id segment.');
    return seg;
  }

  // Store an uploaded dataset under a server-owned project key. The client never
  // controls the key or final path.
  function datasetStorageKey(originalname, projectId, datasetId) {
    const safeName = (db.sanitizeDatasetFilename(originalname) || 'upload.bin')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    return storage.projectStorageFileKey(sanitizeIdSegment(projectId), 'datasets', sanitizeIdSegment(datasetId), safeName);
  }

  // Moves an uploaded temporary file into project storage. A server-folder
  // source passes an open handle instead: its bytes are copied, never moved.
  async function storeDatasetFile(file, projectId, datasetId) {
    const key = datasetStorageKey(file.originalname, projectId, datasetId);
    const stored = file.handle
      ? await durableStorage.putFileFromHandle(file.handle, key, { maxBytes: file.maxBytes, expectedStat: file.expectedStat })
      : await durableStorage.putFileFromPath(file.path, key);
    return {
      internalStorageKey: stored.key,
      sha256: stored.checksumSha256,
      fileSizeBytes: stored.sizeBytes
    };
  }

  // Durable, project-scoped dataset records. Access is governed by the caller's
  // project role: owner/admin/analyst may create/register/update; any member
  // (incl. viewer) may list/read metadata. Identity and storage location are
  // server-controlled — clients may never supply an id, owner/creator/project
  // field, storage key/uri, sha256/size, or a raw filesystem path. A dataset in a
  // project the caller cannot access returns 404 (no existence leak); a known
  // member lacking the role returns 403. (`/api/projects` already has express.json
  // + requireAuth mounted above.) NOTE: there are intentionally no dataset
  // download routes in this branch.

  // Separate multer instance for dataset uploads so the dataset extension policy is
  // independent of the R-vault upload filter. The declared file_type (validated
  // against the DB allow-list) is the source of truth; the extension is a coarse
  // guard. tenx_zip arrives as .zip, hence its inclusion here.
  const datasetUpload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: config.maxUploadBytes() },
    fileFilter: (req, file, cb) => {
      const allowed = new Set(['.csv', '.tsv', '.txt', '.mtx', '.gz', '.h5', '.h5ad', '.h5seurat', '.rds', '.zip']);
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!allowed.has(ext)) return cb(new Error('Unsupported dataset file type'));
      cb(null, true);
    }
  });

  // Run multer only for multipart requests; JSON registration falls through to the
  // express.json-parsed body. Surfaces multer errors (e.g. size/type) as 400.
  function maybeDatasetMultipart(req, res, next) {
    if (String(req.headers['content-type'] || '').includes('multipart/form-data')) {
      return datasetUpload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        next();
      });
    }
    next();
  }

  function cleanupDatasetReqFile(req) {
    if (req.file) cleanupUploadedFiles([req.file]);
  }

  // Server-controlled fields a client may never set on dataset create/update,
  // including any field that would let the client choose the storage location.
  const REJECTED_DATASET_FIELDS = [
    'id', 'projectId', 'project_id', 'ownerUserId', 'owner_user_id',
    'createdByUserId', 'created_by_user_id', 'userId', 'user_id',
    'internalStorageKey', 'internal_storage_key', 'storageUri', 'storage_uri',
    'sha256', 'fileSizeBytes', 'file_size_bytes',
    'uploadStatus', 'upload_status', 'validationStatus', 'validation_status',
    'validationErrors', 'validation_errors',
    'path', 'filePath', 'file_path', 'storagePath', 'storage_path'
  ];

  function rejectDatasetServerFields(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    for (const field of REJECTED_DATASET_FIELDS) {
      if (body[field] !== undefined) {
        cleanupDatasetReqFile(req);
        res.status(400).json({ error: `Field '${field}' is not allowed; it is server-controlled.` });
        return true;
      }
    }
    return false;
  }

  // Coerce dataset metadata, which arrives as a string for multipart uploads or
  // a native object for JSON requests. Returns { ok:false } for invalid JSON.
  function coerceDatasetJsonField(value) {
    if (value === undefined) return { ok: true, value: undefined };
    if (typeof value === 'string') {
      if (value.trim() === '') return { ok: true, value: undefined };
      try { return { ok: true, value: JSON.parse(value) }; } catch { return { ok: false }; }
    }
    return { ok: true, value };
  }

  function sendDatasetError(res, e, context = 'Datasets') {
    switch (e.code) {
      case 'NOT_FOUND':
      case 'DATASET_NOT_FOUND':
        return res.status(404).json({ error: e.message });
      case 'FORBIDDEN':
        return res.status(403).json({ error: e.message });
      case 'INVALID_FILE_TYPE':
      case 'INVALID_UPLOAD_STATUS':
      case 'INVALID_VALIDATION_STATUS':
      case 'INVALID_VALIDATION_ERRORS':
      case 'INVALID_STATUS_COMBO':
      case 'INVALID_METADATA':
      case 'NO_FIELDS':
        return res.status(400).json({ error: e.message });
      default:
        console.error(`[${context}]`, e);
        return res.status(500).json({ error: 'Internal error.' });
    }
  }

  // Reject viewers/nonmembers before Multer consumes or stages their multipart
  // body. The database mutation re-checks the role after parsing to close a role-
  // change race; this early gate prevents unauthorized disk/CPU consumption.
  async function requireDatasetWriterBeforeUpload(req, res, next) {
    if (config.demoMode()) {
      return res.status(403).json({ error: 'Dataset uploads are disabled in the public demo.' });
    }
    try {
      await db.requireProjectRole(req.user.id, req.params.projectId, ['owner', 'admin', 'analyst']);
      return next();
    } catch (error) {
      return sendDatasetError(res, error);
    }
  }

  router.post('/datasets', requireDatasetWriterBeforeUpload, maybeDatasetMultipart, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (rejectDatasetServerFields(req, res)) return;

    const fileType = body.fileType !== undefined ? body.fileType : body.file_type;
    const meta = coerceDatasetJsonField(body.metadata);
    if (!meta.ok) { cleanupDatasetReqFile(req); return res.status(400).json({ error: 'metadata must be valid JSON.' }); }
    try {
      let dataset = await db.createDatasetForProject(req.user.id, req.params.projectId, {
        fileType,
        originalFilename: body.originalFilename !== undefined
          ? body.originalFilename
          : (req.file ? req.file.originalname : undefined),
        metadata: meta.value,
      });

      // If a file rode along, the server stores it under a server-chosen key and
      // records sha256 + size. A storage failure leaves the record `failed`, never
      // a misleading `uploaded`/`valid`.
      if (req.file) {
        let stored = null;
        try {
          stored = await storeDatasetFile(req.file, req.params.projectId, dataset.id);
          dataset = await db.markDatasetUploaded(req.params.projectId, dataset.id, stored);
          const validation = await validateStoredDataset(durableStorage, dataset);
          if (validation.validationStatus !== 'pending') {
            dataset = await db.setDatasetValidationResult(
              req.params.projectId,
              dataset.id,
              validation.validationStatus,
              validation.validationErrors
            );
          }
        } catch (storageErr) {
          console.error('[Datasets] Storage failed:', storageErr);
          if (stored && stored.internalStorageKey) {
            try { durableStorage.remove(stored.internalStorageKey); } catch { /* best effort */ }
          }
          await db.markDatasetUploadFailed(req.params.projectId, dataset.id);
          cleanupDatasetReqFile(req);
          return res.status(500).json({ error: 'Dataset file storage failed.' });
        }
      }
      res.status(201).json(db.toPublicDataset(dataset));
    } catch (e) {
      cleanupDatasetReqFile(req);
      sendDatasetError(res, e);
    }
  });

  // Adds a pipeline input file from a server folder this person was granted
  // (SERVER_DATA_IMPORT_ROOTS), for files too large or too remote to upload from
  // the browser. The bytes are copied into project storage like an upload.
  router.post('/datasets/from-server-folder', requireDatasetWriterBeforeUpload, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const fileType = body.fileType;
    const meta = coerceDatasetJsonField(body.metadata);
    if (!meta.ok) return res.status(400).json({ error: 'metadata must be valid JSON.' });
    let opened;
    try {
      opened = await serverDataImports.openForDataset(req.user.id, req.params.projectId, body.source);
    } catch (error) {
      const status = error?.status || 500;
      return res.status(status).json({ error: status < 500 ? error.message : 'The server folder is unavailable.', ...(status < 500 && error.code ? { code: error.code } : {}) });
    }
    let dataset;
    let stored = null;
    try {
      if (opened.sizeBytes > config.maxUploadBytes()) {
        return res.status(413).json({ error: 'That file is larger than this server accepts for input files.' });
      }
      dataset = await db.createDatasetForProject(req.user.id, req.params.projectId, { fileType, originalFilename: opened.name, metadata: meta.value });
      stored = await storeDatasetFile({ handle: opened.handle, expectedStat: opened.stat, maxBytes: config.maxUploadBytes(), originalname: opened.name }, req.params.projectId, dataset.id);
      await opened.revalidate?.();
      if (stored.fileSizeBytes !== opened.sizeBytes) throw Object.assign(new Error('changed'), { code: 'SERVER_IMPORT_SOURCE_CHANGED' });
      dataset = await db.markDatasetUploaded(req.params.projectId, dataset.id, stored);
      const validation = await validateStoredDataset(durableStorage, dataset);
      if (validation.validationStatus !== 'pending') {
        dataset = await db.setDatasetValidationResult(req.params.projectId, dataset.id, validation.validationStatus, validation.validationErrors);
      }
      return res.status(201).json(db.toPublicDataset(dataset));
    } catch (error) {
      if (stored?.internalStorageKey) { try { durableStorage.remove(stored.internalStorageKey); } catch { /* best effort */ } }
      if (dataset) await db.markDatasetUploadFailed(req.params.projectId, dataset.id).catch(() => {});
      if (error?.code === 'SERVER_IMPORT_SOURCE_CHANGED') return res.status(409).json({ error: 'The source file changed while it was copied. Refresh the folder and choose it again.' });
      if (!dataset) return sendDatasetError(res, error);
      console.error('[Datasets] Server folder copy failed:', error);
      return res.status(500).json({ error: 'Dataset file storage failed.' });
    } finally {
      await opened.close();
    }
  });

  router.get('/datasets', async (req, res) => {
    const filters = {};
    if (typeof req.query.fileType === 'string') filters.fileType = req.query.fileType;
    if (typeof req.query.uploadStatus === 'string') filters.uploadStatus = req.query.uploadStatus;
    if (typeof req.query.validationStatus === 'string') filters.validationStatus = req.query.validationStatus;
    try {
      const rows = await db.listDatasetsForProject(req.user.id, req.params.projectId, filters);
      res.json(rows.map(db.toPublicDataset));
    } catch (e) {
      sendDatasetError(res, e);
    }
  });

  router.get('/datasets/:datasetId', async (req, res) => {
    if (!isValidDatasetIdFormat(req.params.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
    try {
      const dataset = await db.getDatasetForProject(req.user.id, req.params.projectId, req.params.datasetId);
      if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });
      res.json(db.toPublicDataset(dataset));
    } catch (e) {
      sendDatasetError(res, e);
    }
  });

  router.patch('/datasets/:datasetId', async (req, res) => {
    if (!isValidDatasetIdFormat(req.params.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
    if (rejectDatasetServerFields(req, res)) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const updated = await db.updateDatasetForProject(req.user.id, req.params.projectId, req.params.datasetId, {
        uploadStatus: body.uploadStatus,
        validationStatus: body.validationStatus,
        validationErrors: body.validationErrors,
        metadata: body.metadata,
        originalFilename: body.originalFilename
      });
      res.json(db.toPublicDataset(updated));
    } catch (e) {
      sendDatasetError(res, e);
    }
  });

  return { router, requireDatasetWriterBeforeUpload };
}

module.exports = { projectDatasetRoutes };
