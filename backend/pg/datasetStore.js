'use strict';

// Project-scoped dataset records: creation, listing, metadata updates and the
// upload and validation status transitions recorded after storage.
function createDatasetStore({
  query, codedError, genId, parseJson, assertPlainObject, requireProjectRole, verifyProjectMember,
  sanitizeDatasetFilename, assertDatasetStatusCombo, normalizeValidationErrors,
  isValidDatasetUploadStatus, isValidDatasetValidationStatus,
  ALLOWED_DATASET_FILE_TYPES, DATASET_UPLOAD_STATUSES, DATASET_VALIDATION_STATUSES,
  DATASET_READ_ROLES, DATASET_WRITE_ROLES,
}) {
  function rowToDataset(row) {
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      ownerUserId: Number(row.owner_user_id),
      createdByUserId: Number(row.created_by_user_id),
      originalFilename: row.original_filename,
      internalStorageKey: row.internal_storage_key,
      storageUri: row.storage_uri,
      fileType: row.file_type,
      fileSizeBytes: row.file_size_bytes == null ? null : Number(row.file_size_bytes),
      sha256: row.sha256,
      uploadStatus: row.upload_status,
      validationStatus: row.validation_status,
      validationErrors: row.validation_errors ? JSON.parse(row.validation_errors) : null,
      metadata: parseJson(row.metadata, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function toPublicDataset(dataset) {
    if (!dataset) return null;
    const { internalStorageKey, storageUri, ...rest } = dataset; // eslint-disable-line no-unused-vars
    return rest;
  }

  async function getDatasetRow(datasetId, projectId) {
    const { rows } = await query(
      'SELECT * FROM datasets WHERE id = $1 AND project_id = $2',
      [String(datasetId), String(projectId)]
    );
    return rowToDataset(rows[0]);
  }

  async function createDatasetForProject(userId, projectId, input = {}) {
    const membership = await requireProjectRole(userId, projectId, DATASET_WRITE_ROLES);
    if (!ALLOWED_DATASET_FILE_TYPES.has(input.fileType)) {
      throw codedError('INVALID_FILE_TYPE',
        `Invalid file_type. Allowed: ${[...ALLOWED_DATASET_FILE_TYPES].join(', ')}.`);
    }
    const uploadStatus = input.uploadStatus === undefined ? 'pending' : input.uploadStatus;
    if (!DATASET_UPLOAD_STATUSES.has(uploadStatus)) {
      throw codedError('INVALID_UPLOAD_STATUS',
        `Invalid upload_status. Allowed: ${[...DATASET_UPLOAD_STATUSES].join(', ')}.`);
    }
    const validationStatus = input.validationStatus === undefined ? 'pending' : input.validationStatus;
    if (!DATASET_VALIDATION_STATUSES.has(validationStatus)) {
      throw codedError('INVALID_VALIDATION_STATUS',
        `Invalid validation_status. Allowed: ${[...DATASET_VALIDATION_STATUSES].join(', ')}.`);
    }
    assertDatasetStatusCombo(uploadStatus, validationStatus);
    const metadata = input.metadata === undefined ? {} : input.metadata;
    assertPlainObject(metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
    const id = genId('ds');
    const { rows } = await query(
      `INSERT INTO datasets
         (id, project_id, owner_user_id, created_by_user_id, original_filename,
          file_type, upload_status, validation_status, validation_errors, metadata)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        String(projectId),
        Number(membership.userId),
        sanitizeDatasetFilename(input.originalFilename),
        input.fileType,
        uploadStatus,
        validationStatus,
        normalizeValidationErrors(input.validationErrors),
        JSON.stringify(metadata)
      ]
    );
    return rowToDataset(rows[0]);
  }

  async function listDatasetsForProject(userId, projectId, filters = {}) {
    await requireProjectRole(userId, projectId, DATASET_READ_ROLES);
    const clauses = ['project_id = $1'];
    const params = [String(projectId)];
    if (filters.fileType !== undefined) {
      if (!ALLOWED_DATASET_FILE_TYPES.has(filters.fileType)) throw codedError('INVALID_FILE_TYPE', 'Invalid file_type filter.');
      params.push(filters.fileType); clauses.push(`file_type = $${params.length}`);
    }
    if (filters.uploadStatus !== undefined) {
      if (!DATASET_UPLOAD_STATUSES.has(filters.uploadStatus)) throw codedError('INVALID_UPLOAD_STATUS', 'Invalid upload_status filter.');
      params.push(filters.uploadStatus); clauses.push(`upload_status = $${params.length}`);
    }
    if (filters.validationStatus !== undefined) {
      if (!DATASET_VALIDATION_STATUSES.has(filters.validationStatus)) throw codedError('INVALID_VALIDATION_STATUS', 'Invalid validation_status filter.');
      params.push(filters.validationStatus); clauses.push(`validation_status = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT * FROM datasets WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`,
      params
    );
    return rows.map(rowToDataset);
  }

  async function getDatasetForProject(userId, projectId, datasetId) {
    await requireProjectRole(userId, projectId, DATASET_READ_ROLES);
    return getDatasetRow(datasetId, projectId);
  }

  async function verifyDatasetProjectAccess(userId, datasetId, allowedRoles = DATASET_READ_ROLES) {
    if (typeof datasetId !== 'string' || datasetId === '') {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }
    const { rows } = await query('SELECT * FROM datasets WHERE id = $1', [datasetId]);
    if (!rows[0]) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    const membership = await verifyProjectMember(userId, rows[0].project_id);
    if (!membership) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (!allowed.includes(membership.role)) {
      throw codedError('FORBIDDEN', 'You do not have permission to use this dataset.');
    }
    return rowToDataset(rows[0]);
  }

  async function updateDatasetForProject(userId, projectId, datasetId, input = {}) {
    await requireProjectRole(userId, projectId, DATASET_WRITE_ROLES);
    const existing = await getDatasetRow(datasetId, projectId);
    if (!existing) throw codedError('NOT_FOUND', 'Dataset not found.');

    const sets = [];
    const params = [];
    let nextUpload = existing.uploadStatus;
    let nextValidation = existing.validationStatus;

    if (input.uploadStatus !== undefined) {
      if (!isValidDatasetUploadStatus(input.uploadStatus)) throw codedError('INVALID_UPLOAD_STATUS', 'Invalid upload_status.');
      nextUpload = input.uploadStatus;
      params.push(input.uploadStatus); sets.push(`upload_status = $${params.length}`);
    }
    if (input.validationStatus !== undefined) {
      if (!isValidDatasetValidationStatus(input.validationStatus)) throw codedError('INVALID_VALIDATION_STATUS', 'Invalid validation_status.');
      nextValidation = input.validationStatus;
      params.push(input.validationStatus); sets.push(`validation_status = $${params.length}`);
    }
    assertDatasetStatusCombo(nextUpload, nextValidation);
    if (input.validationErrors !== undefined) {
      params.push(normalizeValidationErrors(input.validationErrors)); sets.push(`validation_errors = $${params.length}`);
    }
    if (input.metadata !== undefined) {
      assertPlainObject(input.metadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
      params.push(JSON.stringify(input.metadata)); sets.push(`metadata = $${params.length}`);
    }
    if (input.originalFilename !== undefined) {
      params.push(sanitizeDatasetFilename(input.originalFilename)); sets.push(`original_filename = $${params.length}`);
    }
    if (sets.length === 0) throw codedError('NO_FIELDS', 'No updatable fields provided.');
    params.push(String(datasetId), String(projectId));
    await query(
      `UPDATE datasets SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length - 1} AND project_id = $${params.length}`,
      params
    );
    return getDatasetRow(datasetId, projectId);
  }

  async function markDatasetUploaded(projectId, datasetId, { internalStorageKey, storageUri = null, sha256, fileSizeBytes }) {
    await query(
      `UPDATE datasets
          SET upload_status = 'uploaded',
              internal_storage_key = $1,
              storage_uri = $2,
              sha256 = $3,
              file_size_bytes = $4,
              updated_at = now()
        WHERE id = $5 AND project_id = $6`,
      [
        internalStorageKey != null ? String(internalStorageKey) : null,
        storageUri != null ? String(storageUri) : null,
        sha256 != null ? String(sha256) : null,
        Number.isFinite(fileSizeBytes) ? fileSizeBytes : null,
        String(datasetId),
        String(projectId)
      ]
    );
    return getDatasetRow(datasetId, projectId);
  }

  async function markDatasetUploadFailed(projectId, datasetId) {
    await query(
      `UPDATE datasets
          SET upload_status = 'failed',
              validation_status = CASE WHEN validation_status = 'valid' THEN 'invalid' ELSE validation_status END,
              updated_at = now()
        WHERE id = $1 AND project_id = $2`,
      [String(datasetId), String(projectId)]
    );
    return getDatasetRow(datasetId, projectId);
  }

  async function setDatasetValidationResult(projectId, datasetId, validationStatus, validationErrors = null) {
    if (!['valid', 'invalid'].includes(validationStatus)) {
      throw codedError('INVALID_VALIDATION_STATUS', 'Dataset validation must finish as valid or invalid.');
    }
    const existing = await getDatasetRow(datasetId, projectId);
    if (!existing) throw codedError('NOT_FOUND', 'Dataset not found.');
    if (existing.uploadStatus !== 'uploaded' || !existing.internalStorageKey) {
      throw codedError('INVALID_STATUS_COMBO', 'Only a stored dataset can receive a validation result.');
    }
    await query(
      `UPDATE datasets
          SET validation_status = $1,
              validation_errors = $2,
              updated_at = now()
        WHERE id = $3 AND project_id = $4`,
      [
        validationStatus,
        normalizeValidationErrors(validationErrors),
        String(datasetId),
        String(projectId),
      ]
    );
    return getDatasetRow(datasetId, projectId);
  }

  return {
    rowToDataset, toPublicDataset, getDatasetRow, createDatasetForProject, listDatasetsForProject, getDatasetForProject, verifyDatasetProjectAccess, updateDatasetForProject, markDatasetUploaded, markDatasetUploadFailed, setDatasetValidationResult,
  };
}

module.exports = { createDatasetStore };
