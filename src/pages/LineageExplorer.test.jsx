import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LineageExplorer from './LineageExplorer';

vi.mock('@xyflow/react', async () => {
  const ReactModule = await import('react');
  return {
    ReactFlow: ({ children }) => <div data-testid="lineage-canvas">{children}</div>,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom' },
    useNodesState: (initial) => {
      const [nodes, setNodes] = ReactModule.useState(initial);
      const onNodesChange = ReactModule.useCallback(() => {}, []);
      return [nodes, setNodes, onNodesChange];
    },
    useEdgesState: (initial) => {
      const [edges, setEdges] = ReactModule.useState(initial);
      const onEdgesChange = ReactModule.useCallback(() => {}, []);
      return [edges, setEdges, onEdgesChange];
    },
  };
});

const workspace = {
  selectedProjectId: 'proj_1',
  selectedObjectIds: ['ao_root'],
  objects: [{ id: 'ao_root', projectId: 'proj_1', displayName: 'PBMC root' }],
};

describe('LineageExplorer', () => {
  beforeEach(() => {
    window.electronAPI = {
      getProjectAnalysisObjectLineage: vi.fn(async () => ({
        projectId: 'proj_1',
        objectId: 'ao_root',
        rootObjectId: 'ao_root',
        nodes: [
          { id: 'ao_root', label: 'PBMC root', objectType: 'seurat', storageKey: 'projects/private/root.rds' },
          { id: 'ao_child', label: 'Forked PBMC', objectType: 'seurat', stateKey: 'private:state:key' },
        ],
        edges: [{
          id: 'edge_1', parentAnalysisObjectId: 'ao_root', childAnalysisObjectId: 'ao_child',
          edgeType: 'checkpoint_fork', parentRole: 'source', claimToken: 'secret-claim-token',
        }],
      })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('loads the durable project DAG and renders only safe lineage fields', async () => {
    const { container } = render(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} />);

    expect(await screen.findByText('Lineage')).toBeInTheDocument();
    expect(await screen.findByText('PBMC root')).toBeInTheDocument();
    expect(screen.getByText('Children')).toBeInTheDocument();
    expect(screen.getByText('Forked PBMC')).toBeInTheDocument();
    expect(window.electronAPI.getProjectAnalysisObjectLineage).toHaveBeenCalledWith('proj_1', 'ao_root');

    const text = container.textContent || '';
    expect(text).not.toMatch(/projects\/private/i);
    expect(text).not.toMatch(/private:state:key/i);
    expect(text).not.toMatch(/secret-claim-token/i);
    expect(text).toMatch(/read-only/i);
  });

  it('does not request lineage until both a project and analysis object are selected', () => {
    render(<LineageExplorer currentWs={{ ...workspace, selectedProjectId: null }} datasetInfo={null} />);

    expect(screen.getByText(/Select a backend project/i)).toBeInTheDocument();
    expect(window.electronAPI.getProjectAnalysisObjectLineage).not.toHaveBeenCalled();
  });

  it('shows a retryable safe error rather than rendering an upstream error', async () => {
    window.electronAPI.getProjectAnalysisObjectLineage.mockRejectedValueOnce(new Error('vault/private/raw-error'));
    const { container } = render(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} />);

    expect(await screen.findByText(/Lineage unavailable/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/vault\/private/i);
    await waitFor(() => expect(window.electronAPI.getProjectAnalysisObjectLineage).toHaveBeenCalledTimes(1));
  });
});
