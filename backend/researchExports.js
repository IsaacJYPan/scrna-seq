'use strict';

const crypto = require('crypto');
const db = require('./pgDatabase');
const analysisBranches = require('./analysisBranches');

const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const MANIFEST_VERSION = 1;
const DOWNLOADABLE_ARTIFACT_TYPES = new Set([
  'deg_markers', 'enrichment_results', 'cellchat_results',
  'condition_de_results', 'expert_r_bundle',
]);
const SAFE_MIME_TYPES = new Map([
  ['deg_markers', 'text/csv'],
  ['enrichment_results', 'text/csv'],
  ['cellchat_results', 'text/csv'],
  ['condition_de_results', 'text/csv'],
  ['expert_r_bundle', 'application/gzip'],
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeFilename(artifact) {
  const extension = artifact.artifactType === 'expert_r_bundle' ? 'tar.gz' : 'csv';
  return `${artifact.artifactType}-${artifact.id}.${extension}`;
}

async function objectIsProjectVisible(userId, projectId, objectId) {
  if (!objectId) return false;
  const { rows } = await db.query(
    `WITH RECURSIVE visible(id) AS (
       SELECT head_analysis_object_id FROM analysis_branches
        WHERE project_id = $1 AND visibility = 'project'
       UNION
       SELECT base_analysis_object_id FROM analysis_branches
        WHERE project_id = $1 AND visibility = 'project'
       UNION
       SELECT analysis_object_id FROM project_canonical_analyses WHERE project_id = $1
       UNION
       SELECT edge.parent_analysis_object_id
         FROM analysis_object_edges edge JOIN visible current
           ON current.id = edge.child_analysis_object_id
        WHERE edge.project_id = $1
     )
     SELECT EXISTS (SELECT 1 FROM visible WHERE id = $2) AS visible`,
    [String(projectId), String(objectId)]
  );
  return rows[0]?.visible === true;
}

async function authorizeArtifactDownload(userId, projectId, artifactId) {
  const artifact = await db.getProjectArtifactInternal(userId, projectId, artifactId);
  if (!artifact || artifact.status !== 'available'
      || artifact.storageKind !== 'local_internal'
      || !DOWNLOADABLE_ARTIFACT_TYPES.has(artifact.artifactType)) {
    throw codedError('ARTIFACT_NOT_DOWNLOADABLE', 'Artifact is not available for download.');
  }
  const ownsArtifact = artifact.createdByUserId === Number(userId);
  // Expert R outputs are never shared merely because their private input object
  // is visible. Only the server-created Expert R result can be explicitly
  // published through a branch; ordinary controlled result tables retain their
  // existing source/result visibility behavior.
  const objectIds = artifact.artifactType === 'expert_r_bundle'
    ? [artifact.resultAnalysisObjectId].filter(Boolean)
    : [artifact.resultAnalysisObjectId, artifact.analysisObjectId].filter(Boolean);
  let shared = false;
  for (const objectId of objectIds) {
    if (await objectIsProjectVisible(userId, projectId, objectId)) {
      shared = true;
      break;
    }
  }
  if (!ownsArtifact && !shared) {
    throw codedError('ARTIFACT_NOT_DOWNLOADABLE', 'Artifact is not available for download.');
  }
  if (!artifact.storageUri || !artifact.checksumSha256 || artifact.sizeBytes == null) {
    throw codedError('ARTIFACT_NOT_DOWNLOADABLE', 'Artifact is not available for download.');
  }
  return {
    artifact,
    filename: safeFilename(artifact),
    mimeType: SAFE_MIME_TYPES.get(artifact.artifactType),
  };
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

const MANIFEST_METADATA_DENY = /(path|uri|url|storage|state.?key|token|secret|claim|worker|script)/i;
function sanitizeManifestMetadata(value, depth = 0) {
  if (depth > 4 || value == null) return value == null ? value : null;
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return value.length <= 500 ? value : value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeManifestMetadata(item, depth + 1));
  if (typeof value !== 'object') return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (MANIFEST_METADATA_DENY.test(key)) continue;
    output[key] = sanitizeManifestMetadata(item, depth + 1);
  }
  return output;
}

function safeJobParameters(row) {
  const parameters = parseJson(row.parameters_json, {});
  if (row.job_type === 'expert.r.v1') {
    return {
      profileId: parameters.profileId || null,
      scriptSha256: typeof parameters.script === 'string'
        ? crypto.createHash('sha256').update(parameters.script, 'utf8').digest('hex')
        : parameters.scriptSha256 || null,
    };
  }
  return parameters;
}

async function resolveExportObject(userId, projectId, input = {}) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  if (input.branchId) {
    const branch = await analysisBranches.accessibleBranch(userId, projectId, input.branchId);
    return { objectId: branch.headAnalysisObjectId, branch };
  }
  const objectId = typeof input.analysisObjectId === 'string' ? input.analysisObjectId : '';
  const { rows } = await db.query(
    'SELECT * FROM analysis_objects WHERE id = $1 AND project_id = $2',
    [objectId, String(projectId)]
  );
  const object = db.rowToAnalysisObject(rows[0]);
  if (!object) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  if (object.ownerUserId !== Number(userId)
      && !(await objectIsProjectVisible(userId, projectId, object.id))) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  return { objectId: object.id, branch: null };
}

