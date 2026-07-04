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

  it('labels the supported Seurat pipeline format and rejects unsupported uploads before API contact', async () => {
    renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
      },
    });

    expect(screen.getByTestId('seurat-pipeline-panel')).toHaveTextContent(/10x Genomics filtered feature-barcode matrix HDF5/i);
    expect(screen.getByTestId('seurat-pipeline-panel')).toHaveTextContent(/10x \.h5 only/i);

    const input = screen.getByTestId('seurat-pipeline-upload');
    const file = new File(['not-h5'], 'counts.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/Unsupported for this pipeline/i)).toBeInTheDocument();
    expect(window.electronAPI.uploadDataset).not.toHaveBeenCalled();
  });

  it('uploads a supported 10x HDF5 dataset, launches seurat.pipeline.v1, and reaches durable DEG handoff', async () => {
    window.electronAPI.listDatasets = vi.fn(async () => []);
    window.electronAPI.uploadDataset = vi.fn(async () => ({
      id: 'ds_abc123',
      fileType: 'tenx_h5',
      originalFilename: 'filtered_feature_bc_matrix.h5',
      uploadStatus: 'uploaded',
      validationStatus: 'pending',
    }));
    window.electronAPI.createProjectAnalysisObject = vi.fn(async () => ({
      id: 'ao_input123',
      projectId: 'proj_1',
      datasetId: 'ds_abc123',
      objectType: 'matrix',
      displayName: 'filtered_feature_bc_matrix raw dataset',
      metadata: { source: 'dataset', sourceType: 'tenx_h5_dataset' },
    }));
    window.electronAPI.createSeuratPipelineJob = vi.fn(async () => ({
      id: 'job_pipeline123',
      status: 'queued',
      jobType: 'seurat.pipeline.v1',
      datasetId: 'ds_abc123',
      analysisObjectId: 'ao_input123',
      parameters: { minCells: 3, minFeatures: 200 },
      createdAt: '2026-07-02T00:00:00.000Z',
    }));
    window.electronAPI.createProjectJob = vi.fn(async () => ({
      id: 'job_load123',
      status: 'queued',
      jobType: 'checkpoint.load.v1',
      analysisObjectId: 'ao_result123',
      parameters: {},
    }));
    window.electronAPI.getProjectJob = vi.fn(async (_projectId, jobId) => {
      if (jobId === 'job_load123') {
        return {
          id: 'job_load123',
          status: 'completed',
          jobType: 'checkpoint.load.v1',
          analysisObjectId: 'ao_result123',
          parameters: {},
        };
      }
      return {
        id: 'job_pipeline123',
        status: 'completed',
        jobType: 'seurat.pipeline.v1',
        datasetId: 'ds_abc123',
        analysisObjectId: 'ao_input123',
        resultAnalysisObjectId: 'ao_result123',
        parameters: { minCells: 3, minFeatures: 200 },
      };
    });
    window.electronAPI.getProjectAnalysisObject = vi.fn(async () => ({
      id: 'ao_result123',
      projectId: 'proj_1',
      datasetId: 'ds_abc123',
      objectType: 'seurat',
      displayName: 'Seurat pipeline result',
      metadata: { source: 'seurat.pipeline.v1', summary: { n_cells: 2700, n_features: 13714 } },
    }));
    window.electronAPI.getProjectJobLogs = vi.fn(async () => ({
      logs: [{ ts: '2026-07-02T00:01:00.000Z', level: 'info', message: 'Completed checkpoint vault/private/object.rds state_key user-1:obj-ao_result123' }],
    }));
    window.electronAPI.listProjectJobArtifacts = vi.fn(async () => [
      {
        id: 'artifact_summary',
        artifactType: 'object_summary',
        resultAnalysisObjectId: 'ao_result123',
        metadata: { summary: { cells: 2700, features: 13714, reductions: 'pca, umap' }, warnings: ['mitochondrial filter warning'] },
      },
      { id: 'artifact_checkpoint', artifactType: 'checkpoint', resultAnalysisObjectId: 'ao_result123' },
    ]);
    const onSelectAnalysisObject = vi.fn();
    const setActiveTab = vi.fn();

    const { container } = renderWorkspace({
      currentWs: {
        ...baseWorkspace,
        projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
        selectedProjectId: 'proj_1',
        objects: [],
        selectedObjectIds: [],
      },
      onSelectAnalysisObject,
      setActiveTab,
    });

    fireEvent.change(screen.getByTestId('seurat-pipeline-upload'), {
      target: { files: [new File(['h5'], 'filtered_feature_bc_matrix.h5', { type: 'application/octet-stream' })] },
    });

    expect(await screen.findByText('filtered_feature_bc_matrix.h5')).toBeInTheDocument();
    expect(window.electronAPI.uploadDataset).toHaveBeenCalledWith(
      'proj_1',
      expect.any(File),
      expect.objectContaining({
        supportedWorkflow: 'seurat.pipeline.v1',
        supportedFormat: '10x Genomics filtered feature-barcode matrix HDF5 (.h5)',
      }),
      'tenx_h5'
    );

    fireEvent.click(screen.getByRole('button', { name: /Launch durable Seurat pipeline/i }));

    await waitFor(() => {
      expect(window.electronAPI.createProjectAnalysisObject).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          datasetId: 'ds_abc123',
          objectType: 'matrix',
          metadata: expect.objectContaining({
            sourceType: 'tenx_h5_dataset',
            supportedWorkflow: 'seurat.pipeline.v1',
          }),
        })
      );
      expect(window.electronAPI.createSeuratPipelineJob).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          datasetId: 'ds_abc123',
          analysisObjectId: 'ao_input123',
          params: expect.objectContaining({
            minCells: 3,
            minFeatures: 200,
            maxPercentMt: 5,
            normalizationMethod: 'LogNormalize',
            clusterResolution: 0.8,
          }),
        })
      );
    });
    expect(JSON.stringify(window.electronAPI.createProjectAnalysisObject.mock.calls)).not.toMatch(/storage|path|state/i);
    expect((await screen.findAllByText('ao_result123')).length).toBeGreaterThan(0);
    expect(screen.getByText('artifact_checkpoint')).toBeInTheDocument();
    expect(screen.getByText(/mitochondrial filter warning/i)).toBeInTheDocument();
    expect(container.textContent || '').not.toMatch(/vault\/private|state_key|user-1:obj/i);

    const degButton = screen.getByRole('button', { name: /Continue to durable DEG/i });
    expect(degButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Load checkpoint/i }));
    await waitFor(() => {
      expect(window.electronAPI.createProjectJob).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          jobType: 'checkpoint.load.v1',
          analysisObjectId: 'ao_result123',
        })
      );
      expect(screen.getByRole('button', { name: /Continue to durable DEG/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /Continue to durable DEG/i }));
    expect(onSelectAnalysisObject).toHaveBeenCalledWith('proj_1', 'ao_result123');
    expect(setActiveTab).toHaveBeenCalledWith('deg');
  });
});
