import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const {
  initDatabase, closeDatabase, createUser,
  createOrganizationForUser, createProjectForUser,
  verifyOrganizationMember, requireOrganizationRole,
  verifyProjectMember, requireProjectRole,
  listOrganizationsForUser, listProjectsForUser,
  addProjectMemberByEmail, updateProjectMemberRole, removeProjectMember,
  countProjectOwners, getProjectMember, isValidRole, addOrganizationMember
} = require('./database');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

// There is intentionally no org-member management *route* in this branch, so the
// HTTP tests seed extra org members directly through the DB helper a future
// org-membership route would call. `addOrgMember`/`addOrgMemberDirect` are thin
// aliases used throughout the suite.
function addOrgMember(organizationId, userId, role) {
  return addOrganizationMember(organizationId, userId, role);
}
const addOrgMemberDirect = addOrgMember;

let server;

beforeAll(async () => { server = await startServer(); });
afterAll(() => { if (server) server.close(); });

beforeEach(() => { initDatabase(':memory:'); });
afterEach(() => { closeDatabase(); });

function users() {
  const alice = createUserWithToken({ email: 'alice@example.com', displayName: 'Alice' });
  const bob = createUserWithToken({ email: 'bob@example.com', displayName: 'Bob' });
  const carol = createUserWithToken({ email: 'carol@example.com', displayName: 'Carol' });
  return { alice, bob, carol };
}

async function createOrg(token, body = { name: 'Acme Labs' }) {
  return api(server, '/api/organizations', { method: 'POST', token, body });
}

async function createProject(token, organizationId, body = {}) {
  return api(server, '/api/projects', {
    method: 'POST', token, body: { organizationId, name: 'Project X', ...body }
  });
}

