'use strict';

const express = require('express');
const { REJECTED_CREATOR_FIELDS, REJECTED_OWNER_FIELDS } = require('./projectResourceHttp');

// Mounted at /api after authentication and JSON body parsing for
// /api/organizations and /api/projects. Ids, owners and creators are
// server-assigned; roles change only through the membership routes.
function organizationProjectRoutes({ db }) {
  const router = express.Router();

  // Map the coded errors thrown by the org/project DB helpers to HTTP statuses.
  // 404 for unknown/not-accessible resources (no existence leak), 403 for a known
  // member lacking a role, 409 for membership conflicts (duplicate / last owner),
  // 400 for input validation.
  function sendOrgProjectError(res, e, context) {
    switch (e.code) {
      case 'NOT_FOUND':
      case 'MEMBER_NOT_FOUND':
      case 'USER_NOT_FOUND':
        return res.status(404).json({ error: e.message });
      case 'FORBIDDEN':
        return res.status(403).json({ error: e.message });
      case 'ALREADY_MEMBER':
      case 'LAST_OWNER':
        return res.status(409).json({ error: e.message });
      case 'INVALID_OWNER':
      case 'INVALID_ORG':
      case 'INVALID_NAME':
      case 'INVALID_DESCRIPTION':
      case 'INVALID_ROLE':
      case 'INVALID_EMAIL':
      case 'NO_FIELDS':
        return res.status(400).json({ error: e.message });
      default:
        console.error(`[${context}]`, e);
        return res.status(500).json({ error: 'Internal error.' });
    }
  }

  // Reject any client attempt to set a server-controlled field. Returns true (and
  // has already sent a 400) when a forbidden field was present.
  function rejectServerControlledFields(req, res, { rejectId = true, rejectRole = true, extra = [] } = {}) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (rejectId && body.id !== undefined) {
      res.status(400).json({ error: 'Id is server-assigned and must not be provided.' });
      return true;
    }
    for (const field of [...REJECTED_OWNER_FIELDS, ...REJECTED_CREATOR_FIELDS, ...extra]) {
      if (body[field] !== undefined) {
        res.status(400).json({ error: `Field '${field}' is not allowed; it is server-controlled.` });
        return true;
      }
    }
    if (rejectRole && body.role !== undefined) {
      res.status(400).json({ error: 'Role is server-managed and must not be provided here.' });
      return true;
    }
    return false;
  }

  router.post('/organizations', async (req, res) => {
    if (rejectServerControlledFields(req, res)) return;
    try {
      const org = await db.createOrganizationForUser(req.user.id, { name: req.body.name });
      res.status(201).json(org);
    } catch (e) {
      sendOrgProjectError(res, e, 'Organizations');
    }
  });

  router.get('/organizations', async (req, res) => {
    res.json(await db.listOrganizationsForUser(req.user.id));
  });

  router.get('/organizations/:id', async (req, res) => {
    const org = await db.getOrganizationForUser(req.params.id, req.user.id);
    if (!org) return res.status(404).json({ error: 'Organization not found.' });
    res.json(org);
  });

  router.post('/projects', async (req, res) => {
    if (rejectServerControlledFields(req, res)) return;
    try {
      const project = await db.createProjectForUser(req.user.id, {
        organizationId: req.body.organizationId,
        name: req.body.name,
        description: req.body.description
      });
      res.status(201).json(project);
    } catch (e) {
      sendOrgProjectError(res, e, 'Projects');
    }
  });

  router.get('/projects', async (req, res) => {
    res.json(await db.listProjectsForUser(req.user.id));
  });

  router.get('/projects/:id', async (req, res) => {
    const project = await db.getProjectForUser(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json(project);
  });

  router.patch('/projects/:id', async (req, res) => {
    // A project cannot be reparented to another org in this branch.
    if (rejectServerControlledFields(req, res, { extra: ['organizationId', 'organization_id'] })) return;
    try {
      // owner/admin only; not-a-member → 404, member without role → 403.
      await db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin']);
      await db.updateProject(req.params.id, { name: req.body.name, description: req.body.description });
      res.json(await db.getProjectForUser(req.params.id, req.user.id));
    } catch (e) {
      sendOrgProjectError(res, e, 'Projects');
    }
  });

  router.get('/projects/:id/members', async (req, res) => {
    try {
      // Any project member (incl. viewer) may see the member list.
      await db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin', 'analyst', 'viewer']);
      res.json(await db.listProjectMembers(req.params.id));
    } catch (e) {
      sendOrgProjectError(res, e, 'Projects');
    }
  });

  router.post('/projects/:id/members', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Members are added by exact email; reject any attempt to name a user/row id.
    if (rejectServerControlledFields(req, res, { rejectRole: false, extra: ['userId', 'user_id', 'projectId', 'project_id'] })) return;
    if (typeof body.email !== 'string' || !body.email.trim()) {
      return res.status(400).json({ error: 'A member email is required.' });
    }
    try {
      // The DB layer re-reads this authenticated user's role while holding the
      // project mutation lock, so a concurrent demotion cannot leave stale authority.
      const member = await db.addProjectMemberByEmail(
        req.params.id, body.email, body.role, { userId: req.user.id }
      );
      res.status(201).json(member);
    } catch (e) {
      sendOrgProjectError(res, e, 'Projects');
    }
  });

  router.patch('/projects/:id/members/:userId', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: 'Malformed member user ID.' });
    }
    if (rejectServerControlledFields(req, res, {
      rejectRole: false,
      extra: ['userId', 'user_id', 'projectId', 'project_id', 'email', 'id'],
    })) return;
    if (typeof body.role !== 'string') {
      return res.status(400).json({ error: 'A role is required.' });
    }
    try {
      const updated = await db.updateProjectMemberRole(
        req.params.id, targetUserId, body.role, { userId: req.user.id }
      );
      res.json(updated);
    } catch (e) {
      sendOrgProjectError(res, e, 'Projects');
    }
  });

  router.delete('/projects/:id/members/:userId', async (req, res) => {
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: 'Malformed member user ID.' });
    }
    try {
      await db.removeProjectMember(
        req.params.id, targetUserId, { userId: req.user.id }
      );
      res.json({ success: true });
    } catch (e) {
      sendOrgProjectError(res, e, 'Projects');
    }
  });

  return router;
}

module.exports = { organizationProjectRoutes };
