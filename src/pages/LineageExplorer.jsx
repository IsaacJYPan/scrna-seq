import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { GitBranch, GitFork, History, Code, Save, Trash2, Share2 } from 'lucide-react';
import { ReactFlow, Controls, Background, MiniMap, useNodesState, useEdgesState, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { forkBranch, setAsHead, mergeBranches } from '../gitOperations';
import { saveProvenance, deleteProvenance } from '../provenance';

const nodeWidth = 250;
const nodeHeight = 80;

const getLayoutedElements = (nodes, edges, direction = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: direction, nodesep: 60, ranksep: 100 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
    };
  });

  return { nodes: newNodes, edges };
};

const CustomNode = ({ data }) => {
  return (
    <div className={`px-4 py-3 rounded-lg border-2 shadow-lg bg-surface flex flex-col w-[250px] cursor-pointer hover:border-slate-400 transition-colors
      ${data.isSelected ? 'border-primary shadow-primary/20 bg-primary/5' : 'border-border'}
      ${data.isHead ? '!border-success shadow-success/20' : ''}
    `}>
      <Handle type="target" position={Position.Top} className="w-2 h-2 !bg-primary" />
      <div className="flex items-center gap-2 mb-1">
        <History size={14} className={data.isSelected ? 'text-primary' : 'text-slate-400'} />
        <span className="text-sm font-bold text-white truncate flex-1">{data.label}</span>
        {data.isHead && (
           <div className="w-2 h-2 rounded-full bg-success shadow-[0_0_8px_rgba(34,197,94,0.5)]" title="Branch Head"></div>
        )}
      </div>
      <div className="text-[10px] text-slate-400 font-mono truncate">{data.timeStr}</div>
      <Handle type="source" position={Position.Bottom} className="w-2 h-2 !bg-primary" />
    </div>
  );
};

const nodeTypes = { custom: CustomNode };

