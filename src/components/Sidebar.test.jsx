import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Sidebar from './Sidebar';

describe('Sidebar component', () => {
  const mockWorkspaces = [{
    id: 'ws-1', name: 'Test WS', type: 'personal', objects: []
  }];

  const baseProps = {
    setActiveTab: () => {},
    workspaces: mockWorkspaces,
    activeWsIndex: 0,
    pipelineState: { qc: false, normalize: false, integrate: false, pca: false, cluster: false },
    setWorkspaces: () => {},
    setActiveWsIndex: () => {},
    onLogout: () => {},
    theme: 'dark',
    setTheme: () => {},
  };

  it('renders disabled downstream options when data is not loaded', () => {
    render(
      <Sidebar 
        activeTab="home"
        {...baseProps}
        selectedObjects={[]} // No data loaded
      />
    );

    const qcButton = screen.getByRole('button', { name: /Quality Control/i });
    expect(qcButton).toBeDisabled();

    const clusterButton = screen.getByRole('button', { name: /Cluster/i });
    expect(clusterButton).toBeDisabled();
  });

  it('opens account security from the authenticated-user rail', () => {
    const setActiveTab = vi.fn();
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        setActiveTab={setActiveTab}
        user={{ email: 'owner@example.org' }}
        selectedObjects={[]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /account security/i }));
    expect(setActiveTab).toHaveBeenCalledWith('account');
  });

  it('enables pipeline options when data is loaded', () => {
    render(
      <Sidebar 
        activeTab="home"
        {...baseProps}
        selectedObjects={[{ id: 'ao_abc123' }]} // DB-backed object selected
        pipelineState={{ qc: true, normalize: true, integrate: false, pca: false, cluster: false }}
      />
    );

    const qcButton = screen.getByRole('button', { name: /Quality Control/i });
    expect(qcButton).not.toBeDisabled();
  });

  it('shows integrated downstream-analysis modules while keeping unsupported scientific features hidden', () => {
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        selectedObjects={[{ id: 'ao_abc123' }]}
      />
    );

    expect(screen.getByRole('button', { name: /Pathway Enrichment/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /^CellChat$/i })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /Custom Script/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cell Annotation/i })).not.toBeInTheDocument();
  });

  it('keeps locked workflow tabs focusable for their prerequisite explanation', () => {
    const setActiveTab = vi.fn();
    const activeWorkflow = {
      package: { name: 'Workflow', tabs: [{ id: 'pca', label: 'PCA', step: 'pca' }], steps: [
        { id: 'normalize', label: 'Normalize', inputs: {}, outputs: { analysis: { type: 'rds' } } },
        { id: 'pca', label: 'PCA', inputs: { analysis: { from: 'normalize.analysis', type: 'rds' } } },
      ] },
      state: { results: {}, active: null },
    };
    const view = render(<Sidebar {...baseProps} selectedObjects={[{ id: 'ao_input' }]} activeWorkflow={activeWorkflow} setActiveTab={setActiveTab} />);
    const pca = screen.getByRole('button', { name: 'PCA', exact: true });
    expect(pca).toHaveAttribute('aria-disabled', 'true');
    expect(pca).not.toBeDisabled();
    expect(pca).toHaveAccessibleDescription('Requires Normalize.');
    pca.focus();
    expect(pca).toHaveFocus();
    view.rerender(<Sidebar {...baseProps} selectedObjects={[{ id: 'ao_input' }]} activeWorkflow={{ ...activeWorkflow }} setActiveTab={setActiveTab} />);
    expect(pca).toHaveFocus();
    fireEvent.click(pca);
    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it('shows pipeline-generated sections and utility pipeline manager entry', () => {
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        workspaces={[{
          id: 'ws-1',
          name: 'Test WS',
          type: 'personal',
          projects: [{ id: 'proj_1', name: 'Project', role: 'owner' }],
          selectedProjectId: 'proj_1',
          objects: [{ id: 'ao_abc123' }],
          selectedObjectIds: ['ao_abc123'],
        }]}
        selectedObjects={[{ id: 'ao_abc123' }]}
      />
    );

    expect(screen.getByRole('button', { name: /Pipelines, Project selection/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Collaborators, Project access/i })).not.toBeDisabled();
    expect(screen.queryByText(/Demo only/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Standard scRNA-seq workflow/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Markers \/ DEG/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Runs & Results/i })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /Diagnostics/i })).not.toBeInTheDocument();
  });

  it.each([
    ['default pipeline', null, null],
    ['custom pipeline', { schemaVersion: 1, id: 'custom-recipe', name: 'Custom Recipe', tabs: [
      { id: 'inspect', label: 'Inspect object', moduleKey: 'inspectObject' },
      { id: 'history', label: 'Runs & Results', moduleKey: 'projectHistory' },
    ] }, null],
    ['active workflow', null, { package: { name: 'Custom workflow', tabs: [{ id: 'counts', label: 'Cell counts', step: 'counts' }],
      steps: [{ id: 'counts', label: 'Cell counts', inputs: {}, outputs: {} }] }, state: { results: {}, active: null } }],
  ])('keeps one project Runs & Results destination for a %s without a selected analysis', (_context, activePipeline, activeWorkflow) => {
    const setActiveTab = vi.fn();
    const { container } = render(<Sidebar {...baseProps} activeTab="workspace" setActiveTab={setActiveTab}
      workspaces={[{ ...mockWorkspaces[0], selectedProjectId: 'proj_1', projects: [{ id: 'proj_1' }] }]}
      selectedObjects={[]} activePipeline={activePipeline} activeWorkflow={activeWorkflow} />);
    const history = screen.getAllByRole('button', { name: 'Runs & Results', exact: true });
    expect(history).toHaveLength(1);
    expect(history[0]).not.toBeDisabled();
    expect(history[0]).toHaveAttribute('data-destination', 'history');
    expect(container.querySelector('#navigation-group-project')).toContainElement(history[0]);
    fireEvent.click(history[0]);
    expect(setActiveTab).toHaveBeenCalledWith('history');
    if (activeWorkflow) expect(screen.getByRole('button', { name: 'Cell counts', exact: true })).toBeVisible();
  });

  it('requires a project to open Runs & Results', () => {
    const setActiveTab = vi.fn();
    render(<Sidebar {...baseProps} activeTab="workspace" selectedObjects={[]} setActiveTab={setActiveTab} />);
    const history = screen.getByRole('button', { name: 'Runs & Results', exact: true });
    expect(history).toBeDisabled();
    fireEvent.click(history);
    expect(setActiveTab).not.toHaveBeenCalled();
  });

  it('reopens the project group when Runs & Results becomes the current page', () => {
    const props = { ...baseProps, workspaces: [{ ...mockWorkspaces[0], selectedProjectId: 'proj_1' }], selectedObjects: [] };
    const view = render(<Sidebar {...props} activeTab="workspace" />);
    const project = screen.getByRole('button', { name: 'Project', exact: true });
    fireEvent.click(project);
    expect(project).toHaveAttribute('aria-expanded', 'false');
    view.rerender(<Sidebar {...props} activeTab="history" />);
    const history = screen.getByRole('button', { name: 'Runs & Results', exact: true });
    expect(history).toHaveAttribute('aria-current', 'page');
    expect(project).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(project);
    expect(project).toHaveAttribute('aria-expanded', 'true');
  });

  it('disables the legacy live integration action under the production policy', () => {
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        selectedObjects={[{ id: 'ao_abc123' }]}
        deploymentPolicy={{ legacyLiveMutationToolsEnabled: false }}
      />
    );

    expect(screen.getByRole('button', { name: /Integration, Unavailable in this workspace/i })).toBeDisabled();
  });

  it('lets a private project open R setup when its runtime is not configured', () => {
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        workspaces={[{
          id: 'ws-1',
          name: 'Test WS',
          type: 'personal',
          projects: [{ id: 'proj_1', name: 'Project', role: 'owner' }],
          selectedProjectId: 'proj_1',
          objects: [{ id: 'ao_abc123' }],
          selectedObjectIds: ['ao_abc123'],
        }]}
        selectedObjects={[{ id: 'ao_abc123' }]}
        deploymentPolicy={{ expertREnabled: false }}
      />
    );

    const advancedAnalysisButtons = screen.getAllByRole('button', { name: /Advanced analysis/i });
    expect(advancedAnalysisButtons).toHaveLength(1);
    advancedAnalysisButtons.forEach(button => expect(button).not.toBeDisabled());
    expect(advancedAnalysisButtons[0]).toHaveAccessibleName('Advanced analysis, R setup & availability');
  });

  it('keeps public demo R setup and execution unavailable', () => {
    render(<Sidebar {...baseProps}
      workspaces={[{ ...mockWorkspaces[0], selectedProjectId: 'proj_demo', projects: [{ id: 'proj_demo', role: 'owner' }] }]}
      selectedObjects={[]}
      deploymentPolicy={{ demoMode: true, expertREnabled: false }}
    />);
    expect(screen.getByRole('button', { name: /Advanced analysis/i })).toBeDisabled();
  });

  it('does not require icons for pipeline-generated tabs', () => {
    const { container } = render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        selectedObjects={[{ id: 'ao_abc123' }]}
      />
    );

    const qcButton = screen.getByRole('button', { name: /Quality Control/i });
    expect(qcButton.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('Quality Control');
  });

  it('uses a readable token-based selected state in light mode', () => {
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        theme="light"
        workspaces={[{
          id: 'ws-1',
          name: 'Test WS',
          type: 'personal',
          projects: [{ id: 'proj_1', name: 'Project', role: 'owner' }],
          selectedProjectId: 'proj_1',
          objects: [],
          selectedObjectIds: [],
        }]}
        selectedObjects={[]}
      />
    );

    const workbench = screen.getByRole('button', { name: /Data workspace, Project selected/i });
    expect(workbench).toHaveClass('bg-primary/10');
    expect(workbench).toHaveClass('border-primary/30');
    expect(workbench).toHaveClass('text-text');
    expect(workbench).not.toHaveClass('bg-slate-700');
  });

  it('keeps the collapsed sidebar reopen control inside the left rail', () => {
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        selectedObjects={[]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Collapse sidebar/i }));

    const expandButton = screen.getByRole('button', { name: /Expand sidebar/i });
    expect(expandButton).toHaveClass('w-11');
    expect(expandButton).not.toHaveClass('absolute');

    fireEvent.click(expandButton);

    expect(screen.getByRole('button', { name: /Collapse sidebar/i })).toBeInTheDocument();
  });

  it.each([500, 1000])('starts collapsed at a %ipx viewport', (width) => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: width,
    });

    try {
      render(
        <Sidebar
          activeTab="workspace"
          {...baseProps}
          selectedObjects={[]}
        />
      );

      expect(screen.getByRole('button', { name: /Expand sidebar/i })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: originalInnerWidth,
      });
    }
  });

  it.each([
    ['the default pipeline', undefined],
    ['a custom pipeline', {
      schemaVersion: 1,
      id: 'custom-study-design-view',
      name: 'Custom Study View',
      tabs: [
        { id: 'study-design', label: 'Alternate study design', moduleKey: 'conditionComparison' },
        { id: 'inspect', label: 'Inspect object', moduleKey: 'inspectObject' },
      ],
    }],
  ])('shows one selected Study Design destination for %s', (_pipelineName, activePipeline) => {
    const { container } = render(
      <Sidebar
        activeTab="study-design"
        {...baseProps}
        activePipeline={activePipeline}
        workspaces={[{
          id: 'ws-1',
          name: 'Test WS',
          type: 'personal',
          projects: [{ id: 'proj_1', name: 'Project', role: 'owner' }],
          selectedProjectId: 'proj_1',
          objects: [{ id: 'ao_abc123' }],
          selectedObjectIds: ['ao_abc123'],
        }]}
        selectedObjects={[{ id: 'ao_abc123' }]}
      />
    );

    const studyDesignLinks = screen.getAllByRole('button', { name: /Study Design/i });
    expect(studyDesignLinks).toHaveLength(1);
    expect(studyDesignLinks[0]).toHaveClass('bg-primary/10');
    expect(container.querySelectorAll('button.bg-primary\\/10')).toHaveLength(1);
    if (activePipeline) {
      expect(screen.getByRole('button', { name: /Inspect object/i })).toBeInTheDocument();
    }
  });

  it('dismisses the narrow drawer with its backdrop or Escape and restores focus', () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1000 });
    try {
      render(<div><Sidebar activeTab="workspace" {...baseProps} selectedObjects={[{ id: 'ao_abc123' }]} />
        <main><button>Page action</button></main></div>);
      const main = screen.getByRole('main');
      fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
      expect(main.inert).toBe(true);
      expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Close navigation overlay' }));
      expect(main.inert).not.toBe(true);
      expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus();
      expect(screen.queryByRole('button', { name: /Quality Control/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Collapse sidebar' }), { key: 'Escape' });
      expect(main.inert).not.toBe(true);
      expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
    }
  });

  it('collapses after selecting a nav item on narrow viewports', () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 500,
    });

    const setActiveTab = vi.fn();

    try {
      render(
        <Sidebar
          activeTab="workspace"
          {...baseProps}
          setActiveTab={setActiveTab}
          selectedObjects={[{ id: 'ao_abc123' }]}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /Expand sidebar/i }));
      fireEvent.click(screen.getByRole('button', { name: /Quality Control/i }));

      expect(setActiveTab).toHaveBeenCalledWith('qc');
      expect(screen.getByRole('button', { name: /Expand sidebar/i })).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: originalInnerWidth,
      });
    }
  });

  it('moves focus to the expand control when a focused desktop drawer collapses at the narrow breakpoint', () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1200 });
    try {
      render(<Sidebar activeTab="workspace" {...baseProps} selectedObjects={[{ id: 'ao_abc123' }]} />);
      const focusedDrawerControl = screen.getByRole('button', { name: 'Collapse sidebar' });
      focusedDrawerControl.focus();
      expect(focusedDrawerControl).toHaveFocus();

      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1000 });
      fireEvent.resize(window);

      expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
    }
  });

  it('lets groups collapse while retaining the active destination when it changes', () => {
    const view = render(<Sidebar {...baseProps} activeTab="workspace" selectedObjects={[{ id: 'ao_1' }]} />);
    const explore = screen.getByRole('button', { name: 'Explore', exact: true });
    fireEvent.click(explore);
    expect(explore).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Heatmap' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Data workspace/ })).toBeInTheDocument();
    view.rerender(<Sidebar {...baseProps} activeTab="heatmap" selectedObjects={[{ id: 'ao_1' }]} />);
    expect(explore).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Heatmap' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(explore);
    expect(explore).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps phone account, theme and logout reachable in the navigation drawer', () => {
    const previousWidth = window.innerWidth;
    window.innerWidth = 390;
    const setTheme = vi.fn();
    const onLogout = vi.fn();
    const setActiveTab = vi.fn();
    try {
      render(<div><Sidebar {...baseProps} activeTab="workspace" user={{ email: 'owner@example.org' }} setTheme={setTheme} onLogout={onLogout} setActiveTab={setActiveTab} /><main>Page</main></div>);
      expect(screen.queryByRole('button', { name: 'Account security' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
      expect(screen.getByRole('dialog', { name: 'Workspace navigation' })).toHaveAttribute('aria-modal', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
      expect(setTheme).toHaveBeenCalledWith('light');
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      expect(onLogout).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole('button', { name: 'Account security' }));
      expect(setActiveTab).toHaveBeenCalledWith('account');
      expect(screen.getByRole('main').inert).not.toBe(true);
      expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus();
    } finally { window.innerWidth = previousWidth; }
  });

});
