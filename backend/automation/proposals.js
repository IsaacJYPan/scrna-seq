'use strict';

// Inert agent proposals (docs/spec.md sections 4.3, 9, 19 phase 1). A proposal
// is retained text: nothing here parses, installs, executes, or approves it.
// Review decisions are human-only and "noted" is deliberately not an approval.

const crypto = require('crypto');
const { READ_ROLES, WRITE_ROLES, codedError } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('./automationAudit');

const PROPOSAL_KINDS = ['code', 'method', 'workflow'];
const REVIEW_DECISIONS = ['declined', 'noted'];
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const PROPOSAL_ID_PATTERN = /^prop_[0-9a-f]{24}$/;
const PROPOSAL_FIELDS = ['requestId', 'kind', 'title', 'summary', 'body'];

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function cleanLine(value, field, max, required) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw codedError('INVALID_INPUT', `${field} must be text.`, 400);
  // eslint-disable-next-line no-control-regex -- deliberately strips control characters
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !text) throw codedError('INVALID_INPUT', `${field} is required.`, 400);
  if (text.length > max) throw codedError('INVALID_INPUT', `${field} must be at most ${max} characters.`, 400);
  return text;
}

function cleanBlock(value, field, maxBytes) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw codedError('INVALID_INPUT', `${field} must be text.`, 400);
  // Keep newlines and tabs (patches need them); drop other control characters.
  // eslint-disable-next-line no-control-regex -- deliberately rejects control characters
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw codedError('INVALID_INPUT', `${field} contains unsupported control characters.`, 400);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw codedError('PROPOSAL_TOO_LARGE', `${field} must be at most ${maxBytes} bytes.`, 413);
  }
  return value;
}

function validateProposalInput(body, policy) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
  }
  for (const key of Object.keys(body)) {
    if (!PROPOSAL_FIELDS.includes(key)) throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
  }
  if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
    throw codedError('INVALID_REQUEST_ID', 'requestId must be 8-80 letters, digits, "-" or "_".', 400);
  }
  if (!PROPOSAL_KINDS.includes(body.kind)) {
    throw codedError('INVALID_INPUT', `kind must be one of: ${PROPOSAL_KINDS.join(', ')}.`, 400);
  }
  const input = {
    requestId: body.requestId,
    kind: body.kind,
    title: cleanLine(body.title, 'title', 200, true),
    summary: cleanBlock(body.summary, 'summary', 16000),
    body: cleanBlock(body.body, 'body', policy.maxProposalBytes),
  };
  if (input.summary.length > 4000) throw codedError('INVALID_INPUT', 'summary must be at most 4000 characters.', 400);
  // The request digest covers every caller-supplied field, so a replay with the
  // same requestId but different content is rejected rather than merged.
  input.requestSha256 = sha256(JSON.stringify([input.kind, input.title, input.summary, input.body]));
  return input;
}

function publicProposal(row, { includeBody = false } = {}) {
  return {
    id: row.id,
    projectId: row.project_id,
    delegationId: row.delegation_id,
    agent: { principalId: row.agent_principal_id, displayName: row.agent_display_name || null },
    sponsorUserId: Number(row.sponsor_user_id),
    requestId: row.request_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    bodySha256: row.body_sha256,
    bodyBytes: Number(row.body_bytes),
    ...(includeBody ? { body: row.body_text } : {}),
    // Explicit, separate facts. Nothing about a proposal is executable.
    execution: 'none',
    approval: 'none',
    reviewState: row.review_state,
    reviewedByUserId: row.reviewed_by_user_id == null ? null : Number(row.reviewed_by_user_id),
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    createdAt: row.created_at,
  };
}

const PROPOSAL_SELECT = `
  SELECT pr.*, ap.display_name AS agent_display_name
    FROM agent_change_proposals pr
    JOIN agent_principals ap ON ap.id = pr.agent_principal_id`;

