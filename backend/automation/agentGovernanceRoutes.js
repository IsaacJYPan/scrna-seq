'use strict';

// Human-only governance routes for delegated agents, mounted under
// /api/projects/:projectId (which already requires a signed-in session and
// CSRF origin checks). Agent credentials never reach these handlers: the
// global agentCredentialGuard refuses them, and requireAuth accepts only the
// HttpOnly session cookie.

const express = require('express');
const { humanActorContext } = require('../actors/actorContext');
const { READ_ROLES, MANAGE_ROLES } = require('../policy/agentCapabilities');
const { listAutomationEvents } = require('./automationAudit');

function agentGovernanceRoutes({ db, delegations, proposals }) {
  const router = express.Router({ mergeParams: true });

  const route = (handler, { status = 200 } = {}) => async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const actor = humanActorContext(req.user, { authVia: req.authVia });
      res.status(status).json(await handler(req, actor));
    } catch (error) {
      let code = error.code;
      let httpStatus = Number(error.status);
      if (!httpStatus) {
        if (code === 'NOT_FOUND') httpStatus = 404;
        else if (code === 'FORBIDDEN') httpStatus = 403;
        else httpStatus = 500;
      }
      if (httpStatus >= 500) {
        console.error(`[agent-governance] request failed (${code || 'INTERNAL'}).`);
        code = 'INTERNAL';
        return res.status(500).json({ error: 'Agent settings are unavailable. Please try again.', code });
      }
      return res.status(httpStatus).json({ error: error.message, code });
    }
  };

  router.get('/agent-delegations', route((req, actor) => delegations.listDelegations(actor, req.params.projectId)));
  router.post('/agent-delegations', route(
    (req, actor) => delegations.createDelegation(actor, req.params.projectId, req.body || {}), { status: 201 }));
  router.post('/agent-delegations/revoke-all', route(
    (req, actor) => delegations.revokeAll(actor, req.params.projectId, req.body || {})));
  router.post('/agent-delegations/:delegationId/revoke', route(
    (req, actor) => delegations.revokeDelegation(actor, req.params.projectId, req.params.delegationId, req.body || {})));
  router.post('/agent-delegations/:delegationId/credentials', route(
    (req, actor) => delegations.issueCredential(actor, req.params.projectId, req.params.delegationId, req.body || {}),
    { status: 201 }));
  router.post('/agent-delegations/:delegationId/credentials/:credentialId/revoke', route(
    (req, actor) => delegations.revokeCredential(actor, req.params.projectId, req.params.delegationId, req.params.credentialId)));

  router.get('/agent-proposals', route(async (req, actor) => ({
    schema: 'traceomics.agent-proposals.v1',
    proposals: await proposals.listForHuman(actor, req.params.projectId, {
      limit: req.query.limit, state: typeof req.query.state === 'string' ? req.query.state : undefined,
    }),
  })));
  router.get('/agent-proposals/:proposalId', route(
    (req, actor) => proposals.getForHuman(actor, req.params.projectId, req.params.proposalId)));
  router.post('/agent-proposals/:proposalId/review', route(
    (req, actor) => proposals.reviewByHuman(actor, req.params.projectId, req.params.proposalId, req.body || {})));

  router.get('/automation-audit', route(async (req, actor) => {
    const membership = await db.requireProjectRole(actor.userId, req.params.projectId, READ_ROLES);
    const seeAll = MANAGE_ROLES.includes(membership.role);
    return {
      schema: 'traceomics.automation-audit.v1',
      scope: seeAll ? 'project' : 'mine',
      events: await listAutomationEvents(db, req.params.projectId, {
        limit: req.query.limit, sponsorUserId: seeAll ? null : actor.userId,
      }),
    };
  }));

  return router;
}

module.exports = { agentGovernanceRoutes };