export default function LineageExplorer({ provenanceRecords, setProvenanceRecords, currentWs, updateActiveWorkspace, openProvenance }) {
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [groupSequential, setGroupSequential] = useState(false);


  const lineage = useMemo(() => {
    if (!provenanceRecords || provenanceRecords.length === 0) return [];
    if (!currentWs || !currentWs.branches) return [];

    const headIds = Object.values(currentWs.branches).filter(Boolean);
    if (headIds.length === 0) return [];

    const recordMap = new Map(provenanceRecords.map(r => [r.id, r]));
    const visited = new Set();
    const queue = [...headIds];

    while (queue.length > 0) {
      const id = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);

      const record = recordMap.get(id);
      if (record && record.parentIds) {
        record.parentIds.forEach(parentId => {
          if (parentId && recordMap.has(parentId)) {
            queue.push(parentId);
          }
        });
      }
    }

    return provenanceRecords.filter(r => visited.has(r.id));
  }, [provenanceRecords, currentWs]);

  const selectedNode = lineage.find(n => n.id === selectedNodeId);
  const branches = currentWs?.branches || {};

  useEffect(() => {
    const initialNodes = [];
    const initialEdges = [];

    lineage.forEach((node) => {
      const rawOp = Array.isArray(node.operation) ? node.operation[0] : node.operation;
      const opName = rawOp && typeof rawOp === 'string'
        ? rawOp.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : 'Computation Step';
      
      let timeStr = '';
      try {
        const d = new Date(node.timestamp);
        timeStr = !isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : node.timestamp || '';
      } catch (e) { timeStr = ''; }

      const isHead = Object.values(branches).includes(node.id);
      
      initialNodes.push({
        id: node.id,
        type: 'custom',
        data: { 
           label: opName, 
           timeStr, 
           isHead,
           isSelected: selectedNodeId === node.id
        },
      });

      if (node.parentIds && node.parentIds.length > 0) {
        node.parentIds.forEach((parentId) => {
          initialEdges.push({
            id: `e-${parentId}-${node.id}`,
            source: parentId,
            target: node.id,
            type: 'smoothstep',
            animated: true,
            style: { stroke: '#3b82f6', strokeWidth: 2 },
          });
        });
      }
    });

    let processedNodes = initialNodes;
    
    // Safety check: ensure all edges point to valid nodes before layout
    const initialNodeIds = new Set(initialNodes.map(n => n.id));
    const safeEdges = initialEdges.filter(e => initialNodeIds.has(e.source) && initialNodeIds.has(e.target));
    let processedEdges = safeEdges;

    if (groupSequential) {
      let currentNodes = [...initialNodes];
      let currentEdges = [...safeEdges];
      let changed = true;
      while (changed) {
        changed = false;
        
        const inDeg = {};
        const outDeg = {};
        currentNodes.forEach(n => { inDeg[n.id] = 0; outDeg[n.id] = 0; });
        currentEdges.forEach(e => {
          outDeg[e.source] = (outDeg[e.source] || 0) + 1;
          inDeg[e.target] = (inDeg[e.target] || 0) + 1;
        });

        // Exclude nodes that are the selected node or active branches from being compressed
        // Actually, it's fine if they are compressed, they will just be represented by the last node in the block
        // But to make sure HEAD nodes remain distinct, we can prevent compression if 'u' is a branch head
        const compressibleEdge = currentEdges.find(e => {
          if (outDeg[e.source] !== 1 || inDeg[e.target] !== 1) return false;
          const uNode = currentNodes.find(n => n.id === e.source);
          return !(uNode && uNode.data.isHead);
        });

        if (compressibleEdge) {
           const u = compressibleEdge.source;
           const v = compressibleEdge.target;
           
           const uNode = currentNodes.find(n => n.id === u);
           const vNode = currentNodes.find(n => n.id === v);
           
           if (uNode && vNode) {
             vNode.data.originalLabel = vNode.data.originalLabel || vNode.data.label;
             const uLabel = uNode.data.originalLabel || uNode.data.label;
             vNode.data.label = `${uLabel} + ${vNode.data.originalLabel}`;
             
             // If u was selected, move selection to v
             if (uNode.data.isSelected) {
               vNode.data.isSelected = true;
             }
             
             currentEdges = currentEdges.map(e => {
               if (e.target === u) return { ...e, id: `e-${e.source}-${v}`, target: v };
               return e;
             }).filter(e => e.source !== u);
             
             currentNodes = currentNodes.filter(n => n.id !== u);
             changed = true;
           }
        }
      }
      processedNodes = currentNodes;
      processedEdges = currentEdges;
    }

    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(processedNodes, processedEdges);
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);

  }, [provenanceRecords, branches, selectedNodeId, groupSequential, setNodes, setEdges]);

  const onNodeClick = useCallback((event, node) => {
    setSelectedNodeId(node.id);
  }, []);

  const forkFromHere = (node) => {
    const branchName = prompt("Enter name for new analysis fork:");
    if (!branchName || !currentWs) return;
    try {
      const updatedWs = forkBranch(currentWs, branchName, node.id);
      updateActiveWorkspace(updatedWs);
      alert(`Switched to new fork: ${branchName}`);
    } catch (err) {
      alert(err.message);
    }
  };

  const assignHead = (node) => {
    if (!currentWs) return;
    try {
      const updatedWs = setAsHead(currentWs, node.id);
      updateActiveWorkspace(updatedWs);
    } catch (err) {
      alert(err.message);
    }
  };

  const pruneNodeAction = async (node) => {
    if (!confirm(`Are you sure you want to prune node ${node.id}? This will permanently remove it from the session and database.`)) {
      return;
    }

    try {
      await deleteProvenance(node.id);

      if (setProvenanceRecords) {
        setProvenanceRecords(prev => prev.filter(r => r.id !== node.id));
      }

      if (currentWs?.branches) {
        let wsChanged = false;
        const updatedBranches = { ...currentWs.branches };
        
        Object.keys(updatedBranches).forEach(branchName => {
          if (updatedBranches[branchName] === node.id) {
            const parentId = node.parentIds && node.parentIds.length > 0 ? node.parentIds[0] : null;
            updatedBranches[branchName] = parentId;
            wsChanged = true;
          }
        });

        if (wsChanged) {
          updateActiveWorkspace({
            ...currentWs,
            branches: updatedBranches
          });
        }
      }

      setSelectedNodeId(null);
    } catch (err) {
      alert(`Error pruning node: ${err.message}`);
    }
  };

  const createNewBranch = () => {
    const name = prompt("Enter a name for the new branch:");
    if (!name || !currentWs) return;
    try {
      const updatedWs = forkBranch(currentWs, name, currentWs.branches[currentWs.activeBranch]);
      updateActiveWorkspace(updatedWs);
    } catch (err) {
      alert(err.message);
    }
  };

  const mergeAction = async (node) => {
    if (!currentWs) return;
    const targetBranch = currentWs.activeBranch;
    const targetNodeId = currentWs.branches[targetBranch];
    if (targetNodeId === node.id) {
      alert("Cannot merge a branch into itself.");
      return;
    }

    const sourceBranch = Object.keys(currentWs.branches).find(b => currentWs.branches[b] === node.id);
    if (!sourceBranch) {
      if (!confirm(`This node is not the HEAD of any branch. Merge anyway?`)) return;
    } else {
      if (!confirm(`Merge branch '${sourceBranch}' into '${targetBranch}'?`)) return;
    }

    const parentIds = [];
    if (targetNodeId) parentIds.push(targetNodeId);
    if (node.id && targetNodeId !== node.id) parentIds.push(node.id);

    const mergeNodeId = `prov-${Date.now()}`;
    const mergeEnvelope = {
      provenance: {
        id: mergeNodeId,
        timestamp: new Date().toISOString(),
        operation: 'merge',
        parentIds: parentIds,
        script: `# Merged node ${node.id} into branch ${targetBranch}\n`
      }
    };
    
    try {
      await saveProvenance(mergeEnvelope);
      if (setProvenanceRecords) {
        setProvenanceRecords(prev => [mergeEnvelope.provenance, ...prev]);
      }
      
      let updatedWs;
      if (sourceBranch) {
        updatedWs = mergeBranches(currentWs, targetBranch, sourceBranch, mergeNodeId);
      } else {
        updatedWs = {
          ...currentWs,
          branches: {
            ...currentWs.branches,
            [targetBranch]: mergeNodeId
          }
        };
      }
      updateActiveWorkspace(updatedWs);
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-background">
      <div className="p-8 border-b border-border bg-slate-800/20 shrink-0">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <History size={24} className="text-primary" /> Computational DAG
            </h2>
            <p className="text-textMuted text-sm">Traverse your computational DAG, branch experiments, and export specific pipeline fragments.</p>
          </div>

          <div className="flex gap-4">
            <div className="flex items-center gap-2 px-4 py-2 bg-black/30 rounded-lg border border-border">
              <span className="text-[10px] text-textMuted font-bold uppercase tracking-widest">Active Branch:</span>
              <span className="text-xs font-mono text-blue-400 font-bold">{currentWs?.activeBranch || 'main'}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-4 overflow-x-auto pb-2 custom-scrollbar">
          {(currentWs?.branches ? Object.keys(currentWs.branches) : []).map(b => (
            <button
              key={b}
              onClick={() => updateActiveWorkspace({ activeBranch: b })}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all border ${currentWs.activeBranch === b ? 'bg-blue-400/10 border-blue-400 text-blue-400' : 'bg-slate-800 border-border text-slate-400'}`}
            >
              {b}
            </button>
          ))}
          <button
            onClick={createNewBranch}
            className="px-4 py-2 rounded-lg text-xs font-bold border border-dashed border-slate-600 text-slate-400 hover:border-primary hover:text-primary transition-colors flex items-center gap-2"
          >
            <GitBranch size={14} /> New Branch
          </button>
          <div className="w-px bg-border mx-2"></div>
          <button
            onClick={() => setGroupSequential(prev => !prev)}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all border ${groupSequential ? 'bg-primary/20 border-primary text-primary' : 'bg-slate-800 border-border text-slate-400'}`}
          >
            {groupSequential ? 'Expand DAG' : 'Collapse Sequential Steps'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden grid grid-cols-12 min-h-0">
        {/* DAG Column */}
        <div className="col-span-8 border-r border-border relative bg-slate-900/50 h-full">
          <ReactFlow style={{ width: "100%", height: "100%" }}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#334155" gap={16} />
            <Controls className="bg-surface border border-border fill-slate-400" />
            <MiniMap 
              nodeColor="#3b82f6" 
              maskColor="rgba(15, 23, 42, 0.7)" 
              className="bg-surface border border-border"
            />
          </ReactFlow>
        </div>

        {/* Node Detail Column */}
        <div className="col-span-4 bg-surface overflow-y-auto p-8 custom-scrollbar">
          {selectedNode ? (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="flex flex-col gap-3">
                <div>
                  <span className="text-[10px] font-black text-primary uppercase tracking-[.2em]">Selected Step</span>
                  <h4 className="text-2xl font-bold text-white mt-1">
                    {selectedNode.operation
                      ? (Array.isArray(selectedNode.operation) ? selectedNode.operation[0] : selectedNode.operation).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                      : 'Computation Step'}
                  </h4>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <button
                    onClick={() => forkFromHere(selectedNode)}
                    className="btn btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 hover:bg-primary/10 hover:text-primary hover:border-primary/40 border-slate-700"
                  >
                    <GitFork size={14} /> Fork Branch
                  </button>
                  <button
                    onClick={() => assignHead(selectedNode)}
                    className="btn btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 border-slate-700"
                  >
                    <Save size={14} /> Set as Head
                  </button>
                  <button
                    onClick={() => pruneNodeAction(selectedNode)}
                    className="btn btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 text-danger border-danger/20 hover:bg-danger/10"
                  >
                    <Trash2 size={14} /> Prune
                  </button>
                  <button
                    onClick={() => mergeAction(selectedNode)}
                    className="btn btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 border-slate-700 hover:bg-primary/10 hover:text-primary hover:border-primary/40"
                  >
                    <GitBranch size={14} /> Merge into Current
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="card p-3 bg-black/20 text-center">
                  <div className="text-[10px] text-textMuted uppercase font-bold mb-1">State Type</div>
                  <div className="text-xs text-slate-300 font-mono">Immutable</div>
                </div>
                <div className="card p-3 bg-black/20 text-center">
                  <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Packages</div>
                  <div className="text-xs text-slate-300">{selectedNode.packages?.length || 0} Built-in</div>
                </div>
              </div>

              <div>
                <h5 className="text-[10px] font-black text-slate-400 uppercase tracking-[.2em] mb-4 flex items-center gap-2">
                  <Code size={14} /> Extraction Logic (R)
                </h5>
                <pre className="bg-slate-900 border border-border/50 rounded-xl p-6 overflow-auto text-xs font-mono text-slate-400 leading-relaxed shadow-inner">
                  {selectedNode.script}
                </pre>
              </div>

              <div className="p-6 bg-primary/5 border border-primary/20 rounded-2xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary">
                    <Share2 size={20} />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-white">Partial Pipeline</div>
                    <div className="text-[10px] text-textMuted">Export code for this branch.</div>
                  </div>
                </div>
                <button
                  onClick={() => openProvenance(selectedNode.id)}
                  className="btn btn-primary text-xs px-4 py-2 shadow-lg shadow-primary/20"
                >
                  Export
                </button>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center  p-4">
              <GitBranch size={48} className="mb-4 text-slate-400" />
              <p className="text-lg font-medium text-slate-400">Select a node from the DAG<br />to inspect and branch.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
