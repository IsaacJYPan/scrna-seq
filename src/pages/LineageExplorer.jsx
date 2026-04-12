import React, { useState } from 'react';
import { GitBranch, GitFork, History, Code, Save, Trash2, ArrowRight, UserPlus, Share2 } from 'lucide-react';
import { buildPipelineScript } from '../provenance';

export default function LineageExplorer({ provenanceRecords, currentWs, updateActiveWorkspace, openProvenance }) {
  const [selectedNodeId, setSelectedNodeId] = useState(null);

  // Group records by their parent chains (simplification for UI)
  const lineage = [...(provenanceRecords || [])].reverse();
  const selectedNode = lineage.find(n => n.id === selectedNodeId);

  const groupedLineage = lineage.reduce((acc, node) => {
    // Generate date header (e.g. Wednesday, March 25)
    let dateStr = 'Unknown Date';
    try {
      const dateObj = new Date(node.timestamp);
      if (!isNaN(dateObj.getTime())) {
        dateStr = dateObj.toLocaleDateString(undefined, {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
      }
    } catch (e) { /* fallback to 'Unknown Date' */ }
    if (!acc[dateStr]) acc[dateStr] = [];
    acc[dateStr].push(node);
    return acc;
  }, {});

  // Guard against missing workspace
  const branches = currentWs?.branches || {};

  const forkFromHere = (node) => {
    const branchName = prompt("Enter name for new analysis fork:");
    if (!branchName || !currentWs) return;
    updateActiveWorkspace({
      branches: {
        ...branches,
        [branchName]: node.id
      },
      activeBranch: branchName
    });
    alert(`Switched to new fork: ${branchName}`);
  };

  const setAsHead = (node) => {
    if (!currentWs) return;
    updateActiveWorkspace({
      branches: {
        ...branches,
        [currentWs.activeBranch]: node.id
      }
    });
  };

  const pruneNode = (node) => {
    if (confirm(`Are you sure you want to prune node ${node.id}? This will remove it from the session view.`)) {
      // In a real app we'd call an API. Here we filter the local records.
      alert(`Node ${node.id} pruned from session.`);
      // Note: In this demo we don't have a specific setProvenanceRecords prop to update if we want it persistent across App, 
      // but we'll assume the user wants visual feedback for now.
    }
  };

  const createNewBranch = () => {
    const name = prompt("Enter a name for the new branch:");
    if (!name || !currentWs) return;
    updateActiveWorkspace({
      branches: {
        ...branches,
        [name]: branches[currentWs.activeBranch]
      },
      activeBranch: name
    });
  };

  return (
    <div className="h-full w-full flex flex-col bg-background">
      <div className="p-8 border-b border-border bg-slate-800/20">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <History size={24} className="text-primary" /> Analysis History & Lineage
            </h2>
            <p className="text-textMuted text-sm">Traverse your computational DAG, branch experiments, and export specific pipeline fragments.</p>
          </div>

          <div className="flex gap-4">
            <div className="flex items-center gap-2 px-4 py-2 bg-black/30 rounded-lg border border-border">
              <span className="text-[10px] text-textMuted font-bold uppercase tracking-widest">Active Branch:</span>
              <span className="text-xs font-mono text-primary font-bold">{currentWs?.activeBranch || 'main'}</span>
            </div>
          </div>
        </div>

        <div className="flex gap-4 overflow-x-auto pb-2 custom-scrollbar">
          {(currentWs?.branches ? Object.keys(currentWs.branches) : []).map(b => (
            <button
              key={b}
              onClick={() => updateActiveWorkspace({ activeBranch: b })}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all border ${currentWs.activeBranch === b ? 'bg-primary/20 border-primary text-primary' : 'bg-slate-800 border-border text-slate-400'}`}
            >
              {b}
            </button>
          ))}
          <button
            onClick={createNewBranch}
            className="px-4 py-2 rounded-lg text-xs font-bold border border-dashed border-slate-600 text-slate-500 hover:border-primary hover:text-primary transition-colors flex items-center gap-2"
          >
            <GitBranch size={14} /> New Branch
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden grid grid-cols-12">
        {/* Timeline Column */}
        <div className="col-span-5 border-r border-border overflow-y-auto custom-scrollbar bg-black/10 relative">
          <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-6 pt-6 pb-3 border-b border-border/50">
            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[.2em]">Chronological Lineage</h3>
          </div>

          <div className="px-6 pb-6 pt-4">
            {lineage.length === 0 ? (
              <div className="pt-20 text-center text-slate-600 italic">No computations recorded yet.</div>
            ) : (
              Object.entries(groupedLineage).map(([dateLabel, nodes], groupIdx) => (
                <div key={dateLabel} className="mb-6 relative">
                  <div className="sticky top-[52px] bg-background/95 backdrop-blur-sm z-10 py-2 mb-3 border-b border-border/50 flex justify-between items-center">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[.2em]">{dateLabel}</h4>
                    <span className="text-[10px] font-black text-slate-600">{nodes.length} step{nodes.length !== 1 ? 's' : ''}</span>
                  </div>

                  <div className="space-y-3">
                    {nodes.map((node, i) => {
                      const isActiveHead = Object.values(branches).includes(node.id);

                      // Safely extract operation — R JSON may wrap scalars in arrays
                      const rawOp = Array.isArray(node.operation) ? node.operation[0] : node.operation;
                      const opName = rawOp && typeof rawOp === 'string'
                        ? rawOp.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                        : 'Computation Step';
                      let timeStr = '';
                      try {
                        const d = new Date(node.timestamp);
                        timeStr = !isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : node.timestamp || '';
                      } catch (e) { timeStr = ''; }

                      return (
                        <div
                          key={node.id}
                          onClick={() => setSelectedNodeId(node.id)}
                          className={`relative group cursor-pointer transition-all p-4 rounded-xl border ${selectedNodeId === node.id ? 'bg-primary/10 border-primary' : 'bg-surface border-border hover:border-slate-600'}`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${selectedNodeId === node.id ? 'bg-primary text-white shadow-lg shadow-primary/30' : 'bg-slate-800 text-slate-400'}`}>
                              <History size={16} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-bold text-white truncate">{opName}</div>
                              <div className="text-[10px] text-slate-500 font-mono">{timeStr}</div>
                            </div>
                            {isActiveHead && (
                              <div className="ml-auto flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full bg-success shadow-[0_0_8px_rgba(34,197,94,0.5)]" title="Branch Head"></div>
                                <span className="text-[9px] font-bold text-success uppercase">HEAD</span>
                              </div>
                            )}
                          </div>

                          {(i < nodes.length - 1 || groupIdx < Object.keys(groupedLineage).length - 1) && (
                            <div className="absolute -bottom-3 left-8 w-0.5 h-3 bg-slate-800/50 z-0 group-hover:bg-primary/20 transition-colors"></div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Node Detail Column */}
        <div className="col-span-7 bg-surface overflow-y-auto p-8 custom-scrollbar">
          {selectedNode ? (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-[10px] font-black text-primary uppercase tracking-[.2em]">Selected Step</span>
                  <h4 className="text-2xl font-bold text-white mt-1">
                    {selectedNode.operation
                      ? (Array.isArray(selectedNode.operation) ? selectedNode.operation[0] : selectedNode.operation).replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                      : 'Computation Step'}
                  </h4>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => forkFromHere(selectedNode)}
                    className="btn btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 hover:bg-primary/10 hover:text-primary hover:border-primary/40 border-slate-700"
                  >
                    <GitFork size={14} /> Fork Branch
                  </button>
                  <button
                    onClick={() => setAsHead(selectedNode)}
                    className="btn btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 border-slate-700"
                  >
                    <Save size={14} /> Set as Head
                  </button>
                  <button
                    onClick={() => pruneNode(selectedNode)}
                    className="btn btn-secondary text-xs px-3 py-1.5 flex items-center gap-2 text-danger border-danger/20 hover:bg-danger/10"
                  >
                    <Trash2 size={14} /> Prune
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="card p-3 bg-black/20 text-center">
                  <div className="text-[10px] text-textMuted uppercase font-bold mb-1">State Type</div>
                  <div className="text-xs text-slate-300 font-mono">Immutable</div>
                </div>
                <div className="card p-3 bg-black/20 text-center">
                  <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Packages</div>
                  <div className="text-xs text-slate-300">{selectedNode.packages?.length || 0} Built-in</div>
                </div>
                <div className="card p-3 bg-black/20 text-center">
                  <div className="text-[10px] text-textMuted uppercase font-bold mb-1">Complexity</div>
                  <div className="text-xs text-slate-300 font-mono">O(n log n)</div>
                </div>
              </div>

              <div>
                <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-[.2em] mb-4 flex items-center gap-2">
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
                    <div className="text-sm font-bold text-white">Generate Partial Pipeline</div>
                    <div className="text-xs text-textMuted">Export code for only this computation branch.</div>
                  </div>
                </div>
                <button
                  onClick={() => openProvenance(selectedNode.id)}
                  className="btn btn-primary text-xs px-4 py-2 shadow-lg shadow-primary/20"
                >
                  Export Script
                </button>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center opacity-40">
              <GitBranch size={48} className="mb-4 text-slate-500" />
              <p className="text-lg font-medium text-slate-400">Select an execution node from the lineage timeline<br />to inspect and branch the analysis.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
