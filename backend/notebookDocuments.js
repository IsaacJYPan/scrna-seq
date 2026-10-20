'use strict';

const crypto = require('node:crypto');
const db = require('./pgDatabase');
const contract = import('../shared/notebookDocument.mjs');
const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const WRITE_ROLES = ['owner', 'admin', 'analyst'];
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const identity = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const iso = value => new Date(value).toISOString();
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const notFound = () => { throw failure('NOTEBOOK_NOT_FOUND', 'Notebook not found.', 404); };

function summary(row) {
  return { id: row.id, projectId: row.project_id, analysisId: row.analysis_id, visibility: 'project',
    title: row.title, version: Number(row.version), versionId: row.head_version_id, sha256: row.sha256,
    contentBytes: Number(row.content_bytes), cellCount: row.cell_count, codeCellCount: row.code_cell_count,
    defaultLanguage: row.default_language, createdByUserId: Number(row.created_by_user_id),
    updatedByUserId: Number(row.updated_by_user_id), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function document(head, revision) {
  return { ...summary(head), title: revision.title, version: Number(revision.version), versionId: revision.id,
    sha256: revision.sha256, contentBytes: Number(revision.content_bytes),
    cellCount: revision.content_json.cells.length,
    codeCellCount: revision.content_json.cells.filter(cell => cell.type === 'code').length,
    defaultLanguage: revision.content_json.defaultLanguage, content: revision.content_json,
    updatedByUserId: Number(revision.actor_user_id), updatedAt: iso(revision.created_at) };
}

async function validateScope(projectId, analysisId, documentId, versionId) {
  const schema = await contract;
  if (typeof projectId !== 'string' || !/^proj_[a-f0-9]{16,40}$/.test(projectId)
      || typeof analysisId !== 'string' || !/^ra_[a-f0-9]{24}$/.test(analysisId)
      || documentId !== undefined && (typeof documentId !== 'string' || !schema.NOTEBOOK_DOCUMENT_ID.test(documentId))
      || versionId !== undefined && (typeof versionId !== 'string' || !schema.NOTEBOOK_VERSION_ID.test(versionId))) {
    throw failure('INVALID_NOTEBOOK_ID', 'Choose a valid project, analysis, notebook and saved version.');
  }
}

function createNotebookDocumentService(database = db) {
  async function transaction(userId, projectId, analysisId, action) {
    await validateScope(projectId, analysisId);
    const client = await (await database.connect()).connect();
    try {
      await client.query('BEGIN');
      const user = (await client.query('SELECT id FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rows[0];
      if (!user) notFound();
      const project = (await client.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [projectId])).rows[0];
      if (!project) notFound();
      const member = (await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId])).rows[0];
      if (!member || !READ_ROLES.includes(member.role)) notFound();
      // SHARE conflicts with AS-01's archive UPDATE while independent documents
      // can save concurrently. KEY SHARE alone would not fence a status edit.
      const analysis = (await client.query('SELECT id,status FROM research_analyses WHERE id=$1 AND project_id=$2 FOR SHARE', [analysisId, projectId])).rows[0];
      if (!analysis) notFound();
      const result = await action(client, { member, analysis });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve uncertain original completion. */ }
      throw error;
    } finally { client.release(); }
  }

  function writable({ member, analysis }) {
    if (!WRITE_ROLES.includes(member.role)) throw failure('FORBIDDEN', 'Your project role allows reading notebooks but not editing them.', 403);
    if (analysis.status !== 'active') throw failure('ANALYSIS_ARCHIVED', 'This analysis is archived. Restore it before saving notebook changes; keep your current draft.', 409);
  }

  async function head(client, projectId, analysisId, documentId, lock = false) {
    const row = (await client.query(`SELECT * FROM research_documents WHERE id=$1 AND project_id=$2 AND analysis_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [documentId, projectId, analysisId])).rows[0];
    if (!row) notFound();
    return row;
  }

  async function revision(client, current, versionId) {
    const row = (await client.query(`SELECT * FROM research_document_revisions
      WHERE id=$1 AND document_id=$2 AND project_id=$3 AND analysis_id=$4`, [versionId, current.id, current.project_id, current.analysis_id])).rows[0];
    if (!row) notFound();
    return row;
  }

  async function receipt(client, userId, projectId, analysisId, requestId, requestHash) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notebook:${projectId}:${analysisId}:${userId}:${requestId}`]);
    const row = (await client.query(`SELECT * FROM research_document_submissions
      WHERE project_id=$1 AND analysis_id=$2 AND actor_user_id=$3 AND request_id=$4`, [projectId, analysisId, userId, requestId])).rows[0];
    if (!row) return null;
    if (row.request_sha256 !== requestHash) throw failure('NOTEBOOK_REQUEST_CONFLICT', 'This request already saved different notebook content. Check the original save before creating a new request.', 409);
    const current = await head(client, projectId, analysisId, row.document_id);
    const saved = await revision(client, current, row.version_id);
    return response(current, saved, row, true);
  }

  function response(current, saved, submitted, replayed = false) {
    return { document: document(current, saved), currentHead: summary(current), replayed,
      submission: { schema: 'traceomics.notebook-submission.v1', requestId: submitted.request_id,
        action: submitted.action, documentId: current.id, version: Number(saved.version), versionId: saved.id, sha256: saved.sha256 } };
  }

  async function append(client, userId, current, parsed, action, requestHash, canonical) {
    const versionId = action === 'create' ? current.head_version_id : identity('dv');
    const sha256 = digest(canonical), version = action === 'create' ? 1 : Number(current.version) + 1;
    const bytes = Buffer.byteLength(canonical, 'utf8');
    const saved = (await client.query(`INSERT INTO research_document_revisions
      (id,document_id,project_id,analysis_id,version,title,content_json,sha256,content_bytes,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [versionId, current.id, current.project_id, current.analysis_id, version, parsed.title, canonical, sha256, bytes, userId])).rows[0];
    const updated = action === 'create' ? current : (await client.query(`UPDATE research_documents SET title=$2,version=$3,head_version_id=$4,
      sha256=$5,content_bytes=$6,cell_count=$7,code_cell_count=$8,default_language=$9,updated_by_user_id=$10,updated_at=$11
      WHERE id=$1 RETURNING *`, [current.id, parsed.title, version, versionId, sha256, bytes,
      parsed.content.cells.length, parsed.content.cells.filter(cell => cell.type === 'code').length,
      parsed.content.defaultLanguage, userId, saved.created_at])).rows[0];
    const submitted = (await client.query(`INSERT INTO research_document_submissions
      (project_id,analysis_id,document_id,actor_user_id,request_id,action,request_sha256,expected_version,version_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [current.project_id, current.analysis_id, current.id,
      userId, parsed.requestId, action, requestHash, action === 'create' ? null : parsed.expectedVersion, versionId])).rows[0];
    return response(updated, saved, submitted);
  }

  async function create(userId, projectId, analysisId, input) {
    const schema = await contract, parsed = schema.normalizeNotebookCreate(input);
    const canonical = schema.canonicalNotebookContent(parsed.content);
    const requestHash = digest(JSON.stringify({ action: 'create', projectId, analysisId, ...parsed }));
    return transaction(userId, projectId, analysisId, async (client, access) => {
      const replay = await receipt(client, userId, projectId, analysisId, parsed.requestId, requestHash);
      if (replay) return { ...replay, created: false };
      writable(access);
      const current = (await client.query(`INSERT INTO research_documents
        (id,project_id,analysis_id,title,created_by_user_id,updated_by_user_id,version,head_version_id,sha256,content_bytes,cell_count,code_cell_count,default_language)
        VALUES($1,$2,$3,$4,$5,$5,1,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [identity('doc'), projectId, analysisId, parsed.title, userId, identity('dv'), digest(canonical), Buffer.byteLength(canonical, 'utf8'),
        parsed.content.cells.length, parsed.content.cells.filter(cell => cell.type === 'code').length, parsed.content.defaultLanguage])).rows[0];
      return { ...await append(client, userId, current, parsed, 'create', requestHash, canonical), created: true };
    });
  }

  async function save(userId, projectId, analysisId, documentId, input) {
    await validateScope(projectId, analysisId, documentId);
    const schema = await contract, parsed = schema.normalizeNotebookSave(input);
    const canonical = schema.canonicalNotebookContent(parsed.content);
    const requestHash = digest(JSON.stringify({ action: 'save', projectId, analysisId, documentId, ...parsed }));
    return transaction(userId, projectId, analysisId, async (client, access) => {
      const replay = await receipt(client, userId, projectId, analysisId, parsed.requestId, requestHash);
      if (replay) return replay;
      writable(access);
      const current = await head(client, projectId, analysisId, documentId, true);
      if (Number(current.version) !== parsed.expectedVersion) {
        throw Object.assign(failure('NOTEBOOK_VERSION_CONFLICT', 'This notebook changed while you were editing. Your draft has not replaced the newer version.', 409),
          { currentHead: summary(current), submittedExpectedVersion: parsed.expectedVersion });
      }
      return append(client, userId, current, parsed, 'save', requestHash, canonical);
    });
  }

  async function get(userId, projectId, analysisId, documentId, versionId) {
    await validateScope(projectId, analysisId, documentId, versionId);
    return transaction(userId, projectId, analysisId, async client => {
      const current = await head(client, projectId, analysisId, documentId);
      return { document: document(current, await revision(client, current, versionId ?? current.head_version_id)), currentHead: summary(current) };
    });
  }

  async function list(userId, projectId, analysisId, options = {}) {
    const limit = Number(options.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('INVALID_NOTEBOOK_PAGE', 'Choose a notebook page size from 1 to 100.');
    let cursor;
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 256) throw new Error();
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string'
            || !/^\d{4}-\d\d-\d\dT/.test(cursor[0]) || !Number.isFinite(Date.parse(cursor[0]))
            || typeof cursor[1] !== 'string' || !(await contract).NOTEBOOK_DOCUMENT_ID.test(cursor[1])) throw new Error();
      } catch { throw failure('INVALID_NOTEBOOK_PAGE', 'The notebook page cursor is invalid.'); }
    }
    return transaction(userId, projectId, analysisId, async client => {
      const rows = (await client.query(`SELECT * FROM research_documents WHERE project_id=$1 AND analysis_id=$2
        ${cursor ? "AND (date_trunc('milliseconds',created_at),id)<($4::timestamptz,$5::text)" : ''}
        ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $3`, [projectId, analysisId, limit + 1, ...(cursor || [])])).rows;
      const selected = rows.slice(0, limit), last = selected.at(-1);
      return { documents: selected.map(summary), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([iso(last.created_at), last.id])).toString('base64url') : null };
    });
  }

  return { create, save, get, list,
    checkAccess: (userId, projectId, analysisId) => transaction(userId, projectId, analysisId, async () => undefined) };
}

function notebookDocumentRoutes({ database = db, logger = console } = {}) {
  const express = require('express'), router = express.Router({ mergeParams: true });
  const service = createNotebookDocumentService(database);
  function sendError(res, error) {
    if ([400, 403, 404, 409, 413, 415].includes(error.status)) {
      return res.status(error.status).json({ error: error.message, code: error.code,
        ...(error.currentHead ? { currentHead: error.currentHead, submittedExpectedVersion: error.submittedExpectedVersion } : {}) });
    }
    const code = String(error.code || 'REQUEST_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 64);
    logger.error?.(`[NotebookDocuments] Request failed (${code}).`);
    return res.status(500).json({ error: 'This notebook save could not be confirmed. Keep your draft and retry the same request before saving again.' });
  }
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    next();
  });
  const parse = express.json({ limit: 2 * 1024 * 1024, inflate: false, strict: true,
    type: ['application/json', 'application/*+json'] });
  router.use(async (req, res, next) => {
    if (!['POST', 'PUT'].includes(req.method)) return next();
    try {
      await validateScope(req.params.projectId, req.params.analysisId);
      await service.checkAccess(req.user.id, req.params.projectId, req.params.analysisId);
      if (!req.is(['application/json', 'application/*+json'])) throw failure('INVALID_NOTEBOOK_BODY', 'Notebook saves require a JSON body.', 415);
      return parse(req, res, error => {
        if (!error) return next();
        const status = error.type === 'entity.too.large' ? 413 : error.status === 415 ? 415 : 400;
        return sendError(res, failure('INVALID_NOTEBOOK_BODY', status === 413 ? 'Notebook request must contain at most 2 MiB of JSON.'
          : status === 415 ? 'Compressed notebook request bodies are not supported.' : 'Notebook request must be valid JSON.', status));
      });
    } catch (error) { return sendError(res, error); }
  });
  const route = action => async (req, res) => {
    try {
      const { created, ...result } = await action(req);
      return res.status(created === true ? 201 : 200).json(result);
    } catch (error) { return sendError(res, error); }
  };
  router.get('/', route(req => service.list(req.user.id, req.params.projectId, req.params.analysisId, req.query)));
  router.post('/', route(req => service.create(req.user.id, req.params.projectId, req.params.analysisId, req.body)));
  router.get('/:documentId/versions/:versionId', route(req => service.get(req.user.id, req.params.projectId, req.params.analysisId, req.params.documentId, req.params.versionId)));
  router.get('/:documentId', route(req => service.get(req.user.id, req.params.projectId, req.params.analysisId, req.params.documentId)));
  router.put('/:documentId', route(req => service.save(req.user.id, req.params.projectId, req.params.analysisId, req.params.documentId, req.body)));
  return router;
}

module.exports = { createNotebookDocumentService, notebookDocumentRoutes, READ_ROLES, WRITE_ROLES };
