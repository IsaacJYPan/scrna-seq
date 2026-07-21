import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, GitBranch, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  Background, Controls, MiniMap, Position, ReactFlow, Handle,
  useEdgesState, useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';

const NODE_WIDTH = 250;
const NODE_HEIGHT = 92;

function formatObjectLabel(node) {
  if (typeof node?.label === 'string' && node.label.trim()) return node.label.trim();
  if (typeof node?.objectType === 'string' && node.objectType.trim()) return node.objectType.trim();
  return 'Analysis object';
}

function layoutGraph(nodes, edges) {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 86, marginx: 20, marginy: 20 });
  nodes.forEach((node) => graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);

  return {
    nodes: nodes.map((node) => {
      const position = graph.node(node.id);
      return {
        ...node,
        targetPosition: Position.Top,
        sourcePosition: Position.Bottom,
        position: { x: position.x - (NODE_WIDTH / 2), y: position.y - (NODE_HEIGHT / 2) },
      };
    }),
    edges,
  };
}

function LineageNode({ data }) {
  return (
    <div className={`w-[250px] rounded-xl border-2 bg-surface px-4 py-3 shadow-lg transition-colors ${
      data.selected ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/60'
    }`}>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-primary" />
      <div className="flex items-start gap-2">
        <GitBranch size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-text">{data.label}</p>
          <p className="mt-1 truncate font-mono text-[10px] text-textMuted">{data.id}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-textMuted">
        <span>{data.objectType || 'object'}</span>
        {data.isRoot && <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">root</span>}
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-primary" />
    </div>
  );
}

const nodeTypes = { lineage: LineageNode };

function getActiveSelection(currentWs, datasetInfo) {
  const projectId = datasetInfo?.projectId || currentWs?.selectedProjectId || null;
  if (!projectId) return { projectId: null, objectId: null };
  if (datasetInfo?.id && datasetInfo?.projectId === projectId) {
    return { projectId, objectId: datasetInfo.id };
  }
  const selectedIds = Array.isArray(currentWs?.selectedObjectIds) ? currentWs.selectedObjectIds : [];
  const selectedObject = (currentWs?.objects || []).find((object) => (
    object?.projectId === projectId && selectedIds.includes(object.id)
  ));
  return { projectId, objectId: selectedObject?.id || null };
}

function EdgeList({ title, edges, nodeById }) {
  return (
    <section className="rounded-xl border border-border bg-surface/70 p-4">
      <h3 className="text-sm font-bold text-text">{title}</h3>
      {edges.length === 0 ? (
        <p className="mt-2 text-sm text-textMuted">None recorded.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {edges.map((edge) => {
            const relatedId = title === 'Parents' ? edge.parentAnalysisObjectId : edge.childAnalysisObjectId;
            const related = nodeById.get(relatedId);
            return (
              <li key={edge.id} className="rounded-lg border border-border/70 bg-background/60 p-3">
                <p className="truncate text-sm font-semibold text-text">{formatObjectLabel(related)}</p>
                <p className="mt-1 font-mono text-[10px] text-textMuted">{relatedId}</p>
                <p className="mt-2 text-xs text-textMuted">{edge.edgeType || 'derived from'} / {edge.parentRole || 'input'}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Read-only project lineage. Durable edges are created only by reviewed worker
 * handlers, so this UI never offers client-side graph or provenance mutation.
 */
export default function LineageExplorer({ currentWs, datasetInfo, theme }) {
  const { projectId, objectId } = getActiveSelection(currentWs, datasetInfo);
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const requestRef = useRef(0);

  const loadLineage = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!projectId || !objectId) {
      setGraph(null);
      setNodes([]);
      setEdges([]);
      setSelectedNodeId(null);
      setFailed(false);
      return;
    }
    const getLineage = window.electronAPI?.getProjectAnalysisObjectLineage;
    if (typeof getLineage !== 'function') {
      setGraph(null);
      setFailed(true);
      return;
    }
    setLoading(true);
    setFailed(false);
    try {
      const response = await getLineage(projectId, objectId);
      if (requestRef.current !== requestId) return;
      const safeGraph = response && typeof response === 'object' ? response : null;
      setGraph(safeGraph);
      setSelectedNodeId(objectId);
    } catch {
      if (requestRef.current !== requestId) return;
      setGraph(null);
      setSelectedNodeId(null);
      setFailed(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [objectId, projectId, setEdges, setNodes]);

  useEffect(() => {
    loadLineage();
    return () => { requestRef.current += 1; };
  }, [loadLineage]);

  // Keep the empty fallbacks referentially stable. Without this memoization an
  // unavailable/initial graph continuously retriggers the layout effect.
  const graphNodes = useMemo(() => (Array.isArray(graph?.nodes) ? graph.nodes : []), [graph]);
  const graphEdges = useMemo(() => (Array.isArray(graph?.edges) ? graph.edges : []), [graph]);
  const nodeById = useMemo(() => new Map(graphNodes.map((node) => [node.id, node])), [graphNodes]);
  const selectedNode = nodeById.get(selectedNodeId) || null;
  const selectedParents = graphEdges.filter((edge) => edge.childAnalysisObjectId === selectedNodeId);
  const selectedChildren = graphEdges.filter((edge) => edge.parentAnalysisObjectId === selectedNodeId);

  useEffect(() => {
    const rawNodes = graphNodes
      .filter((node) => typeof node?.id === 'string' && node.id)
      .map((node) => ({
        id: node.id,
        type: 'lineage',
        data: {
          id: node.id,
          label: formatObjectLabel(node),
          objectType: typeof node.objectType === 'string' ? node.objectType : 'analysis object',
          isRoot: node.id === graph?.rootObjectId,
          selected: node.id === selectedNodeId,
        },
      }));
    const knownIds = new Set(rawNodes.map((node) => node.id));
    const rawEdges = graphEdges
      .filter((edge) => knownIds.has(edge.parentAnalysisObjectId) && knownIds.has(edge.childAnalysisObjectId))
      .map((edge) => ({
        id: typeof edge.id === 'string' ? edge.id : `${edge.parentAnalysisObjectId}-${edge.childAnalysisObjectId}`,
        source: edge.parentAnalysisObjectId,
        target: edge.childAnalysisObjectId,
        type: 'smoothstep',
        animated: false,
        label: edge.edgeType || undefined,
        labelStyle: { fill: 'currentColor', fontSize: 10 },
        style: { stroke: '#3b82f6', strokeWidth: 2 },
      }));
    const layout = layoutGraph(rawNodes, rawEdges);
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [graph, graphEdges, graphNodes, selectedNodeId, setEdges, setNodes]);

  const onNodeClick = useCallback((_event, node) => setSelectedNodeId(node.id), []);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8">
        <div className="max-w-lg rounded-xl border border-dashed border-border bg-surface p-8 text-center">
          <GitBranch size={38} className="mx-auto text-primary" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold text-text">Select a backend project</h2>
          <p className="mt-2 text-sm text-textMuted">Lineage is durable project metadata and is unavailable until a backend project is selected.</p>
        </div>
      </div>
    );
  }

  if (!objectId) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8">
        <div className="max-w-lg rounded-xl border border-dashed border-border bg-surface p-8 text-center">
          <GitBranch size={38} className="mx-auto text-primary" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold text-text">Select an analysis object</h2>
          <p className="mt-2 text-sm text-textMuted">Choose a project analysis object in Workbench to view its durable lineage graph.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-border bg-surface/60 px-6 py-5">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-black tracking-tight text-text"><GitBranch size={24} className="text-primary" /> Lineage</h2>
          <p className="mt-1 max-w-3xl text-sm text-textMuted">Durable analysis-object lineage for the selected project object. Edges are created by reviewed job handlers; this view is read-only.</p>
          <p className="mt-2 font-mono text-[11px] text-textMuted">Object: {objectId}</p>
        </div>
        <button onClick={loadLineage} disabled={loading} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </header>

      {failed ? (
        <div className="m-6 flex max-w-2xl items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4 text-danger">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" />
          <div><p className="font-bold">Lineage unavailable</p><p className="mt-1 text-sm">The lineage metadata could not be loaded. Check your project access and retry.</p></div>
        </div>
      ) : loading && !graph ? (
        <div className="flex flex-1 items-center justify-center"><Loader2 size={34} className="animate-spin text-primary" aria-label="Loading lineage" /></div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12">
          <section className="relative min-h-[340px] border-b border-border bg-slate-900/40 lg:col-span-8 lg:border-b-0 lg:border-r">
            {graphNodes.length === 0 ? (
              <div className="flex h-full min-h-[340px] items-center justify-center p-8 text-center">
                <div><GitBranch size={38} className="mx-auto text-textMuted" aria-hidden="true" /><p className="mt-3 font-bold text-text">No lineage metadata returned</p><p className="mt-1 text-sm text-textMuted">This object may not have durable lineage records yet.</p></div>
              </div>
            ) : (
              <ReactFlow
                nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick} nodeTypes={nodeTypes} fitView proOptions={{ hideAttribution: true }}
              >
                <Background color={theme === 'dark' ? '#334155' : '#d8e0ea'} gap={16} />
                <Controls className="border border-border bg-surface fill-slate-400" />
                <MiniMap nodeColor="#3b82f6" maskColor="rgba(15, 23, 42, 0.7)" className="border border-border bg-surface" />
              </ReactFlow>
            )}
          </section>
          <aside className="min-h-0 overflow-y-auto bg-surface p-6 custom-scrollbar lg:col-span-4">
            {selectedNode ? (
              <div className="space-y-5">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Selected object</p>
                  <h3 className="mt-1 text-xl font-bold text-text">{formatObjectLabel(selectedNode)}</h3>
                  <p className="mt-2 break-all font-mono text-xs text-textMuted">{selectedNode.id}</p>
                  <p className="mt-2 text-sm text-textMuted">Type: {selectedNode.objectType || 'analysis object'}</p>
                </div>
                <EdgeList title="Parents" edges={selectedParents} nodeById={nodeById} />
                <EdgeList title="Children" edges={selectedChildren} nodeById={nodeById} />
              </div>
            ) : (
              <div className="flex h-full min-h-64 flex-col items-center justify-center text-center"><GitBranch size={38} className="text-textMuted" aria-hidden="true" /><p className="mt-3 text-sm text-textMuted">Select an object to inspect its recorded relationships.</p></div>
            )}
            <div className="mt-6 flex gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-textMuted"><ShieldCheck size={16} className="shrink-0 text-primary" />Project lineage visibility does not grant access to another member&apos;s private live R state.</div>
          </aside>
        </div>
      )}
    </div>
  );
}
