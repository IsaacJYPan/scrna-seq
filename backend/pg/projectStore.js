'use strict';

const PROJECT_ROLES = new Set(['owner', 'admin', 'analyst', 'viewer']);
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidRole(role) {
  return typeof role === 'string' && PROJECT_ROLES.has(role);
}

// Membership changes re-read the acting user's role while holding the project lock.
function createProjectStore({ connect, query, genId, codedError }) {
  function generateOrganizationId() {
    return genId('org');
  }
  function generateProjectId() {
    return genId('proj');
  }

  async function createOrganization(name, ownerUserId) {
    const owner = Number(ownerUserId);
    if (!Number.isInteger(owner) || owner <= 0) {
      throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
    }
    const id = genId('org');
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, $2, $3)',
        [id, String(name || '').trim(), owner]
      );
      await client.query(
        'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)',
        [id, owner, 'owner']
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return getOrganization(id);
  }

  async function getOrganization(id) {
    const { rows } = await query('SELECT * FROM organizations WHERE id = $1', [String(id)]);
    return rows[0] || null;
  }

  async function createProject(organizationId, name, createdByUserId) {
    const creator = Number(createdByUserId);
    if (!Number.isInteger(creator) || creator <= 0) {
      throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
    }
    const id = genId('proj');
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO projects (id, organization_id, name, created_by_user_id) VALUES ($1, $2, $3, $4)',
        [id, String(organizationId), String(name || '').trim(), creator]
      );
      await client.query(
        'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
        [id, creator, 'owner']
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return getProject(id);
  }

  async function getProject(id) {
    const { rows } = await query('SELECT * FROM projects WHERE id = $1', [String(id)]);
    return rows[0] || null;
  }

  function rowToProjectWithRole(row) {
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      description: row.description || '',
      createdByUserId: Number(row.created_by_user_id),
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function addProjectMember(projectId, userId, role) {
    if (!PROJECT_ROLES.has(role)) {
      throw codedError('INVALID_ROLE', `Invalid role. Allowed: ${[...PROJECT_ROLES].join(', ')}.`);
    }
    await query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
      [String(projectId), Number(userId), role]
    );
  }

  async function getProjectRole(projectId, userId) {
    const { rows } = await query(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [String(projectId), Number(userId)]
    );
    return rows[0] ? rows[0].role : null;
  }

  async function verifyProjectMember(userId, projectId) {
    if (typeof projectId !== 'string' || projectId === '') return null;
    const { rows } = await query(
      'SELECT project_id, user_id, role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [String(projectId), Number(userId)]
    );
    if (!rows[0]) return null;
    return { projectId: rows[0].project_id, userId: Number(rows[0].user_id), role: rows[0].role };
  }

  async function requireProjectRole(userId, projectId, allowedRoles) {
    const membership = await verifyProjectMember(userId, projectId);
    if (!membership) throw codedError('NOT_FOUND', 'Project not found.');
    const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (!allowed.includes(membership.role)) {
      throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
    }
    return membership;
  }

  async function getProjectForUser(projectId, userId) {
    const { rows } = await query(
      `SELECT p.*, pm.role
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
      WHERE p.id = $1 AND pm.user_id = $2`,
      [String(projectId), Number(userId)]
    );
    return rowToProjectWithRole(rows[0]);
  }

  async function listProjectsForUser(userId) {
    const { rows } = await query(
      `SELECT p.*, pm.role
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.user_id = $1
      ORDER BY p.created_at DESC, p.id DESC`,
      [Number(userId)]
    );
    return rows.map(rowToProjectWithRole);
  }

  async function listProjectMembers(projectId) {
    const { rows } = await query(
      `SELECT pm.user_id, pm.role, pm.created_at, pm.updated_at, u.email, u.display_name
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1
      ORDER BY pm.created_at ASC, pm.user_id ASC`,
      [String(projectId)]
    );
    return rows.map((r) => ({
      userId: Number(r.user_id),
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async function createOrganizationForUser(ownerUserId, input = {}) {
    const owner = Number(ownerUserId);
    if (!Number.isInteger(owner) || owner <= 0) {
      throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
    }
    const name = normalizeName(input.name);
    if (!name) throw codedError('INVALID_NAME', 'Organization name is required.');
    if (name.length > MAX_NAME_LENGTH) {
      throw codedError(
        'INVALID_NAME',
        `Organization name must be at most ${MAX_NAME_LENGTH} characters.`
      );
    }
    const id = generateOrganizationId();
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, $2, $3)',
        [id, name, owner]
      );
      await client.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
        [id, owner]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return getOrganizationForUser(id, owner);
  }

  async function getOrganizationForUser(organizationId, userId) {
    if (typeof organizationId !== 'string' || organizationId === '') return null;
    const { rows } = await query(
      `SELECT o.id, o.name, o.owner_user_id, o.created_at, o.updated_at, m.role AS role
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE o.id = $1 AND m.user_id = $2`,
      [organizationId, Number(userId)]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      ownerUserId: Number(row.owner_user_id),
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function listOrganizationsForUser(userId) {
    const { rows } = await query(
      `SELECT o.id, o.name, o.owner_user_id, o.created_at, o.updated_at, m.role AS role
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.id
      WHERE m.user_id = $1
      ORDER BY o.created_at DESC, o.id DESC`,
      [Number(userId)]
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerUserId: Number(row.owner_user_id),
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async function verifyOrganizationMember(userId, organizationId) {
    if (typeof organizationId !== 'string' || organizationId === '') return null;
    const { rows } = await query(
      'SELECT organization_id, user_id, role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [organizationId, Number(userId)]
    );
    if (!rows[0]) return null;
    return {
      organizationId: rows[0].organization_id,
      userId: Number(rows[0].user_id),
      role: rows[0].role,
    };
  }

  async function requireOrganizationRole(userId, organizationId, allowedRoles) {
    const membership = await verifyOrganizationMember(userId, organizationId);
    if (!membership) throw codedError('NOT_FOUND', 'Organization not found.');
    const allowed = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    if (!allowed.includes(membership.role)) {
      throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
    }
    return membership;
  }

  async function addOrganizationMember(organizationId, userId, role) {
    if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0)
      throw codedError('INVALID_OWNER', 'A valid user id is required.');
    if (await verifyOrganizationMember(uid, organizationId)) {
      throw codedError('ALREADY_MEMBER', 'User is already a member of this organization.');
    }
    await query(
      'INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)',
      [String(organizationId), uid, role]
    );
    return { organizationId: String(organizationId), userId: uid, role };
  }

  async function createProjectForUser(userId, input = {}) {
    const creator = Number(userId);
    if (!Number.isInteger(creator) || creator <= 0)
      throw codedError('INVALID_OWNER', 'A valid authenticated user is required.');
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : '';
    if (!organizationId) throw codedError('INVALID_ORG', 'organizationId is required.');
    await requireOrganizationRole(creator, organizationId, ['owner', 'admin']);
    const name = normalizeName(input.name);
    if (!name) throw codedError('INVALID_NAME', 'Project name is required.');
    if (name.length > MAX_NAME_LENGTH)
      throw codedError(
        'INVALID_NAME',
        `Project name must be at most ${MAX_NAME_LENGTH} characters.`
      );
    const description = input.description == null ? '' : String(input.description);
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw codedError(
        'INVALID_DESCRIPTION',
        `Project description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`
      );
    }
    const id = generateProjectId();
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO projects (id, organization_id, name, description, created_by_user_id) VALUES ($1, $2, $3, $4, $5)',
        [id, organizationId, name, description, creator]
      );
      await client.query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')",
        [id, creator]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return getProjectForUser(id, creator);
  }

  async function updateProject(projectId, input = {}) {
    const sets = [];
    const params = [];
    if (input.name !== undefined) {
      const name = normalizeName(input.name);
      if (!name) throw codedError('INVALID_NAME', 'Project name is required.');
      if (name.length > MAX_NAME_LENGTH)
        throw codedError(
          'INVALID_NAME',
          `Project name must be at most ${MAX_NAME_LENGTH} characters.`
        );
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (input.description !== undefined) {
      const description = input.description == null ? '' : String(input.description);
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        throw codedError(
          'INVALID_DESCRIPTION',
          `Project description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`
        );
      }
      params.push(description);
      sets.push(`description = $${params.length}`);
    }
    if (sets.length === 0) throw codedError('NO_FIELDS', 'No updatable fields provided.');
    params.push(String(projectId));
    await query(
      `UPDATE projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
      params
    );
  }

  async function getProjectMember(projectId, userId) {
    const { rows } = await query(
      'SELECT project_id, user_id, role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [String(projectId), Number(userId)]
    );
    if (!rows[0]) return null;
    return { projectId: rows[0].project_id, userId: Number(rows[0].user_id), role: rows[0].role };
  }

  async function countProjectOwners(projectId) {
    const { rows } = await query(
      "SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'",
      [String(projectId)]
    );
    return Number(rows[0]?.n || 0);
  }

  async function lockProjectAndResolveMemberActor(client, projectId, actor) {
    const pid = String(projectId);
    const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [pid]);
    if (!project.rows[0]) throw codedError('NOT_FOUND', 'Project not found.');

    if (actor && typeof actor === 'object') {
      const actorUserId = Number(actor.userId);
      if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
        throw codedError('NOT_FOUND', 'Project not found.');
      }
      const membership = await client.query(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [pid, actorUserId]
      );
      if (!membership.rows[0]) throw codedError('NOT_FOUND', 'Project not found.');
      if (!['owner', 'admin'].includes(membership.rows[0].role)) {
        throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
      }
      return membership.rows[0].role;
    }

    // Compatibility for trusted helper callers/tests. HTTP routes always pass the
    // authenticated user id above so the acting role is re-read under the lock.
    if (!['owner', 'admin'].includes(actor)) {
      throw codedError('FORBIDDEN', 'You do not have permission to perform this action.');
    }
    return actor;
  }

  async function addProjectMemberByEmail(projectId, email, role, actor) {
    if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
    if (typeof email !== 'string' || !email.trim())
      throw codedError('INVALID_EMAIL', 'A member email is required.');
    const pid = String(projectId);
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const actorRole = await lockProjectAndResolveMemberActor(client, pid, actor);
      if (role === 'owner' && actorRole !== 'owner') {
        throw codedError('FORBIDDEN', 'Only an owner can grant the owner role.');
      }
      const found = await client.query(
        'SELECT id, email, display_name FROM users WHERE email = $1',
        [String(email).trim().toLowerCase()]
      );
      const user = found.rows[0];
      if (!user) throw codedError('USER_NOT_FOUND', 'No user found with that email.');
      const existing = await client.query(
        'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2',
        [pid, Number(user.id)]
      );
      if (existing.rows[0])
        throw codedError('ALREADY_MEMBER', 'User is already a member of this project.');
      await client.query(
        'INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)',
        [pid, Number(user.id), role]
      );
      await client.query('COMMIT');
      return {
        userId: Number(user.id),
        email: user.email,
        displayName: user.display_name,
        role,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function updateProjectMemberRole(projectId, targetUserId, role, actor) {
    if (!isValidRole(role)) throw codedError('INVALID_ROLE', 'Invalid role.');
    const pid = String(projectId);
    const target = Number(targetUserId);
    if (!Number.isInteger(target) || target <= 0) {
      throw codedError('INVALID_OWNER', 'A valid member user id is required.');
    }
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const actorRole = await lockProjectAndResolveMemberActor(client, pid, actor);
      const found = await client.query(
        'SELECT project_id, user_id, role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [pid, target]
      );
      const member = found.rows[0];
      if (!member) throw codedError('MEMBER_NOT_FOUND', 'Project member not found.');
      if (role === 'owner' && member.role !== 'owner' && actorRole !== 'owner') {
        throw codedError('FORBIDDEN', 'Only an owner can grant the owner role.');
      }
      if (member.role === 'owner' && role !== 'owner' && actorRole !== 'owner') {
        throw codedError('FORBIDDEN', 'Only an owner can demote an owner.');
      }
      if (member.role === 'owner' && role !== 'owner') {
        const owners = await client.query(
          "SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'",
          [pid]
        );
        if (Number(owners.rows[0]?.n || 0) <= 1) {
          throw codedError('LAST_OWNER', 'Cannot demote the last owner of the project.');
        }
      }
      const updated = await client.query(
        'UPDATE project_members SET role = $1, updated_at = now() WHERE project_id = $2 AND user_id = $3 RETURNING project_id, user_id, role',
        [role, pid, target]
      );
      await client.query('COMMIT');
      return {
        projectId: updated.rows[0].project_id,
        userId: Number(updated.rows[0].user_id),
        role: updated.rows[0].role,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function removeProjectMember(projectId, targetUserId, actor) {
    const pid = String(projectId);
    const target = Number(targetUserId);
    if (!Number.isInteger(target) || target <= 0) {
      throw codedError('INVALID_OWNER', 'A valid member user id is required.');
    }
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const actorRole = await lockProjectAndResolveMemberActor(client, pid, actor);
      const found = await client.query(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [pid, target]
      );
      const member = found.rows[0];
      if (!member) throw codedError('MEMBER_NOT_FOUND', 'Project member not found.');
      if (member.role === 'owner' && actorRole !== 'owner') {
        throw codedError('FORBIDDEN', 'Only an owner can remove an owner.');
      }
      if (member.role === 'owner') {
        const owners = await client.query(
          "SELECT COUNT(*)::int AS n FROM project_members WHERE project_id = $1 AND role = 'owner'",
          [pid]
        );
        if (Number(owners.rows[0]?.n || 0) <= 1) {
          throw codedError('LAST_OWNER', 'Cannot remove the last owner of the project.');
        }
      }
      await client.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
        pid,
        target,
      ]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    generateOrganizationId,
    generateProjectId,
    createOrganization,
    getOrganization,
    createProject,
    getProject,
    addProjectMember,
    getProjectRole,
    verifyProjectMember,
    requireProjectRole,
    getProjectForUser,
    listProjectsForUser,
    listProjectMembers,
    createOrganizationForUser,
    getOrganizationForUser,
    listOrganizationsForUser,
    verifyOrganizationMember,
    requireOrganizationRole,
    addOrganizationMember,
    createProjectForUser,
    updateProject,
    getProjectMember,
    countProjectOwners,
    addProjectMemberByEmail,
    updateProjectMemberRole,
    removeProjectMember,
  };
}

module.exports = { createProjectStore, PROJECT_ROLES, MAX_NAME_LENGTH, isValidRole };
