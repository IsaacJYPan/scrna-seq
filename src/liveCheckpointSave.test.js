import { describe, expect, it, vi } from 'vitest';
import { saveAndOpenCurrentAnalysis, waitForProjectJob } from './liveCheckpointSave';

describe('waitForProjectJob', () => {
  it('polls until a job reaches a terminal state', async () => {
    const api = { getProjectJob: vi.fn()
      .mockResolvedValueOnce({ id: 'job_1', status: 'queued' })
      .mockResolvedValueOnce({ id: 'job_1', status: 'running' })
      .mockResolvedValueOnce({ id: 'job_1', status: 'completed' }) };
    const result = await waitForProjectJob(api, 'proj_1', 'job_1', {
      pollMs: 0, wait: vi.fn().mockResolvedValue(undefined), maxPolls: 4,
    });
    expect(result.status).toBe('completed');
    expect(api.getProjectJob).toHaveBeenCalledTimes(3);
  });

  it('fails closed when terminal state cannot be confirmed', async () => {
    const api = { getProjectJob: vi.fn().mockResolvedValue({ id: 'job_1', status: 'running' }) };
    await expect(waitForProjectJob(api, 'proj_1', 'job_1', {
      pollMs: 0, wait: vi.fn().mockResolvedValue(undefined), maxPolls: 2,
    })).rejects.toMatchObject({ code: 'JOB_POLL_TIMEOUT' });
  });
});

describe('saveAndOpenCurrentAnalysis', () => {
  it('saves first and opens only the server-created result object', async () => {
    const api = {
      createCheckpointSaveJob: vi.fn().mockResolvedValue({ id: 'job_save' }),
      createCheckpointLoadJob: vi.fn().mockResolvedValue({ id: 'job_load' }),
    };
    const waitForJob = vi.fn(async (jobId) => jobId === 'job_save'
      ? { id: jobId, status: 'completed', resultAnalysisObjectId: 'ao_saved' }
      : { id: jobId, status: 'completed' });
    const onPhase = vi.fn();

    await expect(saveAndOpenCurrentAnalysis(api, 'proj_1', 'ao_live', {
      waitForJob, onPhase,
    })).resolves.toEqual({
      resultAnalysisObjectId: 'ao_saved', saveJobId: 'job_save', loadJobId: 'job_load',
    });
    expect(api.createCheckpointSaveJob).toHaveBeenCalledWith('proj_1', 'ao_live');
    expect(api.createCheckpointLoadJob).toHaveBeenCalledWith('proj_1', 'ao_saved');
    expect(onPhase.mock.calls.map(([phase]) => phase)).toEqual(['saving', 'opening', 'completed']);
  });

  it('does not attempt to open a failed save', async () => {
    const api = {
      createCheckpointSaveJob: vi.fn().mockResolvedValue({ id: 'job_save' }),
      createCheckpointLoadJob: vi.fn(),
    };
    await expect(saveAndOpenCurrentAnalysis(api, 'proj_1', 'ao_live', {
      waitForJob: vi.fn().mockResolvedValue({ id: 'job_save', status: 'failed' }),
    })).rejects.toMatchObject({ durableSaved: false });
    expect(api.createCheckpointLoadJob).not.toHaveBeenCalled();
  });

  it('reports that durable data exists when only reattach fails', async () => {
    const api = {
      createCheckpointSaveJob: vi.fn().mockResolvedValue({ id: 'job_save' }),
      createCheckpointLoadJob: vi.fn().mockResolvedValue({ id: 'job_load' }),
    };
    const waitForJob = vi.fn(async (jobId) => jobId === 'job_save'
      ? { id: jobId, status: 'completed', resultAnalysisObjectId: 'ao_saved' }
      : { id: jobId, status: 'failed' });
    await expect(saveAndOpenCurrentAnalysis(api, 'proj_1', 'ao_live', { waitForJob }))
      .rejects.toMatchObject({ durableSaved: true, code: 'SAVED_VERSION_OPEN_FAILED' });
  });
});
