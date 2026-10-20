'use strict';

const crypto = require('node:crypto');
const db = require('./pgDatabase');
const storage = require('./storage');
const contract = import('../shared/researchAnalysis.mjs');
const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const WRITE_ROLES = ['owner', 'admin', 'analyst'];
const SOURCE_SQL = `
  SELECT id,checksum_sha256 AS sha,size_bytes::text AS bytes,storage_key AS key,NULL::text AS object_id,FALSE AS checkpoint,
    name,artifact_type AS type,created_at FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2
  UNION ALL SELECT id,sha256,file_size_bytes::text,internal_storage_key,NULL,FALSE,original_filename,'file',created_at
    FROM expert_r_private_inputs WHERE project_id=$1 AND owner_user_id=$2
  UNION ALL SELECT artifact.id,artifact.descriptor_json->>'sha256',artifact.descriptor_json->>'sizeBytes',artifact.storage_key,NULL,FALSE,
    'Saved workflow output',artifact.descriptor_json->>'type',artifact.created_at
    FROM workflow_artifacts artifact JOIN jobs job ON job.id=artifact.job_id
    WHERE artifact.project_id=$1 AND artifact.owner_user_id=$2 AND job.project_id=$1 AND job.status='completed'
  UNION ALL SELECT artifact.id,artifact.checksum_sha256,artifact.size_bytes::text,artifact.storage_uri,
    COALESCE(artifact.result_analysis_object_id,artifact.analysis_object_id,job.result_analysis_object_id,job.analysis_object_id),artifact.artifact_type IN ('checkpoint','result_checkpoint'),
    COALESCE(artifact.name,'Saved analysis result'),artifact.artifact_type,artifact.created_at
    FROM job_artifacts artifact JOIN jobs job ON job.id=artifact.job_id
    WHERE artifact.project_id=$1 AND job.project_id=$1 AND artifact.created_by_user_id=$2
      AND artifact.storage_kind='local_internal' AND artifact.status='available' AND job.status='completed'`;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cleanReference = ref => ref.kind === 'analysis-object'
  ? { kind: ref.kind, analysisObjectId: ref.analysisObjectId, checkpointVersionId: ref.checkpointVersionId, sha256: ref.sha256 }
  : { kind: ref.kind, versionId: ref.versionId, sha256: ref.sha256 };
