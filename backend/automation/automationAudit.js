'use strict';

const crypto = require('crypto');

// Append-only delegated-authority audit (schema: automation_audit_events).
// Each row records the *actual* actor kind. Agent rows always carry the
// delegation and credential identities; human rows never carry an agent id.

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;

function auditFields(actor) {
  if (actor?.kind === 'agent') {
    return {
      actorKind: 'agent', actorUserId: null, actorPrincipalId: actor.principalId,
      sponsorUserId: actor.sponsorUserId, delegationId: actor.delegation.id,
      delegationVersion: actor.delegation.version, credentialId: actor.credentialId,
    };
  }
  if (actor?.kind === 'human') {
    return {
      actorKind: 'human', actorUserId: actor.userId, actorPrincipalId: null,
      sponsorUserId: actor.userId, delegationId: null, delegationVersion: null, credentialId: null,
    };
  }
  throw new Error('A server-derived actor context is required for auditing.');
}

async function recordAutomationEvent(runner, {
  projectId, actor, action, decision, reasonCode = null, targetType = null, targetId = null, requestId = null,
}) {
  const fields = auditFields(actor);
  const safeTarget = targetId != null && SAFE_ID.test(String(targetId)) ? String(targetId) : null;
  const safeRequest = requestId != null && SAFE_REQUEST_ID.test(String(requestId)) ? String(requestId) : null;
  const id = `aae_${crypto.randomBytes(12).toString('hex')}`;
  await runner.query(
    `INSERT INTO automation_audit_events
       (id, project_id, actor_kind, actor_user_id, actor_principal_id, sponsor_user_id,
        delegation_id, delegation_version, credential_id, action, decision, reason_code,
        target_type, target_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [id, String(projectId), fields.actorKind, fields.actorUserId, fields.actorPrincipalId,
      fields.sponsorUserId, fields.delegationId, fields.delegationVersion, fields.credentialId,
      action, decision, reasonCode, safeTarget ? targetType : null, safeTarget, safeRequest]
  );
  return id;
}

function publicAuditEvent(row) {
  return {
    id: row.id,
    actor: row.actor_kind === 'agent'
      ? { kind: 'agent', principalId: row.actor_principal_id, displayName: row.agent_display_name || null }
      : { kind: 'human', userId: Number(row.actor_user_id), displayName: row.actor_display_name || null },
    sponsorUserId: Number(row.sponsor_user_id),
    delegationId: row.delegation_id,
    delegationVersion: row.delegation_version,
    credentialId: row.credential_id,
    action: row.action,
    decision: row.decision,
    reasonCode: row.reason_code,
    targetType: row.target_type,
    targetId: row.target_id,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

// sponsorUserId narrows to one person's own actions and their agents' actions.
async function listAutomationEvents(db, projectId, { limit = 100, sponsorUserId = null } = {}) {
  const bounded = Math.min(200, Math.max(1, Number(limit) || 100));
  const params = [String(projectId), bounded];
  let filter = '';
  if (sponsorUserId != null) {
    params.push(Number(sponsorUserId));
    filter = ' AND e.sponsor_user_id = $3';
  }
  const { rows } = await db.query(
    `SELECT e.*, p.display_name AS agent_display_name, u.display_name AS actor_display_name
       FROM automation_audit_events e
       LEFT JOIN agent_principals p ON p.id = e.actor_principal_id
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.project_id = $1${filter}
      ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
    params
  );
  return rows.map(publicAuditEvent);
}

module.exports = { recordAutomationEvent, listAutomationEvents, publicAuditEvent };
