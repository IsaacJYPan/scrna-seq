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
import Annotation from './pages/Annotation';
import Enrichment from './pages/Enrichment';
import CellChat from './pages/CellChat';
import Publication from './pages/Publication';
import Validation from './pages/Validation';
import LineageExplorer from './pages/LineageExplorer';
import BatchIntegration from './pages/BatchIntegration';
import Collaborators from './pages/Collaborators';
import Inspect from './pages/Inspect';
import Diagnostics from './pages/Diagnostics';
import ProvenanceDrawer from './components/ProvenanceDrawer';

import {
  saveProvenance,
  loadPersistedProvenance,
  getProvenanceChain,
  makeCacheKey,
  getCachedResult,
  setCachedResult,
} from './provenance';

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
            <h2 className="text-xl font-bold text-white mb-2">Component Error</h2>
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
        <div className="text-6xl mb-6">{icon}</div>
        <h2 className="text-2xl font-black text-white mb-3 tracking-tight">{title}</h2>
        <p className="text-slate-400 text-sm leading-relaxed mb-6">{subtitle}</p>
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 border border-primary/20 rounded-full text-[10px] font-black text-primary uppercase tracking-widest">
          Coming Soon
        </div>
      </div>
    </div>
  );
}

const TabContent = ({ id, activeTab, children }) => (
  <div className={`absolute inset-0 ${activeTab === id ? 'block' : 'hidden'}`}>
    {children}
  </div>
);

