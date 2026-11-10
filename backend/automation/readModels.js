'use strict';

// Bounded read projections for agent credentials (docs/spec.md 13.2). These
// queries are written against the delegation's project directly; they never
// pass the sponsor's user id into a legacy service. The disclosure profile
// decides whether human-authored labels (names, filenames, descriptions) are
// visible. Storage coordinates, parameters, logs, and errors are never exposed.

const MAX_LIST = 100;

function boundedLimit(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(MAX_LIST, n);
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function createAutomationReadModels({ db }) {
  async function projectSummary(actor) {
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.description, p.created_at,
              (SELECT COUNT(*)::int FROM datasets d WHERE d.project_id = p.id) AS dataset_count,
              (SELECT COUNT(*)::int FROM jobs j WHERE j.project_id = p.id AND j.status = 'completed') AS completed_run_count
         FROM projects p WHERE p.id = $1`,
      [actor.delegation.projectId]
    );
    const row = rows[0];
    if (!row) return null;
    const labels = actor.delegation.disclosureProfile === 'labels';
    return {
      schema: 'traceomics.automation.project.v1',
      id: row.id,
      ...(labels ? { name: truncate(row.name, 200), description: truncate(row.description, 2000) } : {}),
      datasetCount: row.dataset_count,
      completedRunCount: row.completed_run_count,
      createdAt: row.created_at,
      approvedWorkflows: { available: true, reason: 'Execution requires a current project approval, pinned runtime and open study.' },
    };
  }

  async function listDatasets(actor, { limit } = {}) {
    const bounded = boundedLimit(limit);
    const { rows } = await db.query(
      `SELECT id, original_filename, file_type, file_size_bytes, sha256, upload_status, validation_status,
              created_at, updated_at
         FROM datasets WHERE project_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [actor.delegation.projectId, bounded + 1]
    );
    const labels = actor.delegation.disclosureProfile === 'labels';
    return {
      schema: 'traceomics.automation.datasets.v1',
      truncated: rows.length > bounded,
      datasets: rows.slice(0, bounded).map((row) => ({
        id: row.id,
        ...(labels ? { originalFilename: truncate(row.original_filename, 255) } : {}),
        fileType: row.file_type,
        fileSizeBytes: row.file_size_bytes == null ? null : Number(row.file_size_bytes),
        sha256: row.sha256 || null,
        uploadStatus: row.upload_status,
        validationStatus: row.validation_status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  async function listRuns(actor, { limit } = {}) {
    const bounded = boundedLimit(limit);
    const { rows } = await db.query(
      `SELECT id, job_type, status, dataset_id, analysis_object_id, result_analysis_object_id,
              created_at, started_at, completed_at, canceled_at
         FROM jobs WHERE project_id = $1 AND status IN ('completed', 'failed', 'canceled')
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [actor.delegation.projectId, bounded + 1]
    );
    return {
      schema: 'traceomics.automation.runs.v1',
      truncated: rows.length > bounded,
      // Runs listed here were submitted outside the delegated path; they are
      // labeled so an agent cannot present them as its own managed execution.
      runs: rows.slice(0, bounded).map((row) => ({
        id: row.id,
        origin: 'project-history',
        jobType: row.job_type,
        status: row.status,
        datasetId: row.dataset_id,
        analysisObjectId: row.analysis_object_id,
        resultAnalysisObjectId: row.result_analysis_object_id,
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        canceledAt: row.canceled_at,
      })),
    };
  }

  return { projectSummary, listDatasets, listRuns };
}

module.exports = { createAutomationReadModels };
