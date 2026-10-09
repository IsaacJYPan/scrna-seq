import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ExecutionTargetIndicator from './ExecutionTargetIndicator';

afterEach(() => { delete window.desktopShell; });

it('shows verified R availability with browser server details on demand', () => {
  render(<ExecutionTargetIndicator deploymentPolicy={{ expertRStatus: { state: 'ready' } }} />);
  expect(screen.getByText(`Server: ${window.location.origin}`)).not.toBeVisible();
  fireEvent.click(screen.getByText('Connection details'));
  expect(screen.getByText(`Server: ${window.location.origin}`)).toBeVisible();
  expect(screen.getByText('Custom R available')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Change server' })).not.toBeInTheDocument();
});

it('shows the window-bound desktop target and opens native settings', async () => {
  window.desktopShell = {
    getCurrentTarget: vi.fn(async () => ({ name: 'Lab workstation', endpoint: 'https://analysis.example.org', status: 'connected' })),
    openTargetSettings: vi.fn(async () => {}),
  };
  render(<ExecutionTargetIndicator deploymentPolicy={{ expertRStatus: { state: 'access-revoked' } }} />);
  fireEvent.click(screen.getByText('Connection details'));
  expect(await screen.findByText('Server: Lab workstation')).toBeVisible();
  expect(screen.getByText('Custom R access revoked')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Change server' }));
  expect(window.desktopShell.openTargetSettings).toHaveBeenCalledOnce();
});

it('keeps the current server visible if native metadata cannot be read', async () => {
  window.desktopShell = { getCurrentTarget: vi.fn(async () => { throw new Error('IPC unavailable'); }) };
  render(<ExecutionTargetIndicator />);
  expect(await screen.findByText('Connection needs attention')).toBeVisible();
  fireEvent.click(screen.getByText('Connection details'));
  expect(screen.getByText('Connection details are unavailable.')).toBeVisible();
  expect(screen.getByText(`Server: ${window.location.origin}`)).toBeVisible();
});

it('preserves initially disconnected target metadata and provides reconnect instructions', async () => {
  window.desktopShell = { getCurrentTarget: vi.fn(async () => ({ id: 'lab', name: 'Lab server',
    endpoint: 'https://analysis.example.org', status: 'disconnected', sshTunnel: { state: 'disconnected' } })) };
  render(<ExecutionTargetIndicator deploymentPolicy={{ expertRStatus: { state: 'not-configured' } }} />);
  expect(await screen.findByText('SSH tunnel disconnected')).toBeVisible();
  expect(screen.getByText('Custom R setup required')).toBeVisible();
  fireEvent.click(screen.getByText('Connection details'));
  expect(screen.getByText('Server: Lab server')).toBeVisible();
  expect(screen.getByText(/Reconnect through server settings/)).toBeVisible();
});

it('shows tunnel loss in the current workspace and removes its subscription on unmount', async () => {
  let notify;
  const unsubscribe = vi.fn();
  const target = { id: 'target_lab', name: 'Lab server', endpoint: 'https://analysis.example.org',
    status: 'connected', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: vi.fn(async () => target),
    onTargetStatus: vi.fn(listener => { notify = listener; return unsubscribe; }) };
  const view = render(<ExecutionTargetIndicator />);
  expect(await screen.findByText('SSH tunnel connected')).toBeVisible();
  fireEvent.click(screen.getByText('Connection details'));
  act(() => notify({ ...target, sshTunnel: { state: 'disconnected' } }));
  expect(screen.getByText('SSH tunnel disconnected', { exact: true })).toBeVisible();
  expect(screen.getByText('Server: Lab server')).toBeVisible();
  act(() => notify({ ...target, id: 'another_window', name: 'Another workspace' }));
  expect(screen.queryByText('Server: Another workspace')).not.toBeInTheDocument();
  view.unmount(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it('does not overwrite a tunnel loss event with a delayed initial status', async () => {
  let initial, notify;
  const target = { id: 'target_lab', name: 'Lab server', status: 'connected',
    endpoint: 'https://analysis.example.org' };
  window.desktopShell = { getCurrentTarget: vi.fn(() => new Promise(resolve => { initial = resolve; })),
    onTargetStatus: listener => { notify = listener; return () => {}; } };
  render(<ExecutionTargetIndicator />);
  act(() => notify({ ...target, sshTunnel: { state: 'disconnected' } }));
  await act(async () => initial({ ...target, sshTunnel: { state: 'connected' } }));
  expect(screen.getByText('SSH tunnel disconnected', { exact: true })).toBeVisible();
  expect(screen.queryByText('SSH tunnel connected')).not.toBeInTheDocument();
});
