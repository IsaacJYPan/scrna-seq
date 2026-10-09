import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ExploratoryAnalysis from './ExploratoryAnalysis';

vi.mock('../components/Plot', () => ({ default: () => <div>Local chart</div> }));
afterEach(() => { delete window.desktopShell; delete window.electronAPI; });

it('blocks guided recipes after tunnel loss without submitting or selecting a fallback service', async () => {
  let notify;
  const target = { id: 'lab', status: 'connected', serviceIdentity: 'selected-lab', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  window.electronAPI = { createExploratoryAnalysisJob: vi.fn() };
  render(<ExploratoryAnalysis currentWs={{ selectedProjectId: 'project', projects: [{ id: 'project', role: 'analyst' }] }} datasetInfo={{ id: 'analysis', projectId: 'project', ownerUserId: 1 }} userId={1} userEmail="researcher@example.test"/>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run recipe' })).toBeEnabled());
  act(() => notify({ ...target, status: 'disconnected', sshTunnel: { state: 'disconnected' } }));
  expect(screen.getByRole('button', { name: 'Run recipe' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Run recipe' }));
  expect(window.electronAPI.createExploratoryAnalysisJob).not.toHaveBeenCalled();
  expect(screen.getByText(/Reconnect through Connection details/)).toBeVisible();
  act(() => notify(target));
  expect(screen.getByRole('button', { name: 'Run recipe' })).toBeEnabled();
  expect(window.electronAPI.createExploratoryAnalysisJob).not.toHaveBeenCalled();
});