function createProposalService({ db, withTransaction }) {
  async function createForAgent(actor, body) {
    const policy = actor.delegation.policy;
    const input = validateProposalInput(body, policy);
    return withTransaction(async (client) => {
      // Lock the delegation so a concurrent revocation either precedes this
      // write (and it fails) or follows it; and so open-proposal counts are exact.
      const { rows: live } = await client.query(
        `SELECT d.id FROM agent_delegations d
           JOIN agent_principals p ON p.id = d.agent_principal_id
          WHERE d.id = $1 AND d.revoked_at IS NULL AND d.expires_at > now() AND p.status = 'active'
          FOR UPDATE OF d`,
        [actor.delegation.id]
      );
      if (!live[0]) throw codedError('AGENT_CREDENTIAL_INVALID', 'The agent credential is not valid.', 401);
      const { rows: existing } = await client.query(
        `${PROPOSAL_SELECT} WHERE pr.delegation_id = $1 AND pr.request_id = $2`,
        [actor.delegation.id, input.requestId]
      );
      if (existing[0]) {
        if (existing[0].request_sha256 !== input.requestSha256) {
          throw codedError('IDEMPOTENCY_CONFLICT', 'This requestId was already used for a different proposal.', 409);
        }
        return { proposal: publicProposal(existing[0]), replayed: true };
      }
      const { rows: open } = await client.query(
        `SELECT COUNT(*)::int AS n FROM agent_change_proposals WHERE delegation_id = $1 AND review_state = 'open'`,
        [actor.delegation.id]
      );
      if (open[0].n >= policy.maxOpenProposals) {
        throw codedError('PROPOSAL_LIMIT', 'This agent has reached its limit of open proposals.', 429);
      }
      const id = `prop_${crypto.randomBytes(12).toString('hex')}`;
      await client.query(
        `INSERT INTO agent_change_proposals
           (id, project_id, delegation_id, agent_principal_id, sponsor_user_id, request_id, request_sha256,
            kind, title, summary, body_text, body_sha256, body_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, actor.delegation.projectId, actor.delegation.id, actor.principalId, actor.sponsorUserId,
          input.requestId, input.requestSha256, input.kind, input.title, input.summary, input.body,
          sha256(input.body), Buffer.byteLength(input.body, 'utf8')]
      );
      await recordAutomationEvent(client, {
        projectId: actor.delegation.projectId, actor, action: 'proposal.created', decision: 'allowed',
        targetType: 'proposal', targetId: id, requestId: input.requestId,
      });
      const { rows } = await client.query(`${PROPOSAL_SELECT} WHERE pr.id = $1`, [id]);
      return { proposal: publicProposal(rows[0]), replayed: false };
    });
  }

  async function listForAgent(actor, { limit } = {}) {
    const bounded = Math.min(100, Math.max(1, Number(limit) || 50));
    const { rows } = await db.query(
      `${PROPOSAL_SELECT} WHERE pr.delegation_id = $1 ORDER BY pr.created_at DESC, pr.id DESC LIMIT $2`,
      [actor.delegation.id, bounded]
    );
    return rows.map((row) => publicProposal(row));
  }

  async function getForAgent(actor, proposalId) {
    if (!PROPOSAL_ID_PATTERN.test(String(proposalId))) throw codedError('NOT_FOUND', 'Proposal not found.', 404);
    const { rows } = await db.query(
      `${PROPOSAL_SELECT} WHERE pr.id = $1 AND pr.delegation_id = $2`,
      [proposalId, actor.delegation.id]
    );
    if (!rows[0]) throw codedError('NOT_FOUND', 'Proposal not found.', 404);
    return publicProposal(rows[0], { includeBody: true });
  }

  async function listForHuman(actor, projectId, { limit, state } = {}) {
    await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const bounded = Math.min(200, Math.max(1, Number(limit) || 100));
    const params = [String(projectId), bounded];
    let filter = '';
    if (state !== undefined) {
      if (!['open', ...REVIEW_DECISIONS].includes(state)) throw codedError('INVALID_INPUT', 'Unknown proposal state.', 400);
      params.push(state); filter = ' AND pr.review_state = $3';
    }
    const { rows } = await db.query(
      `${PROPOSAL_SELECT} WHERE pr.project_id = $1${filter} ORDER BY pr.created_at DESC, pr.id DESC LIMIT $2`,
      params
    );
    return rows.map((row) => publicProposal(row));
  }

  async function getForHuman(actor, projectId, proposalId) {
    await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    if (!PROPOSAL_ID_PATTERN.test(String(proposalId))) throw codedError('NOT_FOUND', 'Proposal not found.', 404);
    const { rows } = await db.query(`${PROPOSAL_SELECT} WHERE pr.id = $1 AND pr.project_id = $2`, [proposalId, String(projectId)]);
    if (!rows[0]) throw codedError('NOT_FOUND', 'Proposal not found.', 404);
    return publicProposal(rows[0], { includeBody: true });
  }

  async function reviewByHuman(actor, projectId, proposalId, body = {}) {
    if (actor?.kind !== 'human') throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
    for (const key of Object.keys(body)) {
      if (!['decision', 'note'].includes(key)) throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
    }
    if (!REVIEW_DECISIONS.includes(body.decision)) {
      throw codedError('INVALID_INPUT', `decision must be one of: ${REVIEW_DECISIONS.join(', ')}.`, 400);
    }
    const note = body.note === undefined ? null : cleanBlock(body.note, 'note', 8000);
    if (note && note.length > 2000) throw codedError('INVALID_INPUT', 'note must be at most 2000 characters.', 400);
    if (!PROPOSAL_ID_PATTERN.test(String(proposalId))) throw codedError('NOT_FOUND', 'Proposal not found.', 404);
    return withTransaction(async (client) => {
      await db.requireProjectRole(actor.userId, projectId, WRITE_ROLES);
      const { rows } = await client.query(
        'SELECT * FROM agent_change_proposals WHERE id = $1 AND project_id = $2 FOR UPDATE',
        [proposalId, String(projectId)]
      );
      if (!rows[0]) throw codedError('NOT_FOUND', 'Proposal not found.', 404);
      if (rows[0].review_state !== 'open') throw codedError('ALREADY_REVIEWED', 'This proposal already has a review decision.', 409);
      await client.query(
        `UPDATE agent_change_proposals SET review_state = $2, reviewed_by_user_id = $3, reviewed_at = now(), review_note = $4
          WHERE id = $1`,
        [proposalId, body.decision, actor.userId, note || null]
      );
      await recordAutomationEvent(client, {
        projectId, actor, action: `proposal.${body.decision}`, decision: 'allowed',
        targetType: 'proposal', targetId: proposalId,
      });
      const { rows: updated } = await client.query(`${PROPOSAL_SELECT} WHERE pr.id = $1`, [proposalId]);
      return publicProposal(updated[0], { includeBody: true });
    });
  }

  return { createForAgent, listForAgent, getForAgent, listForHuman, getForHuman, reviewByHuman };
}

module.exports = { createProposalService, validateProposalInput, publicProposal, PROPOSAL_KINDS, REVIEW_DECISIONS };
