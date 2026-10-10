import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RunMonitor from './RunMonitor';
import { getRunMonitoring, listRunMonitoring } from '../executions/runMonitoringApi';

vi.mock('../executions/runMonitoringApi', () => ({ getRunMonitoring: vi.fn(), listRunMonitoring: vi.fn() }));
const props = { projectId: 'project', userId: 1 };
const row = { id: 'job_one', projectId: 'project', kind: 'job', operation: 'expert.r.v1', status: 'running', timestamps: { createdAt: '2026-10-09T10:00:00Z', startedAt: '2026-10-09T10:00:05Z' }, timing: { queueElapsedMs: 5000, runElapsedMs: 65000, totalElapsedMs: 70000, remainingMs: null } };
const observation = { ...row, checkedAt: '2026-10-09T10:01:10Z', target: { kind: 'service', id: `svc_${'a'.repeat(32)}`, label: 'Research compute', runtimeKind: 'sandbox-r' }, progress: { state: 'unknown', percent: null, remainingMs: null, note: 'This runtime does not report fractional completion.' }, resources: { state: 'observed', scope: 'r-container', observedAt: '2026-10-09T10:01:09Z', cpuPercent: 150.2, memoryBytes: 123 * 1024 ** 2, limits: { cpuLimit: 2, memoryBytes: 1024 ** 3 } }, worker: { state: 'lease-current', heartbeatAt: '2026-10-09T10:00:40Z', leaseExpiresAt: '2026-10-09T10:02:40Z', note: 'The worker has a current lease; this does not predict completion.' }, logs: { items: [{ ts: '2026-10-09T10:00:06Z', level: 'info', message: '<script>scientific note</script>' }], available: true, redacted: true, truncated: false } };
beforeEach(() => { vi.useRealTimers(); vi.resetAllMocks(); listRunMonitoring.mockResolvedValue({ items: [row], nextCursor: null }); getRunMonitoring.mockResolvedValue(observation); });
afterEach(() => { delete window.desktopShell; vi.useRealTimers(); });
const open = async () => { fireEvent.click(await screen.findByRole('button', { name: /job_one/ })); await screen.findByRole('heading', { name: 'Server state: Running' }); };

it('shows honest progress, service elapsed, retained target and container observations separate from limits', async () => {
  render(<RunMonitor {...props} />); await open();
  expect(screen.getByRole('list', { name: 'Monitored runs' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Selected run monitoring' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Worker status' })).toHaveTextContent('Current');
  expect(screen.getByText('Last heartbeat')).toBeVisible();
  expect(screen.getByText('Lease expiry')).toBeVisible();
  expect(screen.getByText('Progress is not reported.')).toBeVisible();
  expect(screen.getByText('Remaining time is unknown.')).toBeVisible();
  expect(screen.getByLabelText('Run elapsed time')).toHaveTextContent('1m 5s');
  expect(screen.getByLabelText('CPU usage')).toHaveTextContent('150.2%');
  expect(screen.getByLabelText('Memory usage')).toHaveTextContent('123.0 MiB');
  expect(screen.getByText('Selected R container')).toBeVisible();
  expect(screen.getByText(`Research compute · svc_${'a'.repeat(32)}`)).toBeVisible();
  fireEvent.click(screen.getByText('Configured resource limits'));
  expect(screen.getByText('2 CPUs')).toBeVisible();
  expect(screen.getByText('1.00 GiB')).toBeVisible();
  fireEvent.click(screen.getByText('Run notes · 1'));
  expect(screen.getByText('<script>scientific note</script>')).toBeVisible();
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText(/private or oversized details may have been omitted/)).toBeVisible();
});

it('never turns a policy limit into measured resource usage', async () => {
  getRunMonitoring.mockResolvedValue({ ...observation, resources: { state: 'unavailable', scope: null, limits: { cpuLimit: 2, memoryBytes: 1024 ** 3 }, note: 'Guided runtime usage is not sampled per run.' } });
  render(<RunMonitor {...props} />); await open();
  expect(screen.getByText('Resource usage is not reported for this run.')).toBeVisible();
  expect(screen.queryByLabelText('CPU usage')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Memory usage')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Configured resource limits'));
  expect(screen.getByText('2 CPUs')).toBeVisible();
});

it('polls only the selected active durable record and stops after its terminal result', async () => {
  vi.useFakeTimers();
  render(<RunMonitor {...props} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /job_one/ }));
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(getRunMonitoring).toHaveBeenCalledTimes(2);
  expect(listRunMonitoring).toHaveBeenCalledTimes(1);
  getRunMonitoring.mockResolvedValue({ ...observation, status: 'completed', timestamps: { ...row.timestamps, completedAt: '2026-10-09T10:01:10Z' }, progress: { state: 'complete', percent: 100 }, resources: { state: 'unavailable' } });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByRole('heading', { name: 'Server state: Complete' })).toBeVisible();
  const count = getRunMonitoring.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(getRunMonitoring).toHaveBeenCalledTimes(count);
  expect(getRunMonitoring.mock.calls.every(([project, id]) => project === 'project' && id === 'job_one')).toBe(true);
});

