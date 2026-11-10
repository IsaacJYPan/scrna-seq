import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useProjectAnalysisJob from './useProjectAnalysisJob';

const JOB_TYPE = 'deg.find_markers.v1';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function installApi(overrides = {}) {
  const api = {
    listProjectJobs: vi.fn(async () => []),
    getProjectJob: vi.fn(async (_projectId, jobId) => ({ id: jobId, status: 'completed' })),
    getProjectJobLogs: vi.fn(async () => ({ logs: [{ level: 'info', message: 'done' }] })),
    listProjectJobArtifacts: vi.fn(async () => [{ artifactType: 'deg_summary' }]),
    cancelProjectJob: vi.fn(async () => ({})),
    ...overrides,
  };
  window.electronAPI = api;
  return api;
}

afterEach(() => {
  delete window.electronAPI;
});

describe('useProjectAnalysisJob', () => {
  it('restores the latest job of its type for the selected analysis', async () => {
    const api = installApi({ listProjectJobs: vi.fn(async () => [{ id: 'job_1' }]) });
    const { result } = renderHook(() => useProjectAnalysisJob({
      jobType: JOB_TYPE, activeProjectId: 'proj_1', selectedObjectId: 'ao_1',
    }));

    await waitFor(() => expect(result.current.job?.id).toBe('job_1'));
    expect(api.listProjectJobs).toHaveBeenCalledWith('proj_1', { jobType: JOB_TYPE, analysisObjectId: 'ao_1' });
    expect(result.current.terminal).toBe(true);
    expect(result.current.logs).toHaveLength(1);
    expect(result.current.artifacts).toEqual([{ artifactType: 'deg_summary' }]);
  });

  it('drops a refresh that resolves after the selection changed', async () => {
    const slowJob = deferred();
    installApi({
      listProjectJobs: vi.fn(async (_projectId, { analysisObjectId }) => (analysisObjectId === 'ao_1' ? [{ id: 'job_old' }] : [])),
      getProjectJob: vi.fn(() => slowJob.promise),
    });
    const { result, rerender } = renderHook(props => useProjectAnalysisJob(props), {
      initialProps: { jobType: JOB_TYPE, activeProjectId: 'proj_1', selectedObjectId: 'ao_1' },
    });
    await waitFor(() => expect(window.electronAPI.getProjectJob).toHaveBeenCalled());

    rerender({ jobType: JOB_TYPE, activeProjectId: 'proj_1', selectedObjectId: 'ao_2' });
    await act(async () => { slowJob.resolve({ id: 'job_old', status: 'completed' }); });

    expect(result.current.job).toBeNull();
    expect(result.current.logs).toEqual([]);
  });

  it('submits a job and loads its state', async () => {
    installApi();
    const { result } = renderHook(() => useProjectAnalysisJob({
      jobType: JOB_TYPE, activeProjectId: 'proj_1', selectedObjectId: 'ao_1',
    }));
    await waitFor(() => expect(window.electronAPI.listProjectJobs).toHaveBeenCalled());

    await act(async () => { await result.current.submitJob(async () => ({ id: 'job_new', status: 'queued' })); });

    expect(result.current.job).toEqual({ id: 'job_new', status: 'completed' });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('shows a public message when submission fails', async () => {
    installApi();
    const { result } = renderHook(() => useProjectAnalysisJob({
      jobType: JOB_TYPE, activeProjectId: 'proj_1', selectedObjectId: 'ao_1',
    }));
    await waitFor(() => expect(window.electronAPI.listProjectJobs).toHaveBeenCalled());

    await act(async () => {
      await result.current.submitJob(async () => { throw new Error('Rscript crashed at /srv/vault/x'); });
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.error).not.toMatch(/Rscript|vault/);
    expect(result.current.loading).toBe(false);
  });

  it('cancels the current job and refreshes it', async () => {
    const api = installApi({
      listProjectJobs: vi.fn(async () => [{ id: 'job_1' }]),
      getProjectJob: vi.fn(async () => ({ id: 'job_1', status: 'running' })),
    });
    const { result } = renderHook(() => useProjectAnalysisJob({
      jobType: JOB_TYPE, activeProjectId: 'proj_1', selectedObjectId: 'ao_1',
    }));
    await waitFor(() => expect(result.current.job?.id).toBe('job_1'));

    api.getProjectJob.mockResolvedValue({ id: 'job_1', status: 'canceled' });
    await act(async () => { await result.current.cancelJob(); });

    expect(api.cancelProjectJob).toHaveBeenCalledWith('proj_1', 'job_1');
    expect(result.current.job.status).toBe('canceled');
    expect(result.current.canceling).toBe(false);
  });

  it('reports an unavailable job service instead of throwing', async () => {
    window.electronAPI = { listProjectJobs: vi.fn(async () => [{ id: 'job_1' }]) };
    const { result } = renderHook(() => useProjectAnalysisJob({
      jobType: JOB_TYPE, activeProjectId: 'proj_1', selectedObjectId: 'ao_1',
    }));

    await waitFor(() => expect(result.current.error).toBe('This analysis service is temporarily unavailable.'));
  });
});
