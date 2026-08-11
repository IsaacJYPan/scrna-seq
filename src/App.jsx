import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import ProvenanceDrawer from './components/ProvenanceDrawer';
import { useProjectPipelineSelection } from './pipelines/useProjectPipelineSelection';
import { hasAttachedLiveRObject, pipelineProbeAction } from './liveRState';
import { saveAndOpenCurrentAnalysis } from './liveCheckpointSave';
import { publicErrorMessage } from './publicError';

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

const Workspace = React.lazy(() => import('./pages/Workspace'));
const QualityControl = React.lazy(() => import('./pages/QualityControl'));
const Normalization = React.lazy(() => import('./pages/Normalization'));
const PCA = React.lazy(() => import('./pages/PCA'));
const Clustering = React.lazy(() => import('./pages/Clustering'));
const UMAPView = React.lazy(() => import('./pages/UMAPView'));
const FeaturePlot = React.lazy(() => import('./pages/FeaturePlot'));
const HeatmapPlot = React.lazy(() => import('./pages/HeatmapPlot'));
const DotPlot = React.lazy(() => import('./pages/DotPlot'));
const GeneViewer = React.lazy(() => import('./pages/GeneViewer'));
const DifferentialExpression = React.lazy(() => import('./pages/DifferentialExpression'));
const PathwayEnrichment = React.lazy(() => import('./pages/PathwayEnrichment'));
const CellChat = React.lazy(() => import('./pages/CellChat'));
const Publication = React.lazy(() => import('./pages/Publication'));
const Validation = React.lazy(() => import('./pages/Validation'));
const LineageExplorer = React.lazy(() => import('./pages/LineageExplorer'));
const ProjectHistory = React.lazy(() => import('./pages/ProjectHistory'));
const BatchIntegration = React.lazy(() => import('./pages/BatchIntegration'));
const Collaborators = React.lazy(() => import('./pages/Collaborators'));
const Inspect = React.lazy(() => import('./pages/Inspect'));
const Diagnostics = React.lazy(() => import('./pages/Diagnostics'));
const PipelineManager = React.lazy(() => import('./pages/PipelineManager'));
const ExploratoryAnalysis = React.lazy(() => import('./pages/ExploratoryAnalysis'));
const AnalysisBranches = React.lazy(() => import('./pages/AnalysisBranches'));
const StudyDesign = React.lazy(() => import('./pages/StudyDesign'));
const ExpertR = React.lazy(() => import('./pages/ExpertR'));

// Pipeline step ordering — used for downstream invalidation
const PIPELINE_ORDER = ['qc', 'normalize', 'integrate', 'pca', 'cluster', 'umap'];

// Human-readable name per tab, used for a visually-hidden <h1> so every
// authenticated view has a level-1 heading (pages render their own <h2>). This
// keeps the screen-reader heading tree rooted instead of starting at h2.
const TAB_TITLES = {
  workspace: 'Workbench', 'pipeline-manager': 'Approved workflows', team: 'Collaborators',
  branches: 'Analysis Branches',
  'study-design': 'Study Design',
  'expert-r': 'Advanced analysis',
  inspect: 'Inspect', lineage: 'Lineage', qc: 'Quality Control', normalize: 'Normalization',
  integrate: 'Batch Integration', pca: 'Principal Component Analysis', cluster: 'Clustering',
  umap: 'UMAP Embedding', featureplot: 'Feature Plot', heatmap: 'Marker Heatmap',
  dotplot: 'Dot Plot', geneviewer: 'Gene Expression', deg: 'Differential Expression',
  explore: 'Exploratory Analysis',
  history: 'Runs & Results', annotate: 'Cell Annotation', enrichment: 'Pathway Enrichment',
  cellchat: 'CellChat', customscript: 'Custom Script', publication: 'Figure Gallery',
  validation: 'Validation', diagnostics: 'Technical support',
};

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
            <h2 className="text-xl font-bold text-text mb-2">Analysis unavailable</h2>
            <p className="text-slate-400 text-sm mb-4">This analysis could not be displayed. Retry it or return to the workspace.</p>
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
  customscript: {
    title: 'Custom Script Disabled',
    subtitle: 'Arbitrary user-provided R execution is out of scope and is not exposed by this local development workbench.',
    icon: 'Disabled'
  }
};

