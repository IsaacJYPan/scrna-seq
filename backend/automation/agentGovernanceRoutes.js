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

function agentGovernanceRoutes({ db, delegations, proposals, approvals, studies, admission }) {
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
      return res.status(httpStatus).json({ error: error.message, code, ...(error.details ? { details: error.details } : {}) });
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

  // Approved workflow releases, studies, and agent runs (docs/spec.md phase 2).
  router.get('/workflow-releases', route((req, actor) => approvals.listForHuman(actor, req.params.projectId)));
  router.post('/workflow-releases/:releaseId/approve', route(
    (req, actor) => approvals.approve(actor, req.params.projectId, req.params.releaseId, req.body || {}), { status: 201 }));
  router.post('/workflow-approvals/:approvalId/revoke', route(
    (req, actor) => approvals.revoke(actor, req.params.projectId, req.params.approvalId)));
  router.get('/studies', route((req, actor) => studies.listForHuman(actor, req.params.projectId)));
  router.post('/studies', route((req, actor) => studies.create(actor, req.params.projectId, req.body || {}), { status: 201 }));
  router.get('/studies/:studyId', route((req, actor) => studies.getForHuman(actor, req.params.projectId, req.params.studyId)));
  router.post('/studies/:studyId/close', route((req, actor) => studies.close(actor, req.params.projectId, req.params.studyId)));
  router.get('/agent-runs', route((req, actor) => admission.listRunsForHuman(actor, req.params.projectId, {
    studyId: typeof req.query.studyId === 'string' ? req.query.studyId : undefined,
  })));
  router.post('/agent-runs/:runId/accept', route(
    (req, actor) => admission.acceptByHuman(actor, req.params.projectId, req.params.runId, req.body || {})));

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
