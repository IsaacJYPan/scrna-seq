import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./components/Sidebar', () => ({
  default: ({ setActiveTab }) => <aside>
    <button onClick={() => setActiveTab('workspace')}>Workspace</button>
    <button onClick={() => setActiveTab('team')}>Collaborators</button>
  </aside>,
}));
vi.mock('./components/ProvenanceDrawer', () => ({ default: () => null }));
vi.mock('./pipelines/useProjectPipelineSelection', () => ({
  useProjectPipelineSelection: () => ({ activePipeline: null, handlePipelineSelectionChanged: () => {} }),
}));
vi.mock('./provenance', () => ({
  saveProvenance: vi.fn(async () => 'prov_umap'),
  loadPersistedProvenance: vi.fn(async () => []),
  getProvenanceChain: vi.fn(async () => []),
  makeCacheKey: vi.fn(), getCachedResult: vi.fn(), setCachedResult: vi.fn(),
}));
vi.mock('./pages/Login', () => ({ default: () => <div data-testid="login">Sign in</div> }));
vi.mock('./pages/Workspace', () => ({
  default: ({ datasetInfo, pipelineState, sessionReady, currentWs, refreshProjects, callApi }) => (
    <section data-testid="workspace">
      <output aria-label="Live readiness">{sessionReady && datasetInfo?.liveState === 'attached' && pipelineState.cluster ? 'ready' : 'unavailable'}</output>
      <output aria-label="Selected analysis">{datasetInfo?.id || 'none'}</output>
      <output aria-label="Project role">{currentWs.projects[0]?.role || 'unknown'}</output>
      <button onClick={() => void refreshProjects()}>Refresh metadata</button>
      <button onClick={() => void callApi('/umap', {}, { operation: 'umap', step: 'umap', useCache: false })}>Run live analysis</button>
    </section>
  ),
}));
import App from './App';

const user = { id: 1, email: 'researcher@example.org' };
const object = { id: 'ao_abcdef1234', projectId: 'proj_1', ownerUserId: 1, displayName: 'PBMC 3k', objectType: 'seurat' };
const members = [{ userId: 1, email: user.email, role: 'owner' }];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitForReady() {
  await screen.findByTestId('workspace');
  await waitFor(() => expect(screen.getByLabelText('Live readiness')).toHaveTextContent('ready'));
}

describe('App session resolution and refresh recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    window.electronAPI = {
      restoreSession: vi.fn(async () => user),
      registrationPolicy: vi.fn(async () => ({})),
      listProjects: vi.fn(async () => [{ id: 'proj_1', name: 'Atlas', role: 'owner' }]),
      listProjectAnalysisObjects: vi.fn(async () => [object]),
      listProjectMembers: vi.fn(async () => members),
      apiRequest: vi.fn(async path => {
        if (path === '/session-id') return { sessionId: 'r-session-1' };
        if (path === '/pipeline-state') return { exists: true, has_qc: true, has_normalized: true, has_pca: true, has_clusters: true };
        if (path === '/umap') return { provenance: { id: 'prov_umap', operation: 'umap' }, result: {} };
        return {};
      }),
    };
  });
  afterEach(() => {
    cleanup();
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('shows a calm opening screen until a delayed cookie session is confirmed', async () => {
    const check = deferred();
    window.electronAPI.restoreSession.mockReturnValue(check.promise);
    localStorage.setItem('traceomics_auth_user', JSON.stringify({ email: 'stale@example.org' }));
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening your workspace');
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();
    await act(async () => check.resolve(user));
    await waitForReady();
  });

  it('shows sign-in only after the server confirms no valid session', async () => {
    window.electronAPI.restoreSession.mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByTestId('login')).toBeInTheDocument();
    expect(window.electronAPI.listProjects).not.toHaveBeenCalled();
  });

  it('offers recovery after a session outage without treating cached user metadata as authentication', async () => {
    window.electronAPI.restoreSession.mockRejectedValueOnce(new Error('network unavailable'));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('check your session');
    expect(screen.queryByTestId('login')).not.toBeInTheDocument();
    expect(window.electronAPI.listProjects).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitForReady();
    expect(window.electronAPI.restoreSession).toHaveBeenCalledTimes(2);
  });

  it('keeps readiness and unsaved changes through a failed member refresh and its successful retry', async () => {
    render(<React.StrictMode><App /></React.StrictMode>);
    await waitForReady();
    fireEvent.click(screen.getByRole('button', { name: 'Run live analysis' }));
    await screen.findByText('Unsaved live changes.');
    window.electronAPI.listProjectMembers.mockRejectedValue(Object.assign(new Error('Members temporarily unavailable.'), { status: 503 }));
    const projectReads = window.electronAPI.listProjects.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Collaborators' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load project members.');
    await waitFor(() => expect(window.electronAPI.listProjects.mock.calls.length).toBeGreaterThan(projectReads));
    window.electronAPI.listProjectMembers.mockResolvedValue(members);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Your role: owner');
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    await waitForReady();
    expect(screen.getByText('Unsaved live changes.')).toBeInTheDocument();
    expect(screen.getByLabelText('Selected analysis')).toHaveTextContent(object.id);
  });

  it('preserves the live analysis during an object-list outage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await waitForReady();
    fireEvent.click(screen.getByRole('button', { name: 'Run live analysis' }));
    await screen.findByText('Unsaved live changes.');
    window.electronAPI.listProjectAnalysisObjects.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh metadata' }));
    await waitFor(() => expect(window.electronAPI.listProjectAnalysisObjects).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Selected analysis')).toHaveTextContent(object.id);
    expect(screen.getByLabelText('Live readiness')).toHaveTextContent('ready');
    expect(screen.getByText('Unsaved live changes.')).toBeInTheDocument();
  });

  it('updates demoted permissions while retaining the same verified analysis', async () => {
    render(<App />);
    await waitForReady();
    window.electronAPI.listProjectMembers.mockResolvedValue([{ ...members[0], role: 'viewer' }]);
    window.electronAPI.listProjects.mockResolvedValue([{ id: 'proj_1', name: 'Atlas', role: 'viewer' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Collaborators' }));
    expect(await screen.findByText('Your role: viewer')).toBeInTheDocument();
    expect(screen.queryByText('Add existing user')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Project role')).toHaveTextContent('viewer'));
    expect(screen.getByLabelText('Selected analysis')).toHaveTextContent(object.id);
    expect(screen.getByLabelText('Live readiness')).toHaveTextContent('ready');
  });
});
