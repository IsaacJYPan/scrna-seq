import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ServerReadiness from './ServerReadiness';
import { readinessFixture } from '../runtime/_runtimeReadinessFixtures';

const props = { projectId: 'project_one', userId: 1, target: { id: 'lab_one', name: 'Lab server', endpoint: 'https://analysis.example.org', status: 'connected', sshTunnel: { state: 'connected' } }, onClose: vi.fn() };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('checks the selected server without dispatching analyses and displays exact environments, worker/storage observations and ceilings', async () => {
  const api = { getRuntimeReadiness: vi.fn(async () => readinessFixture()), createProjectJob: vi.fn(), startPrivateRKernel: vi.fn() };
  render(<ServerReadiness {...props} api={api} />);
  const dialog = screen.getByRole('dialog', { name: 'Server readiness' });
  expect(dialog).toHaveAttribute('aria-modal', 'true'); expect(screen.getByRole('button', { name: 'Close server readiness' })).toHaveFocus();
  expect(await screen.findByText('This server supports the current application. Guided R target: R 4.5.x.')).toBeVisible();
  expect(screen.getByText('R 4.5.3 · Bioconductor 3.22')).toBeVisible(); expect(screen.getByText(/Sessions per researcher/)).toBeVisible();
  expect(screen.getByText(/limits are ceilings/)).toBeVisible(); expect(screen.getAllByText(/Observed free: 32 GiB/)).toHaveLength(4);
  expect(screen.queryByText('An exact custom R environment has not been verified.')).not.toBeInTheDocument();
  expect(api.createProjectJob).not.toHaveBeenCalled(); expect(api.startPrivateRKernel).not.toHaveBeenCalled();
  expect(api.getRuntimeReadiness).toHaveBeenCalledWith('project_one', { signal: expect.any(AbortSignal) });
  expect(within(screen.getByRole('region', { name: 'Readiness actions' })).getByText('Guided analysis · CellChat')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Check again' })); await waitFor(() => expect(api.getRuntimeReadiness).toHaveBeenCalledTimes(2));
});

it('does not turn an absent worker, environment or package probe into available compute', async () => {
  render(<ServerReadiness {...props} api={{ getRuntimeReadiness: async () => readinessFixture({ guided: { state: 'unknown' }, workers: { state: 'unknown', mode: 'standalone' }, privateR: { state: 'unknown', accessState: 'access-required' }, issues: [{ code: 'WORKER_UNKNOWN', scope: 'workers', state: 'unknown' }, { code: 'PRIVATE_R_ACCESS_REQUIRED', scope: 'private-r', state: 'unknown' }] }) }} />);
  expect(await screen.findByText('An exact custom R environment has not been verified.')).toBeVisible();
  expect(screen.getAllByText('Resource limits have not been verified.')).toHaveLength(2);
  expect(screen.getByText('Execution access required')).toBeVisible(); expect(screen.getByText(/No current queued-worker observation/)).toBeVisible();
  expect(screen.getByText('Pathway enrichment: Not verified · CellChat: Not verified')).toBeVisible();
});

it('retains useful pinned identity while showing unavailable runtime and insufficient storage with remediation', async () => {
  const report = readinessFixture(); report.privateR.state = 'unavailable';
  report.storage.durable = { state: 'insufficient-resources', writable: true, freeBytes: 0, minFreeBytes: 1024 ** 3, reservedBytes: 0 };
  report.issues = [{ code: 'PRIVATE_R_UNAVAILABLE', scope: 'private-r', state: 'unavailable' }, { code: 'STORAGE_PRESSURE', scope: 'durable-storage', state: 'insufficient-resources' }];
  render(<ServerReadiness {...props} api={{ getRuntimeReadiness: async () => report }} />);
  expect(await screen.findByText('Pinned R environment', { exact: true })).toBeVisible();
  expect(screen.getByText(/Runtime availability is shown above/)).toBeVisible(); expect(screen.getByText('Unavailable when checked', { exact: true })).toBeVisible();
  expect(screen.getByText(/Observed free: 0 B/)).toBeVisible(); expect(screen.getByText(/expand storage before starting heavy work/)).toBeVisible();
});

it('makes cached observations stale and requires an explicit new check without polling', async () => {
  const api = { getRuntimeReadiness: vi.fn(async () => readinessFixture({ checkedAt: new Date(Date.now() - 6000).toISOString() })) };
  render(<ServerReadiness {...props} api={api} />);
  expect(await screen.findByText(/observation is no longer current/)).toBeVisible();
  expect(api.getRuntimeReadiness).toHaveBeenCalledTimes(1);
});

it('discards a late response when the user or project changes and aborts the old check', async () => {
  let finish;
  const api = { getRuntimeReadiness: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(readinessFixture({ privateR: { state: 'unknown', accessState: 'access-required' } })) };
  const view = render(<ServerReadiness {...props} api={api} />);
  const signal = api.getRuntimeReadiness.mock.calls[0][1].signal;
  view.rerender(<ServerReadiness {...props} api={api} projectId="project_two" userId={2} />);
  expect(await screen.findByText('Execution access required')).toBeVisible(); expect(signal.aborted).toBe(true);
  await act(async () => finish(readinessFixture()));
  expect(screen.queryByText('R 4.5.3 · Bioconductor 3.22')).not.toBeInTheDocument();
  expect(api.getRuntimeReadiness).toHaveBeenCalledTimes(2);
});

it('immediately removes previous observations on tunnel loss and never checks a fallback server', async () => {
  const api = { getRuntimeReadiness: vi.fn(async () => readinessFixture()) };
  const view = render(<ServerReadiness {...props} api={api} />); await screen.findByText('R 4.5.3 · Bioconductor 3.22');
  view.rerender(<ServerReadiness {...props} api={api} target={{ ...props.target, status: 'disconnected', sshTunnel: { state: 'disconnected' } }} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/SSH connection is disconnected/);
  expect(screen.queryByText('R 4.5.3 · Bioconductor 3.22')).not.toBeInTheDocument(); expect(api.getRuntimeReadiness).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
});

it.each([[401, /sign-in has expired/], [503, /selected server could not be reached/]])('shows concrete recovery for HTTP %s without raw server errors', async (status, message) => {
  render(<ServerReadiness {...props} api={{ getRuntimeReadiness: async () => { throw Object.assign(new Error('/private/host: password secret'), { status }); } }} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(message); expect(document.body.textContent).not.toMatch(/password secret|private\/host/);
});

it('supports keyboard dismissal, confines tab focus and restores the opener', async () => {
  const opener = document.createElement('button'); opener.textContent = 'Open readiness'; document.body.appendChild(opener); opener.focus();
  const view = render(<ServerReadiness {...props} api={{ getRuntimeReadiness: async () => readinessFixture() }} />);
  await screen.findByText('R 4.5.3 · Bioconductor 3.22');
  const close = screen.getByRole('button', { name: 'Close server readiness' });
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(screen.getByText('Exact environment identity')).toHaveFocus();
  fireEvent.keyDown(document.activeElement, { key: 'Tab' }); expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Escape' }); expect(props.onClose).toHaveBeenCalledOnce(); view.unmount(); expect(opener).toHaveFocus(); opener.remove();
});