export default function App() {
  const [activeTab, setActiveTab] = useState('workspace');

  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  useEffect(() => {
    localStorage.setItem('theme', theme);
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
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

  const [user, setUser] = useState({ email: 'researcher@lab.edu', displayName: 'Researcher' });
  const isLoggedIn = !!user;

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

  // Collaborative Multi-Workspace Management
  const [workspaces, setWorkspaces] = useState(() => {
    const defaultWs = [
      {
        id: 'ws-personal-1',
        name: 'Personal Workspace',
        projects: [{ id: 'proj-default', name: 'Default Project' }],
        objects: [],
        selectedObjectIds: [],
        activeBranch: 'main',
        branches: { 'main': null },
        collaborators: ['me@lab.edu'],
        type: 'personal',
        dataVersion: 0,
        annotVersion: 0
      },
      {
        id: 'ws-shared-1',
        name: 'Shared Laboratory',
        objects: [],
        selectedObjectIds: [],
        activeBranch: 'main',
        branches: { 'main': null },
        collaborators: ['researcher@lab.edu', 'pi@lab.edu'],
        type: 'shared',
        dataVersion: 0,
        annotVersion: 0
      }
    ];
    
    // Attempt synchronous initialization to avoid race condition with save-on-mount
    const wsStorageKey = 'benchone_ws_researcher@lab.edu'; // Since user is statically initialized to this
    try {
      const saved = localStorage.getItem(wsStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (!Array.isArray(parsed)) throw new Error('Invalid workspace data format');
        return defaultWs.map((ws, i) => {
          if (i >= parsed.length) return ws;
          const loadedProjects = parsed[i]?.projects ?? ws.projects;
          const loadedObjects = (parsed[i]?.objects ?? ws.objects).map(obj => ({
            ...obj,
            projectId: obj.projectId || loadedProjects[0]?.id || 'proj-default'
          }));
          return {
            ...ws,
            projects:          loadedProjects,
            objects:           loadedObjects,
            selectedObjectIds: parsed[i]?.selectedObjectIds ?? ws.selectedObjectIds,
            branches:          parsed[i]?.branches          ?? ws.branches,
            dataVersion:       parsed[i]?.dataVersion       ?? ws.dataVersion,
            lastSelectedByProject: parsed[i]?.lastSelectedByProject ?? ws.lastSelectedByProject,
          };
        });
      }
    } catch (e) {
      console.warn('[App] Failed to synchronous restore workspaces:', e);
    }
    return defaultWs;
  });
  const [activeWsIndex, setActiveWsIndex] = useState(0);

  const currentWs = workspaces[activeWsIndex];
  const selectedObjects = currentWs.objects.filter(obj => currentWs.selectedObjectIds?.includes(obj.id));
  const datasetInfo = selectedObjects.length > 0 ? selectedObjects[0] : (currentWs.objects[0] || null);
  const currentProvId = currentWs.branches[currentWs.activeBranch];

  const [apiStatus, setApiStatus] = useState('checking');
  const [provenanceRecords, setProvenanceRecords] = useState([]);
  const [drawerProvId, setDrawerProvId] = useState(null);
  const [drawerChain, setDrawerChain] = useState(null);
  // R process session ID — changes on every restart, busting the pipeline cache
  // so that all stateful steps re-execute in R and rebuild global_obj.
  const [rSessionId, setRSessionId] = useState(null);
  const sessionReady = sessionCheckDone && !!rSessionId;
  // Mutable ref always pointing to the current user+object RDS path.
  // Used inside callApi (which is a stale closure) to avoid dependency issues.
  const sessionPathRef = React.useRef(null);

  useEffect(() => {
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
      .then(data => setApiStatus(`Connected (${data.mode})`))
      .catch(() => setApiStatus('Disconnected'));
  }, []);

  const updateActiveWorkspace = useCallback((updates) => {
    setWorkspaces(prev => {
      const copy = [...prev];
      copy[activeWsIndex] = { ...copy[activeWsIndex], ...updates };
      return copy;
    });
  }, [activeWsIndex]);

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

  const handleSubsetCreated = useCallback((data, newName) => {
    const parentObj = currentWs.objects.find(o => o.id === datasetInfo?.id);
    const projId = parentObj?.projectId || currentWs.projects?.[0]?.id || 'proj-default';
    
    const existingNames = currentWs.objects.filter(o => o.projectId === projId).map(o => o.name);
    let finalName = newName.trim() || 'Subset';
    let counter = 1;
    while (existingNames.includes(finalName)) {
      finalName = `${newName.trim() || 'Subset'} (${counter})`;
      counter++;
    }
    
    const newObj = {
      id: data.newId || `obj-${crypto.randomUUID()}`,
      projectId: projId,
      name: finalName,
      ...data.result,
      timestamp: new Date().toISOString(),
      isSubset: true,
      parentObjId: datasetInfo?.id ?? null,
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

    // 3. No need to call /save-session here anymore because the /subset call 
    // already persisted the child to disk non-destructively.
  }, [activeWsIndex, currentWs, datasetInfo, user?.email]);

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
          // Immediately persist the R object so a session restore finds it.
          // Firing here (inside callApi, not a useEffect) means the save is
          // in-flight before any UI re-render and can't be raced by app-close.
          if (sessionPathRef.current) {
            window.electronAPI.apiRequest('/save-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: sessionPathRef.current }) })
              .catch(e => console.warn('[Session] Auto-save failed:', e));
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
  }, [activeWsIndex, workspaces, markPipelineStep, currentWs, updateActiveWorkspace, rSessionId]);

  const openProvenance = async (provId) => {
    const chain = await getProvenanceChain(provId);
    setDrawerChain(chain);
    setDrawerProvId(provId);
  };

  const handleLogout = () => {
    setUser(null);
  };

  // ── Workspace Persistence ───────────────────────────────────────
  // Save/restore the objects array (workspace card metadata) between sessions.
  // The R session is stateless across restarts so the user still needs to
  // re-run the pipeline, but the workspace card (name, cells, features) persists.
  const wsStorageKey = user?.email ? `benchone_ws_${user.email}` : null;



  // Save on any workspace change
  useEffect(() => {
    if (!wsStorageKey) return;
    try {
      const toSave = workspaces.map(ws => ({
        projects:          ws.projects,
        objects:           ws.objects,
        selectedObjectIds: ws.selectedObjectIds,
        branches:          ws.branches,
        dataVersion:       ws.dataVersion,
        lastSelectedByProject: ws.lastSelectedByProject,
      }));
      localStorage.setItem(wsStorageKey, JSON.stringify(toSave));
    } catch (e) {
      console.warn('[App] Failed to save workspaces:', e);
    }
  }, [workspaces, wsStorageKey]);
  // ────────────────────────────────────────────────────────────────

  // ── R Session / Pipeline Persistence ─────────────────────────────
  // Strategy: after each pipeline step R saves global_obj as an RDS.
  // The companion JSON stores the session ID. On next login, we restore
  // the RDS *and* the session ID, so the SQLite result cache remains
  // valid and all pipeline tabs hydrate from cache (no re-running needed).

  const sanitizeEmail = (email) => email.replace(/[^a-zA-Z0-9]/g, '_');
  const getSessionPath = (email, objId) =>
    email && objId ? `vault/${sanitizeEmail(email)}/${objId}.rds` : null;

  // Track the currently restored object ID (avoid re-firing if React re-renders)
  const currentlyRestoredObjectRef = React.useRef(null);

  // 0. Keep sessionPathRef in sync so callApi can always find the save path
  useEffect(() => {
    sessionPathRef.current = user?.email && datasetInfo?.id
      ? getSessionPath(user.email, datasetInfo.id)
      : null;
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
    window.electronAPI.apiRequest('/check-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
      .then(d => {
        if (!d.exists) {
          console.log('[Vault] No stored object found — initializing fresh state.');
          return window.electronAPI.apiRequest('/session-id').then(data => {
            if (data.sessionId) setRSessionId(data.sessionId);
            resetPipelineState();
          });
        }
        console.log('[Vault] Found stored object, restoring state…');
        return window.electronAPI.apiRequest('/restore-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
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



  // 3. Recalculate pipeline state when active node (currentProvId) changes
  useEffect(() => {
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
  }, [currentProvId, provenanceRecords]);
  // ────────────────────────────────────────────────────────────────

  if (!isLoggedIn) return <Login onLogin={(u) => setUser(u || { email: 'researcher@lab.edu', displayName: 'Researcher' })} />;

  const handleDataVersionChange = (fn) => {
    updateActiveWorkspace({ dataVersion: (typeof fn === 'function' ? fn(currentWs.dataVersion) : fn) });
  };

  const renderContent = () => {
    const objKey = datasetInfo?.id ?? 'none';
    const getLatestId = (op) => provenanceRecords.find(r => r.operation === op)?.id;

    const activeProjectId = datasetInfo?.projectId || currentWs.projects?.[0]?.id || 'proj-default';
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
      pipelineState,
      theme,
      rSessionId,          // let components watch session changes directly
      sessionReady,        // gate: true only after R session restore completes
      resetPipelineAfterSubset,
      // For per-object parameter persistence
      userEmail: user?.email ?? null,
      objectId: datasetInfo?.id ?? null,
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
          />
        </TabContent></ErrorBoundary>
        <ErrorBoundary key="inspect"><TabContent id="inspect" activeTab={activeTab}><Inspect key={objKey} globalTab={activeTab} obj={datasetInfo} workspaceObjects={currentWs.objects} onSubsetCreated={handleSubsetCreated} userEmail={user?.email} parentSessionPath={user?.email && datasetInfo?.id ? `vault/${user.email.replace(/[^a-zA-Z0-9]/g, '_')}/${datasetInfo.id}.rds` : null} {...props} /></TabContent></ErrorBoundary>
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
        <ErrorBoundary key="annotate"><TabContent id="annotate" activeTab={activeTab}><Annotation key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="enrichment"><TabContent id="enrichment" activeTab={activeTab}><Enrichment key={objKey} {...props} /></TabContent></ErrorBoundary>
        <ErrorBoundary key="cellchat"><TabContent id="cellchat" activeTab={activeTab}><CellChat {...props} /></TabContent></ErrorBoundary>
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
        theme={theme}
        setTheme={setTheme}
        figuresCount={figuresCount}
      />
      <main className="flex-1 flex flex-col relative overflow-hidden h-full overflow-y-auto custom-scrollbar">
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
