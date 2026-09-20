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

  it('shows one capability-gated advanced-analysis entry when the deployment does not configure it', () => {
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
    advancedAnalysisButtons.forEach(button => expect(button).toBeDisabled());
    expect(advancedAnalysisButtons.every(button => button.getAttribute('aria-label') === 'Advanced analysis, Not enabled for this deployment')).toBe(true);
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

    const workbench = screen.getByRole('button', { name: /Analysis workspace, Project selected/i });
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
    expect(expandButton).toHaveClass('w-12');
    expect(expandButton).not.toHaveClass('absolute');

    fireEvent.click(expandButton);

    expect(screen.getByRole('button', { name: /Collapse sidebar/i })).toBeInTheDocument();
  });

  it('starts collapsed on narrow viewports', () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 500,
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
});
