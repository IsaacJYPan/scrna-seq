'use strict';

const db = require('./pgDatabase');

const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const ACTIONS = new Set([
  'branch.created', 'branch.advanced', 'branch.published',
  'review.requested', 'review.commented', 'review.decided', 'canonical.promoted',
  'artifact.downloaded', 'reproducibility.exported', 'attachment.commented',
  'snapshot.published', 'snapshot.withdrawn',
]);
const TARGET_TYPES = new Set(['branch', 'review', 'analysis_object', 'artifact', 'project', 'attachment_revision', 'snapshot_publication']);
const DETAIL_KEYS = new Set([
  'artifactType', 'branchVisibility', 'canonicalVersion', 'decision',
  'fromAnalysisObjectId', 'toAnalysisObjectId', 'manifestVersion',
  'snapshotSha256', 'policyVersion', 'resultCount', 'documentCount',
]);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeToken(value, maxLength = 160) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9._:-]*$/.test(text) && text.length <= maxLength ? text : null;
}

function sanitizeDetails(details = {}) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const safe = {};
  for (const key of DETAIL_KEYS) {
    if (!(key in details)) continue;
    if (['canonicalVersion', 'manifestVersion', 'policyVersion', 'resultCount', 'documentCount'].includes(key)) {
      const value = Number(details[key]);
      if (Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    } else {
      const value = safeToken(details[key]);
      if (value !== null) safe[key] = value;
    }
  }
  return safe;
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    actorUserId: Number(row.actor_user_id),
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    details: typeof row.details_json === 'string' ? JSON.parse(row.details_json) : row.details_json || {},
    createdAt: row.created_at,
  };
}

async function recordEvent(client, input) {
  if (!ACTIONS.has(input.action) || !TARGET_TYPES.has(input.targetType)) {
    throw codedError('INVALID_AUDIT_EVENT', 'Audit event type is invalid.');
  }
  const targetId = input.targetId == null ? null : safeToken(input.targetId);
  if (input.targetId != null && targetId === null) {
    throw codedError('INVALID_AUDIT_EVENT', 'Audit target is invalid.');
  }
  const runner = client && typeof client.query === 'function' ? client : db;
  const { rows } = await runner.query(
    `INSERT INTO project_audit_events
       (id, project_id, actor_user_id, action, target_type, target_id, details_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [db.genId('aud'), String(input.projectId), Number(input.actorUserId), input.action,
      input.targetType, targetId, JSON.stringify(sanitizeDetails(input.details))]
  );
  return fromRow(rows[0]);
}

async function listEvents(userId, projectId, options = {}) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 100));
  const params = [String(projectId), limit];
  let cursorClause = '';
  if (options.before) {
    const before = new Date(options.before);
    if (Number.isNaN(before.getTime())) throw codedError('INVALID_AUDIT_CURSOR', 'Audit cursor is invalid.');
    params.push(before.toISOString());
    cursorClause = ` AND created_at < $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT * FROM project_audit_events
      WHERE project_id = $1${cursorClause}
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    params
  );
  return rows.map(fromRow);
}

module.exports = { ACTIONS, TARGET_TYPES, sanitizeDetails, recordEvent, listEvents, fromRow };
