import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./components/Sidebar', () => ({ default: () => null }));
vi.mock('./components/ProvenanceDrawer', () => ({ default: () => null }));
vi.mock('./pipelines/useProjectPipelineSelection', () => ({
  useProjectPipelineSelection: () => ({ activePipeline: null, handlePipelineSelectionChanged: vi.fn() }),
}));
vi.mock('./provenance', () => ({
  saveProvenance: vi.fn(), loadPersistedProvenance: vi.fn(async () => []),
  getProvenanceChain: vi.fn(), makeCacheKey: vi.fn(), getCachedResult: vi.fn(),
  setCachedResult: vi.fn(),
}));
vi.mock('./pages/Workspace', () => ({
  default: ({ datasetInfo, onSelectAnalysisObject, callApi }) => <div>
    <output data-testid="live-object">{datasetInfo?.id}:{datasetInfo?.liveState}</output>
    <button onClick={() => onSelectAnalysisObject('proj_test', 'analysis_b')}>Select other analysis</button>
    <button onClick={() => callApi('/umap', {}, { operation: 'umap', step: 'umap' })}>Change live analysis</button>
  </div>,
}));

const user = { id: 7, email: 'researcher@example.org' };
const clean = { exists: true, has_unsaved_changes: false, live_revision: 0, saved_revision: 0 };
const dirty = { ...clean, has_unsaved_changes: true, live_revision: 1 };

describe('App live analysis recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    window.electronAPI = {
      restoreSession: vi.fn(async () => user),
      listProjects: vi.fn(async () => [{ id: 'proj_test', name: 'Study', role: 'owner' }]),
      listProjectAnalysisObjects: vi.fn(async () => ['analysis_a', 'analysis_b'].map(id => ({
        id, projectId: 'proj_test', displayName: id, ownerUserId: 7, objectType: 'seurat',
      }))),
      apiRequest: vi.fn(async path => {
        if (path === '/session-id') return { sessionId: 'runtime-test' };
        if (path === '/pipeline-state') return clean;
        if (path === '/umap') return {
          provenance: { id: 'prov_test', operation: 'umap' }, result: {}, live_state: dirty,
        };
        return { mode: 'test' };
      }),
    };
  });
  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('recovers an unsaved warning from the server after remounting the browser app', async () => {
    const original = window.electronAPI.apiRequest;
    original.mockImplementation(async path => path === '/pipeline-state'
      ? dirty : path === '/session-id' ? { sessionId: 'runtime-test' } : {});
    const first = render(<App />);
    expect(await screen.findByText('Unsaved live changes.')).toBeInTheDocument();
    first.unmount();
    render(<App />);
    expect(await screen.findByText('Unsaved live changes.')).toBeInTheDocument();
  });

  it('offers saved-version recovery when the R session no longer has the object', async () => {
    window.electronAPI.apiRequest.mockImplementation(async path => path === '/pipeline-state'
      ? { exists: false } : path === '/session-id' ? { sessionId: 'new-runtime' } : {});
    render(<App />);
    expect(await screen.findByText(/Live analysis is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Unsaved live changes.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Runs & Results' })).toBeInTheDocument();
  });

  it('uses mutation status immediately and clears it when selecting a clean object', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_a:attached'));
    fireEvent.click(screen.getByRole('button', { name: 'Change live analysis' }));
    expect(await screen.findByText('Unsaved live changes.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select other analysis' }));
    await waitFor(() => expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_b:attached'));
    expect(screen.queryByText('Unsaved live changes.')).not.toBeInTheDocument();
  });

  it('ignores an earlier object probe that finishes after switching analyses', async () => {
    let finishOldProbe;
    window.electronAPI.apiRequest.mockImplementation(async (path, options) => {
      if (path === '/session-id') return { sessionId: 'runtime-test' };
      if (path === '/pipeline-state' && options.headers['X-Object-ID'] === 'analysis_a') {
        return new Promise(resolve => { finishOldProbe = resolve; });
      }
      return path === '/pipeline-state' ? clean : {};
    });
    render(<App />);
    await waitFor(() => expect(finishOldProbe).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Select other analysis' }));
    await waitFor(() => expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_b:attached'));
    await act(async () => { finishOldProbe(dirty); });
    expect(screen.queryByText('Unsaved live changes.')).not.toBeInTheDocument();
    expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_b:attached');
  });
  it('retries a canceled initial object probe after slow workspace loading', async () => {
    let finishObjectLoad;
    window.electronAPI.listProjectAnalysisObjects.mockImplementation(() => new Promise(resolve => {
      finishObjectLoad = resolve;
    }));
    window.electronAPI.apiRequest.mockImplementation(async path => path === '/pipeline-state'
      ? dirty : path === '/session-id' ? { sessionId: 'runtime-test' } : {});
    render(<App />);
    await waitFor(() => expect(finishObjectLoad).toBeTypeOf('function'));
    await waitFor(() => expect(window.electronAPI.apiRequest).toHaveBeenCalledWith('/session-id'));
    await act(async () => {
      finishObjectLoad([{ id: 'analysis_a', projectId: 'proj_test', ownerUserId: 7, objectType: 'seurat' }]);
    });
    expect(await screen.findByText('Unsaved live changes.')).toBeInTheDocument();
    expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_a:attached');
  });

});