// Lazy-mount tab content. A tab's subtree is not mounted until the tab is first
// activated; after that it stays mounted (just visually hidden) so per-tab state
// survives navigation. Deferring the initial mount is important: every analysis
// tab fires its own live-R probes on mount (e.g. /genes, /meta-values), and the
// R proxy admits only one in-flight analytical request per user — mounting all
// tabs at once produced a burst of "R service is busy" (429) responses on load.
const TabContent = ({ id, activeTab, children }) => {
  const [hasBeenActive, setHasBeenActive] = useState(activeTab === id);
  useEffect(() => {
    if (activeTab === id) setHasBeenActive(true);
  }, [activeTab, id]);
  return (
    <div className={`absolute inset-0 ${activeTab === id ? 'block' : 'hidden'}`}>
      {hasBeenActive ? (
        <React.Suspense fallback={(
          <div role="status" className="flex h-full items-center justify-center text-sm text-textMuted">
            Opening workspace…
          </div>
        )}>
          {children}
        </React.Suspense>
      ) : null}
    </div>
  );
};

const CLOSED_DEPLOYMENT_POLICY = Object.freeze({
  registrationEnabled: false,
  legacyLocalImportsEnabled: false,
  legacyLiveMutationToolsEnabled: false,
  serverFigureExportEnabled: false,
  expertREnabled: false,
  expertRProfile: null,
  demoMode: false,
  datasetUploadsEnabled: false,
  demoGuestTtlSeconds: null,
});

