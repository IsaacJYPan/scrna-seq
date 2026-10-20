import React, { useState, useEffect, useCallback } from 'react';
import ExecutionTargetIndicator from './components/ExecutionTargetIndicator';
import AnalysisStatusBar from './components/AnalysisStatusBar';
import { SubmissionRecoveryNotice } from './components/SubmissionRecovery';
import { clearSubmissionRecovery } from './executions/submissionRecovery';
import { Loader2, Microscope } from 'lucide-react';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import ProvenanceDrawer from './components/ProvenanceDrawer';
import { useProjectPipelineSelection } from './pipelines/useProjectPipelineSelection';
import { mergeWorkflowUpdate } from './pipelines/workflowApi';
import {
  consumeSavedObjectSelection,
  hasAttachedLiveRObject,
  PIPELINE_PROBE_MAX_RETRIES,
  pipelineProbeAction,
  pipelineProbeRetryDelay,
  reconcileRestoredSession,
  serverUnsavedLiveChanges,
} from './liveRState';
import { saveAndOpenCurrentAnalysis } from './liveCheckpointSave';
import { publicErrorMessage } from './publicError';
import { getExecutionTargetSnapshot } from './runtime/executionTarget';
import { prepareOriginalObjectHistory } from './analyses/openOriginalHistory';
import { buildProjectProvenancePayload } from './projectProvenance';

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
  reconcileAnalysisObjectMetadata,
} from './backendWorkspaceModel';

const Workspace = React.lazy(() => import('./pages/Workspace'));
const ResearchAnalyses = React.lazy(() => import('./pages/ResearchAnalyses'));
const QualityControl = React.lazy(() => import('./pages/QualityControl'));
const Normalization = React.lazy(() => import('./pages/Normalization'));
const PCA = React.lazy(() => import('./pages/PCA'));
const Clustering = React.lazy(() => import('./pages/Clustering'));
const UMAPView = React.lazy(() => import('./pages/UMAPView'));
const FeaturePlot = React.lazy(() => import('./pages/FeaturePlot'));
const HeatmapPlot = React.lazy(() => import('./pages/HeatmapPlot'));
const DotPlot = React.lazy(() => import('./pages/DotPlot'));
const GeneViewer = React.lazy(() => import('./pages/GeneViewer'));
const HISTORY_PERSISTENCE_NOTICE = 'The analysis completed, but some history or cached result details could not be saved. Keep the current result and check Runs & Results. Do not rerun it just to repair history.';
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
const WorkflowWorkbench = React.lazy(() => import('./components/WorkflowWorkbench'));
const ExploratoryAnalysis = React.lazy(() => import('./pages/ExploratoryAnalysis'));
const AnalysisBranches = React.lazy(() => import('./pages/AnalysisBranches'));
const StudyDesign = React.lazy(() => import('./pages/StudyDesign'));
const ExpertR = React.lazy(() => import('./pages/ExpertR'));
const AccountSecurity = React.lazy(() => import('./pages/AccountSecurity'));

// Pipeline step ordering — used for downstream invalidation
const PIPELINE_ORDER = ['qc', 'normalize', 'integrate', 'pca', 'cluster', 'umap'];

