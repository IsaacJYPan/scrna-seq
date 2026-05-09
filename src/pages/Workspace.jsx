import React, { useState } from 'react';
import {
  Database, FileUp, Zap, CheckCircle, Info, Globe, Lock,
  LayoutGrid, List, Edit2, FolderOpen, HardDrive, FlaskConical,
  X, SlidersHorizontal, ChevronDown, ChevronUp, Search, Scissors, Trash2
} from 'lucide-react';
import ObjectInspector from '../components/ObjectInspector';

const API = 'http://localhost:8000';

// ── Load Dataset Modal ─────────────────────────────────────────────

function LoadModal({ onClose, onLoaded, loadingId, setLoadingId }) {
  const [showFilters, setShowFilters] = useState(false);
  const [minCells, setMinCells] = useState(3);
  const [minFeatures, setMinFeatures] = useState(200);

  const loadDemo = async () => {
    setLoadingId('demo');
    const res = await fetch(`${API}/load-data?min_cells=${minCells}&min_features=${minFeatures}`);
    const data = await res.json();
    if (data.result) onLoaded(data, 'PBMC_3k_Tutorial');
    setLoadingId(null);
  };

  const load10X = async () => {
    const path = await window.electronAPI?.openDirectoryDialog();
    if (!path) return;
    setLoadingId('10x');
    const params = new URLSearchParams({ path, min_cells: minCells, min_features: minFeatures });
    const res = await fetch(`${API}/load-local-10x?${params}`);
    const data = await res.json();
    if (data.result) onLoaded(data, path.split(/[/\\]/).pop());
    else if (data.error) alert(`Load failed: ${data.error}`);
    setLoadingId(null);
  };

  const loadRds = async () => {
    const path = await window.electronAPI?.openDataFileDialog('rds');
    if (!path) return;
    setLoadingId('rds');
    const res = await fetch(`${API}/load-rds?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.result) onLoaded(data, path.split(/[/\\]/).pop().replace(/\.rds$/i, ''));
    else if (data.error) alert(`Load failed: ${data.error}`);
    setLoadingId(null);
  };

  const loadH5 = async () => {
    const path = await window.electronAPI?.openDataFileDialog('h5');
    if (!path) return;
    setLoadingId('h5');
    const res = await fetch(`${API}/load-h5ad?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.result) onLoaded(data, path.split(/[/\\]/).pop().replace(/\.(h5ad?|h5seurat)$/i, ''));
    else if (data.error) alert(`Load failed: ${data.error}`);
    setLoadingId(null);
  };

  const isLoading = !!loadingId;

  const options = [
    {
      id: 'demo',
      icon: <FlaskConical size={22} className="text-primary" />,
      title: 'PBMC 3k Demo Dataset',
      desc: '2,700 peripheral blood mononuclear cells from 10X Genomics. Great for exploring the pipeline.',
      tag: 'Built-in',
      tagColor: 'text-primary bg-primary/10 border-primary/20',
      action: loadDemo,
    },
    {
      id: '10x',
      icon: <FolderOpen size={22} className="text-emerald-400" />,
      title: 'Local 10X Directory',
      desc: 'Select a folder containing barcodes.tsv, features.tsv (or genes.tsv), and matrix.mtx.',
      tag: '10X Format',
      tagColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
      action: load10X,
    },
    {
      id: 'rds',
      icon: <HardDrive size={22} className="text-violet-400" />,
      title: 'Seurat RDS Object',
      desc: 'Load a pre-existing Seurat object saved as .rds. Existing reductions and metadata will be detected.',
      tag: '.rds',
      tagColor: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
      action: loadRds,
    },
    {
      id: 'h5',
      icon: <Database size={22} className="text-amber-400" />,
      title: 'H5AD / H5Seurat',
      desc: 'AnnData or H5Seurat format. Requires the SeuratDisk R package to be installed.',
      tag: '.h5ad',
      tagColor: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
      action: loadH5,
    },
  ];

  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-xl pointer-events-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-7 pt-7 pb-5 border-b border-slate-800">
            <div>
              <h3 className="text-lg font-black text-white tracking-tight">Load Dataset</h3>
              <p className="text-xs text-slate-500 mt-0.5">Choose a source to import into your workspace.</p>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-white transition">
              <X size={16} />
            </button>
          </div>

          {/* Filter params (collapsible) */}
          <div className="px-7 pt-4">
            <button
              onClick={() => setShowFilters(v => !v)}
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500 hover:text-white transition"
            >
              <SlidersHorizontal size={11} />
              Filter Parameters
              {showFilters ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
            {showFilters && (
              <div className="flex gap-4 mt-3 mb-1">
                <div className="flex-1 flex items-center justify-between bg-slate-800 rounded-lg px-3 py-2 border border-slate-700">
                  <span className="text-xs text-slate-400 font-medium">min.cells</span>
                  <input
                    type="number" min="0" value={minCells}
                    onChange={e => setMinCells(parseInt(e.target.value) || 0)}
                    className="w-16 bg-transparent text-xs text-white text-right focus:outline-none"
                  />
                </div>
                <div className="flex-1 flex items-center justify-between bg-slate-800 rounded-lg px-3 py-2 border border-slate-700">
                  <span className="text-xs text-slate-400 font-medium">min.features</span>
                  <input
                    type="number" min="0" value={minFeatures}
                    onChange={e => setMinFeatures(parseInt(e.target.value) || 0)}
                    className="w-16 bg-transparent text-xs text-white text-right focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Option cards */}
          <div className="p-7 pt-4 space-y-3">
            {options.map(opt => {
              const active = loadingId === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={opt.action}
                  disabled={isLoading}
                  className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-all group ${
                    active
                      ? 'bg-primary/10 border-primary'
                      : 'bg-slate-800/60 border-slate-700/50 hover:border-slate-600 hover:bg-slate-800'
                  } disabled:opacity-50`}
                >
                  <div className="w-10 h-10 rounded-lg bg-slate-700/60 flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform">
                    {active
                      ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      : opt.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-bold text-white text-sm">{opt.title}</span>
                      <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide ${opt.tagColor}`}>
                        {opt.tag}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-snug">{opt.desc}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main Workspace ─────────────────────────────────────────────────

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
  setActiveWsIndex,
  resetPipelineAfterSubset,
  userEmail,
}) {
  // Derive the RDS save path for the currently active object.
  // Mirrors the getSessionPath logic in App.jsx so they stay in sync.
  const sanitizeEmail = (email) => email?.replace(/[^a-zA-Z0-9]/g, '_') ?? '';
  const selectedObjects = currentWs.objects.filter(obj => currentWs.selectedObjectIds?.includes(obj.id));
  const activeObj = selectedObjects[0] || currentWs.objects[0] || null;
  const parentSessionPath = userEmail && activeObj?.id
    ? `sessions/${sanitizeEmail(userEmail)}/${activeObj.id}.rds`
    : null;
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadingId, setLoadingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [inspectingObj, setInspectingObj] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Called when any load option completes successfully
  const handleLoaded = (data, suggestedName) => {
    const newObj = {
      id: `obj-${Date.now()}`,
      name: suggestedName || 'Dataset',
      ...data.result,
      timestamp: new Date().toISOString(),
    };
    updateActiveWorkspace({
      objects: [...currentWs.objects, newObj],
      selectedObjectIds: [...(currentWs.selectedObjectIds || []), newObj.id],
    });
    setDataVersion(v => v + 1);
    setShowLoadModal(false);
  };

  const selectObject = (id) => {
    // Single-select: clicking an object makes it the one and only active object.
    // Matches the pipeline model — global_obj in R is always one object.
    updateActiveWorkspace({ selectedObjectIds: [id] });
  };

  const handleRenameObject = (e, objId, currentName) => {
    e.stopPropagation();
    setEditingId(objId);
    setEditName(currentName);
  };

  const saveRename = (e, objId) => {
    e.stopPropagation();
    if (editName.trim()) {
      updateActiveWorkspace({
        objects: currentWs.objects.map(o => o.id === objId ? { ...o, name: editName.trim() } : o),
      });
    }
    setEditingId(null);
  };

  const handleDeleteObject = (e, objId) => {
    e.stopPropagation();
    if (confirmDeleteId !== objId) {
      // First click: ask for confirmation
      setConfirmDeleteId(objId);
      return;
    }
    // Second click (confirmed): delete
    setConfirmDeleteId(null);
    const remainingObjects = currentWs.objects.filter(o => o.id !== objId);
    const wasSelected = currentWs.selectedObjectIds?.includes(objId);
    const newSelected = wasSelected
      ? remainingObjects.length > 0 ? [remainingObjects[0].id] : []
      : (currentWs.selectedObjectIds || []).filter(id => id !== objId);
    updateActiveWorkspace({
      objects: remainingObjects,
      selectedObjectIds: newSelected,
    });
    // Clean up all per-object localStorage entries for this object
    const sanitizedEmail = (userEmail || '').replace(/[^a-zA-Z0-9]/g, '_');
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.includes(`_${objId}`) || k.endsWith(`_${objId}`))) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  };

  // Called when the user creates a subset from the inspector
  const handleSubsetCreated = (data, newName) => {
    const newObj = {
      id: `obj-${Date.now()}`,
      name: newName || 'Subset',
      ...data.result,
      timestamp: new Date().toISOString(),
      isSubset: true,
      parentObjId: activeObj?.id ?? null,  // link back to the parent for future restore
    };
    updateActiveWorkspace({
      objects: [...currentWs.objects, newObj],
      selectedObjectIds: [newObj.id],   // auto-select the subset
    });
    setDataVersion(v => v + 1);
    resetPipelineAfterSubset?.();
    setInspectingObj(null);
  };

  const activeCount = selectedObjects.length;
  const displayObject = selectedObjects[0] || currentWs.objects[0];

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-8 pt-8 pb-4 flex justify-between items-end border-b border-border bg-slate-800/10">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-black text-slate-500 uppercase tracking-[.25em] mb-2">
            <Globe size={12} className="text-primary" />
            {currentWs.type === 'personal' ? 'Personal' : 'Shared'} / {currentWs.name}
          </div>
          <h2 className="text-2xl font-black text-text tracking-tighter flex items-center gap-3">
            {currentWs.name}
            {currentWs.type === 'personal'
              ? <Lock size={16} className="text-slate-600" />
              : <Globe size={16} className="text-primary" />}
          </h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-8">
        <div className="max-w-5xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-6">

          {/* Analytical Environment Banner */}
          <div className="card p-8 bg-slate-800/40 relative overflow-hidden group border-2 border-transparent hover:border-primary/20 transition-all">
            <div className="absolute top-[-20%] right-[-10%] w-[30%] h-[60%] bg-primary/10 rounded-full blur-[100px]" />
            <div className="relative z-10 flex flex-col md:flex-row gap-6 md:items-center justify-between">
              <div>
                <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center text-primary mb-6 shadow-inner">
                  <Zap size={24} />
                </div>
                <h3 className="text-2xl font-black text-white mb-3 tracking-tight">Analytical Environment</h3>
                <p className="text-slate-400 mb-0 leading-relaxed max-w-xl">
                  {selectedObjects.length > 0
                    ? `Analyzing ${activeCount} dataset${activeCount !== 1 ? 's' : ''}. Transformations are recorded in the immutable lineage.`
                    : 'Load or import datasets below to begin exploring.'}
                </p>
              </div>
              <button
                onClick={() => setShowLoadModal(true)}
                disabled={!!loadingId}
                className="btn px-8 py-4 font-bold rounded-xl flex items-center gap-3 shadow-xl transition-all active:scale-95 btn-primary shadow-primary/40 whitespace-nowrap"
              >
                <span className="text-xl">+</span> Load Dataset
              </button>
            </div>
          </div>

          {/* Stats Block */}
          {displayObject && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
              <div className="flex items-center gap-2 mb-4">
                <Info size={16} className="text-primary" />
                <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  {activeCount > 1
                    ? `Multi-Select Mode (${activeCount} Active)`
                    : `Data Info: ${displayObject.name}`}
                </h3>
              </div>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: 'Cells (Primary)',    value: displayObject.cells?.toLocaleString() || '0',        info: 'Total unique barcodes after filtering.' },
                  { label: 'Features (Primary)', value: displayObject.features?.toLocaleString() || '0',     info: 'Number of genes measured per cell.' },
                  { label: 'Density',            value: (displayObject.density || '0.00') + '%',              info: 'Percentage of non-zero entries in the sparse matrix. Typical: 1–5%.' },
                  { label: 'Branch',             value: currentWs.activeBranch.toUpperCase(),                 info: 'Current analytical provenance branch.' },
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

          {/* Objects List */}
          <div className="border-t border-border/50 pt-8">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-text flex items-center gap-3">
                Objects
                <span className="text-[10px] bg-slate-800 text-slate-500 px-2 py-0.5 rounded-full">
                  {currentWs.objects.length}
                </span>
              </h3>
              <button
                onClick={() => setShowLoadModal(true)}
                disabled={!!loadingId}
                className="btn btn-primary flex items-center gap-2 px-5 text-sm shadow-lg shadow-primary/20"
              >
                <FileUp size={16} /> Import Object
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {currentWs.objects.length === 0 ? (
                <div className="p-16 text-center border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center">
                  <Database size={40} className="text-slate-600 mb-4 opacity-50" />
                  <h4 className="text-text font-bold mb-2">No Analytical Objects</h4>
                  <p className="text-sm text-textMuted mb-6">
                    Import your own data or load the standard 10x Genomics tutorial dataset to explore.
                  </p>
                  <button
                    onClick={() => setShowLoadModal(true)}
                    className="btn btn-primary flex items-center gap-2"
                  >
                    <FileUp size={15} /> Load Dataset
                  </button>
                </div>
              ) : currentWs.objects.map(obj => {
                const isSelected = currentWs.selectedObjectIds?.includes(obj.id);
                return (
                  <div
                    key={obj.id}
                    onClick={() => selectObject(obj.id)}
                    className={`p-5 rounded-xl border transition-all cursor-pointer group relative flex items-center gap-5 ${
                      isSelected
                        ? 'bg-primary/5 border-primary shadow-lg'
                        : 'bg-surface border-border hover:border-slate-700'
                    }`}
                  >
                    {/* Icon */}
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors flex-shrink-0 ${
                      isSelected ? 'bg-primary text-white scale-110' : 'bg-slate-800 text-slate-500'
                    }`}>
                      {obj.isSubset ? <Scissors size={18} /> : <LayoutGrid size={20} />}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 group/edit h-6">
                        {editingId === obj.id ? (
                          <input
                            type="text" autoFocus
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
                            {obj.isSubset && (
                              <span className="text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide text-amber-400 bg-amber-500/10 border-amber-500/20">
                                subset
                              </span>
                            )}
                            <button
                              onClick={e => handleRenameObject(e, obj.id, obj.name)}
                              className="text-textMuted hover:text-text opacity-0 group-hover/edit:opacity-100 transition-opacity"
                              title="Rename"
                            >
                              <Edit2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-primary font-bold uppercase">
                          {obj.cells?.toLocaleString()} cells × {obj.features?.toLocaleString()} features
                        </span>
                        {obj.source && obj.source !== 'demo' && (
                          <span className="text-[10px] text-slate-500">{obj.source}</span>
                        )}
                      </div>
                    </div>

                    {/* Right side: date + inspect + delete + active badge */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="text-right text-[10px] text-slate-500">
                        {new Date(obj.timestamp).toLocaleDateString()}
                      </div>

                      {/* Inspect button */}
                      <button
                        onClick={e => { e.stopPropagation(); setInspectingObj(obj); }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold text-slate-400 hover:text-white"
                        title="Inspect Object"
                      >
                        <Search size={11} /> Inspect
                      </button>

                      {/* Delete button with inline confirm */}
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                        {confirmDeleteId === obj.id ? (
                          <>
                            <button
                              onClick={e => handleDeleteObject(e, obj.id)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/40 border border-red-500/50 text-[10px] font-bold text-red-400 transition"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={e => { e.stopPropagation(); setConfirmDeleteId(null); }}
                              className="flex items-center px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] text-slate-400 transition"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={e => handleDeleteObject(e, obj.id)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-red-500/20 border border-slate-700 hover:border-red-500/40 text-slate-500 hover:text-red-400 transition"
                            title="Delete object"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>

                      {isSelected && (
                        <div className="flex items-center gap-1.5 px-2.5 py-0.5 bg-primary/20 border border-primary/30 rounded-full text-[9px] font-black text-primary uppercase">
                          <CheckCircle size={10} /> Active
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showLoadModal && (
        <LoadModal
          onClose={() => setShowLoadModal(false)}
          onLoaded={handleLoaded}
          loadingId={loadingId}
          setLoadingId={setLoadingId}
        />
      )}

      {inspectingObj && (
        <ObjectInspector
          obj={inspectingObj}
          onClose={() => setInspectingObj(null)}
          onSubsetCreated={handleSubsetCreated}
          onMetaAdded={() => {/* inspector refreshes itself */}}
          parentSessionPath={parentSessionPath}
        />
      )}
    </div>
  );
}
