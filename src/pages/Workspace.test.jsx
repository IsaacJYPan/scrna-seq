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
      listDatasets: vi.fn(async () => []),
      uploadDataset: vi.fn(),
      createSeuratPipelineJob: vi.fn(),
      getProjectJob: vi.fn(),
      getProjectJobLogs: vi.fn(),
      listProjectJobArtifacts: vi.fn(),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('does not show a fake Default Project when no projects exist', () => {
    renderWorkspace();

    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText(/Create a project before loading a saved analysis/i)).toBeInTheDocument();
    expect(screen.queryByText('Default Project')).not.toBeInTheDocument();
    expect(screen.queryByText('proj-default')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add analysis/i })).not.toBeInTheDocument();
  });

  it('keeps analysis creation controls read-only for project viewers', () => {
    renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'Shared Project', role: 'viewer', isBackendProject: true }],
        selectedProjectId: 'proj_1',
      },
    });

    expect(screen.getAllByRole('button', { name: /Add analysis/i })).toHaveLength(1);
    for (const button of screen.getAllByRole('button', { name: /Add analysis/i })) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(screen.getAllByText(/project role is read-only/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Load analysis/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /Load saved analysis/i })).not.toBeInTheDocument();
  });

  it('shows saved analyses returned for the selected project after refresh', () => {
    const { container } = renderWorkspace({
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
    expect(screen.getByRole('region', { name: 'Current analysis' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Saved analyses 1' })).toBeInTheDocument();
    expect(screen.getAllByText(/Open a saved version/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No Objects in Project/i)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/ao_abc123|pbmc3k_demo|DB-backed|Live R/i);
  });

  it('shows workspace readiness without exposing runtime implementation state', () => {
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

    expect(screen.getAllByText(/Ready in your workspace/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Open Normalize' })).toBeEnabled();
    expect(screen.getByText(/Your live workspace is private/i)).toBeInTheDocument();
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

    expect(screen.getByText(/No analysis selected/i)).toBeInTheDocument();
    expect(screen.getByText(/Select a saved analysis from the project list below/i)).toBeInTheDocument();
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

    fireEvent.click(screen.getAllByRole('button', { name: /Add analysis/i })[0]);
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

  it('surfaces a failed PBMC live load as a recoverable selected object', async () => {
    const onCreateAnalysisObjectForLoad = vi.fn(async () => ({
      id: 'ao_failed123',
      projectId: 'proj_1',
      objectType: 'seurat',
      displayName: 'PBMC_3k_Tutorial',
      metadata: { sourceType: 'pbmc3k_demo' },
    }));
    const onAnalysisObjectLoadFailed = vi.fn();
    window.electronAPI.apiRequest.mockResolvedValueOnce({ error: 'C:\\private\\Rscript.exe failed for job_unsafe_123' });

    renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
      },
      onCreateAnalysisObjectForLoad,
      onAnalysisObjectLoadFailed,
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Add analysis/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /PBMC 3k Demo Dataset/i }));

    await waitFor(() => {
      expect(onAnalysisObjectLoadFailed).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({ id: 'ao_failed123' })
      );
    });
    expect(screen.getByText(/PBMC demo could not be opened/i)).toBeInTheDocument();
    expect(screen.queryByText(/private\\Rscript|job_unsafe/i)).not.toBeInTheDocument();
  });

  it('retries the selected PBMC demo with the same verified object ID', async () => {
    const onCreateAnalysisObjectForLoad = vi.fn();
    const onAnalysisObjectLoaded = vi.fn();
    renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
        objects: [{
          id: 'ao_demo123',
          projectId: 'proj_1',
          ownerUserId: 7,
          name: 'PBMC_3k_Tutorial',
          objectType: 'seurat',
          source: 'pbmc3k_demo',
          metadata: { sourceType: 'pbmc3k_demo', minCells: 3, minFeatures: 200 },
          isBackendAnalysisObject: true,
          liveState: 'unknown',
        }],
        selectedObjectIds: ['ao_demo123'],
      },
      userId: 7,
      onCreateAnalysisObjectForLoad,
      onAnalysisObjectLoaded,
    });

    fireEvent.click(screen.getByRole('button', { name: /Reload PBMC demo/i }));

    await waitFor(() => {
      expect(window.electronAPI.apiRequest).toHaveBeenCalledWith(
        '/load-data?min_cells=3&min_features=200',
        expect.objectContaining({ headers: { 'X-Object-ID': 'ao_demo123' } })
      );
    });
    expect(onCreateAnalysisObjectForLoad).not.toHaveBeenCalled();
    expect(onAnalysisObjectLoaded).toHaveBeenCalledWith(
      'proj_1',
      expect.objectContaining({ id: 'ao_demo123' }),
      expect.objectContaining({ cells: 2700, features: 13714 })
    );
  });

  it('routes production imports to the durable Pipeline Manager and hides blocked local loaders', () => {
    const { props } = renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
      },
      deploymentPolicy: {
        legacyLocalImportsEnabled: false,
        legacyLiveMutationToolsEnabled: false,
      },
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Add analysis/i })[0]);
    expect(screen.getByRole('button', { name: /PBMC 3k Demo Dataset/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /10X H5 analysis workflow/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Local 10X Directory/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Multiple 10X Directories/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Seurat RDS Object/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /H5AD \/ H5Seurat/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /10X H5 analysis workflow/i }));
    expect(props.setActiveTab).toHaveBeenCalledWith('pipeline-manager');
  });

});
