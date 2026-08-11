import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Clock3, GitBranch, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  Background, Controls, MiniMap, Position, ReactFlow, Handle,
  useEdgesState, useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';

const NODE_WIDTH = 250;
const NODE_HEIGHT = 92;

function formatObjectLabel(node) {
  const label = typeof node?.label === 'string' ? node.label.trim() : '';
  if (label && label !== node?.id && !/^(?:ao|job|artifact|object)[_-]/i.test(label)) return label;
  return 'Saved analysis';
}

const RELATIONSHIP_COPY = {
  checkpoint_fork: {
    label: 'Branch from saved version',
    description: 'Created from a saved version. The source analysis remains unchanged.',
  },
  checkpoint: {
    label: 'Saved version',
    description: 'Recorded from a saved version in this analysis history.',
  },
  derived_from: {
    label: 'Derived result',
    description: 'Created by a reviewed analysis step using this object as input.',
  },
  branch: {
    label: 'Analysis branch',
    description: 'Started a separate analysis branch from this saved analysis.',
  },
  integration_input: {
    label: 'Integration input',
    description: 'Used as an input to an integration result.',
  },
  comparison_input: {
    label: 'Comparison input',
    description: 'Used as an input to a recorded comparison.',
  },
  manual_link: {
    label: 'Recorded relationship',
    description: 'A reviewed workflow recorded this relationship.',
  },
};

