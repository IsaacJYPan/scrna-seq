import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronLeft, Database, GitBranch, LayoutPanelTop,
  Info, Lock, LogOut, Menu, Microscope, Moon, Sun, UserRound, Users, Wrench,
} from 'lucide-react';
import { buildPipelineSidebarSections } from '../pipelines/pipelineRegistry';
import { workflowTabAvailability } from '../../shared/workflowState.mjs';

const PRIMARY_DESTINATION_IDS = new Set([
  'workspace', 'pipeline-manager', 'branches', 'study-design', 'expert-r',
  'team', 'lineage', 'publication', 'validation',
]);

function researcherLabel(value) {
  if (value === 'Expert R') return 'Advanced analysis';
  if (/seurat/i.test(String(value || ''))) return 'Standard scRNA-seq workflow';
  return value;
}

function NavButton({ item, disabled = false, activeTab, onSelect, figuresCount }) {
  const Icon = item.icon;
  const isActive = activeTab === item.id;
  const isDisabled = disabled || item.disabled;
  return <button
    onClick={() => { if (!isDisabled) onSelect(item.id); }}
    disabled={isDisabled && !item.lockReason}
    aria-disabled={isDisabled || undefined}
    aria-describedby={item.lockReason ? `${item.id}-dependency` : undefined}
    title={item.status || researcherLabel(item.label)}
    aria-label={item.status ? `${researcherLabel(item.label)}, ${item.status}` : researcherLabel(item.label)}
    className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-[14px] font-medium transition-colors group
      ${isDisabled ? 'cursor-not-allowed' : ''} ${isDisabled && !item.lockReason ? 'opacity-45' : ''}
      ${isActive ? 'border-primary/30 bg-primary/10 text-text' : 'border-transparent text-textMuted hover:bg-black/5 hover:text-text'}`}
  >
    {Icon && <Icon size={18} className={`${isActive ? 'text-primary' : 'text-slate-400'} group-hover:text-text flex-shrink-0`} />}
    <span className="min-w-0 flex-1 truncate text-left">{researcherLabel(item.label)}</span>
    {item.status && <Info size={13} className="flex-shrink-0 text-textMuted" aria-hidden="true" />}
    {item.lockReason && <>
      <Lock size={13} className="flex-shrink-0" aria-hidden="true" />
      <span id={`${item.id}-dependency`} role="tooltip" className="pointer-events-none absolute inset-x-0 top-full z-30 hidden rounded border border-border bg-surface p-2 text-left text-xs text-text shadow group-hover:block group-focus:block">{item.lockReason}</span>
    </>}
    {item.id === 'publication' && figuresCount > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded text-text bg-blue-500/10 border border-blue-500/20">{figuresCount}</span>}
    {item.done && <CheckCircle2 size={14} className="text-success flex-shrink-0" />}
  </button>;
}

function SectionLabel({ children }) {
  return <div className="px-2 mb-1">
    <h3 className="text-[11px] font-semibold text-textMuted flex items-center gap-1.5">
      <ChevronDown size={12} className="opacity-70" />{children}
    </h3>
  </div>;
}

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
  activeWorkflow = null,
  theme = 'dark',
  setTheme,
  figuresCount = 0,
  deploymentPolicy = {},
}) {
  const shellRef = useRef(null);
  const expandRef = useRef(null);
  const collapseRef = useRef(null);
  const [isNarrow, setIsNarrow] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 1024 : false
  ));
  const [isCollapsed, setIsCollapsed] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 1024 : false
  ));

  useEffect(() => {
    const collapseForNarrowViewport = () => {
      const narrow = window.innerWidth < 1024;
      setIsNarrow(narrow);
      if (narrow) setIsCollapsed(true);
    };
    collapseForNarrowViewport();
    window.addEventListener('resize', collapseForNarrowViewport);
    return () => window.removeEventListener('resize', collapseForNarrowViewport);
  }, []);

  useEffect(() => {
    if (!isNarrow || isCollapsed) return;
    const previousFocus = document.activeElement;
    const expand = expandRef.current;
    const main = shellRef.current?.parentElement.querySelector('main');
    const previousInert = main?.inert;
    if (main) main.inert = true;
    collapseRef.current?.focus({ preventScroll: true });
    return () => {
      if (main) main.inert = previousInert;
      if (expand?.isConnected && !expand.hidden) expand.focus({ preventScroll: true });
      else if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [isNarrow, isCollapsed]);

  const handleDrawerKeyDown = (event) => {
    if (!isNarrow || isCollapsed) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setIsCollapsed(true);
    }
    if (event.key !== 'Tab') return;
    const controls = [...shellRef.current.querySelectorAll('button:not([disabled]):not([tabindex="-1"])')]
      .filter(element => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const collapseAfterMobileNavigation = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setIsCollapsed(true);
    }
  };

  const currentWorkspace = workspaces[activeWsIndex];
  const hasData = selectedObjects.length > 0;
  const hasProject = !!currentWorkspace?.selectedProjectId || (currentWorkspace?.projects || []).length > 0;
  // Advanced analysis is a project-scoped, capability-gated workbench. Keep its
  // single entry in the Project section rather than duplicating it in a selected
  // workflow's generated navigation.
  const pipelineSections = (activeWorkflow ? [{ id: 'workflow', label: activeWorkflow.package.name,
    items: activeWorkflow.package.tabs.map(tab => {
      const availability = workflowTabAvailability(activeWorkflow.package, activeWorkflow.state, tab);
      return { id: `workflow:${tab.id}`, label: tab.label, disabled: !availability.ready, lockReason: availability.reason };
    }) }] : buildPipelineSidebarSections(activePipeline, pipelineState))
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !PRIMARY_DESTINATION_IDS.has(item.id)),
    }))
    .filter((section) => section.items.length > 0);
  const navProps = {
    activeTab, figuresCount,
    onSelect: id => { setActiveTab(id); collapseAfterMobileNavigation(); },
  };

  return (
    <div ref={shellRef} onKeyDown={handleDrawerKeyDown} className="flex h-full flex-shrink-0 z-20 relative w-[72px] lg:w-auto">
      <nav aria-label="Account and navigation controls" className="relative z-50 w-[72px] bg-background flex flex-col items-center py-3 gap-2 h-full flex-shrink-0 border-r border-border">
        <div className="w-11 h-11 rounded-xl bg-primary flex items-center justify-center shadow-sm mb-1" title="TraceOmics">
          <Microscope size={22} className="text-on-accent" />
        </div>

          <button
            ref={expandRef}
            type="button"
            onClick={() => setIsCollapsed(false)}
            aria-label="Expand sidebar"
            aria-controls="workspace-navigation"
            aria-expanded={!isCollapsed}
            hidden={!isCollapsed}
            className={`w-12 h-8 rounded-md bg-surface border border-border text-textMuted hover:bg-black/5 hover:text-text dark:hover:bg-slate-700 transition-colors items-center justify-center shadow-sm ${isCollapsed ? 'flex' : 'hidden'}`}
            title="Expand sidebar"
          >
            <Menu size={16} />
          </button>

        <div className="w-8 h-0.5 bg-black/10 dark:bg-slate-800 rounded-full my-1" />

        <div className="flex-1" />

        {user && (
          <div className="mt-auto mb-2 w-full flex flex-col items-center gap-2 group relative">
            <button
              aria-label="Account security"
              className={`w-11 h-11 rounded-xl transition-colors duration-150 flex items-center justify-center ${activeTab === 'account' ? 'bg-primary/10 text-primary' : 'bg-transparent text-textMuted hover:bg-black/5 hover:text-text'}`}
              onClick={() => { setActiveTab('account'); collapseAfterMobileNavigation(); }}
              title="Account security"
            >
              <UserRound size={20} />
            </button>
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

      {isNarrow && !isCollapsed && <button
        type="button"
        aria-label="Close navigation overlay"
        tabIndex={-1}
        onClick={() => setIsCollapsed(true)}
        className="fixed inset-0 left-[72px] z-30 bg-black/25 dark:bg-black/45 lg:hidden"
      />}
      <aside
        id="workspace-navigation"
        aria-label="Workspace navigation"
        aria-hidden={isCollapsed || undefined}
        inert={isCollapsed}
        className={`absolute left-[72px] top-0 z-40 w-[calc(100vw-72px)] max-w-60 bg-surface flex flex-col h-full select-none transition-[width,translate] duration-200 ease-out overflow-hidden shadow-xl lg:static lg:max-w-none lg:translate-x-0 lg:shadow-none ${isCollapsed ? '-translate-x-full pointer-events-none lg:w-0' : 'translate-x-0 lg:w-60'}`}
      >
        <button
          ref={collapseRef}
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
            <NavButton {...navProps} item={{ id: 'workspace', label: 'Analysis workspace', icon: Database, status: hasProject ? 'Project selected' : 'Select project' }} />
            <NavButton {...navProps} item={{ id: 'pipeline-manager', label: 'Pipelines', icon: LayoutPanelTop, status: hasProject ? 'Project selection' : 'Select project' }} disabled={!hasProject} />
            <NavButton {...navProps} item={{ id: 'branches', label: 'Analysis Branches', icon: GitBranch, status: hasProject ? 'Private drafts & review' : 'Select project' }} disabled={!hasProject} />
            <NavButton {...navProps} item={{ id: 'study-design', label: 'Study Design', icon: Microscope, status: hasProject ? 'Samples & contrasts' : 'Select project' }} disabled={!hasProject} />
            <NavButton {...navProps} item={{ id: 'expert-r', label: 'Advanced analysis', icon: Wrench, status: deploymentPolicy.expertREnabled ? 'Available' : 'Not enabled for this deployment' }} disabled={!hasProject || deploymentPolicy.expertREnabled !== true} />
            <NavButton {...navProps} item={{ id: 'team', label: 'Collaborators', icon: Users, status: hasProject ? 'Project access' : 'Select project' }} disabled={!hasProject} />
            <div className="pt-3">
              <SectionLabel>Data & analysis</SectionLabel>
              <NavButton {...navProps} item={{ id: 'lineage', label: 'Lineage', icon: GitBranch, status: hasData ? 'Analysis lineage' : 'Requires a saved analysis' }} disabled={!hasData} />
              <NavButton {...navProps} item={{ id: 'publication', label: 'Figure Gallery', icon: LayoutPanelTop, status: 'Saved figures' }} disabled={!hasData} />
              <NavButton {...navProps} item={{ id: 'validation', label: 'Validation', icon: LayoutPanelTop }} disabled={!hasData} />
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
                  <NavButton {...navProps}
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
