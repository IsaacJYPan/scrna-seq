import React, { useState } from 'react';
import {
  Database, FileUp, Zap, CheckCircle, Info, Globe, Lock,
  LayoutGrid, List, Edit2, FolderOpen, HardDrive, FlaskConical,
  X, SlidersHorizontal, ChevronDown, ChevronUp, Search, Scissors, Trash2,
  FolderTree, Plus, MoreVertical, ScatterChart, Loader2, RefreshCw, Archive
} from 'lucide-react';
import { mapBackendAnalysisObject } from '../backendWorkspaceModel';

// Removed API constant
// ── Load Object Modal ──────────────────────────────────────────────

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
      desc: 'Load a trusted local Seurat object saved as .rds. Disabled unless ALLOW_TRUSTED_RDS_LOAD=true.',
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
              <h3 className="text-lg font-black text-white tracking-tight">Load / Attach Object</h3>
              <p className="text-xs text-slate-400 mt-0.5">Choose a source to create a DB-backed object and attach private live R state.</p>
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

function StatusPill({ label, tone = 'slate' }) {
  const tones = {
    green: 'bg-success/10 text-success border-success/30',
    blue: 'bg-primary/10 text-text border-primary/20',
    amber: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
    slate: 'bg-slate-800 text-slate-300 border-slate-700',
  };
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${tones[tone] || tones.slate}`}>
      {label}
    </span>
  );
}

function formatDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function safeMessage(value) {
  return String(value || '')
    .replace(/[A-Za-z]:[\\/][^\s'")]+/g, '[redacted path]')
    .replace(/\/__private_vault__\/[^\s'")]+/g, '[redacted path]')
    .replace(/\bvault\/[^\s'")]+/gi, '[redacted storage]')
    .replace(/\bstorage_?(uri|key)\b/gi, '[redacted storage field]')
    .replace(/\bclaim_?token\b/gi, '[redacted worker field]')
    .replace(/\bstate_?key\b/gi, '[redacted state field]')
    .replace(/\buser-\d+:obj-[A-Za-z0-9_-]+/g, '[redacted state]');
}

function isSupportedTenxH5File(file) {
  return !!file?.name && /\.h5$/i.test(file.name);
}

function parseApiError(error) {
  const raw = error?.message || String(error || 'Request failed.');
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error || raw;
  } catch {
    return raw;
  }
}

const DEFAULT_SEURAT_PIPELINE_PARAMS = Object.freeze({
  minCells: 3,
  minFeatures: 200,
  applyQcFilter: true,
  minFeaturesFilter: 200,
  maxFeaturesFilter: 2500,
  maxPercentMt: 5,
  normalizationMethod: 'LogNormalize',
  scaleFactor: 10000,
  variableFeatures: 2000,
  pcaDims: 50,
  clusterDims: 15,
  clusterResolution: 0.8,
  umapDims: 15,
  umapComponents: 2,
  umapNeighbors: 30,
  umapMinDist: 0.3,
  seed: null,
});

const SEURAT_NUMERIC_CONTROLS = Object.freeze([
  { key: 'minCells', label: 'Min cells', min: 0, max: 10000, step: 1 },
  { key: 'minFeatures', label: 'Min features', min: 0, max: 100000, step: 1 },
  { key: 'minFeaturesFilter', label: 'QC min features', min: 0, max: 100000, step: 1 },
  { key: 'maxFeaturesFilter', label: 'QC max features', min: 1, max: 1000000, step: 1 },
  { key: 'maxPercentMt', label: 'Max percent MT', min: 0, max: 100, step: 0.1 },
  { key: 'scaleFactor', label: 'Scale factor', min: 1, max: 10000000, step: 1 },
  { key: 'variableFeatures', label: 'Variable features', min: 50, max: 10000, step: 1 },
  { key: 'pcaDims', label: 'PCA dims', min: 2, max: 100, step: 1 },
  { key: 'clusterDims', label: 'Cluster dims', min: 2, max: 100, step: 1 },
  { key: 'clusterResolution', label: 'Cluster resolution', min: 0.01, max: 10, step: 0.01 },
  { key: 'umapDims', label: 'UMAP dims', min: 2, max: 100, step: 1 },
  { key: 'umapNeighbors', label: 'UMAP neighbors', min: 2, max: 200, step: 1 },
  { key: 'umapMinDist', label: 'UMAP min dist', min: 0, max: 1, step: 0.01 },
]);

function datasetDisplayName(dataset) {
  return dataset?.originalFilename || dataset?.name || dataset?.id || 'Dataset';
}

function rawDatasetObjectName(dataset) {
  const base = datasetDisplayName(dataset).replace(/\.[^.]+$/, '');
  return `${base} raw dataset`;
}

function scrubEmptyParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== '') out[key] = value;
  }
  return out;
}

function pipelineStatus(done, hasObject, fallback = 'Requires loaded object') {
  if (!hasObject) return { label: fallback, tone: 'slate' };
  return done ? { label: 'Ready', tone: 'green' } : { label: 'Ready', tone: 'blue' };
}

function WorkbenchOverview({
  activeProject,
  selectedObject,
  activeProjectObjects,
  pipelineState,
  sessionReady,
  rSessionId,
  setActiveTab,
  setShowLoadModal,
}) {
  const hasProject = !!activeProject;
  const hasObject = !!selectedObject;
  const hasObjectsInProject = activeProjectObjects.length > 0;
  const isDbBacked = !!selectedObject?.isBackendAnalysisObject || /^ao_/.test(selectedObject?.id || '');
  const liveAttached = selectedObject?.liveState === 'attached';
  const liveStatus = !hasObject
    ? { label: 'Requires loaded object', tone: 'slate' }
    : liveAttached
      ? { label: 'Live R: attached', tone: 'green' }
      : { label: 'Live R: not attached', tone: sessionReady && rSessionId ? 'amber' : 'slate' };

  const sections = [
    { label: 'Project context', status: hasProject ? { label: 'Ready', tone: 'green' } : { label: 'Select project', tone: 'slate' }, detail: 'Durable backend project metadata.' },
    {
      label: 'Dataset / object',
      status: hasObject
        ? { label: 'Ready', tone: 'green' }
        : hasObjectsInProject
          ? { label: 'Select object', tone: 'amber' }
          : { label: 'Requires loaded object', tone: 'slate' },
      detail: 'DB-backed analysis object identity.',
    },
    { label: 'Inspect', status: pipelineStatus(false, hasObject), detail: 'Live object metadata and subsetting.' },
    { label: 'Quality control', status: pipelineStatus(pipelineState?.qc, hasObject), detail: 'Transient live-R workflow.' },
    { label: 'Normalize', status: pipelineStatus(pipelineState?.normalize, hasObject), detail: 'Transient live-R workflow.' },
    { label: 'PCA', status: pipelineStatus(pipelineState?.pca, hasObject), detail: 'Transient live-R workflow.' },
    { label: 'Cluster / UMAP', status: !hasObject ? { label: 'Requires loaded object', tone: 'slate' } : pipelineState?.pca ? { label: 'Ready', tone: 'blue' } : { label: 'Requires PCA', tone: 'amber' }, detail: 'Live-R analysis and visualization.' },
    {
      label: 'Markers / DEG',
      status: !hasObject
        ? { label: 'Requires loaded object', tone: 'slate' }
        : isDbBacked
          ? { label: 'Durable worker job', tone: 'green' }
          : { label: 'Requires DB-backed object', tone: 'amber' },
      detail: 'Current UI launches deg.find_markers.v1 jobs for DB-backed objects and shows bounded summary metadata.',
    },
    { label: 'Jobs & artifacts', status: hasProject ? { label: 'Metadata plus DEG launch', tone: 'blue' } : { label: 'Select project', tone: 'slate' }, detail: 'Durable backend foundation; no download UI.' },
    { label: 'Reports / export', status: { label: 'Future workflow', tone: 'slate' }, detail: 'Figure gallery exists; full reports are not implemented.' },
    { label: 'Diagnostics', status: { label: 'Ready', tone: 'green' }, detail: 'Backend and R runtime checks.' },
  ];

  let nextAction = 'Select or create a backend project.';
  let actionLabel = 'Create Project';
  let action = null;
  if (hasProject && !hasObject && hasObjectsInProject) {
    nextAction = 'Select a DB-backed analysis object from the project list below before opening live-R workflow tabs.';
    actionLabel = 'Select Object';
  } else if (hasProject && !hasObject) {
    nextAction = 'Load a PBMC demo or trusted local object into this backend project.';
    actionLabel = 'Load Object';
    action = () => setShowLoadModal(true);
  } else if (hasProject && hasObject && !liveAttached) {
    nextAction = 'This DB-backed object is selected, but its private live R state is not attached in this browser session.';
    actionLabel = 'Open Object List';
  } else if (hasProject && hasObject && !pipelineState?.qc) {
    nextAction = 'Run quality control against the attached private live R object.';
    actionLabel = 'Open Quality Control';
    action = () => setActiveTab('qc');
  } else if (hasProject && hasObject && !pipelineState?.normalize) {
    nextAction = 'Run normalization before PCA and clustering.';
    actionLabel = 'Open Normalize';
    action = () => setActiveTab('normalize');
  } else if (hasProject && hasObject && !pipelineState?.pca) {
    nextAction = 'Run PCA to unlock clustering and UMAP.';
    actionLabel = 'Open PCA';
    action = () => setActiveTab('pca');
  } else if (hasProject && hasObject) {
    nextAction = 'Continue through clustering, UMAP, markers, or read project history.';
    actionLabel = 'Open Jobs & Artifacts';
    action = () => setActiveTab('history');
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-2xl font-black tracking-tight text-text">Pipeline Workbench</h3>
          <p className="mt-2 max-w-3xl text-sm text-textMuted">
            Current project, object, live-R attachment, and durable history status. Backend metadata is durable; live R state is private and transient.
          </p>
        </div>
        {action && (
          <button onClick={action} className="btn btn-primary text-sm font-bold">
            {actionLabel}
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="card p-4 bg-surface/70">
          <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-textMuted">
            <FolderTree size={14} /> Project
          </div>
          <div className="truncate text-lg font-bold text-text">{activeProject?.name || 'No backend project selected'}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {activeProject?.role && <StatusPill label={activeProject.role} tone="blue" />}
            {hasProject && <StatusPill label="Backend project" tone="green" />}
          </div>
        </div>

        <div className="card p-4 bg-surface/70">
          <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-textMuted">
            <Database size={14} /> Object
          </div>
          <div className="truncate text-lg font-bold text-text">{selectedObject?.name || 'No analysis object selected'}</div>
          <div className="mt-1 font-mono text-xs text-textMuted">{selectedObject?.id || `${activeProjectObjects.length} object(s) in project`}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {isDbBacked && <StatusPill label="DB-backed object" tone="green" />}
            {hasObject && <StatusPill label="Durable metadata" tone="blue" />}
          </div>
        </div>

        <div className="card p-4 bg-surface/70">
          <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-textMuted">
            <Lock size={14} /> Live R State
          </div>
          <div className="text-lg font-bold text-text">{liveAttached ? 'Attached this session' : 'Private transient state'}</div>
          <p className="mt-1 text-xs text-textMuted">Project membership does not grant live R object access.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <StatusPill label={liveStatus.label} tone={liveStatus.tone} />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-text">Next action</div>
            <p className="mt-1 text-sm text-text">{nextAction}</p>
          </div>
          {!action && actionLabel === 'Create Project' && (
            <span className="text-xs text-textMuted">Use the Projects section below.</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {sections.map(section => (
          <div key={section.label} className="rounded-lg border border-border bg-surface/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="font-bold text-text">{section.label}</div>
              <StatusPill label={section.status.label} tone={section.status.tone} />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-textMuted">{section.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SeuratPipelinePanel({
  activeProjectId,
  selectedObject,
  currentWs,
  updateActiveWorkspace,
  onSelectAnalysisObject,
  setActiveTab,
}) {
  const [datasets, setDatasets] = useState([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [datasetStatus, setDatasetStatus] = useState({ loading: false, uploading: false, error: null });
  const [job, setJob] = useState(null);
  const [loadJob, setLoadJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [jobStatus, setJobStatus] = useState({ launching: false, refreshing: false, error: null });
  const [loadStatus, setLoadStatus] = useState({ launching: false, refreshing: false, error: null });
  const [params, setParams] = useState(() => ({ ...DEFAULT_SEURAT_PIPELINE_PARAMS }));

  const activeDataset = datasets.find(dataset => dataset.id === selectedDatasetId) || null;
  const inputObjects = (currentWs.objects || [])
    .filter(object => object.projectId === activeProjectId && object.datasetId === selectedDatasetId);
  const selectedInputObject = selectedObject?.projectId === activeProjectId && selectedObject?.datasetId === selectedDatasetId
    ? selectedObject
    : null;
  const inputObject = selectedInputObject || inputObjects[0] || null;
  const resultObjectId = job?.resultAnalysisObjectId || artifacts.find(a => a.resultAnalysisObjectId)?.resultAnalysisObjectId || null;
  const resultObject = (currentWs.objects || []).find(object => object.id === resultObjectId) || null;
  const checkpointArtifact = artifacts.find(artifact => /checkpoint/i.test(artifact.artifactType || artifact.type || '')) || null;
  const summaryArtifact = artifacts.find(artifact => /summary|inspect/i.test(artifact.artifactType || artifact.type || '')) || null;
  const safeSummary = summaryArtifact?.metadata?.summary || summaryArtifact?.metadata?.objectSummary || job?.summary || null;
  const warnings = [
    ...(Array.isArray(job?.warnings) ? job.warnings : []),
    ...(Array.isArray(summaryArtifact?.metadata?.warnings) ? summaryArtifact.metadata.warnings : []),
  ];
  const checkpointAttached = loadJob?.status === 'completed' || resultObject?.liveState === 'attached';
  const loadCompleted = checkpointAttached;
  const loadJobErrorMessage = loadJob?.status === 'failed'
    ? (typeof loadJob.error === 'string' ? loadJob.error : loadJob.error?.message || 'Checkpoint load failed.')
    : null;
  const canContinueToDeg = Boolean(resultObjectId && checkpointAttached);

  const loadDatasets = React.useCallback(async () => {
    if (!activeProjectId) {
      setDatasets([]);
      setSelectedDatasetId('');
      return;
    }
    const api = window.electronAPI || {};
    if (!api.listDatasets) return;
    setDatasetStatus(prev => ({ ...prev, loading: true, error: null }));
    try {
      const rows = await api.listDatasets(activeProjectId, { fileType: 'tenx_h5' });
      const next = Array.isArray(rows) ? rows : [];
      setDatasets(next);
      setSelectedDatasetId(prev => (next.some(dataset => dataset.id === prev) ? prev : (next[0]?.id || '')));
    } catch (error) {
      setDatasetStatus(prev => ({ ...prev, error: parseApiError(error) }));
    } finally {
      setDatasetStatus(prev => ({ ...prev, loading: false }));
    }
  }, [activeProjectId]);

  React.useEffect(() => {
    loadDatasets();
  }, [loadDatasets]);

  const upsertWorkspaceObject = React.useCallback((backendObject, { select = false, liveResult = {} } = {}) => {
    if (!backendObject?.id || typeof updateActiveWorkspace !== 'function') return null;
    const mapped = backendObject.isBackendAnalysisObject ? backendObject : mapBackendAnalysisObject(backendObject, liveResult);
    const nextObjects = [mapped, ...(currentWs.objects || []).filter(object => object.id !== mapped.id)];
    const updates = { objects: nextObjects };
    if (select) {
      updates.selectedObjectIds = [mapped.id];
      updates.lastSelectedByProject = {
        ...(currentWs.lastSelectedByProject || {}),
        [activeProjectId]: mapped.id,
      };
    }
    updateActiveWorkspace(updates);
    return mapped;
  }, [activeProjectId, currentWs.lastSelectedByProject, currentWs.objects, updateActiveWorkspace]);

  const ensureDatasetInputObject = async () => {
    if (inputObject?.id) return inputObject;
    const api = window.electronAPI || {};
    if (!api.createProjectAnalysisObject) {
      throw new Error('Project analysis-object API is unavailable in this frontend runtime.');
    }
    const created = await api.createProjectAnalysisObject(activeProjectId, {
      datasetId: selectedDatasetId,
      objectType: 'matrix',
      displayName: rawDatasetObjectName(activeDataset),
      metadata: {
        source: 'dataset',
        sourceType: 'tenx_h5_dataset',
        datasetId: selectedDatasetId,
        fileType: activeDataset?.fileType || 'tenx_h5',
        supportedWorkflow: 'seurat.pipeline.v1',
        scientific_output: false,
      },
    });
    return upsertWorkspaceObject(created) || mapBackendAnalysisObject(created);
  };

  const refreshJob = React.useCallback(async (jobId = job?.id) => {
    if (!activeProjectId || !jobId) return;
    const api = window.electronAPI || {};
    if (!api.getProjectJob || !api.getProjectJobLogs || !api.listProjectJobArtifacts) return;
    setJobStatus(prev => ({ ...prev, refreshing: true, error: null }));
    try {
      const [nextJob, logResponse, nextArtifacts] = await Promise.all([
        api.getProjectJob(activeProjectId, jobId),
        api.getProjectJobLogs(activeProjectId, jobId),
        api.listProjectJobArtifacts(activeProjectId, jobId),
      ]);
      setJob(nextJob || null);
      setLogs(Array.isArray(logResponse?.logs) ? logResponse.logs : []);
      setArtifacts(Array.isArray(nextArtifacts) ? nextArtifacts : []);
      if (nextJob?.resultAnalysisObjectId && api.getProjectAnalysisObject) {
        try {
          const result = await api.getProjectAnalysisObject(activeProjectId, nextJob.resultAnalysisObjectId);
          upsertWorkspaceObject(result);
        } catch {
          // The job/artifact metadata remains usable even if the optional UI cache refresh fails.
        }
      }
    } catch (error) {
      setJobStatus(prev => ({ ...prev, error: parseApiError(error) }));
    } finally {
      setJobStatus(prev => ({ ...prev, refreshing: false }));
    }
  }, [activeProjectId, job?.id, upsertWorkspaceObject]);

  React.useEffect(() => {
    if (!job?.id || !['queued', 'running'].includes(job.status) || jobStatus.refreshing) return undefined;
    const timer = window.setTimeout(() => refreshJob(job.id), 2500);
    return () => window.clearTimeout(timer);
  }, [job?.id, job?.status, jobStatus.refreshing, refreshJob]);

  const uploadDataset = async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    if (!file) return;
    if (!isSupportedTenxH5File(file)) {
      setDatasetStatus({
        loading: false,
        uploading: false,
        error: 'Unsupported for this pipeline: upload a 10x Genomics filtered feature-barcode matrix HDF5 file with a .h5 extension.',
      });
      return;
    }
    const api = window.electronAPI || {};
    if (!api.uploadDataset) {
      setDatasetStatus(prev => ({ ...prev, error: 'Dataset upload API is unavailable in this frontend runtime.' }));
      return;
    }
    setDatasetStatus({ loading: false, uploading: true, error: null });
    try {
      const created = await api.uploadDataset(activeProjectId, file, {
        supportedWorkflow: 'seurat.pipeline.v1',
        supportedFormat: '10x Genomics filtered feature-barcode matrix HDF5 (.h5)',
      }, 'tenx_h5');
      setDatasets(prev => [created, ...prev.filter(dataset => dataset.id !== created.id)]);
      setSelectedDatasetId(created.id);
    } catch (error) {
      setDatasetStatus(prev => ({ ...prev, error: parseApiError(error) }));
    } finally {
      setDatasetStatus(prev => ({ ...prev, uploading: false }));
    }
  };

  const launchPipeline = async () => {
    if (!activeProjectId || !selectedDatasetId) return;
    const api = window.electronAPI || {};
    if (!api.createSeuratPipelineJob) {
      setJobStatus(prev => ({ ...prev, error: 'Seurat pipeline job wrapper is unavailable in this frontend runtime.' }));
      return;
    }
    setJobStatus({ launching: true, refreshing: false, error: null });
    setLogs([]);
    setArtifacts([]);
    try {
      const input = await ensureDatasetInputObject();
      const created = await api.createSeuratPipelineJob(activeProjectId, {
        datasetId: selectedDatasetId,
        analysisObjectId: input.id,
        params: scrubEmptyParams(params),
      });
      setJob(created);
      await refreshJob(created.id);
    } catch (error) {
      setJobStatus(prev => ({ ...prev, error: parseApiError(error) }));
    } finally {
      setJobStatus(prev => ({ ...prev, launching: false }));
    }
  };

  const refreshLoadJob = React.useCallback(async (jobId = loadJob?.id) => {
    if (!activeProjectId || !jobId) return;
    const api = window.electronAPI || {};
    if (!api.getProjectJob) return;
    setLoadStatus(prev => ({ ...prev, refreshing: true, error: null }));
    try {
      const nextJob = await api.getProjectJob(activeProjectId, jobId);
      setLoadJob(nextJob || null);
      if (nextJob?.status === 'completed' && resultObjectId) {
        const existing = (currentWs.objects || []).find(object => object.id === resultObjectId);
        if (existing) upsertWorkspaceObject({ ...existing, liveState: 'attached' });
      }
    } catch (error) {
      setLoadStatus(prev => ({ ...prev, error: parseApiError(error) }));
    } finally {
      setLoadStatus(prev => ({ ...prev, refreshing: false }));
    }
  }, [activeProjectId, currentWs.objects, loadJob?.id, resultObjectId, upsertWorkspaceObject]);

  React.useEffect(() => {
    if (!loadJob?.id || !['queued', 'running'].includes(loadJob.status) || loadStatus.refreshing) return undefined;
    const timer = window.setTimeout(() => refreshLoadJob(loadJob.id), 2500);
    return () => window.clearTimeout(timer);
  }, [loadJob?.id, loadJob?.status, loadStatus.refreshing, refreshLoadJob]);

  const loadCheckpoint = async () => {
    if (!activeProjectId || !resultObjectId) return;
    const api = window.electronAPI || {};
    if (!api.createProjectJob) {
      setLoadStatus(prev => ({ ...prev, error: 'Project job API is unavailable in this frontend runtime.' }));
      return;
    }
    setLoadStatus({ launching: true, refreshing: false, error: null });
    try {
      const created = await api.createProjectJob(activeProjectId, {
        jobType: 'checkpoint.load.v1',
        analysisObjectId: resultObjectId,
        parameters: {},
      });
      setLoadJob(created);
      await refreshLoadJob(created.id);
    } catch (error) {
      setLoadStatus(prev => ({ ...prev, error: parseApiError(error) }));
    } finally {
      setLoadStatus(prev => ({ ...prev, launching: false }));
    }
  };

  const continueToDeg = () => {
    if (!canContinueToDeg) return;
    onSelectAnalysisObject?.(activeProjectId, resultObjectId);
    setActiveTab('deg');
  };

  const canLaunch = !!activeProjectId && !!selectedDatasetId && !jobStatus.launching;

  return (
    <section className="rounded-lg border border-border bg-surface/70 p-5" data-testid="seurat-pipeline-panel">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-black tracking-tight text-text">Supported Seurat Pipeline</h3>
            <StatusPill label="seurat.pipeline.v1" tone="blue" />
            <StatusPill label="10x .h5 only" tone="green" />
          </div>
          <p className="max-w-3xl text-sm text-textMuted">
            This path supports 10x Genomics filtered feature-barcode matrix HDF5 files (`.h5`) uploaded as `tenx_h5`. Other formats are not labeled as supported here.
          </p>
        </div>
        <button onClick={loadDatasets} disabled={!activeProjectId || datasetStatus.loading} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
          {datasetStatus.loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Refresh datasets
        </button>
      </div>

      {!activeProjectId ? (
        <div className="rounded border border-dashed border-border p-5 text-sm text-textMuted">
          Select or create a backend project before uploading datasets or launching the durable Seurat pipeline.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div className="space-y-4">
            <div className="rounded border border-border bg-background/40 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="font-bold text-text">Dataset upload / selection</h4>
                  <p className="mt-1 text-xs text-textMuted">Supported format: 10x Genomics filtered feature-barcode matrix HDF5 (`.h5`).</p>
                </div>
                <label className="btn btn-primary inline-flex cursor-pointer items-center gap-2 text-sm">
                  <FileUp size={16} />
                  {datasetStatus.uploading ? 'Uploading...' : 'Upload 10x .h5'}
                  <input
                    data-testid="seurat-pipeline-upload"
                    type="file"
                    accept=".h5"
                    className="sr-only"
                    disabled={datasetStatus.uploading}
                    onChange={uploadDataset}
                  />
                </label>
              </div>
              {datasetStatus.error && (
                <div className="mb-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {safeMessage(datasetStatus.error)}
                </div>
              )}
              {datasets.length === 0 ? (
                <div className="rounded border border-dashed border-border p-4 text-sm text-textMuted">
                  No `tenx_h5` datasets are recorded for this project yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {datasets.map(dataset => (
                    <label key={dataset.id} className="flex cursor-pointer items-start gap-3 rounded border border-border bg-surface p-3 hover:border-primary/40">
                      <input
                        type="radio"
                        name="seurat-pipeline-dataset"
                        checked={selectedDatasetId === dataset.id}
                        onChange={() => setSelectedDatasetId(dataset.id)}
                        className="mt-1"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold text-text">{dataset.originalFilename || dataset.name || dataset.id}</span>
                        <span className="mt-1 block text-xs text-textMuted">
                          {dataset.id} / {dataset.fileType || 'tenx_h5'} / {dataset.uploadStatus || 'registered'} / {dataset.validationStatus || 'pending validation'}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded border border-border bg-background/40 p-4">
              <h4 className="mb-3 font-bold text-text">Launch parameters</h4>
              <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2 xl:grid-cols-3">
                <label className="rounded border border-border bg-surface p-3">
                  <span className="block font-bold text-textMuted">Normalization</span>
                  <select
                    className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-text"
                    value={params.normalizationMethod}
                    onChange={event => setParams(prev => ({ ...prev, normalizationMethod: event.target.value }))}
                  >
                    <option value="LogNormalize">LogNormalize</option>
                    <option value="SCTransform">SCTransform</option>
                  </select>
                </label>
                <label className="rounded border border-border bg-surface p-3">
                  <span className="block font-bold text-textMuted">UMAP components</span>
                  <select
                    className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-text"
                    value={params.umapComponents}
                    onChange={event => setParams(prev => ({ ...prev, umapComponents: Number(event.target.value) }))}
                  >
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 rounded border border-border bg-surface p-3 font-bold text-textMuted">
                  <input
                    type="checkbox"
                    checked={params.applyQcFilter}
                    onChange={event => setParams(prev => ({ ...prev, applyQcFilter: event.target.checked }))}
                  />
                  Apply QC filter
                </label>
                {SEURAT_NUMERIC_CONTROLS.map(control => (
                  <label key={control.key} className="rounded border border-border bg-surface p-3">
                    <span className="block font-bold text-textMuted">{control.label}</span>
                    <input
                      type="number"
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-text"
                      value={params[control.key]}
                      onChange={event => setParams(prev => ({
                        ...prev,
                        [control.key]: event.target.value === '' ? '' : Number(event.target.value),
                      }))}
                    />
                  </label>
                ))}
                <label className="rounded border border-border bg-surface p-3">
                  <span className="block font-bold text-textMuted">Seed (optional)</span>
                  <input
                    type="number"
                    min={0}
                    max={2147483647}
                    step={1}
                    className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-text"
                    value={params.seed ?? ''}
                    onChange={event => setParams(prev => ({
                      ...prev,
                      seed: event.target.value === '' ? null : Number(event.target.value),
                    }))}
                  />
                </label>
              </div>
              <div className="mt-3 rounded border border-border bg-surface px-3 py-2 text-xs text-textMuted">
                Input object: <span className="font-mono text-text">{inputObject?.id || 'will be created from selected dataset'}</span>
              </div>
              <button
                onClick={launchPipeline}
                disabled={!canLaunch}
                className="btn btn-primary mt-4 inline-flex items-center gap-2 text-sm disabled:opacity-50"
              >
                {jobStatus.launching ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                Launch durable Seurat pipeline
              </button>
              {jobStatus.error && (
                <div className="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {safeMessage(jobStatus.error)}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded border border-border bg-background/40 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="font-bold text-text">Job status</h4>
                {job?.id && (
                  <button onClick={() => refreshJob(job.id)} disabled={jobStatus.refreshing} className="btn btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs">
                    {jobStatus.refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    Refresh job
                  </button>
                )}
              </div>
              {!job ? (
                <p className="text-sm text-textMuted">No `seurat.pipeline.v1` job has been launched from this panel yet.</p>
              ) : (
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-bold text-text">{job.id}</span>
                    <StatusPill label={job.status || 'unknown'} tone={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'amber' : 'blue'} />
                  </div>
                  <div className="text-xs text-textMuted">Created: {formatDate(job.createdAt)}</div>
                  <div className="grid grid-cols-1 gap-2 text-xs">
                    <div>Dataset: <span className="font-mono text-text">{job.datasetId || activeDataset?.id || 'None'}</span></div>
                    <div>Input object: <span className="font-mono text-text">{job.analysisObjectId || selectedObject?.id || 'None'}</span></div>
                    <div>Result object: <span className="font-mono text-text">{resultObjectId || 'Pending worker completion'}</span></div>
                  </div>
                  {job.error?.message && (
                    <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-danger">
                      {safeMessage(job.error.message)}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded border border-border bg-background/40 p-4">
              <h4 className="mb-3 flex items-center gap-2 font-bold text-text"><Archive size={16} /> Result continuation</h4>
              {safeSummary ? (
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {Object.entries(safeSummary).slice(0, 6).map(([key, value]) => (
                    <div key={key} className="rounded border border-border bg-surface p-2">
                      <div className="font-bold uppercase tracking-wide text-textMuted">{key}</div>
                      <div className="mt-1 truncate text-text">{Array.isArray(value) ? value.join(', ') : String(value)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-textMuted">Object inspection summary will appear here if the worker returns public summary metadata.</p>
              )}
              <div className="mt-3 space-y-2 text-xs text-textMuted">
                <p>Result analysis object: <span className="font-mono text-text">{resultObjectId || 'not available yet'}</span></p>
                <p>Checkpoint: <span className="font-mono text-text">{checkpointArtifact?.id || 'not available yet'}</span></p>
                {resultObjectId && resultObject?.liveState !== 'attached' && (
                  <p>Live R workflows require checkpoint reattach into your private R state before downstream jobs can use the result object.</p>
                )}
                {loadJob?.id && (
                  <p>Checkpoint load job: <span className="font-mono text-text">{loadJob.id}</span> / {loadJob.status || 'queued'}</p>
                )}
              </div>
              {(loadStatus.error || loadJobErrorMessage) && (
                <div className="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
                  {safeMessage(loadStatus.error || loadJobErrorMessage)}
                </div>
              )}
              {warnings.length > 0 && (
                <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                  {warnings.map((warning, index) => <div key={`${warning}-${index}`}>{safeMessage(warning)}</div>)}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={loadCheckpoint}
                  disabled={!resultObjectId || loadStatus.launching || loadStatus.refreshing || loadCompleted}
                  className="btn btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  {loadStatus.launching || loadStatus.refreshing ? <Loader2 size={16} className="animate-spin" /> : <Archive size={16} />}
                  {loadCompleted ? 'Checkpoint attached' : 'Load checkpoint'}
                </button>
                {loadJob?.id && loadJob.status !== 'completed' && (
                  <button
                    onClick={() => refreshLoadJob(loadJob.id)}
                    disabled={loadStatus.refreshing}
                    className="btn btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                  >
                    {loadStatus.refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                    Refresh load
                  </button>
                )}
                <button
                  onClick={continueToDeg}
                  disabled={!canContinueToDeg}
                  className="btn btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  Continue to durable DEG
                </button>
                <button onClick={() => setActiveTab('history')} className="btn btn-secondary text-sm">
                  Open Jobs & Artifacts
                </button>
              </div>
            </div>

            <div className="rounded border border-border bg-background/40 p-4">
              <h4 className="mb-3 font-bold text-text">Logs</h4>
              {logs.length === 0 ? (
                <p className="text-sm text-textMuted">Worker logs will appear after the job is claimed.</p>
              ) : (
                <div className="max-h-44 space-y-2 overflow-y-auto custom-scrollbar">
                  {logs.map((entry, index) => (
                    <div key={`${entry?.ts || index}-${index}`} className="rounded border border-border bg-surface p-2 text-xs">
                      <div className="font-mono text-textMuted">{formatDate(entry?.ts)} / {entry?.level || 'info'}</div>
                      <div className="mt-1 text-textMuted">{safeMessage(entry?.message)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default function Workspace({
  callApi: _callApi,
  datasetInfo: _datasetInfo,
  setDataVersion,
  openProvenance: _openProvenance,
  currentWs,
  updateActiveWorkspace,
  workspaces: _workspaces,
  setWorkspaces: _setWorkspaces,
  activeWsIndex: _activeWsIndex,
  setActiveWsIndex: _setActiveWsIndex,
  resetPipelineAfterSubset: _resetPipelineAfterSubset,
  setActiveTab,
  userEmail: _userEmail,
  backendModelStatus,
  onSelectProject,
  onCreateProject,
  onCreateAnalysisObjectForLoad,
  onAnalysisObjectLoaded,
  onSelectAnalysisObject,
  pipelineState,
  sessionReady,
  rSessionId,
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

  const activeSelectedObjects = selectedObjects.filter(obj => !activeProjectId || obj.projectId === activeProjectId);
  const activeCount = activeSelectedObjects.length;
  const displayObject = activeSelectedObjects[0] || null;
  const selectedObject = displayObject;
  const activeProject = currentWs.projects?.find(project => project.id === activeProjectId) || null;

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
          <WorkbenchOverview
            activeProject={activeProject}
            selectedObject={selectedObject}
            activeProjectObjects={activeProjectObjects}
            pipelineState={pipelineState}
            sessionReady={sessionReady}
            rSessionId={rSessionId}
            setActiveTab={setActiveTab}
            setShowLoadModal={setShowLoadModal}
          />

          <SeuratPipelinePanel
            activeProjectId={activeProjectId}
            selectedObject={selectedObject}
            currentWs={currentWs}
            updateActiveWorkspace={updateActiveWorkspace}
            onSelectAnalysisObject={onSelectAnalysisObject}
            setActiveTab={setActiveTab}
          />

          {/* Stats Block */}
          {displayObject && (
            <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
              <div className="flex items-center gap-2 mb-4 px-2 py-1 -ml-2">
                <Info size={16} className="text-primary group-hover/info:text-white transition-colors" />
                <h3 className="text-[10px] font-black text-slate-400 group-hover/info:text-slate-300 uppercase tracking-widest transition-colors">
                  {activeCount > 1
                    ? `Multi-Select Mode (${activeCount} Selected)`
                    : `Data Info: ${displayObject.name}`}
                </h3>
              </div>
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
                    <div className="text-[10px] font-bold text-text uppercase tracking-widest text-center">{stat.label}</div>
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
                      {proj.role && <span className="text-[9px] font-semibold uppercase px-1.5 py-px rounded bg-blue-600 text-on-accent">{proj.role}</span>}
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
                <FileUp size={16} /> Load Object
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
                    <FileUp size={15} /> Load Object
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
                        {obj.isBackendAnalysisObject && (
                          <>
                            <div className="w-1 h-1 rounded-full bg-slate-700"></div>
                            <span className="text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide text-text bg-primary/10 border-primary/20">
                              DB-backed
                            </span>
                          </>
                        )}
                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide ${
                          obj.liveState === 'attached'
                            ? 'text-success bg-success/10 border-success/30'
                            : 'text-amber-400 bg-amber-500/10 border-amber-500/30'
                        }`}>
                          {obj.liveState === 'attached' ? 'Live R attached' : 'Live R not attached'}
                        </span>
                      </div>
                    </div>

                    {/* Right side: active badge + menu */}
                    <div className="flex items-center gap-3 flex-shrink-0 relative">

                      {isSelected && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-primary/10 border border-primary/20 rounded-full text-[9px] font-black text-text uppercase shadow-sm">
                          <CheckCircle size={10} /> Selected
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
