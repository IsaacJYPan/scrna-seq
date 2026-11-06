'use strict';

// Agent-facing automation API: /api/automation/v1 (docs/spec.md section 15).
// Authenticated only by an agent bearer credential. Every handler checks the
// effective authority (sponsor's current role ∩ delegation ∩ project) through
// authorizeAgentOperation before reading or writing anything.

const express = require('express');
const { readAgentCredential } = require('../actors/agentCredentials');
const { authorizeAgentOperation } = require('../actors/delegations');
const { publicCatalog } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('./automationAudit');

const API_VERSION = 'traceomics.automation.v1';
const MAX_RATE_LIMIT_KEYS = 10000;

const RETRY = Object.freeze({
  AGENT_CREDENTIAL_REQUIRED: 'never',
  AGENT_CREDENTIAL_INVALID: 'never',
  SCOPE_DENIED: 'never',
  CAPABILITY_UNAVAILABLE: 'never',
  RATE_LIMITED: 'after-delay',
  PROPOSAL_LIMIT: 'after-review',
  BUDGET_EXCEEDED: 'after-review',
  STUDY_AMENDMENT_REQUIRED: 'never',
  RELEASE_NOT_APPROVED: 'never',
  PLAN_STALE: 'new-plan',
  IDEMPOTENCY_CONFLICT: 'never',
  SERVICE_UNAVAILABLE: 'same-request-id',
  SANDBOX_CLOSED: 'never',
  INVALID_SCRIPT: 'never',
});

function sendError(res, status, code, message, actor, details) {
  res.status(status).json({
    error: message,
    code,
    ...(details ? { details } : {}),
    retry: RETRY[code] || (status >= 500 ? 'same-request-id' : 'never'),
    correlationId: actor?.correlationId || null,
  });
}

function createRateLimiter() {
  const windows = new Map();
  return function allow(key, maxPerMinute, now = Date.now()) {
    let entry = windows.get(key);
    if (!entry || now >= entry.resetAt) {
      if (!entry && windows.size >= MAX_RATE_LIMIT_KEYS) {
        for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
        if (windows.size >= MAX_RATE_LIMIT_KEYS) return { allowed: false, retryAfter: 60 };
      }
      entry = { count: 0, resetAt: now + 60000 };
      windows.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > maxPerMinute) return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    return { allowed: true };
  };
}