// Human-readable name per tab, used for a visually-hidden <h1> so every
// authenticated view has a level-1 heading (pages render their own <h2>). This
// keeps the screen-reader heading tree rooted instead of starting at h2.
const TAB_TITLES = {
  account: 'Account security',
  analyses: 'Analyses',
  workspace: 'Workbench', 'pipeline-manager': 'Pipelines', team: 'Collaborators',
  branches: 'Analysis Branches',
  'study-design': 'Study Design',
  'expert-r': 'Advanced analysis',
  inspect: 'Inspect', lineage: 'Lineage', qc: 'Quality Control', normalize: 'Normalization',
  integrate: 'Batch Integration', pca: 'Principal Component Analysis', cluster: 'Clustering',
  umap: 'UMAP Embedding', featureplot: 'Feature Plot', heatmap: 'Marker Heatmap',
  dotplot: 'Dot Plot', geneviewer: 'Gene Expression', deg: 'Differential Expression',
  explore: 'Exploratory Analysis',
  history: 'Runs & Results', enrichment: 'Pathway Enrichment',
  cellchat: 'CellChat', publication: 'Figure Gallery',
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

// Lazy-mount tab content. A tab's subtree is not mounted until the tab is first
// activated; after that it stays mounted (just visually hidden) so per-tab state
// survives navigation. Deferring the initial mount is important: every analysis
// tab fires its own live-R probes on mount (e.g. /genes, /meta-values), and the
// R proxy admits only one in-flight analytical request per user — mounting all
// tabs at once produced a burst of "R service is busy" (429) responses on load.
export const TabContent = ({ id, activeTab, contextKey = 'workspace', children }) => {
  const [visitedContext, setVisitedContext] = useState(activeTab === id ? contextKey : null);
  useEffect(() => {
    if (activeTab === id) setVisitedContext(contextKey);
  }, [activeTab, id, contextKey]);
  return (
    <div className={`absolute inset-0 ${activeTab === id ? 'block' : 'hidden'}`}>
      {visitedContext === contextKey || activeTab === id ? (
        <React.Suspense fallback={(
          <div role="status" className="flex h-full items-center justify-center text-sm text-textMuted">
            Opening {TAB_TITLES[id] || 'workspace'}…
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
  expertRStatus: null,
  demoMode: false,
  datasetUploadsEnabled: false,
  demoGuestTtlSeconds: null,
});

export default function App() {
  const [activeTab, setActiveTab] = useState('workspace');
  const [activeWorkflow, setActiveWorkflow] = useState(null);
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
        expertRStatus: current.expertRStatus,
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
          expertRStatus: current.expertRStatus,
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
  const [liveRecoveryNotice, setLiveRecoveryNotice] = useState('');
  const [historyPersistenceNotice, setHistoryPersistenceNotice] = useState('');
  const [checkpointSaveState, setCheckpointSaveState] = useState({ phase: 'idle', message: '', durableSaved: false });
  const checkpointSaveRequestRef = React.useRef(0);
  const checkpointSaveOpenedObjectRef = React.useRef(null);
  const checkpointSaveBusy = ['saving', 'opening', 'pending'].includes(checkpointSaveState.phase);
  // Gate that blocks per-page cache hydration until after the R session
  // identity and selected-object attachment probes complete. Without this
  // gate the pages fire onlyIfCached calls with the wrong (new) session ID
  // and miss the saved result cache.
  const [sessionCheckDone, setSessionCheckDone] = useState(false);

  const [user, setUser] = useState(null);
  const [authResolution, setAuthResolution] = useState(() => (
    typeof window.electronAPI?.restoreSession === 'function' ? 'checking' : 'resolved'
  ));
  const [authRetry, setAuthRetry] = useState(0);
  const [loggedOutNotice, setLoggedOutNotice] = useState('');
  const isLoggedIn = !!user;

  useEffect(() => {
    let active = true;
    if (!user?.id || typeof window.electronAPI?.getExpertRCapabilities !== 'function') {
      setDeploymentPolicy((current) => ({
        ...current,
        expertREnabled: false,
        expertRProfile: null,
        expertRStatus: null,
      }));
      return undefined;
    }
    window.electronAPI.getExpertRCapabilities().then((capability) => {
      if (!active) return;
      setDeploymentPolicy((current) => ({
        ...current,
        expertREnabled: capability?.expertREnabled === true,
        expertRProfile: capability?.expertRProfile || null,
        expertRStatus: capability?.expertRStatus || null,
      }));
    }).catch(() => {
      if (active) {
        setDeploymentPolicy((current) => ({
          ...current,
          expertREnabled: false,
          expertRProfile: null,
          expertRStatus: null,
        }));
      }
    });
    return () => { active = false; };
  }, [user?.id]);

  // Restore auth state from the HttpOnly session cookie (source of truth) on
  // mount, rather than trusting cached local user metadata. Keep the login form
  // out of the initial render until the server resolves that session; an outage
  // is retryable and does not mean the user has been signed out.
  useEffect(() => {
    let cancelled = false;
    if (!window.electronAPI?.restoreSession) {
      setAuthResolution('resolved');
      return undefined;
    }
    setAuthResolution('checking');
    window.electronAPI.restoreSession().then((restored) => {
      if (cancelled) return;
      setUser((currentUser) => reconcileRestoredSession(currentUser, restored));
      setAuthResolution('resolved');
    }).catch(() => {
      if (!cancelled) setAuthResolution('error');
    });
    return () => { cancelled = true; };
  }, [authRetry]);

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
  const activeProjectIdForPipeline = currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const workflowContext = React.useMemo(() => ({ active: true, userId: user?.id, projectId: activeProjectIdForPipeline, analysisObjectId: datasetInfo?.id }), [user?.id, activeProjectIdForPipeline, datasetInfo?.id]);
  useEffect(() => { setHistoryPersistenceNotice(''); }, [user?.id, datasetInfo?.id]);
  useEffect(() => {
    workflowContext.active = true;
    return () => { workflowContext.active = false; };
  }, [workflowContext]);
  const updateWorkflow = useCallback((instance, { replace = false } = {}) => {
    if (!workflowContext.active || instance.projectId !== workflowContext.projectId || instance.analysisObjectId !== workflowContext.analysisObjectId) return;
    setActiveWorkflow(current => mergeWorkflowUpdate(current, instance, replace));
    if (replace) setActiveTab(current => current.startsWith('workflow:') && !instance.package.tabs.some(tab => current === `workflow:${tab.id}`) ? `workflow:${instance.package.tabs[0].id}` : current);
  }, [workflowContext]);
  useEffect(() => {
    setActiveWorkflow(null);
    setActiveTab(current => current.startsWith('workflow:') ? 'pipeline-manager' : current);
  }, [user?.id, activeProjectIdForPipeline, datasetInfo?.id]);
  const currentProvId = currentWs.branches[currentWs.activeBranch];
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
      patchActiveWorkspace(ws => ws.selectedProjectId !== projectId ? {} : ({
        objects: reconcileAnalysisObjectMetadata(ws.objects, state.objects),
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
      // An outage is not an authoritative deletion. Keep the selected live
      // object and its dirty state; access denials still remove the projection.
      if ([401, 403, 404].includes(err.status)) {
        patchActiveWorkspace(ws => ws.selectedProjectId === projectId ? { objects: [], selectedObjectIds: [] } : {});
      }
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
      patchActiveWorkspace(ws => ({
        projects: state.projects,
        selectedProjectId: state.selectedProjectId,
        ...(ws.selectedProjectId === state.selectedProjectId ? {} : {
          objects: [],
          selectedObjectIds: [],
          lastSelectedByProject: {},
        }),
      }));
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
      if ([401, 403, 404].includes(err.status)) {
        patchActiveWorkspace({ projects: [], selectedProjectId: null, objects: [], selectedObjectIds: [] });
      } else {
        // Preserve the analysis during a transient outage, while withholding
        // cached mutation permissions until the project list can be verified.
        patchActiveWorkspace(ws => ({ projects: ws.projects.map(project => ({ ...project, role: null })) }));
      }
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
    if (workflowContext.projectId === projectId && workflowContext.analysisObjectId === objectId) {
      delete workflowContext.resultCache;
    }
    setUnsavedLiveChanges(false);
    setLiveRecoveryNotice('');
    patchActiveWorkspace(ws => ({
      objects: ws.objects.map(object => (
        object.projectId === projectId && object.id === objectId
          ? { ...object, liveState: 'attached' }
          : object
      )),
    }));
  }, [patchActiveWorkspace, workflowContext]);

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
    // Restoring a checkpoint can replace live R state while retaining this ID.
    // Discard known result identities even when selection does not change.
    delete workflowContext.resultCache;
    cacheSelectedAnalysisObject(localStorage, user, projectId, objectId);
    patchActiveWorkspace(ws => ({
      selectedObjectIds: objectId ? [objectId] : [],
      lastSelectedByProject: objectId
        ? { ...(ws.lastSelectedByProject || {}), [projectId]: objectId }
        : (ws.lastSelectedByProject || {}),
    }));
  }, [patchActiveWorkspace, user, workflowContext]);

  const savedWorkScope = React.useRef(null);
  savedWorkScope.current = { userId: user?.id, projectId: currentWs?.selectedProjectId, workspaceId: currentWs?.id,
    objectId: datasetInfo?.id, unsavedLiveChanges, activeTab };
  const openOriginalObjectHistory = useCallback(async objectId => {
    const state = await prepareOriginalObjectHistory({ api: window.electronAPI, objectId,
      getScope: () => savedWorkScope.current, getTarget: getExecutionTargetSnapshot,
      getSelection: () => checkpointSaveRequestRef.current });
    patchActiveWorkspace(ws => ({ objects: reconcileAnalysisObjectMetadata(ws.objects, state.objects) }));
    if (state.selectObject) handleSelectAnalysisObject(state.projectId, objectId);
    setActiveTab('history');
  }, [patchActiveWorkspace, handleSelectAnalysisObject]);

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
      checkpointSaveOpenedObjectRef.current = saved.resultAnalysisObjectId;
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

    // Reuse the exact lookup identity when saving. Parent provenance is part of
    // that identity, and generating it again adds a remote request per run.
    let cacheKey = null;
    let cacheKeyUnavailable = false;
    // The browser can prove which parameters produced a live step only after
    // observing that step run in this object/session. Unknown identities after
    // reload are cache misses until a fresh run establishes them.
    if (workflowContext.resultCache?.rSessionId !== rSessionId) {
      workflowContext.resultCache = { rSessionId, stepKeys: new Map(), liveRevision: null };
    }
    const resultCache = workflowContext.resultCache;

    // Stateful operations must run when requested: a historical result cannot
    // apply its parameters to the current R object. Hydrate a completed step
    // only after the server has confirmed it exists in this attached session.
    const canReadCache = !step || (forceOnlyIfCached
      && hasAttachedLiveRObject(datasetInfo) && pipelineState[step]);

    // 1. Check Cache First
    if (useCache && effectiveCacheParams) {
      try {
        cacheKey = await makeCacheKey(operation, effectiveCacheParams, currentWs.dataVersion, parentIds);
        const matchesLiveStep = !step || resultCache.stepKeys.get(step)?.cacheKey === cacheKey;
        const cached = canReadCache && matchesLiveStep ? await getCachedResult(cacheKey) : null;
        if (cached) {
          const prov = await (window.electronAPI?.getProvenance?.(cached.provenanceId));
          if (prov && workflowContext.active && workflowContext.resultCache === resultCache
              && (!step || (resultCache.stepKeys.get(step)?.cacheKey === cacheKey
                && resultCache.stepKeys.get(step)?.provenanceId === cached.provenanceId))) {
            // Reading a prior result never changes current live completion,
            // cluster settings, or object metadata.
            return {
              provenance: { ...prov, parentIds: prov.parentIds || parentIds },
              result: cached.result,
              _fromCache: true,
            };
          }
        }
      } catch {
        // Cache availability must not block an explicitly requested analysis.
        cacheKeyUnavailable = cacheKey === null;
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
      const stepIndex = PIPELINE_ORDER.indexOf(step);
      if (stepIndex >= 0) {
        // A failed mutation may still change R before returning an error. Once
        // dispatched, old identities stay invalid until a success proves one.
        for (const downstream of PIPELINE_ORDER.slice(stepIndex)) resultCache.stepKeys.delete(downstream);
      } else if (step || (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()))) {
        resultCache.stepKeys.clear();
      }
      options.headers = options.headers || {};
      if (datasetInfo?.id) {
        options.headers['X-Object-ID'] = datasetInfo.id;
      }
      const data = await window.electronAPI.apiRequest(path, options);
      if (!workflowContext.active) return data;
      if (data.execution_history?.status === 'unavailable') {
        setHistoryPersistenceNotice(HISTORY_PERSISTENCE_NOTICE);
      }
      const serverUnsaved = serverUnsavedLiveChanges(data.live_state);
      const responseRevision = data.live_state?.live_revision;
      const hasResponseRevision = Number.isSafeInteger(responseRevision);
      const olderResponse = hasResponseRevision && Number.isSafeInteger(resultCache.liveRevision)
        && responseRevision < resultCache.liveRevision;
      const currentResultContext = workflowContext.resultCache === resultCache && !olderResponse;
      if (currentResultContext && stepIndex < 0 && hasResponseRevision
          && responseRevision !== resultCache.liveRevision) {
        // A mutation outside the ordered pipeline can invalidate every live
        // result. Read-only responses at the same revision keep known keys.
        resultCache.stepKeys.clear();
      }
      if (hasResponseRevision && !olderResponse) {
        resultCache.liveRevision = responseRevision;
      }
      // Persist every completed attempt, but project only the newest confirmed
      // state into the live workspace. Recheck after asynchronous history writes:
      // another response or checkpoint attachment may have superseded this one.
      const canProjectLiveResult = () => workflowContext.active
        && workflowContext.resultCache === resultCache && !olderResponse
        && (!hasResponseRevision || resultCache.liveRevision === responseRevision);
      if (serverUnsaved !== null && canProjectLiveResult()) {
        setUnsavedLiveChanges(serverUnsaved);
        setLiveRecoveryNotice('');
      }
      if (data.error) throw new Error(data.error);

      if (data.provenance) {
        data.provenance.parentIds = parentIds;
        try { await saveProvenance(data); }
        catch { setHistoryPersistenceNotice(HISTORY_PERSISTENCE_NOTICE); }
        const projectId = datasetInfo?.projectId;
        const projectRole = (currentWs?.projects || []).find((project) => project.id === projectId)?.role;
        if (projectId && datasetInfo?.id && data.execution_history?.status !== 'recorded'
            && ['owner', 'admin', 'analyst'].includes(projectRole)
            && typeof window.electronAPI?.createProjectProvenance === 'function') {
          const projectPayload = buildProjectProvenancePayload(data.provenance, datasetInfo.id);
          try {
            await window.electronAPI.createProjectProvenance(projectId, projectPayload);
          } catch {
            // The scientific operation has already completed in R. Project-level
            // provenance persistence is best-effort here so a transient history
            // write failure cannot cause the user to repeat a mutating operation.
            setHistoryPersistenceNotice(HISTORY_PERSISTENCE_NOTICE);
          }
        }

        if (workflowContext.active) {
          setProvenanceRecords(prev => {
            if (prev.some(p => p.id === data.provenance.id)) return prev;
            return canProjectLiveResult() ? [data.provenance, ...prev] : [...prev, data.provenance];
          });
        }

        if (canProjectLiveResult()) {
          updateActiveWorkspace({
            branches: {
              ...currentWs.branches,
              [currentWs.activeBranch]: data.provenance.id
            }
          });
        }

        if (step && canProjectLiveResult()) {
          const extraState = {};
          if (step === 'cluster') {
            if (data.result?.n_clusters) extraState.clusterCount = data.result.n_clusters;
            if (data.result?.dims_used)  extraState.clusterDims  = data.result.dims_used;
          }
          if (step === 'qc' && data.result) {
            extraState.qcSummary = data.result;
          }
          markPipelineStep(step, extraState);
          setUnsavedLiveChanges(serverUnsaved ?? true);
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

        if (useCache && effectiveCacheParams && canProjectLiveResult()) {
          try {
            if (cacheKey !== null) {
              await setCachedResult(cacheKey, data.provenance.id, data.result);
              if (stepIndex >= 0 && workflowContext.resultCache === resultCache
                  && (!hasResponseRevision || resultCache.liveRevision === responseRevision)) {
                resultCache.stepKeys.set(step, { cacheKey, provenanceId: data.provenance.id });
              }
            }
            else if (cacheKeyUnavailable) setHistoryPersistenceNotice(HISTORY_PERSISTENCE_NOTICE);
          } catch { setHistoryPersistenceNotice(HISTORY_PERSISTENCE_NOTICE); }
        }
      }
      return data;
    } catch (err) {
      // The R proxy admits one analytical request per user at a time and returns
      // 429 "R service is busy" for concurrent ones — an expected, retryable
      // condition, not an app fault. Log those quietly so genuine failures stay
      // visible as console errors.
      // A departed tab may cancel its read; do not turn that into analysis
      // failure feedback. The read owner discards this aborted response.
      if (options.signal?.aborted) return { error: 'Request cancelled.' };
      const msg = String(err?.message || '');
      if (/\bbusy\b|rate limit|too many/i.test(msg)) console.warn('[callApi] transient:', msg);
      else console.error(err);
      return { error: publicErrorMessage(err) };
    }
  }, [checkpointSaveBusy, markPipelineStep, currentWs, updateActiveWorkspace, rSessionId, datasetInfo, workflowContext, pipelineState]);

  const openProvenance = async (provId) => {
    const chain = await getProvenanceChain(provId);
    setDrawerChain(chain);
    setDrawerProvId(provId);
  };

  const clearAuthenticatedWorkspace = (notice = '') => {
    clearSubmissionRecovery();
    setLoggedOutNotice(notice);
    setUser(null);
    setAuthResolution('resolved');
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

  const handleLogout = async () => {
    const result = await window.electronAPI?.logout?.();
    if (result?.error) {
      setApiStatus(result.error);
      return;
    }
    clearAuthenticatedWorkspace(result?.warning || '');
  };

  // ── Workspace Persistence ───────────────────────────────────────
  // Legacy traceomics_ws_* localStorage keys are intentionally ignored here.
  // Backend projects and analysis-object rows are the authoritative workspace
  // model; localStorage only caches selected project/object IDs.
  // ────────────────────────────────────────────────────────────────

  // ── R Session / Pipeline Persistence ─────────────────────────────
  // Live R state is private and transient. A selected database object is never
  // treated as attached until the current R process confirms it.

  const verifiedRSessionRef = React.useRef(null);
  useEffect(() => {
    let active = true;
    setLiveRecoveryNotice('');
    if (!user?.email) {
      verifiedRSessionRef.current = null;
      setUnsavedLiveChanges(false);
      setSessionCheckDone(true);
      return undefined;
    }
    setSessionCheckDone(false);
    const savedSelection = consumeSavedObjectSelection(
      checkpointSaveOpenedObjectRef.current,
      datasetInfo?.id
    );
    checkpointSaveOpenedObjectRef.current = savedSelection.nextExpectedObjectId;
    if (!savedSelection.preserve) {
      checkpointSaveRequestRef.current += 1;
      setUnsavedLiveChanges(false);
      setCheckpointSaveState({ phase: 'idle', message: '', durableSaved: false });
    }
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
        if (!active || !data?.sessionId) return;
        const previous = verifiedRSessionRef.current;
        if (previous?.email === user.email && previous.sessionId !== data.sessionId) {
          setUnsavedLiveChanges(false);
          setCheckpointSaveState({ phase: 'idle', message: '', durableSaved: false });
        }
        verifiedRSessionRef.current = { email: user.email, sessionId: data.sessionId };
        setRSessionId(data.sessionId);
      })
      .catch(e => {
        if (!active) return;
        console.warn('[Session] R session probe failed:', e);
        setRSessionId(null);
        resetPipelineState();
      })
      .finally(() => { if (active) setSessionCheckDone(true); });
    return () => { active = false; };
  }, [user?.email, datasetInfo?.id, resetPipelineState, patchActiveWorkspace]);

  const pipelineProbeKeyRef = React.useRef(null);
  const pipelineProbeAttachedRef = React.useRef(false);
  const pipelineProbeAttemptsRef = React.useRef(0);
  const pipelineProbeAttemptsKeyRef = React.useRef(null);
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
    if (pipelineProbeAttemptsKeyRef.current !== key) {
      pipelineProbeAttemptsKeyRef.current = key;
      pipelineProbeAttemptsRef.current = 0;
    }
    if (pipelineProbeKeyRef.current !== key) pipelineProbeAttachedRef.current = false;
    pipelineProbeKeyRef.current = key;
    let active = true;
    let completed = false;
    window.electronAPI.apiRequest('/pipeline-state', {
      headers: { 'X-Object-ID': objectId }
    }).then(state => {
      if (!active) return;
      completed = true;
      // A transient proxy/R failure (e.g. HTTP 429 "R service is busy", a network
      // blip, or a temporarily unreachable backend) comes back as { error } — NOT
      // as an authoritative "object does not exist". Treat it as retryable and
      // leave the current attachment intact; detaching a live object on a transient
      // error wrongly tears down a working session. Only an explicit exists:false
      // from the backend detaches the object.
      if (state?.error) {
        pipelineProbeKeyRef.current = null;
        if (pipelineProbeAttemptsRef.current < PIPELINE_PROBE_MAX_RETRIES) {
          pipelineProbeAttemptsRef.current += 1;
          const delay = pipelineProbeRetryDelay(pipelineProbeAttemptsRef.current, Math.random() * 250);
          pipelineProbeRetryTimeoutRef.current = window.setTimeout(() => setPipelineProbeRetry(value => value + 1), delay);
        }
        return;
      }
      if (state?.exists === false) {
        pipelineProbeAttemptsRef.current = 0;
        pipelineProbeAttachedRef.current = false;
        setUnsavedLiveChanges(false);
        setLiveRecoveryNotice('Live analysis is unavailable. Restore a saved version to continue. Any unsaved changes from the previous R session are unavailable.');
        resetPipelineState();
        patchActiveWorkspace(ws => ({
          objects: ws.objects.map(object => object.id === objectId ? { ...object, liveState: 'not_attached' } : object),
        }));
        return;
      }
      if (state?.exists !== true) {
        pipelineProbeKeyRef.current = null;
        return;
      }
      pipelineProbeAttemptsRef.current = 0;
      pipelineProbeAttachedRef.current = true;
      setLiveRecoveryNotice('');
      const serverUnsaved = serverUnsavedLiveChanges(state);
      if (serverUnsaved !== null) setUnsavedLiveChanges(serverUnsaved);
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
        clusterDims: Number(state.cluster_dims) || Number(state.pca_dims) || 15,
      }));
    }).catch(() => {
      if (!active) return;
      completed = true;
      pipelineProbeKeyRef.current = null;
      if (pipelineProbeAttemptsRef.current < PIPELINE_PROBE_MAX_RETRIES) {
        pipelineProbeAttemptsRef.current += 1;
        const delay = pipelineProbeRetryDelay(pipelineProbeAttemptsRef.current, Math.random() * 250);
        pipelineProbeRetryTimeoutRef.current = window.setTimeout(() => setPipelineProbeRetry(value => value + 1), delay);
      }
    });
    // Clear a pending retry if the effect re-runs (dataset/session change) or the
    // component unmounts, so a stale timer can't fire a probe against the wrong
    // object/session after switching.
    return () => {
      active = false;
      if (!completed && pipelineProbeKeyRef.current === key) pipelineProbeKeyRef.current = null;
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

  if (!isLoggedIn && authResolution !== 'resolved') return (
    <div className="login-bg flex min-h-dvh items-center justify-center p-6 text-text">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
          <Microscope size={30} aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">TraceOmics</h1>
        {authResolution === 'checking' ? (
          <div role="status" className="mt-4 flex items-center justify-center gap-2 text-sm text-textMuted">
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
            Opening your workspace…
          </div>
        ) : (
          <div className="mt-4">
            <p role="alert" className="text-sm text-textMuted">We couldn’t check your session. Check your connection and try again.</p>
            <button type="button" className="btn btn-primary mt-5" onClick={() => setAuthRetry(value => value + 1)}>Retry</button>
          </div>
        )}
      </div>
    </div>
  );

  if (!isLoggedIn) return (
    <Login
      onLogin={(u) => {
        setLoggedOutNotice('');
        setUser(u || null);
        setAuthResolution('resolved');
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
      onNavigateToUmap: () => setActiveTab('umap'),
      historyRefreshToken,
      onExpertRSubmitted: () => setHistoryRefreshToken((token) => token + 1),
      computeStatus,
      unsavedLiveChanges,
      onSaveCurrentAnalysis: handleSaveLiveAnalysis,
      checkpointSaveBusy,
    };

    return (
      <div className="relative w-full h-full bg-background">
        {activeWorkflow && activeTab.startsWith('workflow:') && <div className="h-full overflow-auto"><ErrorBoundary key={activeWorkflow.id}>
          <WorkflowWorkbench instance={activeWorkflow} projectId={activeWorkflow.projectId} userId={user?.id} activeTab={activeTab}
            onUpdate={updateWorkflow} enabled={deploymentPolicy.expertREnabled === true}
            onExit={() => { setActiveWorkflow(null); setActiveTab('pipeline-manager'); }} />
        </ErrorBoundary></div>}
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
        <ErrorBoundary key="analyses"><TabContent id="analyses" activeTab={activeTab} contextKey={`${user?.id}:${activeProjectIdForPipeline}`}>
          <ResearchAnalyses
            userId={user?.id}
            projectId={activeProjectIdForPipeline}
            projectName={currentWs?.projects?.find(project => project.id === activeProjectIdForPipeline)?.name}
            role={currentWs?.projects?.find(project => project.id === activeProjectIdForPipeline)?.role}
            theme={theme}
            isActive={activeTab === 'analyses'}
            onOpenWorkspace={() => setActiveTab('workspace')}
            onOpenAdvanced={() => setActiveTab('expert-r')}
            onOpenOriginal={openOriginalObjectHistory}
          />
        </TabContent></ErrorBoundary>
        <ErrorBoundary key="pipeline-manager"><TabContent id="pipeline-manager" activeTab={activeTab}>
          <PipelineManager
            {...props}
            activePipeline={activePipeline}
            onPipelineSelectionChanged={handlePipelineSelectionChanged}
            onOpenWorkflow={instance => { if (workflowContext.active) { setActiveWorkflow(instance); setActiveTab(`workflow:${instance.package.tabs[0].id}`); } }}
            setActiveTab={setActiveTab}
            onSelectAnalysisObject={handleSelectAnalysisObject}
          />
        </TabContent></ErrorBoundary>
        <ErrorBoundary key="branches"><TabContent id="branches" activeTab={activeTab}><AnalysisBranches {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="study-design"><TabContent id="study-design" activeTab={activeTab}><StudyDesign {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="expert-r"><TabContent id="expert-r" activeTab={activeTab}><ExpertR {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="account"><TabContent id="account" activeTab={activeTab}>
          <AccountSecurity
            user={user}
            onPasswordChanged={(updatedUser) => setUser(updatedUser)}
            onSessionInvalid={(message) => clearAuthenticatedWorkspace(message || 'Sign in again to continue.')}
          />
        </TabContent></ErrorBoundary>
        <ErrorBoundary key="inspect"><TabContent id="inspect" activeTab={activeTab}><Inspect key={objKey} globalTab={activeTab} obj={datasetInfo} workspaceObjects={currentWs.objects} onSubsetCreated={handleSubsetCreated} userEmail={user?.email} parentSessionPath={null} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="lineage"><TabContent id="lineage" activeTab={activeTab}><LineageExplorer {...props} provenanceRecords={provenanceRecords} setProvenanceRecords={setProvenanceRecords} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="qc"><TabContent id="qc" activeTab={activeTab} contextKey={objKey}><QualityControl key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="normalize"><TabContent id="normalize" activeTab={activeTab} contextKey={objKey}><Normalization key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="pca"><TabContent id="pca" activeTab={activeTab} contextKey={objKey}><PCA key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="cluster"><TabContent id="cluster" activeTab={activeTab} contextKey={objKey}><Clustering key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="umap"><TabContent id="umap" activeTab={activeTab} contextKey={objKey}><UMAPView key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="featureplot"><TabContent id="featureplot" activeTab={activeTab} contextKey={objKey}><FeaturePlot key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="heatmap"><TabContent id="heatmap" activeTab={activeTab} contextKey={objKey}><HeatmapPlot key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="dotplot"><TabContent id="dotplot" activeTab={activeTab} contextKey={objKey}><DotPlot key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="explore"><TabContent id="explore" activeTab={activeTab} contextKey={objKey}><ExploratoryAnalysis key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="geneviewer"><TabContent id="geneviewer" activeTab={activeTab} contextKey={objKey}><GeneViewer key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="deg"><TabContent id="deg" activeTab={activeTab} contextKey={objKey}><DifferentialExpression key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="history"><TabContent id="history" activeTab={activeTab}><ProjectHistory {...props} refreshAnalysisObjects={refreshAnalysisObjects} onSelectAnalysisObject={handleSelectAnalysisObject} onLiveObjectAttached={handleLiveObjectAttached} setActiveTab={setActiveTab} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="enrichment"><TabContent id="enrichment" activeTab={activeTab} contextKey={objKey}><PathwayEnrichment key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="cellchat"><TabContent id="cellchat" activeTab={activeTab} contextKey={objKey}><CellChat key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="integrate"><TabContent id="integrate" activeTab={activeTab} contextKey={objKey}><BatchIntegration key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="publication"><TabContent id="publication" activeTab={activeTab}><Publication {...props} isActive={activeTab === 'publication'} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="validation"><TabContent id="validation" activeTab={activeTab}><Validation {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="team"><TabContent id="team" activeTab={activeTab}><Collaborators {...props} workspaces={workspaces} setWorkspaces={setWorkspaces} activeWsIndex={activeWsIndex} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="diagnostics"><TabContent id="diagnostics" activeTab={activeTab}><Diagnostics apiStatus={apiStatus} /></TabContent></ErrorBoundary>
      </div>
    );
  };

  return (
    <div className="flex flex-col sm:flex-row bg-background text-text overflow-hidden relative h-dvh w-screen">
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
        activeWorkflow={activeWorkflow}
        theme={theme}
        setTheme={setTheme}
        figuresCount={figuresCount}
        deploymentPolicy={deploymentPolicy}
      />
      <main className="flex-1 flex flex-col relative overflow-hidden min-h-0 min-w-0">
        <h1 className="sr-only">TraceOmics Workbench — {TAB_TITLES[activeTab] || 'Current view'}</h1>
        <ExecutionTargetIndicator deploymentPolicy={deploymentPolicy} userId={user?.id} projectId={activeProjectIdForPipeline} />
        <SubmissionRecoveryNotice userId={user?.id} projectId={activeProjectIdForPipeline} onOpen={() => setActiveTab('history')} />
        {historyPersistenceNotice && (
          <div role="alert" className="mx-4 mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-text">
            {historyPersistenceNotice}
            <button type="button" onClick={() => setHistoryPersistenceNotice('')} className="btn btn-secondary ml-2 text-xs">Dismiss history notice</button>
          </div>
        )}
        {liveRecoveryNotice && (
          <div role="status" className="shrink-0 border-b border-border bg-surface px-4 py-2 text-xs text-text">
            {liveRecoveryNotice}
            <button type="button" className="ml-2 font-bold underline" onClick={() => setActiveTab('history')}>Open Runs &amp; Results</button>
          </div>
        )}
        {(activeTab !== 'analyses' || unsavedLiveChanges || ['saving', 'opening', 'pending', 'error'].includes(checkpointSaveState.phase)) && <AnalysisStatusBar datasetInfo={datasetInfo} unsavedLiveChanges={unsavedLiveChanges}
          checkpointSaveState={checkpointSaveState} checkpointSaveBusy={checkpointSaveBusy}
          onSave={() => void handleSaveLiveAnalysis()} onOpenHistory={() => setActiveTab('history')} />}
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