it('preserves last confirmed state and frozen elapsed on SSH disconnect, then reads the same run on reconnect', async () => {
  let notify;
  const target = { id: 'lab', name: 'Current laptop profile', serviceIdentity: 'same-server', status: 'connected', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  render(<RunMonitor {...props} />); await open();
  vi.useFakeTimers();
  const elapsed = screen.getByLabelText('Run elapsed time').textContent;
  const lastObserved = screen.getByLabelText('Last run observation').textContent;
  act(() => notify({ ...target, status: 'disconnected', sshTunnel: { state: 'disconnected' } }));
  expect(screen.getByRole('heading', { name: 'Last confirmed server state: Running' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Refresh monitoring' })).toBeDisabled();
  const count = getRunMonitoring.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(getRunMonitoring).toHaveBeenCalledTimes(count);
  expect(screen.getByLabelText('Run elapsed time')).toHaveTextContent(elapsed);
  expect(screen.getByLabelText('Last run observation')).toHaveTextContent(lastObserved);
  expect(screen.getByText('Last confirmed container sample; current resource usage is unknown.')).toBeVisible();
  expect(screen.getByText(`Research compute · svc_${'a'.repeat(32)}`)).toBeVisible();
  expect(screen.queryByText('Current laptop profile')).not.toBeInTheDocument();
  getRunMonitoring.mockResolvedValue({ ...observation, status: 'completed', progress: { state: 'complete' } });
  await act(async () => notify(target));
  expect(screen.getByRole('heading', { name: 'Server state: Complete' })).toBeVisible();
  expect(getRunMonitoring).toHaveBeenCalledTimes(count + 1);
  expect(getRunMonitoring.mock.calls.at(-1).slice(0, 2)).toEqual(['project', 'job_one']);
});

it('retains observations after a service failure and refresh checks the same record', async () => {
  render(<RunMonitor {...props} />); await open();
  getRunMonitoring.mockRejectedValueOnce(new Error('Run monitoring could not be reached.'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh monitoring' }));
  expect(await screen.findByRole('heading', { name: 'Last confirmed server state: Running' })).toBeVisible();
  expect(screen.getByLabelText('Run elapsed time')).toHaveTextContent('1m 5s');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh monitoring' }));
  await screen.findByRole('heading', { name: 'Server state: Running' });
  expect(getRunMonitoring.mock.calls.every(([, id]) => id === 'job_one')).toBe(true);
});

it('aborts private requests and rejects stale observations after project or account changes', async () => {
  let finish;
  getRunMonitoring.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RunMonitor {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /job_one/ }));
  const signal = getRunMonitoring.mock.calls[0][2];
  listRunMonitoring.mockResolvedValue({ items: [], nextCursor: null });
  view.rerender(<RunMonitor {...props} userId={2} projectId="other" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(observation));
  expect(screen.queryByText(`Research compute · svc_${'a'.repeat(32)}`)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /job_one/ })).not.toBeInTheDocument();
});

it('clears previous private observations when the selected server identity changes', async () => {
  let notify;
  const target = { id: 'lab', serviceIdentity: 'server-a', status: 'connected' };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  render(<RunMonitor {...props} />); await open();
  listRunMonitoring.mockResolvedValue({ items: [], nextCursor: null });
  await act(async () => notify({ ...target, serviceIdentity: 'server-b' }));
  expect(screen.queryByText(`Research compute · svc_${'a'.repeat(32)}`)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Run elapsed time')).not.toBeInTheDocument();
});

it.each([401, 403, 404])('clears records and private notes immediately after access revocation with status %i', async status => {
  render(<RunMonitor {...props} />); await open();
  getRunMonitoring.mockRejectedValueOnce(Object.assign(new Error('This run is no longer available to your account.'), { status }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh monitoring' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: /job_one/ })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Run elapsed time')).not.toBeInTheDocument();
  expect(screen.queryByText('<script>scientific note</script>')).not.toBeInTheDocument();
});

it('keeps polling the same active record after a temporary service failure', async () => {
  vi.useFakeTimers();
  render(<RunMonitor {...props} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /job_one/ })); await act(async () => {});
  getRunMonitoring.mockRejectedValueOnce(new Error('Run monitoring could not be reached.'));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByRole('heading', { name: 'Last confirmed server state: Running' })).toBeVisible();
  getRunMonitoring.mockResolvedValue({ ...observation, checkedAt: '2026-10-09T10:01:20Z' });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByRole('heading', { name: 'Server state: Running' })).toBeVisible();
  expect(getRunMonitoring).toHaveBeenCalledTimes(3);
  expect(getRunMonitoring.mock.calls.every(([, id]) => id === 'job_one')).toBe(true);
});

