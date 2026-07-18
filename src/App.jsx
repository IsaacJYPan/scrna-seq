import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import Workspace from './pages/Workspace';
import QualityControl from './pages/QualityControl';
import Normalization from './pages/Normalization';
import PCA from './pages/PCA';
import Clustering from './pages/Clustering';
import UMAPView from './pages/UMAPView';
import FeaturePlot from './pages/FeaturePlot';
import HeatmapPlot from './pages/HeatmapPlot';
import DotPlot from './pages/DotPlot';
import GeneViewer from './pages/GeneViewer';
import DifferentialExpression from './pages/DifferentialExpression';
import PathwayEnrichment from './pages/PathwayEnrichment';
import Publication from './pages/Publication';
import Validation from './pages/Validation';
import LineageExplorer from './pages/LineageExplorer';
import ProjectHistory from './pages/ProjectHistory';
import BatchIntegration from './pages/BatchIntegration';
import Collaborators from './pages/Collaborators';
import Inspect from './pages/Inspect';
import Diagnostics from './pages/Diagnostics';
import PipelineManager from './pages/PipelineManager';
import ProvenanceDrawer from './components/ProvenanceDrawer';
import { useProjectPipelineSelection } from './pipelines/useProjectPipelineSelection';
import { hasAttachedLiveRObject } from './liveRState';

import {
  saveProvenance,
  loadPersistedProvenance,
  getProvenanceChain,
  makeCacheKey,
  getCachedResult,
  setCachedResult,
} from './provenance';
import {
  buildAnalysisObjectSummary,
  cacheSelectedAnalysisObject,
  cacheSelectedProject,
  createAnalysisObjectForLiveLoad,
  createEmptyWorkspace,
  createProjectWithBackend,
  loadBackendProjectState,
  loadProjectAnalysisObjectState,
  mapBackendAnalysisObject,
  persistAnalysisObjectSummary,
} from './backendWorkspaceModel';

// Pipeline step ordering — used for downstream invalidation
const PIPELINE_ORDER = ['qc', 'normalize', 'integrate', 'pca', 'cluster', 'umap'];

// Error boundary to prevent full-app crashes from individual page errors
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full flex items-center justify-center p-8 bg-background">
          <div className="text-center max-w-md">
            <div className="text-6xl mb-4">⚠️</div>
            <h2 className="text-xl font-bold text-text mb-2">Component Error</h2>
            <p className="text-slate-400 text-sm mb-4">{this.state.error?.message || 'An unexpected error occurred in this module.'}</p>
            <pre className="text-xs text-slate-400 bg-black/30 p-3 rounded-lg overflow-auto max-h-32 text-left mb-4">{this.state.error?.stack?.split('\n').slice(0, 5).join('\n')}</pre>
            <button onClick={() => this.setState({ hasError: false, error: null })} className="btn btn-primary text-sm">Retry</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function PlaceholderPage({ title, subtitle, icon }) {
  return (
    <div className="h-full flex items-center justify-center p-8 bg-background">
      <div className="text-center max-w-md">
        <div className="inline-flex items-center justify-center px-3 py-1.5 rounded border border-border bg-surface text-xs font-bold uppercase tracking-widest text-textMuted mb-6">
          {icon}
        </div>
        <h2 className="text-2xl font-black text-text mb-3 tracking-tight">{title}</h2>
        <p className="text-slate-400 text-sm leading-relaxed mb-6">{subtitle}</p>
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 border border-primary/20 rounded-full text-[10px] font-black text-primary uppercase tracking-widest">
          Not production-integrated
        </div>
      </div>
    </div>
  );
}

const FUTURE_FEATURES = {
  annotate: {
    title: 'Cell Annotation Not Integrated',
    subtitle: 'Cell annotation is intentionally disabled in this workflow. Any future support must keep biological interpretation reviewable by the researcher.',
    icon: 'Not implemented'
  },
  cellchat: {
    title: 'CellChat Not Integrated',
    subtitle: 'CellChat requires the pinned R 4.5 environment and a durable job/artifact workflow. This branch does not enable CellChat execution.',
    icon: 'Coming later'
  },
  customscript: {
    title: 'Custom Script Disabled',
    subtitle: 'Arbitrary user-provided R execution is out of scope and is not exposed by this local development workbench.',
    icon: 'Disabled'
  }
};

const TabContent = ({ id, activeTab, children }) => (
  <div className={`absolute inset-0 ${activeTab === id ? 'block' : 'hidden'}`}>
    {children}
  </div>
);

const CLOSED_DEPLOYMENT_POLICY = Object.freeze({
  registrationEnabled: false,
  legacyLocalImportsEnabled: false,
  legacyLiveMutationToolsEnabled: false,
  serverFigureExportEnabled: false,
});

