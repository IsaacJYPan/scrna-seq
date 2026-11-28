'use strict';

const storage = require('../storage');
const { MAX_NAME_LENGTH } = require('./projectStore');
const { validateEnvironmentReference, assertEnvironmentMatches, readEnvironmentArtifact, MAX_ENVIRONMENT_BYTES } = require('../rEnvironment');
const {
  MAX_EXPERT_R_OUTPUT_BYTES, MAX_EXPERT_R_BUNDLE_BYTES, EXPERT_R_RESOURCE_POLICY_VERSION,
} = require('../expertR');
const { MAX_CELLCHAT_RESULT_ROWS } = require('../cellChatInference');

// Worker-side completion of analysis jobs: each records its result
// artifacts, child analysis object and lineage edges in one transaction while
// the worker still holds the job claim.
function createJobResultStore({
  connect, query, codedError, parseJson, assertPlainObject,
  claimedJobContextByWorker, workerHoldsClaim, requireWorkerId, requireClaimToken, normalizeWorkerNow,
  getJobRowById, getDatasetRow, getProjectAnalysisObjectRow, getAnalysisObjectForUser, rowToAnalysisObject,
  generateAnalysisObjectId, generateJobArtifactId, insertJobArtifactRow, getJobArtifactRowById, rowToJobArtifact,
  insertLineageEdgeRow, resolveCheckpointArtifact, resolveExpertRPrivateInputs,
  assertArtifactMetadata, assertProjectArtifactStorageKey, isSafeInternalStorageKey,
  normalizeArtifactSizeBytes, normalizeChecksumSha256,
  isValidArtifactStatus, isValidArtifactStorageKind, isValidArtifactType, isValidObjectType,
  ALLOWED_ARTIFACT_STATUSES, ALLOWED_ARTIFACT_STORAGE_KINDS, ALLOWED_ARTIFACT_TYPES, ALLOWED_OBJECT_TYPES,
}) {
  function validateLocalInternalArtifactSpec(input, {
    defaultArtifactType = 'checkpoint',
    artifactTypeRequired = false,
    helperName = 'worker completion'
  } = {}) {
    const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : defaultArtifactType;
    if ((artifactTypeRequired && !artifactType) || !isValidArtifactType(artifactType)) {
      throw codedError('INVALID_ARTIFACT_TYPE',
        `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
    }
    const storageKind = input.storageKind === undefined || input.storageKind === null ? 'local_internal' : String(input.storageKind);
    if (storageKind !== 'local_internal') {
      throw codedError('INVALID_STORAGE_KIND', `${helperName} records a local_internal artifact.`);
    }
    if (!isSafeInternalStorageKey(input.internalStorageKey)) {
      throw codedError('INVALID_STORAGE_KEY', 'internalStorageKey must be a safe, relative, server-allocated key.');
    }
    const checksum = normalizeChecksumSha256(input.checksumSha256);
    if (checksum === undefined || checksum === null) {
      throw codedError('INVALID_CHECKSUM', 'checksumSha256 must be a 64-char hex string.');
    }
    const sizeBytes = normalizeArtifactSizeBytes(input.sizeBytes);
    if (sizeBytes === undefined || sizeBytes === null) {
      throw codedError('INVALID_SIZE', 'sizeBytes must be a non-negative integer.');
    }
    const status = input.status === undefined || input.status === null ? 'available' : String(input.status);
    if (!isValidArtifactStatus(status)) {
      throw codedError('INVALID_ARTIFACT_STATUS', `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
    }
    const metadata = input.metadata === undefined ? {} : input.metadata;
    assertArtifactMetadata(metadata);
    return { artifactType, storageKind, storageUri: input.internalStorageKey, checksumSha256: checksum, sizeBytes, status, metadata };
  }

  function validateMetadataOnlyArtifactSpec(input, {
    defaultArtifactType = '',
    artifactTypeRequired = true
  } = {}) {
    const artifactType = typeof input.artifactType === 'string' ? input.artifactType.trim() : defaultArtifactType;
    if ((artifactTypeRequired && !artifactType) || !isValidArtifactType(artifactType)) {
      throw codedError('INVALID_ARTIFACT_TYPE',
        `Invalid artifactType. Allowed: ${[...ALLOWED_ARTIFACT_TYPES].join(', ')}.`);
    }
    const storageKind = input.storageKind === undefined || input.storageKind === null ? 'metadata_only' : String(input.storageKind);
    if (!isValidArtifactStorageKind(storageKind)) {
      throw codedError('INVALID_STORAGE_KIND', `Invalid storageKind. Allowed: ${[...ALLOWED_ARTIFACT_STORAGE_KINDS].join(', ')}.`);
    }
    const status = input.status === undefined || input.status === null ? 'available' : String(input.status);
    if (!isValidArtifactStatus(status)) {
      throw codedError('INVALID_ARTIFACT_STATUS', `Invalid status. Allowed: ${[...ALLOWED_ARTIFACT_STATUSES].join(', ')}.`);
    }
    const metadata = input.metadata === undefined ? {} : input.metadata;
    assertArtifactMetadata(metadata);
    return { artifactType, storageKind, status, metadata };
  }

  async function completePbmcPipelineResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    if (row.result_analysis_object_id) throw codedError('CHECKPOINT_EXISTS', 'Job already has a result checkpoint object.');

    const owner = Number(row.owner_user_id);
    const pid = row.project_id || null;
    const result = input.result && typeof input.result === 'object' ? input.result : {};
    const objectType = result.objectType === undefined || result.objectType === null ? 'generic' : String(result.objectType).trim();
    if (!isValidObjectType(objectType)) {
      throw codedError('INVALID_OBJECT_TYPE', `Invalid objectType. Allowed: ${[...ALLOWED_OBJECT_TYPES].join(', ')}.`);
    }
    const resultMetadata = result.metadata === undefined ? {} : result.metadata;
    assertPlainObject(resultMetadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
    const cpSpec = validateLocalInternalArtifactSpec(
      input.checkpointArtifact && typeof input.checkpointArtifact === 'object' ? input.checkpointArtifact : {},
      { defaultArtifactType: 'checkpoint', helperName: 'completePbmcPipelineResultByWorker' }
    );
    assertProjectArtifactStorageKey(row, cpSpec.storageUri, 'checkpoints');
    const sm = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
    const smSpec = validateMetadataOnlyArtifactSpec(sm);

    const parentObjectId = result.parentObjectId !== undefined && result.parentObjectId !== null
      ? String(result.parentObjectId)
      : (row.analysis_object_id || null);
    let lineageRootId = null;
    let parentObject = null;
    if (parentObjectId) {
      parentObject = pid ? await getProjectAnalysisObjectRow(parentObjectId, pid)
                         : await getAnalysisObjectForUser(parentObjectId, owner);
      if (!parentObject) throw codedError('PARENT_NOT_FOUND', 'Parent analysis object not found.');
      lineageRootId = parentObject.lineageRootId || parentObject.id;
    }
    // Live-object snapshot jobs do not accept a client dataset binding. Preserve
    // the source object's server-resolved dataset association in the saved child.
    const datasetId = row.dataset_id || parentObject?.datasetId || null;
    const resultId = generateAnalysisObjectId();
    const checkpointArtifactId = generateJobArtifactId();
    const summaryArtifactId = generateJobArtifactId();
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO analysis_objects
           (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id, object_type,
            display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, NULL)`,
        [
          resultId,
          owner,
          pid,
          datasetId,
          parentObjectId,
          lineageRootId || resultId,
          objectType,
          result.displayName != null ? String(result.displayName) : null,
          JSON.stringify(resultMetadata)
        ]
      );
      const linkInfo = await client.query(
        `UPDATE jobs SET result_analysis_object_id = $1, updated_at = $2
         WHERE id = $3 AND worker_id = $4 AND claim_token = $5
           AND status = 'running' AND lease_expires_at > $2
           AND result_analysis_object_id IS NULL`,
        [resultId, now, String(jobId), wid, token]
      );
      if (linkInfo.rowCount !== 1) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
      if (parentObjectId) {
        await insertLineageEdgeRow(client, {
          projectId: pid,
          parentObjectId,
          childObjectId: resultId,
          jobId: String(jobId),
          edgeType: 'checkpoint',
          parentRole: 'primary',
          metadata: {},
          createdByUserId: owner
        });
      }
      await insertJobArtifactRow(client, {
        id: checkpointArtifactId,
        jobRow: row,
        refs: { datasetId, analysisObjectId: parentObjectId, resultAnalysisObjectId: resultId },
        artifactType: cpSpec.artifactType,
        name: input.checkpointArtifact && input.checkpointArtifact.name != null ? String(input.checkpointArtifact.name) : null,
        description: input.checkpointArtifact && input.checkpointArtifact.description != null ? String(input.checkpointArtifact.description) : null,
        storageKind: cpSpec.storageKind,
        storageUri: cpSpec.storageUri,
        checksumSha256: cpSpec.checksumSha256,
        sizeBytes: cpSpec.sizeBytes,
        status: cpSpec.status,
        metadata: cpSpec.metadata
      });
      await insertJobArtifactRow(client, {
        id: summaryArtifactId,
        jobRow: row,
        refs: { datasetId, analysisObjectId: parentObjectId, resultAnalysisObjectId: resultId },
        artifactType: smSpec.artifactType,
        name: sm.name != null ? String(sm.name) : null,
        description: sm.description != null ? String(sm.description) : null,
        storageKind: smSpec.storageKind,
        status: smSpec.status,
        metadata: smSpec.metadata
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return {
      resultObject: pid ? await getProjectAnalysisObjectRow(resultId, pid) : await getAnalysisObjectForUser(resultId, owner),
      checkpointArtifact: await getJobArtifactRowById(checkpointArtifactId),
      summaryArtifact: await getJobArtifactRowById(summaryArtifactId)
    };
  }

  async function completeSeuratPipelineResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    if (row.result_analysis_object_id) throw codedError('CHECKPOINT_EXISTS', 'Job already has a result checkpoint object.');
    if (!row.project_id || !row.dataset_id || !row.analysis_object_id || !(await getDatasetRow(row.dataset_id, row.project_id))) {
      throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    }

    const owner = Number(row.owner_user_id);
    const pid = row.project_id;
    const datasetId = row.dataset_id;
    const result = input.result && typeof input.result === 'object' ? input.result : {};
    const resultMetadata = result.metadata === undefined ? {} : result.metadata;
    assertPlainObject(resultMetadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
    const cpSpec = validateLocalInternalArtifactSpec(
      input.checkpointArtifact && typeof input.checkpointArtifact === 'object' ? input.checkpointArtifact : {},
      { defaultArtifactType: 'checkpoint', helperName: 'completeSeuratPipelineResultByWorker' }
    );
    assertProjectArtifactStorageKey(row, cpSpec.storageUri, 'checkpoints');
    const sm = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
    const smSpec = validateMetadataOnlyArtifactSpec(sm);

    const sourceId = row.analysis_object_id;
    const sourceObject = await getProjectAnalysisObjectRow(sourceId, pid);
    if (!sourceObject || sourceObject.datasetId !== datasetId) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    const resultId = generateAnalysisObjectId();
    const checkpointArtifactId = generateJobArtifactId();
    const summaryArtifactId = generateJobArtifactId();
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO analysis_objects
           (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id, object_type,
            display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'seurat', $7, NULL, NULL, $8, NULL)`,
        [
          resultId,
          owner,
          pid,
          datasetId,
          sourceId,
          sourceObject.lineageRootId || sourceId,
          result.displayName != null ? String(result.displayName) : 'Seurat pipeline result',
          JSON.stringify(resultMetadata)
        ]
      );
      const linkInfo = await client.query(
        `UPDATE jobs SET result_analysis_object_id = $1, updated_at = $2
         WHERE id = $3 AND worker_id = $4 AND claim_token = $5
           AND status = 'running' AND lease_expires_at > $2
           AND result_analysis_object_id IS NULL`,
        [resultId, now, String(jobId), wid, token]
      );
      if (linkInfo.rowCount !== 1) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
      await insertLineageEdgeRow(client, {
        projectId: pid,
        parentObjectId: sourceId,
        childObjectId: resultId,
        jobId: String(jobId),
        edgeType: 'checkpoint',
        parentRole: 'primary',
        metadata: { source: 'dataset', datasetId },
        createdByUserId: owner
      });
      await insertJobArtifactRow(client, {
        id: checkpointArtifactId,
        jobRow: row,
        refs: { datasetId, analysisObjectId: sourceId, resultAnalysisObjectId: resultId },
        artifactType: cpSpec.artifactType,
        name: input.checkpointArtifact && input.checkpointArtifact.name != null ? String(input.checkpointArtifact.name) : null,
        description: input.checkpointArtifact && input.checkpointArtifact.description != null ? String(input.checkpointArtifact.description) : null,
        storageKind: cpSpec.storageKind,
        storageUri: cpSpec.storageUri,
        checksumSha256: cpSpec.checksumSha256,
        sizeBytes: cpSpec.sizeBytes,
        status: cpSpec.status,
        metadata: cpSpec.metadata
      });
      await insertJobArtifactRow(client, {
        id: summaryArtifactId,
        jobRow: row,
        refs: { datasetId, analysisObjectId: sourceId, resultAnalysisObjectId: resultId },
        artifactType: smSpec.artifactType,
        name: sm.name != null ? String(sm.name) : null,
        description: sm.description != null ? String(sm.description) : null,
        storageKind: smSpec.storageKind,
        status: smSpec.status,
        metadata: smSpec.metadata
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return {
      sourceObject: await getProjectAnalysisObjectRow(sourceId, pid),
      resultObject: await getProjectAnalysisObjectRow(resultId, pid),
      checkpointArtifact: await getJobArtifactRowById(checkpointArtifactId),
      summaryArtifact: await getJobArtifactRowById(summaryArtifactId)
    };
  }

  // Shared publication step for workers that emit one private results table plus a
  // metadata-only summary. Callers validate both specs first; this re-checks the claim
  // under a row lock, refuses a second results artifact, and inserts both rows in one
  // transaction.
  async function insertTableAndSummaryArtifactsByWorker({
    row, wid, token, now, refs, resultsType, resultExists, table, tableSpec, summary, summarySpec,
  }) {
    const resultsArtifactId = generateJobArtifactId();
    const summaryArtifactId = generateJobArtifactId();
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const claimRow = await client.query(
        `SELECT 1 FROM jobs
         WHERE id = $1 AND worker_id = $2 AND claim_token = $3
           AND status = 'running' AND lease_expires_at > $4
         FOR UPDATE`,
        [String(row.id), wid, token, now]
      );
      if (!claimRow.rows[0]) {
        throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
      }
      const duplicate = await client.query(
        'SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = $2 LIMIT 1',
        [String(row.id), resultsType]
      );
      if (duplicate.rows[0]) throw codedError(resultExists[0], resultExists[1]);
      await insertJobArtifactRow(client, {
        id: resultsArtifactId,
        jobRow: row,
        refs,
        artifactType: tableSpec.artifactType,
        name: table.name != null ? String(table.name) : null,
        description: table.description != null ? String(table.description) : null,
        mimeType: table.mimeType != null ? String(table.mimeType) : null,
        storageKind: tableSpec.storageKind,
        storageUri: tableSpec.storageUri,
        checksumSha256: tableSpec.checksumSha256,
        sizeBytes: tableSpec.sizeBytes,
        status: tableSpec.status,
        metadata: tableSpec.metadata
      });
      await insertJobArtifactRow(client, {
        id: summaryArtifactId,
        jobRow: row,
        refs,
        artifactType: summarySpec.artifactType,
        name: summary.name != null ? String(summary.name) : null,
        description: summary.description != null ? String(summary.description) : null,
        storageKind: summarySpec.storageKind,
        status: summarySpec.status,
        metadata: summarySpec.metadata
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return {
      resultsArtifact: await getJobArtifactRowById(resultsArtifactId),
      summaryArtifact: await getJobArtifactRowById(summaryArtifactId)
    };
  }

  async function completeDegFindMarkersResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    const existing = await query(
      "SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = 'deg_markers' LIMIT 1",
      [String(row.id)]
    );
    if (existing.rows[0]) throw codedError('DEG_RESULT_EXISTS', 'Job already has a DEG marker result artifact.');

    const tbl = input.markersArtifact && typeof input.markersArtifact === 'object' ? input.markersArtifact : {};
    const tblSpec = validateLocalInternalArtifactSpec(tbl, {
      defaultArtifactType: 'deg_markers',
      helperName: 'completeDegFindMarkersResultByWorker'
    });
    assertProjectArtifactStorageKey(row, tblSpec.storageUri, 'artifacts');
    const sm = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
    const smSpec = validateMetadataOnlyArtifactSpec(sm, { defaultArtifactType: 'deg_summary', artifactTypeRequired: false });
    const refs = {
      datasetId: row.dataset_id || null,
      analysisObjectId: row.analysis_object_id || null,
      resultAnalysisObjectId: row.result_analysis_object_id || null
    };
    const published = await insertTableAndSummaryArtifactsByWorker({
      row, wid, token, now, refs,
      resultsType: 'deg_markers',
      resultExists: ['DEG_RESULT_EXISTS', 'Job already has a DEG marker result artifact.'],
      table: tbl, tableSpec: tblSpec, summary: sm, summarySpec: smSpec,
    });
    return { markersArtifact: published.resultsArtifact, summaryArtifact: published.summaryArtifact };
  }

  /**
   * Atomically publish the two outputs of enrichment.gsea.v1. The full table stays
   * in private project storage; the second artifact contains only the bridge-sanitized,
   * bounded preview used by the UI. No analysis object or lineage edge is created.
   */
  // Pathway enrichment and CellChat workers each publish one bounded results
  // table plus a metadata-only summary. The kinds below differ only in job type,
  // artifact types, row limit, and their public error codes and messages.
  const ENRICHMENT_RESULT_KIND = Object.freeze({
    jobType: 'enrichment.gsea.v1',
    resultsType: 'enrichment_results',
    summaryType: 'enrichment_summary',
    helperName: 'completeEnrichmentGseaResultByWorker',
    maxRows: 100000,
    resultExists: ['ENRICHMENT_RESULT_EXISTS', 'Job already has a pathway-enrichment result artifact.'],
    resultTypeFixedMessage: 'The enrichment result artifact type is fixed.',
    resultTooLarge: ['ENRICHMENT_RESULT_TOO_LARGE', 'Pathway-enrichment result exceeds its safe size limit.'],
    invalidRowCount: ['INVALID_ENRICHMENT_RESULT', 'Pathway-enrichment result row count is invalid.'],
    summaryTypeFixedMessage: 'The enrichment summary artifact type is fixed.',
    summaryTooLarge: ['INVALID_ENRICHMENT_SUMMARY', 'Pathway-enrichment summary exceeds its safe size limit.'],
  });
  const CELLCHAT_RESULT_KIND = Object.freeze({
    jobType: 'cellchat.infer.v1',
    resultsType: 'cellchat_results',
    summaryType: 'cellchat_summary',
    helperName: 'completeCellChatInferenceResultByWorker',
    maxRows: MAX_CELLCHAT_RESULT_ROWS,
    resultExists: ['CELLCHAT_RESULT_EXISTS', 'Job already has a cell-communication result artifact.'],
    resultTypeFixedMessage: 'The cell-communication result artifact type is fixed.',
    resultTooLarge: ['CELLCHAT_RESULT_TOO_LARGE', 'Cell-communication result exceeds its safe size limit.'],
    invalidRowCount: ['INVALID_CELLCHAT_RESULT', 'Cell-communication result row count is invalid.'],
    summaryTypeFixedMessage: 'The cell-communication summary artifact type is fixed.',
    summaryTooLarge: ['INVALID_CELLCHAT_SUMMARY', 'Cell-communication summary exceeds its safe size limit.'],
  });

  async function completeTableAndSummaryResultByWorker(kind, jobId, workerId, claimToken, input = {}, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    if (row.job_type !== kind.jobType) {
      throw codedError('INVALID_JOB_TYPE', `A claimed ${kind.jobType} job is required.`);
    }
    const existing = await query(
      'SELECT 1 FROM job_artifacts WHERE job_id = $1 AND artifact_type = $2 LIMIT 1',
      [String(row.id), kind.resultsType]
    );
    if (existing.rows[0]) {
      throw codedError(kind.resultExists[0], kind.resultExists[1]);
    }

    const table = input.resultsArtifact && typeof input.resultsArtifact === 'object'
      ? input.resultsArtifact : {};
    const tableSpec = validateLocalInternalArtifactSpec(table, {
      defaultArtifactType: kind.resultsType,
      helperName: kind.helperName
    });
    if (tableSpec.artifactType !== kind.resultsType) {
      throw codedError('INVALID_ARTIFACT_TYPE', kind.resultTypeFixedMessage);
    }
    assertProjectArtifactStorageKey(row, tableSpec.storageUri, 'artifacts');
    if (tableSpec.sizeBytes > 50 * 1024 * 1024) {
      throw codedError(kind.resultTooLarge[0], kind.resultTooLarge[1]);
    }
    const nRows = tableSpec.metadata && tableSpec.metadata.nRows;
    if (!Number.isInteger(nRows) || nRows < 0 || nRows > kind.maxRows) {
      throw codedError(kind.invalidRowCount[0], kind.invalidRowCount[1]);
    }

    const summary = input.summaryArtifact && typeof input.summaryArtifact === 'object'
      ? input.summaryArtifact : {};
    const summarySpec = validateMetadataOnlyArtifactSpec(summary, {
      defaultArtifactType: kind.summaryType, artifactTypeRequired: false
    });
    if (summarySpec.artifactType !== kind.summaryType
        || summarySpec.storageKind !== 'metadata_only') {
      throw codedError('INVALID_ARTIFACT_TYPE', kind.summaryTypeFixedMessage);
    }
    const encodedSummary = JSON.stringify(summarySpec.metadata);
    if (Buffer.byteLength(encodedSummary, 'utf8') > 128 * 1024) {
      throw codedError(kind.summaryTooLarge[0], kind.summaryTooLarge[1]);
    }

    const refs = {
      datasetId: row.dataset_id || null,
      analysisObjectId: row.analysis_object_id || null,
      resultAnalysisObjectId: null
    };
    return insertTableAndSummaryArtifactsByWorker({
      row, wid, token, now, refs,
      resultsType: kind.resultsType,
      resultExists: kind.resultExists,
      table, tableSpec, summary, summarySpec,
    });
  }

  async function completeEnrichmentGseaResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
    return completeTableAndSummaryResultByWorker(ENRICHMENT_RESULT_KIND, jobId, workerId, claimToken, input, opts);
  }

  async function completeConditionComparisonResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    if (row.job_type !== 'condition.pseudobulk_de.v1') {
      throw codedError('INVALID_JOB_TYPE', 'A claimed condition.pseudobulk_de.v1 job is required.');
    }
    const table = input.resultsArtifact && typeof input.resultsArtifact === 'object' ? input.resultsArtifact : {};
    const tableSpec = validateLocalInternalArtifactSpec(table, {
      defaultArtifactType: 'condition_de_results', helperName: 'completeConditionComparisonResultByWorker',
    });
    if (tableSpec.artifactType !== 'condition_de_results') {
      throw codedError('INVALID_ARTIFACT_TYPE', 'The condition-comparison result artifact type is fixed.');
    }
    assertProjectArtifactStorageKey(row, tableSpec.storageUri, 'artifacts');
    const nRows = tableSpec.metadata && tableSpec.metadata.nRows;
    if (tableSpec.sizeBytes > 100 * 1024 * 1024
        || !Number.isInteger(nRows) || nRows < 0 || nRows > 500000) {
      throw codedError('INVALID_CONDITION_COMPARISON_RESULT', 'Condition-comparison result bounds are invalid.');
    }
    const summary = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
    const summarySpec = validateMetadataOnlyArtifactSpec(summary, {
      defaultArtifactType: 'condition_de_summary', artifactTypeRequired: false,
    });
    if (summarySpec.artifactType !== 'condition_de_summary'
        || Buffer.byteLength(JSON.stringify(summarySpec.metadata), 'utf8') > 128 * 1024) {
      throw codedError('INVALID_CONDITION_COMPARISON_SUMMARY', 'Condition-comparison summary is invalid.');
    }
    const refs = { datasetId: row.dataset_id || null, analysisObjectId: row.analysis_object_id, resultAnalysisObjectId: null };
    return insertTableAndSummaryArtifactsByWorker({
      row, wid, token, now, refs,
      resultsType: 'condition_de_results',
      resultExists: ['CONDITION_COMPARISON_RESULT_EXISTS', 'Job already has a condition-comparison result.'],
      table, tableSpec, summary, summarySpec,
    });
  }

  async function completeExpertRResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
    const wid = requireWorkerId(workerId); const token = requireClaimToken(claimToken);
    const now = normalizeWorkerNow(opts); const row = await getJobRowById(jobId);
    if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    if (!workerHoldsClaim(row, wid, token, now)) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    if (row.job_type !== 'expert.r.v1') throw codedError('INVALID_JOB_TYPE', 'A claimed expert.r.v1 job is required.');
    if (row.result_analysis_object_id) throw codedError('EXPERT_R_RESULT_EXISTS', 'Job already has an Expert R result.');
    if (!row.project_id || !row.analysis_object_id) {
      throw codedError('INVALID_PROJECT_SCOPE', 'Expert R requires a project-scoped analysis object.');
    }
    const owner = Number(row.owner_user_id);
    const pid = row.project_id;
    const sourceId = row.analysis_object_id;
    const sourceObject = await getProjectAnalysisObjectRow(sourceId, pid);
    if (!sourceObject || sourceObject.ownerUserId !== owner) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    const expectedCheckpoint = await resolveCheckpointArtifact(sourceId, pid);
    const jobParameters = parseJson(row.parameters_json, {});
    const expectedProfileId = jobParameters.profileId;
    const expectedScriptSha256 = jobParameters.scriptSha256;
    // Sandbox runs routed to a qualified Slurm target record the cluster policy.
    const expectedPolicyVersion = row.execution_target === 'slurm'
      ? require('../expertR').SLURM_SANDBOX_POLICY_VERSION : EXPERT_R_RESOURCE_POLICY_VERSION;
    const expectedEnvironment = jobParameters.environment ? validateEnvironmentReference(jobParameters.environment) : null;
    const expectedPrivateInputs = (await resolveExpertRPrivateInputs(
      owner, pid, jobParameters.inputIds || []
    )).map((input) => ({
      id: input.id,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
    }));
    const result = input.result && typeof input.result === 'object' ? input.result : {};
    if (result.objectType !== undefined && result.objectType !== 'generic') {
      throw codedError('INVALID_OBJECT_TYPE', 'Expert R result object type is fixed.');
    }
    const resultMetadata = result.metadata === undefined ? {} : result.metadata;
    assertPlainObject(resultMetadata, 'INVALID_METADATA', 'metadata must be a plain JSON object.');
    if (Buffer.byteLength(JSON.stringify(resultMetadata), 'utf8') > 128 * 1024) {
      throw codedError('INVALID_EXPERT_R_RESULT', 'Expert R result metadata is too large.');
    }
    const bundle = input.bundleArtifact && typeof input.bundleArtifact === 'object' ? input.bundleArtifact : {};
    const bundleSpec = validateLocalInternalArtifactSpec(bundle, {
      defaultArtifactType: 'expert_r_bundle', helperName: 'completeExpertRResultByWorker',
    });
    if (bundleSpec.artifactType !== 'expert_r_bundle') throw codedError('INVALID_ARTIFACT_TYPE', 'Expert R bundle type is fixed.');
    assertProjectArtifactStorageKey(row, bundleSpec.storageUri, 'artifacts');
    const nFiles = bundleSpec.metadata && bundleSpec.metadata.nFiles;
    if (bundleSpec.sizeBytes > MAX_EXPERT_R_BUNDLE_BYTES || !Number.isInteger(nFiles) || nFiles < 0 || nFiles > 50) {
      throw codedError('INVALID_EXPERT_R_RESULT', 'Expert R output bounds are invalid.');
    }
    const summary = input.summaryArtifact && typeof input.summaryArtifact === 'object' ? input.summaryArtifact : {};
    let environmentSpec = null;
    if (expectedEnvironment) {
      environmentSpec = validateLocalInternalArtifactSpec(input.environmentArtifact || {}, {
        defaultArtifactType: 'expert_r_environment', helperName: 'completeExpertRResultByWorker',
      });
      if (environmentSpec.artifactType !== 'expert_r_environment' || environmentSpec.sizeBytes < 1
          || environmentSpec.sizeBytes > MAX_ENVIRONMENT_BYTES
          || environmentSpec.storageUri !== `${bundleSpec.storageUri}.environment.json`) throw codedError('INVALID_EXPERT_R_RESULT', 'The exact R environment artifact is invalid.');
      assertProjectArtifactStorageKey(row, environmentSpec.storageUri, 'artifacts');
      assertEnvironmentMatches(expectedEnvironment, environmentSpec.metadata.environment);
      await readEnvironmentArtifact(storage.createLocalStorageProvider(), {
        internalStorageKey: environmentSpec.storageUri, checksumSha256: environmentSpec.checksumSha256,
        sizeBytes: environmentSpec.sizeBytes,
      }, expectedEnvironment);
    }
    const summarySpec = validateMetadataOnlyArtifactSpec(summary, {
      defaultArtifactType: 'expert_r_summary', artifactTypeRequired: false,
    });
    if (summarySpec.artifactType !== 'expert_r_summary'
        || Buffer.byteLength(JSON.stringify(summarySpec.metadata), 'utf8') > 128 * 1024) {
      throw codedError('INVALID_EXPERT_R_RESULT', 'Expert R summary is invalid.');
    }
    for (const metadata of [resultMetadata, bundleSpec.metadata, summarySpec.metadata]) {
      if (expectedEnvironment) {
        assertEnvironmentMatches(expectedEnvironment, metadata.environment);
        if (metadata.sandboxImageDigest !== expectedEnvironment.imageDigest) throw codedError('INVALID_EXPERT_R_RESULT', 'The exact R runtime provenance is inconsistent.');
      }
      if (metadata.packageProfileId !== expectedProfileId
          || metadata.scriptSha256 !== expectedScriptSha256
          || metadata.resourcePolicyVersion !== expectedPolicyVersion
          || !/^sha256:[0-9a-f]{64}$/.test(String(metadata.sandboxImageDigest || ''))
          || metadata.input?.analysisObjectId !== sourceId
          || metadata.input?.checkpointArtifactId !== expectedCheckpoint.checkpointArtifactId
          || metadata.input?.checkpointChecksumSha256 !== expectedCheckpoint.checksumSha256
          || metadata.input?.checkpointSizeBytes !== expectedCheckpoint.sizeBytes
          || JSON.stringify(metadata.input?.privateInputs || []) !== JSON.stringify(expectedPrivateInputs)) {
        throw codedError('INVALID_EXPERT_R_RESULT', 'Expert R provenance is incomplete or inconsistent.');
      }
    }
    const outputFiles = bundleSpec.metadata.files;
    const filesValid = Array.isArray(outputFiles)
      && outputFiles.length === nFiles
      && outputFiles.every((file) => (
        file && typeof file.name === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(file.name)
        && !file.name.split('/').some((part) => part === '.' || part === '..' || part === '')
        && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0
        && /^[0-9a-f]{64}$/.test(String(file.checksumSha256 || ''))
      ));
    const outputBytes = bundleSpec.metadata.outputBytes;
    if (!filesValid
        || !Number.isSafeInteger(outputBytes) || outputBytes < 0
        || outputBytes > MAX_EXPERT_R_OUTPUT_BYTES
        || outputFiles.reduce((total, file) => total + file.sizeBytes, 0) !== outputBytes
        || summarySpec.metadata.nFiles !== nFiles
        || JSON.stringify(summarySpec.metadata.files) !== JSON.stringify(outputFiles)
        || summarySpec.metadata.outputBundleChecksumSha256 !== bundleSpec.checksumSha256
        || summarySpec.metadata.outputBundleSizeBytes !== bundleSpec.sizeBytes
        || resultMetadata.outputBundleChecksumSha256 !== bundleSpec.checksumSha256
        || resultMetadata.nFiles !== nFiles) {
      throw codedError('INVALID_EXPERT_R_RESULT', 'Expert R output manifest is inconsistent.');
    }
    const resultId = generateAnalysisObjectId();
    const bundleId = generateJobArtifactId(); const summaryId = generateJobArtifactId();
    const environmentId = environmentSpec ? generateJobArtifactId() : null;
    if (environmentSpec) {
      for (const metadata of [resultMetadata, bundleSpec.metadata, summarySpec.metadata]) metadata.environmentArtifact = {
        id: environmentId, checksumSha256: environmentSpec.checksumSha256, sizeBytes: environmentSpec.sizeBytes,
      };
    }
    const refs = {
      datasetId: sourceObject.datasetId || null,
      analysisObjectId: sourceId,
      resultAnalysisObjectId: resultId,
    };
    const p = await connect(); const client = await p.connect();
    let committedRows = null;
    let commitAttempted = false;
    try {
      await client.query('BEGIN');
      const claim = await client.query(
        "SELECT 1 FROM jobs WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND status='running' AND lease_expires_at>$4 FOR UPDATE",
        [row.id, wid, token, now]
      );
      if (!claim.rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
      const duplicate = await client.query("SELECT 1 FROM job_artifacts WHERE job_id=$1 AND artifact_type='expert_r_bundle' LIMIT 1", [row.id]);
      if (duplicate.rows[0]) throw codedError('EXPERT_R_RESULT_EXISTS', 'Job already has an Expert R result.');
      await client.query(
        `INSERT INTO analysis_objects
           (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id,
            object_type, display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'generic', $7, NULL, NULL, $8, NULL)`,
        [
          resultId,
          owner,
          pid,
          sourceObject.datasetId || null,
          sourceId,
          sourceObject.lineageRootId || sourceId,
          result.displayName != null ? String(result.displayName).slice(0, MAX_NAME_LENGTH) : 'Expert R result',
          JSON.stringify(resultMetadata),
        ]
      );
      const linkInfo = await client.query(
        `UPDATE jobs SET result_analysis_object_id = $1, updated_at = $2
          WHERE id = $3 AND worker_id = $4 AND claim_token = $5
            AND status = 'running' AND lease_expires_at > $2
            AND result_analysis_object_id IS NULL`,
        [resultId, now, row.id, wid, token]
      );
      if (linkInfo.rowCount !== 1) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
      await insertLineageEdgeRow(client, {
        projectId: pid,
        parentObjectId: sourceId,
        childObjectId: resultId,
        jobId: row.id,
        edgeType: 'derived_from',
        parentRole: 'primary',
        metadata: {
          analysisKind: 'expert_r',
          checkpointArtifactId: expectedCheckpoint.checkpointArtifactId,
          packageProfileId: expectedProfileId,
          scriptSha256: expectedScriptSha256,
        },
        createdByUserId: owner,
      });
      await insertJobArtifactRow(client, {
        id: bundleId, jobRow: row, refs, artifactType: bundleSpec.artifactType,
        name: bundle.name || null, description: bundle.description || null,
        mimeType: bundle.mimeType || null, storageKind: bundleSpec.storageKind,
        storageUri: bundleSpec.storageUri, checksumSha256: bundleSpec.checksumSha256,
        sizeBytes: bundleSpec.sizeBytes, status: bundleSpec.status, metadata: bundleSpec.metadata,
      });
      await insertJobArtifactRow(client, {
        id: summaryId, jobRow: row, refs, artifactType: summarySpec.artifactType,
        name: summary.name || null, description: summary.description || null,
        storageKind: summarySpec.storageKind, status: summarySpec.status, metadata: summarySpec.metadata,
      });
      if (environmentSpec) await insertJobArtifactRow(client, {
        id: environmentId, jobRow: row, refs, artifactType: 'expert_r_environment',
        name: 'Exact R environment', description: 'Verified package lock and immutable container userspace identity.',
        mimeType: 'application/json', storageKind: environmentSpec.storageKind,
        storageUri: environmentSpec.storageUri, checksumSha256: environmentSpec.checksumSha256,
        sizeBytes: environmentSpec.sizeBytes, status: environmentSpec.status, metadata: environmentSpec.metadata,
      });
      const [resultRows, artifactRows] = await Promise.all([
        client.query('SELECT * FROM analysis_objects WHERE id = $1 AND project_id = $2', [resultId, pid]),
        client.query('SELECT * FROM job_artifacts WHERE id = ANY($1::text[])', [[bundleId, summaryId, ...(environmentId ? [environmentId] : [])]]),
      ]);
      const artifactsById = new Map(artifactRows.rows.map((artifactRow) => [artifactRow.id, artifactRow]));
      if (!resultRows.rows[0] || !artifactsById.has(bundleId) || !artifactsById.has(summaryId) || (environmentId && !artifactsById.has(environmentId))) {
        throw codedError('EXPERT_R_PUBLICATION_INVALID', 'Expert R publication could not be verified.');
      }
      committedRows = {
        resultObject: rowToAnalysisObject(resultRows.rows[0]),
        bundleArtifact: rowToJobArtifact(artifactsById.get(bundleId)),
        summaryArtifact: rowToJobArtifact(artifactsById.get(summaryId)),
        ...(environmentId ? { environmentArtifact: rowToJobArtifact(artifactsById.get(environmentId)) } : {}),
      };
      commitAttempted = true;
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
      if (commitAttempted) {
        const indeterminate = codedError(
          'EXPERT_R_PUBLICATION_INDETERMINATE',
          'Expert R publication outcome is indeterminate.'
        );
        indeterminate.completionMayHaveCommitted = true;
        throw indeterminate;
      }
      throw error;
    } finally { client.release(); }
    return {
      sourceObject,
      ...committedRows,
    };
  }

  /**
   * Atomically publish a `trusted.method.v1` result: a new analysis object
   * derived from the input, a lineage edge, every declared output (the rds
   * `analysis` output becomes the new object's checkpoint, so follow-on studies
   * and the workbench can load it), and a metadata-only summary carrying the
   * bounded metrics used for trial comparison. Output keys must be the
   * job-scoped keys the handler allocated; the handler already verified bytes.
   */
  const TRUSTED_METHOD_OUTPUT_TYPES = new Set(['rds', 'table', 'metrics', 'figure']);
  async function completeTrustedMethodResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
    const wid = requireWorkerId(workerId); const token = requireClaimToken(claimToken);
    const now = normalizeWorkerNow(opts); const row = await getJobRowById(jobId);
    if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    if (!workerHoldsClaim(row, wid, token, now)) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    if (row.job_type !== 'trusted.method.v1') throw codedError('INVALID_JOB_TYPE', 'A claimed trusted.method.v1 job is required.');
    if (row.result_analysis_object_id) throw codedError('TRUSTED_METHOD_RESULT_EXISTS', 'Job already has a result.');
    if (!row.project_id || !row.analysis_object_id) throw codedError('INVALID_PROJECT_SCOPE', 'A project-scoped analysis object is required.');
    const owner = Number(row.owner_user_id); const pid = row.project_id; const sourceId = row.analysis_object_id;
    const sourceObject = await getProjectAnalysisObjectRow(sourceId, pid);
    if (!sourceObject || sourceObject.ownerUserId !== owner) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    const jobParameters = parseJson(row.parameters_json, {});
    if (input.method !== jobParameters.method) throw codedError('INVALID_TRUSTED_METHOD_RESULT', 'Result method does not match the job.');
    const objectType = input.objectType === 'seurat' ? 'seurat' : 'generic';
    const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : null;
    if (!metadata || Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 128 * 1024) {
      throw codedError('INVALID_TRUSTED_METHOD_RESULT', 'Result metadata is missing or too large.');
    }
    const outputs = Array.isArray(input.outputs) ? input.outputs : [];
    const prefix = storage.projectStorageFileKey(pid, 'artifacts', row.id, 'trusted-method');
    if (outputs.length < 1 || outputs.length > 8 || outputs.some((o) => !o || !TRUSTED_METHOD_OUTPUT_TYPES.has(o.type)
        || typeof o.port !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(o.port)
        || typeof o.storageKey !== 'string' || !o.storageKey.startsWith(`${prefix}-`)
        || !/^[a-f0-9]{64}$/.test(o.sha256 || '') || !Number.isSafeInteger(o.sizeBytes) || o.sizeBytes < 0)
        || new Set(outputs.map((o) => o.port)).size !== outputs.length
        || (objectType === 'seurat') !== outputs.some((o) => o.port === 'analysis' && o.type === 'rds')) {
      throw codedError('INVALID_TRUSTED_METHOD_RESULT', 'Trusted method outputs are invalid.');
    }
    for (const output of outputs) assertProjectArtifactStorageKey(row, output.storageKey, 'artifacts');
    const resultId = generateAnalysisObjectId();
    const summaryId = generateJobArtifactId();
    const outputIds = outputs.map(() => generateJobArtifactId());
    const refs = { datasetId: sourceObject.datasetId || null, analysisObjectId: sourceId, resultAnalysisObjectId: resultId };
    const mime = { rds: 'application/octet-stream', table: 'application/json', metrics: 'application/json', figure: 'image/png' };
    const p = await connect(); const client = await p.connect();
    try {
      await client.query('BEGIN');
      const claim = await client.query(
        "SELECT 1 FROM jobs WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND status='running' AND lease_expires_at>$4 FOR UPDATE",
        [row.id, wid, token, now]
      );
      if (!claim.rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
      await client.query(
        `INSERT INTO analysis_objects
           (id, owner_user_id, project_id, dataset_id, parent_object_id, lineage_root_id,
            object_type, display_name, storage_uri, object_hash, metadata_json, created_by_provenance_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9, NULL)`,
        [resultId, owner, pid, sourceObject.datasetId || null, sourceId, sourceObject.lineageRootId || sourceId,
          objectType, String(input.displayName || 'Trusted method result').slice(0, MAX_NAME_LENGTH), JSON.stringify(metadata)]
      );
      const linked = await client.query(
        `UPDATE jobs SET result_analysis_object_id = $1, updated_at = $2
          WHERE id = $3 AND worker_id = $4 AND claim_token = $5 AND status = 'running'
            AND lease_expires_at > $2 AND result_analysis_object_id IS NULL`,
        [resultId, now, row.id, wid, token]
      );
      if (linked.rowCount !== 1) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
      await insertLineageEdgeRow(client, {
        projectId: pid, parentObjectId: sourceId, childObjectId: resultId, jobId: row.id,
        edgeType: 'derived_from', parentRole: 'primary',
        metadata: { analysisKind: 'trusted_method', method: metadata.method || null, scriptSha256: metadata.scriptSha256 || null },
        createdByUserId: owner,
      });
      for (const [index, output] of outputs.entries()) {
        const checkpoint = output.port === 'analysis' && output.type === 'rds';
        await insertJobArtifactRow(client, {
          id: outputIds[index], jobRow: row, refs,
          artifactType: checkpoint ? 'checkpoint' : 'trusted_method_output',
          name: String(output.label || output.port).slice(0, MAX_NAME_LENGTH),
          description: checkpoint ? 'Seurat analysis produced by a trusted method.' : `Trusted method ${output.type} output.`,
          mimeType: mime[output.type], storageKind: 'local_internal', storageUri: output.storageKey,
          checksumSha256: output.sha256, sizeBytes: output.sizeBytes, status: 'available',
          metadata: { port: output.port, outputType: output.type, method: metadata.method || null, downloadable: false },
        });
      }
      await insertJobArtifactRow(client, {
        id: summaryId, jobRow: row, refs, artifactType: 'trusted_method_summary',
        name: `${String(input.displayName || 'Trusted method').slice(0, 200)} summary`,
        description: 'Bounded metrics and exact provenance of a trusted method run.',
        storageKind: 'metadata_only', status: 'available',
        metadata: { ...metadata, outputs: outputs.map((o, i) => ({ id: outputIds[i], port: o.port, type: o.type, sha256: o.sha256, sizeBytes: o.sizeBytes })) },
      });
      const result = await client.query('SELECT * FROM analysis_objects WHERE id = $1 AND project_id = $2', [resultId, pid]);
      await client.query('COMMIT');
      return { sourceObject, resultObject: rowToAnalysisObject(result.rows[0]), summaryArtifact: await getJobArtifactRowById(summaryId) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
      throw error;
    } finally { client.release(); }
  }

  /**
   * Atomically publish the two outputs of `cellchat.infer.v1`. The complete
   * ligand-receptor candidate table remains in private project storage; the
   * metadata-only companion is already strictly sanitized by rWorkerBridge and
   * is the only CellChat content exposed through project artifact APIs.
   */
  async function completeCellChatInferenceResultByWorker(jobId, workerId, claimToken, input = {}, opts = {}) {
    return completeTableAndSummaryResultByWorker(CELLCHAT_RESULT_KIND, jobId, workerId, claimToken, input, opts);
  }

  return {
    completePbmcPipelineResultByWorker, completeSeuratPipelineResultByWorker, completeDegFindMarkersResultByWorker, completeEnrichmentGseaResultByWorker, completeConditionComparisonResultByWorker, completeExpertRResultByWorker, completeTrustedMethodResultByWorker, completeCellChatInferenceResultByWorker,
  };
}

module.exports = { createJobResultStore };
