'use strict';

// Project-scoped provenance records and saved figures. Every read and write
// checks the caller's project role, and every cross-reference (dataset, analysis
// object, job, provenance) must belong to the same project.

const PROVENANCE_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const PROVENANCE_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const FIGURE_WRITE_ROLES = ['owner', 'admin', 'analyst'];
const FIGURE_READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];

function createProjectRecordsStore({
  query, codedError, requireProjectRole, assertPlainObject, parseJson,
  generateProvenanceId, generateFigureId,
  getDatasetRow, getProjectAnalysisObjectRow, getProjectJobRow,
}) {
  async function getProjectProvenanceRow(provenanceId, projectId) {
    if (typeof provenanceId !== 'string' || provenanceId === '') return null;
    const { rows } = await query(
      'SELECT * FROM provenance WHERE id = $1 AND project_id = $2',
      [String(provenanceId), String(projectId)]
    );
    return rowToProjectProvenance(rows[0]);
  }

  async function getProjectFigureRow(figureId, projectId) {
    if (typeof figureId !== 'string' || figureId === '') return null;
    const { rows } = await query(
      'SELECT * FROM figure_collection WHERE id = $1 AND project_id = $2',
      [String(figureId), String(projectId)]
    );
    return rowToProjectFigure(rows[0]);
  }

  function rowToProjectProvenance(row) {
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      createdByUserId: Number(row.created_by_user_id),
      datasetId: row.dataset_id,
      analysisObjectId: row.analysis_object_id,
      jobId: row.job_id,
      resultAnalysisObjectId: row.result_analysis_object_id,
      timestamp: row.timestamp,
      language: row.language,
      languageVersion: row.language_version,
      packages: parseJson(row.packages, []),
      script: row.script,
      parameters: parseJson(row.parameters, {}),
      parentIds: parseJson(row.parent_ids, []),
      operation: row.operation || 'unknown',
      createdAt: row.created_at
    };
  }

  function rowToProjectFigure(row) {
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      createdByUserId: Number(row.created_by_user_id),
      analysisObjectId: row.analysis_object_id,
      jobId: row.job_id,
      provenanceId: row.provenance_id,
      datasetId: row.dataset_id,
      plotType: row.plot_type,
      title: row.title,
      params: parseJson(row.params_json, {}),
      fileFormat: row.file_format,
      thumbnailB64: row.thumbnail_b64,
      collection: row.collection_name || '',
      tags: parseJson(row.tags_json, []),
      notes: row.notes || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at || null
    };
  }

  const MAX_FIGURE_TAGS = 20;
  const MAX_FIGURE_TAG_CHARS = 40;
  const MAX_FIGURE_COLLECTION_CHARS = 80;
  const MAX_FIGURE_TITLE_CHARS = 200;
  const MAX_FIGURE_NOTES_CHARS = 4000;
  const MAX_FIGURE_THUMBNAIL_CHARS = 2 * 1024 * 1024;

  // Normalise the organisation fields a figure can carry.
  function normalizeFigureOrganization(input = {}) {
    const out = {};
    if (input.title !== undefined) {
      if (typeof input.title !== 'string') throw codedError('INVALID_FIGURE', 'title must be a string.');
      out.title = input.title.trim().slice(0, MAX_FIGURE_TITLE_CHARS);
    }
    if (input.collection !== undefined) {
      if (input.collection !== null && typeof input.collection !== 'string') {
        throw codedError('INVALID_FIGURE', 'collection must be a string.');
      }
      out.collection = String(input.collection || '').trim().replace(/\s+/g, ' ').slice(0, MAX_FIGURE_COLLECTION_CHARS);
    }
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string')) {
        throw codedError('INVALID_FIGURE', 'tags must be an array of strings.');
      }
      const tags = [];
      for (const raw of input.tags) {
        const tag = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_FIGURE_TAG_CHARS);
        if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
      }
      if (tags.length > MAX_FIGURE_TAGS) throw codedError('INVALID_FIGURE', `A figure can have at most ${MAX_FIGURE_TAGS} tags.`);
      out.tags = tags;
    }
    if (input.notes !== undefined) {
      if (typeof input.notes !== 'string') throw codedError('INVALID_FIGURE', 'notes must be a string.');
      out.notes = input.notes.slice(0, MAX_FIGURE_NOTES_CHARS);
    }
    return out;
  }

  async function resolveSameProjectRefs(pid, input, { allowResult = false, allowProvenanceRef = false, allowParents = false } = {}) {
    const out = {};
    if (input.datasetId !== undefined && input.datasetId !== null) {
      if (typeof input.datasetId !== 'string' || !(await getDatasetRow(input.datasetId, pid))) {
        throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
      }
      out.datasetId = input.datasetId;
    }
    if (input.analysisObjectId !== undefined && input.analysisObjectId !== null) {
      if (typeof input.analysisObjectId !== 'string' || !(await getProjectAnalysisObjectRow(input.analysisObjectId, pid))) {
        throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
      }
      out.analysisObjectId = input.analysisObjectId;
    }
    if (input.jobId !== undefined && input.jobId !== null) {
      if (typeof input.jobId !== 'string' || !(await getProjectJobRow(input.jobId, pid))) {
        throw codedError('JOB_NOT_FOUND', 'Job not found.');
      }
      out.jobId = input.jobId;
    }
    if (allowResult && input.resultAnalysisObjectId !== undefined && input.resultAnalysisObjectId !== null) {
      if (typeof input.resultAnalysisObjectId !== 'string' || !(await getProjectAnalysisObjectRow(input.resultAnalysisObjectId, pid))) {
        throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
      }
      out.resultAnalysisObjectId = input.resultAnalysisObjectId;
    }
    if (allowProvenanceRef && input.provenanceId !== undefined && input.provenanceId !== null) {
      if (typeof input.provenanceId !== 'string' || !(await getProjectProvenanceRow(input.provenanceId, pid))) {
        throw codedError('PROVENANCE_NOT_FOUND', 'Provenance record not found.');
      }
      out.provenanceId = input.provenanceId;
    }
    if (allowParents && input.parentIds !== undefined && input.parentIds !== null) {
      if (!Array.isArray(input.parentIds)) throw codedError('INVALID_PARENT_IDS', 'parentIds must be an array.');
      for (const parentId of input.parentIds) {
        if (typeof parentId !== 'string' || !(await getProjectProvenanceRow(parentId, pid))) {
          throw codedError('PARENT_NOT_FOUND', 'Parent provenance record not found.');
        }
      }
      out.parentIds = input.parentIds.map(String);
    }
    return out;
  }

  async function createProjectProvenance(userId, projectId, input = {}) {
    const membership = await requireProjectRole(userId, projectId, PROVENANCE_WRITE_ROLES);
    const actor = membership.userId;
    const pid = String(projectId);
    const parameters = input.parameters === undefined ? {} : input.parameters;
    assertPlainObject(parameters, 'INVALID_PARAMETERS', 'parameters must be a plain JSON object.');
    const packages = input.packages === undefined ? [] : input.packages;
    if (!Array.isArray(packages)) throw codedError('INVALID_PACKAGES', 'packages must be an array.');
    const refs = await resolveSameProjectRefs(pid, input, { allowResult: true, allowParents: true });
    const id = generateProvenanceId();
    const { rows } = await query(
      `INSERT INTO provenance
         (id, user_email, project_id, created_by_user_id, dataset_id, analysis_object_id, job_id,
          result_analysis_object_id, timestamp, language, language_version, packages, script,
          parameters, parent_ids, operation)
       VALUES ($1, '', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        id, pid, Number(actor), refs.datasetId || null, refs.analysisObjectId || null,
        refs.jobId || null, refs.resultAnalysisObjectId || null,
        input.timestamp != null ? String(input.timestamp) : new Date().toISOString(),
        input.language != null ? String(input.language) : '',
        input.languageVersion != null ? String(input.languageVersion) : '',
        JSON.stringify(packages),
        input.script != null ? String(input.script) : '',
        JSON.stringify(parameters),
        JSON.stringify(refs.parentIds || []),
        input.operation != null ? String(input.operation) : 'unknown'
      ]
    );
    return rowToProjectProvenance(rows[0]);
  }

  async function listProjectProvenance(userId, projectId, filters = {}) {
    await requireProjectRole(userId, projectId, PROVENANCE_READ_ROLES);
    const clauses = ['project_id = $1'];
    const params = [String(projectId)];
    const allowed = { datasetId: 'dataset_id', analysisObjectId: 'analysis_object_id', jobId: 'job_id', operation: 'operation' };
    for (const [field, column] of Object.entries(allowed)) {
      if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
    }
    const { rows } = await query(`SELECT * FROM provenance WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`, params);
    return rows.map(rowToProjectProvenance);
  }

  async function getProjectProvenance(userId, projectId, provenanceId) {
    await requireProjectRole(userId, projectId, PROVENANCE_READ_ROLES);
    return getProjectProvenanceRow(provenanceId, projectId);
  }

  async function createProjectFigure(userId, projectId, input = {}) {
    const membership = await requireProjectRole(userId, projectId, FIGURE_WRITE_ROLES);
    const actor = membership.userId;
    const pid = String(projectId);
    const params = input.params === undefined ? {} : input.params;
    assertPlainObject(params, 'INVALID_PARAMETERS', 'params must be a plain JSON object.');
    const plotType = input.plotType === undefined || input.plotType === null ? 'Unknown' : input.plotType;
    if (typeof plotType !== 'string' || plotType === '') throw codedError('INVALID_PLOT_TYPE', 'plotType must be a non-empty string.');
    const thumbnail = input.thumbnailB64 != null ? String(input.thumbnailB64) : '';
    if (thumbnail && (thumbnail.length > MAX_FIGURE_THUMBNAIL_CHARS
        || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(thumbnail))) {
      throw codedError('INVALID_FIGURE', 'Figure previews must be a PNG, JPEG or WebP data URL under 2 MB.');
    }
    const refs = await resolveSameProjectRefs(pid, input, { allowProvenanceRef: true });
    const organization = normalizeFigureOrganization({
      collection: input.collection, tags: input.tags, notes: input.notes,
    });
    const id = generateFigureId();
    const { rows } = await query(
      `INSERT INTO figure_collection
         (id, user_email, project_id, created_by_user_id, analysis_object_id, job_id, provenance_id,
          dataset_id, plot_type, title, params_json, file_path, file_format, thumbnail_b64,
          collection_name, tags_json, notes)
       VALUES ($1, '', $2, $3, $4, $5, $6, $7, $8, $9, $10, '', $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        id, pid, Number(actor), refs.analysisObjectId || null, refs.jobId || null,
        refs.provenanceId || null, refs.datasetId || null, plotType,
        input.title != null ? String(input.title) : '',
        JSON.stringify(params),
        input.fileFormat != null ? String(input.fileFormat) : 'png',
        thumbnail,
        organization.collection || '',
        JSON.stringify(organization.tags || []),
        organization.notes || ''
      ]
    );
    return rowToProjectFigure(rows[0]);
  }

  async function listProjectFigures(userId, projectId, filters = {}) {
    await requireProjectRole(userId, projectId, FIGURE_READ_ROLES);
    const clauses = ['project_id = $1'];
    const params = [String(projectId)];
    const allowed = {
      analysisObjectId: 'analysis_object_id',
      jobId: 'job_id',
      provenanceId: 'provenance_id',
      datasetId: 'dataset_id',
      plotType: 'plot_type'
    };
    for (const [field, column] of Object.entries(allowed)) {
      if (filters[field]) { params.push(String(filters[field])); clauses.push(`${column} = $${params.length}`); }
    }
    const { rows } = await query(`SELECT * FROM figure_collection WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`, params);
    return rows.map(rowToProjectFigure);
  }

  async function getProjectFigure(userId, projectId, figureId) {
    await requireProjectRole(userId, projectId, FIGURE_READ_ROLES);
    return getProjectFigureRow(figureId, projectId);
  }

  // Organise a project figure: rename, caption, file into a collection, tag.
  // Owners/admins may edit any figure; analysts may edit the figures they saved.
  async function requireFigureEditor(userId, projectId, figureId, verb) {
    const membership = await requireProjectRole(userId, projectId, FIGURE_WRITE_ROLES);
    const existing = await getProjectFigureRow(figureId, projectId);
    if (!existing) throw codedError('FIGURE_NOT_FOUND', 'Figure not found.');
    if (!['owner', 'admin'].includes(membership.role) && existing.createdByUserId !== Number(membership.userId)) {
      throw codedError('FORBIDDEN', `Only the person who saved this figure, or a project owner or admin, can ${verb} it.`);
    }
    return existing;
  }

  async function updateProjectFigure(userId, projectId, figureId, input = {}) {
    const existing = await requireFigureEditor(userId, projectId, figureId, 'edit');
    const changes = normalizeFigureOrganization(input);
    const columns = { title: 'title', collection: 'collection_name', tags: 'tags_json', notes: 'notes' };
    const sets = [];
    const params = [String(figureId), String(projectId)];
    for (const [field, column] of Object.entries(columns)) {
      if (changes[field] === undefined) continue;
      params.push(field === 'tags' ? JSON.stringify(changes[field]) : changes[field]);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) return existing;
    const { rows } = await query(
      `UPDATE figure_collection SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 AND project_id = $2 RETURNING *`,
      params
    );
    return rowToProjectFigure(rows[0]);
  }

  async function removeProjectFigure(userId, projectId, figureId) {
    await requireFigureEditor(userId, projectId, figureId, 'remove');
    const result = await query('DELETE FROM figure_collection WHERE id = $1 AND project_id = $2',
      [String(figureId), String(projectId)]);
    return result.rowCount > 0;
  }

  return {
    createProjectProvenance,
    listProjectProvenance,
    getProjectProvenance,
    createProjectFigure,
    listProjectFigures,
    getProjectFigure,
    updateProjectFigure,
    removeProjectFigure,
  };
}

module.exports = {
  createProjectRecordsStore,
  PROVENANCE_WRITE_ROLES, PROVENANCE_READ_ROLES, FIGURE_WRITE_ROLES, FIGURE_READ_ROLES,
};
