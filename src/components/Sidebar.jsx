import React, { useState } from 'react';
import { 
  Database, Activity, LayoutGrid, MessageSquare, FileText, 
  Microscope, Clock as History, 
  LayoutPanelTop, Clipboard as ClipboardList, ChevronDown,
  Users, ChevronLeft, Menu, LogOut, BarChart3, Sparkles, Network, Layers, ShieldCheck,
  CheckCircle2, Circle, Moon, Sun, Search, ScatterChart, Grid3x3, CircleDot, ImageIcon, Wrench, Lock, Loader2, Terminal
} from 'lucide-react';

export default function Sidebar({ 
  activeTab, 
  setActiveTab, 
  apiStatus, 
  records, 
  currentProvId, 
  openProvenance,
  workspaces,
  setWorkspaces,
  activeWsIndex,
  setActiveWsIndex,
  selectedObjects,
  user,
  onLogout,
  pipelineState,
  theme,
  setTheme,
  figuresCount
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const personalWs = workspaces.filter(ws => ws.type === 'personal');
  const sharedWs = workspaces.filter(ws => ws.type === 'shared');
  const currentWorkspace = workspaces[activeWsIndex];
  const hasData = selectedObjects && selectedObjects.length > 0;
  const backendConnected = typeof apiStatus === 'string' && /connected/i.test(apiStatus) && !/disconnected/i.test(apiStatus);

  // Pipeline steps — ordered, gated
  const pipelineItems = [
    { id: 'qc',        label: 'Quality Control', icon: Activity, done: pipelineState?.qc },
    { id: 'normalize', label: 'Normalization',   icon: Sparkles, done: pipelineState?.normalize },
    { id: 'integrate', label: 'Integration',     icon: Layers,   done: pipelineState?.integrate },
    { id: 'pca',       label: 'PCA',             icon: BarChart3, done: pipelineState?.pca },
    { id: 'cluster',   label: 'Clustering',      icon: Network,  done: pipelineState?.cluster },
  ];

  // Plot modules — require UMAP / clustering
  const plotItems = [
    { id: 'umap',        label: 'UMAP',          icon: Layers,      done: pipelineState?.umap },
    { id: 'featureplot', label: 'Feature Plot',  icon: ScatterChart },
    { id: 'heatmap',     label: 'Heatmap',       icon: Grid3x3 },
    { id: 'dotplot',     label: 'Dot Plot',      icon: CircleDot },
  ];

  // Analysis modules
  const analysisItems = [
    { id: 'geneviewer', label: 'Gene Expression', icon: BarChart3 },
    { id: 'deg', label: 'Differential Expression', icon: FileText },
    { id: 'annotate', label: 'Cell Annotation', icon: Sparkles, disabled: true, status: 'Not implemented yet' },
    { id: 'enrichment', label: 'Pathway Enrichment', icon: Microscope, disabled: true, status: 'Coming later' },
    { id: 'cellchat', label: 'CellChat', icon: MessageSquare, disabled: true, status: 'Coming later' },
    { id: 'customscript', label: 'Custom Script', icon: Terminal, disabled: true, status: 'Disabled' },
  ];

  // Output modules
  const outputItems = [
    { id: 'publication', label: 'Figures', icon: LayoutPanelTop },
    { id: 'validation', label: 'Validation', icon: ClipboardList },
  ];

  const handleAddWorkspace = () => {
    if (!setWorkspaces) return;
    const newWs = {
      id: `ws-${Date.now()}`,
      name: `New Workspace ${workspaces.length}`,
      projects: [{ id: `proj-${Date.now()}`, name: 'Default Project' }],
      objects: [],
      selectedObjectIds: [],
      activeBranch: 'main',
      branches: { 'main': null },
      collaborators: [],
      type: 'personal',
      dataVersion: 0
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
        onClick={() => !isDisabled && setActiveTab(item.id)}
        disabled={isDisabled}
        title={item.status || item.label}
        className={`w-full flex items-center gap-3 px-3 py-[7px] rounded text-[15px] font-medium transition-colors group
          ${isDisabled ? 'opacity-45 cursor-not-allowed' : ''}
          ${isActive 
            ? 'bg-black/5 dark:bg-slate-700 text-text' 
            : 'text-textMuted hover:bg-black/5 dark:hover:bg-slate-700 hover:text-text'
          }
        `}
      >
        <Icon size={18} className={`${isActive ? 'text-primary' : 'text-slate-400'} group-hover:text-slate-200 flex-shrink-0`} />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">{item.label}</span>
          {item.status && (
            <span className="mt-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-slate-400">
              <Lock size={10} />
              {item.status}
            </span>
          )}
        </span>
        {item.id === 'publication' && figuresCount > 0 && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded text-blue-700 dark:text-blue-300 bg-blue-500/10 border border-blue-500/20">
            {figuresCount}
          </span>
        )}
        {item.done && <CheckCircle2 size={14} className="text-success flex-shrink-0" />}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-shrink-0 z-20 shadow-2xl relative">
      {/* Discord-style Far-Left Server Rail */}
      <nav className="w-[72px] bg-background flex flex-col items-center py-3 gap-2 h-full flex-shrink-0">
        <div className="w-12 h-12 rounded-[24px] bg-primary flex items-center justify-center shadow-lg shadow-black/50 mb-1 hover:rounded-[16px] transition-all duration-200 cursor-pointer">
           <span className="text-white text-xl font-black tracking-tighter">sc</span>
        </div>
        
        <div className="w-8 h-0.5 bg-black/10 dark:bg-slate-800 rounded-full my-1"></div>

        <div className="flex-1 w-full overflow-y-auto no-scrollbar flex flex-col items-center gap-2">
          {personalWs.map((ws) => {
            const i = workspaces.indexOf(ws);
            const isActive = activeWsIndex === i;
            const initials = ws.name.substring(0, 2).toUpperCase();
            return (
              <div key={ws.id} className="relative group w-full flex justify-center">
                <div className={`absolute left-0 w-[4px] bg-white rounded-r-lg transition-all duration-300 ${isActive ? 'h-10 top-1' : 'h-0 top-6 group-hover:h-5 group-hover:top-3.5'}`}></div>
                <button 
                  onClick={() => { setActiveWsIndex(i); setIsCollapsed(false); }}
                  className={`w-12 h-12 flex items-center justify-center text-[15px] font-black transition-all duration-200 relative group-hover:rounded-[16px] group-hover:bg-primary group-hover:text-white
                    ${isActive ? 'rounded-[16px] bg-primary text-white shadow-lg' : 'rounded-[24px] bg-black/5 dark:bg-slate-800 text-text'}
                  `}
                >
                  {initials}
                </button>
              </div>
            );
          })}

          {sharedWs.length > 0 && <div className="w-8 h-0.5 bg-black/10 dark:bg-slate-800 rounded-full my-1"></div>}

          {sharedWs.map((ws) => {
            const i = workspaces.indexOf(ws);
            const isActive = activeWsIndex === i;
            const initials = ws.name.substring(0, 2).toUpperCase();
            return (
              <div key={ws.id} className="relative group w-full flex justify-center">
                <div className={`absolute left-0 w-[4px] bg-white rounded-r-lg transition-all duration-300 ${isActive ? 'h-10 top-1' : 'h-0 top-6 group-hover:h-5 group-hover:top-3.5'}`}></div>
                <button 
                  onClick={() => { setActiveWsIndex(i); setIsCollapsed(false); }}
                  className={`w-12 h-12 flex items-center justify-center text-[15px] font-black transition-all duration-200 relative group-hover:rounded-[16px] group-hover:bg-primary group-hover:text-white
                    ${isActive ? 'rounded-[16px] bg-primary text-white shadow-lg' : 'rounded-[24px] bg-black/5 dark:bg-slate-800 text-text'}
                  `}
                >
                  {initials}
                  {!isActive && <div className="absolute -top-1 -right-0 w-3 h-3 bg-success border-2 border-background rounded-full"></div>}
                </button>
              </div>
            );
          })}

          <div className="relative group w-full flex justify-center mt-2">
            <button 
              onClick={handleAddWorkspace}
              aria-label="Create new workspace"
              className="w-12 h-12 rounded-[24px] bg-black/5 dark:bg-slate-800 flex items-center justify-center text-success hover:bg-success hover:text-white hover:rounded-[16px] transition-all duration-200 shadow-sm"
              title="Create Workspace"
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
               onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
               title={theme === 'dark' ? "Switch to Light Mode" : "Switch to Dark Mode"}
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

      {/* Inner Active Workspace Sidebar */}
      <aside className={`bg-surface flex flex-col h-full select-none transition-all duration-300 overflow-hidden ${isCollapsed ? 'w-0 opacity-0' : 'w-60 opacity-100'}`}>
        <div className="h-12 w-full flex items-center px-4 shadow-sm border-b border-border hover:bg-slate-700 transition-colors cursor-pointer group" onClick={() => setIsCollapsed(true)}>
          <h1 className="text-[15px] font-black text-slate-100 truncate flex-1 leading-none">{currentWorkspace?.name || "BenchOne"}</h1>
          <ChevronLeft size={18} className="text-slate-400 group-hover:text-slate-200" />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-4 space-y-5 custom-scrollbar">
          
          {/* Top-level nav */}
          <div className="space-y-[2px]">
            <NavButton item={{ id: 'workspace', label: 'Workspace', icon: Database }} />
            <div className="py-3">
              <NavButton item={{ id: 'inspect', label: 'Inspect', icon: Search }} disabled={!hasData} />
            </div>
          </div>

          {/* Pipeline section */}
          <div className="space-y-[2px]">
            <div className="px-2 mb-1">
              <h3 className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <ChevronDown size={12} className="opacity-70" />
                Core Preprocessing
              </h3>
            </div>
            {pipelineItems.map(item => (
              <NavButton key={item.id} item={item} disabled={!hasData} />
            ))}
          </div>

          {/* Plots section */}
          <div className="space-y-[2px]">
            <div className="px-2 mb-1">
              <h3 className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <ChevronDown size={12} className="opacity-70" />
                Plots
              </h3>
            </div>
            {plotItems.map(item => (
              <NavButton key={item.id} item={item} disabled={!hasData} />
            ))}
          </div>

          {/* Analysis section */}
          <div className="space-y-[2px]">
            <div className="px-2 mb-1">
              <h3 className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <ChevronDown size={12} className="opacity-70" />
                Downstream Analysis
              </h3>
            </div>
            {analysisItems.map(item => (
              <NavButton key={item.id} item={item} disabled={!hasData} />
            ))}
          </div>

          {/* Output section */}
          <div className="space-y-[2px]">
            <div className="px-2 mb-1">
              <h3 className="text-[11px] font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <ChevronDown size={12} className="opacity-70" />
                Output
              </h3>
            </div>
            {outputItems.map(item => (
              <NavButton key={item.id} item={item} disabled={!hasData} />
            ))}
            <NavButton item={{ id: 'lineage', label: 'Lineage', icon: History }} />
          </div>

          {/* Team — only for shared workspaces */}
          {currentWorkspace?.type === 'shared' && (
            <div className="pt-2 border-t border-border/50">
               <NavButton item={{ id: 'team', label: 'Collaborators', icon: Users }} />
            </div>
          )}
        </div>

        {/* Engine Status */}
        <div 
          className="h-14 bg-black/5 dark:bg-[black] mt-auto flex items-center px-4 gap-3 select-none shrink-0 cursor-pointer hover:bg-slate-800 transition-colors"
          onClick={() => setActiveTab('diagnostics')}
          title="Open Diagnostics & Environment"
        >
          <div className="flex flex-col justify-center min-w-0 pr-2 pb-0.5 flex-1">
             <div className="flex items-center gap-1.5 mb-[2px]">
                <div className={`w-2.5 h-2.5 rounded-full border border-black dark:border-white shadow-sm ${backendConnected ? 'bg-success' : 'animate-pulse bg-danger'}`}></div>
                <span className="text-[13px] font-bold text-text truncate leading-none mt-1">{backendConnected ? 'Backend connected' : 'Backend offline'}</span>
             </div>
             <span className="text-[11px] text-slate-400 truncate leading-none">{apiStatus || "Connection lost"}</span>
          </div>
          <Wrench size={16} className="text-slate-400" />
        </div>
      </aside>
      
      {isCollapsed && (
         <button onClick={() => setIsCollapsed(false)} className="absolute left-[80px] top-4 w-8 h-8 bg-surface hover:bg-slate-700 text-slate-400 hover:text-white rounded-md shadow flex items-center justify-center transition-all z-30 border border-background">
           <Menu size={16} />
         </button>
      )}
    </div>
  );
}
