import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronLeft, Database, FileText, GitBranch, LayoutPanelTop,
  Info, Lock, LogOut, Menu, Microscope, Moon, Sun, UserRound, Users, Wrench,
} from 'lucide-react';
import { buildPipelineSidebarSections } from '../pipelines/pipelineRegistry';
import { workflowTabAvailability } from '../../shared/workflowState.mjs';

const PRIMARY_DESTINATION_IDS = new Set([
  'workspace', 'analyses', 'pipeline-manager', 'branches', 'study-design', 'expert-r',
  'team', 'history', 'lineage', 'publication', 'validation',
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
    aria-current={isActive ? 'page' : undefined}
    data-destination={item.id}
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

function NavSection({ id, label, open, active, onToggle, children }) {
  return <section className="space-y-1">
    <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`navigation-group-${id}`}
      aria-disabled={active || undefined} title={active ? 'This group contains the current page' : undefined}
      className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs font-semibold text-textMuted hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <ChevronDown size={14} className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words leading-relaxed">{label}</span>
    </button>
    <div id={`navigation-group-${id}`} hidden={!open} className="space-y-0.5">{children}</div>
  </section>;
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
  const navigationScrollRef = useRef(null);
  const previousNarrowRef = useRef(window.innerWidth < 1024);
  const focusExpandAfterBreakpointRef = useRef(false);
  const [closedGroups, setClosedGroups] = useState(new Set());
  const [isPhone, setIsPhone] = useState(() => window.innerWidth < 640);
  const expandRef = useRef(null);
  const collapseRef = useRef(null);
  const [isNarrow, setIsNarrow] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 1024 : false
  ));
  const [isCollapsed, setIsCollapsed] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 1024 : false
  ));
  const isCollapsedRef = useRef(isCollapsed);
  isCollapsedRef.current = isCollapsed;

  useEffect(() => {
    const collapseForNarrowViewport = () => {
      const narrow = window.innerWidth < 1024;
      setIsNarrow(narrow);
      setIsPhone(window.innerWidth < 640);
      if (narrow && !previousNarrowRef.current) {
        const aside = shellRef.current?.querySelector('aside');
        if (!isCollapsedRef.current && aside?.contains(document.activeElement)) {
          focusExpandAfterBreakpointRef.current = true;
        }
        setIsCollapsed(true);
      }
      previousNarrowRef.current = narrow;
    };
    collapseForNarrowViewport();
    window.addEventListener('resize', collapseForNarrowViewport);
    return () => window.removeEventListener('resize', collapseForNarrowViewport);
  }, []);

  useEffect(() => {
    if (!isNarrow || !isCollapsed || !focusExpandAfterBreakpointRef.current) return;
    focusExpandAfterBreakpointRef.current = false;
    expandRef.current?.focus({ preventScroll: true });
  }, [isNarrow, isCollapsed]);

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
    const controls = [...shellRef.current.querySelector('aside').querySelectorAll('button:not([disabled]):not([tabindex="-1"])')]
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
  // Project destinations remain available when a selected workflow replaces
  // the generated analysis navigation.
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
  const groupActive = items => items.some(item => item.id === activeTab);
  const toggleGroup = (id, active) => {
    if (active) return;
    setClosedGroups(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (isCollapsed) return;
    const scroll = navigationScrollRef.current;
    const active = scroll?.querySelector('[aria-current="page"]');
    if (!scroll || !active) return;
    const frame = requestAnimationFrame(() => {
      const bounds = scroll.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      if (item.top < bounds.top) scroll.scrollTop -= bounds.top - item.top;
      else if (item.bottom > bounds.bottom) scroll.scrollTop += item.bottom - bounds.bottom;
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, closedGroups, isCollapsed]);

  const navProps = {
    activeTab, figuresCount,
    onSelect: id => { setActiveTab(id); collapseAfterMobileNavigation(); },
  };

  return (
    <div ref={shellRef} onKeyDown={handleDrawerKeyDown} className="relative z-20 flex h-14 w-full shrink-0 sm:h-full sm:w-[72px] lg:w-auto">
      <nav aria-label="Account and navigation controls" inert={isNarrow && !isCollapsed} className="relative z-50 flex h-14 w-full shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:h-full sm:w-[72px] sm:flex-col sm:border-b-0 sm:border-r sm:px-0 sm:py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary shadow-sm sm:mb-1 sm:h-11 sm:w-11" title="TraceOmics">
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
            className={`h-11 w-11 shrink-0 rounded-md bg-surface border border-border text-textMuted hover:bg-black/5 hover:text-text dark:hover:bg-slate-700 transition-colors items-center justify-center shadow-sm ${isCollapsed ? 'flex' : 'hidden'}`}
            title="Expand sidebar"
          >
            <Menu size={16} />
          </button>

        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text sm:hidden">{currentWorkspace?.name || 'TraceOmics'}</span>
        <div className="my-1 hidden h-0.5 w-8 rounded-full bg-black/10 dark:bg-slate-800 sm:block" />

        <div className="hidden flex-1 sm:block" />

        {!isPhone && user && (
          <div className="relative mb-2 mt-auto hidden w-full flex-col items-center gap-2 sm:flex">
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
        className="fixed inset-0 top-14 z-30 bg-black/25 dark:bg-black/45 sm:left-[72px] sm:top-0 lg:hidden"
      />}
      <aside
        id="workspace-navigation"
        aria-label="Workspace navigation"
        role={isNarrow && !isCollapsed ? 'dialog' : undefined}
        aria-modal={isNarrow && !isCollapsed ? true : undefined}
        aria-hidden={isCollapsed || undefined}
        inert={isCollapsed}
        className={`fixed bottom-0 left-0 top-14 z-40 w-[min(320px,100vw)] overflow-hidden bg-surface shadow-xl transition-[width,transform] duration-200 ease-out motion-reduce:transition-none sm:left-[72px] sm:top-0 sm:w-60 lg:static lg:h-full lg:shadow-none ${isCollapsed ? '-translate-x-full pointer-events-none lg:w-0 lg:translate-x-0' : 'translate-x-0 lg:w-60'}`}
      >
        <div className="flex h-full w-[min(320px,100vw)] flex-col sm:w-60">
        <button
          ref={collapseRef}
          type="button"
          aria-label="Collapse sidebar"
          className="h-12 w-full shrink-0 flex items-center px-4 border-b border-border hover:bg-black/5 transition-colors cursor-pointer group text-left"
          onClick={() => setIsCollapsed(true)}
        >
          <span className="text-[15px] font-semibold text-text truncate flex-1 leading-none">{currentWorkspace?.name || 'TraceOmics'}</span>
          <ChevronLeft size={18} className="text-slate-400 group-hover:text-text" />
        </button>

        <div className="shrink-0 border-b border-border p-2">
          <NavButton {...navProps} item={{ id: 'analyses', label: 'Analyses', icon: FileText }} disabled={!hasProject} />
          <NavButton {...navProps} item={{ id: 'workspace', label: 'Data workspace', icon: Database, status: hasProject ? 'Project selected' : 'Select project' }} />
        </div>
        <div ref={navigationScrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2 space-y-3 custom-scrollbar" style={{ scrollbarGutter: 'stable' }}>
          <NavSection id="project" label="Project" active={['pipeline-manager', 'branches', 'study-design', 'expert-r', 'team', 'history'].includes(activeTab)} open={!closedGroups.has('project') || ['pipeline-manager', 'branches', 'study-design', 'expert-r', 'team', 'history'].includes(activeTab)} onToggle={() => toggleGroup('project', ['pipeline-manager', 'branches', 'study-design', 'expert-r', 'team', 'history'].includes(activeTab))}>
            <NavButton {...navProps} item={{ id: 'pipeline-manager', label: 'Pipelines', icon: LayoutPanelTop, status: hasProject ? 'Project selection' : 'Select project' }} disabled={!hasProject} />
            <NavButton {...navProps} item={{ id: 'history', label: 'Runs & Results', icon: LayoutPanelTop }} disabled={!hasProject} />
            <NavButton {...navProps} item={{ id: 'branches', label: 'Analysis Branches', icon: GitBranch, status: hasProject ? 'Private drafts & review' : 'Select project' }} disabled={!hasProject} />
            <NavButton {...navProps} item={{ id: 'study-design', label: 'Study Design', icon: Microscope, status: hasProject ? 'Samples & contrasts' : 'Select project' }} disabled={!hasProject} />
            <NavButton {...navProps} item={{ id: 'expert-r', label: 'Advanced analysis', icon: Wrench, status: deploymentPolicy.expertREnabled ? 'Available' : deploymentPolicy.demoMode ? 'Unavailable in public demo' : 'R setup & availability' }} disabled={!hasProject || deploymentPolicy.demoMode === true || deploymentPolicy.expertRStatus?.state === 'demo-disabled'} />
            <NavButton {...navProps} item={{ id: 'team', label: 'Collaborators', icon: Users, status: hasProject ? 'Project access' : 'Select project' }} disabled={!hasProject} />
          </NavSection>
          <NavSection id="data" label="Data & analysis" active={['lineage', 'publication', 'validation'].includes(activeTab)} open={!closedGroups.has('data') || ['lineage', 'publication', 'validation'].includes(activeTab)} onToggle={() => toggleGroup('data', ['lineage', 'publication', 'validation'].includes(activeTab))}>
              <NavButton {...navProps} item={{ id: 'lineage', label: 'Lineage', icon: GitBranch, status: hasData ? 'Analysis lineage' : 'Requires a saved analysis' }} disabled={!hasData} />
              <NavButton {...navProps} item={{ id: 'publication', label: 'Figure Gallery', icon: LayoutPanelTop, status: 'Saved figures' }} disabled={!hasData} />
              <NavButton {...navProps} item={{ id: 'validation', label: 'Validation', icon: LayoutPanelTop }} disabled={!hasData} />
          </NavSection>

          {pipelineSections.map(section => (
            <NavSection key={section.id} id={section.id} label={researcherLabel(section.label)} active={groupActive(section.items)} open={!closedGroups.has(section.id) || groupActive(section.items)} onToggle={() => toggleGroup(section.id, groupActive(section.items))}>
              {section.items.map(item => {
                const blockedLegacyMutation = deploymentPolicy.legacyLiveMutationToolsEnabled !== true
                  && item.id === 'integrate';
                const blockedExpertR = (deploymentPolicy.demoMode === true || deploymentPolicy.expertRStatus?.state === 'demo-disabled')
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
            </NavSection>
          ))}
        </div>
        {isPhone && user && <div className="shrink-0 border-t border-border p-2 space-y-1">
          <p className="truncate px-3 py-1 text-xs text-textMuted" title={user.email}>{user.email || 'Account'}</p>
          <NavButton {...navProps} item={{ id: 'account', label: 'Account security', icon: UserRound }} />
          <button type="button" onClick={() => setTheme?.(theme === 'dark' ? 'light' : 'dark')} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-textMuted hover:bg-black/5">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            {theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          </button>
          <button type="button" onClick={onLogout} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-textMuted hover:bg-danger/10 hover:text-danger"><LogOut size={18} />Log out</button>
        </div>}
        </div>
      </aside>
    </div>
  );
}
