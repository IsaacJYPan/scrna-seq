'use strict';

// Agent principals, project-scoped delegations, and revocable credentials
// (docs/spec.md sections 7.1-7.3). Every mutation here is human-initiated:
// callers pass a verified human ActorContext, and nothing in this module
// accepts an agent context for a write.

const crypto = require('crypto');
const {
  READ_ROLES, MANAGE_ROLES, normalizeCapabilities, normalizePolicy, normalizeDisclosure,
  normalizeLifetimeSeconds, sponsorRolesFor, publicCatalog, codedError,
} = require('../policy/agentCapabilities');
const { generateAgentToken, hashAgentToken, isWellFormedAgentToken } = require('./agentCredentials');
const { agentActorContext } = require('./actorContext');
const { recordAutomationEvent } = require('../automation/automationAudit');

const MAX_ACTIVE_DELEGATIONS_PER_SPONSOR_PROJECT = 10;
const MAX_ACTIVE_CREDENTIALS_PER_DELEGATION = 3;
const LAST_USED_RESOLUTION_MS = 60 * 1000;
const REVOCATION_REASONS = new Set(['sponsor-request', 'project-kill-switch', 'sponsor-kill-switch', 'rotated', 'compromised', 'no-longer-needed']);
const ID_PATTERNS = {
  delegation: /^dlg_[0-9a-f]{24}$/,
  credential: /^agcred_[0-9a-f]{24}$/,
  principal: /^agt_[0-9a-f]{24}$/,
};

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function requireHuman(actor) {
  if (!actor || actor.kind !== 'human' || !Number.isSafeInteger(actor.userId)) {
    throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
  }
}

function assertId(kind, value) {
  if (typeof value !== 'string' || !ID_PATTERNS[kind].test(value)) {
    throw codedError('NOT_FOUND', 'Not found.', 404);
  }
}

function cleanText(value, { field, max, required = false }) {
  if (value === undefined || value === null) {
    if (required) throw codedError('INVALID_INPUT', `${field} is required.`, 400);
    return '';
  }
  if (typeof value !== 'string') throw codedError('INVALID_INPUT', `${field} must be text.`, 400);
  // Strip control characters so labels render inertly everywhere.
  // eslint-disable-next-line no-control-regex -- deliberately strips control characters
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !text) throw codedError('INVALID_INPUT', `${field} is required.`, 400);
  if (text.length > max) throw codedError('INVALID_INPUT', `${field} must be at most ${max} characters.`, 400);
  return text;
}

function rejectUnknownFields(body, allowed) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
  }
}

function delegationStatus(row, now = new Date()) {
  if (row.revoked_at) return 'revoked';
  if (row.principal_status === 'disabled') return 'disabled';
  if (new Date(row.expires_at) <= now) return 'expired';
  return 'active';
}

function credentialStatus(row, now = new Date()) {
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at) <= now) return 'expired';
  return 'active';
}

