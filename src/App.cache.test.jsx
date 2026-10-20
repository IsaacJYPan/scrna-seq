import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ workspace: null, history: null }));

vi.mock('./components/Sidebar', () => ({ default: () => null }));
vi.mock('./components/ProvenanceDrawer', () => ({ default: () => null }));
vi.mock('./pipelines/useProjectPipelineSelection', () => ({
  useProjectPipelineSelection: () => ({ activePipeline: null, handlePipelineSelectionChanged: vi.fn() }),
}));
vi.mock('./provenance', () => ({
  saveProvenance: vi.fn(), loadPersistedProvenance: vi.fn(async () => []),
  getProvenanceChain: vi.fn(), makeCacheKey: vi.fn(), getCachedResult: vi.fn(), setCachedResult: vi.fn(),
}));
vi.mock('./pages/Workspace', () => ({
  default: props => {
    harness.workspace = props;
    return <output data-testid="live-object">{props.datasetInfo?.id}:{props.datasetInfo?.liveState}</output>;
  },
}));
vi.mock('./pages/ProjectHistory', () => ({
  default: props => {
    harness.history = props;
    return <output data-testid="history-harness">{props.datasetInfo?.id}</output>;
  },
}));

import App from './App';
import { getCachedResult, makeCacheKey, saveProvenance, setCachedResult } from './provenance';

const user = { id: 7, email: 'researcher@example.org' };
const attached = {
  exists: true, live_revision: 0, saved_revision: 0, has_unsaved_changes: false,
  has_qc: true, has_normalized: true, has_pca: true, has_clusters: true, has_umap: true,
  n_clusters: 3, cluster_dims: 15,
};
const normalizeContext = {
  operation: 'normalize', step: 'normalize', parentIds: ['prov_qc'],
  cacheParams: { method: 'LogNormalize', scale_factor: 10000 },
};

