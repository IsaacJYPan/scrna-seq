import { describe, expect, it, vi } from 'vitest';
import {
  buildAnalysisObjectSummary,
  buildLiveLoadAnalysisObjectPayload,
  cacheSelectedAnalysisObject,
  cacheSelectedProject,
  createAnalysisObjectForLiveLoad,
  createEmptyWorkspace,
  createProjectWithBackend,
  loadBackendProjectState,
  loadProjectAnalysisObjectState,
  persistAnalysisObjectSummary,
  selectedObjectStorageKey,
  selectedProjectStorageKey,
} from './backendWorkspaceModel';

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn(key => values.delete(key)),
    dump: () => Object.fromEntries(values.entries()),
  };
}

const user = { id: 42, email: 'scientist@example.com' };

describe('backend workspace model', () => {
  it('starts without a fake durable Default Project or local analysis objects', () => {
    const ws = createEmptyWorkspace();

    expect(ws.projects).toEqual([]);
    expect(ws.objects).toEqual([]);
    expect(ws.selectedProjectId).toBeNull();
    expect(ws.selectedObjectIds).toEqual([]);
    expect(JSON.stringify(ws)).not.toContain('Default Project');
    expect(JSON.stringify(ws)).not.toContain('proj-default');
    expect(JSON.stringify(ws)).not.toContain('obj-');
  });

  it('loads projects from the API and asks for a real project when none exist', async () => {
    const api = { listProjects: vi.fn(async () => []) };
    const storage = makeStorage();

    const state = await loadBackendProjectState(api, storage, user);

    expect(api.listProjects).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      projects: [],
      selectedProjectId: null,
      status: 'create-project',
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('uses cached selected project IDs only when the backend still returns them', async () => {
    const key = selectedProjectStorageKey(user);
    const api = {
      listProjects: vi.fn(async () => [
        { id: 'proj_a', name: 'A', role: 'owner' },
        { id: 'proj_b', name: 'B', role: 'analyst' },
      ]),
    };
    const storage = makeStorage({ [key]: 'proj_b' });

    const state = await loadBackendProjectState(api, storage, user);

    expect(state.selectedProjectId).toBe('proj_b');
    expect(state.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'proj_b', isBackendProject: true, role: 'analyst' }),
    ]));
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('clears a stale cached project ID instead of inventing a replacement project', async () => {
    const key = selectedProjectStorageKey(user);
    const api = { listProjects: vi.fn(async () => [{ id: 'proj_real', name: 'Real Project' }]) };
    const storage = makeStorage({ [key]: 'proj_missing' });

    const state = await loadBackendProjectState(api, storage, user);

    expect(state.selectedProjectId).toBeNull();
    expect(state.cacheWasInvalid).toBe(true);
    expect(state.status).toBe('select-project');
    expect(storage.removeItem).toHaveBeenCalledWith(key);
    expect(JSON.stringify(storage.dump())).not.toContain('Real Project');
  });

  it('loads analysis objects from the selected backend project and clears stale object selection', async () => {
    const key = selectedObjectStorageKey(user, 'proj_1');
    const api = {
      listProjectAnalysisObjects: vi.fn(async () => [
        {
          id: 'ao_abc123',
          projectId: 'proj_1',
          objectType: 'seurat',
          displayName: 'PBMC 3k',
          metadata: { sourceType: 'pbmc3k_demo', summary: { cells: 2700, features: 13714 } },
        },
      ]),
    };
    const storage = makeStorage({ [key]: 'ao_missing' });

    const state = await loadProjectAnalysisObjectState(api, storage, user, 'proj_1');

    expect(api.listProjectAnalysisObjects).toHaveBeenCalledWith('proj_1');
    expect(state.selectedObjectId).toBeNull();
    expect(state.cacheWasInvalid).toBe(true);
    expect(storage.removeItem).toHaveBeenCalledWith(key);
    expect(state.objects).toEqual([
      expect.objectContaining({
        id: 'ao_abc123',
        projectId: 'proj_1',
        isBackendAnalysisObject: true,
        cells: 2700,
        features: 13714,
      }),
    ]);
  });

  it('does not trust durable project metadata as proof of private live R attachment', async () => {
    const api = {
      listProjectAnalysisObjects: vi.fn(async () => [{
        id: 'ao_shared',
        projectId: 'proj_1',
        objectType: 'seurat',
        metadata: { liveState: 'attached' },
      }]),
    };

    const state = await loadProjectAnalysisObjectState(api, makeStorage(), user, 'proj_1');

    expect(state.objects[0]).toMatchObject({ id: 'ao_shared', liveState: 'unknown' });
  });

  it('stores selected project/object IDs as preferences without full project or object records', () => {
    const storage = makeStorage();

    cacheSelectedProject(storage, user, 'proj_1');
    cacheSelectedAnalysisObject(storage, user, 'proj_1', 'ao_abc123');

    expect(storage.dump()).toEqual({
      [selectedProjectStorageKey(user)]: 'proj_1',
      [selectedObjectStorageKey(user, 'proj_1')]: 'ao_abc123',
    });
    expect(JSON.stringify(storage.dump())).not.toContain('"projects"');
    expect(JSON.stringify(storage.dump())).not.toContain('"objects"');
    expect(JSON.stringify(storage.dump())).not.toContain('PBMC');
  });

  it('creates projects through organizations returned by the backend', async () => {
    const api = {
      listOrganizations: vi.fn(async () => [{ id: 'org_admin', name: 'Lab', role: 'admin' }]),
      createOrganization: vi.fn(),
      createProject: vi.fn(async payload => ({ id: 'proj_1', name: payload.name, organizationId: payload.organizationId })),
    };

    const project = await createProjectWithBackend(api, { name: 'PBMC work', description: 'Demo' });

    expect(api.createOrganization).not.toHaveBeenCalled();
    expect(api.createProject).toHaveBeenCalledWith({
      organizationId: 'org_admin',
      name: 'PBMC work',
      description: 'Demo',
    });
    expect(project).toEqual(expect.objectContaining({ id: 'proj_1', isBackendProject: true }));
  });

  it('creates an organization first when the user has no writable org', async () => {
    const api = {
      listOrganizations: vi.fn(async () => [{ id: 'org_viewer', name: 'Shared', role: 'viewer' }]),
      createOrganization: vi.fn(async () => ({ id: 'org_new', name: 'Personal Organization', role: 'owner' })),
      createProject: vi.fn(async payload => ({ id: 'proj_2', name: payload.name, organizationId: payload.organizationId })),
    };

    await createProjectWithBackend(api, { name: 'New Project' });

    expect(api.createOrganization).toHaveBeenCalledWith({ name: 'Personal Organization' });
    expect(api.createProject).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_new' }));
  });

  it('builds live-load analysis object payloads without client-controlled identity, project, storage, or status fields', async () => {
    const payload = buildLiveLoadAnalysisObjectPayload({
      displayName: 'PBMC_3k_Tutorial',
      sourceType: 'pbmc3k_demo',
      metadata: { minCells: 3, minFeatures: 200 },
    });

    expect(payload).toEqual({
      objectType: 'seurat',
      displayName: 'PBMC_3k_Tutorial',
      metadata: {
        minCells: 3,
        minFeatures: 200,
        sourceType: 'pbmc3k_demo',
        liveState: 'private_transient',
        uiFlow: 'live-r-load',
      },
    });
    for (const forbidden of ['id', 'projectId', 'ownerUserId', 'createdByUserId', 'storageUri', 'storageKey', 'path', 'stateKey', 'status']) {
      expect(payload).not.toHaveProperty(forbidden);
    }

    const api = {
      createProjectAnalysisObject: vi.fn(async () => ({ id: 'ao_created', projectId: 'proj_1', objectType: 'seurat' })),
    };
    const created = await createAnalysisObjectForLiveLoad(api, 'proj_1', {
      displayName: 'PBMC_3k_Tutorial',
      sourceType: 'pbmc3k_demo',
      metadata: { minCells: 3 },
    });

    expect(api.createProjectAnalysisObject).toHaveBeenCalledWith('proj_1', expect.objectContaining({
      objectType: 'seurat',
      displayName: 'PBMC_3k_Tutorial',
    }));
    expect(created.id).toBe('ao_created');
  });

  it('builds a display summary from only finite numeric counts', () => {
    expect(buildAnalysisObjectSummary({ cells: 2700, features: 13714, density: 2.59 }))
      .toEqual({ cells: 2700, features: 13714, density: 2.59 });
    // Missing / non-finite values are dropped, never coerced to 0.
    expect(buildAnalysisObjectSummary({ cells: 2700, features: undefined, density: NaN }))
      .toEqual({ cells: 2700 });
    expect(buildAnalysisObjectSummary({})).toEqual({});
    expect(buildAnalysisObjectSummary()).toEqual({});
  });

  it('persists the summary through the backend only when there is something to send', async () => {
    const api = { updateProjectAnalysisObjectSummary: vi.fn(async () => ({ id: 'ao_1' })) };

    await persistAnalysisObjectSummary(api, 'proj_1', 'ao_1', { cells: 2700, features: 13714, density: 2.59 });
    expect(api.updateProjectAnalysisObjectSummary).toHaveBeenCalledWith('proj_1', 'ao_1', { cells: 2700, features: 13714, density: 2.59 });

    api.updateProjectAnalysisObjectSummary.mockClear();
    await persistAnalysisObjectSummary(api, 'proj_1', 'ao_1', {});
    await persistAnalysisObjectSummary(api, null, 'ao_1', { cells: 1 });
    await persistAnalysisObjectSummary(api, 'proj_1', null, { cells: 1 });
    expect(api.updateProjectAnalysisObjectSummary).not.toHaveBeenCalled();
  });

  it('reloads cells/features/density from persisted summary metadata after a refresh', async () => {
    // Simulates a browser refresh: no live R result, counts come from the object's
    // persisted metadata.summary instead of the transient live load.
    const api = {
      listProjectAnalysisObjects: vi.fn(async () => [
        {
          id: 'ao_abc123',
          projectId: 'proj_1',
          objectType: 'seurat',
          displayName: 'PBMC_3k_Tutorial',
          metadata: { sourceType: 'pbmc3k_demo', summary: { cells: 2700, features: 13714, density: 2.59 } },
        },
      ]),
    };
    const storage = makeStorage();

    const state = await loadProjectAnalysisObjectState(api, storage, user, 'proj_1');

    expect(state.objects[0]).toEqual(expect.objectContaining({
      id: 'ao_abc123',
      cells: 2700,
      features: 13714,
      density: 2.59,
    }));
  });
});