// ── HTTP: authentication ───────────────────────────────────────────────────
describe('org/project API — authentication', () => {
  it('rejects unauthenticated access on every org/project/member route', async () => {
    const routes = [
      ['GET', '/api/organizations'],
      ['POST', '/api/organizations'],
      ['GET', '/api/organizations/org_x'],
      ['GET', '/api/projects'],
      ['POST', '/api/projects'],
      ['GET', '/api/projects/proj_x'],
      ['PATCH', '/api/projects/proj_x'],
      ['GET', '/api/projects/proj_x/members'],
      ['POST', '/api/projects/proj_x/members'],
      ['PATCH', '/api/projects/proj_x/members/1'],
      ['DELETE', '/api/projects/proj_x/members/1']
    ];
    for (const [method, path] of routes) {
      const res = await api(server, path, { method, body: method === 'GET' ? undefined : {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── HTTP: organizations ────────────────────────────────────────────────────
describe('organizations API', () => {
  it('lets an authenticated user create an organization with a server id', async () => {
    const { alice } = users();
    const res = await createOrg(alice.token, { name: 'Acme Labs' });
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^org_[0-9a-f]+$/);
    expect(res.data.name).toBe('Acme Labs');
    expect(res.data.ownerUserId).toBe(alice.user.id);
  });

  it('makes the creator an owner member', async () => {
    const { alice } = users();
    const org = (await createOrg(alice.token)).data;
    expect(org.role).toBe('owner');
    expect(verifyOrganizationMember(alice.user.id, org.id).role).toBe('owner');
  });

  it('rejects a blank name', async () => {
    const { alice } = users();
    const res = await createOrg(alice.token, { name: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects client-provided id / owner / role fields', async () => {
    const { alice, bob } = users();
    for (const body of [
      { name: 'X', id: 'org_hax' },
      { name: 'X', ownerUserId: bob.user.id },
      { name: 'X', owner_user_id: bob.user.id },
      { name: 'X', userId: bob.user.id },
      { name: 'X', user_id: bob.user.id },
      { name: 'X', role: 'owner' }
    ]) {
      const res = await createOrg(alice.token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('lists only organizations the user belongs to', async () => {
    const { alice, bob } = users();
    await createOrg(alice.token, { name: 'Alice Org' });
    await createOrg(alice.token, { name: 'Alice Org 2' });
    await createOrg(bob.token, { name: 'Bob Org' });

    const aliceList = await api(server, '/api/organizations', { token: alice.token });
    const bobList = await api(server, '/api/organizations', { token: bob.token });
    expect(aliceList.data).toHaveLength(2);
    expect(bobList.data).toHaveLength(1);
    expect(bobList.data[0].name).toBe('Bob Org');
  });

  it('returns 404 reading an organization the user does not belong to', async () => {
    const { alice, bob } = users();
    const org = (await createOrg(alice.token)).data;
    expect((await api(server, `/api/organizations/${org.id}`, { token: alice.token })).status).toBe(200);
    expect((await api(server, `/api/organizations/${org.id}`, { token: bob.token })).status).toBe(404);
    expect((await api(server, '/api/organizations/org_does_not_exist', { token: alice.token })).status).toBe(404);
  });
});

// ── HTTP: projects ─────────────────────────────────────────────────────────
describe('projects API', () => {
  it('lets an org owner create a project; creator becomes project owner', async () => {
    const { alice } = users();
    const org = (await createOrg(alice.token)).data;
    const res = await createProject(alice.token, org.id, { name: 'scRNA pilot', description: 'pilot run' });
    expect(res.status).toBe(201);
    expect(res.data.id).toMatch(/^proj_[0-9a-f]+$/);
    expect(res.data.organizationId).toBe(org.id);
    expect(res.data.name).toBe('scRNA pilot');
    expect(res.data.description).toBe('pilot run');
    expect(res.data.createdByUserId).toBe(alice.user.id);
    expect(res.data.role).toBe('owner');
  });

  it('lets an org admin create a project', async () => {
    const { alice, bob } = users();
    const org = (await createOrg(alice.token)).data;
    // Make bob an org admin directly (no org-member route in this branch).
    addOrgMember(org.id, bob.user.id, 'admin');
    const res = await createProject(bob.token, org.id);
    expect(res.status).toBe(201);
  });

  it('returns 404 when a non-member tries to create a project in an org', async () => {
    const { alice, bob } = users();
    const org = (await createOrg(alice.token)).data;
    const res = await createProject(bob.token, org.id);
    expect(res.status).toBe(404); // never reveal the org exists
  });

  it('returns 403 when an org viewer/analyst tries to create a project', async () => {
    const { alice, bob, carol } = users();
    const org = (await createOrg(alice.token)).data;
    addOrgMember(org.id, bob.user.id, 'viewer');
    addOrgMember(org.id, carol.user.id, 'analyst');
    expect((await createProject(bob.token, org.id)).status).toBe(403);
    expect((await createProject(carol.token, org.id)).status).toBe(403);
  });

  it('rejects a project create with a missing/unknown org', async () => {
    const { alice } = users();
    expect((await api(server, '/api/projects', { method: 'POST', token: alice.token, body: { name: 'X' } })).status).toBe(400);
    expect((await createProject(alice.token, 'org_missing')).status).toBe(404);
  });

  it('rejects client-provided id / creator / owner / role fields on create', async () => {
    const { alice, bob } = users();
    const org = (await createOrg(alice.token)).data;
    for (const extra of [
      { id: 'proj_hax' },
      { createdByUserId: bob.user.id },
      { created_by_user_id: bob.user.id },
      { ownerUserId: bob.user.id },
      { owner_user_id: bob.user.id },
      { role: 'owner' }
    ]) {
      const res = await createProject(alice.token, org.id, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('lists only projects the user is a member of', async () => {
    const { alice, bob } = users();
    const org = (await createOrg(alice.token)).data;
    await createProject(alice.token, org.id, { name: 'P1' });
    await createProject(alice.token, org.id, { name: 'P2' });

    const aliceList = await api(server, '/api/projects', { token: alice.token });
    const bobList = await api(server, '/api/projects', { token: bob.token });
    expect(aliceList.data).toHaveLength(2);
    expect(bobList.data).toHaveLength(0); // bob is an org member of nothing
  });

  it('returns 404 reading a project the user is not a member of', async () => {
    const { alice, bob } = users();
    const org = (await createOrg(alice.token)).data;
    const proj = (await createProject(alice.token, org.id)).data;
    expect((await api(server, `/api/projects/${proj.id}`, { token: alice.token })).status).toBe(200);
    expect((await api(server, `/api/projects/${proj.id}`, { token: bob.token })).status).toBe(404);
    expect((await api(server, '/api/projects/proj_missing', { token: alice.token })).status).toBe(404);
  });

  it('lets owner/admin update a project but a viewer cannot', async () => {
    const { alice, bob } = users();
    const org = (await createOrg(alice.token)).data;
    const proj = (await createProject(alice.token, org.id)).data;

    const updated = await api(server, `/api/projects/${proj.id}`, {
      method: 'PATCH', token: alice.token, body: { name: 'Renamed', description: 'new desc' }
    });
    expect(updated.status).toBe(200);
    expect(updated.data.name).toBe('Renamed');
    expect(updated.data.description).toBe('new desc');

    // Add bob as a viewer; he cannot update (403).
    await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'bob@example.com', role: 'viewer' }
    });
    const denied = await api(server, `/api/projects/${proj.id}`, {
      method: 'PATCH', token: bob.token, body: { name: 'Hacked' }
    });
    expect(denied.status).toBe(403);
  });

  it('returns 404 (not 403) when a non-member tries to update a project', async () => {
    const { alice, bob } = users();
    const org = (await createOrg(alice.token)).data;
    const proj = (await createProject(alice.token, org.id)).data;
    const res = await api(server, `/api/projects/${proj.id}`, {
      method: 'PATCH', token: bob.token, body: { name: 'Hacked' }
    });
    expect(res.status).toBe(404);
  });

  it('rejects a project update with no updatable fields', async () => {
    const { alice } = users();
    const org = (await createOrg(alice.token)).data;
    const proj = (await createProject(alice.token, org.id)).data;
    const res = await api(server, `/api/projects/${proj.id}`, { method: 'PATCH', token: alice.token, body: {} });
    expect(res.status).toBe(400);
  });

  it('rejects reparenting / server-controlled fields on update', async () => {
    const { alice } = users();
    const org = (await createOrg(alice.token)).data;
    const proj = (await createProject(alice.token, org.id)).data;
    for (const body of [{ organizationId: 'org_other' }, { id: 'proj_other' }, { createdByUserId: 999 }]) {
      const res = await api(server, `/api/projects/${proj.id}`, { method: 'PATCH', token: alice.token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

// ── HTTP: project membership management ─────────────────────────────────────
describe('project members API', () => {
  async function setup() {
    const u = users();
    const org = (await createOrg(u.alice.token)).data;
    const proj = (await createProject(u.alice.token, org.id)).data;
    return { ...u, org, proj };
  }

  function addMember(token, projectId, email, role) {
    return api(server, `/api/projects/${projectId}/members`, { method: 'POST', token, body: { email, role } });
  }
  function patchMemberRole(token, projectId, userId, role) {
    return api(server, `/api/projects/${projectId}/members/${userId}`, { method: 'PATCH', token, body: { role } });
  }
  function removeMember(token, projectId, userId) {
    return api(server, `/api/projects/${projectId}/members/${userId}`, { method: 'DELETE', token });
  }

  it('lets an owner add an existing user by exact email', async () => {
    const { alice, bob, proj } = await setup();
    const res = await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'bob@example.com', role: 'analyst' }
    });
    expect(res.status).toBe(201);
    expect(res.data.userId).toBe(bob.user.id);
    expect(res.data.role).toBe('analyst');
  });

  it('lists project members for any member', async () => {
    const { alice, bob, proj } = await setup();
    await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'bob@example.com', role: 'viewer' }
    });
    const list = await api(server, `/api/projects/${proj.id}/members`, { token: bob.token });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(2);
    expect(list.data.map(m => m.email).sort()).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('lets an admin manage members but an analyst cannot', async () => {
    const { alice, bob, carol, proj } = await setup();
    // bob is admin, carol is analyst
    await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'bob@example.com', role: 'admin' }
    });
    await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'carol@example.com', role: 'analyst' }
    });

    // Admin (bob) can add a member — recreate a 4th user to add.
    createUser('dave@example.com', 'password123', 'Dave');
    const adminAdd = await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: bob.token, body: { email: 'dave@example.com', role: 'viewer' }
    });
    expect(adminAdd.status).toBe(201);

    // Analyst (carol) cannot manage members → 403.
    const analystAdd = await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: carol.token, body: { email: 'dave@example.com', role: 'admin' }
    });
    expect(analystAdd.status).toBe(403);
  });

  it('lets an owner change a member role and remove a member', async () => {
    const { alice, bob, proj } = await setup();
    await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'bob@example.com', role: 'viewer' }
    });

    const changed = await api(server, `/api/projects/${proj.id}/members/${bob.user.id}`, {
      method: 'PATCH', token: alice.token, body: { role: 'admin' }
    });
    expect(changed.status).toBe(200);
    expect(changed.data.role).toBe('admin');

    const removed = await api(server, `/api/projects/${proj.id}/members/${bob.user.id}`, {
      method: 'DELETE', token: alice.token
    });
    expect(removed.status).toBe(200);
    expect(getProjectMember(proj.id, bob.user.id)).toBeNull();
  });

  it('refuses to remove or demote the last owner (409)', async () => {
    const { alice, proj } = await setup();
    const remove = await api(server, `/api/projects/${proj.id}/members/${alice.user.id}`, {
      method: 'DELETE', token: alice.token
    });
    expect(remove.status).toBe(409);
    const demote = await api(server, `/api/projects/${proj.id}/members/${alice.user.id}`, {
      method: 'PATCH', token: alice.token, body: { role: 'admin' }
    });
    expect(demote.status).toBe(409);
  });

  it('handles duplicate membership safely (409)', async () => {
    const { alice, proj } = await setup();
    const body = { email: 'bob@example.com', role: 'viewer' };
    expect((await api(server, `/api/projects/${proj.id}/members`, { method: 'POST', token: alice.token, body })).status).toBe(201);
    const dup = await api(server, `/api/projects/${proj.id}/members`, { method: 'POST', token: alice.token, body });
    expect(dup.status).toBe(409);
  });

  it('rejects a malformed role on add and update (400)', async () => {
    const { alice, bob, proj } = await setup();
    const badAdd = await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'bob@example.com', role: 'superuser' }
    });
    expect(badAdd.status).toBe(400);

    await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'bob@example.com', role: 'viewer' }
    });
    const badUpdate = await api(server, `/api/projects/${proj.id}/members/${bob.user.id}`, {
      method: 'PATCH', token: alice.token, body: { role: 'superuser' }
    });
    expect(badUpdate.status).toBe(400);
  });

  it('returns 404 adding an email with no account (no enumeration via search)', async () => {
    const { alice, proj } = await setup();
    const res = await api(server, `/api/projects/${proj.id}/members`, {
      method: 'POST', token: alice.token, body: { email: 'ghost@example.com', role: 'viewer' }
    });
    expect(res.status).toBe(404);
  });

  it('rejects body-provided user/id fields on add member', async () => {
    const { alice, bob, proj } = await setup();
    for (const extra of [{ userId: bob.user.id }, { user_id: bob.user.id }, { id: 'x' }, { projectId: 'p' }]) {
      const res = await api(server, `/api/projects/${proj.id}/members`, {
        method: 'POST', token: alice.token, body: { email: 'bob@example.com', role: 'viewer', ...extra }
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('returns 404 managing members of a project the caller cannot access', async () => {
    const { bob, proj } = await setup();
    expect((await api(server, `/api/projects/${proj.id}/members`, { token: bob.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/members`, { method: 'POST', token: bob.token, body: { email: 'x@example.com', role: 'viewer' } })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/members/1`, { method: 'PATCH', token: bob.token, body: { role: 'viewer' } })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/members/1`, { method: 'DELETE', token: bob.token })).status).toBe(404);
  });

  it('returns 404 updating/removing a non-existent member of an accessible project', async () => {
    const { alice, proj } = await setup();
    expect((await api(server, `/api/projects/${proj.id}/members/99999`, { method: 'PATCH', token: alice.token, body: { role: 'viewer' } })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/members/99999`, { method: 'DELETE', token: alice.token })).status).toBe(404);
  });

  // ── Owner-only operations: admins cannot grant/demote/remove owners ─────────
  // Intended hierarchy: owner > admin. An admin may manage admin/analyst/viewer
  // members, but only an owner may grant the owner role or demote/remove an
  // existing owner. Insufficient role → 403; the last-owner guard (409) and the
  // 404-for-non-members discipline are preserved.

  it('forbids an admin from promoting self to owner (403)', async () => {
    const { alice, bob, proj } = await setup();
    expect((await addMember(alice.token, proj.id, 'bob@example.com', 'admin')).status).toBe(201);
    const res = await patchMemberRole(bob.token, proj.id, bob.user.id, 'owner');
    expect(res.status).toBe(403);
    expect(getProjectMember(proj.id, bob.user.id).role).toBe('admin'); // unchanged
  });

  it('forbids an admin from promoting another member to owner (403)', async () => {
    const { alice, bob, carol, proj } = await setup();
    expect((await addMember(alice.token, proj.id, 'bob@example.com', 'admin')).status).toBe(201);
    expect((await addMember(alice.token, proj.id, 'carol@example.com', 'viewer')).status).toBe(201);
    const res = await patchMemberRole(bob.token, proj.id, carol.user.id, 'owner');
    expect(res.status).toBe(403);
    expect(getProjectMember(proj.id, carol.user.id).role).toBe('viewer'); // unchanged
  });

  it('forbids an admin from adding a new member directly as owner (403)', async () => {
    const { alice, bob, proj } = await setup();
    expect((await addMember(alice.token, proj.id, 'bob@example.com', 'admin')).status).toBe(201);
    createUser('dave@example.com', 'password123', 'Dave');
    const res = await addMember(bob.token, proj.id, 'dave@example.com', 'owner');
    expect(res.status).toBe(403);
  });

  it('forbids an admin from demoting an owner even when multiple owners exist (403)', async () => {
    const { alice, bob, carol, proj } = await setup();
    // alice (owner) grants bob a second owner seat, and makes carol an admin.
    expect((await addMember(alice.token, proj.id, 'bob@example.com', 'owner')).status).toBe(201);
    expect((await addMember(alice.token, proj.id, 'carol@example.com', 'admin')).status).toBe(201);
    expect(countProjectOwners(proj.id)).toBe(2);
    const res = await patchMemberRole(carol.token, proj.id, bob.user.id, 'admin');
    expect(res.status).toBe(403); // not 409 — admin may never demote an owner
    expect(getProjectMember(proj.id, bob.user.id).role).toBe('owner'); // unchanged
  });

  it('forbids an admin from removing an owner even when multiple owners exist (403)', async () => {
    const { alice, bob, carol, proj } = await setup();
    expect((await addMember(alice.token, proj.id, 'bob@example.com', 'owner')).status).toBe(201);
    expect((await addMember(alice.token, proj.id, 'carol@example.com', 'admin')).status).toBe(201);
    expect(countProjectOwners(proj.id)).toBe(2);
    const res = await removeMember(carol.token, proj.id, bob.user.id);
    expect(res.status).toBe(403);
    expect(getProjectMember(proj.id, bob.user.id).role).toBe('owner'); // unchanged
  });

  it('lets an owner promote another member to owner', async () => {
    const { alice, bob, proj } = await setup();
    expect((await addMember(alice.token, proj.id, 'bob@example.com', 'admin')).status).toBe(201);
    const res = await patchMemberRole(alice.token, proj.id, bob.user.id, 'owner');
    expect(res.status).toBe(200);
    expect(res.data.role).toBe('owner');
    expect(countProjectOwners(proj.id)).toBe(2);
  });

  it('lets an owner demote and remove a non-last owner', async () => {
    const { alice, bob, proj } = await setup();
    expect((await addMember(alice.token, proj.id, 'bob@example.com', 'owner')).status).toBe(201);
    expect(countProjectOwners(proj.id)).toBe(2);

    const demoted = await patchMemberRole(alice.token, proj.id, bob.user.id, 'admin');
    expect(demoted.status).toBe(200);
    expect(demoted.data.role).toBe('admin');
    expect(countProjectOwners(proj.id)).toBe(1);

    // Re-promote and then remove the second owner.
    expect((await patchMemberRole(alice.token, proj.id, bob.user.id, 'owner')).status).toBe(200);
    const removed = await removeMember(alice.token, proj.id, bob.user.id);
    expect(removed.status).toBe(200);
    expect(getProjectMember(proj.id, bob.user.id)).toBeNull();
  });

  it('still returns 409 when an owner would remove or demote the last owner', async () => {
    const { alice, proj } = await setup();
    expect((await removeMember(alice.token, proj.id, alice.user.id)).status).toBe(409);
    expect((await patchMemberRole(alice.token, proj.id, alice.user.id, 'admin')).status).toBe(409);
  });

  it('still returns 404 when a non-member attempts owner-role member management', async () => {
    const { alice, bob, carol, proj } = await setup();
    // bob is a real owner of the project; carol is not a member at all.
    expect((await addMember(alice.token, proj.id, 'bob@example.com', 'owner')).status).toBe(201);
    expect((await patchMemberRole(carol.token, proj.id, bob.user.id, 'admin')).status).toBe(404);
    expect((await removeMember(carol.token, proj.id, bob.user.id)).status).toBe(404);
    expect((await addMember(carol.token, proj.id, 'carol@example.com', 'owner')).status).toBe(404);
  });
});

// ── DB helper layer ─────────────────────────────────────────────────────────
// Direct helper tests (not only HTTP) covering the authorization predicates and
// membership invariants, mirroring backend/jobs.test.js's helper-layer suite.
describe('org/project DB helpers', () => {
  function setup() {
    const alice = createUser('alice@example.com', 'password123', 'Alice');
    const bob = createUser('bob@example.com', 'password123', 'Bob');
    const carol = createUser('carol@example.com', 'password123', 'Carol');
    return { alice, bob, carol };
  }

  it('validates roles', () => {
    for (const r of ['owner', 'admin', 'analyst', 'viewer']) expect(isValidRole(r)).toBe(true);
    for (const r of ['superuser', '', null, undefined, 'Owner']) expect(isValidRole(r)).toBe(false);
  });

  it('creates an org with the creator as owner member', () => {
    const { alice } = setup();
    const org = createOrganizationForUser(alice.id, { name: 'Acme' });
    expect(org.id).toMatch(/^org_[0-9a-f]+$/);
    expect(org.role).toBe('owner');
    expect(verifyOrganizationMember(alice.id, org.id).role).toBe('owner');
  });

  it('requireOrganizationRole distinguishes 404 (non-member) from 403 (wrong role)', () => {
    const { alice, bob, carol } = setup();
    const org = createOrganizationForUser(alice.id, { name: 'Acme' });
    addOrgMemberDirect(org.id, bob.id, 'viewer');

    expect(() => requireOrganizationRole(carol.id, org.id, ['owner'])).toThrow(/not found/i); // non-member
    try {
      requireOrganizationRole(bob.id, org.id, ['owner', 'admin']);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('FORBIDDEN'); // member, wrong role
    }
    expect(requireOrganizationRole(alice.id, org.id, ['owner']).role).toBe('owner');
  });

  it('createProjectForUser enforces org owner/admin and seeds an owner member', () => {
    const { alice, bob } = setup();
    const org = createOrganizationForUser(alice.id, { name: 'Acme' });
    addOrgMemberDirect(org.id, bob.id, 'viewer');

    const proj = createProjectForUser(alice.id, { organizationId: org.id, name: 'P' });
    expect(proj.role).toBe('owner');
    expect(verifyProjectMember(alice.id, proj.id).role).toBe('owner');

    // Org viewer cannot create a project (FORBIDDEN), non-member → NOT_FOUND.
    expect(() => createProjectForUser(bob.id, { organizationId: org.id, name: 'P2' }))
      .toThrow(/permission/i);
    expect(() => createProjectForUser(99999, { organizationId: org.id, name: 'P3' }))
      .toThrow(); // invalid owner / not found
  });

  it('scopes listings to membership', () => {
    const { alice, bob } = setup();
    const orgA = createOrganizationForUser(alice.id, { name: 'A' });
    createOrganizationForUser(bob.id, { name: 'B' });
    createProjectForUser(alice.id, { organizationId: orgA.id, name: 'PA' });

    expect(listOrganizationsForUser(alice.id)).toHaveLength(1);
    expect(listProjectsForUser(alice.id)).toHaveLength(1);
    expect(listProjectsForUser(bob.id)).toHaveLength(0);
  });

  it('enforces the last-owner invariant on demote and remove', () => {
    const { alice, bob } = setup();
    const org = createOrganizationForUser(alice.id, { name: 'Acme' });
    const proj = createProjectForUser(alice.id, { organizationId: org.id, name: 'P' });

    // alice is the acting owner throughout (actorRole 'owner').
    expect(() => updateProjectMemberRole(proj.id, alice.id, 'admin', 'owner')).toThrow(/last owner/i);
    expect(() => removeProjectMember(proj.id, alice.id, 'owner')).toThrow(/last owner/i);
    expect(countProjectOwners(proj.id)).toBe(1);

    // With a second owner, the original can be demoted/removed.
    addProjectMemberByEmail(proj.id, 'bob@example.com', 'owner', 'owner');
    expect(countProjectOwners(proj.id)).toBe(2);
    expect(updateProjectMemberRole(proj.id, alice.id, 'admin', 'owner').role).toBe('admin');
    expect(countProjectOwners(proj.id)).toBe(1);
  });

  it('rejects duplicate and unknown-email member adds', () => {
    const { alice, bob } = setup();
    const org = createOrganizationForUser(alice.id, { name: 'Acme' });
    const proj = createProjectForUser(alice.id, { organizationId: org.id, name: 'P' });

    addProjectMemberByEmail(proj.id, 'bob@example.com', 'viewer');
    expect(() => addProjectMemberByEmail(proj.id, 'bob@example.com', 'viewer')).toThrow(/already a member/i);
    expect(() => addProjectMemberByEmail(proj.id, 'nobody@example.com', 'viewer')).toThrow(/no user/i);
    expect(() => addProjectMemberByEmail(proj.id, 'bob@example.com', 'superuser')).toThrow(/invalid role/i);
  });

  it('enforces owner-only owner operations at the helper layer (fail closed)', () => {
    const { alice, bob, carol } = setup();
    const org = createOrganizationForUser(alice.id, { name: 'Acme' });
    const proj = createProjectForUser(alice.id, { organizationId: org.id, name: 'P' });
    addProjectMemberByEmail(proj.id, 'bob@example.com', 'admin', 'owner');
    addProjectMemberByEmail(proj.id, 'carol@example.com', 'owner', 'owner'); // second owner

    // A non-owner actor (admin) may not grant, demote, or remove an owner.
    const forbids = (fn) => {
      try { fn(); throw new Error('should have thrown'); }
      catch (e) { expect(e.code).toBe('FORBIDDEN'); }
    };
    forbids(() => addProjectMemberByEmail(proj.id, 'bob@example.com', 'owner', 'admin'));
    forbids(() => updateProjectMemberRole(proj.id, bob.id, 'owner', 'admin'));   // promote → owner
    forbids(() => updateProjectMemberRole(proj.id, carol.id, 'admin', 'admin')); // demote owner
    forbids(() => removeProjectMember(proj.id, carol.id, 'admin'));              // remove owner

    // Fail closed: a missing actorRole is treated as non-owner.
    forbids(() => updateProjectMemberRole(proj.id, carol.id, 'admin'));

    // The owner actor can perform the same operations.
    expect(updateProjectMemberRole(proj.id, carol.id, 'admin', 'owner').role).toBe('admin');
    expect(countProjectOwners(proj.id)).toBe(1);
  });
});
