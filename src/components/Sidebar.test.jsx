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

    // Look for Clustering button
    const clusterButton = screen.getByRole('button', { name: /Clustering/i });
    expect(clusterButton).toBeDisabled();
  });

  it('enables pipeline options when data is loaded', () => {
    render(
      <Sidebar 
        activeTab="home"
        {...baseProps}
        selectedObjects={['obj-1']} // Data loaded
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
        selectedObjects={['obj-1']}
      />
    );

    expect(screen.getByRole('button', { name: /Pathway Enrichment/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /CellChat/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Custom Script/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cell Annotation/i })).toBeDisabled();
    expect(screen.getByText(/Not implemented yet/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Coming later/i)).toHaveLength(2);
    expect(screen.getByText(/Disabled/i)).toBeInTheDocument();
  });
});