function publicCredential(row) {
  return {
    id: row.id,
    hint: `tro_agent_${row.token_hint}…`,
    status: credentialStatus(row),
    issuedByUserId: Number(row.issued_by_user_id),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

function publicDelegation(row, credentials = []) {
  return {
    id: row.id,
    version: Number(row.version),
    projectId: row.project_id,
    status: delegationStatus(row),
    agent: {
      id: row.agent_principal_id,
      displayName: row.agent_display_name,
      clientLabel: row.agent_client_label,
      status: row.principal_status,
    },
    sponsor: { userId: Number(row.sponsor_user_id), displayName: row.sponsor_display_name },
    capabilities: row.capabilities,
    disclosureProfile: row.disclosure_profile,
    policy: row.policy_json,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id == null ? null : Number(row.revoked_by_user_id),
    revocationReason: row.revocation_reason,
    createdAt: row.created_at,
    credentials: credentials.map(publicCredential),
  };
}

const DELEGATION_SELECT = `
  SELECT d.*, p.display_name AS agent_display_name, p.client_label AS agent_client_label,
         p.status AS principal_status, u.display_name AS sponsor_display_name
    FROM agent_delegations d
    JOIN agent_principals p ON p.id = d.agent_principal_id
    JOIN users u ON u.id = d.sponsor_user_id`;

function createDelegationStore({ db }) {
  async function withTransaction(callback) {
    const pool = await db.connect();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function lockedMembership(client, userId, projectId) {
    const { rows } = await client.query(
      `SELECT pm.role, u.is_demo_guest FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = $1 AND pm.user_id = $2 FOR SHARE OF pm`,
      [String(projectId), Number(userId)]
    );
    if (!rows[0]) throw codedError('NOT_FOUND', 'Project not found.', 404);
    return { role: rows[0].role, isDemoGuest: rows[0].is_demo_guest === true };
  }

  async function credentialsFor(runner, delegationIds) {
    if (delegationIds.length === 0) return new Map();
    const { rows } = await runner.query(
      `SELECT * FROM agent_credentials WHERE delegation_id = ANY($1::text[])
        ORDER BY created_at DESC, id DESC`,
      [delegationIds]
    );
    const byDelegation = new Map();
    for (const row of rows) {
      if (!byDelegation.has(row.delegation_id)) byDelegation.set(row.delegation_id, []);
      byDelegation.get(row.delegation_id).push(row);
    }
    return byDelegation;
  }

  async function insertCredential(client, { delegationId, issuedByUserId, expiresAt }) {
    const { token, sha256, hint } = generateAgentToken();
    const id = genId('agcred');
    const { rows } = await client.query(
      `INSERT INTO agent_credentials (id, delegation_id, token_sha256, token_hint, issued_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, delegationId, sha256, hint, issuedByUserId, expiresAt]
    );
    return { token, row: rows[0] };
  }

  // Creates a distinct agent principal and its first delegation and credential.
  // The credential secret is returned exactly once and never stored.
  async function createDelegation(actor, projectId, body) {
    requireHuman(actor);
    rejectUnknownFields(body, ['agentName', 'clientLabel', 'capabilities', 'disclosureProfile', 'limits', 'lifetimeSeconds']);
    const agentName = cleanText(body.agentName, { field: 'agentName', max: 120, required: true });
    const clientLabel = cleanText(body.clientLabel, { field: 'clientLabel', max: 120 });
    const disclosureProfile = normalizeDisclosure(body.disclosureProfile);
    const policy = normalizePolicy(body.limits === undefined ? {} : body.limits);
    const lifetimeSeconds = normalizeLifetimeSeconds(body.lifetimeSeconds);

    return withTransaction(async (client) => {
      const membership = await lockedMembership(client, actor.userId, projectId);
      if (membership.isDemoGuest) {
        throw codedError('DEMO_ACCOUNT', 'Demo accounts cannot delegate to agents.', 403);
      }
      const capabilities = normalizeCapabilities(body.capabilities, membership.role);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-delegation:${projectId}:${actor.userId}`]);
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM agent_delegations
          WHERE project_id = $1 AND sponsor_user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
        [String(projectId), actor.userId]
      );
      if (countRows[0].n >= MAX_ACTIVE_DELEGATIONS_PER_SPONSOR_PROJECT) {
        throw codedError('DELEGATION_LIMIT', 'Revoke an existing agent before adding another.', 409);
      }
      const principalId = genId('agt');
      await client.query(
        `INSERT INTO agent_principals (id, sponsor_user_id, display_name, client_label) VALUES ($1, $2, $3, $4)`,
        [principalId, actor.userId, agentName, clientLabel]
      );
      const delegationId = genId('dlg');
      const { rows: delegationRows } = await client.query(
        `INSERT INTO agent_delegations
           (id, agent_principal_id, project_id, sponsor_user_id, capabilities, disclosure_profile, policy_json, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, now() + ($8 || ' seconds')::interval)
         RETURNING *`,
        [delegationId, principalId, String(projectId), actor.userId, JSON.stringify(capabilities),
          disclosureProfile, JSON.stringify(policy), String(lifetimeSeconds)]
      );
      const credential = await insertCredential(client, {
        delegationId, issuedByUserId: actor.userId, expiresAt: delegationRows[0].expires_at,
      });
      await recordAutomationEvent(client, {
        projectId, actor, action: 'delegation.created', decision: 'allowed',
        targetType: 'delegation', targetId: delegationId,
      });
      await recordAutomationEvent(client, {
        projectId, actor, action: 'credential.issued', decision: 'allowed',
        targetType: 'credential', targetId: credential.row.id,
      });
      const { rows } = await client.query(`${DELEGATION_SELECT} WHERE d.id = $1`, [delegationId]);
      return {
        delegation: publicDelegation(rows[0], [credential.row]),
        credential: { ...publicCredential(credential.row), token: credential.token },
      };
    });
  }

  async function listDelegations(actor, projectId) {
    requireHuman(actor);
    const membership = await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const seeAll = MANAGE_ROLES.includes(membership.role);
    const params = [String(projectId)];
    let filter = '';
    if (!seeAll) { params.push(actor.userId); filter = ' AND d.sponsor_user_id = $2'; }
    const { rows } = await db.query(
      `${DELEGATION_SELECT} WHERE d.project_id = $1${filter} ORDER BY d.created_at DESC, d.id DESC LIMIT 200`,
      params
    );
    const credentials = await credentialsFor(db, rows.map((row) => row.id));
    return {
      schema: 'traceomics.agent-delegations.v1',
      viewerRole: membership.role,
      scope: seeAll ? 'project' : 'mine',
      catalog: publicCatalog(),
      delegations: rows.map((row) => publicDelegation(row, credentials.get(row.id) || [])),
    };
  }

  // Sponsors may revoke their own delegations; project owners/admins may revoke
  // any delegation in the project. Revocation also revokes every credential.
  async function lockDelegationForChange(client, actor, projectId, delegationId) {
    assertId('delegation', delegationId);
    const membership = await lockedMembership(client, actor.userId, projectId);
    const { rows } = await client.query(
      'SELECT * FROM agent_delegations WHERE id = $1 AND project_id = $2 FOR UPDATE',
      [delegationId, String(projectId)]
    );
    const row = rows[0];
    if (!row) throw codedError('NOT_FOUND', 'Agent delegation not found.', 404);
    const isSponsor = Number(row.sponsor_user_id) === actor.userId;
    if (!isSponsor && !MANAGE_ROLES.includes(membership.role)) {
      // Do not reveal another member's delegations to non-managers.
      throw codedError('NOT_FOUND', 'Agent delegation not found.', 404);
    }
    return { row, membership, isSponsor };
  }

  function normalizeReason(value, fallback) {
    if (value === undefined) return fallback;
    if (!REVOCATION_REASONS.has(value)) {
      throw codedError('INVALID_INPUT', `reason must be one of: ${[...REVOCATION_REASONS].join(', ')}.`, 400);
    }
    return value;
  }

  async function revokeDelegationRow(client, actor, projectId, row, reason) {
    if (row.revoked_at) return false;
    await client.query(
      `UPDATE agent_delegations SET revoked_at = now(), revoked_by_user_id = $2, revocation_reason = $3
        WHERE id = $1 AND revoked_at IS NULL`,
      [row.id, actor.userId, reason]
    );
    await client.query(
      'UPDATE agent_credentials SET revoked_at = now() WHERE delegation_id = $1 AND revoked_at IS NULL',
      [row.id]
    );
    await recordAutomationEvent(client, {
      projectId, actor, action: 'delegation.revoked', decision: 'allowed',
      targetType: 'delegation', targetId: row.id, reasonCode: reason.toUpperCase().replace(/-/g, '_'),
    });
    return true;
  }

  async function revokeDelegation(actor, projectId, delegationId, body = {}) {
    requireHuman(actor);
    rejectUnknownFields(body, ['reason']);
    const reason = normalizeReason(body.reason, 'sponsor-request');
    return withTransaction(async (client) => {
      const { row } = await lockDelegationForChange(client, actor, projectId, delegationId);
      const changed = await revokeDelegationRow(client, actor, projectId, row, reason);
      return { revoked: true, changed, delegationId };
    });
  }

  // Kill switch: all of the caller's delegations in this project, or (for
  // owners/admins) every delegation in the project.
  async function revokeAll(actor, projectId, body = {}) {
    requireHuman(actor);
    rejectUnknownFields(body, ['scope']);
    const scope = body.scope === undefined ? 'mine' : body.scope;
    if (!['mine', 'project'].includes(scope)) throw codedError('INVALID_INPUT', 'scope must be mine or project.', 400);
    return withTransaction(async (client) => {
      const membership = await lockedMembership(client, actor.userId, projectId);
      if (scope === 'project' && !MANAGE_ROLES.includes(membership.role)) {
        throw codedError('FORBIDDEN', 'Only project owners and admins can revoke every agent.', 403);
      }
      const params = [String(projectId)];
      let filter = '';
      if (scope === 'mine') { params.push(actor.userId); filter = ' AND sponsor_user_id = $2'; }
      const { rows } = await client.query(
        `SELECT * FROM agent_delegations WHERE project_id = $1 AND revoked_at IS NULL${filter}
          ORDER BY id FOR UPDATE`,
        params
      );
      const reason = scope === 'project' ? 'project-kill-switch' : 'sponsor-kill-switch';
      let count = 0;
      for (const row of rows) {
        if (await revokeDelegationRow(client, actor, projectId, row, reason)) count += 1;
      }
      return { revoked: count, scope };
    });
  }

  async function issueCredential(actor, projectId, delegationId, body = {}) {
    requireHuman(actor);
    rejectUnknownFields(body, ['lifetimeSeconds']);
    const lifetimeSeconds = body.lifetimeSeconds === undefined ? null : normalizeLifetimeSeconds(body.lifetimeSeconds);
    return withTransaction(async (client) => {
      const { row, membership, isSponsor } = await lockDelegationForChange(client, actor, projectId, delegationId);
      // A credential is handed to the agent runtime, so only its sponsor may mint one.
      if (!isSponsor) throw codedError('FORBIDDEN', 'Only the sponsoring person can issue agent credentials.', 403);
      if (membership.isDemoGuest) throw codedError('DEMO_ACCOUNT', 'Demo accounts cannot delegate to agents.', 403);
      const { rows: principal } = await client.query('SELECT status FROM agent_principals WHERE id = $1', [row.agent_principal_id]);
      if (row.revoked_at || principal[0]?.status !== 'active' || new Date(row.expires_at) <= new Date()) {
        throw codedError('DELEGATION_INACTIVE', 'This agent delegation is no longer active.', 409);
      }
      const { rows: active } = await client.query(
        `SELECT COUNT(*)::int AS n FROM agent_credentials
          WHERE delegation_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [row.id]
      );
      if (active[0].n >= MAX_ACTIVE_CREDENTIALS_PER_DELEGATION) {
        throw codedError('CREDENTIAL_LIMIT', 'Revoke an existing credential before issuing another.', 409);
      }
      const { rows: expiry } = await client.query(
        `SELECT LEAST($1::timestamptz, COALESCE(now() + ($2 || ' seconds')::interval, $1::timestamptz)) AS expires_at`,
        [row.expires_at, lifetimeSeconds == null ? null : String(lifetimeSeconds)]
      );
      const credential = await insertCredential(client, {
        delegationId: row.id, issuedByUserId: actor.userId, expiresAt: expiry[0].expires_at,
      });
      await recordAutomationEvent(client, {
        projectId, actor, action: 'credential.issued', decision: 'allowed',
        targetType: 'credential', targetId: credential.row.id,
      });
      return { credential: { ...publicCredential(credential.row), token: credential.token } };
    });
  }

  async function revokeCredential(actor, projectId, delegationId, credentialId) {
    requireHuman(actor);
    assertId('credential', credentialId);
    return withTransaction(async (client) => {
      await lockDelegationForChange(client, actor, projectId, delegationId);
      const { rows } = await client.query(
        `UPDATE agent_credentials SET revoked_at = COALESCE(revoked_at, now())
          WHERE id = $1 AND delegation_id = $2 RETURNING *`,
        [credentialId, delegationId]
      );
      if (!rows[0]) throw codedError('NOT_FOUND', 'Credential not found.', 404);
      await recordAutomationEvent(client, {
        projectId, actor, action: 'credential.revoked', decision: 'allowed',
        targetType: 'credential', targetId: credentialId,
      });
      return { credential: publicCredential(rows[0]) };
    });
  }

  // Resolves a presented bearer token to an agent ActorContext. All authority
  // facts are rechecked on every request: credential and delegation expiry and
  // revocation, principal status, and the sponsor's *current* project role.
  // Returns { actor } or { failure: code }.
  async function resolveAgentCredential(token) {
    if (!isWellFormedAgentToken(token)) return { failure: 'AGENT_CREDENTIAL_INVALID' };
    const { rows } = await db.query(
      `SELECT c.id AS credential_id, c.expires_at AS credential_expires_at, c.revoked_at AS credential_revoked_at,
              c.last_used_at,
              d.id AS delegation_id, d.version, d.project_id, d.sponsor_user_id, d.capabilities,
              d.disclosure_profile, d.policy_json, d.expires_at AS delegation_expires_at,
              d.revoked_at AS delegation_revoked_at,
              p.id AS agent_principal_id, p.status AS principal_status, p.display_name AS agent_display_name,
              u.is_demo_guest, pm.role AS sponsor_role, now() AS db_now
         FROM agent_credentials c
         JOIN agent_delegations d ON d.id = c.delegation_id
         JOIN agent_principals p ON p.id = d.agent_principal_id AND p.sponsor_user_id = d.sponsor_user_id
         JOIN users u ON u.id = d.sponsor_user_id
         LEFT JOIN project_members pm ON pm.project_id = d.project_id AND pm.user_id = d.sponsor_user_id
        WHERE c.token_sha256 = $1`,
      [hashAgentToken(token)]
    );
    const row = rows[0];
    if (!row) return { failure: 'AGENT_CREDENTIAL_INVALID' };
    const now = new Date(row.db_now);
    if (row.credential_revoked_at || new Date(row.credential_expires_at) <= now
        || row.delegation_revoked_at || new Date(row.delegation_expires_at) <= now
        || row.principal_status !== 'active' || row.is_demo_guest === true) {
      return { failure: 'AGENT_CREDENTIAL_INVALID' };
    }
    if (!row.last_used_at || now - new Date(row.last_used_at) > LAST_USED_RESOLUTION_MS) {
      await db.query('UPDATE agent_credentials SET last_used_at = now() WHERE id = $1', [row.credential_id]);
    }
    const actor = agentActorContext({
      agentPrincipalId: row.agent_principal_id,
      agentDisplayName: row.agent_display_name,
      sponsorUserId: Number(row.sponsor_user_id),
      sponsorRole: row.sponsor_role || null,
      delegationId: row.delegation_id,
      delegationVersion: Number(row.version),
      projectId: row.project_id,
      capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
      disclosureProfile: row.disclosure_profile,
      policy: row.policy_json || {},
      delegationExpiresAt: row.delegation_expires_at,
      credentialId: row.credential_id,
      credentialExpiresAt: row.credential_expires_at,
    });
    return { actor };
  }

  return {
    createDelegation,
    listDelegations,
    revokeDelegation,
    revokeAll,
    issueCredential,
    revokeCredential,
    resolveAgentCredential,
    withTransaction,
  };
}

// Effective-authority check for an agent operation (docs/spec.md 7.1):
// current sponsor role ∩ delegation ∩ project scope. Unknown facts deny.
function authorizeAgentOperation(actor, capability, projectId) {
  if (!actor || actor.kind !== 'agent' || !actor.delegation) return 'AGENT_CREDENTIAL_REQUIRED';
  if (typeof projectId !== 'string' || projectId !== actor.delegation.projectId) return 'SCOPE_DENIED';
  if (!actor.delegation.capabilities.includes(capability)) return 'SCOPE_DENIED';
  const roles = sponsorRolesFor(capability);
  if (!actor.sponsorRole || !roles.includes(actor.sponsorRole)) return 'SCOPE_DENIED';
  return null;
}

module.exports = {
  createDelegationStore,
  authorizeAgentOperation,
  publicDelegation,
  MAX_ACTIVE_DELEGATIONS_PER_SPONSOR_PROJECT,
  MAX_ACTIVE_CREDENTIALS_PER_DELEGATION,
};