export default function App() {
  const [activeTab, setActiveTab] = useState('workspace');
  const [deploymentPolicy, setDeploymentPolicy] = useState(CLOSED_DEPLOYMENT_POLICY);

  useEffect(() => {
    let active = true;
    if (!window.electronAPI?.registrationPolicy) return undefined;
    window.electronAPI.registrationPolicy().then((policy) => {
      if (!active) return;
      setDeploymentPolicy({
        registrationEnabled: policy?.registrationEnabled === true,
        legacyLocalImportsEnabled: policy?.legacyLocalImportsEnabled === true,
        legacyLiveMutationToolsEnabled: policy?.legacyLiveMutationToolsEnabled === true,
        serverFigureExportEnabled: policy?.serverFigureExportEnabled === true,
      });
    }).catch(() => {
      if (active) setDeploymentPolicy(CLOSED_DEPLOYMENT_POLICY);
    });
    return () => { active = false; };
  }, []);

  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');

    if (window.electronAPI && window.electronAPI.setTheme) {
      window.electronAPI.setTheme(theme);
    }
  }, [theme]);

  // Pipeline state tracking

  const [pipelineState, setPipelineState] = useState({
    qc: false,
    normalize: false,
    integrate: false,
    pca: false,
    cluster: false,
    annotate: false,
    umap: false,
    clusterCount: 0,
    clusterDims: 15  // default dims; updated when clustering runs
  });
  // Gate that blocks per-page cache hydration until after the R session
  // restore attempt completes (success or no saved session). Without this
  // gate the pages fire onlyIfCached calls with the wrong (new) session ID
  // and always miss the SQLite cache.
  const [sessionCheckDone, setSessionCheckDone] = useState(false);

  const [user, setUser] = useState(null);
  const [loggedOutNotice, setLoggedOutNotice] = useState('');
  const isLoggedIn = !!user;

  // Restore auth state from the HttpOnly session cookie (source of truth) on
  // mount, rather than trusting cached local user metadata. The cookie is not
  // readable by JS, so we ask the backend who we are. This reconciles the fast
  // synchronous bootstrap (cached user) with the real server session: if the
  // cookie session is valid we adopt/refresh the user; if it is gone we stay
  // logged out so a reload cannot trust stale local user metadata.
  useEffect(() => {
    let cancelled = false;
    if (!window.electronAPI?.restoreSession) return undefined;
    window.electronAPI.restoreSession().then((restored) => {
      if (cancelled) return;
      if (restored && restored.email) {
        setUser((prev) => (prev && prev.email === restored.email ? prev : restored));
      } else if (restored === null) {
        setUser(null);
      }
    }).catch(() => { /* transient failure: keep current state */ });
    return () => { cancelled = true; };
  }, []);

  const [figuresCount, setFiguresCount] = useState(0);

  useEffect(() => {
    if (window.electronAPI && window.electronAPI.getFigures && user?.email) {
      window.electronAPI.getFigures(user.email).then(figures => {
        setFiguresCount(figures.length);
      }).catch(err => {
        console.error('[App] Failed to load figures count:', err);
      });
    }
  }, [activeTab, user?.email]);

  // Local workspace shell. Backend projects/analysis objects are loaded after
  // login; localStorage is no longer a durable project/object source.
  const [workspaces, setWorkspaces] = useState(() => [
    createEmptyWorkspace({ collaborators: ['me@lab.edu'] }),
  ]);
  const [activeWsIndex, setActiveWsIndex] = useState(0);
  const [backendModelStatus, setBackendModelStatus] = useState({
    projectsLoading: false,
    objectsLoading: false,
    error: null,
    projectCacheCleared: false,
    objectCacheCleared: false,
  });

  const currentWs = workspaces[activeWsIndex];
  const selectedObjects = currentWs.objects.filter(obj => currentWs.selectedObjectIds?.includes(obj.id));
  const datasetInfo = selectedObjects.length > 0 ? selectedObjects[0] : (currentWs.objects[0] || null);
  const currentProvId = currentWs.branches[currentWs.activeBranch];
  const activeProjectIdForPipeline = currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const { activePipeline, handlePipelineSelectionChanged } = useProjectPipelineSelection({
    api: window.electronAPI,
    projectId: activeProjectIdForPipeline,
    userEmail: user?.email,
  });

  const [apiStatus, setApiStatus] = useState('Checking backend');
  const [provenanceRecords, setProvenanceRecords] = useState([]);
  const [drawerProvId, setDrawerProvId] = useState(null);
  const [drawerChain, setDrawerChain] = useState(null);
  // R process session ID — changes on every restart, busting the pipeline cache
  // so that all stateful steps re-execute in R and rebuild global_obj.
  const [rSessionId, setRSessionId] = useState(null);
  const sessionReady = sessionCheckDone && !!rSessionId;

  useEffect(() => {
    if (!user?.email) return;

    loadPersistedProvenance()
      .then(records => {
        if (records && records.length > 0) {
          setProvenanceRecords(records);
        }
      })
      .catch(err => {
        console.warn('[App] Failed to load persisted provenance:', err);
      });
    window.electronAPI.apiRequest('/health')
      .then(data => setApiStatus(data?.error ? 'Backend disconnected' : (data?.mode || 'R/Seurat runtime connected')))
      .catch(() => setApiStatus('Backend disconnected'));
  }, [user?.email]);

  const updateActiveWorkspace = useCallback((updates) => {
    setWorkspaces(prev => {
      const copy = [...prev];
      copy[activeWsIndex] = { ...copy[activeWsIndex], ...updates };
      return copy;
    });
  }, [activeWsIndex]);

  const patchActiveWorkspace = useCallback((updater) => {
    setWorkspaces(prev => {
      const copy = [...prev];
      const current = copy[activeWsIndex];
      const updates = typeof updater === 'function' ? updater(current) : updater;
      copy[activeWsIndex] = { ...current, ...updates };
      return copy;
    });
  }, [activeWsIndex]);

  const refreshAnalysisObjects = useCallback(async (projectId) => {
    if (!user?.email || !projectId) {
      patchActiveWorkspace({ objects: [], selectedObjectIds: [] });
      return { objects: [], selectedObjectId: null };
    }

    setBackendModelStatus(prev => ({ ...prev, objectsLoading: true, error: null, objectCacheCleared: false }));
    try {
      const state = await loadProjectAnalysisObjectState(window.electronAPI, localStorage, user, projectId);
      patchActiveWorkspace(ws => ({
        objects: state.objects,
        selectedObjectIds: state.selectedObjectId ? [state.selectedObjectId] : [],
        lastSelectedByProject: state.selectedObjectId
          ? { ...(ws.lastSelectedByProject || {}), [projectId]: state.selectedObjectId }
          : (ws.lastSelectedByProject || {}),
      }));
      setBackendModelStatus(prev => ({
        ...prev,
        objectsLoading: false,
        objectCacheCleared: state.cacheWasInvalid,
      }));
      return state;
    } catch (err) {
      console.error('[App] Failed to load analysis objects:', err);
      patchActiveWorkspace({ objects: [], selectedObjectIds: [] });
      setBackendModelStatus(prev => ({
        ...prev,
        objectsLoading: false,
        error: err.message || 'Failed to load analysis objects.',
      }));
      return { objects: [], selectedObjectId: null, error: err };
    }
  }, [patchActiveWorkspace, user]);

  const refreshProjects = useCallback(async () => {
    if (!user?.email) return;
    setBackendModelStatus(prev => ({ ...prev, projectsLoading: true, error: null, projectCacheCleared: false }));
    try {
      const state = await loadBackendProjectState(window.electronAPI, localStorage, user);
      patchActiveWorkspace({
        projects: state.projects,
        selectedProjectId: state.selectedProjectId,
        objects: [],
        selectedObjectIds: [],
        lastSelectedByProject: {},
      });
      setBackendModelStatus(prev => ({
        ...prev,
        projectsLoading: false,
        projectCacheCleared: state.cacheWasInvalid,
      }));
      if (state.selectedProjectId) {
        await refreshAnalysisObjects(state.selectedProjectId);
      }
      return state;
    } catch (err) {
      console.error('[App] Failed to load projects:', err);
      patchActiveWorkspace({ projects: [], selectedProjectId: null, objects: [], selectedObjectIds: [] });
      setBackendModelStatus(prev => ({
        ...prev,
        projectsLoading: false,
        error: err.message || 'Failed to load backend projects.',
      }));
      return { projects: [], selectedProjectId: null, error: err };
    }
  }, [patchActiveWorkspace, refreshAnalysisObjects, user]);

  useEffect(() => {
    if (!user?.email) return;
    refreshProjects();
  }, [refreshProjects, user?.email]);

  const handleSelectProject = useCallback(async (projectId) => {
    cacheSelectedProject(localStorage, user, projectId);
    patchActiveWorkspace({
      selectedProjectId: projectId,
      objects: [],
      selectedObjectIds: [],
    });
    await refreshAnalysisObjects(projectId);
  }, [patchActiveWorkspace, refreshAnalysisObjects, user]);

  const handleCreateProject = useCallback(async ({ name, description }) => {
    const project = await createProjectWithBackend(window.electronAPI, { name, description });
    cacheSelectedProject(localStorage, user, project.id);
    patchActiveWorkspace(ws => ({
      projects: [project, ...ws.projects.filter(p => p.id !== project.id)],
      selectedProjectId: project.id,
      objects: [],
      selectedObjectIds: [],
      lastSelectedByProject: {},
    }));
    return project;
  }, [patchActiveWorkspace, user]);

  const handleCreateAnalysisObjectForLoad = useCallback(async ({ projectId, displayName, sourceType, metadata }) => {
    if (!projectId) throw new Error('Select or create a backend project before loading data.');
    return createAnalysisObjectForLiveLoad(window.electronAPI, projectId, {
      displayName,
      sourceType,
      metadata,
    });
  }, []);

  const handleAnalysisObjectLoaded = useCallback((projectId, analysisObject, liveResult) => {
    const objectCard = mapBackendAnalysisObject(analysisObject, liveResult);
    cacheSelectedProject(localStorage, user, projectId);
    cacheSelectedAnalysisObject(localStorage, user, projectId, analysisObject.id);

    // Persist the live cell/feature/density counts as safe summary metadata so the
    // Workspace/Data Info card stays accurate after a refresh (live R state is
    // transient and not restored on reload). Fire-and-forget: the card already shows
    // the live counts this session; a failure here only affects the refreshed view.
    persistAnalysisObjectSummary(
      window.electronAPI, projectId, analysisObject.id, buildAnalysisObjectSummary(objectCard)
    ).catch(err => console.error('Failed to persist analysis object summary:', err));

    patchActiveWorkspace(ws => ({
      selectedProjectId: projectId,
      objects: [
        objectCard,
        ...ws.objects.filter(obj => obj.id !== analysisObject.id),
      ],
      selectedObjectIds: [analysisObject.id],
      lastSelectedByProject: {
        ...(ws.lastSelectedByProject || {}),
        [projectId]: analysisObject.id,
      },
    }));
  }, [patchActiveWorkspace, user]);

  const handleSelectAnalysisObject = useCallback((projectId, objectId) => {
    cacheSelectedAnalysisObject(localStorage, user, projectId, objectId);
    patchActiveWorkspace(ws => ({
      selectedObjectIds: objectId ? [objectId] : [],
      lastSelectedByProject: objectId
        ? { ...(ws.lastSelectedByProject || {}), [projectId]: objectId }
        : (ws.lastSelectedByProject || {}),
    }));
  }, [patchActiveWorkspace, user]);

  /**
   * Mark a pipeline step as complete and invalidate downstream steps if re-running.
   */
  const markPipelineStep = useCallback((step, extraState = {}) => {
    setPipelineState(prev => {
      const next = { ...prev, [step]: true, ...extraState };
      // If re-running a step, invalidate everything downstream
      const stepIdx = PIPELINE_ORDER.indexOf(step);
      if (stepIdx >= 0) {
        for (let i = stepIdx + 1; i < PIPELINE_ORDER.length; i++) {
          next[PIPELINE_ORDER[i]] = false;
        }
      }
      return next;
    });
  }, []);

  /**
   * Reset pipeline after subsetting: QC metadata is per-cell and preserved in the
   * subset (standard Seurat practice), so qc stays true. Everything else resets.
   */
  const resetPipelineState = useCallback(() => {
    console.log('[Session] Resetting pipeline state due to session loss.');
    setPipelineState({
      qc: false,
      normalize: false,
      integrate: false,
      pca: false,
      cluster: false,
      annotate: false,
      umap: false,
      clusterCount: 0,
      clusterDims: 15,
    });
  }, []);

  const resetPipelineAfterSubset = useCallback(() => {
    setPipelineState({
      qc: true,          // inherited from parent — QC metrics are per-cell and preserved by Seurat subset()
      isSubset: true,    // flag so downstream steps know QC is optional / already applied
      normalize: false,
      integrate: false,
      pca: false,
      cluster: false,
      annotate: false,
      umap: false,
      clusterCount: 0,
      clusterDims: 15,
    });
  }, []);

  const handleSubsetCreated = useCallback(async (data, newName) => {
    const parentObj = currentWs.objects.find(o => o.id === datasetInfo?.id);
    const projId = parentObj?.projectId || currentWs.selectedProjectId;
    if (!projId || !datasetInfo?.id) {
      console.warn('[Subset] Cannot record subset without a selected backend project/object.');
      return;
    }
    
    const existingNames = currentWs.objects.filter(o => o.projectId === projId).map(o => o.name);
    let finalName = newName.trim() || 'Subset';
    let counter = 1;
    while (existingNames.includes(finalName)) {
      finalName = `${newName.trim() || 'Subset'} (${counter})`;
      counter++;
    }
    
    let created;
    try {
      created = await window.electronAPI.createProjectAnalysisObject(projId, {
        objectType: 'seurat',
        displayName: finalName,
        parentObjectId: datasetInfo.id,
        metadata: {
          sourceType: 'subset',
          liveState: 'private_transient',
          uiFlow: 'subset',
        },
      });
    } catch (err) {
      console.warn('[Subset] Failed to create backend analysis object:', err);
      return;
    }
    const newObj = {
      ...mapBackendAnalysisObject(created, data.result),
      isSubset: true,
      parentObjId: datasetInfo.id,
    };

    setWorkspaces(prev => {
      const copy = [...prev];
      const ws = copy[activeWsIndex];
      copy[activeWsIndex] = {
        ...ws,
        objects: [...ws.objects, newObj],
        selectedObjectIds: [newObj.id],
        lastSelectedByProject: {
          ...(ws.lastSelectedByProject || {}),
          [projId]: newObj.id
        }
      };
      return copy;
    });
    cacheSelectedAnalysisObject(localStorage, user, projId, newObj.id);
    
    const sanitizedEmail = (user?.email || '').replace(/[^a-zA-Z0-9]/g, '_');
    
    // 1. Copy tab parameters from parent to subset so settings (QC filters, etc.) are inherited
    if (sanitizedEmail && datasetInfo?.id) {
      const parentId = datasetInfo.id;
      const childId = newObj.id;
      ['qc', 'normalize', 'pca', 'cluster', 'umap', 'deg', 'annotate'].forEach(step => {
        const parentKey = `benchone_params_${step}_${sanitizedEmail}_${parentId}`;
        const childKey = `benchone_params_${step}_${sanitizedEmail}_${childId}`;
        const parentParams = localStorage.getItem(parentKey);
        if (parentParams) localStorage.setItem(childKey, parentParams);
      });
    }

    // 2. Persist the "subset-ready" pipeline state immediately.
    const initialSubsetPS = {
      qc: true,
      isSubset: true,
      qcSummary: pipelineState.qcSummary, // Inherit the stats report
      normalize: false,
      integrate: false,
      pca: false,
      cluster: false,
      annotate: false,
      umap: false,
      clusterCount: 0,
      clusterDims: 15,
    };
    setPipelineState(initialSubsetPS);

    // The subset object is DB-backed metadata; live R state remains transient.
  }, [activeWsIndex, currentWs, datasetInfo, pipelineState.qcSummary, user]);

  const callApi = useCallback(async (path, options = {}, {
    
    operation = '',
    step = '',
    parentIds = [],
    useCache = true,
    cacheParams = null,
    onlyIfCached = false,
  } = {}) => {
    // Ignore React SyntheticEvents (which are truthy) passed accidentally via onClick
    const forceOnlyIfCached = typeof onlyIfCached === 'boolean' ? onlyIfCached : false;
    // ── Cache key includes the R session ID so a fresh R process always
    // misses the cache and re-runs pipeline steps to rebuild global_obj.
    // We also include the object ID to strictly partition the cache when switching
    // or replacing datasets in the workspace.
    let effectiveCacheParams = cacheParams;
    if (useCache && cacheParams) {
      effectiveCacheParams = { ...cacheParams };
      if (rSessionId) effectiveCacheParams._rSession = rSessionId;
      if (datasetInfo?.id) effectiveCacheParams._objectId = datasetInfo.id;
    }

    // 1. Check Cache First
    if (useCache && effectiveCacheParams) {
      const key = await makeCacheKey(operation, effectiveCacheParams, currentWs.dataVersion, parentIds);
      const cached = await getCachedResult(key);
      if (cached) {
        const prov = await (window.electronAPI?.getProvenance?.(cached.provenanceId));
        if (prov) {
          // [PATCH] Update pipeline state even for cached results
          if (step) {
            const extraState = {};
            if (step === 'cluster') {
              if (cached.result?.n_clusters) extraState.clusterCount = cached.result.n_clusters;
              if (cached.result?.dims_used)  extraState.clusterDims  = cached.result.dims_used;
            }
            markPipelineStep(step, extraState);
            // QC: update workspace object cell count to post-filter value
            if (step === 'qc' && cached.result?.post_filter_cells) {
              updateActiveWorkspace({
                objects: currentWs.objects.map((obj, i) =>
                  i === 0 ? { ...obj, cells: cached.result.post_filter_cells } : obj
                )
              });
            }
          }
          return {
            provenance: { ...prov, parentIds: prov.parentIds || parentIds },
            result: cached.result,
            _fromCache: true,
          };
        }
      }
    }

    if (forceOnlyIfCached) return null;

    // Durable project objects are safe to browse without a live R attachment.
    // Do not let hidden analysis tabs probe R merely because such an object is
    // selected; only cached results may be read until this user's private live
    // object has been attached explicitly.
    if (!hasAttachedLiveRObject(datasetInfo)) {
      return { error: 'No live R object is attached. Load or attach this object first.' };
    }

    // 2. Fresh Fetch
    try {
      options.headers = options.headers || {};
      if (datasetInfo?.id) {
        options.headers['X-Object-ID'] = datasetInfo.id;
      }
      const data = await window.electronAPI.apiRequest(path, options);
      if (data.error) throw new Error(data.error);

      if (data.provenance) {
        data.provenance.parentIds = parentIds;
        await saveProvenance(data);

        setProvenanceRecords(prev => {
          if (prev.some(p => p.id === data.provenance.id)) return prev;
          return [data.provenance, ...prev];
        });

        updateActiveWorkspace({
          branches: {
            ...currentWs.branches,
            [currentWs.activeBranch]: data.provenance.id
          }
        });

        if (step) {
          const extraState = {};
          if (step === 'cluster') {
            if (data.result?.n_clusters) extraState.clusterCount = data.result.n_clusters;
            if (data.result?.dims_used)  extraState.clusterDims  = data.result.dims_used;
          }
          if (step === 'qc' && data.result) {
            extraState.qcSummary = data.result;
          }
          markPipelineStep(step, extraState);
          // QC: update workspace object cell count to post-filter value
          if (step === 'qc' && data.result?.post_filter_cells) {
            updateActiveWorkspace({
              objects: currentWs.objects.map((obj) =>
                currentWs.selectedObjectIds?.includes(obj.id)
                  ? { ...obj, cells: data.result.post_filter_cells }
                  : obj
              )
            });
          }
        }

        if (useCache && effectiveCacheParams) {
          const key = await makeCacheKey(operation, effectiveCacheParams, currentWs.dataVersion);
          await setCachedResult(key, data.provenance.id, data.result);
        }
      }
      return data;
    } catch (err) {
      console.error(err);
      return { error: err.message };
    }
  }, [markPipelineStep, currentWs, updateActiveWorkspace, rSessionId, datasetInfo]);

  const openProvenance = async (provId) => {
    const chain = await getProvenanceChain(provId);
    setDrawerChain(chain);
    setDrawerProvId(provId);
  };

  const handleLogout = async () => {
    const result = await window.electronAPI?.logout?.();
    if (result?.error) {
      setApiStatus(result.error);
      return;
    }
    setLoggedOutNotice(result?.warning || '');
    setUser(null);
    setActiveTab('workspace');
    setProvenanceRecords([]);
    setDrawerProvId(null);
    setDrawerChain(null);
    setRSessionId(null);
    setSessionCheckDone(false);
    setApiStatus('Checking backend');
    setWorkspaces([
      createEmptyWorkspace({ collaborators: ['me@lab.edu'] }),
    ]);
    setBackendModelStatus({
      projectsLoading: false,
      objectsLoading: false,
      error: null,
      projectCacheCleared: false,
      objectCacheCleared: false,
    });
  };

  // ── Workspace Persistence ───────────────────────────────────────
  // Legacy benchone_ws_* localStorage keys are intentionally ignored here.
  // Backend projects and analysis-object rows are the authoritative workspace
  // model; localStorage only caches selected project/object IDs.
  // ────────────────────────────────────────────────────────────────

  // ── R Session / Pipeline Persistence ─────────────────────────────
  // Live R state is private and transient. The UI probes the server for the
  // current process session ID only; it does not restore objects from
  // client-selected paths or localStorage session metadata.
  const getSessionPath = () => null;
  const currentlyRestoredObjectRef = React.useRef(null);

  // Track the currently restored object ID (avoid re-firing if React re-renders)

  // 0. Keep sessionPathRef in sync so callApi can always find the save path
  useEffect(() => {
    return undefined;
  }); // runs every render — cheap, keeps ref always fresh



  // 1. Auto-restore on login + active object available
  useEffect(() => {
    if (!user?.email || !datasetInfo?.id) {
      // No object yet — nothing to restore, unblock hydration immediately
      setSessionCheckDone(true);
      return;
    }
    if (currentlyRestoredObjectRef.current === datasetInfo.id) return;
    currentlyRestoredObjectRef.current = datasetInfo.id;

    // Block hydration until this async restore resolves
    setSessionCheckDone(false);

    const path = getSessionPath(user.email, datasetInfo.id);
    if (!path) { setSessionCheckDone(true); return; }
 
    console.log('[Vault] Checking for stored object:', path);
    window.electronAPI.apiRequest('/session-id')
      .then(d => {
        if (!d.exists) {
          console.log('[Vault] No stored object found — initializing fresh state.');
          return window.electronAPI.apiRequest('/session-id').then(data => {
            if (data.sessionId) setRSessionId(data.sessionId);
            resetPipelineState();
          });
        }
        console.log('[Vault] Found stored object, restoring state…');
        return window.electronAPI.apiRequest('/session-id')
          .then(d2 => {
            if (d2?.success) {
              const reductionsStr = Array.isArray(d2.reductions) 
                ? d2.reductions.join(', ') 
                : (d2.reductions ? String(d2.reductions) : 'none');
              console.log('[Vault] ✅ Restored:', d2.cells, 'cells, reductions:', reductionsStr);
              if (d2.session_id) {
                console.log('[Vault] Linking to provenance cache:', d2.session_id);
                setRSessionId(d2.session_id);
              } else {
                console.warn('[Vault] Metadata missing session_id — fetching fresh ID.');
                return window.electronAPI.apiRequest('/session-id').then(data => {
                  if (data.sessionId) setRSessionId(data.sessionId);
                });
              }
            } else if (d2?.error) {
              console.warn('[Vault] Object restore failed:', d2.error);
              return window.electronAPI.apiRequest('/session-id').then(data => {
                if (data.sessionId) setRSessionId(data.sessionId);
                resetPipelineState();
              });
            } else {
              console.warn('[Vault] Unexpected restore response, unblocking with fresh ID.');
              return window.electronAPI.apiRequest('/session-id').then(data => {
                if (data.sessionId) setRSessionId(data.sessionId);
              });
            }
          });
      })
      .catch(e => {
        console.warn('[Vault] Restore check failed:', e);
        return window.electronAPI.apiRequest('/session-id').then(data => {
          if (data.sessionId) setRSessionId(data.sessionId);
          resetPipelineState();
        }).catch(() => resetPipelineState());
      })
      .finally(() => {
        console.log('[Vault] Ready.');
        setSessionCheckDone(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email, datasetInfo?.id]);

  useEffect(() => {
    if (!user?.email) {
      setSessionCheckDone(true);
      return;
    }
    setSessionCheckDone(false);
    window.electronAPI.apiRequest('/session-id')
      .then(data => {
        if (data?.sessionId) setRSessionId(data.sessionId);
        if (!datasetInfo?.id) resetPipelineState();
      })
      .catch(e => {
        console.warn('[Session] R session probe failed:', e);
        setRSessionId(null);
        resetPipelineState();
      })
      .finally(() => setSessionCheckDone(true));
  }, [user?.email, datasetInfo?.id, resetPipelineState]);

  const pipelineProbeKeyRef = React.useRef(null);
  const pipelineProbeAttachedRef = React.useRef(false);
  const pipelineProbeAttemptsRef = React.useRef(0);
  const [pipelineProbeRetry, setPipelineProbeRetry] = useState(0);
  useEffect(() => {
    const objectId = datasetInfo?.id;
    if (!user?.email || !objectId || !sessionCheckDone) return;
    const key = `${user.email}:${objectId}:${rSessionId || 'unknown'}`;
    if (pipelineProbeKeyRef.current === key) {
      if (pipelineProbeAttachedRef.current && datasetInfo?.liveState !== 'attached') {
        patchActiveWorkspace(ws => ({
          objects: ws.objects.map(object => object.id === objectId ? { ...object, liveState: 'attached' } : object),
        }));
      }
      return;
    }
    pipelineProbeKeyRef.current = key;

    window.electronAPI.apiRequest('/pipeline-state', {
      headers: { 'X-Object-ID': objectId }
    }).then(state => {
      if (!state?.exists) {
        pipelineProbeAttemptsRef.current = 0;
        pipelineProbeAttachedRef.current = false;
        resetPipelineState();
        patchActiveWorkspace(ws => ({
          objects: ws.objects.map(object => object.id === objectId ? { ...object, liveState: 'not_attached' } : object),
        }));
        return;
      }
      pipelineProbeAttemptsRef.current = 0;
      pipelineProbeAttachedRef.current = true;
      patchActiveWorkspace(ws => ({
        objects: ws.objects.map(object => object.id === objectId ? { ...object, liveState: 'attached' } : object),
      }));
      setPipelineState(prev => ({
        ...prev,
        qc: Boolean(state.has_qc),
        normalize: Boolean(state.has_normalized),
        integrate: Boolean(state.has_integrated),
        pca: Boolean(state.has_pca),
        cluster: Boolean(state.has_clusters),
        umap: Boolean(state.has_umap),
        clusterCount: Number(state.n_clusters) || 0,
        clusterDims: Number(state.pca_dims) || 15,
      }));
    }).catch(() => {
      pipelineProbeKeyRef.current = null;
      if (pipelineProbeAttemptsRef.current < 3) {
        pipelineProbeAttemptsRef.current += 1;
        window.setTimeout(() => setPipelineProbeRetry(value => value + 1), 750);
      }
    });
  }, [user?.email, datasetInfo?.id, datasetInfo?.liveState, rSessionId, sessionCheckDone, pipelineProbeRetry, resetPipelineState, patchActiveWorkspace]);



  // 3. Recalculate pipeline state when active node (currentProvId) changes
  useEffect(() => {
    if (datasetInfo?.liveState !== 'attached') {
      resetPipelineState();
      return;
    }
    if (!currentProvId || provenanceRecords.length === 0) {
      return;
    }
    
    const computeState = (nodeId) => {
      const state = {
        qc: false,
        normalize: false,
        integrate: false,
        pca: false,
        cluster: false,
        annotate: false,
        umap: false,
        clusterCount: 0,
        clusterDims: 15
      };
      const visited = new Set();
      const queue = [nodeId];
      
      while (queue.length > 0) {
        const currentId = queue.shift();
        if (visited.has(currentId)) continue;
        visited.add(currentId);
        
        const r = provenanceRecords.find(x => x.id === currentId);
        if (r) {
          const op = Array.isArray(r.operation) ? r.operation[0] : r.operation;
          if (op === 'quality-control' || op === 'qc') {
            state.qc = true;
            if (r.result) state.qcSummary = r.result;
            else if (r.parameters?.summary) state.qcSummary = r.parameters.summary;
          }
          if (op === 'normalize') state.normalize = true;
          if (op === 'integrate') state.integrate = true;
          if (op === 'pca') state.pca = true;
          if (op === 'cluster') {
            state.cluster = true;
            if (r.result?.n_clusters) state.clusterCount = r.result.n_clusters;
            else if (r.parameters?.n_clusters) state.clusterCount = r.parameters.n_clusters;
            
            if (r.result?.dims_used) state.clusterDims = r.result.dims_used;
            else if (r.parameters?.dims) state.clusterDims = r.parameters.dims;
          }
          if (op === 'umap') state.umap = true;
          if (op === 'annotate') state.annotate = true;
          
          if (r.parentIds) {
            r.parentIds.forEach(pId => queue.push(pId));
          }
        }
      }
      return state;
    };
    
    const nextState = computeState(currentProvId);
    setPipelineState(nextState);
  }, [currentProvId, provenanceRecords, datasetInfo?.liveState, resetPipelineState]);
  // ────────────────────────────────────────────────────────────────

  if (!isLoggedIn) return (
    <Login
      onLogin={(u) => {
        setLoggedOutNotice('');
        setUser(u || null);
      }}
      notice={loggedOutNotice}
      theme={theme}
      setTheme={setTheme}
    />
  );

  const handleDataVersionChange = (fn) => {
    updateActiveWorkspace({ dataVersion: (typeof fn === 'function' ? fn(currentWs.dataVersion) : fn) });
  };

  const renderContent = () => {
    const objKey = datasetInfo?.id ?? 'none';
    const getLatestId = (op) => provenanceRecords.find(r => r.operation === op)?.id;

    const activeProjectId = datasetInfo?.projectId || currentWs.selectedProjectId || currentWs.projects?.[0]?.id || null;
    const activeProjectSeed = currentWs.projects?.find(p => p.id === activeProjectId)?.seed || '';

    const props = {
      callApi,
      activeProjectSeed,
      datasetInfo,
      selectedObjects,
      currentProvId,
      // Stable parent IDs for each step to avoid downstream-triggered resets
      qcProvId: getLatestId('quality-control'),
      normProvId: getLatestId('normalize'),
      integrateProvId: getLatestId('integrate'),
      pcaProvId: getLatestId('pca'),
      clusterProvId: getLatestId('cluster'),
      degProvId: getLatestId('deg'),
      openProvenance,
      currentWs,
      updateActiveWorkspace,
      refreshProjects,
      pipelineState,
      theme,
      rSessionId,          // let components watch session changes directly
      sessionReady,        // gate: true only after R session restore completes
      resetPipelineAfterSubset,
      // For per-object parameter persistence
      userEmail: user?.email ?? null,
      userId: user?.id ?? null,
      objectId: datasetInfo?.id ?? null,
      deploymentPolicy,
    };

    return (
      <div className="relative w-full h-full bg-background">
        <ErrorBoundary key="workspace"><TabContent id="workspace" activeTab={activeTab}>
          <Workspace
            {...props}
            setDataVersion={handleDataVersionChange}
            workspaces={workspaces}
            setWorkspaces={setWorkspaces}
            activeWsIndex={activeWsIndex}
            setActiveWsIndex={setActiveWsIndex}
            setActiveTab={setActiveTab}
            backendModelStatus={backendModelStatus}
            onSelectProject={handleSelectProject}
            onCreateProject={handleCreateProject}
            onCreateAnalysisObjectForLoad={handleCreateAnalysisObjectForLoad}
            onAnalysisObjectLoaded={handleAnalysisObjectLoaded}
            onSelectAnalysisObject={handleSelectAnalysisObject}
          />
        </TabContent></ErrorBoundary>
        <ErrorBoundary key="pipeline-manager"><TabContent id="pipeline-manager" activeTab={activeTab}>
          <PipelineManager
            {...props}
            activePipeline={activePipeline}
            onPipelineSelectionChanged={handlePipelineSelectionChanged}
            setActiveTab={setActiveTab}
            onSelectAnalysisObject={handleSelectAnalysisObject}
          />
        </TabContent></ErrorBoundary>
        <ErrorBoundary key="inspect"><TabContent id="inspect" activeTab={activeTab}><Inspect key={objKey} globalTab={activeTab} obj={datasetInfo} workspaceObjects={currentWs.objects} onSubsetCreated={handleSubsetCreated} userEmail={user?.email} parentSessionPath={null} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="lineage"><TabContent id="lineage" activeTab={activeTab}><LineageExplorer {...props} provenanceRecords={provenanceRecords} setProvenanceRecords={setProvenanceRecords} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="qc"><TabContent id="qc" activeTab={activeTab}><QualityControl key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="normalize"><TabContent id="normalize" activeTab={activeTab}><Normalization key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="pca"><TabContent id="pca" activeTab={activeTab}><PCA key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="cluster"><TabContent id="cluster" activeTab={activeTab}><Clustering key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="umap"><TabContent id="umap" activeTab={activeTab}><UMAPView key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="featureplot"><TabContent id="featureplot" activeTab={activeTab}><FeaturePlot key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="heatmap"><TabContent id="heatmap" activeTab={activeTab}><HeatmapPlot key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="dotplot"><TabContent id="dotplot" activeTab={activeTab}><DotPlot key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="geneviewer"><TabContent id="geneviewer" activeTab={activeTab}><GeneViewer key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="deg"><TabContent id="deg" activeTab={activeTab}><DifferentialExpression key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="history"><TabContent id="history" activeTab={activeTab}><ProjectHistory {...props} refreshAnalysisObjects={refreshAnalysisObjects} onSelectAnalysisObject={handleSelectAnalysisObject} setActiveTab={setActiveTab} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="annotate"><TabContent id="annotate" activeTab={activeTab}><PlaceholderPage {...FUTURE_FEATURES.annotate} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="enrichment"><TabContent id="enrichment" activeTab={activeTab}><PathwayEnrichment key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="cellchat"><TabContent id="cellchat" activeTab={activeTab}><PlaceholderPage {...FUTURE_FEATURES.cellchat} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="customscript"><TabContent id="customscript" activeTab={activeTab}><PlaceholderPage {...FUTURE_FEATURES.customscript} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="integrate"><TabContent id="integrate" activeTab={activeTab}><BatchIntegration key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="publication"><TabContent id="publication" activeTab={activeTab}><Publication {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="validation"><TabContent id="validation" activeTab={activeTab}><Validation {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="team"><TabContent id="team" activeTab={activeTab}><Collaborators {...props} workspaces={workspaces} setWorkspaces={setWorkspaces} activeWsIndex={activeWsIndex} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="diagnostics"><TabContent id="diagnostics" activeTab={activeTab}><Diagnostics apiStatus={apiStatus} /></TabContent></ErrorBoundary>
      </div>
    );
  };

  return (
    <div className="flex bg-background text-text overflow-hidden relative h-screen w-screen">
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        apiStatus={apiStatus}
        records={provenanceRecords.length}
        currentProvId={currentProvId}
        openProvenance={openProvenance}
        workspaces={workspaces}
        setWorkspaces={setWorkspaces}
        activeWsIndex={activeWsIndex}
        setActiveWsIndex={setActiveWsIndex}
        selectedObjects={selectedObjects}
        user={user}
        onLogout={handleLogout}
        pipelineState={pipelineState}
        activePipeline={activePipeline}
        theme={theme}
        setTheme={setTheme}
        figuresCount={figuresCount}
        deploymentPolicy={deploymentPolicy}
      />
      <main className="flex-1 flex flex-col relative overflow-hidden h-full min-w-0">
        {renderContent()}
      </main>

      <ProvenanceDrawer
        provId={drawerProvId}
        chain={drawerChain}
        onClose={() => { setDrawerProvId(null); setDrawerChain(null); }}
      />
    </div>
  );
}
