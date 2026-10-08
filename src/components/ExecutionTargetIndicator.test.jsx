import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ExecutionTargetIndicator from './ExecutionTargetIndicator';

afterEach(() => { delete window.desktopShell; });

it('shows the current browser server and verified R availability', () => {
  render(<ExecutionTargetIndicator deploymentPolicy={{ expertRStatus: { state: 'ready' } }} />);
  expect(screen.getByText(`Server: ${window.location.origin}`)).toBeVisible();
  expect(screen.getByText('R available')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Change server' })).not.toBeInTheDocument();
});

it('shows the window-bound desktop target and opens native settings', async () => {
  window.desktopShell = {
    getCurrentTarget: vi.fn(async () => ({ name: 'Lab workstation', endpoint: 'https://analysis.example.org', status: 'connected' })),
    openTargetSettings: vi.fn(async () => {}),
  };
  render(<ExecutionTargetIndicator deploymentPolicy={{ expertRStatus: { state: 'access-revoked' } }} />);
  expect(await screen.findByText('Server: Lab workstation')).toBeVisible();
  expect(screen.getByText('R access revoked')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Change server' }));
  expect(window.desktopShell.openTargetSettings).toHaveBeenCalledOnce();
});

it('keeps the current server visible if native metadata cannot be read', async () => {
  window.desktopShell = { getCurrentTarget: vi.fn(async () => { throw new Error('IPC unavailable'); }) };
  render(<ExecutionTargetIndicator />);
  expect(await screen.findByText('Connection details are unavailable.')).toBeVisible();
  expect(screen.getByText(`Server: ${window.location.origin}`)).toBeVisible();
});