function automationRoutes({ db, delegations, proposals, readModels, studies, admission, approvals, targets, sandboxes, reports }) {
  const router = express.Router();
  const rateLimit = createRateLimiter();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TraceOmics-Automation-Version', API_VERSION);
    next();
  });

  router.use(async (req, res, next) => {
    const credential = readAgentCredential(req);
    if (!credential.present) {
      return sendError(res, 401, 'AGENT_CREDENTIAL_REQUIRED', 'An agent credential is required for this API.');
    }
    if (!credential.token) return sendError(res, 401, 'AGENT_CREDENTIAL_INVALID', 'The agent credential is not valid.');
    let resolved;
    try {
      resolved = await delegations.resolveAgentCredential(credential.token);
    } catch {
      return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Agent authorization is temporarily unavailable.');
    }
    if (!resolved.actor) return sendError(res, 401, resolved.failure, 'The agent credential is not valid.');
    const limit = rateLimit(resolved.actor.credentialId, resolved.actor.delegation.policy.maxRequestsPerMinute || 60);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfter));
      return sendError(res, 429, 'RATE_LIMITED', 'Too many requests for this agent credential.', resolved.actor);
    }
    req.actor = resolved.actor;
    return next();
  });

  // Body parsing happens only after authentication so unauthenticated callers
  // cannot make the server buffer large bodies.
  router.use(express.json({ limit: '1mb', strict: true }));

  const route = (capability, handler) => async (req, res) => {
    const actor = req.actor;
    const projectId = req.params.projectId;
    if (capability) {
      const denial = authorizeAgentOperation(actor, capability, projectId);
      if (denial) {
        try {
          await recordAutomationEvent(db, {
            projectId: actor.delegation.projectId, actor, action: `denied.${capability}`, decision: 'denied',
            reasonCode: denial, targetType: 'project', targetId: projectId,
          });
        } catch {
          // A denial that cannot be recorded is still a denial.
        }
        return sendError(res, 403, denial, 'This agent is not permitted to perform that operation.', actor);
      }
    }
    try {
      const result = await handler(req, actor);
      if (result === null || result === undefined) return sendError(res, 404, 'NOT_FOUND', 'Not found.', actor);
      return res.status(result.__status || 200).json(result.__status ? result.body : result);
    } catch (error) {
      const status = Number(error.status) || (error.code === 'NOT_FOUND' ? 404 : 500);
      if (status >= 500) {
        console.error(`[automation] ${req.method} request failed (${error.code || 'INTERNAL'}).`);
        return sendError(res, 500, 'INTERNAL', 'The request could not be completed.', actor);
      }
      return sendError(res, status, error.code || 'INVALID_REQUEST', error.message, actor, error.details);
    }
  };

  router.get('/context', route(null, async (req, actor) => ({
    schema: 'traceomics.automation.context.v1',
    apiVersion: API_VERSION,
    actor: { kind: 'agent', principalId: actor.principalId, displayName: actor.agentDisplayName },
    sponsor: { userId: actor.sponsorUserId, currentProjectRole: actor.sponsorRole },
    delegation: {
      id: actor.delegation.id,
      version: actor.delegation.version,
      projectId: actor.delegation.projectId,
      capabilities: actor.delegation.capabilities,
      effectiveCapabilities: actor.delegation.capabilities
        .filter((name) => !authorizeAgentOperation(actor, name, actor.delegation.projectId)),
      disclosureProfile: actor.delegation.disclosureProfile,
      policy: actor.delegation.policy,
      expiresAt: actor.delegation.expiresAt,
    },
    credential: { id: actor.credentialId, expiresAt: actor.credentialExpiresAt },
    catalog: publicCatalog(),
    correlationId: actor.correlationId,
  })));

  router.get('/projects/:projectId', route('metadata.read', (req, actor) => readModels.projectSummary(actor)));
  router.get('/projects/:projectId/datasets', route('metadata.read',
    (req, actor) => readModels.listDatasets(actor, { limit: req.query.limit })));
  // ?scope=mine lists this agent's own runs; otherwise bounded project history.
  router.get('/projects/:projectId/runs', route('results.read', async (req, actor) => (req.query.scope === 'mine'
    ? { schema: 'traceomics.automation.agent-runs.v1', runs: await admission.listRunsForAgent(actor, { limit: req.query.limit }) }
    : readModels.listRuns(actor, { limit: req.query.limit }))));

  router.post('/projects/:projectId/proposals', route('proposal.create', async (req, actor) => {
    const { proposal, replayed } = await proposals.createForAgent(actor, req.body);
    return { __status: replayed ? 200 : 201, body: { schema: 'traceomics.automation.proposal.v1', replayed, proposal } };
  }));
  router.get('/projects/:projectId/proposals', route('proposal.create', async (req, actor) => ({
    schema: 'traceomics.automation.proposals.v1',
    proposals: await proposals.listForAgent(actor, { limit: req.query.limit }),
  })));
  router.get('/projects/:projectId/proposals/:proposalId', route('proposal.create', async (req, actor) => ({
    schema: 'traceomics.automation.proposal.v1',
    proposal: await proposals.getForAgent(actor, req.params.proposalId),
  })));

  // Approved workflow execution (docs/spec.md phase 2).
  router.get('/projects/:projectId/workflows', route('workflow.plan', async (req, actor) => ({
    schema: 'traceomics.automation.workflows.v1',
    releases: await approvals.listApprovedForProject(actor.delegation.projectId),
  })));
  router.get('/projects/:projectId/targets', route('metadata.read', () => targets.list()));
  router.get('/projects/:projectId/studies', route('workflow.plan', async (req, actor) => ({
    schema: 'traceomics.automation.studies.v1',
    studies: await studies.listForAgent(actor),
  })));
  router.get('/projects/:projectId/studies/:studyId', route('workflow.plan', async (req, actor) => ({
    schema: 'traceomics.automation.study.v1',
    study: await studies.getForAgent(actor, req.params.studyId),
  })));
  router.post('/projects/:projectId/plans', route('workflow.plan', async (req, actor) => ({
    __status: 201, body: { schema: 'traceomics.automation.plan.v1', ...(await admission.createPlan(actor, req.body)) },
  })));
  router.get('/projects/:projectId/plans/:planId', route('workflow.plan', async (req, actor) => ({
    schema: 'traceomics.automation.plan.v1', ...(await admission.getPlan(actor, req.params.planId)),
  })));
  router.post('/projects/:projectId/runs', route('workflow.executeApproved', async (req, actor) => {
    const { run, replayed } = await admission.submitRun(actor, req.body);
    return { __status: replayed ? 200 : 201, body: { schema: 'traceomics.automation.run.v1', replayed, run } };
  }));
  router.get('/projects/:projectId/runs/:runId', route('results.read', async (req, actor) => ({
    schema: 'traceomics.automation.run.v1', run: await admission.getRunForAgent(actor, req.params.runId),
  })));
  router.get('/projects/:projectId/runs/:runId/results', route('results.read', async (req, actor) => ({
    schema: 'traceomics.automation.run-results.v1', ...(await admission.resultsForAgent(actor, req.params.runId)),
  })));
  router.post('/projects/:projectId/runs/:runId/cancel', route('run.cancelOwn', async (req, actor) => ({
    schema: 'traceomics.automation.run.v1', run: await admission.cancelForAgent(actor, req.params.runId),
  })));

  // Isolated development (docs/spec.md phase 4): the agent's own R scripts.
  if (sandboxes) {
    router.get('/projects/:projectId/sandboxes', route('development.executeCandidate', async (req, actor) => ({
      schema: 'traceomics.automation.sandboxes.v1', sandboxes: await sandboxes.listForAgent(actor),
    })));
    router.get('/projects/:projectId/sandboxes/:sandboxId', route('development.executeCandidate', async (req, actor) => ({
      schema: 'traceomics.automation.sandbox.v1', sandbox: await sandboxes.getForAgent(actor, req.params.sandboxId),
    })));
    router.post('/projects/:projectId/sandboxes/:sandboxId/runs', route('development.executeCandidate', async (req, actor) => {
      const { run, replayed } = await sandboxes.submitRun(actor, req.params.sandboxId, req.body);
      return { __status: replayed ? 200 : 201, body: { schema: 'traceomics.automation.sandbox-run.v1', replayed, run } };
    }));
    router.get('/projects/:projectId/sandbox-runs/:runId', route('development.executeCandidate', async (req, actor) => ({
      schema: 'traceomics.automation.sandbox-run.v1', run: await sandboxes.getRunForAgent(actor, req.params.runId),
    })));
    router.post('/projects/:projectId/sandbox-runs/:runId/cancel', route('development.executeCandidate', async (req, actor) => ({
      schema: 'traceomics.automation.sandbox-run.v1', run: await sandboxes.cancelForAgent(actor, req.params.runId),
    })));
    router.get('/projects/:projectId/sandbox-runs/:runId/files/*name', route('results.read', async (req, actor) => {
      const name = Array.isArray(req.params.name) ? req.params.name.join('/') : String(req.params.name);
      const file = await sandboxes.fileForAgent(actor, req.params.runId, name);
      return {
        schema: 'traceomics.automation.sandbox-file.v1', name: file.name, kind: file.kind, mimeType: file.mimeType,
        sizeBytes: file.content.length,
        ...(file.kind === 'text' ? { text: file.content.toString('utf8') } : { base64: file.content.toString('base64') }),
      };
    }));
  }

  // Reports drafted by the agent for people to review (docs/spec.md phase 5).
  if (reports) {
    router.get('/projects/:projectId/reports', route('report.write', async (req, actor) => ({
      schema: 'traceomics.automation.reports.v1', reports: await reports.listForAgent(actor),
    })));
    router.post('/projects/:projectId/reports', route('report.write', async (req, actor) => {
      const { report, replayed } = await reports.createForAgent(actor, req.body);
      return { __status: replayed ? 200 : 201, body: { schema: 'traceomics.automation.report.v1', replayed, report } };
    }));
    router.get('/projects/:projectId/reports/:reportId', route('report.write', async (req, actor) => ({
      schema: 'traceomics.automation.report.v1', report: await reports.getForAgent(actor, req.params.reportId),
    })));
    router.post('/projects/:projectId/reports/:reportId/sections', route('report.write', async (req, actor) => {
      const { section, replayed } = await reports.writeSectionForAgent(actor, req.params.reportId, req.body);
      return { __status: replayed ? 200 : 201, body: { schema: 'traceomics.automation.report-section.v1', replayed, section } };
    }));
  }

  router.use((req, res) => sendError(res, 404, 'NOT_FOUND', 'Unknown automation operation.', req.actor));
  // Malformed JSON and other body errors.
  router.use((error, req, res, _next) => {
    const tooLarge = error && error.type === 'entity.too.large';
    sendError(res, tooLarge ? 413 : 400, tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
      tooLarge ? 'The request body is too large.' : 'The request body is not valid JSON.', req.actor);
  });
  return router;
}

// Mounted ahead of every route. Agent credentials are honored only by the
// automation API; every other route refuses them explicitly (docs/spec.md
// 16.3), and a request that mixes a human session with an agent credential is
// rejected rather than resolved in favor of either.
function agentCredentialGuard({ hasSessionCookie }) {
  return (req, res, next) => {
    // Applies to every path: Express routing is case-insensitive, so a prefix
    // check on "/api/" alone could be bypassed with "/API/...".
    const credential = readAgentCredential(req);
    if (!credential.present) return next();
    const lowerPath = req.path.toLowerCase();
    const automation = lowerPath === '/api/automation/v1' || lowerPath.startsWith('/api/automation/v1/');
    if (credential.present && hasSessionCookie(req)) {
      res.setHeader('Cache-Control', 'no-store');
      return sendError(res, 400, 'AMBIGUOUS_CREDENTIALS',
        'Send either a signed-in session or an agent credential, not both.');
    }
    if (credential.present && !automation) {
      res.setHeader('Cache-Control', 'no-store');
      return sendError(res, 403, 'AGENT_ROUTE_NOT_ADAPTED',
        'Agent credentials can only be used with the automation API.');
    }
    return next();
  };
}

module.exports = { automationRoutes, agentCredentialGuard, API_VERSION };
