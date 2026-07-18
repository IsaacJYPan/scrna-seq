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

    // Look for Quality Control button
    const qcButton = screen.getByRole('button', { name: /Quality Control/i });
    expect(qcButton).toBeDisabled();

    // Look for Cluster button
    const clusterButton = screen.getByRole('button', { name: /Cluster/i });
    expect(clusterButton).toBeDisabled();
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

    // QC should be enabled since data is loaded (whether done or not, it should be clickable if prev steps done or it's the first step)
    // Wait, let's verify if QC is enabled. The Sidebar logic might disable it if there are NO objects, but enabled if there are.
    const qcButton = screen.getByRole('button', { name: /Quality Control/i });
    expect(qcButton).not.toBeDisabled();
  });

  it('shows integrated pathway enrichment while keeping future scientific features hidden', () => {
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        selectedObjects={[{ id: 'ao_abc123' }]}
      />
    );

    expect(screen.getByRole('button', { name: /Pathway Enrichment/i })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /CellChat/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Custom Script/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cell Annotation/i })).not.toBeInTheDocument();
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

    expect(screen.getByRole('button', { name: /Pipeline Manager, User scoped/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Collaborators, Project RBAC/i })).not.toBeDisabled();
    expect(screen.queryByText(/Demo only/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Default Seurat scRNA-seq Pipeline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Markers \/ DEG/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Jobs & Artifacts/i })).not.toBeDisabled();
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

    expect(screen.getByRole('button', { name: /Integration, Local development only/i })).toBeDisabled();
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

    const workbench = screen.getByRole('button', { name: /Workbench, Backend project/i });
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
