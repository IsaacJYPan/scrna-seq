import React, { useEffect, useState } from 'react';
import {
  Activity, Archive, BarChart3, CheckCircle2, ChevronDown, ChevronLeft,
  CircleDot, Clipboard as ClipboardList, Database, FileText, GitBranch,
  Grid3x3, Layers, LayoutPanelTop, Lock, LogOut, Menu, MessageSquare,
  Microscope, Moon, Network, ScatterChart, Search, Sparkles, Sun,
  Terminal, Users, Wrench,
} from 'lucide-react';

export default function Sidebar({
  activeTab,
  setActiveTab,
  apiStatus,
  workspaces = [],
  setWorkspaces,
  activeWsIndex = 0,
  setActiveWsIndex,
  selectedObjects = [],
  user,
  onLogout,
  pipelineState = {},
  theme = 'dark',
  setTheme,
  figuresCount = 0,
}) {
  const [isCollapsed, setIsCollapsed] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 900 : false
  ));

  useEffect(() => {
    const collapseForNarrowViewport = () => {
      if (window.innerWidth < 900) setIsCollapsed(true);
    };
    collapseForNarrowViewport();
    window.addEventListener('resize', collapseForNarrowViewport);
    return () => window.removeEventListener('resize', collapseForNarrowViewport);
  }, []);

  const collapseAfterMobileNavigation = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 900) {
      setIsCollapsed(true);
    }
  };

  const personalWs = workspaces.filter(ws => ws.type === 'personal');
  const sharedWs = workspaces.filter(ws => ws.type === 'shared');
  const currentWorkspace = workspaces[activeWsIndex];
  const hasData = selectedObjects.length > 0;
  const hasProject = !!currentWorkspace?.selectedProjectId || (currentWorkspace?.projects || []).length > 0;
  const backendConnected = typeof apiStatus === 'string' && /connected/i.test(apiStatus) && !/disconnected/i.test(apiStatus);

  const pipelineItems = [
    { id: 'qc', label: 'Quality Control', icon: Activity, done: pipelineState.qc },
    { id: 'normalize', label: 'Normalize', icon: Sparkles, done: pipelineState.normalize },
    { id: 'integrate', label: 'Integration', icon: Layers, done: pipelineState.integrate, status: 'Optional live-R' },
    { id: 'pca', label: 'PCA', icon: BarChart3, done: pipelineState.pca },
    { id: 'cluster', label: 'Cluster', icon: Network, done: pipelineState.cluster },
    { id: 'umap', label: 'UMAP', icon: Layers, done: pipelineState.umap },
  ];

  const exploreItems = [
    { id: 'featureplot', label: 'Feature Plot', icon: ScatterChart },
    { id: 'geneviewer', label: 'Gene Expression', icon: BarChart3 },
    { id: 'heatmap', label: 'Heatmap', icon: Grid3x3 },
    { id: 'dotplot', label: 'Dot Plot', icon: CircleDot },
  ];

  const markerItems = [
    { id: 'deg', label: 'Markers / DEG', icon: FileText, status: 'Durable worker' },
    { id: 'annotate', label: 'Cell Annotation', icon: Sparkles, disabled: true, status: 'Not integrated' },
    { id: 'enrichment', label: 'Pathway Enrichment', icon: Microscope, disabled: true, status: 'Future workflow' },
    { id: 'cellchat', label: 'CellChat', icon: MessageSquare, disabled: true, status: 'Future workflow' },
    { id: 'customscript', label: 'Custom Script', icon: Terminal, disabled: true, status: 'Disabled' },
  ];

  const historyItems = [
    { id: 'history', label: 'Jobs & Artifacts', icon: Archive, status: 'Read-only' },
    { id: 'lineage', label: 'Session DAG', icon: GitBranch, status: 'Transient live-R' },
  ];

  const reportItems = [
    { id: 'publication', label: 'Reports / Export', icon: LayoutPanelTop, status: 'Figures only' },
    { id: 'validation', label: 'Validation', icon: ClipboardList },
    { id: 'reports-future', label: 'Full Reports', icon: FileText, disabled: true, status: 'Future workflow' },
  ];

  const handleAddWorkspace = () => {
    if (!setWorkspaces || !setActiveWsIndex) return;
    const newWs = {
      id: `ws-${Date.now()}`,
      name: `New Workspace ${workspaces.length}`,
      projects: [],
      objects: [],
      selectedProjectId: null,
      selectedObjectIds: [],
      activeBranch: 'main',
      branches: { main: null },
      collaborators: [],
      type: 'personal',
      dataVersion: 0,
    };
    setWorkspaces([...workspaces, newWs]);
    setActiveWsIndex(workspaces.length);
  };

  const NavButton = ({ item, disabled = false }) => {
    const Icon = item.icon;
    const isActive = activeTab === item.id;
    const isDisabled = disabled || item.disabled;
    return (
      <button
        onClick={() => {
          if (isDisabled) return;
          setActiveTab(item.id);
          collapseAfterMobileNavigation();
        }}
        disabled={isDisabled}
        title={item.status || item.label}
        aria-label={item.status ? `${item.label}, ${item.status}` : item.label}
        className={`w-full flex items-center gap-3 px-3 py-[7px] rounded border text-[15px] font-medium transition-colors group
          ${isDisabled ? 'opacity-45 cursor-not-allowed' : ''}
          ${isActive
            ? 'border-primary/30 bg-primary/10 text-text dark:border-slate-600 dark:bg-slate-700'
            : 'border-transparent text-textMuted hover:bg-black/5 dark:hover:bg-slate-700 hover:text-text'
          }
        `}
      >
        <Icon size={18} className={`${isActive ? 'text-primary' : 'text-slate-400'} group-hover:text-text flex-shrink-0`} />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">{item.label}</span>
          {item.status && (
            <span className="mt-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200">
              <Lock size={10} />
              {item.status}
            </span>
          )}
        </span>
        {item.id === 'publication' && figuresCount > 0 && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded text-text bg-blue-500/10 border border-blue-500/20">
            {figuresCount}
          </span>
        )}
        {item.done && <CheckCircle2 size={14} className="text-success flex-shrink-0" />}
      </button>
    );
  };

  const SectionLabel = ({ children }) => (
    <div className="px-2 mb-1">
      <h3 className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
        <ChevronDown size={12} className="opacity-70" />
        {children}
      </h3>
    </div>
  );

  const WorkspaceButton = ({ ws, demo = false }) => {
    const i = workspaces.indexOf(ws);
    const isActive = activeWsIndex === i;
    const initials = ws.name.substring(0, 2).toUpperCase();
    return (
      <div key={ws.id} className="relative group w-full flex justify-center">
        <div className={`absolute left-0 w-[4px] bg-white rounded-r-lg transition-all duration-300 ${isActive ? 'h-10 top-1' : 'h-0 top-6 group-hover:h-5 group-hover:top-3.5'}`} />
        <button
          onClick={() => { setActiveWsIndex?.(i); setIsCollapsed(false); }}
          aria-label={demo ? `Switch to demo workspace ${ws.name}` : `Switch to ${ws.name}`}
          title={demo ? `${ws.name} demo shell, not project RBAC` : ws.name}
          className={`w-12 h-12 flex items-center justify-center text-[15px] font-black transition-all duration-200 relative group-hover:rounded-[16px] group-hover:bg-primary group-hover:text-white
            ${isActive ? 'rounded-[16px] bg-primary text-white shadow-lg' : 'rounded-[24px] bg-black/5 dark:bg-slate-800 text-text'}
          `}
        >
          {initials}
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-shrink-0 z-20 shadow-2xl relative w-[72px] lg:w-auto">
      <nav className="w-[72px] bg-background flex flex-col items-center py-3 gap-2 h-full flex-shrink-0">
        <div className="w-12 h-12 rounded-[24px] bg-primary flex items-center justify-center shadow-lg shadow-black/50 mb-1 hover:rounded-[16px] transition-all duration-200 cursor-pointer" title="BenchOne">
          <Microscope size={22} className="text-on-accent" />
        </div>

        {isCollapsed && (
          <button
            type="button"
            onClick={() => setIsCollapsed(false)}
            aria-label="Expand sidebar"
            className="w-12 h-8 rounded-md bg-surface border border-border text-textMuted hover:bg-black/5 hover:text-text dark:hover:bg-slate-700 transition-colors flex items-center justify-center shadow-sm"
            title="Expand sidebar"
          >
            <Menu size={16} />
          </button>
        )}

        <div className="w-8 h-0.5 bg-black/10 dark:bg-slate-800 rounded-full my-1" />

        <div className="flex-1 w-full overflow-y-auto no-scrollbar flex flex-col items-center gap-2">
          {personalWs.map(ws => <WorkspaceButton key={ws.id} ws={ws} />)}

          {sharedWs.length > 0 && <div className="w-8 h-0.5 bg-black/10 dark:bg-slate-800 rounded-full my-1" />}
          {sharedWs.map(ws => <WorkspaceButton key={ws.id} ws={ws} demo />)}

          <div className="relative group w-full flex justify-center mt-2">
            <button
              onClick={handleAddWorkspace}
              aria-label="Create new local workspace"
              className="w-12 h-12 rounded-[24px] bg-black/5 dark:bg-slate-800 flex items-center justify-center text-success hover:bg-success hover:text-white hover:rounded-[16px] transition-all duration-200 shadow-sm"
              title="Create local workspace shell"
            >
              <span className="text-3xl font-light mb-1">+</span>
            </button>
          </div>
        </div>

        {user && (
          <div className="mt-auto mb-2 w-full flex flex-col items-center gap-2 group relative">
            <button
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="w-12 h-12 rounded-[24px] bg-transparent hover:bg-slate-700 hover:rounded-[16px] transition-all duration-200 flex items-center justify-center text-slate-400 hover:text-white"
              onClick={() => setTheme?.(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {theme === 'dark' ? <Moon size={20} /> : <Sun size={20} />}
            </button>
            <button
              aria-label="Log out"
              className="w-12 h-12 rounded-[24px] bg-transparent hover:bg-danger hover:rounded-[16px] transition-all duration-200 flex items-center justify-center text-slate-400 hover:text-white"
              onClick={onLogout}
              title="Log Out"
            >
              <LogOut size={20} className="ml-0.5" />
            </button>
          </div>
        )}
      </nav>

      <aside className={`bg-surface flex flex-col h-full select-none transition-all duration-300 overflow-hidden ${isCollapsed ? 'w-0 opacity-0 pointer-events-none' : 'absolute left-[72px] top-0 z-40 w-[calc(100vw-72px)] max-w-60 opacity-100 shadow-2xl lg:static lg:left-auto lg:top-auto lg:z-auto lg:w-60 lg:max-w-none'}`}>
        <button
          type="button"
          aria-label="Collapse sidebar"
          className="h-12 w-full flex items-center px-4 shadow-sm border-b border-border hover:bg-slate-700 transition-colors cursor-pointer group text-left"
          onClick={() => setIsCollapsed(true)}
        >
          <span className="text-[15px] font-black text-slate-100 truncate flex-1 leading-none">{currentWorkspace?.name || 'BenchOne'}</span>
          <ChevronLeft size={18} className="text-slate-400 group-hover:text-text" />
        </button>

        <div className="flex-1 overflow-y-auto px-2 py-4 space-y-5 custom-scrollbar">
          <div className="space-y-[2px]">
            <SectionLabel>Project</SectionLabel>
            <NavButton item={{ id: 'workspace', label: 'Workbench', icon: Database, status: hasProject ? 'Backend project' : 'Select project' }} />
            <div className="pt-3">
              <SectionLabel>Data / Object</SectionLabel>
              <NavButton item={{ id: 'inspect', label: 'Inspect', icon: Search }} disabled={!hasData} />
            </div>
          </div>

          <div className="space-y-[2px]">
            <SectionLabel>Live R Pipeline</SectionLabel>
            {pipelineItems.map(item => (
              <NavButton key={item.id} item={item} disabled={!hasData} />
            ))}
          </div>

          <div className="space-y-[2px]">
            <SectionLabel>Explore</SectionLabel>
            {exploreItems.map(item => (
              <NavButton key={item.id} item={item} disabled={!hasData} />
            ))}
          </div>

          <div className="space-y-[2px]">
            <SectionLabel>Markers</SectionLabel>
            {markerItems.map(item => (
              <NavButton key={item.id} item={item} disabled={!hasData} />
            ))}
          </div>

          <div className="space-y-[2px]">
            <SectionLabel>Durable History</SectionLabel>
            {historyItems.map(item => (
              <NavButton key={item.id} item={item} disabled={item.id === 'history' ? !hasProject : false} />
            ))}
          </div>

          <div className="space-y-[2px]">
            <SectionLabel>Reports / Export</SectionLabel>
            {reportItems.map(item => (
              <NavButton key={item.id} item={item} disabled={item.id === 'validation' ? !hasData : false} />
            ))}
          </div>

          {currentWorkspace?.type === 'shared' && (
            <div className="pt-2 border-t border-border/50">
              <NavButton item={{ id: 'team', label: 'Collaborators', icon: Users, status: 'Demo only' }} />
            </div>
          )}
        </div>

        <div
          className="h-14 bg-black/5 dark:bg-[black] mt-auto flex items-center px-4 gap-3 select-none shrink-0 cursor-pointer hover:bg-slate-800 transition-colors"
          onClick={() => setActiveTab('diagnostics')}
          title="Open Diagnostics & Environment"
        >
          <div className="flex flex-col justify-center min-w-0 pr-2 pb-0.5 flex-1">
            <div className="flex items-center gap-1.5 mb-[2px]">
              <div className={`w-2.5 h-2.5 rounded-full border border-black dark:border-white shadow-sm ${backendConnected ? 'bg-success' : 'animate-pulse bg-danger'}`} />
              <span className="text-[13px] font-bold text-text truncate leading-none mt-1">{backendConnected ? 'Backend connected' : 'Backend offline'}</span>
            </div>
            <span className="text-[11px] text-slate-400 truncate leading-none">{apiStatus || 'Connection lost'}</span>
          </div>
          <Wrench size={16} className="text-slate-400" />
        </div>
      </aside>
    </div>
  );
}
