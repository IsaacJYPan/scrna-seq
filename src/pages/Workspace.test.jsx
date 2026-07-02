import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Workspace from './Workspace';

const baseWorkspace = {
  id: 'ws-personal-1',
  name: 'Personal Workspace',
  type: 'personal',
  projects: [],
  objects: [],
  selectedProjectId: null,
  selectedObjectIds: [],
  activeBranch: 'main',
  branches: { main: null },
};

function renderWorkspace(overrides = {}) {
  const props = {
    callApi: vi.fn(),
    datasetInfo: null,
    setDataVersion: vi.fn(),
    openProvenance: vi.fn(),
    currentWs: baseWorkspace,
    updateActiveWorkspace: vi.fn(),
    workspaces: [baseWorkspace],
    setWorkspaces: vi.fn(),
    activeWsIndex: 0,
    setActiveWsIndex: vi.fn(),
    resetPipelineAfterSubset: vi.fn(),
    setActiveTab: vi.fn(),
    userEmail: 'scientist@example.com',
    pipelineState: { qc: false, normalize: false, pca: false, cluster: false, umap: false },
    sessionReady: true,
    rSessionId: 'mock-session',
    backendModelStatus: { projectsLoading: false, objectsLoading: false, error: null },
    onSelectProject: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateAnalysisObjectForLoad: vi.fn(),
    onAnalysisObjectLoaded: vi.fn(),
    onSelectAnalysisObject: vi.fn(),
    ...overrides,
  };
  const view = render(<Workspace {...props} />);
  return { ...view, props };
}

describe('Workspace backend-backed project/object UI', () => {
  beforeEach(() => {
    window.electronAPI = {
      apiRequest: vi.fn(async () => ({
        result: { cells: 2700, features: 13714, genes: 13714, density: 2.4 },
      })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('does not show a fake Default Project when no backend projects exist', () => {
    renderWorkspace();

    expect(screen.getByText('No backend projects')).toBeInTheDocument();
    expect(screen.getByText(/Create a real backend project/i)).toBeInTheDocument();
    expect(screen.queryByText('Default Project')).not.toBeInTheDocument();
    expect(screen.queryByText('proj-default')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load Object/i })).toBeDisabled();
  });

  it('shows DB-backed analysis objects returned for the selected backend project after refresh', () => {
    renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
        objects: [{
          id: 'ao_abc123',
          projectId: 'proj_1',
          name: 'PBMC 3k',
          objectType: 'seurat',
          cells: 2700,
          features: 13714,
          source: 'pbmc3k_demo',
          timestamp: '2026-06-30T00:00:00.000Z',
          isBackendAnalysisObject: true,
          liveState: 'unknown',
        }],
        selectedObjectIds: ['ao_abc123'],
      },
    });

    expect(screen.getAllByText('PBMC Project').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PBMC 3k').length).toBeGreaterThan(0);
    expect(screen.getByText(/2,700 cells/i)).toBeInTheDocument();
    expect(screen.getByText('Pipeline Workbench')).toBeInTheDocument();
    expect(screen.getAllByText(/DB-backed object/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Live R: not attached/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No Objects in Project/i)).not.toBeInTheDocument();
  });

  it('shows attached live-R state separately from durable DB-backed object identity', () => {
    renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
        objects: [{
          id: 'ao_live123',
          projectId: 'proj_1',
          name: 'Attached PBMC',
          objectType: 'seurat',
          cells: 2700,
          features: 13714,
          timestamp: '2026-06-30T00:00:00.000Z',
          isBackendAnalysisObject: true,
          liveState: 'attached',
        }],
        selectedObjectIds: ['ao_live123'],
      },
      pipelineState: { qc: true, normalize: false, pca: false, cluster: false, umap: false },
    });

    expect(screen.getByText(/Attached this session/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Live R: attached/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Durable metadata/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Project membership does not grant live R object access/i)).toBeInTheDocument();
  });

  it('does not treat an unselected project object as the active workflow object', () => {
    renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
        objects: [{
          id: 'ao_unselected',
          projectId: 'proj_1',
          name: 'Unselected PBMC',
          objectType: 'seurat',
          cells: 2700,
          features: 13714,
          isBackendAnalysisObject: true,
          liveState: 'unknown',
        }],
        selectedObjectIds: [],
      },
    });

    expect(screen.getByText(/No analysis object selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Select a DB-backed analysis object from the project list below/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Select object/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Data Info: Unselected PBMC/i)).not.toBeInTheDocument();
  });

  it('creates a backend analysis object before PBMC demo load and calls R with that verified object ID', async () => {
    const onCreateAnalysisObjectForLoad = vi.fn(async () => ({
      id: 'ao_demo123',
      projectId: 'proj_1',
      objectType: 'seurat',
      displayName: 'PBMC_3k_Tutorial',
      metadata: { sourceType: 'pbmc3k_demo' },
    }));
    const onAnalysisObjectLoaded = vi.fn();

    renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
      },
      onCreateAnalysisObjectForLoad,
      onAnalysisObjectLoaded,
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Load Object/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /PBMC 3k Demo Dataset/i }));

    await waitFor(() => {
      expect(onCreateAnalysisObjectForLoad).toHaveBeenCalledWith({
        projectId: 'proj_1',
        displayName: 'PBMC_3k_Tutorial',
        sourceType: 'pbmc3k_demo',
        metadata: { minCells: 3, minFeatures: 200 },
      });
    });
    expect(window.electronAPI.apiRequest).toHaveBeenCalledWith(
      '/load-data?min_cells=3&min_features=200',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Object-ID': 'ao_demo123' }),
      })
    );
    await waitFor(() => {
      expect(onAnalysisObjectLoaded).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({ id: 'ao_demo123', displayName: 'PBMC_3k_Tutorial' }),
        expect.objectContaining({ cells: 2700, features: 13714 })
      );
    });
  });
});
