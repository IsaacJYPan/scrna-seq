'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const db = require('./pgDatabase');
const config = require('./config');
const storage = require('./storage');
const contract = import('../shared/analysisAttachment.mjs');
const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const WRITE_ROLES = ['owner', 'admin', 'analyst'];
const FORMATS = ['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const time = value => new Date(value).toISOString();
const identity = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const notFound = () => { throw failure('ANALYSIS_ATTACHMENT_NOT_FOUND', 'Analysis attachment not found.', 404); };
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const headSql = `SELECT h.id AS attachment_id,h.head_revision_id,h.created_at AS attachment_created_at,r.* FROM research_analysis_attachments h
  JOIN research_analysis_attachment_revisions r ON r.id=h.head_revision_id AND r.attachment_id=h.id
  WHERE h.project_id=$1 AND h.analysis_id=$2`;

function createAnalysisAttachmentService(database = db, provider = storage.createLocalStorageProvider()) {
  const writable = context => WRITE_ROLES.includes(context.member.role) && context.analysis.status === 'active'
    && !context.user.is_demo_guest && !config.demoMode();
  async function transaction(userId, projectId, analysisId, action, fence = false) {
    if (typeof projectId !== 'string' || !/^proj_[a-f0-9]{16,40}$/.test(projectId)
        || typeof analysisId !== 'string' || !/^ra_[a-f0-9]{24}$/.test(analysisId)) notFound();
    const client = await (await database.connect()).connect(); let committing = false, destroy = false;
    try {
      await client.query('BEGIN');
      const user = (await client.query('SELECT id,is_demo_guest FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rows[0];
      if (!user) notFound();
      if (!(await client.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [projectId])).rowCount) notFound();
      const member = (await client.query('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 FOR SHARE', [projectId, userId])).rows[0];
      if (!member || !READ_ROLES.includes(member.role)) notFound();
      const analysis = (await client.query('SELECT id,status FROM research_analyses WHERE project_id=$1 AND id=$2 FOR SHARE', [projectId, analysisId])).rows[0];
      if (!analysis) notFound();
      // Serialize independent attachment admissions to make the collection bound
      // atomic, without advancing or replacing the analysis draft's CAS version.
      if (fence) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`analysis-attachment:${projectId}:${analysisId}`]);
      const result = await action(client, { user, member, analysis });
      committing = true; await client.query('COMMIT'); committing = false;
      return result;
    } catch (error) {
      destroy = committing;
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
      throw error;
    } finally { client.release(destroy); }
  }
  function revision(row) {
    return { id: row.id, attachmentId: row.attachment_id, revisionNumber: Number(row.revision_number),
      reference: row.reference_json, caption: row.caption, suppliedOrigin: row.supplied_origin_json,
      createdByUserId: Number(row.actor_user_id), createdAt: time(row.created_at) };
  }
  function eligible(row, projectId) {
    return row && /^av_[a-f0-9]{24}$/.test(row.id) && /^[a-f0-9]{64}$/.test(row.checksum_sha256)
      && FORMATS.includes(row.format_json?.id) && row.format_json.version === '1'
      && Number.isSafeInteger(Number(row.size_bytes)) && Number(row.size_bytes) >= 0 && Number(row.size_bytes) <= 200 * 1024 * 1024
      && storage.isProjectStorageKey(row.storage_key, { projectId, kind: 'artifacts' });
  }
  async function sourceAccess(client, userId, projectId, row) {
    // The actor was required to own this exact source at admission. An attachment
    // shares its caption/reference, never the owner's filename, path or bytes.
    if (Number(row.actor_user_id) !== Number(userId)) return 'restricted';
    const source = (await client.query('SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2 AND id=$3',
      [projectId, userId, row.reference_json.versionId])).rows[0];
    if (!eligible(source, projectId) || source.checksum_sha256 !== row.reference_json.sha256) return 'unavailable';
    try {
      const stat = await fs.lstat(provider.resolveKey(source.storage_key));
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === Number(source.size_bytes) ? 'available' : 'unavailable';
    } catch { return 'unavailable'; }
  }
  async function item(client, userId, projectId, row) {
    return { id: row.attachment_id, headRevisionId: row.head_revision_id, revision: revision(row),
      sourceAccess: await sourceAccess(client, userId, projectId, row) };
  }
  async function result(client, context, userId, projectId, analysisId, row, replayed) {
    const current = (await client.query(`${headSql} AND h.id=$3`, [projectId, analysisId, row.attachment_id])).rows[0];
    if (!current) throw failure('ANALYSIS_ATTACHMENT_RECEIPT_UNAVAILABLE', 'The accepted attachment is recorded but its current head could not be read. Keep the original request and check again.', 500);
    return { projectId, analysisId, canWrite: writable(context), requestId: row.request_id,
      requestSha256: row.request_sha256, replayed, acceptedRevision: revision(row), attachment: await item(client, userId, projectId, current) };
  }
  async function create(userId, projectId, analysisId, input) {
    const schema = await contract, parsed = schema.normalizeAnalysisAttachmentCreate(input);
    const hash = digest(schema.canonicalAnalysisAttachmentContent(parsed));
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const accepted = (await client.query(`SELECT * FROM research_analysis_attachment_revisions
        WHERE project_id=$1 AND analysis_id=$2 AND actor_user_id=$3 AND request_id=$4`, [projectId, analysisId, userId, parsed.requestId])).rows[0];
      if (accepted) {
        if (accepted.request_sha256 !== hash) throw failure('ANALYSIS_ATTACHMENT_REQUEST_CONFLICT', 'This request already attached different content. Keep its original caption, source and origin notes to recover it.', 409);
        return result(client, context, userId, projectId, analysisId, accepted, true);
      }
      if (!WRITE_ROLES.includes(context.member.role)) throw failure('FORBIDDEN', 'Current project write access is required to attach a new result.', 403);
      if (context.analysis.status !== 'active') throw failure('ANALYSIS_ARCHIVED', 'Restore this archived analysis before attaching a new result.', 409);
      if (context.user.is_demo_guest || config.demoMode()) throw failure('FORBIDDEN', 'This deployment does not allow new result attachments.', 403);
      const count = (await client.query('SELECT COUNT(*)::int AS n FROM research_analysis_attachments WHERE project_id=$1 AND analysis_id=$2', [projectId, analysisId])).rows[0].n;
      if (count >= schema.ANALYSIS_ATTACHMENT_LIMITS.attachments) throw failure('ANALYSIS_ATTACHMENT_LIMIT', 'This analysis already has 200 attachments. Keep the exact saved source for another analysis.', 409);
      const source = (await client.query('SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2 AND id=$3 FOR KEY SHARE',
        [projectId, userId, parsed.reference.versionId])).rows[0];
      if (!eligible(source, projectId) || source.checksum_sha256 !== parsed.reference.sha256) {
        throw failure('ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE', 'Choose an exact CSV, TSV, PNG or JPEG managed version available to your own account.', 404);
      }
      let opened;
      try { opened = await provider.openVerifiedRead(source.storage_key, { checksumSha256: parsed.reference.sha256, sizeBytes: Number(source.size_bytes) }); }
      catch { throw failure('ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE', 'The exact saved result bytes could not be verified. Keep its reference and restore or inspect the source before attaching it.', 409); }
      finally { if (opened) await opened.handle.close(); }
      const attachmentId = identity('raa'), revisionId = identity('rar');
      await client.query(`INSERT INTO research_analysis_attachments(id,project_id,analysis_id,created_by_user_id,head_revision_id,revision_number)
        VALUES($1,$2,$3,$4,$5,1)`, [attachmentId, projectId, analysisId, userId, revisionId]);
      const saved = (await client.query(`INSERT INTO research_analysis_attachment_revisions
        (id,attachment_id,project_id,analysis_id,revision_number,actor_user_id,request_id,request_sha256,reference_json,caption,supplied_origin_json)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [revisionId, attachmentId, projectId, analysisId, userId, parsed.requestId, hash, parsed.reference, parsed.caption, parsed.suppliedOrigin])).rows[0];
      return result(client, context, userId, projectId, analysisId, saved, false);
    }, true);
  }
  async function getRequest(userId, projectId, analysisId, requestId) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) notFound();
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const row = (await client.query(`SELECT * FROM research_analysis_attachment_revisions
        WHERE project_id=$1 AND analysis_id=$2 AND actor_user_id=$3 AND request_id=$4`, [projectId, analysisId, userId, requestId.toLowerCase()])).rows[0];
      if (!row) throw failure('ANALYSIS_ATTACHMENT_REQUEST_NOT_FOUND', 'No accepted attachment receipt is available to this account. A missing receipt does not rule out an in-flight request; keep its original UUID and content.', 404);
      return result(client, context, userId, projectId, analysisId, row, true);
    }, true);
  }
  function page(options, prefix) {
    const limit = Number(options.limit ?? 30);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30 || Object.keys(options).some(key => !['limit', 'cursor'].includes(key))) {
      throw failure('INVALID_ANALYSIS_ATTACHMENT_PAGE', 'Choose an attachment page size from 1 to 30.');
    }
    let cursor;
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw new Error();
        cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || time(cursor[0]) !== cursor[0]
            || typeof cursor[1] !== 'string' || !new RegExp(`^${prefix}_[a-f0-9]{24}$`).test(cursor[1])) throw new Error();
      } catch { throw failure('INVALID_ANALYSIS_ATTACHMENT_PAGE', 'The attachment page cursor is invalid.'); }
    }
    return { limit, cursor };
  }
  const nextCursor = (rows, limit, last, id, createdAt = last?.created_at) => rows.length > limit ? Buffer.from(JSON.stringify([time(createdAt), id])).toString('base64url') : null;
  async function list(userId, projectId, analysisId, options = {}) {
    const { limit, cursor } = page(options, 'raa');
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const rows = (await client.query(`${headSql} ${cursor ? "AND (date_trunc('milliseconds',h.created_at),h.id)<($4::timestamptz,$5::text)" : ''}
        ORDER BY date_trunc('milliseconds',h.created_at) DESC,h.id DESC LIMIT $3`, [projectId, analysisId, limit + 1, ...(cursor || [])])).rows;
      const selected = rows.slice(0, limit), last = selected.at(-1);
      return { projectId, analysisId, canWrite: writable(context), attachments: await Promise.all(selected.map(row => item(client, userId, projectId, row))),
        nextCursor: nextCursor(rows, limit, last, last?.attachment_id, last?.attachment_created_at) };
    });
  }
  async function options(userId, projectId, analysisId, values = {}) {
    const { limit, cursor } = page(values, 'av');
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const rows = (await client.query(`SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2
        AND format_json->>'id'=ANY($3::text[]) AND format_json->>'version'='1' AND size_bytes BETWEEN 0 AND 209715200
        ${cursor ? "AND (date_trunc('milliseconds',created_at),id)<($5::timestamptz,$6::text)" : ''}
        ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $4`, [projectId, userId, FORMATS, limit + 1, ...(cursor || [])])).rows;
      const selected = rows.slice(0, limit), last = selected.at(-1);
      return { projectId, analysisId, canWrite: writable(context), items: selected.filter(row => eligible(row, projectId)).map(row => ({
        reference: { kind: 'artifact-version', versionId: row.id, sha256: row.checksum_sha256 },
        name: [...String(row.name).replace(/[\p{Cc}\p{Cf}]/gu, ' ')].slice(0, 160).join(''),
        format: { id: row.format_json.id, version: row.format_json.version }, sizeBytes: Number(row.size_bytes), createdAt: time(row.created_at) })),
      nextCursor: nextCursor(rows, limit, last, last?.id) };
    });
  }
  return { create, getRequest, list, options };
}
module.exports = { createAnalysisAttachmentService };
