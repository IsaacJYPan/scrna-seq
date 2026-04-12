import React, { useState } from 'react';
import { Database, FileUp, Zap, CheckCircle, Share2, Users, UserPlus, Info, Globe, Lock, LayoutGrid, List, Edit2 } from 'lucide-react';

export default function Workspace({ 
  callApi, 
  datasetInfo, 
  setDataVersion, 
  openProvenance,
  currentWs,
  updateActiveWorkspace,
  workspaces,
  setWorkspaces,
  activeWsIndex,
  setActiveWsIndex
}) {
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [minCells, setMinCells] = useState(3);
  const [minFeatures, setMinFeatures] = useState(200);

  const loadData = async () => {
    setLoading(true);
    const data = await callApi(`/load-data?min_cells=${minCells}&min_features=${minFeatures}`, {}, {
      operation: 'load',
      step: 'load',
      useCache: false
    });
    
    if (data && data.result) {
      const newObj = {
        id: `obj-${Date.now()}`,
        name: 'PBMC_3k_Tutorial',
        ...data.result,
        timestamp: new Date().toISOString()
      };
      
      updateActiveWorkspace({ 
        objects: [...currentWs.objects, newObj],
        selectedObjectIds: [...(currentWs.selectedObjectIds || []), newObj.id],
      });
      setDataVersion(v => v + 1);
    }
    setLoading(false);
  };

  const selectObject = (id) => {
    const currentSelected = currentWs.selectedObjectIds || [];
    if (currentSelected.includes(id)) {
      updateActiveWorkspace({ selectedObjectIds: currentSelected.filter(oId => oId !== id) });
    } else {
      updateActiveWorkspace({ selectedObjectIds: [...currentSelected, id] });
    }
  };

  const handleRenameObject = (e, objId, currentName) => {
    e.stopPropagation();
    setEditingId(objId);
    setEditName(currentName);
  };

  const saveRename = (e, objId) => {
    e.stopPropagation();
    if (editName.trim() !== '') {
      updateActiveWorkspace({
        objects: currentWs.objects.map(o => o.id === objId ? { ...o, name: editName.trim() } : o)
      });
    }
    setEditingId(null);
  };

  const selectedObjects = currentWs.objects.filter(obj => currentWs.selectedObjectIds?.includes(obj.id));
  const activeCount = selectedObjects.length;
  
  // Create an object mapped to the first selected (or first available) just to render the top details
  const displayObject = selectedObjects[0] || currentWs.objects[0];

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      <div className="px-8 pt-8 pb-4 flex justify-between items-end border-b border-border bg-slate-800/10">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-[.25em] mb-2">
             <Globe size={12} className="text-primary" />
             {currentWs.type === 'personal' ? 'Personal' : 'Shared'} / {currentWs.name}
          </div>
          <h2 className="text-2xl font-black text-text tracking-tighter flex items-center gap-3">
            {currentWs.name}
            {currentWs.type === 'personal' ? <Lock size={16} className="text-slate-600" /> : <Globe size={16} className="text-primary" />}
          </h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-8">
        <div className="max-w-5xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-6">
              
          {/* Top Analytical Target / Load Demo Banner */}
          <div className="card p-8 bg-slate-800/40 relative overflow-hidden group border-2 border-transparent hover:border-primary/20 transition-all">
            <div className="absolute top-[-20%] right-[-10%] w-[30%] h-[60%] bg-primary/10 rounded-full blur-[100px]" />
            <div className="relative z-10 flex flex-col md:flex-row gap-6 md:items-center justify-between">
              <div>
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center text-primary mb-6 shadow-inner">
                  <Zap size={24} />
                </div>
                <h3 className="text-2xl font-black text-white mb-3 tracking-tight">Analytical Environment</h3>
                <p className="text-slate-400 mb-0 leading-relaxed max-w-xl">
                  {selectedObjects.length > 0 ? `Analyzing ${activeCount} dataset${activeCount !== 1 ? 's' : ''}. Transformations are recorded in the immutable lineage.` : 'Load or import datasets below to begin exploring.'}
                </p>
              </div>
              <div>
                <button 
                  onClick={loadData}
                  disabled={loading}
                  className="btn px-8 py-4 font-bold rounded-xl flex items-center gap-3 shadow-xl transition-all active:scale-95 btn-primary shadow-primary/40"
                >
                  {loading ? <div className="w-5 h-5 border-3 border-white border-t-transparent rounded-full animate-spin" /> : <span className="text-xl">+</span>}
                  Load 10x Demo Data
                </button>
              </div>
            </div>
          </div>

          {/* Stats Block */}
          {displayObject && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
              <div className="flex items-center gap-2 mb-4">
                <Info size={16} className="text-primary" />
                <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                   {activeCount > 1 ? `Multi-Select Mode (${activeCount} Active)` : `Data Info: ${displayObject.name}`}
                </h3>
              </div>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { 
                    label: 'Cells (Primary)', 
                    value: displayObject.cells?.toLocaleString() || '0',
                    info: 'Total unique barcodes (cells) identified in the dataset.'
                  },
                  { 
                    label: 'Features (Primary)', 
                    value: displayObject.features?.toLocaleString() || '0',
                    info: 'Number of genes measured per cell (Dataset height).'
                  },
                  { 
                    label: 'Density', 
                    value: (displayObject.density || '0.00') + '%',
                    info: 'Percentage of non-zero entries in the sparse matrix. Typical scRNA-seq range: 1-5%.'
                  },
                  { 
                    label: 'Branch', 
                    value: currentWs.activeBranch.toUpperCase(),
                    info: 'Current analytical provenance branch.'
                  }
                ].map((stat, i) => (
                  <div key={i} className="card p-6 bg-surface/50 border-border/50 hover:border-primary/40 transition-all group relative">
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="relative">
                        <Info size={12} className="text-slate-500 cursor-help" />
                        <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-slate-800 border border-slate-700 rounded-lg text-[10px] text-slate-300 shadow-2xl invisible group-hover:visible z-50 pointer-events-none">
                          {stat.info}
                        </div>
                      </div>
                    </div>
                    <div className="text-2xl font-black text-text mb-1 tracking-tighter">{stat.value}</div>
                    <div className="text-[10px] font-bold text-primary uppercase tracking-widest">{stat.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Global Inventory List */}
          <div className="border-t border-border/50 pt-8">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-text flex items-center gap-3">
                 Objects
                 <span className="text-[10px] bg-slate-800 text-slate-500 px-2 py-0.5 rounded-full">{currentWs.objects.length}</span>
              </h3>
              <button onClick={() => window.electronAPI?.openCsvDialog() || alert('File dialog opened')} disabled={loading} className="btn btn-primary flex items-center gap-2 px-5 text-sm shadow-lg shadow-primary/20">
                 <FileUp size={16} /> Import Object
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {currentWs.objects.length === 0 ? (
                <div className="p-16 text-center border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center">
                   <Database size={40} className="text-slate-600 mb-4 opacity-50" />
                   <h4 className="text-text font-bold mb-2">No Analytical Objects</h4>
                   <p className="text-sm text-textMuted mb-6">Import your own data or load the standard 10x Genomics tutorial dataset to explore.</p>
                   <div className="flex flex-col gap-3 w-full max-w-lg">
                     <div className="flex gap-4">
                       <div className="flex-1 flex items-center justify-between bg-black/5 dark:bg-black/10 rounded-md px-3 py-2 border border-border">
                         <span className="text-xs text-textMuted font-medium">min.cells</span>
                         <input type="number" min="0" value={minCells} onChange={e=>setMinCells(parseInt(e.target.value) || 0)} className="w-16 bg-surface border border-border rounded text-xs text-text p-1 text-center focus:ring-1 focus:ring-primary focus:outline-none" />
                       </div>
                       <div className="flex-1 flex items-center justify-between bg-black/5 dark:bg-black/10 rounded-md px-3 py-2 border border-border">
                         <span className="text-xs text-textMuted font-medium">min.features</span>
                         <input type="number" min="0" value={minFeatures} onChange={e=>setMinFeatures(parseInt(e.target.value) || 0)} className="w-16 bg-surface border border-border rounded text-xs text-text p-1 text-center focus:ring-1 focus:ring-primary focus:outline-none" />
                       </div>
                     </div>
                     <div className="flex justify-center gap-4">
                       <button onClick={loadData} disabled={loading} className="btn btn-primary text-xs flex items-center gap-2 shadow-lg shadow-primary/20">
                         {loading ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span> : <FileUp size={14} />}
                         Load PBMC 3k Tutorial Dataset
                       </button>
                     </div>
                     <div className="flex justify-center gap-4 mt-2 pt-5 border-t border-border/50">
                       <button onClick={() => window.electronAPI?.openCsvDialog()} disabled={loading} className="btn bg-surface border border-border text-text hover:bg-black/5 dark:hover:bg-slate-700 text-xs flex flex-1 items-center justify-center gap-2 transition">
                         <List size={14} /> Import Count Matrix (.csv, .h5ad)
                       </button>
                       <button onClick={() => window.electronAPI?.openCsvDialog()} disabled={loading} className="btn bg-surface border border-border text-text hover:bg-black/5 dark:hover:bg-slate-700 text-xs flex flex-1 items-center justify-center gap-2 transition">
                         <Database size={14} /> Import Seurat Object (.rds)
                       </button>
                     </div>
                   </div>
                </div>
              ) : currentWs.objects.map((obj) => (
                <div 
                  key={obj.id}
                  onClick={() => selectObject(obj.id)}
                  className={`p-5 rounded-xl border transition-all cursor-pointer group relative flex items-center gap-5 ${currentWs.selectedObjectIds?.includes(obj.id) ? 'bg-primary/5 border-primary shadow-lg' : 'bg-surface border-border hover:border-slate-700'}`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${currentWs.selectedObjectIds?.includes(obj.id) ? 'bg-primary text-white scale-110' : 'bg-slate-800 text-slate-500'}`}>
                    <LayoutGrid size={20} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 group/edit h-6">
                      {editingId === obj.id ? (
                        <input 
                          type="text" 
                          autoFocus 
                          className="bg-background text-text px-2 py-0.5 rounded border border-primary text-sm font-bold w-48 focus:outline-none"
                          value={editName} 
                          onChange={e => setEditName(e.target.value)}
                          onBlur={e => saveRename(e, obj.id)}
                          onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <>
                          <div className="text-sm font-bold text-text">{obj.name}</div>
                          <button 
                            onClick={(e) => handleRenameObject(e, obj.id, obj.name)} 
                            className="text-textMuted hover:text-text opacity-0 group-hover/edit:opacity-100 transition-opacity"
                            title="Rename Object"
                          >
                            <Edit2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[10px] text-primary font-bold uppercase">{obj.cells?.toLocaleString()} cells × {obj.features?.toLocaleString()} features</span>
                    </div>
                  </div>
                  <div className="text-right text-[10px] text-slate-500">{new Date(obj.timestamp).toLocaleDateString()}</div>
                  {currentWs.selectedObjectIds?.includes(obj.id) && (
                    <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-primary/20 border border-primary/30 rounded-full text-[9px] font-black text-primary uppercase">
                      <CheckCircle size={10} /> Active
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