export default function App() {
  const [activeTab, setActiveTab] = useState('workspace');
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [deploymentPolicy, setDeploymentPolicy] = useState(CLOSED_DEPLOYMENT_POLICY);

  useEffect(() => {
    let active = true;
    if (!window.electronAPI?.registrationPolicy) return undefined;
    window.electronAPI.registrationPolicy().then((policy) => {
      if (!active) return;
      setDeploymentPolicy((current) => ({
        registrationEnabled: policy?.registrationEnabled === true,
        legacyLocalImportsEnabled: policy?.legacyLocalImportsEnabled === true,
        legacyLiveMutationToolsEnabled: policy?.legacyLiveMutationToolsEnabled === true,
        serverFigureExportEnabled: policy?.serverFigureExportEnabled === true,
        expertREnabled: current.expertREnabled,
        expertRProfile: current.expertRProfile,
        demoMode: policy?.demoMode === true,
        datasetUploadsEnabled: policy?.datasetUploadsEnabled === true,
        demoGuestTtlSeconds: policy?.demoGuestTtlSeconds || null,
      }));
    }).catch(() => {
      if (active) {
        setDeploymentPolicy((current) => ({
          ...CLOSED_DEPLOYMENT_POLICY,
          expertREnabled: current.expertREnabled,
          expertRProfile: current.expertRProfile,
        }));
      }
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
  const [unsavedLiveChanges, setUnsavedLiveChanges] = useState(false);
  const [checkpointSaveState, setCheckpointSaveState] = useState({ phase: 'idle', message: '', durableSaved: false });
  const checkpointSaveRequestRef = React.useRef(0);
  const checkpointSaveBusy = ['saving', 'opening', 'pending'].includes(checkpointSaveState.phase);
  // Gate that blocks per-page cache hydration until after the R session
  // identity and selected-object attachment probes complete. Without this
  // gate the pages fire onlyIfCached calls with the wrong (new) session ID
  // and always miss the SQLite cache.
  const [sessionCheckDone, setSessionCheckDone] = useState(false);

  const [user, setUser] = useState(null);
  const [loggedOutNotice, setLoggedOutNotice] = useState('');
  const isLoggedIn = !!user;

  useEffect(() => {
    let active = true;
    if (!user?.id || typeof window.electronAPI?.getExpertRCapabilities !== 'function') {
      setDeploymentPolicy((current) => ({
        ...current,
        expertREnabled: false,
        expertRProfile: null,
      }));
      return undefined;
    }
    window.electronAPI.getExpertRCapabilities().then((capability) => {
      if (!active) return;
      setDeploymentPolicy((current) => ({
        ...current,
        expertREnabled: capability?.expertREnabled === true,
        expertRProfile: capability?.expertRProfile || null,
      }));
    }).catch(() => {
      if (active) {
        setDeploymentPolicy((current) => ({
          ...current,
          expertREnabled: false,
          expertRProfile: null,
        }));
      }
    });
    return () => { active = false; };
  }, [user?.id]);

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

  // Refresh the gallery badge on login and when entering/leaving the Figure
  // Gallery, rather than firing getFigures on every unrelated tab navigation.
  const onPublicationTab = activeTab === 'publication';
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.getFigures && user?.email) {
      window.electronAPI.getFigures(user.email).then(figures => {
        setFiguresCount(figures.length);
      }).catch(err => {
        console.error('[App] Failed to load figures count:', err);
      });
    }
  }, [onPublicationTab, user?.email]);

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
  const [computeStatus, setComputeStatus] = useState({ status: 'unknown', updatedAt: null });
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

  useEffect(() => {
    if (!user?.email || typeof window.electronAPI?.getComputeRuntimeStatus !== 'function') {
      setComputeStatus({ status: 'unknown', updatedAt: null });
      return undefined;
    }
    let active = true;
    const refreshComputeStatus = async () => {
      try {
        const next = await window.electronAPI.getComputeRuntimeStatus();
        if (active) setComputeStatus(next);
      } catch {
        if (active) setComputeStatus({ status: 'unknown', updatedAt: null });
      }
    };
    void refreshComputeStatus();
    const intervalId = window.setInterval(refreshComputeStatus, 5000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
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
        error: publicErrorMessage(err, 'Saved analyses are temporarily unavailable.'),
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
        error: publicErrorMessage(err, 'Projects are temporarily unavailable.'),
      }));
      return { projects: [], selectedProjectId: null, error: err };
    }
  }, [patchActiveWorkspace, refreshAnalysisObjects, user]);

  useEffect(() => {
    if (!user?.email) return;
    refreshProjects();
  }, [refreshProjects, user?.email]);

  const handleSelectProject = useCallback(async (projectId) => {
    checkpointSaveRequestRef.current += 1;
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

  // A DB-backed object must be created before R can accept its server-verified
  // private key. If the live load fails, keep that durable record visible and
  // selected so the owner gets a concrete recovery action instead of an
  // unexplained object appearing after the next sign-in.
  const handleAnalysisObjectLoadFailed = useCallback((projectId, analysisObject) => {
    if (!projectId || !analysisObject?.id) return;
    const objectCard = mapBackendAnalysisObject(analysisObject);
    cacheSelectedProject(localStorage, user, projectId);
    cacheSelectedAnalysisObject(localStorage, user, projectId, analysisObject.id);
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

  // This is a UI projection of a just-completed server-authorized restore/fork
  // job. It never grants access to another member's live R state; the worker
  // has already verified the requesting owner and selected the checkpoint.
  const handleLiveObjectAttached = useCallback((projectId, objectId) => {
    if (!projectId || !objectId) return;
    setUnsavedLiveChanges(false);
    patchActiveWorkspace(ws => ({
      objects: ws.objects.map(object => (
        object.projectId === projectId && object.id === objectId
          ? { ...object, liveState: 'attached' }
          : object
      )),
    }));
  }, [patchActiveWorkspace]);

  useEffect(() => {
    if (!unsavedLiveChanges) return undefined;
    const warnBeforeClose = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeClose);
    return () => window.removeEventListener('beforeunload', warnBeforeClose);
  }, [unsavedLiveChanges]);

  const handleSelectAnalysisObject = useCallback((projectId, objectId) => {
    checkpointSaveRequestRef.current += 1;
    cacheSelectedAnalysisObject(localStorage, user, projectId, objectId);
    patchActiveWorkspace(ws => ({
      selectedObjectIds: objectId ? [objectId] : [],
      lastSelectedByProject: objectId
        ? { ...(ws.lastSelectedByProject || {}), [projectId]: objectId }
        : (ws.lastSelectedByProject || {}),
    }));
  }, [patchActiveWorkspace, user]);

  const handleSaveLiveAnalysis = useCallback(async () => {
    const projectId = datasetInfo?.projectId || currentWs.selectedProjectId;
    const objectId = datasetInfo?.id;
    if (!projectId || !objectId || checkpointSaveBusy) return;
    const requestId = ++checkpointSaveRequestRef.current;
    setCheckpointSaveState({ phase: 'saving', message: 'Saving the current analysis as an immutable version...', durableSaved: false });
    try {
      const saved = await saveAndOpenCurrentAnalysis(
        window.electronAPI,
        projectId,
        objectId,
        {
          onPhase: (phase) => {
            if (checkpointSaveRequestRef.current !== requestId) return;
            if (phase === 'opening') {
              setUnsavedLiveChanges(false);
              setCheckpointSaveState({
                phase,
                message: 'Saved. Opening the durable version in your private workspace...',
                durableSaved: true,
              });
            }
          },
        }
      );
      if (checkpointSaveRequestRef.current !== requestId) return;
      await refreshAnalysisObjects(projectId);
      if (checkpointSaveRequestRef.current !== requestId) return;
      handleSelectAnalysisObject(projectId, saved.resultAnalysisObjectId);
      handleLiveObjectAttached(projectId, saved.resultAnalysisObjectId);
      setUnsavedLiveChanges(false);
      setCheckpointSaveState({
        phase: 'completed',
        message: 'Saved and opened as a durable analysis version.',
        durableSaved: true,
      });
    } catch (error) {
      if (checkpointSaveRequestRef.current !== requestId) return;
      const durableSaved = error?.durableSaved === true;
      if (durableSaved) setUnsavedLiveChanges(false);
      const stillPending = error?.code === 'JOB_POLL_TIMEOUT' && !durableSaved;
      setCheckpointSaveState({
        phase: stillPending ? 'pending' : 'error',
        message: publicErrorMessage(
          error,
          durableSaved
            ? 'The saved version exists, but it could not be opened. Open it from Runs & Results.'
            : 'The current analysis could not be saved. Review Runs & Results and try again.'
        ),
        durableSaved,
      });
    }
  }, [checkpointSaveBusy, currentWs.selectedProjectId, datasetInfo?.id, datasetInfo?.projectId,
    handleLiveObjectAttached, handleSelectAnalysisObject, refreshAnalysisObjects]);

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
        const parentKey = `traceomics_params_${step}_${sanitizedEmail}_${parentId}`;
        const childKey = `traceomics_params_${step}_${sanitizedEmail}_${childId}`;
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
    setUnsavedLiveChanges(true);
    setCheckpointSaveState({ phase: 'idle', message: '', durableSaved: false });

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
          // Cached provenance can render a prior result, but it cannot prove
          // that the selected object exists in the current private R process.
          if (step && hasAttachedLiveRObject(datasetInfo)) {
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

    if (checkpointSaveBusy) {
      return { error: 'Wait for the current analysis save to finish before changing the live workspace.' };
    }

    // Durable project objects are safe to browse without a live R attachment.
    // Do not let hidden analysis tabs probe R merely because such an object is
    // selected; only cached results may be read until this user's private live
    // object has been attached explicitly.
    if (!hasAttachedLiveRObject(datasetInfo)) {
      return { error: 'Open this saved version in your private analysis workspace before continuing.' };
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
          setUnsavedLiveChanges(true);
          setCheckpointSaveState({ phase: 'idle', message: '', durableSaved: false });
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
      // The R proxy admits one analytical request per user at a time and returns
      // 429 "R service is busy" for concurrent ones — an expected, retryable
      // condition, not an app fault. Log those quietly so genuine failures stay
      // visible as console errors.
      const msg = String(err?.message || '');
      if (/\bbusy\b|rate limit|too many/i.test(msg)) console.warn('[callApi] transient:', msg);
      else console.error(err);
      return { error: publicErrorMessage(err) };
    }
  }, [checkpointSaveBusy, markPipelineStep, currentWs, updateActiveWorkspace, rSessionId, datasetInfo]);

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
  // Legacy traceomics_ws_* localStorage keys are intentionally ignored here.
  // Backend projects and analysis-object rows are the authoritative workspace
  // model; localStorage only caches selected project/object IDs.
  // ────────────────────────────────────────────────────────────────

  // ── R Session / Pipeline Persistence ─────────────────────────────
  // Live R state is private and transient. A selected database object is never
  // treated as attached until the current R process confirms it.

  useEffect(() => {
    if (!user?.email) {
      setSessionCheckDone(true);
      return;
    }
    setSessionCheckDone(false);
    checkpointSaveRequestRef.current += 1;
    setUnsavedLiveChanges(false);
    setCheckpointSaveState({ phase: 'idle', message: '', durableSaved: false });
    resetPipelineState();
    if (datasetInfo?.id) {
      const objectId = datasetInfo.id;
      patchActiveWorkspace(ws => ({
        objects: ws.objects.map(object => object.id === objectId
          ? { ...object, liveState: 'unknown' }
          : object),
      }));
    }
    window.electronAPI.apiRequest('/session-id')
      .then(data => {
        if (data?.sessionId) setRSessionId(data.sessionId);
      })
      .catch(e => {
        console.warn('[Session] R session probe failed:', e);
        setRSessionId(null);
        resetPipelineState();
      })
      .finally(() => setSessionCheckDone(true));
  }, [user?.email, datasetInfo?.id, resetPipelineState, patchActiveWorkspace]);

  const pipelineProbeKeyRef = React.useRef(null);
  const pipelineProbeAttachedRef = React.useRef(false);
  const pipelineProbeAttemptsRef = React.useRef(0);
  const pipelineProbeRetryTimeoutRef = React.useRef(null);
  const [pipelineProbeRetry, setPipelineProbeRetry] = useState(0);
  useEffect(() => {
    const objectId = datasetInfo?.id;
    if (!user?.email || !objectId || !sessionCheckDone) return;
    const key = `${user.email}:${objectId}:${rSessionId || 'unknown'}`;
    const probeAction = pipelineProbeAction({
      currentKey: pipelineProbeKeyRef.current,
      nextKey: key,
      serverAttached: pipelineProbeAttachedRef.current,
      liveState: datasetInfo?.liveState,
    });
    if (probeAction === 'skip') {
      return;
    }
    if (pipelineProbeKeyRef.current !== key) pipelineProbeAttachedRef.current = false;
    pipelineProbeKeyRef.current = key;

    window.electronAPI.apiRequest('/pipeline-state', {
      headers: { 'X-Object-ID': objectId }
    }).then(state => {
      // A transient proxy/R failure (e.g. HTTP 429 "R service is busy", a network
      // blip, or a temporarily unreachable backend) comes back as { error } — NOT
      // as an authoritative "object does not exist". Treat it as retryable and
      // leave the current attachment intact; detaching a live object on a transient
      // error wrongly tears down a working session. Only an explicit exists:false
      // from the backend detaches the object.
      if (state?.error) {
        pipelineProbeKeyRef.current = null;
        if (pipelineProbeAttemptsRef.current < 3) {
          pipelineProbeAttemptsRef.current += 1;
          pipelineProbeRetryTimeoutRef.current = window.setTimeout(() => setPipelineProbeRetry(value => value + 1), 750);
        }
        return;
      }
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
        pipelineProbeRetryTimeoutRef.current = window.setTimeout(() => setPipelineProbeRetry(value => value + 1), 750);
      }
    });
    // Clear a pending retry if the effect re-runs (dataset/session change) or the
    // component unmounts, so a stale timer can't fire a probe against the wrong
    // object/session after switching.
    return () => {
      if (pipelineProbeRetryTimeoutRef.current) {
        window.clearTimeout(pipelineProbeRetryTimeoutRef.current);
        pipelineProbeRetryTimeoutRef.current = null;
      }
    };
  }, [user?.email, datasetInfo?.id, datasetInfo?.liveState, rSessionId, sessionCheckDone, pipelineProbeRetry, resetPipelineState, patchActiveWorkspace]);



  // Pipeline availability belongs to the server-verified private R session, not
  // the browser's provenance cache. Provenance can be incomplete for sessions
  // created by older releases or after a local cache reset; treating a partial
  // history as authoritative used to turn a completed PCA/cluster into a false
  // "PCA Required" gate immediately after a downstream action. The pipeline
  // probe above and successful current-session actions are the only sources
  // allowed to change these live-state controls. Provenance remains available
  // for history, script viewing, and parent links without changing R state.
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
      setActiveTab,
      historyRefreshToken,
      onExpertRSubmitted: () => setHistoryRefreshToken((token) => token + 1),
      computeStatus,
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
            onAnalysisObjectLoadFailed={handleAnalysisObjectLoadFailed}
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
        <ErrorBoundary key="branches"><TabContent id="branches" activeTab={activeTab}><AnalysisBranches {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="study-design"><TabContent id="study-design" activeTab={activeTab}><StudyDesign {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="expert-r"><TabContent id="expert-r" activeTab={activeTab}><ExpertR {...props} /></TabContent></ErrorBoundary>
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
        <ErrorBoundary key="explore"><TabContent id="explore" activeTab={activeTab}><ExploratoryAnalysis key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="geneviewer"><TabContent id="geneviewer" activeTab={activeTab}><GeneViewer key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="deg"><TabContent id="deg" activeTab={activeTab}><DifferentialExpression key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="history"><TabContent id="history" activeTab={activeTab}><ProjectHistory {...props} refreshAnalysisObjects={refreshAnalysisObjects} onSelectAnalysisObject={handleSelectAnalysisObject} onLiveObjectAttached={handleLiveObjectAttached} setActiveTab={setActiveTab} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="annotate"><TabContent id="annotate" activeTab={activeTab}><PlaceholderPage {...FUTURE_FEATURES.annotate} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="enrichment"><TabContent id="enrichment" activeTab={activeTab}><PathwayEnrichment key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="cellchat"><TabContent id="cellchat" activeTab={activeTab}><CellChat key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="customscript"><TabContent id="customscript" activeTab={activeTab}><PlaceholderPage {...FUTURE_FEATURES.customscript} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="integrate"><TabContent id="integrate" activeTab={activeTab}><BatchIntegration key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="publication"><TabContent id="publication" activeTab={activeTab}><Publication {...props} isActive={activeTab === 'publication'} /></TabContent></ErrorBoundary>
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
        computeStatus={computeStatus}
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
        <h1 className="sr-only">TraceOmics Workbench — {TAB_TITLES[activeTab] || 'Current view'}</h1>
        {(unsavedLiveChanges || checkpointSaveState.phase !== 'idle') && (
          <div className={`shrink-0 border-b px-4 py-2 text-xs text-text ${checkpointSaveState.phase === 'completed' ? 'border-emerald-500/30 bg-emerald-500/10' : checkpointSaveState.phase === 'error' ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'}`} role="status">
            {checkpointSaveState.phase === 'idle' ? (
              <>
                <span className="font-bold">Unsaved live changes.</span>{' '}
                Closing this window or restarting compute can discard them.
              </>
            ) : <span className="font-medium">{checkpointSaveState.message}</span>}
            {unsavedLiveChanges && !checkpointSaveBusy && (
              <button type="button" className="ml-2 font-bold underline" onClick={() => void handleSaveLiveAnalysis()}>Save current analysis</button>
            )}
            {(checkpointSaveState.phase === 'error' || checkpointSaveState.phase === 'pending') && (
              <button type="button" className="ml-2 underline" onClick={() => setActiveTab('history')}>Open Runs &amp; Results</button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1">{renderContent()}</div>
      </main>

      <ProvenanceDrawer
        provId={drawerProvId}
        chain={drawerChain}
        onClose={() => { setDrawerProvId(null); setDrawerChain(null); }}
      />
    </div>
  );
}
