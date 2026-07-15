const PROJECT_SELECTION_PREFIX = 'benchone_selected_project_';
const OBJECT_SELECTION_PREFIX = 'benchone_selected_analysis_object_';

function stableUserKey(user) {
  const raw = user?.id ?? user?.email ?? 'anonymous';
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '_');
}

export function selectedProjectStorageKey(user) {
  return `${PROJECT_SELECTION_PREFIX}${stableUserKey(user)}`;
}

export function selectedObjectStorageKey(user, projectId) {
  return `${OBJECT_SELECTION_PREFIX}${stableUserKey(user)}_${String(projectId || 'none').replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function createEmptyWorkspace({
  id = 'ws-personal-1',
  name = 'Personal Workspace',
  type = 'personal',
  collaborators = [],
} = {}) {
  return {
    id,
    name,
    projects: [],
    objects: [],
    selectedProjectId: null,
    selectedObjectIds: [],
    activeBranch: 'main',
    branches: { main: null },
    collaborators,
    type,
    dataVersion: 0,
    annotVersion: 0,
    lastSelectedByProject: {},
  };
}

export function mapBackendProject(project) {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name || 'Untitled Project',
    description: project.description || '',
    role: project.role,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    isBackendProject: true,
  };
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function mapBackendAnalysisObject(object, liveResult = {}) {
  const metadata = object.metadata && typeof object.metadata === 'object' ? object.metadata : {};
  const summary = metadata.summary && typeof metadata.summary === 'object' ? metadata.summary : {};
  const cells = firstNumber(liveResult.cells, liveResult.n_cells, metadata.cells, metadata.n_cells, summary.cells, summary.n_cells);
  const features = firstNumber(
    liveResult.features,
    liveResult.genes,
    liveResult.n_features,
    metadata.features,
    metadata.genes,
    metadata.n_features,
    summary.features,
    summary.genes,
    summary.n_features
  );
  const density = firstNumber(liveResult.density, metadata.density, summary.density);

  return {
    id: object.id,
    projectId: object.projectId,
    name: object.displayName || metadata.displayName || metadata.name || 'Analysis Object',
    objectType: object.objectType,
    cells,
    features,
    density,
    source: metadata.source || metadata.sourceType || object.objectType,
    timestamp: object.createdAt || new Date().toISOString(),
    parentObjId: object.parentObjectId || null,
    lineageRootId: object.lineageRootId || null,
    metadata,
    isBackendAnalysisObject: true,
    // Project metadata is durable and shared; it cannot establish whether this
    // browser user's private R key is currently attached. Only a live response
    // from the current session may mark the object attached.
    liveState: liveResult && Object.keys(liveResult).length > 0 ? 'attached' : 'unknown',
  };
}

export function resolveCachedSelection(items, cachedId, { selectFirstWhenUncached = false } = {}) {
  const ids = new Set(items.map(item => item.id));
  if (cachedId) {
    return {
      selectedId: ids.has(cachedId) ? cachedId : null,
      cacheWasInvalid: !ids.has(cachedId),
    };
  }
  return {
    selectedId: selectFirstWhenUncached ? (items[0]?.id || null) : null,
    cacheWasInvalid: false,
  };
}

export async function loadBackendProjectState(api, storage, user) {
  const projects = (await api.listProjects()).map(mapBackendProject);
  const key = selectedProjectStorageKey(user);
  const cachedId = storage.getItem(key);
  const { selectedId, cacheWasInvalid } = resolveCachedSelection(projects, cachedId, {
    selectFirstWhenUncached: true,
  });

  if (cacheWasInvalid) storage.removeItem(key);
  if (selectedId) storage.setItem(key, selectedId);

  return {
    projects,
    selectedProjectId: selectedId,
    cacheWasInvalid,
    status: projects.length === 0 ? 'create-project' : (selectedId ? 'ready' : 'select-project'),
  };
}

export async function loadProjectAnalysisObjectState(api, storage, user, projectId) {
  if (!projectId) {
    return { objects: [], selectedObjectId: null, cacheWasInvalid: false, status: 'select-project' };
  }

  const objects = (await api.listProjectAnalysisObjects(projectId)).map(mapBackendAnalysisObject);
  const key = selectedObjectStorageKey(user, projectId);
  const cachedId = storage.getItem(key);
  const { selectedId, cacheWasInvalid } = resolveCachedSelection(objects, cachedId, {
    selectFirstWhenUncached: true,
  });

  if (cacheWasInvalid) storage.removeItem(key);
  if (selectedId) storage.setItem(key, selectedId);

  return {
    objects,
    selectedObjectId: selectedId,
    cacheWasInvalid,
    status: objects.length === 0 ? 'empty-project' : (selectedId ? 'ready' : 'select-object'),
  };
}

export function cacheSelectedProject(storage, user, projectId) {
  const key = selectedProjectStorageKey(user);
  if (projectId) storage.setItem(key, projectId);
  else storage.removeItem(key);
}

export function cacheSelectedAnalysisObject(storage, user, projectId, objectId) {
  const key = selectedObjectStorageKey(user, projectId);
  if (objectId) storage.setItem(key, objectId);
  else storage.removeItem(key);
}

export async function createProjectWithBackend(api, { name, description = '', organizationName = 'Personal Organization' }) {
  const orgs = await api.listOrganizations();
  let org = orgs.find(candidate => ['owner', 'admin'].includes(candidate.role));
  if (!org) {
    org = await api.createOrganization({ name: organizationName });
  }
  return mapBackendProject(await api.createProject({
    organizationId: org.id,
    name,
    description,
  }));
}

export function buildLiveLoadAnalysisObjectPayload({ displayName, sourceType, metadata = {} }) {
  return {
    objectType: 'seurat',
    displayName,
    metadata: {
      ...metadata,
      sourceType,
      liveState: 'private_transient',
      uiFlow: 'live-r-load',
    },
  };
}

export async function createAnalysisObjectForLiveLoad(api, projectId, input) {
  const payload = buildLiveLoadAnalysisObjectPayload(input);
  return api.createProjectAnalysisObject(projectId, payload);
}

// Build a small, safe display summary from a mapped analysis-object card. Only the
// finite numeric counts the Workspace/Data Info card shows are included — no storage,
// state, path, or identity fields. Returns {} when no usable numbers are present.
export function buildAnalysisObjectSummary({ cells, features, density } = {}) {
  const summary = {};
  if (Number.isFinite(cells)) summary.cells = cells;
  if (Number.isFinite(features)) summary.features = features;
  if (Number.isFinite(density)) summary.density = density;
  return summary;
}

// Persist the display summary onto the backend analysis object so the counts survive
// a browser refresh (live R counts are transient). Metadata-only; the backend rejects
// any storage/state/owner/project field and leaves R state untouched. No-ops when
// there is nothing to persist or the API does not support the call.
export async function persistAnalysisObjectSummary(api, projectId, objectId, summary) {
  if (!projectId || !objectId || !summary || Object.keys(summary).length === 0) return null;
  if (!api || typeof api.updateProjectAnalysisObjectSummary !== 'function') return null;
  return api.updateProjectAnalysisObjectSummary(projectId, objectId, summary);
}
