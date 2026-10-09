import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LineageExplorer from './LineageExplorer';

const flowHarness = vi.hoisted(() => ({ instance: { fitView: vi.fn() }, props: null }));

vi.mock('@xyflow/react', async () => {
  const ReactModule = await import('react');
  return {
    ReactFlow: (props) => {
      flowHarness.props = props;
      ReactModule.useEffect(() => { props.onInit?.(flowHarness.instance); }, [props.onInit]);
      return <div data-testid="lineage-canvas"><button onClick={() => props.onMoveStart?.({ type: 'pointerdown' })}>Pan graph</button>{props.children}</div>;
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => <div data-testid="lineage-minimap" />,
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
    flowHarness.instance.fitView.mockClear();
    window.electronAPI = {
      getProjectAnalysisObjectLineage: vi.fn(async () => ({
        projectId: 'proj_1',
        objectId: 'ao_root',
        rootObjectId: 'ao_root',
        truncated: true,
        nodes: [
          { id: 'ao_root', label: 'PBMC root', objectType: 'seurat', storageKey: 'projects/private/root.rds' },
          { id: 'ao_child', label: 'Forked PBMC', objectType: 'seurat', stateKey: 'private:state:key' },
        ],
        edges: [{
          id: 'edge_1', parentAnalysisObjectId: 'ao_root', childAnalysisObjectId: 'ao_child',
          edgeType: 'checkpoint_fork', parentRole: 'source', claimToken: 'secret-claim-token',
        }],
      })),
      listAnalysisBranches: vi.fn(async () => []),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads recorded lineage and renders only safe researcher-facing fields', async () => {
    const { container } = render(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} />);

    expect(await screen.findByText('Lineage')).toBeInTheDocument();
    expect(await screen.findByText('PBMC root')).toBeInTheDocument();
    expect(screen.getByText('Children')).toBeInTheDocument();
    expect(screen.getByText('Forked PBMC')).toBeInTheDocument();
    expect(screen.getByText('Branch from saved version')).toBeInTheDocument();
    expect(screen.getByText(/Created from a saved version/i)).toBeInTheDocument();
    expect(screen.getByText(/Lineage view is bounded/i)).toBeInTheDocument();
    expect(window.electronAPI.getProjectAnalysisObjectLineage).toHaveBeenCalledWith('proj_1', 'ao_root');

    const text = container.textContent || '';
    expect(text).not.toMatch(/projects\/private/i);
    expect(text).not.toMatch(/private:state:key/i);
    expect(text).not.toMatch(/secret-claim-token/i);
    expect(text).not.toMatch(/ao_root|ao_child|seurat/i);
    expect(text).toMatch(/read-only/i);
  });

  it('lets a researcher inspect a related object from a keyboard-accessible relationship card', async () => {
    render(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} />);

    const relatedObject = await screen.findByRole('button', { name: /Forked PBMC.*Branch from saved version/i });
    expect(relatedObject.tagName).toBe('BUTTON');
    fireEvent.click(relatedObject);

    expect(await screen.findByText('Parents')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Forked PBMC' })).toBeInTheDocument();
    expect(screen.queryByText('ao_child')).not.toBeInTheDocument();
  });

  it('shows branches based on the selected saved version even before they create a child object', async () => {
    window.electronAPI.getProjectAnalysisObjectLineage.mockResolvedValueOnce({
      projectId: 'proj_1', objectId: 'ao_root', rootObjectId: 'ao_root',
      truncated: false, nodes: [{ id: 'ao_root', label: 'PBMC root' }], edges: [],
    });
    window.electronAPI.listAnalysisBranches.mockResolvedValueOnce([{
      id: 'br_private', name: 'alternate QC strategy', visibility: 'private', version: 1,
      baseAnalysisObjectId: 'ao_root', headAnalysisObjectId: 'ao_root',
    }]);

    render(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} />);

    expect(await screen.findByText('alternate QC strategy')).toBeInTheDocument();
    expect(screen.getByText(/Private draft.*saved version 1/i)).toBeInTheDocument();
  });

  it('explains an omitted related object without offering a broken selection', async () => {
    window.electronAPI.getProjectAnalysisObjectLineage.mockResolvedValueOnce({
      projectId: 'proj_1',
      objectId: 'ao_root',
      rootObjectId: 'ao_not_shown',
      truncated: true,
      nodes: [{ id: 'ao_root', label: 'PBMC root', objectType: 'seurat' }],
      edges: [{
        id: 'edge_outside_view', parentAnalysisObjectId: 'ao_root', childAnalysisObjectId: 'ao_not_shown',
        edgeType: 'checkpoint_fork', parentRole: 'source',
      }],
    });

    render(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} />);

    expect(await screen.findByText('Related object not shown')).toBeInTheDocument();
    expect(screen.getByText(/outside this bounded lineage view/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Jump to root/i })).not.toBeInTheDocument();
  });

  it('does not request lineage until both a project and analysis object are selected', () => {
    render(<LineageExplorer currentWs={{ ...workspace, selectedProjectId: null }} datasetInfo={null} />);

    expect(screen.getByRole('heading', { name: /Select a project/i })).toBeInTheDocument();
    expect(window.electronAPI.getProjectAnalysisObjectLineage).not.toHaveBeenCalled();
  });

  it('shows a retryable safe error rather than rendering an upstream error', async () => {
    window.electronAPI.getProjectAnalysisObjectLineage.mockRejectedValueOnce(new Error('vault/private/raw-error'));
    const { container } = render(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} />);

    expect(await screen.findByText(/Lineage unavailable/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/vault\/private/i);
    await waitFor(() => expect(window.electronAPI.getProjectAnalysisObjectLineage).toHaveBeenCalledTimes(1));
  });
  it('fits meaningful canvas resizes, hides an obstructive minimap and preserves manual navigation', async () => {
    let notifyResize;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    });
    const view = render(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} theme="light" />);
    await screen.findByRole('button', { name: 'Fit graph to view' });
    await waitFor(() => expect(flowHarness.instance.fitView).toHaveBeenCalled());
    act(() => notifyResize([{ contentRect: { width: 900, height: 600 } }]));
    await screen.findByTestId('lineage-minimap');
    flowHarness.instance.fitView.mockClear();
    act(() => notifyResize([{ contentRect: { width: 390, height: 440 } }]));
    await waitFor(() => expect(flowHarness.instance.fitView).toHaveBeenCalledWith({ padding: 0.18, maxZoom: 1, duration: 0 }));
    expect(screen.queryByTestId('lineage-minimap')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pan graph' }));
    flowHarness.instance.fitView.mockClear();
    act(() => notifyResize([{ contentRect: { width: 420, height: 440 } }]));
    view.rerender(<LineageExplorer currentWs={workspace} datasetInfo={{ id: 'ao_root', projectId: 'proj_1' }} theme="dark" />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(flowHarness.instance.fitView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fit graph to view' }));
    expect(flowHarness.instance.fitView).toHaveBeenCalledOnce();
    expect(flowHarness.props.nodesDraggable).toBe(false);
    expect(flowHarness.props.nodesConnectable).toBe(false);
    expect(flowHarness.props.edgesReconnectable).toBe(false);
  });

});
