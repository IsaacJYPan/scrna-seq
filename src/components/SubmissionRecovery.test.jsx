import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SubmissionRecovery, { SubmissionRecoveryNotice } from './SubmissionRecovery';
import RunMonitor from './RunMonitor';
import {
  RECOVERY_STORAGE_KEY, clearSubmissionRecovery, getSubmissionRecoverySnapshot, submitWithRecovery,
} from '../executions/submissionRecovery';
import { getRunMonitoring, listRunMonitoring } from '../executions/runMonitoringApi';

vi.mock('../executions/runMonitoringApi', () => ({ getRunMonitoring: vi.fn(), listRunMonitoring: vi.fn() }));
const installation = { schema: 'traceomics.installation.v1', installationId: `svc_${'a'.repeat(32)}`, userId: 1 };
const requestId = '00000000-0000-4000-8000-000000000001';
const receipt = { schema: 'traceomics.job-submission.v1', requestId, projectId: 'proj_one', jobId: 'job_exact', requestHash: 'b'.repeat(64) };
const response = value => ({ ok: true, headers: new Headers(), json: async () => value });
const row = { id: 'job_exact', projectId: 'proj_one', kind: 'job', operation: 'expert.r.v1', status: 'completed', timestamps: {}, timing: {} };
const onOpen = vi.fn();
function RecoveryView({ userId = 1, projectId = 'proj_one', monitor = true }) {
  return <><SubmissionRecoveryNotice userId={userId} projectId={projectId} onOpen={onOpen} />
    <SubmissionRecovery userId={userId} projectId={projectId} />{monitor && <RunMonitor userId={userId} projectId={projectId} />}</>;
}
beforeEach(async () => {
  await clearSubmissionRecovery(); localStorage.clear(); vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async url => response(url === '/api/auth/installation' ? installation : receipt)));
  listRunMonitoring.mockResolvedValue({ items: [{ ...row, id: 'job_newer' }, row], nextCursor: null });
  getRunMonitoring.mockResolvedValue({ ...row, checkedAt: new Date().toISOString(), progress: { state: 'complete' }, resources: { state: 'unavailable' }, logs: { items: [] } });
});
afterEach(async () => { cleanup(); await clearSubmissionRecovery(); delete window.desktopShell; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function retainedPending() {
  await expect(submitWithRecovery({ projectId: 'proj_one', requestId, submit: async () => { throw new Error('Lost acknowledgement'); } })).rejects.toThrow('unconfirmed');
  const saved = localStorage.getItem(RECOVERY_STORAGE_KEY);
  const generation = JSON.parse(saved).generation;
  await clearSubmissionRecovery(); localStorage.setItem('traceomics_submission_recovery_v1_generation', generation); localStorage.setItem(RECOVERY_STORAGE_KEY, saved); fetch.mockClear();
}

it('reopens a lost acknowledgement using GET and selects its exact run instead of the newest job', async () => {
  await retainedPending();
  render(<RecoveryView />);
  const record = await screen.findByRole('region', { name: `Submission ${requestId}` });
  await waitFor(() => expect(record).toHaveTextContent('Accepted'));
  fireEvent.click(within(record).getByRole('button', { name: 'Open exact run' }));
  await waitFor(() => expect(screen.getByRole('region', { name: 'Selected run monitoring' })).toHaveTextContent('job_exact'));
  expect(screen.getByRole('button', { name: /R analysis.*job_exact/ })).toHaveAttribute('aria-pressed', 'true');
  expect(getRunMonitoring.mock.calls.every(([, id]) => id === 'job_exact')).toBe(true);
  expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  expect(screen.queryByRole('region', { name: 'Submission recovery' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Saved submissions' })).toBeVisible();
});

it('shows a missing receipt truthfully and requires explicit confirmation before forgetting it', async () => {
  await retainedPending();
  fetch.mockImplementation(async url => url.includes('job-submissions') ? { ok: false, status: 404 } : response(url === '/api/auth/installation' ? installation : { id: 'proj_one' }));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<RecoveryView monitor={false} />);
  await screen.findByText(/No matching receipt was found/);
  fireEvent.click(screen.getByRole('button', { name: 'Open recovered runs' }));
  expect(onOpen).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Forget unconfirmed request' }));
  expect(getSubmissionRecoverySnapshot().records).toHaveLength(1);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('could create duplicate work'));
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Forget unconfirmed request' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Saved submissions' })).toBeNull());
  expect(getSubmissionRecoverySnapshot().records).toHaveLength(0);
  expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

it('hides private recovery details immediately when another owner or project is selected', async () => {
  await retainedPending();
  const view = render(<RecoveryView />);
  await screen.findByRole('button', { name: 'Open exact run' });
  await act(async () => { view.rerender(<RecoveryView projectId="proj_other" />); });
  expect(screen.queryByRole('region', { name: 'Saved submissions' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Selected run monitoring' })).not.toHaveTextContent('job_exact');
  await act(async () => { view.rerender(<RecoveryView userId={2} />); });
  expect(screen.queryByRole('region', { name: 'Saved submissions' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Selected run monitoring' })).not.toHaveTextContent('job_exact');
});

it('keeps recovery unavailable until an authenticated numeric owner is present', async () => {
  render(<><SubmissionRecovery userId={undefined} projectId="proj_one" /><RunMonitor projectId="proj_one" /></>);
  expect(screen.queryByRole('region', { name: 'Saved submissions' })).toBeNull();
  await screen.findByRole('button', { name: /R analysis.*job_exact/ });
  expect(screen.getByRole('region', { name: 'Selected run monitoring' })).not.toHaveTextContent('job_exact');
});

it('clears retained private monitor state when a receipt confirms revoked project access', async () => {
  await retainedPending();
  render(<RecoveryView />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Selected run monitoring' })).toHaveTextContent('job_exact'));
  fetch.mockResolvedValue({ ok: false, status: 403 });
  fireEvent.click(screen.getByRole('button', { name: 'Check receipt' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Saved submissions' })).toBeNull());
  expect(screen.getByRole('region', { name: 'Selected run monitoring' })).not.toHaveTextContent('job_exact');
});

it('retains a pending UUID when an unrelated selected monitoring record is missing', async () => {
  await retainedPending();
  fetch.mockImplementation(async url => url.includes('job-submissions') ? { ok: false, status: 503 } : response(installation));
  getRunMonitoring.mockRejectedValue(Object.assign(new Error('Run not found'), { status: 404 }));
  render(<RecoveryView />);
  await screen.findByRole('region', { name: `Submission ${requestId}` });
  fireEvent.click(await screen.findByRole('button', { name: /R analysis.*job_newer/ }));
  await screen.findByText('Run not found');
  await waitFor(() => expect(getRunMonitoring).toHaveBeenCalled());
  expect(getSubmissionRecoverySnapshot().records).toEqual(expect.arrayContaining([expect.objectContaining({ requestId, state: 'pending' })]));
  const another = vi.fn();
  await act(async () => { await expect(submitWithRecovery({ projectId: 'proj_one', submit: another })).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_REQUIRED' }); });
  expect(another).not.toHaveBeenCalled();
});

it('clears an exact recovered monitor selection when another window removes that project receipt', async () => {
  await retainedPending(); render(<RecoveryView />);
  await waitFor(() => expect(screen.getByRole('region', { name: 'Selected run monitoring' })).toHaveTextContent('job_exact'));
  await act(async () => {
    const value = JSON.parse(localStorage.getItem(RECOVERY_STORAGE_KEY)); value.records = []; value.selection = null;
    localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(value));
    window.dispatchEvent(new StorageEvent('storage', { key: RECOVERY_STORAGE_KEY }));
  });
  expect(screen.getByRole('region', { name: 'Selected run monitoring' })).not.toHaveTextContent('job_exact');
  expect(screen.queryByRole('region', { name: 'Saved submissions' })).toBeNull();
});

it('retains the exact identifier during tunnel loss and reads the receipt after reconnect without POST', async () => {
  let notify;
  const target = { id: 'lab', serviceIdentity: 'stable-lab', status: 'connected', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  await retainedPending();
  render(<RecoveryView />);
  await screen.findByRole('button', { name: 'Open exact run' });
  act(() => notify({ ...target, sshTunnel: { state: 'disconnected' } }));
  expect(screen.getByRole('button', { name: 'Check receipt' })).toBeDisabled();
  const before = fetch.mock.calls.length;
  act(() => notify(target));
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check receipt' })).toBeEnabled());
  expect(fetch.mock.calls.filter(([url]) => url.includes('job-submissions')).length).toBeGreaterThan(1);
  expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});
