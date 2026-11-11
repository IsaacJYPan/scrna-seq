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

function agentGovernanceRoutes({ db, delegations, proposals, approvals, studies, admission, targets, sandboxes, reports }) {
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
  router.get('/compute-targets', route(async (req, actor) => {
    await db.requireProjectRole(actor.userId, req.params.projectId, READ_ROLES);
    return targets.list();
  }));
  router.get('/workflow-releases', route((req, actor) => approvals.listForHuman(actor, req.params.projectId)));
  router.post('/workflow-releases/:releaseId/approve', route(
    (req, actor) => approvals.approve(actor, req.params.projectId, req.params.releaseId, req.body || {}), { status: 201 }));
  // The analysis steps of a release, for reading: each step's exact code and a
  // version with error handling hidden. Only releases that name their analysis
  // source file have this view.
  router.get('/workflow-releases/:releaseId/steps', route(async (req, actor) => {
    await db.requireProjectRole(actor.userId, req.params.projectId, READ_ROLES);
    const releases = await approvals.ensureCatalog();
    const release = releases.find((r) => r.id === req.params.releaseId);
    if (!release) throw Object.assign(new Error('Workflow release not found.'), { code: 'NOT_FOUND' });
    if (!release.readableSource) return { schema: 'traceomics.release-steps.v1', releaseId: release.id, source: null, steps: [] };
    const pinned = release.definition.handler.find((h) => h.path === release.readableSource);
    const bytes = require('fs').readFileSync(require('path').join(__dirname, '..', '..', release.readableSource));
    const sha = require('crypto').createHash('sha256').update(bytes).digest('hex');
    if (!pinned || pinned.sha256 !== sha)
      throw Object.assign(new Error('The release source changed.'), { code: 'RELEASE_SOURCE_CHANGED', status: 409 });
    const { readableSteps } = require('../../shared/readableR.mjs');
    return { schema: 'traceomics.release-steps.v1', releaseId: release.id, source: { path: release.readableSource, sha256: sha },
      steps: readableSteps(bytes.toString('utf8')) };
  }));
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

  // Agent sandboxes and their draft outputs (docs/spec.md phase 4).
  if (sandboxes) {
    router.get('/agent-sandboxes', route((req, actor) => sandboxes.listForHuman(actor, req.params.projectId)));
    router.post('/agent-sandboxes', route((req, actor) => sandboxes.create(actor, req.params.projectId, req.body || {}), { status: 201 }));
    router.get(
      '/agent-sandboxes/:sandboxId',
      route((req, actor) => sandboxes.getForHuman(actor, req.params.projectId, req.params.sandboxId))
    );
    router.post(
      '/agent-sandboxes/:sandboxId/close',
      route((req, actor) => sandboxes.close(actor, req.params.projectId, req.params.sandboxId))
    );
    router.post('/agent-sandbox-runs/:runId/review', route(
      (req, actor) => sandboxes.reviewRun(actor, req.params.projectId, req.params.runId, req.body || {})));
    // Raw file from a run's output bundle, for the review screen.
    router.get('/agent-sandbox-runs/:runId/files/*name', async (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const actor = humanActorContext(req.user, { authVia: req.authVia });
        const name = Array.isArray(req.params.name) ? req.params.name.join('/') : String(req.params.name);
        const file = await sandboxes.fileForHuman(actor, req.params.projectId, req.params.runId, name);
        res.setHeader('Content-Type', file.kind === 'text' ? `${file.mimeType}; charset=utf-8` : file.mimeType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // SVG and PDF can carry script; never render them as an active document.
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
        if (req.query.download === '1' || file.kind === 'binary') {
          res.setHeader('Content-Disposition', `attachment; filename="${file.name.split('/').pop()}"`);
        }
        res.end(file.content);
      } catch (error) {
        const status = Number(error.status) || (error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 500);
        res.status(status).json(status >= 500
          ? { error: 'The file is unavailable.', code: 'INTERNAL' }
          : { error: error.message, code: error.code });
      }
    });
  }

  if (reports) {
    router.get('/agent-reports', route((req, actor) => reports.listForHuman(actor, req.params.projectId)));
    router.get('/agent-reports/:reportId', route((req, actor) => reports.getForHuman(actor, req.params.projectId, req.params.reportId)));
    router.post('/agent-reports/:reportId/reviews', route(
      (req, actor) => reports.reviewByHuman(actor, req.params.projectId, req.params.reportId, req.body || {}), { status: 201 }));
    router.post('/agent-reports/:reportId/finalize', route(
      (req, actor) => reports.finalizeByHuman(actor, req.params.projectId, req.params.reportId, req.body || {})));
    router.get('/agent-reports/:reportId/export', async (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const actor = humanActorContext(req.user, { authVia: req.authVia });
        const exported = await reports.exportMarkdown(actor, req.params.projectId, req.params.reportId);
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${exported.filename}"`);
        res.end(exported.markdown);
      } catch (error) {
        const status = Number(error.status) || (error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 500);
        res
          .status(status)
          .json(
            status >= 500
              ? { error: 'The report is unavailable.', code: 'INTERNAL' }
              : { error: error.message, code: error.code }
          );
      }
    });
  }

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
