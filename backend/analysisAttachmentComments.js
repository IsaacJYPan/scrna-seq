'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const projectAudit = require('./projectAudit');
const contract = import('../shared/analysisAttachmentComment.mjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const time = value => new Date(value).toISOString();
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const notFound = () => { throw error('ANALYSIS_ATTACHMENT_NOT_FOUND', 'Analysis attachment revision not found.', 404); };

// Reuse the attachment service's current membership/analysis locks and admission
// fence. A discussion is not a publication, source grant or scientific revision.
function createAnalysisAttachmentCommentService({ transaction, head }) {
  const canComment = context => context.analysis.status === 'active' && !context.user.is_demo_guest && !config.demoMode();
  function comment(row) {
    return { id: row.id, attachmentId: row.attachment_id, revisionId: row.revision_id, body: row.body,
      authorUserId: Number(row.author_user_id), authorDisplayName: row.author_display_name, createdAt: time(row.created_at) };
  }
  function authorName(raw) {
    if (typeof raw !== 'string' || !raw.isWellFormed()) return 'Researcher';
    return [...raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()].slice(0, 160).join('').trim() || 'Researcher';
  }
  async function target(client, projectId, analysisId, attachmentId, revisionId) {
    if (typeof revisionId !== 'string' || !/^rar_[a-f0-9]{24}$/.test(revisionId)) notFound();
    const current = await head(client, projectId, analysisId, attachmentId);
    if (!(await client.query(`SELECT id FROM research_analysis_attachment_revisions WHERE project_id=$1 AND analysis_id=$2 AND attachment_id=$3 AND id=$4`,
      [projectId, analysisId, attachmentId, revisionId])).rowCount) notFound();
    return current;
  }
  async function accepted(client, userId, projectId, analysisId, requestId) {
    return (await client.query(`SELECT * FROM research_analysis_attachment_comments
      WHERE project_id=$1 AND analysis_id=$2 AND author_user_id=$3 AND request_id=$4`, [projectId, analysisId, userId, requestId])).rows[0];
  }
  async function response(client, context, projectId, analysisId, row, replayed) {
    const current = await target(client, projectId, analysisId, row.attachment_id, row.revision_id);
    return { projectId, analysisId, attachmentId: row.attachment_id, revisionId: row.revision_id,
      headRevisionId: current.head_revision_id, canComment: canComment(context), requestId: row.request_id,
      requestSha256: row.request_sha256, replayed, comment: comment(row) };
  }
  async function addComment(userId, projectId, analysisId, attachmentId, revisionId, input) {
    const schema = await contract, parsed = schema.normalizeAnalysisAttachmentComment(input);
    const hash = crypto.createHash('sha256').update(schema.canonicalAnalysisAttachmentComment(attachmentId, revisionId, parsed), 'utf8').digest('hex');
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const saved = await accepted(client, userId, projectId, analysisId, parsed.requestId);
      if (saved) {
        if (saved.attachment_id !== attachmentId || saved.revision_id !== revisionId || saved.request_sha256 !== hash) {
          throw error('ANALYSIS_ATTACHMENT_COMMENT_REQUEST_CONFLICT', 'This request already added different text or discussed another exact revision. Keep the original request to recover its comment.', 409);
        }
        return response(client, context, projectId, analysisId, saved, true);
      }
      if (context.analysis.status !== 'active') throw error('ANALYSIS_ARCHIVED', 'Restore this archived analysis before adding a comment. Earlier discussion remains readable.', 409);
      if (!canComment(context)) throw error('FORBIDDEN', 'This deployment or account does not allow new discussion comments.', 403);
      await target(client, projectId, analysisId, attachmentId, revisionId);
      const counts = (await client.query(`SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE revision_id=$3)::int AS revision
        FROM research_analysis_attachment_comments WHERE project_id=$1 AND analysis_id=$2`, [projectId, analysisId, revisionId])).rows[0];
      if (counts.total >= schema.ANALYSIS_ATTACHMENT_COMMENT_LIMITS.analysis || counts.revision >= schema.ANALYSIS_ATTACHMENT_COMMENT_LIMITS.revision) {
        throw error('ANALYSIS_ATTACHMENT_COMMENT_LIMIT', 'This analysis or revision has reached its retained discussion limit. Earlier comments remain available.', 409);
      }
      const row = (await client.query(`INSERT INTO research_analysis_attachment_comments
        (id,project_id,analysis_id,attachment_id,revision_id,author_user_id,author_display_name,body,request_id,request_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, ['rac_' + crypto.randomBytes(12).toString('hex'), projectId,
        analysisId, attachmentId, revisionId, userId, authorName(context.user.display_name), parsed.body, parsed.requestId, hash])).rows[0];
      await projectAudit.recordEvent(client, { projectId, actorUserId: userId, action: 'attachment.commented', targetType: 'attachment_revision', targetId: revisionId });
      return response(client, context, projectId, analysisId, row, false);
    }, true);
  }
  async function getCommentRequest(userId, projectId, analysisId, requestId) {
    if (typeof requestId !== 'string' || !UUID.test(requestId)) notFound();
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const row = await accepted(client, userId, projectId, analysisId, requestId.toLowerCase());
      if (!row) throw error('ANALYSIS_ATTACHMENT_COMMENT_REQUEST_NOT_FOUND', 'No accepted comment receipt is available to this account. A missing receipt does not prove rejection; keep the original UUID, text and revision.', 404);
      return response(client, context, projectId, analysisId, row, true);
    }, true);
  }
  function page(values, attachmentId, revisionId) {
    const limit = Number(values.limit ?? 30); let cursor;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30 || Object.keys(values).some(key => !['limit', 'cursor'].includes(key))) {
      throw error('INVALID_ANALYSIS_ATTACHMENT_COMMENT_PAGE', 'Choose a discussion page size from 1 to 30.');
    }
    if (values.cursor !== undefined) {
      try {
        if (typeof values.cursor !== 'string' || !values.cursor || values.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(values.cursor)) throw new Error();
        const parsed = JSON.parse(Buffer.from(values.cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== attachmentId || parsed[1] !== revisionId
            || typeof parsed[2] !== 'string' || time(parsed[2]) !== parsed[2] || typeof parsed[3] !== 'string' || !/^rac_[a-f0-9]{24}$/.test(parsed[3])) throw new Error();
        cursor = parsed.slice(2);
      } catch { throw error('INVALID_ANALYSIS_ATTACHMENT_COMMENT_PAGE', 'The discussion cursor is invalid for this exact revision.'); }
    }
    return { limit, cursor };
  }
  async function listComments(userId, projectId, analysisId, attachmentId, revisionId, values = {}) {
    const { limit, cursor } = page(values, attachmentId, revisionId);
    return transaction(userId, projectId, analysisId, async (client, context) => {
      const current = await target(client, projectId, analysisId, attachmentId, revisionId);
      const rows = (await client.query(`SELECT * FROM research_analysis_attachment_comments WHERE project_id=$1 AND analysis_id=$2 AND attachment_id=$3 AND revision_id=$4
        ${cursor ? "AND (date_trunc('milliseconds',created_at),id)<($6::timestamptz,$7::text)" : ''}
        ORDER BY date_trunc('milliseconds',created_at) DESC,id DESC LIMIT $5`, [projectId, analysisId, attachmentId, revisionId, limit + 1, ...(cursor || [])])).rows;
      const selected = rows.slice(0, limit), last = selected.at(-1);
      return { projectId, analysisId, attachmentId, revisionId, headRevisionId: current.head_revision_id, canComment: canComment(context),
        comments: selected.map(comment), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([attachmentId, revisionId, time(last.created_at), last.id])).toString('base64url') : null };
    }, true);
  }
  return { addComment, getCommentRequest, listComments };
}
module.exports = { createAnalysisAttachmentCommentService };