function describeRelationship(edge) {
  const type = typeof edge?.edgeType === 'string' ? edge.edgeType : '';
  return RELATIONSHIP_COPY[type] || {
    label: 'Recorded relationship',
    description: 'A reviewed workflow recorded this relationship.',
  };
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
    <div
      role="button"
      tabIndex={0}
      onClick={() => data.onSelect?.(data.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          data.onSelect?.(data.id);
        }
      }}
      aria-label={`Inspect ${data.label}`}
      title={`Inspect ${data.label}`}
      className={`w-[250px] rounded-xl border-2 bg-surface px-4 py-3 text-left shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        data.selected ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/60'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-primary" />
      <div className="flex items-start gap-2">
        <GitBranch size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-text">{data.label}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-textMuted">
        <span>Saved analysis</span>
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

function EdgeList({ title, edges, nodeById, onSelect }) {
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
            const relationship = describeRelationship(edge);
            const isVisible = Boolean(related);
            return (
              <li key={edge.id}>
                {isVisible ? (
                  <button
                    type="button"
                    onClick={() => onSelect?.(relatedId)}
                    className="w-full rounded-lg border border-border/70 bg-background/60 p-3 text-left transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <p className="truncate text-sm font-semibold text-text">{formatObjectLabel(related)}</p>
                    <p className="mt-2 text-xs font-semibold text-primary">{relationship.label}</p>
                    <p className="mt-1 text-xs leading-relaxed text-textMuted">{relationship.description}</p>
                  </button>
                ) : (
                  <div className="rounded-lg border border-border/70 bg-background/60 p-3 text-left">
                    <p className="text-sm font-semibold text-text">Related object not shown</p>
                    <p className="mt-1 text-xs leading-relaxed text-textMuted">This relationship is recorded, but its other object is outside this bounded lineage view.</p>
                    <p className="mt-2 text-xs font-semibold text-primary">{relationship.label}</p>
                  </div>
                )}
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
  const [isFreshForSelection, setIsFreshForSelection] = useState(false);
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
      setIsFreshForSelection(false);
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
    setIsFreshForSelection(false);
    try {
      const response = await getLineage(projectId, objectId);
      if (requestRef.current !== requestId) return;
      const safeGraph = response && typeof response === 'object' ? response : null;
      setGraph(safeGraph);
      setSelectedNodeId(objectId);
      setIsFreshForSelection(true);
    } catch {
      if (requestRef.current !== requestId) return;
      setGraph(null);
      setSelectedNodeId(null);
      setIsFreshForSelection(false);
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
          objectType: typeof node.objectType === 'string' ? node.objectType : 'saved analysis',
          isRoot: node.id === graph?.rootObjectId,
          selected: node.id === selectedNodeId,
          onSelect: setSelectedNodeId,
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
        label: describeRelationship(edge).label,
        labelStyle: { fill: theme === 'dark' ? '#e2e8f0' : '#0f172a', fontSize: 10, fontWeight: 700 },
        labelBgStyle: { fill: theme === 'dark' ? '#0f172a' : '#f8fafc', fillOpacity: 0.88 },
        style: { stroke: '#3b82f6', strokeWidth: 2 },
      }));
    const layout = layoutGraph(rawNodes, rawEdges);
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [graph, graphEdges, graphNodes, selectedNodeId, setEdges, setNodes, theme]);

  const onNodeClick = useCallback((_event, node) => setSelectedNodeId(node.id), []);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8">
        <div className="max-w-lg rounded-xl border border-dashed border-border bg-surface p-8 text-center">
          <GitBranch size={38} className="mx-auto text-primary" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold text-text">Select a project</h2>
          <p className="mt-2 text-sm text-textMuted">Analysis lineage is available after you select a project.</p>
        </div>
      </div>
    );
  }

  if (!objectId) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8">
        <div className="max-w-lg rounded-xl border border-dashed border-border bg-surface p-8 text-center">
          <GitBranch size={38} className="mx-auto text-primary" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold text-text">Select a saved analysis</h2>
          <p className="mt-2 text-sm text-textMuted">Choose a saved analysis in the Analysis workspace to view its recorded relationships.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-border bg-surface/60 px-6 py-5">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-black tracking-tight text-text"><GitBranch size={24} className="text-primary" /> Lineage</h2>
          <p className="mt-1 max-w-3xl text-sm text-textMuted">Recorded relationships for the selected saved analysis. This view is read-only.</p>
          <p className="mt-2 flex items-center gap-1.5 text-xs text-textMuted" aria-live="polite">
            <Clock3 size={13} aria-hidden="true" />
            {isFreshForSelection ? 'Current view loaded. Refresh to check for collaborator changes.' : 'Refresh to check for collaborator changes.'}
          </p>
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
        <div className="flex min-h-0 flex-1 flex-col">
          {graph?.truncated && (
            <div className="mx-6 mt-5 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-900 dark:text-amber-100" role="status">
              <AlertTriangle size={20} className="mt-0.5 shrink-0" />
              <div><p className="font-bold">Lineage view is bounded</p><p className="mt-1 text-sm">This graph reached its safe display limit. It may not include every recorded relationship.</p></div>
            </div>
          )}
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12">
          <section className="relative min-h-[340px] border-b border-border bg-slate-100 dark:bg-slate-950/40 lg:col-span-8 lg:border-b-0 lg:border-r">
            {graphNodes.length === 0 ? (
              <div className="flex h-full min-h-[340px] items-center justify-center p-8 text-center">
                <div><GitBranch size={38} className="mx-auto text-textMuted" aria-hidden="true" /><p className="mt-3 font-bold text-text">This is a root analysis</p><p className="mt-1 text-sm text-textMuted">No parent or child relationships have been recorded yet.</p></div>
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
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Selected analysis</p>
                    {graph?.rootObjectId && nodeById.has(graph.rootObjectId) && selectedNodeId !== graph.rootObjectId && (
                      <button type="button" onClick={() => setSelectedNodeId(graph.rootObjectId)} className="text-xs font-bold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Jump to root</button>
                    )}
                  </div>
                  <h3 className="mt-1 text-xl font-bold text-text">{formatObjectLabel(selectedNode)}</h3>
                  <p className="mt-3 text-xs leading-relaxed text-textMuted">Choose a node on the graph or a relationship below to inspect its recorded provenance.</p>
                </div>
                <EdgeList title="Parents" edges={selectedParents} nodeById={nodeById} onSelect={setSelectedNodeId} />
                <EdgeList title="Children" edges={selectedChildren} nodeById={nodeById} onSelect={setSelectedNodeId} />
              </div>
            ) : (
              <div className="flex h-full min-h-64 flex-col items-center justify-center text-center"><GitBranch size={38} className="text-textMuted" aria-hidden="true" /><p className="mt-3 text-sm text-textMuted">Select a saved analysis to inspect its recorded relationships.</p></div>
            )}
            <div className="mt-6 flex gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-textMuted"><ShieldCheck size={16} className="shrink-0 text-primary" />Lineage visibility does not grant access to another researcher&apos;s private analysis workspace.</div>
          </aside>
        </div>
        </div>
      )}
    </div>
  );
}
