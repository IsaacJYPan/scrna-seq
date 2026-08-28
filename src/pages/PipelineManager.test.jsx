import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PipelineManager from './PipelineManager';
import { DEFAULT_PIPELINE_ID, getDefaultPipelineManifest } from '../pipelines/pipelineRegistry';

const currentWs = {
  id: 'ws-1',
  name: 'Personal Workspace',
  type: 'personal',
  projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner' }],
  selectedProjectId: 'proj_1',
  objects: [{ id: 'ao_abc123', projectId: 'proj_1', name: 'PBMC 3k' }],
  selectedObjectIds: ['ao_abc123'],
};

function trustedManifest(id = 'trusted-inspection-view', name = 'Trusted Inspection View') {
  return {
    schemaVersion: 1,
    id,
    name,
    tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
  };
}

function trustedDefinition(manifest, id = `pipe_${manifest.id}`) {
  return {
    id,
    manifestId: manifest.id,
    projectId: null,
    visibility: 'platform',
    builtin: false,
    name: manifest.name,
    manifest,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
      getPipelineRegistryCapabilities: vi.fn(async () => ({ canPublishPipelineManifests: false })),
      publishPipelineRegistryDefinition: vi.fn(),
      listDatasets: vi.fn(async () => []),
      uploadDataset: vi.fn(),
      createProjectAnalysisObject: vi.fn(),
      createSeuratPipelineJob: vi.fn(),
      createMultiSampleSeuratPipelineJob: vi.fn(),
      createSpatialSeuratPipelineJob: vi.fn(),
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

  it('loads the per-project trusted pipeline selection and renders default modules', async () => {
    renderPipelineManager();

    expect(await screen.findByText('Approved workflows')).toBeInTheDocument();
    expect(screen.getAllByText('Standard scRNA-seq workflow').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Quality Control').length).toBeGreaterThan(0);
    expect(window.electronAPI.getProjectPipelineSelection).toHaveBeenCalledWith('proj_1');
  });

  it('keeps data upload and workflow launch read-only for project viewers', async () => {
    renderPipelineManager({
      currentWs: {
        ...currentWs,
        projects: [{ ...currentWs.projects[0], role: 'viewer' }],
      },
    });

    expect(await screen.findByText(/project is read-only for your role/i)).toBeInTheDocument();
    expect(screen.getByText(/uploads are disabled for your role/i)).toBeInTheDocument();
    expect(screen.queryByTestId('seurat-pipeline-upload')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Seurat preprocessing/i })).toBeDisabled();
    expect(window.electronAPI.uploadDataset).not.toHaveBeenCalled();
    expect(window.electronAPI.createSeuratPipelineJob).not.toHaveBeenCalled();
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

    await screen.findByText('Approved workflows');
    expect(window.electronAPI.getProjectPipelineSelection).toHaveBeenCalledWith('proj_2');
  });

  /* Publication controls intentionally remain outside the researcher interface.
  it('fails closed when publisher capability cannot be verified, even for a project owner', async () => {
    window.electronAPI.getPipelineRegistryCapabilities = vi.fn(async () => {
      throw new Error(JSON.stringify({ error: 'Capability lookup failed' }));
    });

    renderPipelineManager();

    expect(await screen.findByText(/Publisher status unavailable: Capability lookup failed/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Publish Trusted Pipeline Manifest/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Manifest JSON')).not.toBeInTheDocument();
    expect(window.electronAPI.publishPipelineRegistryDefinition).not.toHaveBeenCalled();
  });

  it('lets a verified platform developer publish a validated manifest through the global registry API', async () => {
    const manifest = trustedManifest('custom-seurat-view', 'Custom Seurat View');
    window.electronAPI.getPipelineRegistryCapabilities = vi.fn(async () => ({
      canPublishPipelineManifests: true,
    }));
    window.electronAPI.publishPipelineRegistryDefinition = vi.fn(async published =>
      trustedDefinition(published, 'pipe_abc123'));

    renderPipelineManager();

    const publish = await screen.findByRole('button', { name: 'Publish' });
    const textarea = screen.getByLabelText('Manifest JSON');
    fireEvent.change(textarea, {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(publish);

    await waitFor(() => {
      expect(window.electronAPI.publishPipelineRegistryDefinition).toHaveBeenCalledWith(expect.objectContaining({
        id: 'custom-seurat-view',
        modality: 'scrna',
      }));
    });
    const published = window.electronAPI.publishPipelineRegistryDefinition.mock.calls[0][0];
    expect(published.tabs[0]).not.toHaveProperty('routeId');
    expect(published.tabs[0]).not.toHaveProperty('componentKey');
    expect(published.tabs[0]).not.toHaveProperty('jobType');
    expect(await screen.findByText(/Published .*Custom Seurat View.* trusted registry/i)).toBeInTheDocument();
  });

  it('fails the next publication after live capability revocation and explains why the form disappeared', async () => {
    window.electronAPI.getPipelineRegistryCapabilities = vi.fn()
      .mockResolvedValueOnce({ canPublishPipelineManifests: true })
      .mockResolvedValueOnce({ canPublishPipelineManifests: false });
    window.electronAPI.publishPipelineRegistryDefinition = vi.fn(async () => {
      throw new Error(JSON.stringify({ error: 'Platform pipeline publication is not permitted.' }));
    });

    renderPipelineManager();

    const textarea = await screen.findByLabelText('Manifest JSON');
    fireEvent.change(textarea, { target: { value: JSON.stringify(trustedManifest()) } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Publication failed: Platform pipeline publication is not permitted.'
    );
    expect(screen.queryByRole('heading', { name: /Publish Trusted Pipeline Manifest/i })).not.toBeInTheDocument();
    expect(window.electronAPI.getPipelineRegistryCapabilities).toHaveBeenCalledTimes(2);
  });

  */
  it('keeps manifest publication and platform capability administration out of the researcher interface', async () => {
    window.electronAPI.getPipelineRegistryCapabilities = vi.fn(async () => ({ canPublishPipelineManifests: true }));

    renderPipelineManager();

    await screen.findByText('Approved workflows');
    expect(screen.queryByRole('heading', { name: /Publish Trusted Pipeline Manifest/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Manifest JSON')).not.toBeInTheDocument();
    expect(window.electronAPI.getPipelineRegistryCapabilities).not.toHaveBeenCalled();
    expect(window.electronAPI.publishPipelineRegistryDefinition).not.toHaveBeenCalled();
  });

  it('falls back visibly when a previously selected registry definition is unavailable', async () => {
    window.electronAPI.getProjectPipelineSelection = vi.fn(async () => ({
      projectId: 'proj_1',
      pipelineId: 'pipe_removed',
      selectionUnavailable: true,
    }));
    const onPipelineSelectionChanged = vi.fn();

    renderPipelineManager({ onPipelineSelectionChanged });

    expect(await screen.findByText(/previous workflow is no longer available/i)).toBeInTheDocument();
    expect(onPipelineSelectionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      id: DEFAULT_PIPELINE_ID,
    }));
    expect(screen.getAllByText('Standard scRNA-seq workflow').length).toBeGreaterThan(0);
  });

  it('ignores invalid global registry entries returned by a compromised or stale server', async () => {
    const invalidManifest = {
      ...trustedManifest('tampered-pipeline', 'Tampered Pipeline'),
      tabs: [{
        id: 'inspect',
        label: 'Inspect',
        moduleKey: 'inspectObject',
        endpoint: '/api/arbitrary-r',
      }],
    };
    window.electronAPI.listProjectPipelineDefinitions = vi.fn(async () => [
      trustedDefinition(invalidManifest, 'pipe_tampered'),
    ]);
    window.electronAPI.getProjectPipelineSelection = vi.fn(async () => ({
      projectId: 'proj_1',
      pipelineId: 'pipe_tampered',
    }));
    const onPipelineSelectionChanged = vi.fn();

    renderPipelineManager({ onPipelineSelectionChanged });

    expect(await screen.findByText(/invalid registry entries were ignored by the browser/i)).toBeInTheDocument();
    expect(screen.queryByText('Tampered Pipeline')).not.toBeInTheDocument();
    expect(onPipelineSelectionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      id: DEFAULT_PIPELINE_ID,
    }));
  });

  it('does not let a late response from the previous project replace the current project registry', async () => {
    const projectOneList = deferred();
    const projectOneSelection = deferred();
    const projectOneManifest = trustedManifest('project-one-view', 'Project One Pipeline');
    const projectTwoManifest = trustedManifest('project-two-view', 'Project Two Pipeline');
    const projectOneDefinition = trustedDefinition(projectOneManifest, 'pipe_project_one');
    const projectTwoDefinition = trustedDefinition(projectTwoManifest, 'pipe_project_two');
    window.electronAPI.listProjectPipelineDefinitions = vi.fn(projectId => (
      projectId === 'proj_1' ? projectOneList.promise : Promise.resolve([projectTwoDefinition])
    ));
    window.electronAPI.getProjectPipelineSelection = vi.fn(projectId => (
      projectId === 'proj_1'
        ? projectOneSelection.promise
        : Promise.resolve({ projectId: 'proj_2', pipelineId: projectTwoDefinition.id })
    ));
    const onPipelineSelectionChanged = vi.fn();
    const initial = renderPipelineManager({ onPipelineSelectionChanged });
    const projectTwoWorkspace = {
      ...currentWs,
      projects: [
        { id: 'proj_1', name: 'PBMC Project', role: 'owner' },
        { id: 'proj_2', name: 'Spatial Project', role: 'owner' },
      ],
      selectedProjectId: 'proj_2',
    };

    initial.rerender(<PipelineManager
      {...initial.props}
      currentWs={projectTwoWorkspace}
      onPipelineSelectionChanged={onPipelineSelectionChanged}
    />);

    expect(await screen.findAllByText('Project Two Pipeline')).not.toHaveLength(0);
    await act(async () => {
      projectOneList.resolve([projectOneDefinition]);
      projectOneSelection.resolve({ projectId: 'proj_1', pipelineId: projectOneDefinition.id });
      await projectOneList.promise;
      await projectOneSelection.promise;
    });

    expect(screen.queryByText('Project One Pipeline')).not.toBeInTheDocument();
    expect(onPipelineSelectionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'project-two-view',
    }));
  });

  it('serializes refresh and selection so a refresh cannot capture and restore an older selection', async () => {
    const pipelineA = trustedDefinition(trustedManifest('pipeline-a', 'Pipeline A'), 'pipe_pipeline_a');
    const pipelineB = trustedDefinition(trustedManifest('pipeline-b', 'Pipeline B'), 'pipe_pipeline_b');
    window.electronAPI.listProjectPipelineDefinitions = vi.fn(async () => [pipelineA, pipelineB]);
    window.electronAPI.getProjectPipelineSelection = vi.fn(async () => ({
      projectId: 'proj_1',
      pipelineId: pipelineA.id,
    }));

    renderPipelineManager();

    const pipelineBButton = await screen.findByRole('button', { name: /Pipeline B/i });
    await waitFor(() => expect(pipelineBButton).toBeEnabled());
    const refreshList = deferred();
    const refreshSelection = deferred();
    window.electronAPI.listProjectPipelineDefinitions.mockImplementationOnce(() => refreshList.promise);
    window.electronAPI.getProjectPipelineSelection.mockImplementationOnce(() => refreshSelection.promise);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(pipelineBButton).toBeDisabled();
    fireEvent.click(pipelineBButton);
    expect(window.electronAPI.setProjectPipelineSelection).not.toHaveBeenCalled();

    await act(async () => {
      refreshList.resolve([pipelineA, pipelineB]);
      refreshSelection.resolve({ projectId: 'proj_1', pipelineId: pipelineA.id });
      await Promise.all([refreshList.promise, refreshSelection.promise]);
    });

    await waitFor(() => expect(pipelineBButton).toBeEnabled());
  });

  it('clears an obsolete selection operation when the active project changes', async () => {
    const projectOneA = trustedDefinition(trustedManifest('project-one-a', 'Project One A'), 'pipe_project_one_a');
    const projectOneB = trustedDefinition(trustedManifest('project-one-b', 'Project One B'), 'pipe_project_one_b');
    const projectTwoA = trustedDefinition(trustedManifest('project-two-a', 'Project Two A'), 'pipe_project_two_a');
    const projectTwoB = trustedDefinition(trustedManifest('project-two-b', 'Project Two B'), 'pipe_project_two_b');
    const pendingSelection = deferred();
    window.electronAPI.listProjectPipelineDefinitions = vi.fn(async projectId => (
      projectId === 'proj_1' ? [projectOneA, projectOneB] : [projectTwoA, projectTwoB]
    ));
    window.electronAPI.getProjectPipelineSelection = vi.fn(async projectId => ({
      projectId,
      pipelineId: projectId === 'proj_1' ? projectOneA.id : projectTwoA.id,
    }));
    window.electronAPI.setProjectPipelineSelection = vi.fn(() => pendingSelection.promise);
    const onPipelineSelectionChanged = vi.fn();
    const initial = renderPipelineManager({ onPipelineSelectionChanged });

    fireEvent.click(await screen.findByRole('button', { name: /Project One B/i }));
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();

    initial.rerender(<PipelineManager
      {...initial.props}
      currentWs={{
        ...currentWs,
        projects: [
          { id: 'proj_1', name: 'PBMC Project', role: 'owner' },
          { id: 'proj_2', name: 'Spatial Project', role: 'owner' },
        ],
        selectedProjectId: 'proj_2',
      }}
      onPipelineSelectionChanged={onPipelineSelectionChanged}
    />);

    const projectTwoBButton = await screen.findByRole('button', { name: /Project Two B/i });
    await waitFor(() => expect(projectTwoBButton).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();

    await act(async () => {
      pendingSelection.resolve({
        projectId: 'proj_1',
        pipelineId: projectOneB.id,
        definition: projectOneB,
      });
      await pendingSelection.promise;
    });

    expect(screen.queryByText('Project One B')).not.toBeInTheDocument();
    expect(onPipelineSelectionChanged).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'project-two-a',
    }));
  });

  it('labels the supported Seurat pipeline format and rejects unsupported uploads before API contact', async () => {
    renderPipelineManager();

    expect(await screen.findByTestId('seurat-pipeline-panel')).toHaveTextContent(/10x Genomics filtered feature-barcode matrix HDF5/i);
    expect(screen.getByTestId('seurat-pipeline-panel')).toHaveTextContent(/10x HDF5/i);

    const input = screen.getByTestId('seurat-pipeline-upload');
    const file = new File(['not-h5'], 'counts.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/Unsupported for this pipeline/i)).toBeInTheDocument();
    expect(window.electronAPI.uploadDataset).not.toHaveBeenCalled();
  });

  it('uploads a classic Visium bundle and launches the spatial Seurat workflow', async () => {
    window.electronAPI.uploadDataset = vi.fn(async () => ({
      id: 'ds_spatial123',
      fileType: 'visium_zip',
      originalFilename: 'sample_outs.zip',
      uploadStatus: 'uploaded',
      validationStatus: 'valid',
    }));
    window.electronAPI.createProjectAnalysisObject = vi.fn(async () => ({
      id: 'ao_spatial_input',
      projectId: 'proj_1',
      datasetId: 'ds_spatial123',
      objectType: 'matrix',
      displayName: 'sample_outs raw dataset',
      metadata: {},
    }));
    window.electronAPI.createSpatialSeuratPipelineJob = vi.fn(async () => ({
      id: 'job_spatial123',
      status: 'queued',
      jobType: 'spatial.seurat.v1',
      datasetId: 'ds_spatial123',
      analysisObjectId: 'ao_spatial_input',
    }));

    renderPipelineManager({
      currentWs: { ...currentWs, objects: [], selectedObjectIds: [] },
      datasetInfo: null,
    });

    fireEvent.click(await screen.findByRole('button', { name: /Spatial transcriptomics/i }));
    await waitFor(() => {
      expect(window.electronAPI.listDatasets).toHaveBeenCalledWith('proj_1', { fileType: 'visium_zip' });
    });
    expect(screen.getByTestId('seurat-pipeline-panel')).toHaveTextContent(/Visium HD and Xenium are not accepted/i);

    fireEvent.change(screen.getByTestId('seurat-pipeline-upload'), {
      target: { files: [new File(['zip'], 'sample_outs.zip', { type: 'application/zip' })] },
    });
    expect(await screen.findByText('sample_outs.zip')).toBeInTheDocument();
    expect(window.electronAPI.uploadDataset).toHaveBeenCalledWith(
      'proj_1',
      expect.any(File),
      expect.objectContaining({ supportedWorkflow: 'spatial.seurat.v1' }),
      'visium_zip'
    );

    fireEvent.click(screen.getByRole('button', { name: /Run spatial Seurat preprocessing/i }));
    await waitFor(() => {
      expect(window.electronAPI.createProjectAnalysisObject).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          datasetId: 'ds_spatial123',
          metadata: expect.objectContaining({
            sourceType: 'classic_visium_dataset',
            supportedWorkflow: 'spatial.seurat.v1',
          }),
        })
      );
      expect(window.electronAPI.createSpatialSeuratPipelineJob).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          datasetId: 'ds_spatial123',
          analysisObjectId: 'ao_spatial_input',
        })
      );
    });
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
    expect(screen.getByTestId('seurat-pipeline-panel')).toHaveTextContent(/10x HDF5 · Checking data/i);
    expect(screen.getByTestId('seurat-pipeline-panel')).not.toHaveTextContent(/ds_abc123|tenx_h5|uploaded \/ pending/i);
    expect(window.electronAPI.uploadDataset).toHaveBeenCalledWith(
      'proj_1',
      expect.any(File),
      expect.objectContaining({
        supportedWorkflow: 'seurat.pipeline.v1',
        supportedFormat: '10x Genomics filtered feature-barcode matrix HDF5 (.h5)',
      }),
      'tenx_h5'
    );

    fireEvent.click(screen.getByRole('button', { name: /Run Seurat preprocessing/i }));

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
    expect((await screen.findAllByText(/Saved analysis is ready/i)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Open saved version/i })).toBeInTheDocument();
    expect(screen.getByText(/mitochondrial filter warning/i)).toBeInTheDocument();
    expect(container.textContent || '').not.toMatch(/vault\/private|state_key|user-1:obj/i);

    const degButton = screen.getByRole('button', { name: /Continue to marker analysis/i });
    expect(degButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Open saved version/i }));
    await waitFor(() => {
      expect(window.electronAPI.createProjectJob).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          jobType: 'checkpoint.load.v1',
          analysisObjectId: 'ao_result123',
        })
      );
      expect(screen.getByRole('button', { name: /Continue to marker analysis/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /Continue to marker analysis/i }));
    expect(onSelectAnalysisObject).toHaveBeenCalledWith('proj_1', 'ao_result123');
    expect(setActiveTab).toHaveBeenCalledWith('deg');
  });

  it('uploads multiple durable sample files and launches a condition-aware Seurat preparation job', async () => {
    let uploadIndex = 0;
    window.electronAPI.uploadDataset = vi.fn(async (_projectId, file) => {
      uploadIndex += 1;
      return {
        id: `ds_multi${uploadIndex}`,
        fileType: 'tenx_h5',
        originalFilename: file.name,
        uploadStatus: 'uploaded',
        validationStatus: 'valid',
      };
    });
    window.electronAPI.createProjectAnalysisObject = vi.fn(async (_projectId, payload) => ({
      id: 'ao_multi_input',
      projectId: 'proj_1',
      datasetId: payload.datasetId,
      objectType: 'matrix',
      displayName: 'Primary multi-sample input',
      metadata: payload.metadata,
    }));
    window.electronAPI.createMultiSampleSeuratPipelineJob = vi.fn(async (_projectId, payload) => ({
      id: 'job_multi',
      status: 'queued',
      jobType: 'seurat.multisample.v1',
      datasetId: payload.samples[0].datasetId,
      analysisObjectId: payload.analysisObjectId,
      parameters: payload,
      createdAt: '2026-08-11T00:00:00.000Z',
    }));
    window.electronAPI.getProjectJob = vi.fn(async () => ({
      id: 'job_multi',
      status: 'queued',
      jobType: 'seurat.multisample.v1',
      datasetId: 'ds_multi1',
      analysisObjectId: 'ao_multi_input',
      createdAt: '2026-08-11T00:00:00.000Z',
    }));
    window.electronAPI.getProjectJobLogs = vi.fn(async () => ({ logs: [] }));
    window.electronAPI.listProjectJobArtifacts = vi.fn(async () => []);

    renderPipelineManager({
      currentWs: { ...currentWs, objects: [], selectedObjectIds: [] },
      datasetInfo: null,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Multiple conditions' }));
    const files = [
      new File(['h5'], 'control_1.h5'),
      new File(['h5'], 'control_2.h5'),
      new File(['h5'], 'treated_1.h5'),
      new File(['h5'], 'treated_2.h5'),
    ];
    fireEvent.change(screen.getByTestId('seurat-pipeline-upload'), { target: { files } });

    expect(await screen.findByText('control_1.h5')).toBeInTheDocument();
    expect(await screen.findByText('treated_2.h5')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Condition for control_1.h5'), { target: { value: 'control' } });
    fireEvent.change(screen.getByLabelText('Condition for control_2.h5'), { target: { value: 'control' } });
    fireEvent.change(screen.getByLabelText('Condition for treated_1.h5'), { target: { value: 'treated' } });
    fireEvent.change(screen.getByLabelText('Condition for treated_2.h5'), { target: { value: 'treated' } });

    expect(screen.getByText(/minimum replication gate/i)).toBeInTheDocument();
    const launch = screen.getByRole('button', { name: /Prepare multi-condition analysis/i });
    fireEvent.change(screen.getByLabelText('Donor code for control_1.h5'), { target: { value: 'donor/1' } });
    expect(launch).toBeDisabled();
    expect(screen.getByText(/Labels must be 1-80 characters/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Donor code for control_1.h5'), { target: { value: 'donor_1' } });
    expect(launch).toBeEnabled();
    fireEvent.click(launch);

    await waitFor(() => {
      expect(window.electronAPI.createProjectAnalysisObject).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          datasetId: 'ds_multi1',
          metadata: expect.objectContaining({
            sourceType: 'tenx_h5_multisample_dataset',
            supportedWorkflow: 'seurat.multisample.v1',
          }),
        })
      );
      expect(window.electronAPI.createMultiSampleSeuratPipelineJob).toHaveBeenCalledWith(
        'proj_1',
        expect.objectContaining({
          analysisObjectId: 'ao_multi_input',
          samples: [
            expect.objectContaining({ datasetId: 'ds_multi1', sampleName: 'control_1', conditionName: 'control' }),
            expect.objectContaining({ datasetId: 'ds_multi2', sampleName: 'control_2', conditionName: 'control' }),
            expect.objectContaining({ datasetId: 'ds_multi3', sampleName: 'treated_1', conditionName: 'treated' }),
            expect.objectContaining({ datasetId: 'ds_multi4', sampleName: 'treated_2', conditionName: 'treated' }),
          ],
        })
      );
    });
  });
});