async function buildReproducibilityManifest(userId, projectId, input = {}) {
  const resolved = await resolveExportObject(userId, projectId, input);
  const objectId = resolved.objectId;
  const { rows: candidateObjectRows } = await db.query(
    `WITH RECURSIVE lineage(id) AS (
       SELECT $2::text
       UNION
       SELECT edge.parent_analysis_object_id
         FROM analysis_object_edges edge JOIN lineage current
           ON current.id = edge.child_analysis_object_id
        WHERE edge.project_id = $1
     )
     SELECT object.* FROM analysis_objects object JOIN lineage ON lineage.id = object.id
      WHERE object.project_id = $1 ORDER BY object.created_at, object.id`,
    [String(projectId), objectId]
  );
  const objectRows = [];
  for (const row of candidateObjectRows) {
    if (await db.getProjectAnalysisObject(userId, projectId, row.id)) objectRows.push(row);
  }
  const objectIds = objectRows.map((row) => row.id);
  const { rows: edgeRows } = await db.query(
    `SELECT * FROM analysis_object_edges WHERE project_id = $1
      AND child_analysis_object_id = ANY($2::text[])
      AND parent_analysis_object_id = ANY($2::text[])
      ORDER BY created_at, id`,
    [String(projectId), objectIds]
  );
  const { rows: candidateJobRows } = await db.query(
    `SELECT * FROM jobs WHERE project_id = $1
      AND (analysis_object_id = ANY($2::text[]) OR result_analysis_object_id = ANY($2::text[]))
      ORDER BY created_at, id`,
    [String(projectId), objectIds]
  );
  const jobRows = [];
  for (const row of candidateJobRows) {
    if (await db.getProjectJob(userId, projectId, row.id)) jobRows.push(row);
  }
  const jobIds = jobRows.map((row) => row.id);
  const { rows: artifactRows } = jobIds.length === 0 ? { rows: [] } : await db.query(
    `SELECT * FROM job_artifacts WHERE project_id = $1 AND job_id = ANY($2::text[])
      AND status = 'available' ORDER BY created_at, id`,
    [String(projectId), jobIds]
  );
  const { rows: bindingRows } = await db.query(
    `SELECT binding.analysis_object_id, binding.sample_id, binding.cell_metadata_column,
            binding.cell_metadata_value, sample.name AS sample_name, sample.donor_code,
            sample.batch, sample.replicate_label, sample.modality,
            condition.id AS condition_id, condition.name AS condition_name
       FROM analysis_object_sample_bindings binding
       JOIN biological_samples sample ON sample.id = binding.sample_id
       JOIN study_conditions condition ON condition.id = sample.condition_id
      WHERE binding.project_id = $1 AND binding.analysis_object_id = ANY($2::text[])
      ORDER BY binding.analysis_object_id, sample.name, sample.id`,
    [String(projectId), objectIds]
  );
  const { rows: contrastRows } = await db.query(
    `SELECT id, analysis_object_id, name, numerator_condition_id, denominator_condition_id,
            unit_of_replication, paired, cell_type_column, blocking_factor,
            covariates_json, status, validation_json, created_at
       FROM condition_contrasts WHERE project_id = $1
        AND analysis_object_id = ANY($2::text[]) ORDER BY created_at, id`,
    [String(projectId), objectIds]
  );
  const { rows: canonicalRows } = await db.query(
    `SELECT project_id, analysis_object_id, source_branch_id, source_review_id,
            promoted_by_user_id, version, promoted_at
       FROM project_canonical_analyses WHERE project_id = $1`,
    [String(projectId)]
  );
  const { rows: reviewRows } = resolved.branch ? await db.query(
    `SELECT * FROM analysis_branch_reviews WHERE project_id = $1 AND branch_id = $2
      ORDER BY created_at, id`,
    [String(projectId), resolved.branch.id]
  ) : { rows: [] };
  const reviewIds = reviewRows.map((row) => row.id);
  const { rows: commentRows } = reviewIds.length > 0 ? await db.query(
    `SELECT * FROM analysis_branch_review_comments
      WHERE project_id = $1 AND review_id = ANY($2::text[]) ORDER BY created_at, id`,
    [String(projectId), reviewIds]
  ) : { rows: [] };
  return {
    schema: 'traceomics.reproducibility-manifest',
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    projectId: String(projectId),
    exportedAnalysisObjectId: objectId,
    branch: resolved.branch ? {
      id: resolved.branch.id, name: resolved.branch.name, version: resolved.branch.version,
      visibility: resolved.branch.visibility, headAnalysisObjectId: resolved.branch.headAnalysisObjectId,
    } : null,
    lineage: {
      objects: objectRows.map((row) => ({
        id: row.id, objectType: row.object_type, datasetId: row.dataset_id,
        lineageRootId: row.lineage_root_id, createdByUserId: Number(row.created_by_user_id),
        createdAt: row.created_at,
      })),
      edges: edgeRows.map((row) => ({
        id: row.id, parentAnalysisObjectId: row.parent_analysis_object_id,
        childAnalysisObjectId: row.child_analysis_object_id, jobId: row.job_id,
        edgeType: row.edge_type, parentRole: row.parent_role, createdAt: row.created_at,
      })),
    },
    jobs: jobRows.map((row) => ({
      id: row.id, jobType: row.job_type, status: row.status,
      analysisObjectId: row.analysis_object_id,
      resultAnalysisObjectId: row.result_analysis_object_id,
      parameters: safeJobParameters(row), createdAt: row.created_at,
      completedAt: row.completed_at,
    })),
    artifacts: artifactRows.map((row) => ({
      id: row.id, jobId: row.job_id, artifactType: row.artifact_type,
      analysisObjectId: row.analysis_object_id,
      resultAnalysisObjectId: row.result_analysis_object_id,
      mimeType: row.mime_type, checksumSha256: row.checksum_sha256,
      sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
      metadata: sanitizeManifestMetadata(parseJson(row.metadata_json, {})),
      createdAt: row.created_at,
    })),
    experimentalDesign: {
      sampleBindings: bindingRows.map((row) => ({
        analysisObjectId: row.analysis_object_id, sampleId: row.sample_id,
        sampleName: row.sample_name, conditionId: row.condition_id,
        conditionName: row.condition_name, donorCode: row.donor_code, batch: row.batch,
        replicateLabel: row.replicate_label, modality: row.modality,
        cellMetadataColumn: row.cell_metadata_column,
        cellMetadataValue: row.cell_metadata_value,
      })),
      contrasts: contrastRows.map((row) => ({
        id: row.id, analysisObjectId: row.analysis_object_id, name: row.name,
        numeratorConditionId: row.numerator_condition_id,
        denominatorConditionId: row.denominator_condition_id,
        unitOfReplication: row.unit_of_replication, paired: row.paired,
        cellTypeColumn: row.cell_type_column, blockingFactor: row.blocking_factor,
        covariates: parseJson(row.covariates_json, []), status: row.status,
        validation: parseJson(row.validation_json, {}), createdAt: row.created_at,
      })),
    },
    governance: {
      canonical: canonicalRows[0] ? {
        analysisObjectId: canonicalRows[0].analysis_object_id,
        sourceBranchId: canonicalRows[0].source_branch_id,
        sourceReviewId: canonicalRows[0].source_review_id,
        promotedByUserId: Number(canonicalRows[0].promoted_by_user_id),
        version: Number(canonicalRows[0].version),
        promotedAt: canonicalRows[0].promoted_at,
      } : null,
      reviews: reviewRows.map((row) => ({
        id: row.id, branchId: row.branch_id,
        headAnalysisObjectId: row.head_analysis_object_id,
        requestedByUserId: Number(row.requested_by_user_id), title: row.title,
        summary: row.summary, status: row.status,
        decidedByUserId: row.decided_by_user_id == null ? null : Number(row.decided_by_user_id),
        decisionNote: row.decision_note, decidedAt: row.decided_at, createdAt: row.created_at,
      })),
      reviewComments: commentRows.map((row) => ({
        id: row.id, reviewId: row.review_id, authorUserId: Number(row.author_user_id),
        body: row.body, createdAt: row.created_at,
      })),
    },
  };
}

module.exports = {
  MANIFEST_VERSION, DOWNLOADABLE_ARTIFACT_TYPES, SAFE_MIME_TYPES,
  authorizeArtifactDownload, buildReproducibilityManifest, objectIsProjectVisible,
  sanitizeManifestMetadata,
};
