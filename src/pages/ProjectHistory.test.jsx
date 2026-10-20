import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectHistory from './ProjectHistory';

const currentWs = {
  id: 'ws-1',
  name: 'Personal Workspace',
  type: 'personal',
  projects: [{ id: 'proj_1', name: 'PBMC Project', role: 'owner', isBackendProject: true }],
  selectedProjectId: 'proj_1',
  objects: [{ id: 'ao_abc123', projectId: 'proj_1', displayName: 'PBMC 3k' }],
  selectedObjectIds: ['ao_abc123'],
};

describe('ProjectHistory', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.electronAPI = {
      listProjectJobs: vi.fn(async () => [{
        id: 'job_safe_1',
        status: 'completed',
        jobType: 'pbmc.pipeline.v1',
        analysisObjectId: 'ao_abc123',
        resultAnalysisObjectId: 'ao_result123',
        datasetId: 'ds_1',
        createdAt: '2026-06-30T00:00:00.000Z',
        storageUri: 'vault/private/job-output.rds',
        storage_uri: 'vault/private/job-output-snake.rds',
        storage_key: 'vault/private/job-key.rds',
        workerId: 'worker-internal-1',
        stateKey: 'user-101:obj-ao_abc123',
        state_key: 'user-101:obj-ao_abc123:snake',
        claim_token: 'secret-claim-token-snake',
        error: {
          code: 'R_RUNTIME_ERROR',
          message: 'Traceback at C:\\private\\stack.R for https://worker.internal/api/job_unsafe_1',
          stack: 'Error: raw R stack trace text at vault/private/stack.R:42',
        },
      }, {
        id: 'job_expert_safe_1',
        status: 'failed',
        jobType: 'expert.r.v1',
        analysisObjectId: 'ao_abc123',
        createdAt: '2026-06-30T00:01:00.000Z',
        error: {
          code: 'HANDLER_ERROR',
          message: 'The R script referenced an object or function that is not available.',
        },
      }, {
        id: 'job_cellchat_safe_1',
        status: 'failed',
        jobType: 'cellchat.infer.v1',
        analysisObjectId: 'ao_abc123',
        createdAt: '2026-06-30T00:01:30.000Z',
        error: {
          code: 'CELLCHAT_MIN_GROUP_CELLS',
          message: 'At least two groups must meet the minimum cell threshold. Lower the threshold or revise the grouping.',
        },
      }]),
      listProjectArtifacts: vi.fn(async () => [{
        id: 'artifact_safe_1',
        name: 'QC checkpoint',
        artifactType: 'checkpoint',
        status: 'available',
        storageKind: 'local_internal',
        jobId: 'job_safe_1',
        resultAnalysisObjectId: 'ao_result123',
        internalStorageKey: 'private/artifacts/checkpoint.rds',
        internal_storage_key: 'vault/private/artifacts/checkpoint-snake.rds',
        claimToken: 'secret-claim-token',
        claim_token: 'secret-claim-token-snake',
        storage_uri: 'vault/private/artifact-storage.rds',
        storage_key: 'vault/private/artifact-key.rds',
      }]),
      listProjectProvenance: vi.fn(async () => [{
        id: 'prov_safe_1',
        operation: 'deg.find_markers.v1',
        analysisObjectId: 'ao_result123',
        jobId: 'job_safe_1',
        createdAt: '2026-06-30T00:02:00.000Z',
        params: {
          storageKey: 'private/provenance.json',
          storage_key: 'vault/private/provenance-snake.json',
          state_key: 'user-101:obj-ao_result123',
          rawRStackTrace: 'raw R stack trace text: traceback() vault/private/provenance.R',
        },
      }]),
      listProjectFigures: vi.fn(async () => [{
        id: 'fig_safe_1',
        title: 'UMAP overview',
        plotType: 'UMAP',
        createdAt: '2026-06-30T00:03:00.000Z',
        filePath: '/__private_vault__/umap.png',
        storage_key: 'vault/private/figure-key.png',
      }]),
      getProjectAnalysisObjectLineage: vi.fn(async () => ({
        projectId: 'proj_1',
        objectId: 'ao_abc123',
        rootObjectId: 'ao_abc123',
        nodes: [
          {
            id: 'ao_abc123',
            label: 'PBMC 3k',
            objectType: 'seurat',
            storageUri: 'vault/private/root.rds',
            storage_uri: 'vault/private/root-snake.rds',
            objectHash: 'object-hash-secret-camel',
            object_hash: 'object-hash-secret-snake',
            state_key: 'user-101:obj-ao_abc123:lineage',
          },
          { id: 'ao_result123', label: 'Normalized PBMC', objectType: 'seurat', object_hash: 'object-hash-result-secret' },
        ],
        edges: [{
          id: 'edge_safe_1',
          parentAnalysisObjectId: 'ao_abc123',
          childAnalysisObjectId: 'ao_result123',
          edgeType: 'derived_from',
          parentRole: 'input',
          storageKey: 'private/edge.json',
          storage_key: 'vault/private/edge-snake.json',
          internal_storage_key: 'vault/private/edge-internal.json',
          claim_token: 'secret-claim-token-edge',
        }],
        truncated: false,
      })),
      createCheckpointForkJob: vi.fn(async () => ({
        id: 'job_fork_1',
        jobType: 'checkpoint.fork.v1',
        analysisObjectId: 'ao_result123',
        resultAnalysisObjectId: 'ao_fork123',
        status: 'completed',
      })),
      createCheckpointLoadJob: vi.fn(),
      retryProjectJob: vi.fn(),
      getProjectJob: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('renders researcher-safe history without leaking private runtime details', async () => {
    const { container } = render(<ProjectHistory currentWs={currentWs} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect(screen.getByText('Runs & Results')).toBeInTheDocument();
    expect(screen.getAllByText(/analysis history/i).length).toBeGreaterThan(0);
    const privacy = screen.getByText('Visibility & privacy');
    expect(privacy.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(privacy);
    expect(screen.getByText(/History access does not open another researcher’s private workspace/i)).toBeInTheDocument();
    expect(await screen.findByText('PBMC preprocessing')).toBeInTheDocument();
    expect(screen.getByText(/Inspect or import artifact files/i)).toBeInTheDocument();

    expect(screen.getByLabelText('Selected analysis counts')).toHaveTextContent('3 selected runs');
    expect(screen.getByLabelText('Selected analysis counts')).toHaveTextContent('1 selected result');
    const selectedRuns = screen.getByText('Selected Analysis Runs').closest('section');
    const selectedResults = screen.getByText('Selected Analysis Results').closest('section');
    const runMonitor = screen.getByRole('region', { name: 'Run monitoring' });
    expect(selectedRuns.compareDocumentPosition(selectedResults) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(selectedResults.compareDocumentPosition(runMonitor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const executionHistory = screen.getByRole('button', { name: /Execution history.*Recorded inputs/i });
    expect(executionHistory).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Execution history' })).not.toBeInTheDocument();
    fireEvent.click(executionHistory);
    expect(executionHistory).toHaveAttribute('aria-expanded', 'true');
    const executionRegion = await screen.findByRole('region', { name: 'Execution history' });
    fireEvent.click(executionHistory);
    expect(executionHistory).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('#execution-history-panel')).toHaveAttribute('hidden');
    expect(container.querySelector('#execution-history-panel [aria-label="Execution history"]')).toBe(executionRegion);

    expect(screen.getByText('Saved version')).toBeInTheDocument();
    expect(screen.getByText('Cluster marker analysis')).toBeInTheDocument();
    expect(screen.getByText('This analysis needs attention. Review the settings and try again.')).toBeInTheDocument();
    expect(screen.getByText('The R script referenced an object or function that is not available.')).toBeInTheDocument();
    expect(screen.getByText('At least two groups must meet the minimum cell threshold. Lower the threshold or revise the grouping.')).toBeInTheDocument();
    expect(screen.getByText('UMAP overview')).toBeInTheDocument();
    expect(screen.getByText(/Source analysis → derived analysis/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(window.electronAPI.listProjectJobs).toHaveBeenCalledWith('proj_1');
      expect(window.electronAPI.getProjectAnalysisObjectLineage).toHaveBeenCalledWith('proj_1', 'ao_abc123');
    });

    const text = container.textContent || '';
    expect(text).not.toMatch(/vault\/private/i);
    expect(text).not.toMatch(/vault\//i);
    expect(text).not.toMatch(/__private_vault__/i);
    expect(text).not.toMatch(/C:\\Users/i);
    expect(text).not.toMatch(/C:\/Users/i);
    expect(text).not.toMatch(/storage_uri/i);
    expect(text).not.toMatch(/internalStorageKey/i);
    expect(text).not.toMatch(/internal_storage_key/i);
    expect(text).not.toMatch(/storageKey/i);
    expect(text).not.toMatch(/storage_key/i);
    expect(text).not.toMatch(/objectHash/i);
    expect(text).not.toMatch(/object_hash/i);
    expect(text).not.toMatch(/claimToken/i);
    expect(text).not.toMatch(/claim_token/i);
    expect(text).not.toMatch(/secret-claim-token/i);
    expect(text).not.toMatch(/worker-internal/i);
    expect(text).not.toMatch(/stateKey/i);
    expect(text).not.toMatch(/state_key/i);
    expect(text).not.toMatch(/user-101:obj/i);
    expect(text).not.toMatch(/raw R stack trace text/i);
    expect(text).not.toMatch(/traceback/i);
    expect(text).not.toMatch(/object-hash-secret/i);
    expect(text).not.toMatch(/job_safe_1|artifact_safe_1|prov_safe_1|fig_safe_1/i);
    expect(text).not.toMatch(/ao_abc123|ao_result123|pbmc\.pipeline\.v1|deg\.find_markers\.v1|local_internal|\bseurat\b/i);
    expect(text).not.toMatch(/C:\\private\\stack\.R|worker\.internal|job_unsafe_1/i);
  });

  it('refreshes Runs & Results when an analysis is submitted elsewhere in the workbench', async () => {
    const props = { currentWs, datasetInfo: { id: 'ao_abc123', projectId: 'proj_1' } };
    const { rerender } = render(<ProjectHistory {...props} historyRefreshToken={0} />);

    await waitFor(() => expect(window.electronAPI.listProjectJobs).toHaveBeenCalledTimes(1));
    rerender(<ProjectHistory {...props} historyRefreshToken={1} />);
    await waitFor(() => expect(window.electronAPI.listProjectJobs).toHaveBeenCalledTimes(2));
  });

  it('distinguishes repeated R analysis outputs by their saved analysis and recorded time', async () => {
    window.electronAPI.listProjectJobs.mockResolvedValueOnce([{
      id: 'job_r_one', jobType: 'expert.r.v1', analysisObjectId: 'ao_abc123', status: 'completed', createdAt: '2026-06-30T00:00:00.000Z',
    }, {
      id: 'job_r_two', jobType: 'expert.r.v1', analysisObjectId: 'ao_abc123', status: 'completed', createdAt: '2026-07-01T00:00:00.000Z',
    }]);
    window.electronAPI.listProjectArtifacts.mockResolvedValueOnce([{
      id: 'artifact_r_one', artifactType: 'expert_r_bundle', status: 'available', storageKind: 'local_internal', jobId: 'job_r_one', createdAt: '2026-06-30T00:01:00.000Z',
    }, {
      id: 'artifact_r_two', artifactType: 'expert_r_bundle', status: 'available', storageKind: 'local_internal', jobId: 'job_r_two', createdAt: '2026-07-01T00:01:00.000Z',
    }]);

    render(<ProjectHistory currentWs={currentWs} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect(await screen.findAllByText('R analysis output')).toHaveLength(2);
    expect(screen.getAllByText('From PBMC 3k')).toHaveLength(2);
    expect(screen.getAllByText(/Recorded:/)).toHaveLength(2);
  });

  it('keeps runs for other analyses out of the selected-analysis section', async () => {
    window.electronAPI.listProjectJobs.mockResolvedValueOnce([{
      id: 'job_selected', jobType: 'pbmc.pipeline.v1', analysisObjectId: 'ao_abc123',
      ownerUserId: 7, status: 'completed', createdAt: '2026-07-01T00:00:00.000Z',
    }, {
      id: 'job_other', jobType: 'spatial.seurat.v1', analysisObjectId: 'ao_spatial',
      ownerUserId: 9, status: 'failed', createdAt: '2026-07-02T00:00:00.000Z',
      error: { code: 'HANDLER_ERROR', message: 'spatial pipeline failed' },
    }]);
    const mixedWorkspace = {
      ...currentWs,
      objects: [...currentWs.objects, {
        id: 'ao_spatial', projectId: 'proj_1', displayName: 'Visium section', ownerUserId: 9,
      }],
    };

    render(<ProjectHistory currentWs={mixedWorkspace} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} userId={7} />);

    const selectedSection = (await screen.findByText('Selected Analysis Runs')).closest('section');
    expect(within(selectedSection).getByText('PBMC preprocessing')).toBeInTheDocument();
    expect(within(selectedSection).queryByText('Spatial preprocessing')).not.toBeInTheDocument();
    expect(screen.getByText(/Other project activity \(1 runs/i)).toBeInTheDocument();
  });

  it('retries an owned failed run as a separate immutable run', async () => {
    const failed = {
      id: 'job_failed_retry',
      jobType: 'pbmc.pipeline.v1',
      analysisObjectId: 'ao_abc123',
      ownerUserId: 7,
      status: 'failed',
      createdAt: '2026-07-02T00:00:00.000Z',
      error: { code: 'HANDLER_ERROR', message: 'private failure detail' },
    };
    const retry = {
      id: 'job_retry_child',
      retryOfJobId: failed.id,
      jobType: failed.jobType,
      analysisObjectId: failed.analysisObjectId,
      ownerUserId: 7,
      status: 'queued',
      createdAt: '2026-07-02T00:01:00.000Z',
    };
    window.electronAPI.listProjectJobs
      .mockResolvedValueOnce([failed])
      .mockResolvedValueOnce([retry, failed]);
    window.electronAPI.retryProjectJob.mockResolvedValueOnce(retry);

    render(
      <ProjectHistory
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }}
        userId={7}
      />
    );

    expect(await screen.findByText(/creates a separate run from the recorded inputs/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry as new run/i }));
    await waitFor(() => {
      expect(window.electronAPI.retryProjectJob).toHaveBeenCalledWith('proj_1', failed.id);
      expect(screen.getByText(/Separate retry run:/i)).toHaveTextContent(/Waiting for compute/i);
    });
    expect(screen.getByText(/Retry of prior pbmc preprocessing run/i)).toBeInTheDocument();
    expect(screen.queryByText(/private failure detail/i)).not.toBeInTheDocument();
  });

  it('uses a generic history error when a response contains private runtime details', async () => {
    window.electronAPI.listProjectJobs.mockRejectedValueOnce(new Error(JSON.stringify({
      error: 'Traceback at C:\\private\\history.R from https://worker.internal/api/job_unsafe_2',
    })));
    const { container } = render(<ProjectHistory currentWs={currentWs} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect(await screen.findByText('Failed to load Runs & Results.')).toBeInTheDocument();
    const text = container.textContent || '';
    expect(text).not.toMatch(/C:\\private\\history\.R|worker\.internal|job_unsafe_2/i);
  });

  it('creates a private checkpoint fork and opens the new lineage child', async () => {
    const onSelectAnalysisObject = vi.fn(async () => {});
    const setActiveTab = vi.fn();
    render(
      <ProjectHistory
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }}
        onSelectAnalysisObject={onSelectAnalysisObject}
        setActiveTab={setActiveTab}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /create branch from this version/i }));
    await waitFor(() => {
      expect(window.electronAPI.createCheckpointForkJob).toHaveBeenCalledWith('proj_1', 'ao_result123');
    });

    fireEvent.click(await screen.findByRole('button', { name: /open branch/i }));
    await waitFor(() => {
      expect(onSelectAnalysisObject).toHaveBeenCalledWith('proj_1', 'ao_fork123');
      expect(setActiveTab).toHaveBeenCalledWith('workspace');
    });
    expect(screen.getByText(/source analysis and saved version remain unchanged/i)).toBeInTheDocument();
  });

  it('shows a project-scoped empty state when no project is selected', () => {
    render(<ProjectHistory currentWs={{ ...currentWs, projects: [], selectedProjectId: null }} datasetInfo={null} />);

    expect(screen.getByText(/Select a project/i)).toBeInTheDocument();
    expect(screen.getByText(/scoped to a project/i)).toBeInTheDocument();
  });

  it('does not load object lineage when no object is selected in the active project', async () => {
    render(
      <ProjectHistory
        currentWs={{ ...currentWs, selectedObjectIds: [] }}
        datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }}
      />
    );

    await waitFor(() => {
      expect(window.electronAPI.listProjectJobs).toHaveBeenCalledWith('proj_1');
    });
    expect(window.electronAPI.getProjectAnalysisObjectLineage).not.toHaveBeenCalled();
    expect(screen.getByText(/No analysis selected/i)).toBeInTheDocument();
  });

  it('keeps checkpoint forks unavailable to project viewers', async () => {
    const viewerWorkspace = {
      ...currentWs,
      projects: currentWs.projects.map(project => ({ ...project, role: 'viewer' })),
    };
    render(<ProjectHistory currentWs={viewerWorkspace} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect(await screen.findByText(/Writer role required/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create branch from this version/i })).not.toBeInTheDocument();
  });

  it('reattaches an owner-owned selected checkpoint only after its durable job completes', async () => {
    const ownedResultWorkspace = {
      ...currentWs,
      objects: [{
        id: 'ao_result123',
        projectId: 'proj_1',
        displayName: 'Normalized PBMC',
        ownerUserId: 7,
        liveState: 'unknown',
      }],
      selectedObjectIds: ['ao_result123'],
    };
    window.electronAPI.createCheckpointLoadJob.mockResolvedValueOnce({
      id: 'job_attach_poll',
      jobType: 'checkpoint.load.v1',
      analysisObjectId: 'ao_result123',
      status: 'queued',
    });
    window.electronAPI.getProjectJob
      .mockResolvedValueOnce({ id: 'job_attach_poll', status: 'queued' })
      .mockResolvedValueOnce({ id: 'job_attach_poll', status: 'completed' });
    const refreshAnalysisObjects = vi.fn(async () => {});
    const onLiveObjectAttached = vi.fn();
    render(
      <ProjectHistory
        currentWs={ownedResultWorkspace}
        datasetInfo={{ id: 'ao_result123', projectId: 'proj_1' }}
        userId={7}
        refreshAnalysisObjects={refreshAnalysisObjects}
        onLiveObjectAttached={onLiveObjectAttached}
      />
    );

    const attachButton = await screen.findByRole('button', { name: /restore saved version/i });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(attachButton);
        await Promise.resolve();
      });
      expect(window.electronAPI.createCheckpointLoadJob).toHaveBeenCalledWith('proj_1', 'ao_result123');
      expect(screen.getByRole('status')).toHaveTextContent(/Restoring saved version: Waiting for compute/i);

      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent(/Restoring saved version: Waiting for compute/i);

      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(2);
      await act(async () => {
        await Promise.resolve();
      });
      expect(refreshAnalysisObjects).toHaveBeenCalledWith('proj_1');
      expect(onLiveObjectAttached).toHaveBeenCalledWith('proj_1', 'ao_result123');
      expect(screen.getByRole('button', { name: /saved version restored/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never offers owner reattach for a different member\'s private object', async () => {
    const collaboratorResultWorkspace = {
      ...currentWs,
      objects: [{
        id: 'ao_result123',
        projectId: 'proj_1',
        displayName: 'Collaborator PBMC',
        ownerUserId: 99,
        liveState: 'unknown',
      }],
      selectedObjectIds: ['ao_result123'],
    };
    render(
      <ProjectHistory
        currentWs={collaboratorResultWorkspace}
        datasetInfo={{ id: 'ao_result123', projectId: 'proj_1' }}
        userId={7}
      />
    );

    expect((await screen.findAllByRole('button', { name: /create branch from this version/i })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /restore saved version/i })).not.toBeInTheDocument();
    expect(window.electronAPI.createCheckpointLoadJob).not.toHaveBeenCalled();
  });

  it('continues polling a queued fork until the completed result can be opened', async () => {
    window.electronAPI.createCheckpointForkJob.mockResolvedValueOnce({
      id: 'job_fork_poll',
      jobType: 'checkpoint.fork.v1',
      status: 'queued',
    });
    window.electronAPI.getProjectJob
      .mockResolvedValueOnce({ id: 'job_fork_poll', status: 'queued' })
      .mockResolvedValueOnce({ id: 'job_fork_poll', status: 'running' })
      .mockResolvedValueOnce({
        id: 'job_fork_poll',
        status: 'completed',
        resultAnalysisObjectId: 'ao_fork_polled',
      });
    const refreshAnalysisObjects = vi.fn(async () => {});
    render(
      <ProjectHistory
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }}
        refreshAnalysisObjects={refreshAnalysisObjects}
      />
    );

    const forkButton = await screen.findByRole('button', { name: /create branch from this version/i });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(forkButton);
        await Promise.resolve();
      });
      expect(screen.getByRole('status')).toHaveTextContent(/Waiting for compute/i);

      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent(/Waiting for compute/i);

      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('status')).toHaveTextContent(/running/i);

      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(3);
      expect(screen.getByRole('button', { name: /open branch/i })).toBeInTheDocument();
      expect(refreshAnalysisObjects).toHaveBeenCalledWith('proj_1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not offer a fork when loadable checkpoint selection is ambiguous', async () => {
    window.electronAPI.listProjectArtifacts.mockResolvedValueOnce([
      {
        id: 'artifact_checkpoint_1', artifactType: 'checkpoint', status: 'available',
        storageKind: 'local_internal', jobId: 'job_1', resultAnalysisObjectId: 'ao_abc123',
      },
      {
        id: 'artifact_checkpoint_2', artifactType: 'checkpoint', status: 'available',
        storageKind: 'local_internal', jobId: 'job_2', resultAnalysisObjectId: 'ao_abc123',
      },
    ]);
    render(<ProjectHistory currentWs={currentWs} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect((await screen.findAllByText(/cannot be selected automatically/i)).length).toBe(3);
    expect(screen.queryByRole('button', { name: /create branch from this version/i })).not.toBeInTheDocument();
  });

  it('shows an unavailable saved version when only its metadata remains', async () => {
    window.electronAPI.listProjectArtifacts.mockResolvedValueOnce([{
      id: 'artifact_metadata_only', artifactType: 'checkpoint', status: 'available',
      storageKind: 'metadata_only', jobId: 'job_safe_1', resultAnalysisObjectId: 'ao_result123',
    }]);
    render(<ProjectHistory currentWs={currentWs} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    const row = (await screen.findByText('This saved version is unavailable.')).closest('tr');
    expect(within(row).getByText('Unavailable', { exact: true })).toBeInTheDocument();
    expect(within(row).queryByText('Available', { exact: true })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /create branch/i })).not.toBeInTheDocument();
  });

  it('ignores delayed history from a previously selected project', async () => {
    let resolveA;
    let resolveB;
    const jobsA = new Promise(resolve => { resolveA = resolve; });
    const jobsB = new Promise(resolve => { resolveB = resolve; });
    window.electronAPI.listProjectJobs.mockImplementation(projectId => (
      projectId === 'proj_a' ? jobsA : jobsB
    ));
    window.electronAPI.listProjectArtifacts.mockResolvedValue([]);
    window.electronAPI.listProjectProvenance.mockResolvedValue([]);
    window.electronAPI.listProjectFigures.mockResolvedValue([]);
    window.electronAPI.getProjectAnalysisObjectLineage.mockResolvedValue(null);
    const workspaceA = {
      projects: [{ id: 'proj_a', name: 'Project A', role: 'owner' }],
      selectedProjectId: 'proj_a',
      objects: [],
      selectedObjectIds: [],
    };
    const workspaceB = {
      projects: [{ id: 'proj_b', name: 'Project B', role: 'owner' }],
      selectedProjectId: 'proj_b',
      objects: [],
      selectedObjectIds: [],
    };
    const { rerender } = render(<ProjectHistory currentWs={workspaceA} datasetInfo={null} />);
    await waitFor(() => expect(window.electronAPI.listProjectJobs).toHaveBeenCalledWith('proj_a'));

    rerender(<ProjectHistory currentWs={workspaceB} datasetInfo={null} />);
    await act(async () => {
      resolveB([{ id: 'job_project_b', status: 'completed', jobType: 'deg.find_markers.v1' }]);
      await jobsB;
    });
    expect(await screen.findByText('Cluster marker analysis')).toBeInTheDocument();

    await act(async () => {
      resolveA([{ id: 'job_project_a', status: 'completed', jobType: 'pbmc.pipeline.v1' }]);
      await jobsA;
    });
    expect(screen.queryByText('PBMC preprocessing')).not.toBeInTheDocument();
    expect(screen.getByText('Cluster marker analysis')).toBeInTheDocument();
  });

  it('hides prior-project history and fork actions while the next project is loading', async () => {
    let resolveB;
    const jobsB = new Promise(resolve => { resolveB = resolve; });
    window.electronAPI.listProjectJobs.mockImplementation(projectId => (
      projectId === 'proj_a'
        ? Promise.resolve([{ id: 'job_project_a', status: 'completed', jobType: 'pbmc.pipeline.v1' }])
        : jobsB
    ));
    window.electronAPI.listProjectArtifacts.mockImplementation(projectId => Promise.resolve(
      projectId === 'proj_a'
        ? [{
          id: 'artifact_a', artifactType: 'checkpoint', status: 'available',
          storageKind: 'local_internal', jobId: 'job_project_a', resultAnalysisObjectId: 'ao_a',
        }]
        : []
    ));
    window.electronAPI.listProjectProvenance.mockResolvedValue([]);
    window.electronAPI.listProjectFigures.mockResolvedValue([]);
    const workspaceA = {
      projects: [{ id: 'proj_a', name: 'Project A', role: 'owner' }],
      selectedProjectId: 'proj_a',
      objects: [{ id: 'ao_a', projectId: 'proj_a', displayName: 'Project A analysis' }],
      selectedObjectIds: ['ao_a'],
    };
    const workspaceB = {
      projects: [{ id: 'proj_b', name: 'Project B', role: 'owner' }],
      selectedProjectId: 'proj_b', objects: [], selectedObjectIds: [],
    };
    const { rerender } = render(<ProjectHistory currentWs={workspaceA} datasetInfo={workspaceA.objects[0]} />);
    expect((await screen.findAllByText('PBMC preprocessing')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /create branch from this version/i }).length).toBeGreaterThan(0);

    rerender(<ProjectHistory currentWs={workspaceB} datasetInfo={null} />);

    expect(screen.queryAllByText('PBMC preprocessing')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /create branch from this version/i })).not.toBeInTheDocument();
    expect(screen.getByText('Project B')).toBeInTheDocument();

    await act(async () => {
      resolveB([{ id: 'job_project_b', status: 'completed', jobType: 'deg.find_markers.v1' }]);
      await jobsB;
    });
    expect(await screen.findByText('Cluster marker analysis')).toBeInTheDocument();
  });

  it('reconciles project access and stops polling when a fork lookup returns 404', async () => {
    window.electronAPI.createCheckpointForkJob.mockResolvedValueOnce({
      id: 'job_fork_removed', jobType: 'checkpoint.fork.v1', status: 'queued',
    });
    window.electronAPI.getProjectJob.mockRejectedValue(
      Object.assign(new Error(JSON.stringify({ error: 'Project job not found.' })), { status: 404 })
    );
    const refreshProjects = vi.fn(async () => {});
    render(
      <ProjectHistory
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }}
        refreshProjects={refreshProjects}
      />
    );

    const forkButton = await screen.findByRole('button', { name: /create branch from this version/i });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(forkButton);
        await Promise.resolve();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(1);
      expect(refreshProjects).toHaveBeenCalled();
      expect(screen.getByText(/Project access changed; refresh required/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /create branch from this version/i })).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes authoritative projects when history access is revoked', async () => {
    const accessError = Object.assign(
      new Error(JSON.stringify({ error: 'Project not found.' })),
      { status: 404 }
    );
    window.electronAPI.listProjectJobs.mockRejectedValueOnce(accessError);
    const refreshProjects = vi.fn(async () => {});

    render(
      <ProjectHistory
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }}
        refreshProjects={refreshProjects}
      />
    );

    expect(await screen.findByText(/Project not found/i)).toBeInTheDocument();
    expect(refreshProjects).toHaveBeenCalled();
    expect(screen.queryByText('PBMC preprocessing')).not.toBeInTheDocument();
  });

  it('reconciles a claim-time PROJECT_ACCESS_REVOKED cancellation', async () => {
    window.electronAPI.createCheckpointForkJob.mockResolvedValueOnce({
      id: 'job_fork_demoted', jobType: 'checkpoint.fork.v1', status: 'queued',
    });
    window.electronAPI.getProjectJob.mockResolvedValueOnce({
      id: 'job_fork_demoted',
      jobType: 'checkpoint.fork.v1',
      status: 'canceled',
      error: { code: 'PROJECT_ACCESS_REVOKED', message: 'Project write access was revoked before claim.' },
    });
    const refreshProjects = vi.fn(async () => {});
    render(
      <ProjectHistory
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }}
        refreshProjects={refreshProjects}
      />
    );

    const forkButton = await screen.findByRole('button', { name: /create branch from this version/i });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(forkButton);
        await Promise.resolve();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

      expect(refreshProjects).toHaveBeenCalled();
      expect(screen.getByText(/Project access changed; refresh required/i)).toBeInTheDocument();
      expect(screen.getByText(/Creating a branch from the saved version canceled/i)).toBeInTheDocument();
      expect(screen.queryByText(/Project write access was revoked before claim/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
