// src/api.js
// Replaces the window.electronAPI object with standard fetch calls to our Express server.
import { publicErrorMessage } from './publicError';

// API base URL is configured via Vite env (VITE_API_BASE_URL).
// When unset, fall back to same-origin relative requests (empty base),
// which is the correct default for a single-origin deployment where the
// Express server also serves the built frontend.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const DEG_FIND_MARKERS_JOB_TYPE = 'deg.find_markers.v1';
const ENRICHMENT_GSEA_JOB_TYPE = 'enrichment.gsea.v1';
const CELLCHAT_INFERENCE_JOB_TYPE = 'cellchat.infer.v1';
const SEURAT_PIPELINE_JOB_TYPE = 'seurat.pipeline.v1';
const MULTI_SAMPLE_SEURAT_PIPELINE_JOB_TYPE = 'seurat.multisample.v1';
const SPATIAL_SEURAT_PIPELINE_JOB_TYPE = 'spatial.seurat.v1';
const CHECKPOINT_SAVE_JOB_TYPE = 'checkpoint.save.v1';
const CHECKPOINT_FORK_JOB_TYPE = 'checkpoint.fork.v1';
const DEG_FIND_MARKERS_PARAM_KEYS = new Set([
  'groupBy',
  'assay',
  'onlyPositive',
  'minPct',
  'logfcThreshold',
  'testUse',
  'maxCellsPerIdent',
  'randomSeed',
  'topMarkersPerCluster',
]);
const ENRICHMENT_GSEA_PARAM_KEYS = new Set([
  'groupBy',
  'assay',
  'targetGroup',
  'species',
  'geneSetCollection',
  'minGeneSetSize',
  'maxGeneSetSize',
  'adjustedPValueCutoff',
  'topPathways',
  'maxCellsPerIdent',
  'randomSeed',
]);
const CELLCHAT_INFERENCE_PARAM_KEYS = new Set([
  'groupBy',
  'assay',
  'species',
  'databaseCategory',
  'analysisIntent',
  'minCellsPerGroup',
  'maxCellsPerGroup',
  'maxTotalCells',
  'pValueCutoff',
  'topInteractions',
  'topPathways',
  'randomSeed',
]);
const SEURAT_PIPELINE_PARAM_KEYS = new Set([
  'minCells',
  'minFeatures',
  'applyQcFilter',
  'minFeaturesFilter',
  'maxFeaturesFilter',
  'maxPercentMt',
  'normalizationMethod',
  'scaleFactor',
  'variableFeatures',
  'pcaDims',
  'clusterDims',
  'clusterResolution',
  'umapDims',
  'umapComponents',
  'umapNeighbors',
  'umapMinDist',
  'seed',
]);

export function apiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

export function buildDegFindMarkersJobPayload(objectId, params = {}) {
  const safeParams = {};
  const rawParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (DEG_FIND_MARKERS_PARAM_KEYS.has(key)) safeParams[key] = value;
  }
  return {
    jobType: DEG_FIND_MARKERS_JOB_TYPE,
    analysisObjectId: objectId,
    parameters: safeParams,
  };
}

export function buildEnrichmentGseaJobPayload(objectId, params = {}) {
  const safeParams = {};
  const rawParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (ENRICHMENT_GSEA_PARAM_KEYS.has(key)) safeParams[key] = value;
  }
  return {
    jobType: ENRICHMENT_GSEA_JOB_TYPE,
    analysisObjectId: objectId,
    parameters: safeParams,
  };
}

export function buildCellChatInferenceJobPayload(objectId, params = {}) {
  const safeParams = {};
  const rawParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (CELLCHAT_INFERENCE_PARAM_KEYS.has(key)) safeParams[key] = value;
  }
  return {
    jobType: CELLCHAT_INFERENCE_JOB_TYPE,
    analysisObjectId: objectId,
    parameters: safeParams,
  };
}

