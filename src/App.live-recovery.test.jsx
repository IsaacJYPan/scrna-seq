import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { getCachedResult, makeCacheKey, saveProvenance, setCachedResult } from './provenance';

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
  default: function WorkspaceHarness({ datasetInfo, onSelectAnalysisObject, callApi, pipelineState }) {
    const [result, setResult] = React.useState(null);
    return <div>
      <output data-testid="live-object">{datasetInfo?.id}:{datasetInfo?.liveState}</output>
      <output data-testid="live-completion">{pipelineState.umap ? 'completed' : 'pending'}</output>
      <output data-testid="pipeline-readiness">{JSON.stringify({
        normalize: pipelineState.normalize, pca: pipelineState.pca,
        cluster: pipelineState.cluster, umap: pipelineState.umap,
      })}</output>
      <output data-testid="execution-outcome">{result ? JSON.stringify(result) : ''}</output>
      <button onClick={() => onSelectAnalysisObject('proj_test', 'analysis_b')}>Select other analysis</button>
      <button onClick={() => callApi('/umap', {}, { operation: 'umap', step: 'umap' })}>Change live analysis</button>
      <button onClick={async () => setResult(await callApi('/umap', {}, { operation: 'umap', step: 'umap', cacheParams: { dims: 10 } }))}>Run and cache live analysis</button>
      <button onClick={async () => setResult(await callApi('/normalize', {}, { operation: 'normalize', step: 'normalize', cacheParams: { method: 'LogNormalize' } }))}>Hydrate cached normalization</button>
      <button onClick={() => callApi('/normalize', {}, { operation: 'normalize', step: 'normalize', useCache: false })}>Run fresh normalization</button>
    </div>;
  },
}));

const user = { id: 7, email: 'researcher@example.org' };
const clean = { exists: true, has_unsaved_changes: false, live_revision: 0, saved_revision: 0 };
const dirty = { ...clean, has_unsaved_changes: true, live_revision: 1 };

describe('App live analysis recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveProvenance.mockReset(); setCachedResult.mockReset();
    makeCacheKey.mockReset().mockResolvedValue('live-cache-key'); getCachedResult.mockReset().mockResolvedValue(null);
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

  it('preserves completed downstream readiness when a valid normalization cache entry hydrates', async () => {
    window.electronAPI.apiRequest.mockImplementation(async path => {
      if (path === '/session-id') return { sessionId: 'runtime-test' };
      if (path === '/pipeline-state') return {
        ...clean, has_qc: true, has_normalized: true, has_pca: true, has_clusters: true, has_umap: true,
      };
      return {};
    });
    getCachedResult.mockResolvedValue({
      provenanceId: 'prov_normalize_cached', result: { success: true },
    });
    window.electronAPI.getProvenance = vi.fn(async id => ({ id, operation: 'normalize' }));

    render(<App />);
    await waitFor(() => expect(screen.getByTestId('pipeline-readiness')).toHaveTextContent(
      '{"normalize":true,"pca":true,"cluster":true,"umap":true}'
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Hydrate cached normalization' }));
    await waitFor(() => expect(screen.getByTestId('execution-outcome')).toHaveTextContent('"_fromCache":true'));
    await waitFor(() => expect(screen.getByTestId('pipeline-readiness')).toHaveTextContent(
      '{"normalize":true,"pca":true,"cluster":true,"umap":true}'
    ));
    expect(window.electronAPI.apiRequest).not.toHaveBeenCalledWith('/normalize', expect.anything());
  });

  it('invalidates downstream readiness after a fresh normalization run', async () => {
    window.electronAPI.apiRequest.mockImplementation(async path => {
      if (path === '/session-id') return { sessionId: 'runtime-test' };
      if (path === '/pipeline-state') return {
        ...clean, has_qc: true, has_normalized: true, has_pca: true, has_clusters: true, has_umap: true,
      };
      if (path === '/normalize') return {
        provenance: { id: 'prov_normalize_fresh', operation: 'normalize' }, result: { success: true },
      };
      return {};
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId('pipeline-readiness')).toHaveTextContent(
      '{"normalize":true,"pca":true,"cluster":true,"umap":true}'
    ));
    fireEvent.click(screen.getByRole('button', { name: 'Run fresh normalization' }));
    await waitFor(() => expect(screen.getByTestId('pipeline-readiness')).toHaveTextContent(
      '{"normalize":true,"pca":false,"cluster":false,"umap":false}'
    ));
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

  it.each(['provenance', 'cache', 'cache-key', 'project-provenance'])('preserves completed R results and live state when the %s persistence write fails', async failure => {
    const api = window.electronAPI.apiRequest;
    const unavailable = new Error('Private persistence diagnostic at C:\\private\\database');
    api.mockImplementation(async path => {
      if (path === '/session-id') return { sessionId: 'runtime-test' };
      if (path === '/pipeline-state') return clean;
      if (path === '/umap') return { provenance: { id: 'prov_completed', operation: 'umap' }, result: { completed: true, n_points: 2 }, live_state: dirty, execution_history: { status: failure === 'project-provenance' ? 'unavailable' : 'recorded' } };
      return {};
    });
    if (failure === 'provenance') saveProvenance.mockRejectedValueOnce(unavailable);
    if (failure === 'cache') setCachedResult.mockRejectedValueOnce(unavailable);
    if (failure === 'cache-key') makeCacheKey.mockResolvedValueOnce('live-cache-key').mockRejectedValueOnce(unavailable);
    if (failure === 'project-provenance') window.electronAPI.createProjectProvenance = vi.fn().mockRejectedValueOnce(unavailable);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_a:attached'));
    fireEvent.click(screen.getByRole('button', { name: 'Run and cache live analysis' }));
    await waitFor(() => expect(screen.getByTestId('execution-outcome')).toHaveTextContent('"completed":true'));
    expect(screen.getByTestId('execution-outcome')).not.toHaveTextContent('"error"');
    expect(screen.getByTestId('live-completion')).toHaveTextContent('completed');
    expect(screen.getByText('Unsaved live changes.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Do not rerun it just to repair history.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Private persistence diagnostic');
    expect(api.mock.calls.filter(([path]) => path === '/umap')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss history notice' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('execution-outcome')).toHaveTextContent('"completed":true');
  });

});