async function mountApp() {
  const rendered = render(<App />);
  await waitFor(() => expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_a:attached'));
  return rendered;
}

async function callApi(path, context) {
  let data;
  await act(async () => { data = await harness.workspace.callApi(path, {}, context); });
  return data;
}

function analysisRequests() {
  return window.electronAPI.apiRequest.mock.calls.filter(([path]) => path.startsWith('/analysis/'));
}

describe('App analysis result caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    harness.workspace = null;
    harness.history = null;
    const results = new Map();
    const provenance = new Map();
    makeCacheKey.mockReset().mockImplementation(async (...parts) => JSON.stringify(parts));
    getCachedResult.mockReset().mockImplementation(async key => results.get(key) || null);
    setCachedResult.mockReset().mockImplementation(async (key, provenanceId, result) => {
      results.set(key, { provenanceId, result });
    });
    saveProvenance.mockReset().mockImplementation(async envelope => {
      provenance.set(envelope.provenance.id, envelope.provenance);
    });
    let sequence = 0;
    window.electronAPI = {
      restoreSession: vi.fn(async () => user),
      listProjects: vi.fn(async () => [{ id: 'project_a', name: 'Atlas', role: 'owner' }]),
      listProjectAnalysisObjects: vi.fn(async () => ['analysis_a', 'analysis_b'].map(id => ({
        id, projectId: 'project_a', ownerUserId: 7, objectType: 'seurat', displayName: id,
      }))),
      getProvenance: vi.fn(async id => provenance.get(id) || null),
      apiRequest: vi.fn(async path => {
        if (path === '/session-id') return { sessionId: 'r-session-1' };
        if (path === '/pipeline-state') return attached;
        if (path.startsWith('/analysis/')) {
          sequence += 1;
          return {
            provenance: { id: `prov_${sequence}`, operation: path.split('/')[2] },
            result: { completed: true, path, n_clusters: 4, dims_used: 20 },
            live_state: { ...attached, live_revision: sequence, has_unsaved_changes: true },
            execution_history: { status: 'recorded' },
          };
        }
        return {};
      }),
    };
  });
  afterEach(() => {
    cleanup();
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('stores under the lookup identity and hydrates identical results with one R request', async () => {
    await mountApp();
    const fresh = await callApi('/analysis/normalize', normalizeContext);
    const cached = await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true });

    expect(cached).toEqual({ provenance: fresh.provenance, result: fresh.result, _fromCache: true });
    expect(analysisRequests()).toHaveLength(1);
    expect(makeCacheKey).toHaveBeenCalledTimes(2);
    expect(makeCacheKey).toHaveBeenNthCalledWith(1, 'normalize', {
      ...normalizeContext.cacheParams, _rSession: 'r-session-1', _objectId: 'analysis_a',
    }, harness.workspace.currentWs.dataVersion, ['prov_qc']);
    expect(setCachedResult.mock.calls[0][0]).toBe(await makeCacheKey.mock.results[0].value);
    expect(cached.provenance.parentIds).toEqual(['prov_qc']);
  });

  it('applies A, B, then A in R instead of reusing an earlier stateful result', async () => {
    await mountApp();
    const context = { operation: 'cluster', step: 'cluster', parentIds: ['prov_pca'] };
    const a = { ...context, cacheParams: { dims: 15, resolution: 0.5, seed: 42 } };
    const b = { ...context, cacheParams: { dims: 20, resolution: 1, seed: 42 } };
    const first = await callApi('/analysis/cluster?resolution=0.5', a);
    const second = await callApi('/analysis/cluster?resolution=1', b);
    const third = await callApi('/analysis/cluster?resolution=0.5', a);

    expect(analysisRequests()).toHaveLength(3);
    expect([first, second, third].every(data => !data._fromCache)).toBe(true);
    expect(third.result).toEqual(first.result);
    expect(third.provenance.id).not.toBe(first.provenance.id);
    expect(makeCacheKey).toHaveBeenCalledTimes(3);
    expect(getCachedResult).not.toHaveBeenCalled();
  });

  it('preserves completed downstream readiness when a known upstream result hydrates', async () => {
    await mountApp();
    const fresh = await callApi('/analysis/normalize', normalizeContext);
    for (const step of ['pca', 'cluster', 'umap']) {
      await callApi(`/analysis/${step}`, { operation: step, step, useCache: false });
    }
    const stateBeforeHydration = harness.workspace.pipelineState;
    expect(stateBeforeHydration).toMatchObject({ normalize: true, pca: true, cluster: true, umap: true });
    const cached = await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true });

    expect(cached).toEqual({ provenance: fresh.provenance, result: fresh.result, _fromCache: true });
    expect(harness.workspace.pipelineState).toEqual(stateBeforeHydration);
    expect(analysisRequests()).toHaveLength(4);
    expect(getCachedResult).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a cached downstream step after an upstream run invalidates it', async () => {
    await mountApp();
    const cluster = { operation: 'cluster', step: 'cluster', cacheParams: { dims: 15, seed: 42 } };
    await callApi('/analysis/cluster', cluster);
    await callApi('/analysis/normalize', { ...normalizeContext, useCache: false });
    const stateBeforeHydration = harness.workspace.pipelineState;
    expect(stateBeforeHydration.cluster).toBe(false);

    expect(await callApi('/analysis/cluster', { ...cluster, onlyIfCached: true })).toBeNull();
    expect(harness.workspace.pipelineState).toEqual(stateBeforeHydration);
    expect(analysisRequests()).toHaveLength(2);
    expect(getCachedResult).not.toHaveBeenCalled();
  });

  it.each(['error', 'missing provenance'])('invalidates current cache identity before a mutation returns %s', async outcome => {
    await mountApp();
    await callApi('/analysis/normalize', normalizeContext);
    window.electronAPI.apiRequest.mockResolvedValueOnce(outcome === 'error'
      ? { error: 'R service is busy' } : { result: { completed: true } });
    const response = await callApi('/analysis/normalize', {
      ...normalizeContext, cacheParams: { ...normalizeContext.cacheParams, scale_factor: 20000 },
    });
    if (outcome === 'error') expect(response.error).toBeTruthy();
    else expect(response.result.completed).toBe(true);

    expect(await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true })).toBeNull();
    expect(getCachedResult).not.toHaveBeenCalled();
  });

  it('clears known identities when a read reveals an unobserved live revision', async () => {
    await mountApp();
    await callApi('/analysis/normalize', normalizeContext);
    window.electronAPI.apiRequest.mockResolvedValueOnce({
      live_state: { ...attached, live_revision: 100, has_unsaved_changes: true },
    });
    await callApi('/object-info', { useCache: false });

    expect(await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true })).toBeNull();
    expect(getCachedResult).not.toHaveBeenCalled();
  });

  it('discards current identities when the same object is selected after restoring a checkpoint', async () => {
    await mountApp();
    await callApi('/analysis/normalize', normalizeContext);
    await act(async () => harness.workspace.onSelectAnalysisObject('project_a', 'analysis_a'));

    expect(await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true })).toBeNull();
    expect(harness.workspace.datasetInfo.id).toBe('analysis_a');
    expect(getCachedResult).not.toHaveBeenCalled();
    expect(analysisRequests()).toHaveLength(1);
  });

  it('discards current identities on a direct same-object live attachment callback', async () => {
    await mountApp();
    await callApi('/analysis/normalize', normalizeContext);
    await act(async () => harness.workspace.setActiveTab('history'));
    await screen.findByTestId('history-harness');
    await act(async () => harness.history.onLiveObjectAttached('project_a', 'analysis_a'));

    expect(await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true })).toBeNull();
    expect(getCachedResult).not.toHaveBeenCalled();
    expect(analysisRequests()).toHaveLength(1);
  });

  it('does not bind a delayed older live revision as the current cached result', async () => {
    await mountApp();
    await callApi('/analysis/normalize', normalizeContext);
    window.electronAPI.apiRequest.mockResolvedValueOnce({
      provenance: { id: 'prov_older_response', operation: 'normalize' },
      result: { completed: true }, live_state: { ...attached, live_revision: 0 },
      execution_history: { status: 'recorded' },
    });
    const older = await callApi('/analysis/normalize', normalizeContext);

    expect(older.result.completed).toBe(true);
    expect(setCachedResult).toHaveBeenCalledTimes(1);
    expect(await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true })).toBeNull();
    expect(getCachedResult).not.toHaveBeenCalled();
  });

  it('retains a delayed QC attempt without replacing newer live flags, counts, or branch head', async () => {
    await mountApp();
    let finishOldQc;
    window.electronAPI.apiRequest.mockImplementationOnce(() => new Promise(resolve => { finishOldQc = resolve; }));
    let oldRequest;
    await act(async () => {
      oldRequest = harness.workspace.callApi('/analysis/qc', {}, {
        operation: 'quality-control', step: 'qc', cacheParams: { min_features: 200 },
      });
    });
    await waitFor(() => expect(finishOldQc).toBeTypeOf('function'));
    const latest = {
      provenance: { id: 'prov_newer_umap', operation: 'umap' },
      result: { completed: true },
      live_state: { ...attached, live_revision: 2, has_unsaved_changes: false },
      execution_history: { status: 'recorded' },
    };
    window.electronAPI.apiRequest.mockResolvedValueOnce(latest);
    await callApi('/analysis/umap', { operation: 'umap', step: 'umap', useCache: false });
    const state = harness.workspace.pipelineState;
    const objects = harness.workspace.currentWs.objects;
    const old = {
      provenance: { id: 'prov_delayed_qc', operation: 'quality-control' },
      result: { completed: true, post_filter_cells: 100 },
      live_state: { ...attached, live_revision: 1, has_unsaved_changes: true },
      execution_history: { status: 'recorded' },
    };
    await act(async () => { finishOldQc(old); await oldRequest; });

    expect(harness.workspace.pipelineState).toEqual(state);
    expect(harness.workspace.pipelineState.umap).toBe(true);
    expect(harness.workspace.currentWs.objects).toEqual(objects);
    expect(harness.workspace.currentProvId).toBe('prov_newer_umap');
    expect(harness.workspace.unsavedLiveChanges).toBe(false);
    expect(saveProvenance).toHaveBeenCalledWith(old);
    expect(await window.electronAPI.getProvenance('prov_delayed_qc')).toEqual(old.provenance);
  });

  it('rechecks the live revision after delayed provenance persistence without losing either attempt', async () => {
    await mountApp();
    const persist = saveProvenance.getMockImplementation();
    let finishOldPersistence;
    saveProvenance.mockImplementationOnce(envelope => {
      persist(envelope);
      return new Promise(resolve => { finishOldPersistence = resolve; });
    });
    window.electronAPI.apiRequest.mockResolvedValueOnce({
      provenance: { id: 'prov_old_cluster', operation: 'cluster' },
      result: { n_clusters: 3, dims_used: 10 },
      live_state: { ...attached, live_revision: 1, has_unsaved_changes: true },
      execution_history: { status: 'recorded' },
    });
    const context = { operation: 'cluster', step: 'cluster', cacheParams: { resolution: 0.5 } };
    let oldRequest;
    await act(async () => { oldRequest = harness.workspace.callApi('/analysis/cluster', {}, context); });
    await waitFor(() => expect(finishOldPersistence).toBeTypeOf('function'));
    window.electronAPI.apiRequest.mockResolvedValueOnce({
      provenance: { id: 'prov_new_cluster', operation: 'cluster' },
      result: { n_clusters: 8, dims_used: 25 },
      live_state: { ...attached, live_revision: 2, has_unsaved_changes: false },
      execution_history: { status: 'recorded' },
    });
    const newest = await callApi('/analysis/cluster', context);
    await act(async () => { finishOldPersistence(); await oldRequest; });

    expect(harness.workspace.pipelineState).toMatchObject({ cluster: true, clusterCount: 8, clusterDims: 25 });
    expect(harness.workspace.currentProvId).toBe('prov_new_cluster');
    expect(harness.workspace.clusterProvId).toBe('prov_new_cluster');
    expect(harness.workspace.unsavedLiveChanges).toBe(false);
    expect(await window.electronAPI.getProvenance('prov_old_cluster')).toMatchObject({ id: 'prov_old_cluster' });
    expect(await window.electronAPI.getProvenance('prov_new_cluster')).toMatchObject({ id: 'prov_new_cluster' });
    expect(await callApi('/analysis/cluster', { ...context, onlyIfCached: true }))
      .toEqual({ provenance: newest.provenance, result: newest.result, _fromCache: true });
  });

  it.each(['analysis_a', 'analysis_b'])('does not project pending history after selecting %s', async objectId => {
    await mountApp();
    const persist = saveProvenance.getMockImplementation();
    let finishPersistence;
    saveProvenance.mockImplementationOnce(envelope => {
      persist(envelope);
      return new Promise(resolve => { finishPersistence = resolve; });
    });
    let pending;
    await act(async () => { pending = harness.workspace.callApi('/analysis/normalize', {}, normalizeContext); });
    await waitFor(() => expect(finishPersistence).toBeTypeOf('function'));
    await act(async () => { harness.workspace.onSelectAnalysisObject('project_a', objectId); });
    const state = harness.workspace.pipelineState;
    const head = harness.workspace.currentProvId;
    await act(async () => { finishPersistence(); await pending; });

    expect(harness.workspace.datasetInfo.id).toBe(objectId);
    expect(harness.workspace.pipelineState).toEqual(state);
    expect(harness.workspace.currentProvId).toBe(head);
    expect(await window.electronAPI.getProvenance('prov_1')).toMatchObject({ id: 'prov_1' });
  });

  it('rejects a cached payload whose provenance no longer matches the known current result', async () => {
    await mountApp();
    await callApi('/analysis/normalize', normalizeContext);
    getCachedResult.mockResolvedValue({ provenanceId: 'prov_overwritten', result: { completed: true } });
    window.electronAPI.getProvenance.mockResolvedValue({ id: 'prov_overwritten', operation: 'normalize' });

    expect(await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true })).toBeNull();
    expect(analysisRequests()).toHaveLength(1);
  });

  it('hydrates the current parameter result and rejects the superseded result', async () => {
    await mountApp();
    const context = { operation: 'cluster', step: 'cluster', parentIds: ['prov_pca'] };
    const a = { ...context, cacheParams: { dims: 15, resolution: 0.5, seed: 42 } };
    const b = { ...context, cacheParams: { dims: 20, resolution: 1, seed: 42 } };
    await callApi('/analysis/cluster?resolution=0.5', a);
    const current = await callApi('/analysis/cluster?resolution=1', b);
    const stateBeforeHydration = harness.workspace.pipelineState;
    const objectsBeforeHydration = harness.workspace.currentWs.objects;
    expect(await callApi('/analysis/cluster?resolution=0.5', { ...a, onlyIfCached: true })).toBeNull();
    const cached = await callApi('/analysis/cluster?resolution=1', { ...b, onlyIfCached: true });

    expect(cached._fromCache).toBe(true);
    expect(cached.result).toEqual(current.result);
    expect(harness.workspace.pipelineState).toEqual(stateBeforeHydration);
    expect(harness.workspace.currentWs.objects).toEqual(objectsBeforeHydration);
    expect(analysisRequests()).toHaveLength(2);
    expect(getCachedResult).toHaveBeenCalledTimes(1);
  });

  it('partitions read-only result reuse by parameters, parent provenance, data version, object, and R session', async () => {
    const mounted = await mountApp();
    const base = { operation: 'summary', cacheParams: { metric: 'counts' }, parentIds: ['prov_a'] };
    const first = await callApi('/analysis/summary', base);
    expect((await callApi('/analysis/summary', base)).result).toEqual(first.result);
    expect(analysisRequests()).toHaveLength(1);
    expect((await callApi('/analysis/summary', { ...base, parentIds: ['prov_b'], onlyIfCached: true }))).toBeNull();
    expect((await callApi('/analysis/summary', { ...base, cacheParams: { metric: 'features' }, onlyIfCached: true }))).toBeNull();

    await act(async () => harness.workspace.updateActiveWorkspace({ dataVersion: 2 }));
    expect(await callApi('/analysis/summary', { ...base, onlyIfCached: true })).toBeNull();
    await act(async () => harness.workspace.onSelectAnalysisObject('project_a', 'analysis_b'));
    await waitFor(() => expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_b:attached'));
    expect(await callApi('/analysis/summary', { ...base, onlyIfCached: true })).toBeNull();

    mounted.unmount();
    localStorage.clear();
    window.electronAPI.apiRequest.mockImplementation(async path => path === '/session-id'
      ? { sessionId: 'r-session-2' } : path === '/pipeline-state' ? attached : {});
    await mountApp();
    expect(await callApi('/analysis/summary', { ...base, onlyIfCached: true })).toBeNull();
    expect(analysisRequests()).toHaveLength(1);
    expect(makeCacheKey.mock.calls.at(-1)[1]._rSession).toBe('r-session-2');
  });

  it('does not use stateful cached provenance to attach a selected durable object', async () => {
    window.electronAPI.apiRequest.mockImplementation(async path => path === '/session-id'
      ? { sessionId: 'r-session-1' } : path === '/pipeline-state' ? { exists: false } : {});
    getCachedResult.mockResolvedValue({ provenanceId: 'prov_normalize', result: { completed: true } });
    window.electronAPI.getProvenance.mockResolvedValue({ id: 'prov_normalize', operation: 'normalize' });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('live-object')).toHaveTextContent('analysis_a:not_attached'));

    expect(await callApi('/analysis/normalize', { ...normalizeContext, onlyIfCached: true })).toBeNull();
    expect(getCachedResult).not.toHaveBeenCalled();
    expect(harness.workspace.datasetInfo.liveState).toBe('not_attached');
    expect(harness.workspace.pipelineState.normalize).toBe(false);
    expect(analysisRequests()).toHaveLength(0);
  });

  it('retains a successful scientific result when cache identity generation is unavailable', async () => {
    await mountApp();
    makeCacheKey.mockRejectedValueOnce(new Error('Cache service unavailable'));
    const data = await callApi('/analysis/normalize', normalizeContext);

    expect(data.result.completed).toBe(true);
    expect(data.error).toBeUndefined();
    expect(analysisRequests()).toHaveLength(1);
    expect(setCachedResult).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Do not rerun it just to repair history.');
  });
});
