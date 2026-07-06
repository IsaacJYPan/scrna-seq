import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PipelineManager from './PipelineManager';
import { getDefaultPipelineManifest } from '../pipelines/pipelineRegistry';

const currentWs = {
  id: 'ws-1',
  name: 'Personal Workspace',
  type: 'personal',
  projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner' }],
  selectedProjectId: 'proj_1',
  objects: [{ id: 'ao_abc123', projectId: 'proj_1', name: 'PBMC 3k' }],
  selectedObjectIds: ['ao_abc123'],
};

function renderPipelineManager(overrides = {}) {
  const props = {
    currentWs,
    datasetInfo: { id: 'ao_abc123', projectId: 'proj_1' },
    activePipeline: getDefaultPipelineManifest(),
    onPipelineSelectionChanged: vi.fn(),
    updateActiveWorkspace: vi.fn(),
    onSelectAnalysisObject: vi.fn(),
    setActiveTab: vi.fn(),
    ...overrides,
  };
  const view = render(<PipelineManager {...props} />);
  return { ...view, props };
}

describe('PipelineManager', () => {
  beforeEach(() => {
    const manifest = getDefaultPipelineManifest();
    window.electronAPI = {
      listProjectPipelineDefinitions: vi.fn(async () => [{
        id: manifest.id,
        name: manifest.name,
        visibility: 'builtin',
        manifest,
      }]),
      getProjectPipelineSelection: vi.fn(async () => ({
        projectId: 'proj_1',
        pipelineId: manifest.id,
        definition: { id: manifest.id, name: manifest.name, manifest },
      })),
      setProjectPipelineSelection: vi.fn(async (_projectId, pipelineId) => ({
        projectId: 'proj_1',
        pipelineId,
        definition: { id: manifest.id, name: manifest.name, manifest },
      })),
      createProjectPipelineDefinition: vi.fn(async (_projectId, payload) => ({
        id: 'pipe_abc123',
        name: payload.manifest.name,
        visibility: payload.visibility,
        manifest: payload.manifest,
      })),
      listDatasets: vi.fn(async () => []),
      uploadDataset: vi.fn(),
      createProjectAnalysisObject: vi.fn(),
      createSeuratPipelineJob: vi.fn(),
      createProjectJob: vi.fn(),
      getProjectJob: vi.fn(),
      getProjectAnalysisObject: vi.fn(),
      getProjectJobLogs: vi.fn(),
      listProjectJobArtifacts: vi.fn(),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('loads the user-project pipeline selection and renders default modules', async () => {
    renderPipelineManager();

    expect(await screen.findByText('Pipeline Manager')).toBeInTheDocument();
    expect(screen.getAllByText('Default Seurat scRNA-seq Pipeline').length).toBeGreaterThan(0);
    expect(screen.getByText('Quality Control')).toBeInTheDocument();
    expect(window.electronAPI.getProjectPipelineSelection).toHaveBeenCalledWith('proj_1');
  });

  it('uses the workspace-selected project for user-project pipeline selection', async () => {
    renderPipelineManager({
      currentWs: {
        ...currentWs,
        projects: [
          { id: 'proj_1', name: 'PBMC Project', role: 'owner' },
          { id: 'proj_2', name: 'Spatial Project', role: 'owner' },
        ],
        selectedProjectId: 'proj_2',
      },
      datasetInfo: { id: 'ao_abc123', projectId: 'proj_1' },
    });

    await screen.findByText('Pipeline Manager');
    expect(window.electronAPI.getProjectPipelineSelection).toHaveBeenCalledWith('proj_2');
  });

  it('validates and uploads declarative manifests through the project pipeline API', async () => {
    renderPipelineManager();

    const upload = await screen.findByRole('button', { name: /Upload/i });
    const textarea = screen.getByPlaceholderText(/\{"schemaVersion":1/i);
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          schemaVersion: 1,
          id: 'custom-seurat-view',
          name: 'Custom Seurat View',
          tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
        }),
      },
    });
    fireEvent.click(upload);

    await waitFor(() => {
      expect(window.electronAPI.createProjectPipelineDefinition).toHaveBeenCalledWith('proj_1', expect.objectContaining({
        visibility: 'user',
        manifest: expect.objectContaining({ id: 'custom-seurat-view' }),
      }));
    });
  });

  it('labels the supported Seurat pipeline format and rejects unsupported uploads before API contact', async () => {
    renderPipelineManager();

    expect(await screen.findByTestId('seurat-pipeline-panel')).toHaveTextContent(/10x Genomics filtered feature-barcode matrix HDF5/i);
    expect(screen.getByTestId('seurat-pipeline-panel')).toHaveTextContent(/10x \.h5 only/i);

    const input = screen.getByTestId('seurat-pipeline-upload');
    const file = new File(['not-h5'], 'counts.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/Unsupported for this pipeline/i)).toBeInTheDocument();
    expect(window.electronAPI.uploadDataset).not.toHaveBeenCalled();
  });

  it('uploads a supported 10x HDF5 dataset, launches seurat.pipeline.v1, and reaches durable DEG handoff', async () => {
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

    const { container } = renderPipelineManager({
      currentWs: {
        ...currentWs,
        objects: [],
        selectedObjectIds: [],
      },
      datasetInfo: null,
      onSelectAnalysisObject,
      setActiveTab,
    });

    fireEvent.change(await screen.findByTestId('seurat-pipeline-upload'), {
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
