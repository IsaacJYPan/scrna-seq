import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import Workspace from './pages/Workspace';
import QualityControl from './pages/QualityControl';
import Normalization from './pages/Normalization';
import PCA from './pages/PCA';
import Clustering from './pages/Clustering';
import UMAPView from './pages/UMAPView';
import GeneViewer from './pages/GeneViewer';
import DifferentialExpression from './pages/DifferentialExpression';
import Enrichment from './pages/Enrichment';
import CellChat from './pages/CellChat';
import Publication from './pages/Publication';
import Validation from './pages/Validation';
import LineageExplorer from './pages/LineageExplorer';
import BatchIntegration from './pages/BatchIntegration';
import Collaborators from './pages/Collaborators';
import ProvenanceDrawer from './components/ProvenanceDrawer';

import {
  saveProvenance,
  loadPersistedProvenance,
  getProvenanceChain,
  makeCacheKey,
  getCachedResult,
  setCachedResult,
} from './provenance';

const API = 'http://localhost:8000';

// Pipeline step ordering — used for downstream invalidation
const PIPELINE_ORDER = ['qc', 'normalize', 'pca', 'cluster', 'umap'];

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
            <pre className="text-xs text-slate-600 bg-black/30 p-3 rounded-lg overflow-auto max-h-32 text-left mb-4">{this.state.error?.stack?.split('\n').slice(0, 5).join('\n')}</pre>
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
    pca: false,
    cluster: false,
    umap: false,
    clusterCount: 0 // track for UMAP mock data
  });

  // Collaborative Multi-Workspace Management
  const [workspaces, setWorkspaces] = useState([
    {
      id: 'ws-personal-1',
      name: 'Personal Workspace',
      objects: [],
      selectedObjectIds: [],
      activeBranch: 'main',
      branches: { 'main': null },
      collaborators: ['me@lab.edu'],
      type: 'personal',
      dataVersion: 0
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
      dataVersion: 0
    }
  ]);
  const [activeWsIndex, setActiveWsIndex] = useState(0);

  const currentWs = workspaces[activeWsIndex];
  const selectedObjects = currentWs.objects.filter(obj => currentWs.selectedObjectIds?.includes(obj.id));
  const datasetInfo = selectedObjects.length > 0 ? selectedObjects[0] : (currentWs.objects[0] || null);
  const currentProvId = currentWs.branches[currentWs.activeBranch];

  const [apiStatus, setApiStatus] = useState('checking');
  const [provenanceRecords, setProvenanceRecords] = useState([]);
  const [drawerProvId, setDrawerProvId] = useState(null);
  const [drawerChain, setDrawerChain] = useState(null);

  useEffect(() => {
    loadPersistedProvenance().then(records => {
      if (records.length > 0) setProvenanceRecords(records);
    });
    fetch(`${API}/health`)
      .then(r => r.json())
      .then(data => setApiStatus(`Connected (${data.mode})`))
      .catch(() => setApiStatus('Disconnected'));
  }, []);

  const updateActiveWorkspace = (updates) => {
    setWorkspaces(prev => {
      const copy = [...prev];
      copy[activeWsIndex] = { ...copy[activeWsIndex], ...updates };
      return copy;
    });
  };

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

    if (forceOnlyIfCached) return null;

    // 1. Check Cache First
    if (useCache && cacheParams) {
      const key = await makeCacheKey(operation, cacheParams, currentWs.dataVersion);
      const cached = await getCachedResult(key);
      if (cached) {
        const prov = await (window.electronAPI?.getProvenance?.(cached.provenanceId));
        if (prov) {
          // [PATCH] Update pipeline state even for cached results
          if (step) {
            const extraState = {};
            if (step === 'cluster' && cached.result?.n_clusters) {
              extraState.clusterCount = cached.result.n_clusters;
            }
            markPipelineStep(step, extraState);
          }
          return {
            provenance: { ...prov, parentIds: prov.parentIds || parentIds },
            result: cached.result,
            _fromCache: true,
          };
        }
      }
    }

    if (onlyIfCached) return null;
    if (forceOnlyIfCached) return null;

    // 2. Fresh Fetch
    try {
      const res = await fetch(`${API}${path}`, options);
      const data = await res.json();
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
          if (step === 'cluster' && data.result?.n_clusters) {
            extraState.clusterCount = data.result.n_clusters;
          }
          markPipelineStep(step, extraState);
        }

        if (useCache && cacheParams) {
          const key = await makeCacheKey(operation, cacheParams, currentWs.dataVersion);
          await setCachedResult(key, data.provenance.id, data.result);
        }
      }
      return data;
    } catch (err) {
      console.error(err);
      return null;
    }
  }, [activeWsIndex, workspaces, markPipelineStep, currentWs, updateActiveWorkspace]);

  const openProvenance = async (provId) => {
    const chain = await getProvenanceChain(provId);
    setDrawerChain(chain);
    setDrawerProvId(provId);
  };

  const [user, setUser] = useState(null);
  const isLoggedIn = !!user;

  const handleLogout = () => {
    setUser(null);
  };

  if (!isLoggedIn) return <Login onLogin={(u) => setUser(u || { email: 'researcher@lab.edu', displayName: 'Researcher' })} />;

  const handleDataVersionChange = (fn) => {
    updateActiveWorkspace({ dataVersion: (typeof fn === 'function' ? fn(currentWs.dataVersion) : fn) });
  };

  const renderContent = () => {
    const props = {
      callApi,
      datasetInfo,
      selectedObjects,
      currentProvId,
      openProvenance,
      currentWs,
      updateActiveWorkspace,
      pipelineState,
      theme
    };

    return (
      <div className="relative w-full h-full bg-background">
        <ErrorBoundary>
          <TabContent id="workspace" activeTab={activeTab}>
            <Workspace
              {...props}
              setDataVersion={handleDataVersionChange}
              workspaces={workspaces}
              setWorkspaces={setWorkspaces}
              activeWsIndex={activeWsIndex}
              setActiveWsIndex={setActiveWsIndex}
            />
          </TabContent>
          <TabContent id="lineage" activeTab={activeTab}><LineageExplorer {...props} provenanceRecords={provenanceRecords} /></TabContent>
          <TabContent id="qc" activeTab={activeTab}><QualityControl {...props} /></TabContent>
          <TabContent id="normalize" activeTab={activeTab}><Normalization {...props} /></TabContent>
          <TabContent id="pca" activeTab={activeTab}><PCA {...props} /></TabContent>
          <TabContent id="cluster" activeTab={activeTab}><Clustering {...props} /></TabContent>
          <TabContent id="umap" activeTab={activeTab}><UMAPView {...props} /></TabContent>
          <TabContent id="geneviewer" activeTab={activeTab}><GeneViewer datasetInfo={datasetInfo} /></TabContent>
          <TabContent id="deg" activeTab={activeTab}><DifferentialExpression {...props} /></TabContent>
          <TabContent id="enrichment" activeTab={activeTab}><Enrichment {...props} /></TabContent>
          <TabContent id="cellchat" activeTab={activeTab}><CellChat {...props} /></TabContent>
          <TabContent id="multimodal" activeTab={activeTab}><BatchIntegration datasetInfo={datasetInfo} /></TabContent>
          <TabContent id="publication" activeTab={activeTab}><Publication {...props} /></TabContent>
          <TabContent id="validation" activeTab={activeTab}><Validation {...props} /></TabContent>
          <TabContent id="team" activeTab={activeTab}><Collaborators {...props} workspaces={workspaces} setWorkspaces={setWorkspaces} activeWsIndex={activeWsIndex} /></TabContent>
        </ErrorBoundary>
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
