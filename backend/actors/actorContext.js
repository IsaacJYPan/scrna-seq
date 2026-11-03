'use strict';

// ActorContext is the server-derived answer to "who is acting, and on whose
// authority?" (docs/spec.md section 7.1). Only trusted authentication code
// constructs it; request bodies, headers such as `actorKind`, and client
// claims never contribute to it. Contexts are frozen so downstream services
// cannot widen them.

const crypto = require('crypto');

function correlationId() {
  return `req_${crypto.randomBytes(9).toString('hex')}`;
}

function humanActorContext(user, { authVia = 'cookie' } = {}) {
  if (!user || !Number.isSafeInteger(Number(user.id))) throw new Error('A verified user is required.');
  return Object.freeze({
    kind: 'human',
    principalId: `user:${Number(user.id)}`,
    userId: Number(user.id),
    sponsorUserId: Number(user.id),
    delegation: null,
    credentialId: null,
    authVia,
    correlationId: correlationId(),
  });
}

function agentActorContext(row) {
  return Object.freeze({
    kind: 'agent',
    principalId: row.agentPrincipalId,
    userId: null,
    sponsorUserId: row.sponsorUserId,
    delegation: Object.freeze({
      id: row.delegationId,
      version: row.delegationVersion,
      projectId: row.projectId,
      capabilities: Object.freeze([...row.capabilities]),
      disclosureProfile: row.disclosureProfile,
      policy: Object.freeze({ ...row.policy }),
      expiresAt: row.delegationExpiresAt,
    }),
    sponsorRole: row.sponsorRole,
    agentDisplayName: row.agentDisplayName,
    credentialId: row.credentialId,
    credentialExpiresAt: row.credentialExpiresAt,
    authVia: 'agent-credential',
    correlationId: correlationId(),
  });
}

module.exports = { humanActorContext, agentActorContext };
