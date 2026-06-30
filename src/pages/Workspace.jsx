import React, { useState } from 'react';
import {
  Database, FileUp, Zap, CheckCircle, Info, Globe, Lock,
  LayoutGrid, List, Edit2, FolderOpen, HardDrive, FlaskConical,
  X, SlidersHorizontal, ChevronDown, ChevronUp, Search, Scissors, Trash2,
  FolderTree, Plus, MoreVertical, ScatterChart
} from 'lucide-react';

// Removed API constant
// ── Load Dataset Modal ─────────────────────────────────────────────

function LoadModal({ onClose, onLoaded, loadingId, setLoadingId, activeProjectId, onCreateAnalysisObjectForLoad }) {
  const [showFilters, setShowFilters] = useState(false);
  const [minCells, setMinCells] = useState(3);
  const [minFeatures, setMinFeatures] = useState(200);
  const [error, setError] = useState(null);

  const isLoading = !!loadingId;

  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isLoading) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isLoading]);

  // Multi-10X setup state
  const [multiStep, setMultiStep] = useState(null); // null | 'setup'
  const [multiPaths, setMultiPaths] = useState([]);
  const [sampleNames, setSampleNames] = useState([]);
  const [metaCol, setMetaCol] = useState('orig.ident');
  const [extraMetaCols, setExtraMetaCols] = useState([]);

  const addExtraMetaCol = () => setExtraMetaCols(prev => [...prev, { name: `Meta_${prev.length + 1}`, values: Array(multiPaths.length).fill('') }]);
  const removeExtraMetaCol = idx => setExtraMetaCols(prev => prev.filter((_, i) => i !== idx));
  const updateExtraMetaColName = (idx, name) => setExtraMetaCols(prev => prev.map((c, i) => i === idx ? { ...c, name } : c));
  const updateExtraMetaColValue = (colIdx, rowIdx, val) => setExtraMetaCols(prev => prev.map((c, i) => i === colIdx ? { ...c, values: c.values.map((v, j) => j === rowIdx ? val : v) } : c));

  const runWithAnalysisObject = async ({
    endpoint,
    options = {},
    displayName,
    sourceType,
    metadata = {},
  }) => {
    if (!activeProjectId) throw new Error('Select or create a backend project before loading data.');
    const analysisObject = await onCreateAnalysisObjectForLoad({
      projectId: activeProjectId,
      displayName,
      sourceType,
      metadata,
    });
    const headers = { ...(options.headers || {}), 'X-Object-ID': analysisObject.id };
    const data = await window.electronAPI.apiRequest(endpoint, { ...options, headers });
    if (data.error) throw new Error(data.error);
    if (data.result) onLoaded(data, displayName, analysisObject);
  };

  const loadDemo = async () => {
    setError(null);
    setLoadingId('demo');
    try {
      await runWithAnalysisObject({
        endpoint: `/load-data?min_cells=${minCells}&min_features=${minFeatures}`,
        displayName: 'PBMC_3k_Tutorial',
        sourceType: 'pbmc3k_demo',
        metadata: { minCells, minFeatures },
      });
    } catch (err) {
      setError(`Request failed: ${err.message}`);
    }
    setLoadingId(null);
  };

  const load10X = async () => {
    const path = await window.electronAPI?.openDirectoryDialog();
    if (!path) return;
    setError(null);
    setLoadingId('10x');
    try {
      const params = new URLSearchParams({ path, min_cells: minCells, min_features: minFeatures });
      await runWithAnalysisObject({
        endpoint: `/load-local-10x?${params}`,
        displayName: path.split(/[/\\]/).pop(),
        sourceType: 'local_10x',
        metadata: { minCells, minFeatures },
      });
    } catch (err) {
      setError(`Request failed: ${err.message}`);
    }
    setLoadingId(null);
  };

  const openMulti10X = async () => {
    const paths = await window.electronAPI?.openMultiDirectoryDialog();
    if (!paths || paths.length === 0) return;
    // Default sample name = folder name
    setMultiPaths(paths);
    setSampleNames(paths.map(p => p.split(/[/\\]/).pop()));
    setMetaCol('orig.ident');
    setExtraMetaCols([]);
    setMultiStep('setup');
  };

  const addMore10X = async () => {
    const paths = await window.electronAPI?.openMultiDirectoryDialog();
    if (!paths || paths.length === 0) return;
    const newPaths = paths.filter(p => !multiPaths.includes(p));
    if (newPaths.length === 0) return;
    setMultiPaths(prev => [...prev, ...newPaths]);
    setSampleNames(prev => [...prev, ...newPaths.map(p => p.split(/[/\\]/).pop())]);
    setExtraMetaCols(prev => prev.map(c => ({ ...c, values: [...c.values, ...Array(newPaths.length).fill('')] })));
  };

  const scanRoot10X = async () => {
    const result = await window.electronAPI?.scan10xRoot();
    if (!result || result.found.length === 0) {
      if (result?.root) alert(`No 10X data folders found under:\n${result.root}\n\nMake sure each sample folder contains barcodes.tsv, features.tsv, and matrix.mtx.`);
      return;
    }
    const newPaths = result.found.filter(p => !multiPaths.includes(p));
    if (newPaths.length === 0) { alert('All found folders are already in the list.'); return; }
    setMultiPaths(prev => [...prev, ...newPaths]);
    setSampleNames(prev => [...prev, ...newPaths.map(p => p.split(/[/\\]/).pop())]);
    setExtraMetaCols(prev => prev.map(c => ({ ...c, values: [...c.values, ...Array(newPaths.length).fill('')] })));
    if (multiStep !== 'setup') setMultiStep('setup');
  };

  const remove10X = (index) => {
    const newPaths = multiPaths.filter((_, i) => i !== index);
    const newNames = sampleNames.filter((_, i) => i !== index);
    setMultiPaths(newPaths);
    setSampleNames(newNames);
    setExtraMetaCols(prev => prev.map(c => ({ ...c, values: c.values.filter((_, i) => i !== index) })));
    if (newPaths.length === 0) setMultiStep(null);
  };

  const submitMulti10X = async () => {
    if (multiPaths.length === 0) return;
    // Validate sample names
    const trimmed = sampleNames.map(n => n.trim());
    if (trimmed.some(n => n === '')) {
      setError('All sample names must be non-empty.');
      return;
    }
    if (new Set(trimmed).size !== trimmed.length) {
      setError('Sample names must be unique.');
      return;
    }

    // Validate extra metadata
    const extraMeta = {};
    for (const col of extraMetaCols) {
      const cName = col.name.trim();
      if (!cName) { setError('Additional metadata column names cannot be empty.'); return; }
      if (cName === (metaCol.trim() || 'orig.ident')) { setError(`Column name "${cName}" conflicts with the primary metadata column.`); return; }
      if (extraMeta[cName]) { setError(`Duplicate metadata column name: ${cName}`); return; }
      extraMeta[cName] = col.values.map(v => v.trim());
    }

    const colName = metaCol.trim() || 'orig.ident';
    setError(null);
    setLoadingId('multi10x');
    try {
      await runWithAnalysisObject({
        endpoint: '/load-multi-10x',
        displayName: trimmed.join('+').length > 40 ? `${trimmed.length}_samples_merged` : trimmed.join('+'),
        sourceType: 'multi_10x',
        metadata: { sampleCount: trimmed.length, minCells, minFeatures },
        options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paths: multiPaths,
          sample_names: trimmed,
          meta_col: colName,
          extra_meta: Object.keys(extraMeta).length > 0 ? extraMeta : null,
          min_cells: minCells,
          min_features: minFeatures,
        }),
        },
      });
    } catch (err) {
      setError(`Request failed: ${err.message}`);
    }
    setLoadingId(null);
  };

  const loadRds = async () => {
    const path = await window.electronAPI?.openDataFileDialog('rds');
    if (!path) return;
    setError(null);
    setLoadingId('rds');
    try {
      await runWithAnalysisObject({
        endpoint: '/load-rds',
        displayName: path.split(/[/\\]/).pop().replace(/\.rds$/i, ''),
        sourceType: 'rds_import',
        metadata: {},
        options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) },
      });
    } catch (err) {
      setError(`Request failed: ${err.message}`);
    }
    setLoadingId(null);
  };

  const loadH5 = async () => {
    const path = await window.electronAPI?.openDataFileDialog('h5');
    if (!path) return;
    setError(null);
    setLoadingId('h5');
    try {
      await runWithAnalysisObject({
        endpoint: `/load-h5ad?path=${encodeURIComponent(path)}`,
        displayName: path.split(/[/\\]/).pop().replace(/\.(h5ad?|h5seurat)$/i, ''),
        sourceType: 'h5_import',
        metadata: {},
      });
    } catch (err) {
      setError(`Request failed: ${err.message}`);
    }
    setLoadingId(null);
  };



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
      id: 'multi10x',
      icon: <FolderTree size={22} className="text-cyan-400" />,
      title: 'Multiple 10X Directories',
      desc: 'Load several Cell Ranger output folders and merge them into one object. Sample names become a metadata column.',
      tag: 'Multi-Sample',
      tagColor: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
      action: openMulti10X,
    },
    {
      id: 'scan-root',
      icon: <Search size={22} className="text-violet-400" />,
      title: 'Scan Root Folder for Samples',
      desc: 'Select a parent folder and automatically discover all nested 10X data directories. Perfect for standard Cell Ranger project layouts.',
      tag: 'Auto-Detect',
      tagColor: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
      action: scanRoot10X,
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

  // ── Multi-10X Setup Step ─────────────────────────────────────────
  if (multiStep === 'setup') {
    return (
      <>
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onClick={onClose} />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl pointer-events-auto flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-7 pt-7 pb-5 border-b border-slate-800 flex-shrink-0">
              <div>
                <h3 className="text-lg font-black text-white tracking-tight flex items-center gap-2">
                  <FolderTree size={18} className="text-cyan-400" />
                  Configure Multi-Sample Merge
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {multiPaths.length} folder{multiPaths.length !== 1 ? 's' : ''} selected — edit sample names and metadata column below.
                </p>
              </div>
              <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition">
                <X size={16} />
              </button>
            </div>

            {/* Error Message */}
            {error && (
              <div className="mx-7 mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-lg flex items-center gap-2 flex-shrink-0">
                <Info size={14} className="flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Metadata column + filter params */}
            <div className="px-7 pt-5 pb-3 flex flex-col gap-3 border-b border-slate-800 flex-shrink-0">
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Global Settings</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={scanRoot10X}
                    title="Pick a root folder and auto-discover all nested 10X data directories"
                    className="flex items-center gap-1.5 px-2 py-1 rounded bg-violet-500/10 border border-violet-500/20 text-violet-400 text-[10px] font-black uppercase hover:bg-violet-500/20 transition-colors"
                  >
                    <Search size={12} /> Scan Root Folder
                  </button>
                  <button
                    onClick={addMore10X}
                    className="flex items-center gap-1.5 px-2 py-1 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[10px] font-black uppercase hover:bg-cyan-500/20 transition-colors"
                  >
                    <Plus size={12} /> Add Manually
                  </button>
                </div>
              </div>
              <div className="flex gap-3 items-center">
                <label className="text-xs font-bold text-slate-400 w-36 flex-shrink-0">Metadata Column</label>
                <input
                  type="text"
                  value={metaCol}
                  onChange={e => setMetaCol(e.target.value)}
                  placeholder="orig.ident"
                  className="flex-1 bg-slate-800 border border-slate-700 text-xs text-white px-3 py-2 rounded-lg focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div className="flex gap-3">
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
            </div>

            {/* Sample list */}
            <div className="flex-1 overflow-x-auto overflow-y-auto custom-scrollbar px-7 py-4 space-y-2">
              <div 
                className="grid gap-x-4 gap-y-2 items-center text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 px-1 pb-2 border-b border-slate-700/50"
                style={{ gridTemplateColumns: `auto minmax(200px, 2fr) ${'minmax(120px, 1fr) '.repeat(extraMetaCols.length)}auto` }}
              >
                <span className="w-6 text-center">#</span>
                <span>Sample Name (editable) / Folder Path</span>
                {extraMetaCols.map((c, i) => (
                  <div key={i} className="flex items-center gap-1 group">
                    <input 
                      type="text" 
                      value={c.name} 
                      onChange={e => updateExtraMetaColName(i, e.target.value)} 
                      className="bg-transparent border-b border-slate-600 focus:border-cyan-500 w-full focus:outline-none text-slate-300 placeholder:text-slate-400" 
                      placeholder="Column Name" 
                    />
                    <button onClick={() => removeExtraMetaCol(i)} className="text-slate-400 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity" title="Remove Column">
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button onClick={addExtraMetaCol} className="text-cyan-400 hover:text-cyan-300 ml-auto flex items-center gap-1" title="Add Metadata Column">
                  <Plus size={12} /> <span className="hidden sm:inline">Add Meta</span>
                </button>
              </div>
              {multiPaths.map((p, i) => (
                <div 
                  key={i} 
                  className="grid gap-x-4 gap-y-2 items-center p-3 rounded-xl bg-slate-800/60 border border-slate-700/50 group/row hover:bg-slate-800/80 transition-colors"
                  style={{ gridTemplateColumns: `auto minmax(200px, 2fr) ${'minmax(120px, 1fr) '.repeat(extraMetaCols.length)}auto` }}
                >
                  <span className="text-[10px] font-black text-cyan-400 w-6 text-center flex-shrink-0">{i + 1}</span>
                  <div className="min-w-0">
                    <input
                      type="text"
                      value={sampleNames[i] || ''}
                      onChange={e => setSampleNames(prev => prev.map((n, j) => j === i ? e.target.value : n))}
                      className="w-full bg-slate-900 border border-slate-700 text-sm text-white px-3 py-1.5 rounded-lg focus:outline-none focus:border-cyan-500 font-bold mb-1"
                      placeholder={`Sample ${i + 1}`}
                    />
                    <p className="text-[10px] text-slate-400 truncate pl-1" title={p}>{p}</p>
                  </div>
                  {extraMetaCols.map((c, colIdx) => (
                    <input
                      key={colIdx}
                      type="text"
                      value={c.values[i] || ''}
                      onChange={e => updateExtraMetaColValue(colIdx, i, e.target.value)}
                      className="w-full bg-slate-900 border border-slate-700 text-xs text-white px-3 py-1.5 rounded-lg focus:outline-none focus:border-cyan-500"
                      placeholder={c.name}
                    />
                  ))}
                  <button
                    onClick={() => remove10X(i)}
                    className="p-2 rounded-lg text-slate-400 hover:bg-rose-500/20 hover:text-rose-400 transition-colors opacity-0 group-hover/row:opacity-100"
                    title="Remove Sample"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-7 py-5 border-t border-slate-800 flex justify-between items-center flex-shrink-0 gap-3">
              <button
                onClick={() => setMultiStep(null)}
                disabled={isLoading}
                className="btn btn-ghost border border-slate-700 text-sm px-4 py-2 text-slate-400 hover:text-white hover:border-slate-500 disabled:opacity-50"
              >
                ← Back
              </button>
              <button
                onClick={submitMulti10X}
                disabled={isLoading || sampleNames.some(n => !n.trim())}
                className="btn btn-primary flex items-center gap-2 px-6 text-sm shadow-lg shadow-cyan-500/20 disabled:opacity-50"
              >
                {loadingId === 'multi10x' ? (
                  <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Merging...</>
                ) : (
                  <><Zap size={15} /> Merge {multiPaths.length} Samples</>
                )}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // ── Default: Source Selection Step ───────────────────────────────
  return (
    <>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-xl pointer-events-auto">
          {/* Header */}
          <div className="flex items-center justify-between px-7 pt-7 pb-5 border-b border-slate-800">
            <div>
              <h3 className="text-lg font-black text-white tracking-tight">Load Dataset</h3>
              <p className="text-xs text-slate-400 mt-0.5">Choose a source to import into your workspace.</p>
            </div>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition">
              <X size={16} />
            </button>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mx-7 mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-lg flex items-center gap-2">
              <Info size={14} className="flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Filter params (collapsible) */}
          <div className="px-7 pt-4">
            <button
              onClick={() => setShowFilters(v => !v)}
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white transition"
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
  setActiveTab,
  userEmail,
  backendModelStatus,
  onSelectProject,
  onCreateProject,
  onCreateAnalysisObjectForLoad,
  onAnalysisObjectLoaded,
  onSelectAnalysisObject,
}) {
  const selectedObjects = currentWs.objects.filter(obj => currentWs.selectedObjectIds?.includes(obj.id));
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadingId, setLoadingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Projects come from the backend. The selected project ID may be cached as a
  // UI preference, but the project list itself is not localStorage truth.
  const defaultProjectId = currentWs.selectedProjectId || currentWs.projects?.[0]?.id || null;
  const [activeProjectId, setActiveProjectId] = useState(defaultProjectId);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [openMenuId, setOpenMenuId] = useState(null);

  // Sync active project if workspace changes
  React.useEffect(() => {
    setActiveProjectId(defaultProjectId);
  }, [defaultProjectId]);

  const handleProjectSelect = async (projId) => {
    setActiveProjectId(projId);
    await onSelectProject?.(projId);
  };

  const activeProjectObjects = activeProjectId
    ? currentWs.objects.filter(o => o.projectId === activeProjectId)
    : [];

  // Called when any load option completes successfully
  const handleLoaded = (data, suggestedName, analysisObject) => {
    if (!analysisObject?.id) {
      setLoadingId(null);
      return;
    }
    let baseName = suggestedName || 'Dataset';
    let finalName = baseName;
    let counter = 1;
    const existingNames = currentWs.objects.filter(o => o.projectId === activeProjectId).map(o => o.name);
    while (existingNames.includes(finalName)) {
      finalName = `${baseName} (${counter})`;
      counter++;
    }

    const namedAnalysisObject = { ...analysisObject, displayName: analysisObject.displayName || finalName };
    onAnalysisObjectLoaded?.(activeProjectId, namedAnalysisObject, data.result);

    setDataVersion(v => v + 1);
    setShowLoadModal(false);
  };

  const selectObject = (id) => {
    const obj = currentWs.objects.find(o => o.id === id);
    if (!obj) return;
    onSelectAnalysisObject?.(obj.projectId, id);
  };

  const handleRenameObject = (e, objId, currentName) => {
    e.stopPropagation();
    setEditingId(objId);
    setEditName(currentName);
  };

  const saveRename = (e, objId) => {
    e.stopPropagation();
    const trimmed = editName.trim();
    if (trimmed) {
      const obj = currentWs.objects.find(o => o.id === objId);
      if (obj) {
        const existingNames = currentWs.objects.filter(o => o.projectId === obj.projectId && o.id !== objId).map(o => o.name);
        if (existingNames.includes(trimmed)) {
          alert(`An object named "${trimmed}" already exists in this project.`);
          return;
        }
      }
      updateActiveWorkspace({
        objects: currentWs.objects.map(o => o.id === objId ? { ...o, name: trimmed } : o)
      });
    }
    setEditingId(null);
  };

  const handleDeleteObject = (e, objId) => {
    e.stopPropagation();
    if (confirmDeleteId !== objId) {
      setConfirmDeleteId(objId);
      return;
    }
    const obj = currentWs.objects.find(o => o.id === objId);
    if (obj?.parentObjId) {
      // It's a subset: don't delete from disk, just remove from workspace UI
      // If we *really* wanted to delete subset files we could do that here,
      // but right now subsets exist inside the parent's vault file.
    }
    setConfirmDeleteId(null);
    setOpenMenuId(null);

    // 2. App State update
    const remainingObjects = currentWs.objects.filter(o => o.id !== objId);
    const wasSelected = currentWs.selectedObjectIds?.includes(objId);
    const newSelected = wasSelected
      ? remainingObjects.length > 0 ? [remainingObjects[0].id] : []
      : (currentWs.selectedObjectIds || []).filter(id => id !== objId);
    
    updateActiveWorkspace({
      objects: remainingObjects,
      selectedObjectIds: newSelected,
    });

    // 3. LocalStorage cleanup (Tab parameters + Pipeline state)
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.includes(`_${objId}`) || k.endsWith(`_${objId}`))) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  };

  // ── Project Management ──────────────────────────────────────────

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      const project = await onCreateProject?.({ name: newProjectName.trim(), description: '' });
      if (project?.id) setActiveProjectId(project.id);
      setNewProjectName('');
      setIsCreatingProject(false);
    } catch (err) {
      alert(err.message || 'Failed to create project.');
    }
  };

  const handleChangeObjectProject = (e, objId, newProjectId) => {
    e.stopPropagation();
    
    let newSelected = currentWs.selectedObjectIds || [];
    if (newSelected.includes(objId)) {
      const remainingInCurrent = currentWs.objects.filter(o => o.projectId === activeProjectId && o.id !== objId);
      newSelected = remainingInCurrent.length > 0 ? [remainingInCurrent[remainingInCurrent.length - 1].id] : [];
    }

    updateActiveWorkspace({
      objects: currentWs.objects.map(o => o.id === objId ? { ...o, projectId: newProjectId } : o),
      selectedObjectIds: newSelected
    });
  };

  // ────────────────────────────────────────────────────────────────

  const activeCount = selectedObjects.length;
  const displayObject = selectedObjects[0] || currentWs.objects[0];

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-8 pt-6 pb-4 flex justify-between items-end border-b border-border bg-slate-800/10">
        <div>
          <h2 className="text-2xl font-black text-text tracking-tighter flex items-center gap-3">
            {currentWs.name}
            {currentWs.type === 'personal'
              ? <Lock size={16} className="text-slate-400" />
              : <Globe size={16} className="text-primary" />}
          </h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-8">
        <div className="max-w-5xl mx-auto space-y-12 animate-in fade-in slide-in-from-bottom-6">

          {/* Stats Block */}
          {displayObject && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
              <button 
                className="flex items-center gap-2 mb-4 group/info cursor-pointer hover:bg-white/5 px-2 py-1 -ml-2 rounded-lg transition-colors"
                onClick={() => alert("Detailed dataset metadata modal would open here.")}
                title="View detailed metadata"
              >
                <Info size={16} className="text-primary group-hover/info:text-white transition-colors" />
                <h3 className="text-[10px] font-black text-slate-400 group-hover/info:text-slate-300 uppercase tracking-widest transition-colors">
                  {activeCount > 1
                    ? `Multi-Select Mode (${activeCount} Active)`
                    : `Data Info: ${displayObject.name}`}
                </h3>
                <ChevronDown size={14} className="text-slate-500 group-hover/info:text-slate-300 opacity-0 group-hover/info:opacity-100 transition-all -ml-1" />
              </button>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { label: 'Cells (Primary)',    value: displayObject.cells?.toLocaleString() || '0',        info: 'Total unique barcodes after filtering.', icon: Database },
                  { label: 'Features (Primary)', value: displayObject.features?.toLocaleString() || '0',     info: 'Number of genes measured per cell.', icon: LayoutGrid },
                  { label: 'Density',            value: (displayObject.density || '0.00') + '%',              info: 'Percentage of non-zero entries in the sparse matrix. Typical: 1–5%.', icon: ScatterChart },
                  { label: 'Branch',             value: currentWs.activeBranch.toUpperCase(),                 info: 'Current analytical provenance branch.', icon: FolderTree },
                ].map((stat, i) => (
                  <div key={i} className="card p-6 bg-surface/50 border-border/50 hover:border-primary/40 transition-all group relative flex flex-col justify-center items-center min-h-[130px]">
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="relative">
                        <Info size={12} className="text-slate-400 cursor-help" />
                        <div className="absolute bottom-full right-0 mb-2 w-48 p-2 bg-slate-800 border border-slate-700 rounded-lg text-[10px] text-slate-300 shadow-2xl invisible group-hover:visible z-50 pointer-events-none text-center">
                          {stat.info}
                        </div>
                      </div>
                    </div>
                    <stat.icon size={24} className="text-slate-500/50 mb-2 group-hover:text-primary/50 transition-colors" />
                    <div className="text-2xl font-black text-text mb-1 tracking-tighter text-center">{stat.value}</div>
                    <div className="text-[10px] font-bold text-blue-700 dark:text-blue-300 uppercase tracking-widest text-center">{stat.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Projects Navigation */}
          <div className="pt-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-text flex items-center gap-3">
                <FolderTree size={18} className="text-slate-400" />
                Projects
              </h3>
              {isCreatingProject ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    placeholder="Project Name"
                    className="bg-slate-800 border border-slate-700 text-sm text-white px-3 py-1.5 rounded focus:outline-none focus:border-primary w-40"
                    autoFocus
                  />
                  <button onClick={handleCreateProject} className="btn btn-primary text-xs px-3 py-1.5">Save</button>
                  <button onClick={() => setIsCreatingProject(false)} className="text-slate-400 hover:text-white px-2"><X size={14} /></button>
                </div>
              ) : (
                <button
                  onClick={() => setIsCreatingProject(true)}
                  className="btn btn-primary text-xs px-4 py-2 flex items-center gap-2 font-bold shadow-sm transition-all"
                >
                  <Plus size={14} /> New Project
                </button>
              )}
            </div>

            {backendModelStatus?.error && (
              <div className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {backendModelStatus.error}
              </div>
            )}

            <div className="flex gap-2 overflow-x-auto pb-4 border-b border-border/50 custom-scrollbar">
              {backendModelStatus?.projectsLoading ? (
                <div className="text-sm text-textMuted px-1 py-3">Loading backend projects...</div>
              ) : currentWs.projects?.length === 0 ? (
                <div className="w-full rounded border border-dashed border-border p-6 text-center">
                  <h4 className="text-text font-bold mb-2">No backend projects</h4>
                  <p className="text-sm text-textMuted mb-4">Create a real backend project before loading analysis objects.</p>
                  <button
                    onClick={() => setIsCreatingProject(true)}
                    className="btn btn-primary text-xs px-4 py-2 inline-flex items-center gap-2"
                  >
                    <Plus size={14} /> Create Project
                  </button>
                </div>
              ) : currentWs.projects?.map(proj => {
                const isActive = activeProjectId === proj.id;
                const projObjects = currentWs.objects.filter(o => o.projectId === proj.id);

                return (
                  <div
                    key={proj.id}
                    onClick={() => handleProjectSelect(proj.id)}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border transition-all cursor-pointer min-w-max group ${
                      isActive ? 'bg-primary/10 border-primary text-white shadow-sm' : 'bg-slate-800/50 border-slate-700/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className="font-bold text-sm">{proj.name}</span>
                      {proj.role && <span className="text-[9px] text-primary uppercase">{proj.role}</span>}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-primary/20 text-primary' : 'bg-slate-900 text-slate-400'}`}>
                        {projObjects.length}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Objects List */}
          <div className="pt-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-text flex items-center gap-3">
                Objects in Project
                <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">
                  {activeProjectObjects.length}
                </span>
              </h3>
              <button
                onClick={() => setShowLoadModal(true)}
                disabled={!!loadingId || !activeProjectId}
                className="btn btn-primary flex items-center gap-2 px-5 text-sm shadow-lg shadow-primary/20"
              >
                <FileUp size={16} /> Import Object
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {!activeProjectId ? (
                <div className="p-16 text-center border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center">
                  <FolderTree size={40} className="text-slate-400 mb-4 opacity-50" />
                  <h4 className="text-text font-bold mb-2">Select a backend project</h4>
                  <p className="text-sm text-textMuted mb-6">
                    Projects are loaded from the backend. Select or create one to list analysis objects.
                  </p>
                </div>
              ) : backendModelStatus?.objectsLoading ? (
                <div className="p-16 text-center border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center">
                  <Database size={40} className="text-slate-400 mb-4 opacity-50" />
                  <h4 className="text-text font-bold mb-2">Loading analysis objects</h4>
                  <p className="text-sm text-textMuted">Reading DB-backed project object metadata.</p>
                </div>
              ) : activeProjectObjects.length === 0 ? (
                <div className="p-16 text-center border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center">
                  <Database size={40} className="text-slate-400 mb-4 opacity-50" />
                  <h4 className="text-text font-bold mb-2">No analysis objects in this project</h4>
                  <p className="text-sm text-textMuted mb-6">
                    Load the PBMC demo or import data to create a DB-backed analysis object.
                  </p>
                  <button
                    onClick={() => setShowLoadModal(true)}
                    className="btn btn-primary flex items-center gap-2"
                  >
                    <FileUp size={15} /> Load Dataset
                  </button>
                </div>
              ) : activeProjectObjects.map(obj => {
                const isSelected = currentWs.selectedObjectIds?.includes(obj.id);
                return (
                  <div
                    key={obj.id}
                    onClick={() => { selectObject(obj.id); setOpenMenuId(null); }}
                    onMouseLeave={() => setOpenMenuId(null)}
                    className={`p-5 rounded-xl border transition-all cursor-pointer group relative flex items-center gap-5 ${
                      isSelected
                        ? 'bg-primary/5 border-primary shadow-lg'
                        : 'bg-surface border-border hover:border-slate-700'
                    }`}
                  >
                    {/* Icon */}
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors flex-shrink-0 ${
                      isSelected ? 'bg-primary text-white scale-110' : 'bg-slate-800 text-slate-400'
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
                            {!obj.isBackendAnalysisObject && (
                              <button
                                onClick={e => handleRenameObject(e, obj.id, obj.name)}
                                className="text-textMuted hover:text-text opacity-0 group-hover/edit:opacity-100 transition-opacity"
                                title="Rename"
                              >
                                <Edit2 size={12} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-primary font-bold uppercase">
                          {obj.cells?.toLocaleString()} cells × {obj.features?.toLocaleString()} features
                        </span>
                        <div className="w-1 h-1 rounded-full bg-slate-700"></div>
                        <span className="text-[10px] text-slate-400">
                          {new Date(obj.timestamp).toLocaleDateString()}
                        </span>
                        {obj.source && obj.source !== 'demo' && (
                          <>
                            <div className="w-1 h-1 rounded-full bg-slate-700"></div>
                            <span className="text-[10px] text-slate-400">{obj.source}</span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right side: active badge + menu */}
                    <div className="flex items-center gap-3 flex-shrink-0 relative">

                      {isSelected && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-primary/10 border border-primary/20 rounded-full text-[9px] font-black text-blue-700 dark:text-blue-300 uppercase shadow-sm">
                          <CheckCircle size={10} /> Active
                        </div>
                      )}

                      {/* 3-dot Menu */}
                      <div className="relative">
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            setOpenMenuId(openMenuId === obj.id ? null : obj.id);
                          }}
                          aria-label="Object options"
                          className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
                        >
                          <MoreVertical size={16} />
                        </button>
                        
                        {openMenuId === obj.id && (
                          <div 
                            className="absolute right-0 top-full mt-2 w-48 bg-slate-800 border border-slate-700 rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden animate-in fade-in zoom-in-95"
                            onClick={e => e.stopPropagation()}
                          >
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                selectObject(obj.id);
                                setActiveTab('inspect');
                                setOpenMenuId(null);
                              }}
                              className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/50 hover:text-white flex items-center gap-2"
                            >
                              <Search size={14} /> Inspect Data
                            </button>
                            
                            {!obj.isBackendAnalysisObject && currentWs.projects?.length > 1 && (
                              <>
                                <div className="h-px bg-slate-700/50 my-1" />
                                <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                  Move to Project
                                </div>
                                {currentWs.projects.map(p => (
                                  <button
                                    key={p.id}
                                    onClick={e => { handleChangeObjectProject(e, obj.id, p.id); setOpenMenuId(null); }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-700/50 hover:text-white flex items-center justify-between"
                                  >
                                    {p.name}
                                    {obj.projectId === p.id && <CheckCircle size={12} className="text-primary"/>}
                                  </button>
                                ))}
                              </>
                            )}

                            {!obj.isBackendAnalysisObject && (
                              <>
                                <div className="h-px bg-slate-700/50 my-1" />

                                {confirmDeleteId === obj.id ? (
                                  <div className="flex gap-1 px-2 py-1">
                                    <button
                                      onClick={e => handleDeleteObject(e, obj.id)}
                                      className="flex-1 bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1.5 rounded"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      onClick={e => { e.stopPropagation(); setConfirmDeleteId(null); }}
                                      className="flex-1 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold py-1.5 rounded"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={e => handleDeleteObject(e, obj.id)}
                                    className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 hover:text-red-300 flex items-center gap-2"
                                  >
                                    <Trash2 size={14} /> Delete Object
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
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
          activeProjectId={activeProjectId}
          onCreateAnalysisObjectForLoad={onCreateAnalysisObjectForLoad}
        />
      )}
    </div>
  );
}
