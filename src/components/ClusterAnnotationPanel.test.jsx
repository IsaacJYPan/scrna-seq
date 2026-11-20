import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ClusterAnnotationPanel, { CLUSTERS_BUSY_MESSAGE, CLUSTERS_MISSING_MESSAGE, clusterLoadErrorMessage, topGenesByGroup, validateAnnotation } from './ClusterAnnotationPanel';

const clusterValues = { values: [{ value: '1', count: 20 }, { value: '0', count: 30 }, { value: '10', count: 5 }] };

function renderPanel(overrides = {}) {
  const callApi = overrides.callApi || vi.fn(async (path) => {
    if (path.startsWith('/meta-values')) return clusterValues;
    return { mapped_cells: 55, active_identity: 'cell_type', identity_levels: ['T cells', 'B cells'], live_state: { unsaved_changes: true } };
  });
  render(
    <ClusterAnnotationPanel
      callApi={callApi}
      liveObjectAttached
      markers={[{ group: '0', gene: 'CD3E' }, { group: '0', gene: 'IL7R' }, { group: '1', gene: 'MS4A1' }]}
      {...overrides}
    />
  );
  return callApi;
}

describe('ClusterAnnotationPanel', () => {
  it('lists clusters in numeric order with marker hints', async () => {
    renderPanel();
    const inputs = await screen.findAllByLabelText(/^Label for cluster/);
    expect(inputs.map(input => input.getAttribute('aria-label'))).toEqual([
      'Label for cluster 0', 'Label for cluster 1', 'Label for cluster 10',
    ]);
    expect(screen.getByText('CD3E, IL7R')).toBeInTheDocument();
    expect(screen.getByText('MS4A1')).toBeInTheDocument();
  });

  it('requires every cluster to be labeled before applying', async () => {
    renderPanel();
    fireEvent.change(await screen.findByLabelText('Label for cluster 0'), { target: { value: 'T cells' } });
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled();
    expect(screen.getByText(/2 remaining/)).toBeInTheDocument();
  });

  it('sends a complete mapping that sets the active identity and asks to save', async () => {
    const onSave = vi.fn();
    const callApi = renderPanel({ unsavedLiveChanges: true, onSaveCurrentAnalysis: onSave });
    fireEvent.change(await screen.findByLabelText('Label for cluster 0'), { target: { value: ' T cells ' } });
    fireEvent.change(screen.getByLabelText('Label for cluster 1'), { target: { value: 'B cells' } });
    fireEvent.change(screen.getByLabelText('Label for cluster 10'), { target: { value: 'T cells' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 labels' }));

    await waitFor(() => expect(callApi).toHaveBeenCalledWith('/add-meta-mapping', expect.objectContaining({ method: 'POST' }), { useCache: false }));
    const [, options] = callApi.mock.calls.find(([path]) => path === '/add-meta-mapping');
    expect(JSON.parse(options.body)).toEqual({
      source_col: 'seurat_clusters',
      new_col: 'cell_type',
      mapping: { 0: 'T cells', 1: 'B cells', 10: 'T cells' },
      set_identity: true,
    });
    expect(await screen.findByText(/set it as the current identities/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save analysis' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('shows R validation errors without claiming success', async () => {
    const callApi = vi.fn(async (path) => (path.startsWith('/meta-values') ? clusterValues : { error: 'Add a label for every seurat_clusters value before making it the active identity. Missing: 3' }));
    renderPanel({ callApi });
    for (const id of ['0', '1', '10']) {
      fireEvent.change(await screen.findByLabelText(`Label for cluster ${id}`), { target: { value: 'X' } });
    }
    fireEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Add a label for every/);
    expect(screen.queryByText(/set it as the current identities/)).not.toBeInTheDocument();
  });

  it('retries a briefly busy shared R slot when loading clusters', async () => {
    let calls = 0;
    const callApi = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? { error: 'R service is busy. Please retry shortly.' } : clusterValues;
    });
    renderPanel({ callApi });
    expect(await screen.findByLabelText('Label for cluster 0', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(callApi).toHaveBeenCalledTimes(2);
  });

  it('says R is busy, not that clustering is missing, while a large object is still loading', async () => {
    const callApi = vi.fn(async () => { throw new Error('Request timed out'); });
    renderPanel({ callApi });
    expect(await screen.findByRole('alert')).toHaveTextContent(CLUSTERS_BUSY_MESSAGE);
    expect(screen.queryByText(/Run clustering/)).not.toBeInTheDocument();
  });

  it('asks for clustering only when the cluster column is missing', async () => {
    const callApi = vi.fn(async () => ({ error: 'column was not found in object metadata.' }));
    renderPanel({ callApi });
    expect(await screen.findByRole('alert')).toHaveTextContent(CLUSTERS_MISSING_MESSAGE);
  });

  it('does not contact R until the private analysis is open', () => {
    const callApi = vi.fn();
    render(<ClusterAnnotationPanel callApi={callApi} liveObjectAttached={false} />);
    expect(callApi).not.toHaveBeenCalled();
    expect(screen.getByText(/Open this saved version/)).toBeInTheDocument();
  });
});

describe('cluster annotation helpers', () => {
  it('classifies cluster loading failures', () => {
    expect(clusterLoadErrorMessage(new Error('column was not found in object metadata.'))).toBe(CLUSTERS_MISSING_MESSAGE);
    expect(clusterLoadErrorMessage(new Error('No object loaded'))).toBe(CLUSTERS_BUSY_MESSAGE);
    expect(clusterLoadErrorMessage(new Error('R service is busy. Please retry shortly.'))).toBe(CLUSTERS_BUSY_MESSAGE);
    expect(clusterLoadErrorMessage(new Error('Failed to fetch at C:\secret\path'))).toBe(CLUSTERS_BUSY_MESSAGE);
  });

  it('keeps the first marker genes per group', () => {
    const map = topGenesByGroup([
      { group: 0, gene: 'A' }, { group: 0, gene: 'B' }, { group: 0, gene: 'C' }, { group: 0, gene: 'D' }, { group: '1', gene: 'E' },
    ], 3);
    expect(map.get('0')).toEqual(['A', 'B', 'C']);
    expect(map.get('1')).toEqual(['E']);
  });

  it('lists widely detected markers before rare high-fold-change genes', () => {
    const map = topGenesByGroup([
      { group: '1', gene: 'LINC01827', pct1: 0.05 },
      { group: '1', gene: 'IGF1', pct1: 0.12 },
      { group: '1', gene: 'MARCO', pct1: 0.81 },
      { group: '1', gene: 'FABP4', pct1: 0.9 },
    ], 3);
    expect(map.get('1')).toEqual(['MARCO', 'FABP4', 'LINC01827']);
  });

  it('rejects unsafe or computed column names', () => {
    const labels = { 0: 'T' };
    expect(validateAnnotation({ columnName: 'cell type', labels, clusters: ['0'] })).toMatch(/start with a letter/);
    expect(validateAnnotation({ columnName: 'seurat_clusters', labels, clusters: ['0'] })).toMatch(/computed values/);
    expect(validateAnnotation({ columnName: 'cell_type', labels, clusters: ['0'] })).toBeNull();
  });
});