const referenceKey = ref => JSON.stringify(cleanReference(ref));
const time = value => new Date(value).toISOString();
function error(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function notFound() { throw error('RESEARCH_ANALYSIS_NOT_FOUND', 'Analysis not found.', 404); }
function createResearchAnalysisService(database = db) {
  async function transaction(userId, projectId, roles, action) {
    const client = await (await database.connect()).connect();
    try {
      await client.query('BEGIN');
      // User -> project -> membership follows demo cleanup/member administration
      // ordering. Membership remains locked until the document write commits.
      const user = (await client.query('SELECT id FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rows[0];
      if (!user) notFound();
      const project = (await client.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [projectId])).rows[0];
      if (!project) notFound();
      const member = (await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId])).rows[0];
      if (!member) notFound();
      if (!roles.includes(member.role)) throw error('FORBIDDEN', 'Your project role allows reading analyses but not editing them.', 403);
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (failure) { await client.query('ROLLBACK'); throw failure; }
    finally { client.release(); }
  }
  // Current managed files and checkpoints are private to their owners. Sharing a
  // container never broadens source access. Publication adapters can extend this
  // resolver later using their own explicit source permission, not membership.
  async function accessibleReferences(client, userId, projectId, references) {
    if (!references.length) return new Set();
    const ids = [...new Set(references.map(ref => ref.versionId || ref.checkpointVersionId))];
    const rows = (await client.query(`SELECT * FROM (${SOURCE_SQL}) source WHERE id=ANY($3::text[])`, [projectId, userId, ids])).rows;
    const byId = new Map(rows.filter(row => /^[a-f0-9]{64}$/.test(row.sha || '') && Number.isSafeInteger(Number(row.bytes))
      && Number(row.bytes) >= 0 && storage.isProjectStorageKey(row.key, { projectId })).map(row => [row.id, row]));
    const objectIds = [...new Set(references.filter(ref => ref.kind === 'analysis-object').map(ref => ref.analysisObjectId))];
    const ownedObjects = objectIds.length ? new Set((await client.query('SELECT id FROM analysis_objects WHERE project_id=$1 AND owner_user_id=$2 AND id=ANY($3::text[])', [projectId, userId, objectIds])).rows.map(row => row.id)) : new Set();
    return new Set(references.filter(ref => {
      const source = byId.get(ref.versionId || ref.checkpointVersionId);
      return source && source.sha === ref.sha256 && (ref.kind !== 'analysis-object'
        || source.checkpoint && source.object_id === ref.analysisObjectId && ownedObjects.has(ref.analysisObjectId));
    }).map(referenceKey));
  }
  function fromRow(row, allowed) {
    return { id: row.id, projectId: row.project_id, createdByUserId: Number(row.created_by_user_id),
      name: row.name, description: row.description, status: row.status, version: Number(row.version),
      references: row.references_json.map(ref => ({ reference: cleanReference(ref), access: allowed.has(referenceKey(ref)) ? 'available' : 'restricted' })),
      studyDesignRef: row.study_design_ref_json || null, createdAt: time(row.created_at), updatedAt: time(row.updated_at) };
  }
  async function display(client, userId, projectId, rows) {
    const allowed = await accessibleReferences(client, userId, projectId, rows.flatMap(row => row.references_json));
    return rows.map(row => fromRow(row, allowed));
  }
  async function snapshot(client, row, userId) {
    const value = { id: row.id, projectId: row.project_id, createdByUserId: Number(row.created_by_user_id), name: row.name,
      description: row.description, status: row.status, version: Number(row.version), references: row.references_json,
      studyDesignRef: row.study_design_ref_json || null, createdAt: time(row.created_at), updatedAt: time(row.updated_at) };
    await client.query(`INSERT INTO research_analysis_revisions(analysis_id,project_id,version,actor_user_id,snapshot_json)
      VALUES($1,$2,$3,$4,$5)`, [row.id, row.project_id, row.version, userId, value]);
  }
  async function create(userId, projectId, input) {
    const parsed = (await contract).normalizeResearchAnalysisCreate(input);
    const { requestId, ...content } = parsed;
    const requestHash = digest(content);
    return transaction(userId, projectId, WRITE_ROLES, async client => {
      let row = (await client.query('SELECT * FROM research_analyses WHERE project_id=$1 AND created_by_user_id=$2 AND request_id=$3', [projectId, userId, requestId])).rows[0];
      if (row) {
        if (row.request_sha256 !== requestHash) throw error('ANALYSIS_REQUEST_CONFLICT', 'This request already created a different analysis. Use its original fields to recover it, or create a new request.', 409);
        return { analysis: (await display(client, userId, projectId, [row]))[0], created: false };
      }
      const allowed = await accessibleReferences(client, userId, projectId, content.references);
      if (content.references.some(ref => !allowed.has(referenceKey(ref)))) throw error('ANALYSIS_REFERENCE_NOT_FOUND', 'A selected exact reference is unavailable or not accessible to your account.', 404);
      const inserted = await client.query(`INSERT INTO research_analyses(id,project_id,created_by_user_id,request_id,request_sha256,name,description,references_json,study_design_ref_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(project_id,created_by_user_id,request_id) DO NOTHING RETURNING *`,
      ['ra_' + crypto.randomBytes(12).toString('hex'), projectId, userId, requestId, requestHash, content.name, content.description, JSON.stringify(content.references), content.studyDesignRef]);
      row = inserted.rows[0];
      if (!row) {
        row = (await client.query('SELECT * FROM research_analyses WHERE project_id=$1 AND created_by_user_id=$2 AND request_id=$3', [projectId, userId, requestId])).rows[0];
        if (!row || row.request_sha256 !== requestHash) throw error('ANALYSIS_REQUEST_CONFLICT', 'This request already created a different analysis.', 409);
      } else await snapshot(client, row, userId);
      return { analysis: (await display(client, userId, projectId, [row]))[0], created: Boolean(inserted.rows[0]) };
    });
  }
  async function get(userId, projectId, analysisId) {
    return transaction(userId, projectId, READ_ROLES, async client => {
      const row = (await client.query('SELECT * FROM research_analyses WHERE id=$1 AND project_id=$2', [analysisId, projectId])).rows[0];
      if (!row) notFound();
      return { analysis: (await display(client, userId, projectId, [row]))[0] };
    });
  }
  async function list(userId, projectId, options = {}) {
    const status = options.status ?? 'active';
    const limit = Number(options.limit ?? 50);
    if (!['active', 'archived', 'all'].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error('INVALID_ANALYSIS_PAGE', 'Choose an analysis status and page size from 1 to 100.');
    let cursor;
    if (options.cursor) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 256) throw new Error();
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(cursor[0])
          || !Number.isFinite(Date.parse(cursor[0])) || typeof cursor[1] !== 'string' || !(await contract).RESEARCH_ANALYSIS_ID.test(cursor[1])) throw new Error();
      } catch { throw error('INVALID_ANALYSIS_PAGE', 'The analysis page cursor is invalid.'); }
    }
    return transaction(userId, projectId, READ_ROLES, async client => {
      const rows = (await client.query(`SELECT * FROM research_analyses WHERE project_id=$1
        AND ($2='all' OR status=$2) ${cursor ? "AND (date_trunc('milliseconds',created_at),id)<($4::timestamptz,$5::text)" : ''}
        ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $3`, [projectId, status, limit + 1, ...(cursor || [])])).rows;
      const selected = rows.slice(0, limit);
      const last = selected.at(-1);
      return { analyses: await display(client, userId, projectId, selected),
        nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([time(last.created_at), last.id])).toString('base64url') : null };
    });
  }
  async function referenceOptions(userId, projectId, options = {}) {
    const limit = Number(options.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error('INVALID_ANALYSIS_PAGE', 'Choose a reference page size from 1 to 100.');
    let cursor;
    if (options.cursor) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 256) throw new Error();
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || !Number.isFinite(Date.parse(cursor[0]))
          || typeof cursor[1] !== 'string' || !/^(?:av|art|eri)_[a-f0-9]{16,40}$/.test(cursor[1])) throw new Error();
      } catch { throw error('INVALID_ANALYSIS_PAGE', 'The reference page cursor is invalid.'); }
    }
    return transaction(userId, projectId, READ_ROLES, async client => {
      const rows = (await client.query(`SELECT * FROM (${SOURCE_SQL}) source
        ${cursor ? "WHERE (date_trunc('milliseconds',created_at),id)<($4::timestamptz,$5::text)" : ''}
        ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $3`, [projectId, userId, limit + 1, ...(cursor || [])])).rows;
      const selected = rows.slice(0, limit);
      const objectIds = selected.filter(row => row.checkpoint && row.object_id).map(row => row.object_id);
      const owned = objectIds.length ? new Set((await client.query('SELECT id FROM analysis_objects WHERE project_id=$1 AND owner_user_id=$2 AND id=ANY($3::text[])', [projectId, userId, objectIds])).rows.map(row => row.id)) : new Set();
      const candidates = selected.filter(row => /^[a-f0-9]{64}$/.test(row.sha || '') && Number.isSafeInteger(Number(row.bytes))
        && Number(row.bytes) >= 0 && storage.isProjectStorageKey(row.key, { projectId }));
      const last = selected.at(-1);
      return { options: candidates.map(row => ({ reference: row.checkpoint && owned.has(row.object_id)
        ? { kind: 'analysis-object', analysisObjectId: row.object_id, checkpointVersionId: row.id, sha256: row.sha }
        : { kind: 'artifact-version', versionId: row.id, sha256: row.sha },
      label: [...String(row.name || 'Saved result')].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('').slice(0, 160),
      type: String(row.type || 'file').slice(0, 80), createdAt: time(row.created_at) })),
      nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([time(last.created_at), last.id])).toString('base64url') : null };
    });
  }
  async function patch(userId, projectId, analysisId, input) {
    const parsed = (await contract).normalizeResearchAnalysisPatch(input);
    return transaction(userId, projectId, WRITE_ROLES, async client => {
      const row = (await client.query('SELECT * FROM research_analyses WHERE id=$1 AND project_id=$2 FOR UPDATE', [analysisId, projectId])).rows[0];
      if (!row) notFound();
      if (Number(row.version) !== parsed.expectedVersion) {
        const conflict = error('ANALYSIS_VERSION_CONFLICT', 'This analysis changed while you were editing. Your draft has not replaced the newer version.', 409);
        conflict.analysis = (await display(client, userId, projectId, [row]))[0];
        conflict.submittedExpectedVersion = parsed.expectedVersion;
        throw conflict;
      }
      const references = parsed.references ?? row.references_json;
      const existing = new Set(row.references_json.map(referenceKey));
      const added = references.filter(ref => !existing.has(referenceKey(ref)));
      const allowed = await accessibleReferences(client, userId, projectId, added);
      if (added.some(ref => !allowed.has(referenceKey(ref)))) throw error('ANALYSIS_REFERENCE_NOT_FOUND', 'A selected exact reference is unavailable or not accessible to your account.', 404);
      const updated = (await client.query(`UPDATE research_analyses SET name=$3,description=$4,status=$5,references_json=$6,
        study_design_ref_json=$7,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND project_id=$2 RETURNING *`,
      [analysisId, projectId, parsed.name ?? row.name, parsed.description ?? row.description, parsed.status ?? row.status,
        JSON.stringify(references), Object.hasOwn(parsed, 'studyDesignRef') ? parsed.studyDesignRef : row.study_design_ref_json])).rows[0];
      await snapshot(client, updated, userId);
      return { analysis: (await display(client, userId, projectId, [updated]))[0] };
    });
  }
  return { create, list, get, patch, referenceOptions };
}
function researchAnalysisRoutes({ database = db, logger = console } = {}) {
  const router = require('express').Router({ mergeParams: true });
  const service = createResearchAnalysisService(database);
  const route = action => async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const { created, ...result } = await action(req);
      res.status(created === true ? 201 : 200).json(result);
    } catch (failure) {
      if ([400, 403, 404, 409].includes(failure.status)) {
        return res.status(failure.status).json({ error: failure.message, code: failure.code,
          ...(failure.code === 'ANALYSIS_VERSION_CONFLICT' ? {
            analysis: failure.analysis, submittedExpectedVersion: failure.submittedExpectedVersion,
          } : {}) });
      }
      const code = String(failure.code || 'REQUEST_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 64);
      logger.error?.(`[ResearchAnalyses] Request failed (${code}).`);
      return res.status(500).json({ error: 'This analysis request could not be confirmed. Reload the analysis before saving again, or retry creation with the same request.' });
    }
  };
  router.get('/', route(req => service.list(req.user.id, req.params.projectId, req.query)));
  router.post('/', route(req => service.create(req.user.id, req.params.projectId, req.body)));
  router.get('/reference-options', route(req => service.referenceOptions(req.user.id, req.params.projectId, req.query)));
  router.get('/:analysisId', route(req => service.get(req.user.id, req.params.projectId, req.params.analysisId)));
  router.patch('/:analysisId', route(req => service.patch(req.user.id, req.params.projectId, req.params.analysisId, req.body)));
  return router;
}
module.exports = { createResearchAnalysisService, researchAnalysisRoutes, READ_ROLES, WRITE_ROLES };
