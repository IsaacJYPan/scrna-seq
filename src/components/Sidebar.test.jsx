import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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

  it('marks non-integrated scientific features as disabled future actions', () => {
    render(
      <Sidebar
        activeTab="workspace"
        {...baseProps}
        selectedObjects={[{ id: 'ao_abc123' }]}
      />
    );

    expect(screen.getByRole('button', { name: /Pathway Enrichment/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /CellChat/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Custom Script/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cell Annotation/i })).toBeDisabled();
    expect(screen.getByText(/Not integrated/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Future workflow/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Disabled/i)).toBeInTheDocument();
  });

  it('shows pipeline foundation sections with honest backend and legacy status labels', () => {
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

    expect(screen.getByText(/Live R Pipeline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Markers \/ DEG, Legacy live-R/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Jobs & Artifacts, Read-only/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Session DAG, Transient live-R/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Full Reports, Future workflow/i })).toBeDisabled();
  });
});
