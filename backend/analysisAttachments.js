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
      const user = (await client.query('SELECT id,is_demo_guest,display_name FROM users WHERE id=$1 FOR KEY SHARE', [userId])).rows[0];
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
      previousRevisionId: row.expected_head_revision_id || null,
      reference: row.reference_json, caption: row.caption, suppliedOrigin: row.supplied_origin_json,
      createdByUserId: Number(row.actor_user_id), createdAt: time(row.created_at) };
  }
  function eligible(row, projectId) {
    return row && /^av_[a-f0-9]{24}$/.test(row.id) && /^[a-f0-9]{64}$/.test(row.checksum_sha256)
      && FORMATS.includes(row.format_json?.id) && row.format_json.version === '1'
      && Number.isSafeInteger(Number(row.size_bytes)) && Number(row.size_bytes) >= 0 && Number(row.size_bytes) <= 200 * 1024 * 1024
      && storage.isProjectStorageKey(row.storage_key, { projectId, kind: 'artifacts' });
  }
  async function sourceAccesses(client, userId, projectId, rows) {
    // A caption correction can be authored by a collaborator. Source ownership
    // is captured independently and never follows the latest revision's actor.
    const owned = rows.filter(row => Number(row.source_owner_user_id) === Number(userId));
    const sources = owned.length ? (await client.query('SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2 AND id=ANY($3::text[])',
      [projectId, userId, [...new Set(owned.map(row => row.reference_json.versionId))]])).rows : [];
    const byId = new Map(sources.map(source => [source.id, source])), checks = new Map();
    return Promise.all(rows.map(async row => {
      if (Number(row.source_owner_user_id) !== Number(userId)) return 'restricted';
      const source = byId.get(row.reference_json.versionId);
      if (!eligible(source, projectId) || source.checksum_sha256 !== row.reference_json.sha256) return 'unavailable';
      if (!checks.has(source.id)) checks.set(source.id, (async () => {
        try {
          const stat = await fs.lstat(provider.resolveKey(source.storage_key));
          return stat.isFile() && !stat.isSymbolicLink() && stat.size === Number(source.size_bytes) ? 'available' : 'unavailable';
        } catch { return 'unavailable'; }
      })());
      return checks.get(source.id);
    }));
  }
  const sourceAccess = async (client, userId, projectId, row) => (await sourceAccesses(client, userId, projectId, [row]))[0];
  const itemFromRow = (row, access) => ({ id: row.attachment_id, headRevisionId: row.head_revision_id, revision: revision(row), sourceAccess: access });
  async function item(client, userId, projectId, row) {
    return itemFromRow(row, await sourceAccess(client, userId, projectId, row));
  }
  async function result(client, context, userId, projectId, analysisId, row, replayed) {
    const current = (await client.query(`${headSql} AND h.id=$3`, [projectId, analysisId, row.attachment_id])).rows[0];
    if (!current) throw failure('ANALYSIS_ATTACHMENT_RECEIPT_UNAVAILABLE', 'The accepted attachment is recorded but its current head could not be read. Keep the original request and check again.', 500);
    const access = await sourceAccesses(client, userId, projectId, [row, current]);
    return { projectId, analysisId, canWrite: writable(context), requestId: row.request_id,
      requestSha256: row.request_sha256, replayed, acceptedRevision: revision(row),
      acceptedSourceAccess: access[0], attachment: itemFromRow(current, access[1]) };
  }
  function assertWritable(context) {
    if (!WRITE_ROLES.includes(context.member.role)) throw failure('FORBIDDEN', 'Current project write access is required to attach or correct a result.', 403);
    if (context.analysis.status !== 'active') throw failure('ANALYSIS_ARCHIVED', 'Restore this archived analysis before attaching or correcting a result.', 409);
    if (context.user.is_demo_guest || config.demoMode()) throw failure('FORBIDDEN', 'This deployment does not allow new result attachment revisions.', 403);
  }
  async function assertHistoryCapacity(client, projectId, analysisId, attachmentId = null) {
    const limits = (await contract).ANALYSIS_ATTACHMENT_LIMITS;
    const count = (await client.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE attachment_id=$3)::int AS attachment
      FROM research_analysis_attachment_revisions WHERE project_id=$1 AND analysis_id=$2`, [projectId, analysisId, attachmentId])).rows[0];
    if (count.total >= limits.analysisRevisions || attachmentId && count.attachment >= limits.revisions) {
      throw failure('ANALYSIS_ATTACHMENT_HISTORY_LIMIT', 'This analysis or attachment has reached its retained revision limit. Earlier evidence is kept; save further work in another analysis.', 409);
    }
  }
  async function verifiedSource(client, userId, projectId, reference) {
    const source = (await client.query('SELECT * FROM managed_artifact_versions WHERE project_id=$1 AND owner_user_id=$2 AND id=$3 FOR KEY SHARE',
      [projectId, userId, reference.versionId])).rows[0];
    if (!eligible(source, projectId) || source.checksum_sha256 !== reference.sha256) {
      throw failure('ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE', 'Choose an exact CSV, TSV, PNG or JPEG managed version available to your own account.', 404);
    }
    let opened;
    try { opened = await provider.openVerifiedRead(source.storage_key, { checksumSha256: reference.sha256, sizeBytes: Number(source.size_bytes) }); }
    catch { throw failure('ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE', 'The exact saved result bytes could not be verified. Keep its reference and restore or inspect the source before attaching it.', 409); }
    finally { if (opened) await opened.handle.close(); }
  }
  async function acceptedRequest(client, userId, projectId, analysisId, requestId) {
    return (await client.query(`SELECT * FROM research_analysis_attachment_revisions
      WHERE project_id=$1 AND analysis_id=$2 AND actor_user_id=$3 AND request_id=$4`, [projectId, analysisId, userId, requestId])).rows[0];
  }
  function requestConflict() {
    throw failure('ANALYSIS_ATTACHMENT_REQUEST_CONFLICT', 'This request already identifies different attachment content or a different correction target. Keep the original request to recover its accepted revision.', 409);
  }
  async function head(client, projectId, analysisId, attachmentId) {
    if (typeof attachmentId !== 'string' || !(await contract).ANALYSIS_ATTACHMENT_ID.test(attachmentId)) notFound();
    const row = (await client.query(`${headSql} AND h.id=$3`, [projectId, analysisId, attachmentId])).rows[0];
    if (!row) notFound();
    return row;
  }
  async function create(userId, projectId, analysisId, input) {
    const schema = await contract, parsed = schema.normalizeAnalysisAttachmentCreate(input);
    const hash = digest(schema.canonicalAnalysisAttachmentContent(parsed));
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const accepted = await acceptedRequest(client, userId, projectId, analysisId, parsed.requestId);
      if (accepted) {
        if (accepted.action !== 'create' || accepted.request_sha256 !== hash) requestConflict();
        return result(client, context, userId, projectId, analysisId, accepted, true);
      }
      assertWritable(context);
      const count = (await client.query('SELECT COUNT(*)::int AS n FROM research_analysis_attachments WHERE project_id=$1 AND analysis_id=$2', [projectId, analysisId])).rows[0].n;
      if (count >= schema.ANALYSIS_ATTACHMENT_LIMITS.attachments) throw failure('ANALYSIS_ATTACHMENT_LIMIT', 'This analysis already has 200 attachments. Keep the exact saved source for another analysis.', 409);
      await assertHistoryCapacity(client, projectId, analysisId);
      await verifiedSource(client, userId, projectId, parsed.reference);
      const attachmentId = identity('raa'), revisionId = identity('rar');
      await client.query(`INSERT INTO research_analysis_attachments(id,project_id,analysis_id,created_by_user_id,head_revision_id,revision_number)
        VALUES($1,$2,$3,$4,$5,1)`, [attachmentId, projectId, analysisId, userId, revisionId]);
      const saved = (await client.query(`INSERT INTO research_analysis_attachment_revisions
        (id,attachment_id,project_id,analysis_id,revision_number,actor_user_id,source_owner_user_id,request_id,request_sha256,reference_json,caption,supplied_origin_json)
        VALUES($1,$2,$3,$4,1,$5,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [revisionId, attachmentId, projectId, analysisId, userId, parsed.requestId, hash, parsed.reference, parsed.caption, parsed.suppliedOrigin])).rows[0];
      return result(client, context, userId, projectId, analysisId, saved, false);
    }, true);
  }
  async function correct(userId, projectId, analysisId, attachmentId, input) {
    const schema = await contract, parsed = schema.normalizeAnalysisAttachmentCorrection(input);
    const hash = digest(schema.canonicalAnalysisAttachmentCorrection(attachmentId, parsed));
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const accepted = await acceptedRequest(client, userId, projectId, analysisId, parsed.requestId);
      if (accepted) {
        if (accepted.action !== 'correct' || accepted.attachment_id !== attachmentId || accepted.request_sha256 !== hash) requestConflict();
        return result(client, context, userId, projectId, analysisId, accepted, true);
      }
      assertWritable(context);
      const current = await head(client, projectId, analysisId, attachmentId);
      if (current.head_revision_id !== parsed.expectedHeadRevisionId) {
        throw Object.assign(failure('ANALYSIS_ATTACHMENT_HEAD_CONFLICT', 'This attachment changed while you were editing. Your correction has not replaced the newer revision.', 409), {
          attachment: await item(client, userId, projectId, current), submittedExpectedHeadRevisionId: parsed.expectedHeadRevisionId });
      }
      await assertHistoryCapacity(client, projectId, analysisId, attachmentId);
      const sameSource = current.reference_json.versionId === parsed.reference.versionId && current.reference_json.sha256 === parsed.reference.sha256;
      if (!sameSource) await verifiedSource(client, userId, projectId, parsed.reference);
      const revisionId = identity('rar'), sourceOwner = sameSource ? current.source_owner_user_id : userId;
      const saved = (await client.query(`INSERT INTO research_analysis_attachment_revisions
        (id,attachment_id,project_id,analysis_id,revision_number,actor_user_id,source_owner_user_id,request_id,request_sha256,action,expected_head_revision_id,reference_json,caption,supplied_origin_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'correct',$10,$11,$12,$13) RETURNING *`,
      [revisionId, attachmentId, projectId, analysisId, Number(current.revision_number) + 1, userId, sourceOwner, parsed.requestId,
        hash, parsed.expectedHeadRevisionId, parsed.reference, parsed.caption, parsed.suppliedOrigin])).rows[0];
      const updated = await client.query(`UPDATE research_analysis_attachments SET head_revision_id=$2,revision_number=revision_number+1,updated_at=clock_timestamp()
        WHERE id=$1 AND project_id=$3 AND analysis_id=$4 AND head_revision_id=$5`, [attachmentId, revisionId, projectId, analysisId, parsed.expectedHeadRevisionId]);
      if (updated.rowCount !== 1) throw failure('ANALYSIS_ATTACHMENT_RECEIPT_UNAVAILABLE', 'The correction could not be confirmed. Keep its original request and check again.', 500);
      return result(client, context, userId, projectId, analysisId, saved, false);
    }, true);
  }
  async function getRequest(userId, projectId, analysisId, requestId) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) notFound();
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const row = await acceptedRequest(client, userId, projectId, analysisId, requestId.toLowerCase());
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
      const access = await sourceAccesses(client, userId, projectId, selected);
      return { projectId, analysisId, canWrite: writable(context), attachments: selected.map((row, index) => itemFromRow(row, access[index])),
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
  async function history(userId, projectId, analysisId, attachmentId, values = {}) {
    const limit = Number(values.limit ?? 30); let before = null;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30 || Object.keys(values).some(key => !['limit', 'cursor'].includes(key))) {
      throw failure('INVALID_ANALYSIS_ATTACHMENT_PAGE', 'Choose an attachment history page size from 1 to 30.');
    }
    if (values.cursor !== undefined) {
      try {
        if (typeof values.cursor !== 'string' || !values.cursor || values.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(values.cursor)) throw new Error();
        const cursor = JSON.parse(Buffer.from(values.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(cursor) || cursor.length !== 2 || cursor[0] !== attachmentId || !Number.isSafeInteger(cursor[1]) || cursor[1] < 1 || cursor[1] > 200) throw new Error();
        before = cursor[1];
      } catch { throw failure('INVALID_ANALYSIS_ATTACHMENT_PAGE', 'The attachment history cursor is invalid for this attachment.'); }
    }
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const current = await head(client, projectId, analysisId, attachmentId);
      const rows = (await client.query(`SELECT * FROM research_analysis_attachment_revisions WHERE project_id=$1 AND analysis_id=$2 AND attachment_id=$3
        ${before === null ? '' : 'AND revision_number<$5'} ORDER BY revision_number DESC LIMIT $4`, [projectId, analysisId, attachmentId, limit + 1, ...(before === null ? [] : [before])])).rows;
      const selected = rows.slice(0, limit), last = selected.at(-1);
      const access = await sourceAccesses(client, userId, projectId, selected);
      return { projectId, analysisId, attachmentId, canWrite: writable(context), headRevisionId: current.head_revision_id,
        revisions: selected.map((row, index) => ({ revision: revision(row), sourceAccess: access[index] })),
        nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([attachmentId, Number(last.revision_number)])).toString('base64url') : null };
    }, true);
  }
  async function getRevision(userId, projectId, analysisId, attachmentId, revisionId) {
    if (typeof revisionId !== 'string' || !(await contract).ANALYSIS_ATTACHMENT_REVISION_ID.test(revisionId)) notFound();
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const current = await head(client, projectId, analysisId, attachmentId);
      const row = (await client.query(`SELECT * FROM research_analysis_attachment_revisions WHERE project_id=$1 AND analysis_id=$2 AND attachment_id=$3 AND id=$4`,
        [projectId, analysisId, attachmentId, revisionId])).rows[0];
      if (!row) notFound();
      return { projectId, analysisId, attachmentId, canWrite: writable(context), headRevisionId: current.head_revision_id,
        revision: revision(row), sourceAccess: await sourceAccess(client, userId, projectId, row) };
    }, true);
  }
  const discussion = require('./analysisAttachmentComments').createAnalysisAttachmentCommentService({ transaction, head });
  const localIntakes = require('./analysisLocalIntakes').createAnalysisLocalIntakeService({ database, provider, transaction, writable, attachmentResult: result, head, item });
  return { create, correct, getRequest, list, options, history, getRevision, ...discussion, ...localIntakes };
}
module.exports = { createAnalysisAttachmentService };
