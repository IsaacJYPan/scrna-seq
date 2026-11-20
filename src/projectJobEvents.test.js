import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { electronAPI } from './api';
import { noteProjectJobStatus, onProjectJobSettled, resetProjectJobEventsForTests } from './projectJobEvents';

describe('project job settled events', () => {
  beforeEach(() => resetProjectJobEventsForTests());

  it('emits once when a job seen running reaches a terminal state', () => {
    const listener = vi.fn();
    onProjectJobSettled(listener);
    noteProjectJobStatus('proj_1', { id: 'job_1', status: 'queued' });
    noteProjectJobStatus('proj_1', { id: 'job_1', status: 'running' });
    expect(listener).not.toHaveBeenCalled();
    noteProjectJobStatus('proj_1', { id: 'job_1', status: 'completed' });
    noteProjectJobStatus('proj_1', { id: 'job_1', status: 'completed' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ projectId: 'proj_1', job: { id: 'job_1', status: 'completed' } });
  });

  it('treats failure and cancellation as settled too', () => {
    const listener = vi.fn();
    onProjectJobSettled(listener);
    noteProjectJobStatus('proj_1', { id: 'job_f', status: 'running' });
    noteProjectJobStatus('proj_1', { id: 'job_f', status: 'failed' });
    noteProjectJobStatus('proj_1', { id: 'job_c', status: 'queued' });
    noteProjectJobStatus('proj_1', { id: 'job_c', status: 'canceled' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stays quiet for a job first seen already finished, such as a restored run', () => {
    const listener = vi.fn();
    onProjectJobSettled(listener);
    noteProjectJobStatus('proj_1', { id: 'job_old', status: 'completed' });
    noteProjectJobStatus('proj_1', null);
    noteProjectJobStatus(null, { id: 'job_x', status: 'running' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe and survives a failing listener', () => {
    const broken = vi.fn(() => { throw new Error('boom'); });
    const listener = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    onProjectJobSettled(broken);
    const unsubscribe = onProjectJobSettled(listener);
    noteProjectJobStatus('proj_1', { id: 'job_1', status: 'running' });
    noteProjectJobStatus('proj_1', { id: 'job_1', status: 'completed' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    noteProjectJobStatus('proj_1', { id: 'job_2', status: 'running' });
    noteProjectJobStatus('proj_1', { id: 'job_2', status: 'completed' });
    expect(listener).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe('API layer reports polled jobs', () => {
  const originalFetch = global.fetch;
  beforeEach(() => resetProjectJobEventsForTests());
  afterEach(() => { global.fetch = originalFetch; });

  it('emits when getProjectJob first returns running and later completed', async () => {
    const statuses = ['running', 'completed'];
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_poll', status: statuses.shift() }),
    }));
    const listener = vi.fn();
    onProjectJobSettled(listener);
    await electronAPI.getProjectJob('proj_9', 'job_poll');
    expect(listener).not.toHaveBeenCalled();
    const job = await electronAPI.getProjectJob('proj_9', 'job_poll');
    expect(job.status).toBe('completed');
    expect(listener).toHaveBeenCalledWith({ projectId: 'proj_9', job: { id: 'job_poll', status: 'completed' } });
  });
});