export function buildSeuratPipelineJobPayload({ datasetId, analysisObjectId, params = {} } = {}) {
  const safeParams = {};
  const rawParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (SEURAT_PIPELINE_PARAM_KEYS.has(key)) safeParams[key] = value;
  }
  return {
    jobType: SEURAT_PIPELINE_JOB_TYPE,
    ...(datasetId ? { datasetId } : {}),
    ...(analysisObjectId ? { analysisObjectId } : {}),
    parameters: safeParams,
  };
}

export function buildSpatialSeuratPipelineJobPayload({ datasetId, analysisObjectId, params = {} } = {}) {
  return {
    ...buildSeuratPipelineJobPayload({ datasetId, analysisObjectId, params }),
    jobType: SPATIAL_SEURAT_PIPELINE_JOB_TYPE,
  };
}

export function buildMultiSampleSeuratPipelineJobPayload({ samples = [], analysisObjectId, params = {} } = {}) {
  const primaryDatasetId = Array.isArray(samples) ? samples[0]?.datasetId : null;
  const base = buildSeuratPipelineJobPayload({
    datasetId: primaryDatasetId,
    analysisObjectId,
    params,
  });
  return {
    ...base,
    jobType: MULTI_SAMPLE_SEURAT_PIPELINE_JOB_TYPE,
    parameters: {
      ...base.parameters,
      samples: Array.isArray(samples) ? samples.map(sample => ({
        datasetId: sample?.datasetId,
        sampleName: sample?.sampleName,
        conditionName: sample?.conditionName,
        donorCode: sample?.donorCode || null,
        batch: sample?.batch || null,
      })) : [],
    },
  };
}

export function buildCheckpointForkJobPayload(analysisObjectId) {
  return {
    jobType: CHECKPOINT_FORK_JOB_TYPE,
    analysisObjectId,
    parameters: {},
  };
}

export function buildCheckpointSaveJobPayload(analysisObjectId) {
  return {
    jobType: CHECKPOINT_SAVE_JOB_TYPE,
    analysisObjectId,
    parameters: {},
  };
}

const CLIENT_ID = localStorage.getItem('client_id') || Math.random().toString(36).substr(2, 9);
localStorage.setItem('client_id', CLIENT_ID);
// The HttpOnly session cookie set by the backend is the only authentication
// credential. This key remains exported solely so migration cleanup and tests
// can remove bearer credentials left by pre-cookie releases.
export const AUTH_TOKEN_KEY = 'traceomics_auth_token';
export const AUTH_USER_KEY = 'traceomics_auth_user';
const AUTH_SESSION_KEY_PREFIXES = ['traceomics_auth_', 'traceomics_session'];
const SESSION_STORAGE_KEYS = ['client_id'];

// Purge bearer credentials left by pre-cookie-only releases. The key remains
// exported for migration tests but is never used for authentication.
localStorage.removeItem(AUTH_TOKEN_KEY);

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function persistAuthResponse(data) {
  if (!data?.user) return data;
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user));
  return data.user;
}

export function clearAuthSessionStorage() {
  const keysToRemove = new Set([AUTH_TOKEN_KEY, AUTH_USER_KEY, ...SESSION_STORAGE_KEYS]);
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && AUTH_SESSION_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) {
      keysToRemove.add(key);
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));
}

function pickFiles({ accept = '', directory = false, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple || directory;
    if (directory) {
      input.webkitdirectory = true;
      input.directory = true;
    }
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files || []));
      input.remove();
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