it('ages unchanged active observations into last confirmed state and checks age on focus', async () => {
  vi.useFakeTimers();
  render(<RunMonitor {...props} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /job_one/ })); await act(async () => {});
  const elapsed = screen.getByLabelText('Run elapsed time').textContent;
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(screen.getByRole('heading', { name: 'Last confirmed server state: Running' })).toBeVisible();
  expect(screen.getByLabelText('Run elapsed time')).toHaveTextContent(elapsed);
  expect(screen.getByText('Last confirmed container sample; current resource usage is unknown.')).toBeVisible();
  getRunMonitoring.mockResolvedValue({ ...observation, checkedAt: '2026-10-09T10:01:25Z' });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(screen.getByRole('heading', { name: 'Server state: Running' })).toBeVisible();
  vi.setSystemTime(Date.now() + 11000);
  fireEvent.focus(window);
  expect(screen.getByRole('heading', { name: 'Last confirmed server state: Running' })).toBeVisible();
});

it('shows container allowances separately when a measured sample has no configured policy object', async () => {
  getRunMonitoring.mockResolvedValue({ ...observation, resources: { ...observation.resources, limits: null, cpuLimit: 2, memoryLimitBytes: 1024 ** 3 } });
  render(<RunMonitor {...props} />); await open();
  fireEvent.click(screen.getByText('Configured resource limits'));
  expect(screen.getByText('2 CPUs')).toBeVisible();
  expect(screen.getByText('1.00 GiB')).toBeVisible();
  expect(screen.getByLabelText('Memory usage')).toHaveTextContent('123.0 MiB');
});

it('does not overlap a slow selected-run read with more polling requests', async () => {
  vi.useFakeTimers();
  render(<RunMonitor {...props} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /job_one/ })); await act(async () => {});
  let finish;
  getRunMonitoring.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(getRunMonitoring).toHaveBeenCalledTimes(2);
  await act(async () => finish({ ...observation, status: 'completed' }));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(getRunMonitoring).toHaveBeenCalledTimes(2);
});

it('aborts an in-flight detail response when a simultaneous list check revokes access', async () => {
  render(<RunMonitor {...props} />); await open();
  let finish;
  getRunMonitoring.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  listRunMonitoring.mockRejectedValueOnce(Object.assign(new Error('This run is no longer available to your account.'), { status: 403 }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh monitoring' }));
  const signal = getRunMonitoring.mock.calls.at(-1)[2];
  await screen.findByRole('alert');
  expect(signal.aborted).toBe(true);
  await act(async () => finish(observation));
  expect(screen.queryByLabelText('Run elapsed time')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /job_one/ })).not.toBeInTheDocument();
});

it('rejects a list page from a different project without showing its private records', async () => {
  listRunMonitoring.mockResolvedValue({ items: [{ ...row, projectId: 'other', id: 'job_other' }], nextCursor: null });
  render(<RunMonitor {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('incomplete');
  expect(screen.queryByRole('button', { name: /job_other/ })).not.toBeInTheDocument();
});

it('rejects a list response that exceeds the twenty-five-record page contract', async () => {
  listRunMonitoring.mockResolvedValue({ items: Array.from({ length: 26 }, (_, index) => ({ ...row, id: `job_${index}` })), nextCursor: null });
  render(<RunMonitor {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('incomplete');
  expect(screen.queryByRole('button', { name: /job_0/ })).not.toBeInTheDocument();
});

it('does not accept a different record from a stale or inconsistent detail response', async () => {
  getRunMonitoring.mockResolvedValue({ ...observation, id: 'job_other' });
  render(<RunMonitor {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /job_one/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('did not match');
  expect(screen.queryByLabelText('Run elapsed time')).not.toBeInTheDocument();
});

it('pages the run list without duplicates and clears it when access disappears', async () => {
  listRunMonitoring.mockResolvedValueOnce({ items: [row], nextCursor: 'older' });
  listRunMonitoring.mockResolvedValueOnce({ items: [row, { ...row, id: 'pex_older', kind: 'r-console' }], nextCursor: null });
  render(<RunMonitor {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'More monitored runs' }));
  await screen.findByRole('button', { name: /pex_older/ });
  expect(screen.getAllByRole('button', { name: /job_one/ })).toHaveLength(1);
  expect(listRunMonitoring).toHaveBeenLastCalledWith('project', expect.objectContaining({ before: 'older' }));
  listRunMonitoring.mockRejectedValueOnce(Object.assign(new Error('This run is no longer available to your account.'), { status: 403 }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh monitoring' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: /pex_older/ })).not.toBeInTheDocument());
});
