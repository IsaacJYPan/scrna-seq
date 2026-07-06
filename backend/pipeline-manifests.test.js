import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const {
  initDatabase, closeDatabase,
  createOrganizationForUser, createProjectForUser, addProjectMemberByEmail,
} = require('./database');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { DEFAULT_PIPELINE_ID } = require('./pipelineManifests');

let server;

beforeAll(async () => { server = await startServer(); });
afterAll(() => { if (server) server.close(); });

beforeEach(() => { initDatabase(':memory:'); });
afterEach(() => { closeDatabase(); });

function users() {
  const alice = createUserWithToken({ email: 'alice@example.com', displayName: 'Alice' });
  const bob = createUserWithToken({ email: 'bob@example.com', displayName: 'Bob' });
  const dave = createUserWithToken({ email: 'dave@example.com', displayName: 'Dave' });
  return { alice, bob, dave };
}

function seedProject(ownerUserId) {
  const org = createOrganizationForUser(ownerUserId, { name: 'Acme Labs' });
  return createProjectForUser(ownerUserId, { organizationId: org.id, name: 'Project X' });
}

function addMember(projectId, email, role) {
  return addProjectMemberByEmail(projectId, email, role, 'owner');
}

const manifest = (over = {}) => ({
  schemaVersion: 1,
  id: 'custom-seurat-view',
  name: 'Custom Seurat View',
  modality: 'scrna',
  tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
  ...over,
});

describe('project pipeline definitions and user-project selection', () => {
  it('defaults each project member to the built-in Seurat pipeline', async () => {
    const { alice, bob } = users();
    const proj = seedProject(alice.user.id);
    addMember(proj.id, 'bob@example.com', 'viewer');

    const aliceSelection = await api(server, `/api/projects/${proj.id}/pipeline-selection`, { token: alice.token });
    const bobSelection = await api(server, `/api/projects/${proj.id}/pipeline-selection`, { token: bob.token });

    expect(aliceSelection.status).toBe(200);
    expect(bobSelection.status).toBe(200);
    expect(aliceSelection.data.pipelineId).toBe(DEFAULT_PIPELINE_ID);
    expect(bobSelection.data.pipelineId).toBe(DEFAULT_PIPELINE_ID);
    expect(aliceSelection.data.definition.manifest.tabs.some(tab => tab.icon)).toBe(false);
  });

  it('keeps active pipeline selection scoped to user plus project', async () => {
    const { alice, bob } = users();
    const proj = seedProject(alice.user.id);
    addMember(proj.id, 'bob@example.com', 'admin');

    const created = await api(server, `/api/projects/${proj.id}/pipeline-definitions`, {
      method: 'POST',
      token: alice.token,
      body: { manifest: manifest(), visibility: 'project' },
    });
    expect(created.status).toBe(201);
    expect(created.data.id).toMatch(/^pipe_[0-9a-f]+$/);

    const selected = await api(server, `/api/projects/${proj.id}/pipeline-selection`, {
      method: 'PUT',
      token: alice.token,
      body: { pipelineId: created.data.id },
    });
    expect(selected.status).toBe(200);
    expect(selected.data.pipelineId).toBe(created.data.id);

    const bobSelection = await api(server, `/api/projects/${proj.id}/pipeline-selection`, { token: bob.token });
    expect(bobSelection.status).toBe(200);
    expect(bobSelection.data.pipelineId).toBe(DEFAULT_PIPELINE_ID);
  });

  it('requires route-backed tab ids and stores validated UI templates', async () => {
    const { alice } = users();
    const proj = seedProject(alice.user.id);

    const badRoute = await api(server, `/api/projects/${proj.id}/pipeline-definitions`, {
      method: 'POST',
      token: alice.token,
      body: {
        manifest: manifest({
          id: 'custom-route-mismatch',
          tabs: [{ id: 'my-qc', label: 'QC', moduleKey: 'seuratQc' }],
        }),
      },
    });
    expect(badRoute.status).toBe(400);
    expect(badRoute.data.error).toMatch(/must be 'qc'/i);

    const badArtifact = await api(server, `/api/projects/${proj.id}/pipeline-definitions`, {
      method: 'POST',
      token: alice.token,
      body: {
        manifest: manifest({
          id: 'custom-artifact-mismatch',
          tabs: [{ id: 'qc', label: 'QC', moduleKey: 'seuratQc', resultArtifactTypes: ['deg_markers'] }],
        }),
      },
    });
    expect(badArtifact.status).toBe(400);
    expect(badArtifact.data.error).toMatch(/not produced by the registered module/i);

    const created = await api(server, `/api/projects/${proj.id}/pipeline-definitions`, {
      method: 'POST',
      token: alice.token,
      body: {
        manifest: manifest({
          id: 'custom-qc-view',
          tabs: [{
            id: 'qc',
            label: 'QC Review',
            moduleKey: 'seuratQc',
            parameterSchema: [{ key: 'minfeatures', label: 'Minimum features', type: 'integer' }],
            resultViews: ['plotlyViolin', { type: 'summaryMetrics', title: 'Summary' }],
          }],
        }),
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.manifest.tabs[0]).toEqual(expect.objectContaining({
      id: 'qc',
      routeId: 'qc',
      parameterSchema: [expect.objectContaining({ key: 'minfeatures', type: 'integer' })],
      resultViews: ['plotlyViolin', expect.objectContaining({ type: 'summaryMetrics' })],
    }));
  });

  it('rejects unsafe uploaded manifest fields before storage', async () => {
    const { alice } = users();
    const proj = seedProject(alice.user.id);

    for (const badTab of [
      { id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', icon: 'Activity' },
      { id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', endpoint: '/api/r/deg' },
      { id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', code: 'RunPCA(global_obj)' },
    ]) {
      const res = await api(server, `/api/projects/${proj.id}/pipeline-definitions`, {
        method: 'POST',
        token: alice.token,
        body: { manifest: manifest({ tabs: [badTab] }) },
      });
      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(/not allowed/i);
    }
  });

  it('does not leak pipeline routes to non-members', async () => {
    const { alice, dave } = users();
    const proj = seedProject(alice.user.id);

    expect((await api(server, `/api/projects/${proj.id}/pipeline-definitions`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/pipeline-selection`, { token: dave.token })).status).toBe(404);
    expect((await api(server, `/api/projects/${proj.id}/pipeline-selection`, {
      method: 'PUT',
      token: dave.token,
      body: { pipelineId: DEFAULT_PIPELINE_ID },
    })).status).toBe(404);
  });
});