async function uploadSingleFile(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  const headers = {};

  const res = await fetch(apiUrl('/api/upload'), { method: 'POST', headers, body: form, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.path;
}

async function uploadDirectory(files) {
  const form = new FormData();
  files.forEach((file) => {
    form.append('files', file, file.name);
    form.append('relativePaths', file.webkitRelativePath || file.name);
  });
  const headers = {};

  const res = await fetch(apiUrl('/api/upload-directory'), { method: 'POST', headers, body: form, credentials: 'include' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.path;
}

async function pickAndUploadFile(kind = '') {
  const accepts = {
    csv: '.csv,.tsv,.txt',
    rds: '.rds',
    h5: '.h5,.h5ad,.h5seurat'
  };
  const files = await pickFiles({ accept: accepts[kind] || '', multiple: false });
  if (!files[0]) return null;
  return uploadSingleFile(files[0]);
}

async function pickAndUploadDirectory() {
  const files = await pickFiles({ directory: true });
  if (files.length === 0) return null;
  return uploadDirectory(files);
}

function formatRequestError(error) {
  return publicErrorMessage(error);
}

async function req(endpoint, options = {}) {
  options.headers = options.headers || {};
  options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
  options.headers['X-Client-ID'] = CLIENT_ID;
  // Send the HttpOnly session cookie (source of auth truth) even cross-origin.
  options.credentials = options.credentials || 'include';

  const res = await fetch(apiUrl(endpoint), options);
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(text || res.statusText);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function downloadResponse(endpoint, fallbackFilename) {
  const res = await fetch(apiUrl(endpoint), {
    credentials: 'include',
    headers: { 'X-Client-ID': CLIENT_ID },
  });
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(text || res.statusText);
    error.status = res.status;
    throw error;
  }
  const disposition = res.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="([^"\r\n]+)"/i)?.[1] || fallbackFilename;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { filename, sizeBytes: blob.size };
}

function formatRVersion(version) {
  if (!version) return 'Unknown';
  const text = String(version).trim();
  if (!text) return 'Unknown';
  return /^R\b/i.test(text) ? text : `R ${text}`;
}

async function checkRuntimeDiagnostics() {
  const data = await req('/api/runtime/diagnostics');
  return {
    version: formatRVersion(data.runtime?.rVersion || data.runtime?.version || data.rVersion),
    supportedTarget: data.supportedTarget || 'R 4.5.x',
    runtimeStatus: data.runtime?.status || 'unknown',
  };
}

async function getComputeRuntimeStatus() {
  const data = await req('/api/runtime/compute-status');
  const status = ['ready', 'unavailable', 'unknown'].includes(data?.status) ? data.status : 'unknown';
  return {
    status,
    updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : null,
  };
}

export const electronAPI = {
  // R Plumber Proxy
  apiRequest: async (endpoint, options = {}) => {
    try {
      options.headers = options.headers || {};
      options.headers['X-Client-ID'] = CLIENT_ID;
      options.headers['X-TraceOmics-CSRF'] = '1';
      options.credentials = options.credentials || 'include';

      const res = await fetch(apiUrl(`/api/r${endpoint}`), options);
      const contentType = res.headers.get('content-type');
      let data;
      if (contentType && contentType.includes('application/json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }
      
      if (!res.ok) {
        if (typeof data === 'object' && data.error) return { ...data, error: publicErrorMessage(data.error) };
        return { error: publicErrorMessage(typeof data === 'string' ? data : res.statusText) };
      }
      
      return data;
    } catch (e) {
      return { error: publicErrorMessage(e) };
    }
  },

  // Auth / DB calls
  registrationPolicy: async () => {
    try {
      return await req('/api/auth/policy', { method: 'GET' });
    } catch {
      // Fail closed in the UI. Login remains available even if the policy probe
      // is temporarily unavailable.
      return { registrationEnabled: false };
    }
  },
  signup: async (email, password, displayName) => {
    try {
      const data = await req('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });
      return persistAuthResponse(data);
    } catch (error) {
      return { error: formatRequestError(error) };
    }
  },
  login: async (email, password) => {
    try {
      const data = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      return persistAuthResponse(data);
    } catch (error) {
      return { error: formatRequestError(error) };
    }
  },
  getCurrentUser,
  // Restore auth state from the HttpOnly session cookie (source of truth). The
  // cookie is not readable by JS, so the app asks the backend who it is.
  restoreSession: async () => {
    // Purge credentials that an older release may have written after this
    // module was loaded. They are never sent or accepted as authentication.
    localStorage.removeItem(AUTH_TOKEN_KEY);
    try {
      const headers = { 'X-Client-ID': CLIENT_ID };
      const res = await fetch(apiUrl('/api/auth/session'), {
        method: 'GET',
        headers,
        credentials: 'include'
      });
      if (!res.ok) {
        if (res.status === 401) clearAuthSessionStorage();
        return null;
      }
      const data = await res.json().catch(() => ({}));
      if (data?.user) {
        localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user));
        return data.user;
      }
      return null;
    } catch {
      // Network/backend unavailable: keep local cache untouched, but do not use
      // it as auth truth. The app stays logged out until the backend confirms.
      return null;
    }
  },
  startDemoGuest: async () => {
    try {
      const data = await req('/api/auth/demo-guest', { method: 'POST' });
      return persistAuthResponse(data);
    } catch (error) {
      return { error: formatRequestError(error) };
    }
  },
  logout: async () => {
    // Keep local state until the server confirms that every session issued for
    // this user has been revoked. A failed request is visible and retryable.
    try {
      const res = await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        headers: { 'X-Client-ID': CLIENT_ID },
        credentials: 'include'
      });
      if (!res || !res.ok) {
        const data = await res?.json?.().catch(() => ({}));
        return { error: data?.error || 'Session revocation failed. Please retry.' };
      }
      const data = await res.json().catch(() => ({}));
      if (data?.allSessionsRevoked !== true) {
        // The server clears an invalid/expired cookie on this successful path.
        // There is no authenticated session left to preserve, so make the login
        // screen reachable while accurately warning about the revoke-all result.
        clearAuthSessionStorage();
        return {
          success: true,
          allSessionsRevoked: false,
          warning: 'The current session had already expired; other sessions could not be revoked.',
        };
      }
      clearAuthSessionStorage();
      return { success: true };
    } catch {
      return { error: 'Session revocation failed. Please check your connection and retry.' };
    }
  },
  
  // Figures
  getFigures: async () => req('/api/db/figures'),
  saveFigure: async (record) => req('/api/db/figures', { method: 'POST', body: JSON.stringify(record) }),
  deleteFigure: async (id) => req(`/api/db/figures/${id}`, { method: 'DELETE' }),

  // Provenance
  saveProvenance: async (envelope) => req('/api/db/provenance', { method: 'POST', body: JSON.stringify(envelope) }),
  dbSaveProvenance: async (envelope) => req('/api/db/provenance', { method: 'POST', body: JSON.stringify(envelope) }),
  getProvenance: async (id) => req(`/api/db/provenance/${id}`),
  dbGetProvenance: async (id) => req(`/api/db/provenance/${id}`),
  getAllProvenance: async () => req('/api/db/provenance'),
  dbGetAllProvenance: async () => req('/api/db/provenance'),
  getProvenanceChain: async (id) => req(`/api/db/provenance-chain/${id}`),
  dbGetProvenanceChain: async (id) => req(`/api/db/provenance-chain/${id}`),
  deleteProvenance: async (id) => req(`/api/db/provenance/${id}`, { method: 'DELETE' }),
  dbDeleteProvenance: async (id) => req(`/api/db/provenance/${id}`, { method: 'DELETE' }),

  // Analysis Objects (durable, ownership-scoped object identity)
  createAnalysisObject: async (payload) => req('/api/analysis-objects', { method: 'POST', body: JSON.stringify(payload || {}) }),
  listAnalysisObjects: async (filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/analysis-objects${qs ? `?${qs}` : ''}`);
  },
  getAnalysisObject: async (id) => req(`/api/analysis-objects/${id}`),

  // Jobs (durable, ownership-scoped long-running task records)
  createJob: async (payload) => req('/api/jobs', { method: 'POST', body: JSON.stringify(payload || {}) }),
  listJobs: async (filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/jobs${qs ? `?${qs}` : ''}`);
  },
  getJob: async (id) => req(`/api/jobs/${id}`),
  getJobLogs: async (id) => req(`/api/jobs/${id}/logs`),
  cancelJob: async (id) => req(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  // Organizations & Projects (membership + authorization foundation)
  createOrganization: async (payload) => req('/api/organizations', { method: 'POST', body: JSON.stringify(payload || {}) }),
  listOrganizations: async () => req('/api/organizations'),
  getOrganization: async (id) => req(`/api/organizations/${id}`),
  createProject: async (payload) => req('/api/projects', { method: 'POST', body: JSON.stringify(payload || {}) }),
  listProjects: async () => req('/api/projects'),
  getProject: async (id) => req(`/api/projects/${id}`),
  updateProject: async (id, payload) => req(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(payload || {}) }),
  // Datasets (project-scoped). Thin wrappers; ids/owner/storage are server-controlled.
  createDataset: async (projectId, payload) => req(`/api/projects/${projectId}/datasets`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listDatasets: async (projectId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/projects/${projectId}/datasets${qs ? `?${qs}` : ''}`);
  },
  getDataset: async (projectId, datasetId) => req(`/api/projects/${projectId}/datasets/${datasetId}`),
  updateDataset: async (projectId, datasetId, payload) => req(`/api/projects/${projectId}/datasets/${datasetId}`, { method: 'PATCH', body: JSON.stringify(payload || {}) }),
  listProjectPipelineDefinitions: async (projectId) => req(`/api/projects/${projectId}/pipeline-definitions`),
  getPipelineRegistryCapabilities: async () => req('/api/pipeline-registry/capabilities'),
  getExpertRCapabilities: async () => req('/api/expert-r/capabilities'),
  listExpertRInputs: async (projectId) => req(`/api/expert-r/projects/${projectId}/inputs`),
  uploadExpertRInput: async (projectId, file) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch(apiUrl(`/api/expert-r/projects/${projectId}/inputs`), {
      method: 'POST', body: form, credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },
  publishPipelineRegistryDefinition: async (manifest) =>
    req('/api/pipeline-registry/definitions', { method: 'POST', body: JSON.stringify({ manifest }) }),
  getProjectPipelineSelection: async (projectId) => req(`/api/projects/${projectId}/pipeline-selection`),
  setProjectPipelineSelection: async (projectId, pipelineId) =>
    req(`/api/projects/${projectId}/pipeline-selection`, { method: 'PUT', body: JSON.stringify({ pipelineId }) }),
  // Multipart dataset upload: the server chooses the storage location and records
  // sha256/size. `metadata` (if given) is sent as a JSON string form field.
  uploadDataset: async (projectId, file, metadata = {}, fileType) => {
    const form = new FormData();
    form.append('file', file, file.name);
    if (fileType) form.append('fileType', fileType);
    if (metadata && Object.keys(metadata).length > 0) form.append('metadata', JSON.stringify(metadata));
    const headers = {};
    const res = await fetch(apiUrl(`/api/projects/${projectId}/datasets`), { method: 'POST', headers, body: form, credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  },

  // Project-scoped analysis objects & jobs (project metadata/history; ids/owner/
  // project/status are server-controlled). R execution/state is unchanged here —
  // these are metadata APIs only.
  createProjectAnalysisObject: async (projectId, payload) =>
    req(`/api/projects/${projectId}/analysis-objects`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listProjectAnalysisObjects: async (projectId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/projects/${projectId}/analysis-objects${qs ? `?${qs}` : ''}`);
  },
  getProjectAnalysisObject: async (projectId, objectId) =>
    req(`/api/projects/${projectId}/analysis-objects/${objectId}`),
  // Persist a small, safe display summary (cells/features/density) so the Workspace
  // card keeps accurate counts after a refresh. Metadata-only; server rejects any
  // storage/state/owner/project field. R execution/state is unchanged.
  updateProjectAnalysisObjectSummary: async (projectId, objectId, summary) =>
    req(`/api/projects/${projectId}/analysis-objects/${objectId}/summary`, { method: 'PATCH', body: JSON.stringify(summary || {}) }),
  // Read-only analysis-object lineage (DAG). The edge table is the graph source;
  // these return public-safe edge/graph metadata only (no create/mutate wrapper —
  // edges are created server-side by the checkpoint helper / future multi-parent ops).
  getProjectAnalysisObjectParents: async (projectId, objectId) =>
    req(`/api/projects/${projectId}/analysis-objects/${objectId}/parents`),
  getProjectAnalysisObjectChildren: async (projectId, objectId) =>
    req(`/api/projects/${projectId}/analysis-objects/${objectId}/children`),
  getProjectAnalysisObjectLineage: async (projectId, objectId) =>
    req(`/api/projects/${projectId}/analysis-objects/${objectId}/lineage`),
  // Explicit study design. Contrast validation is server-derived from the
  // samples bound to the selected immutable analysis object.
  createStudyCondition: async (projectId, payload) =>
    req(`/api/projects/${projectId}/conditions`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listStudyConditions: async (projectId) => req(`/api/projects/${projectId}/conditions`),
  createBiologicalSample: async (projectId, payload) =>
    req(`/api/projects/${projectId}/samples`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listBiologicalSamples: async (projectId) => req(`/api/projects/${projectId}/samples`),
  bindSampleToAnalysisObject: async (projectId, objectId, payload) =>
    req(`/api/projects/${projectId}/analysis-objects/${objectId}/sample-bindings`, {
      method: 'POST', body: JSON.stringify(payload || {}),
    }),
  listAnalysisObjectSampleBindings: async (projectId, objectId) =>
    req(`/api/projects/${projectId}/analysis-objects/${objectId}/sample-bindings`),
  createConditionContrast: async (projectId, payload) =>
    req(`/api/projects/${projectId}/contrasts`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listConditionContrasts: async (projectId) => req(`/api/projects/${projectId}/contrasts`),
  // Git-like analysis refs. Checkpoint/result objects remain immutable; these
  // APIs move only optimistic branch pointers and review/canonical metadata.
  createAnalysisBranch: async (projectId, payload) =>
    req(`/api/projects/${projectId}/branches`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listAnalysisBranches: async (projectId) => req(`/api/projects/${projectId}/branches`),
  advanceAnalysisBranch: async (projectId, branchId, headAnalysisObjectId, expectedVersion) =>
    req(`/api/projects/${projectId}/branches/${branchId}/head`, {
      method: 'PATCH', body: JSON.stringify({ headAnalysisObjectId, expectedVersion }),
    }),
  publishAnalysisBranch: async (projectId, branchId) =>
    req(`/api/projects/${projectId}/branches/${branchId}/publish`, { method: 'POST', body: '{}' }),
  listAnalysisBranchEvents: async (projectId, branchId) =>
    req(`/api/projects/${projectId}/branches/${branchId}/events`),
  requestAnalysisBranchReview: async (projectId, branchId, payload) =>
    req(`/api/projects/${projectId}/branches/${branchId}/reviews`, {
      method: 'POST', body: JSON.stringify(payload || {}),
    }),
  listAnalysisBranchReviews: async (projectId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, value]) => value != null && value !== '')
    ).toString();
    return req(`/api/projects/${projectId}/reviews${qs ? `?${qs}` : ''}`);
  },
  listAnalysisBranchReviewComments: async (projectId, reviewId) =>
    req(`/api/projects/${projectId}/reviews/${reviewId}/comments`),
  addAnalysisBranchReviewComment: async (projectId, reviewId, body) =>
    req(`/api/projects/${projectId}/reviews/${reviewId}/comments`, {
      method: 'POST', body: JSON.stringify({ body }),
    }),
  decideAnalysisBranchReview: async (projectId, reviewId, status, note = '') =>
    req(`/api/projects/${projectId}/reviews/${reviewId}/decision`, {
      method: 'PATCH', body: JSON.stringify({ status, note }),
    }),
  promoteAnalysisBranch: async (projectId, branchId, reviewId) =>
    req(`/api/projects/${projectId}/branches/${branchId}/promote`, {
      method: 'POST', body: JSON.stringify({ reviewId }),
    }),
  getCanonicalAnalysis: async (projectId) => req(`/api/projects/${projectId}/canonical-analysis`),
  compareAnalysisBranches: async (projectId, leftBranchId, rightBranchId) => {
    const qs = new URLSearchParams({ leftBranchId, rightBranchId }).toString();
    return req(`/api/projects/${projectId}/branch-comparison?${qs}`);
  },
  createProjectJob: async (projectId, payload) =>
    req(`/api/projects/${projectId}/jobs`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listProjectJobs: async (projectId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/projects/${projectId}/jobs${qs ? `?${qs}` : ''}`);
  },
  getProjectJob: async (projectId, jobId) => req(`/api/projects/${projectId}/jobs/${jobId}`),
  getProjectJobLogs: async (projectId, jobId) => req(`/api/projects/${projectId}/jobs/${jobId}/logs`),
  cancelProjectJob: async (projectId, jobId) =>
    req(`/api/projects/${projectId}/jobs/${jobId}/cancel`, { method: 'POST' }),
  createDegFindMarkersJob: async (projectId, objectId, params = {}) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(buildDegFindMarkersJobPayload(objectId, params)),
    }),
  createEnrichmentGseaJob: async (projectId, objectId, params = {}) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(buildEnrichmentGseaJobPayload(objectId, params)),
    }),
  createCellChatInferenceJob: async (projectId, objectId, params = {}) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(buildCellChatInferenceJobPayload(objectId, params)),
    }),
  createExploratoryAnalysisJob: async (projectId, objectId, params = {}) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        jobType: 'explore.summarize.v1',
        analysisObjectId: objectId,
        parameters: params,
      }),
    }),
  createCheckpointLoadJob: async (projectId, objectId) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        jobType: 'checkpoint.load.v1',
        analysisObjectId: objectId,
        parameters: {},
      }),
    }),
  createCheckpointSaveJob: async (projectId, objectId) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(buildCheckpointSaveJobPayload(objectId)),
    }),
  createSeuratPipelineJob: async (projectId, { datasetId, analysisObjectId, params = {} } = {}) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(buildSeuratPipelineJobPayload({ datasetId, analysisObjectId, params })),
    }),
  createMultiSampleSeuratPipelineJob: async (projectId, { samples = [], analysisObjectId, params = {} } = {}) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(buildMultiSampleSeuratPipelineJobPayload({ samples, analysisObjectId, params })),
    }),
  createSpatialSeuratPipelineJob: async (projectId, { datasetId, analysisObjectId, params = {} } = {}) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(buildSpatialSeuratPipelineJobPayload({ datasetId, analysisObjectId, params })),
    }),
  createCheckpointForkJob: async (projectId, analysisObjectId) =>
    req(`/api/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(buildCheckpointForkJobPayload(analysisObjectId)),
    }),

  // Project-scoped provenance & figure metadata (project metadata/history; ids/
  // owner/project/actor are server-controlled). Append-only; figures never carry
  // a client-supplied or returned file path. R execution/state is unchanged.
  createProjectProvenance: async (projectId, payload) =>
    req(`/api/projects/${projectId}/provenance`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listProjectProvenance: async (projectId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/projects/${projectId}/provenance${qs ? `?${qs}` : ''}`);
  },
  getProjectProvenance: async (projectId, provenanceId) =>
    req(`/api/projects/${projectId}/provenance/${provenanceId}`),
  createProjectFigure: async (projectId, payload) =>
    req(`/api/projects/${projectId}/figures`, { method: 'POST', body: JSON.stringify(payload || {}) }),
  listProjectFigures: async (projectId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/projects/${projectId}/figures${qs ? `?${qs}` : ''}`);
  },
  getProjectFigure: async (projectId, figureId) =>
    req(`/api/projects/${projectId}/figures/${figureId}`),

  // Project-scoped job artifact & checkpoint metadata (READ-ONLY). Metadata only —
  // there is no create/mutate wrapper (artifacts are worker/helper-driven) and no
  // download: responses never include a storage path/uri. R execution is unchanged.
  listProjectArtifacts: async (projectId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/projects/${projectId}/artifacts${qs ? `?${qs}` : ''}`);
  },
  getProjectArtifact: async (projectId, artifactId) =>
    req(`/api/projects/${projectId}/artifacts/${artifactId}`),
  listProjectJobArtifacts: async (projectId, jobId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, v]) => v != null && v !== '')
    ).toString();
    return req(`/api/projects/${projectId}/jobs/${jobId}/artifacts${qs ? `?${qs}` : ''}`);
  },
  downloadProjectArtifact: async (projectId, artifactId) => downloadResponse(
    `/api/projects/${projectId}/artifacts/${artifactId}/download`,
    `artifact-${artifactId}`
  ),
  downloadReproducibilityManifest: async (projectId, { branchId, analysisObjectId } = {}) => {
    const qs = new URLSearchParams();
    if (branchId) qs.set('branchId', branchId);
    else if (analysisObjectId) qs.set('analysisObjectId', analysisObjectId);
    return downloadResponse(
      `/api/projects/${projectId}/reproducibility-manifest?${qs.toString()}`,
      'reproducibility-manifest.json'
    );
  },
  listProjectAuditEvents: async (projectId, filters = {}) => {
    const qs = new URLSearchParams(
      Object.entries(filters).filter(([, value]) => value != null && value !== '')
    ).toString();
    return req(`/api/projects/${projectId}/audit-events${qs ? `?${qs}` : ''}`);
  },

  listProjectMembers: async (id) => req(`/api/projects/${id}/members`),
  addProjectMember: async (id, email, role) => req(`/api/projects/${id}/members`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  updateProjectMemberRole: async (id, userId, role) => req(`/api/projects/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeProjectMember: async (id, userId) => req(`/api/projects/${id}/members/${userId}`, { method: 'DELETE' }),

  // Cache
  makeCacheKey: async (op, params, ver, pids) => {
    const res = await req('/api/db/cache-key', { method: 'POST', body: JSON.stringify({ operation: op, params, dataVersion: ver, parentIds: pids }) });
    return res.key;
  },
  dbMakeCacheKey: async (op, params, ver, pids) => {
    const res = await req('/api/db/cache-key', { method: 'POST', body: JSON.stringify({ operation: op, params, dataVersion: ver, parentIds: pids }) });
    return res.key;
  },
  getCachedResult: async (key) => req(`/api/db/cache/${key}`),
  dbGetCachedResult: async (key) => req(`/api/db/cache/${key}`),
  setCachedResult: async (key, pid, data) => req(`/api/db/cache/${key}`, { method: 'POST', body: JSON.stringify({ provenanceId: pid, resultData: data }) }),
  dbSetCachedResult: async (key, pid, data) => req(`/api/db/cache/${key}`, { method: 'POST', body: JSON.stringify({ provenanceId: pid, resultData: data }) }),
  clearCache: async () => req('/api/db/cache', { method: 'DELETE' }),
  dbClearCache: async () => req('/api/db/cache', { method: 'DELETE' }),

  // Theme
  setTheme: (_theme) => { /* No-op in browser, handled by CSS */ },

  // Diagnostics
  getComputeRuntimeStatus,
  getRScriptPath: async () => {
    try {
      const result = await checkRuntimeDiagnostics();
      return result.rscriptPath;
    } catch {
      return 'Unknown';
    }
  },
  setRScriptPath: async () => ({ error: 'Rscript is configured on the server; browser clients cannot change it.' }),
  checkREnv: async () => {
    try {
      return await checkRuntimeDiagnostics();
    } catch (error) {
      return { error: formatRequestError(error) };
    }
  },
  restartPlumber: () => {},
  runRInstaller: () => {},
  onRInstallerOutput: () => () => {},
  onRInstallerDone: () => () => {},

  // Dialogs (Mocked or unsupported in web)
  openCsvDialog: async () => pickAndUploadFile('csv'),
  openDirectoryDialog: async () => pickAndUploadDirectory(),
  openMultiDirectoryDialog: async () => {
    const path = await pickAndUploadDirectory();
    return path ? [path] : [];
  },
  openDataFileDialog: async (kind) => pickAndUploadFile(kind),
  saveScriptDialog: async () => { alert("File dialogs are not supported in web mode yet."); return null; },
  openExportsFolder: async () => { alert("Cannot open local folders from web mode."); return false; },
  scan10xRoot: async () => { return { root: null, found: [] }; }
};
