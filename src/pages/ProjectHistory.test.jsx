import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
          message: 'sanitized job error',
          stack: 'Error: raw R stack trace text at vault/private/stack.R:42',
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
        operation: 'normalize',
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
      getProjectJob: vi.fn(),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('renders read-only project history without leaking private storage or live-R state fields', async () => {
    const { container } = render(<ProjectHistory currentWs={currentWs} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect(screen.getByText('Jobs & Artifacts')).toBeInTheDocument();
    expect(screen.getByText(/durable metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/no public download/i)).toBeInTheDocument();
    expect(screen.getByText(/private live forks/i)).toBeInTheDocument();

    expect((await screen.findAllByText('job_safe_1')).length).toBeGreaterThan(0);
    expect(screen.getByText('artifact_safe_1')).toBeInTheDocument();
    expect(screen.getByText('prov_safe_1')).toBeInTheDocument();
    expect(screen.getByText('fig_safe_1')).toBeInTheDocument();
    expect(screen.getByText('UMAP overview')).toBeInTheDocument();
    expect(screen.getByText(/ao_abc123 -> ao_result123/i)).toBeInTheDocument();

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

    fireEvent.click(await screen.findByRole('button', { name: /fork checkpoint/i }));
    await waitFor(() => {
      expect(window.electronAPI.createCheckpointForkJob).toHaveBeenCalledWith('proj_1', 'ao_result123');
    });

    fireEvent.click(await screen.findByRole('button', { name: /open fork/i }));
    await waitFor(() => {
      expect(onSelectAnalysisObject).toHaveBeenCalledWith('proj_1', 'ao_fork123');
      expect(setActiveTab).toHaveBeenCalledWith('workspace');
    });
    expect(screen.getByText(/source object and checkpoint remain unchanged/i)).toBeInTheDocument();
  });

  it('shows a project-scoped empty state when no project is selected', () => {
    render(<ProjectHistory currentWs={{ ...currentWs, projects: [], selectedProjectId: null }} datasetInfo={null} />);

    expect(screen.getByText(/Select a backend project/i)).toBeInTheDocument();
    expect(screen.getByText(/scoped to a backend project/i)).toBeInTheDocument();
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
    expect(screen.getByText(/No selected object/i)).toBeInTheDocument();
  });

  it('keeps checkpoint forks unavailable to project viewers', async () => {
    const viewerWorkspace = {
      ...currentWs,
      projects: currentWs.projects.map(project => ({ ...project, role: 'viewer' })),
    };
    render(<ProjectHistory currentWs={viewerWorkspace} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect(await screen.findByText(/Writer role required/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fork checkpoint/i })).not.toBeInTheDocument();
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

    const forkButton = await screen.findByRole('button', { name: /fork checkpoint/i });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(forkButton);
        await Promise.resolve();
      });
      expect(screen.getByRole('status')).toHaveTextContent(/queued/i);

      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent(/queued/i);

      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('status')).toHaveTextContent(/running/i);

      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(window.electronAPI.getProjectJob).toHaveBeenCalledTimes(3);
      expect(screen.getByRole('button', { name: /open fork/i })).toBeInTheDocument();
      expect(refreshAnalysisObjects).toHaveBeenCalledWith('proj_1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not offer a fork when loadable checkpoint selection is ambiguous', async () => {
    window.electronAPI.listProjectArtifacts.mockResolvedValueOnce([
      {
        id: 'artifact_checkpoint_1', artifactType: 'checkpoint', status: 'available',
        storageKind: 'local_internal', jobId: 'job_1', resultAnalysisObjectId: 'ao_result123',
      },
      {
        id: 'artifact_checkpoint_2', artifactType: 'checkpoint', status: 'available',
        storageKind: 'local_internal', jobId: 'job_2', resultAnalysisObjectId: 'ao_result123',
      },
    ]);
    render(<ProjectHistory currentWs={currentWs} datasetInfo={{ id: 'ao_abc123', projectId: 'proj_1' }} />);

    expect((await screen.findAllByText(/server selection is ambiguous/i)).length).toBe(2);
    expect(screen.queryByRole('button', { name: /fork checkpoint/i })).not.toBeInTheDocument();
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
      resolveB([{ id: 'job_project_b', status: 'completed', jobType: 'generic' }]);
      await jobsB;
    });
    expect(await screen.findByText('job_project_b')).toBeInTheDocument();

    await act(async () => {
      resolveA([{ id: 'job_project_a', status: 'completed', jobType: 'generic' }]);
      await jobsA;
    });
    expect(screen.queryByText('job_project_a')).not.toBeInTheDocument();
    expect(screen.getByText('job_project_b')).toBeInTheDocument();
  });

  it('hides prior-project history and fork actions while the next project is loading', async () => {
    let resolveB;
    const jobsB = new Promise(resolve => { resolveB = resolve; });
    window.electronAPI.listProjectJobs.mockImplementation(projectId => (
      projectId === 'proj_a'
        ? Promise.resolve([{ id: 'job_project_a', status: 'completed', jobType: 'generic' }])
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
      selectedProjectId: 'proj_a', objects: [], selectedObjectIds: [],
    };
    const workspaceB = {
      projects: [{ id: 'proj_b', name: 'Project B', role: 'owner' }],
      selectedProjectId: 'proj_b', objects: [], selectedObjectIds: [],
    };
    const { rerender } = render(<ProjectHistory currentWs={workspaceA} datasetInfo={null} />);
    expect((await screen.findAllByText('job_project_a')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /fork checkpoint/i })).toBeInTheDocument();

    rerender(<ProjectHistory currentWs={workspaceB} datasetInfo={null} />);

    expect(screen.queryAllByText('job_project_a')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /fork checkpoint/i })).not.toBeInTheDocument();
    expect(screen.getByText('Project B')).toBeInTheDocument();

    await act(async () => {
      resolveB([{ id: 'job_project_b', status: 'completed', jobType: 'generic' }]);
      await jobsB;
    });
    expect(await screen.findByText('job_project_b')).toBeInTheDocument();
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

    const forkButton = await screen.findByRole('button', { name: /fork checkpoint/i });
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
      expect(screen.queryByRole('button', { name: /fork checkpoint/i })).not.toBeInTheDocument();

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
    expect(screen.queryByText('job_safe_1')).not.toBeInTheDocument();
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

    const forkButton = await screen.findByRole('button', { name: /fork checkpoint/i });
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(forkButton);
        await Promise.resolve();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });

      expect(refreshProjects).toHaveBeenCalled();
      expect(screen.getByText(/Project access changed; refresh required/i)).toBeInTheDocument();
      expect(screen.getByText(/Project write access was revoked before claim/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
