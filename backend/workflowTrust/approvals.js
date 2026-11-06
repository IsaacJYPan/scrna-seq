'use strict';

// Human approval of exact workflow releases per project (docs/spec.md 8.1).
// Approval state lives only here, on the server; a package or client cannot
// mark itself approved.

const crypto = require('crypto');
const { READ_ROLES, MANAGE_ROLES, codedError } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('../automation/automationAudit');
const { currentReleases, syncReleaseCatalog } = require('./catalog');

function requireHuman(actor) {
  if (actor?.kind !== 'human') throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
}

function publicRelease(release, approval = null) {
  return {
    id: release.id,
    key: release.key,
    version: release.version,
    title: release.title,
    jobType: release.jobType,
    digest: release.digest,
    handler: release.definition.handler,
    parameterSchema: release.definition.parameterSchema,
    resources: release.definition.resources,
    inputs: release.definition.inputs,
    outputs: release.definition.outputs,
    readableSource: release.readableSource || null,
    approval: approval ? {
      id: approval.id,
      approvedByUserId: Number(approval.approved_by_user_id),
      approvedAt: approval.created_at,
      note: approval.note,
    } : null,
  };
}

function createApprovalService({ db, withTransaction }) {
  let syncedDigests = null;

  // Keeps the release table aligned with the running code. Cheap when nothing
  // changed; re-syncs after a schema reset or a code change.
  async function ensureCatalog() {
    const releases = currentReleases();
    const key = releases.map((r) => r.digest).join(',');
    if (syncedDigests === key) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM workflow_releases WHERE status = 'current' AND digest = ANY($1::text[])`,
        [releases.map((r) => r.digest)]
      );
      if (rows[0].n === releases.length) return releases;
    }
    await syncReleaseCatalog(db, releases);
    syncedDigests = key;
    return releases;
  }

  async function activeApprovals(runner, projectId) {
    const { rows } = await runner.query(
      `SELECT wa.* FROM workflow_approvals wa JOIN workflow_releases wr ON wr.id = wa.release_id
        WHERE wa.project_id = $1 AND wa.revoked_at IS NULL AND wr.status = 'current'`,
      [String(projectId)]
    );
    return new Map(rows.map((row) => [row.release_id, row]));
  }

  async function listForHuman(actor, projectId) {
    requireHuman(actor);
    const membership = await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const releases = await ensureCatalog();
    const approvals = await activeApprovals(db, projectId);
    return {
      schema: 'traceomics.workflow-releases.v1',
      canApprove: MANAGE_ROLES.includes(membership.role),
      releases: releases.map((release) => publicRelease(release, approvals.get(release.id))),
    };
  }

  // Releases an agent may plan against: current and approved in its project.
  async function listApprovedForProject(projectId) {
    const releases = await ensureCatalog();
    const approvals = await activeApprovals(db, projectId);
    return releases.filter((r) => approvals.has(r.id)).map((r) => publicRelease(r, approvals.get(r.id)));
  }

  async function approve(actor, projectId, releaseId, body = {}) {
    requireHuman(actor);
    for (const key of Object.keys(body || {})) {
      if (key !== 'note' && key !== 'digest') throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
    }
    const note = body.note === undefined ? null : String(body.note).slice(0, 2000);
    const releases = await ensureCatalog();
    const release = releases.find((r) => r.id === releaseId);
    if (!release) throw codedError('NOT_FOUND', 'Workflow release not found.', 404);
    // The reviewer approves exactly what they saw.
    if (body.digest !== undefined && body.digest !== release.digest) {
      throw codedError('RELEASE_CHANGED', 'This release changed since it was reviewed. Review it again.', 409);
    }
    return withTransaction(async (client) => {
      await db.requireProjectRole(actor.userId, projectId, MANAGE_ROLES);
      const { rows: current } = await client.query(
        `SELECT status FROM workflow_releases WHERE id = $1 FOR SHARE`, [release.id]);
      if (current[0]?.status !== 'current') throw codedError('RELEASE_CHANGED', 'This release is no longer current.', 409);
      const { rows: existing } = await client.query(
        'SELECT * FROM workflow_approvals WHERE project_id = $1 AND release_id = $2 AND revoked_at IS NULL',
        [String(projectId), release.id]
      );
      if (existing[0]) return publicRelease(release, existing[0]);
      const id = `wfa_${crypto.randomBytes(12).toString('hex')}`;
      const { rows } = await client.query(
        `INSERT INTO workflow_approvals (id, project_id, release_id, release_digest, approved_by_user_id, note)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, String(projectId), release.id, release.digest, actor.userId, note]
      );
      await recordAutomationEvent(client, {
        projectId, actor, action: 'workflow.approved', decision: 'allowed', targetType: 'workflow_release', targetId: release.id,
      });
      return publicRelease(release, rows[0]);
    });
  }

  async function revoke(actor, projectId, approvalId) {
    requireHuman(actor);
    if (!/^wfa_[0-9a-f]{24}$/.test(String(approvalId))) throw codedError('NOT_FOUND', 'Approval not found.', 404);
    return withTransaction(async (client) => {
      await db.requireProjectRole(actor.userId, projectId, MANAGE_ROLES);
      const { rows } = await client.query(
        `UPDATE workflow_approvals SET revoked_at = now(), revoked_by_user_id = $3
          WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING *`,
        [approvalId, String(projectId), actor.userId]
      );
      if (!rows[0]) throw codedError('NOT_FOUND', 'Active approval not found.', 404);
      await recordAutomationEvent(client, {
        projectId, actor, action: 'workflow.approval-revoked', decision: 'allowed', targetType: 'workflow_approval', targetId: approvalId,
      });
      return { revoked: true, approvalId };
    });
  }

  return { ensureCatalog, listForHuman, listApprovedForProject, approve, revoke };
}

module.exports = { createApprovalService, publicRelease };
