import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ExploratoryAnalysis from './ExploratoryAnalysis';

const { plotSpy } = vi.hoisted(() => ({ plotSpy: vi.fn() }));
vi.mock('../components/Plot', () => ({ default: props => { plotSpy(props); return <div>Local chart</div>; } }));
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

it('says which genes are left out and asks for every cluster', async () => {
  window.electronAPI = { createExploratoryAnalysisJob: vi.fn(async () => ({ id: 'job_1', status: 'queued' })), getProjectJob: vi.fn(async () => ({ id: 'job_1', status: 'queued' })), listProjectJobArtifacts: vi.fn(async () => []) };
  render(<ExploratoryAnalysis currentWs={{ selectedProjectId: 'project', projects: [{ id: 'project', role: 'analyst' }] }} datasetInfo={{ id: 'analysis', projectId: 'project', ownerUserId: 1 }} userId={1} userEmail="researcher@example.test"/>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Recipe' }), { target: { value: 'feature_by_group' } });
  const genes = Array.from({ length: 14 }, (_, index) => `G${index + 1}`).join(', ');
  fireEvent.change(screen.getByRole('textbox', { name: /Features/ }), { target: { value: genes } });
  expect(screen.getByText(/G13, G14 will be left out/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run recipe' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Run recipe' }));
  await waitFor(() => expect(window.electronAPI.createExploratoryAnalysisJob).toHaveBeenCalled());
  const payload = JSON.stringify(window.electronAPI.createExploratoryAnalysisJob.mock.calls[0]);
  expect(payload).toContain('"maxGroups":32');
  expect(payload).toContain('"G12"');
  expect(payload).not.toContain('"G13"');
});

it('runs a group composition by sample and stacks each sample to 100 percent, grouped by condition', async () => {
  const summary = { recipe: 'group_composition', nCells: 300, panels: [{ type: 'composition', title: 'Group composition by sample_id', rows: [
    { label: 'S2', group: 'Macrophages', condition: 'severe', count: 90, fraction: 0.9 },
    { label: 'S2', group: 'T cells', condition: 'severe', count: 10, fraction: 0.1 },
    { label: 'S1', group: 'Macrophages', condition: 'healthy', count: 50, fraction: 0.5 },
    { label: 'S1', group: 'T cells', condition: 'healthy', count: 50, fraction: 0.5 },
  ] }] };
  window.electronAPI = {
    createExploratoryAnalysisJob: vi.fn(async () => ({ id: 'job_2', status: 'completed' })),
    getProjectJob: vi.fn(async () => ({ id: 'job_2', status: 'completed' })),
    listProjectJobArtifacts: vi.fn(async () => [{ artifactType: 'exploration_summary', metadata: { summary } }]),
  };
  render(<ExploratoryAnalysis currentWs={{ selectedProjectId: 'project', projects: [{ id: 'project', role: 'analyst' }] }} datasetInfo={{ id: 'analysis', projectId: 'project', ownerUserId: 1 }} userId={1} userEmail="researcher@example.test"/>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Recipe' }), { target: { value: 'group_composition' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Groups' }), { target: { value: 'ident' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run recipe' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Run recipe' }));
  await waitFor(() => expect(window.electronAPI.createExploratoryAnalysisJob).toHaveBeenCalled());
  expect(window.electronAPI.createExploratoryAnalysisJob.mock.calls[0][2]).toMatchObject({ recipe: 'group_composition', metadataField: 'sample_id', groupBy: 'ident' });
  await waitFor(() => expect(plotSpy.mock.calls.at(-1)?.[0].layout.barmode).toBe('stack'));
  const { data } = plotSpy.mock.calls.at(-1)[0];
  expect(data.map(trace => trace.name)).toEqual(['Macrophages', 'T cells']);
  expect(data[0].x).toEqual(['healthy · S1', 'severe · S2']);
  expect(data[0].y).toEqual([50, 90]);
});
