import React, { useEffect, useState } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronLeft, Database, GitBranch, LayoutPanelTop,
  Lock, LogOut, Menu, Microscope, Moon, Sun, Users, Wrench,
} from 'lucide-react';
import { buildPipelineSidebarSections } from '../pipelines/pipelineRegistry';

export default function Sidebar({
  activeTab,
  setActiveTab,
  workspaces = [],
  activeWsIndex = 0,
  selectedObjects = [],
  user,
  onLogout,
  pipelineState = {},
  activePipeline = null,
  theme = 'dark',
  setTheme,
  figuresCount = 0,
  deploymentPolicy = {},
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

  const currentWorkspace = workspaces[activeWsIndex];
  const hasData = selectedObjects.length > 0;
  const hasProject = !!currentWorkspace?.selectedProjectId || (currentWorkspace?.projects || []).length > 0;
  // Advanced analysis is a project-scoped, capability-gated workbench. Keep its
  // single entry in the Project section rather than duplicating it in a selected
  // workflow's generated navigation.
  const pipelineSections = buildPipelineSidebarSections(activePipeline, pipelineState)
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.id !== 'expert-r'),
    }))
    .filter((section) => section.items.length > 0);
  const researcherLabel = (value) => {
    if (value === 'Expert R') return 'Advanced analysis';
    if (/seurat/i.test(String(value || ''))) return 'Standard scRNA-seq workflow';
    return value;
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
        title={item.status || researcherLabel(item.label)}
        aria-label={item.status ? `${researcherLabel(item.label)}, ${item.status}` : researcherLabel(item.label)}
        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-[14px] font-medium transition-colors group
          ${isDisabled ? 'opacity-45 cursor-not-allowed' : ''}
          ${isActive
            ? 'border-primary/30 bg-primary/10 text-text'
            : 'border-transparent text-textMuted hover:bg-black/5 hover:text-text'
          }
        `}
      >
        {Icon && <Icon size={18} className={`${isActive ? 'text-primary' : 'text-slate-400'} group-hover:text-text flex-shrink-0`} />}
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate">{researcherLabel(item.label)}</span>
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
      <h3 className="text-[11px] font-semibold text-textMuted flex items-center gap-1.5">
        <ChevronDown size={12} className="opacity-70" />
        {children}
      </h3>
    </div>
  );

  return (
    <div className="flex h-full flex-shrink-0 z-20 relative w-[72px] lg:w-auto">
      <nav className="w-[72px] bg-background flex flex-col items-center py-3 gap-2 h-full flex-shrink-0 border-r border-border">
        <div className="w-11 h-11 rounded-xl bg-primary flex items-center justify-center shadow-sm mb-1" title="TraceOmics">
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

        <div className="flex-1" />

        {user && (
          <div className="mt-auto mb-2 w-full flex flex-col items-center gap-2 group relative">
            <button
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="w-11 h-11 rounded-xl bg-transparent hover:bg-black/5 transition-colors duration-150 flex items-center justify-center text-textMuted hover:text-text"
              onClick={() => setTheme?.(theme === 'dark' ? 'light' : 'dark')}
              title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            >
              {theme === 'dark' ? <Moon size={20} /> : <Sun size={20} />}
            </button>
            <button
              aria-label="Log out"
              className="w-11 h-11 rounded-xl bg-transparent hover:bg-danger hover:text-on-accent transition-colors duration-150 flex items-center justify-center text-textMuted"
              onClick={onLogout}
              title="Log Out"
            >
              <LogOut size={20} className="ml-0.5" />
            </button>
          </div>
        )}
      </nav>

      <aside className={`bg-surface flex flex-col h-full select-none transition-[width,opacity] duration-200 overflow-hidden ${isCollapsed ? 'w-0 opacity-0 pointer-events-none' : 'absolute left-[72px] top-0 z-40 w-[calc(100vw-72px)] max-w-60 opacity-100 shadow-xl lg:static lg:left-auto lg:top-auto lg:z-auto lg:w-60 lg:max-w-none'}`}>
        <button
          type="button"
          aria-label="Collapse sidebar"
          className="h-12 w-full flex items-center px-4 border-b border-border hover:bg-black/5 transition-colors cursor-pointer group text-left"
          onClick={() => setIsCollapsed(true)}
        >
          <span className="text-[15px] font-semibold text-text truncate flex-1 leading-none">{currentWorkspace?.name || 'TraceOmics'}</span>
          <ChevronLeft size={18} className="text-slate-400 group-hover:text-text" />
        </button>

        <div className="flex-1 overflow-y-auto px-2 py-4 space-y-5 custom-scrollbar">
          <div className="space-y-[2px]">
            <SectionLabel>Project</SectionLabel>
            <NavButton item={{ id: 'workspace', label: 'Analysis workspace', icon: Database, status: hasProject ? 'Project selected' : 'Select project' }} />
            <NavButton item={{ id: 'pipeline-manager', label: 'Approved workflows', icon: LayoutPanelTop, status: hasProject ? 'Project selection' : 'Select project' }} disabled={!hasProject} />
            <NavButton item={{ id: 'branches', label: 'Analysis Branches', icon: GitBranch, status: hasProject ? 'Private drafts & review' : 'Select project' }} disabled={!hasProject} />
            <NavButton item={{ id: 'study-design', label: 'Study Design', icon: Microscope, status: hasProject ? 'Samples & contrasts' : 'Select project' }} disabled={!hasProject} />
            <NavButton item={{ id: 'expert-r', label: 'Advanced analysis', icon: Wrench, status: deploymentPolicy.expertREnabled ? 'Available' : 'Not configured' }} disabled={!hasProject || !deploymentPolicy.expertREnabled} />
            <NavButton item={{ id: 'team', label: 'Collaborators', icon: Users, status: hasProject ? 'Project access' : 'Select project' }} disabled={!hasProject} />
            <div className="pt-3">
              <SectionLabel>Data & analysis</SectionLabel>
              <NavButton item={{ id: 'lineage', label: 'Lineage', icon: GitBranch, status: hasData ? 'Analysis lineage' : 'Requires a saved analysis' }} disabled={!hasData} />
              <NavButton item={{ id: 'publication', label: 'Figure Gallery', icon: LayoutPanelTop, status: 'Saved figures' }} disabled={!hasData} />
              <NavButton item={{ id: 'validation', label: 'Validation', icon: LayoutPanelTop }} disabled={!hasData} />
            </div>
          </div>

          {pipelineSections.map(section => (
            <div key={section.id} className="space-y-[2px]">
              <SectionLabel>{researcherLabel(section.label)}</SectionLabel>
              {section.items.map(item => {
                const blockedLegacyMutation = deploymentPolicy.legacyLiveMutationToolsEnabled !== true
                  && item.id === 'integrate';
                const blockedExpertR = deploymentPolicy.expertREnabled !== true
                  && item.id === 'expert-r';
                const visibleItem = blockedLegacyMutation
                  ? { ...item, status: 'Unavailable in this workspace' }
                  : blockedExpertR
                    ? { ...item, status: 'Not configured' }
                    : item;
                return (
                  <NavButton
                    key={item.id}
                    item={visibleItem}
                    disabled={blockedLegacyMutation
                      || blockedExpertR
                      || (item.requiresObject && !hasData)
                      || (item.requiresProject && !hasProject)}
                  />
                );
              })}
            </div>
          ))}
        </div>

      </aside>
    </div>
  );
}
