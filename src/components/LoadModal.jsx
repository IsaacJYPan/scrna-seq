import React, { useRef, useState } from 'react';
import {
  Database,
  Zap,
  Info,
  FolderOpen,
  HardDrive,
  FlaskConical,
  X,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Search,
  Trash2,
  FolderTree,
  Plus,
  Loader2,
  Archive,
} from 'lucide-react';
import { publicErrorMessage } from '../publicError';

export function isLiveLoadResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const cells = Number(result.cells ?? result.n_cells);
  const features = Number(result.features ?? result.genes ?? result.n_features);
  return Number.isFinite(cells) && cells > 0 && Number.isFinite(features) && features > 0;
}

export default function LoadModal({
  onClose,
  onLoaded,
  loadingId,
  setLoadingId,
  activeProjectId,
  onCreateAnalysisObjectForLoad,
  onLoadFailed,
  legacyLocalImportsEnabled = false,
  onOpenPipelineManager,
}) {
  const [showFilters, setShowFilters] = useState(false);
  const [minCells, setMinCells] = useState(3);
  const [minFeatures, setMinFeatures] = useState(200);
  const [error, setError] = useState(null);

  const isLoading = !!loadingId;
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const requestClose = () => {
    if (!isLoading) onClose();
  };

  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isLoading) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isLoading]);

  React.useEffect(() => {
    previousFocusRef.current = document.activeElement;
    dialogRef.current?.querySelector('button, input, select, textarea')?.focus();
    return () => previousFocusRef.current?.focus?.();
  }, []);

  const trapDialogFocus = (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

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
    if (!activeProjectId) throw new Error('Select or create a project before loading data.');
    let analysisObject = null;
    try {
      analysisObject = await onCreateAnalysisObjectForLoad({
        projectId: activeProjectId,
        displayName,
        sourceType,
        metadata,
      });
      const headers = { ...(options.headers || {}), 'X-Object-ID': analysisObject.id };
      const data = await window.electronAPI.apiRequest(endpoint, { ...options, headers });
      if (data?.error) throw new Error(data.error);
      if (!isLiveLoadResult(data?.result)) {
        throw new Error('The R runtime returned an incomplete load summary.');
      }
      onLoaded(data, displayName, analysisObject);
      return analysisObject;
    } catch (error) {
      if (analysisObject && error && typeof error === 'object') error.analysisObject = analysisObject;
      throw error;
    }
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
      if (err?.analysisObject) onLoadFailed?.(err.analysisObject);
      setError(publicErrorMessage(err, 'The PBMC demo could not be opened. Please try again.'));
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
      setError(publicErrorMessage(err));
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
      setError(publicErrorMessage(err));
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
      setError(publicErrorMessage(err));
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
      setError(publicErrorMessage(err));
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
      id: 'pipeline-manager',
      icon: <Archive size={22} className="text-blue-400" />,
      title: '10X H5 analysis workflow',
      desc: 'Upload a 10X filtered feature-barcode .h5 file and run the approved Seurat workflow.',
      tag: 'Production',
      tagColor: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
      action: onOpenPipelineManager,
    },
    {
      id: '10x',
      legacy: true,
      icon: <FolderOpen size={22} className="text-emerald-400" />,
      title: 'Local 10X Directory',
      desc: 'Select a folder containing barcodes.tsv, features.tsv (or genes.tsv), and matrix.mtx.',
      tag: '10X Format',
      tagColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
      action: load10X,
    },
    {
      id: 'multi10x',
      legacy: true,
      icon: <FolderTree size={22} className="text-cyan-400" />,
      title: 'Multiple 10X Directories',
      desc: 'Load several Cell Ranger output folders and merge them into one object. Sample names become a metadata column.',
      tag: 'Multi-Sample',
      tagColor: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
      action: openMulti10X,
    },
    {
      id: 'scan-root',
      legacy: true,
      icon: <Search size={22} className="text-violet-400" />,
      title: 'Scan Root Folder for Samples',
      desc: 'Select a parent folder and automatically discover all nested 10X data directories. Perfect for standard Cell Ranger project layouts.',
      tag: 'Auto-Detect',
      tagColor: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
      action: scanRoot10X,
    },
    {
      id: 'rds',
      legacy: true,
      icon: <HardDrive size={22} className="text-violet-400" />,
      title: 'Dataset file (.rds)',
      desc: 'Load a trusted local dataset file. This option is available only in approved local environments.',
      tag: '.rds',
      tagColor: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
      action: loadRds,
    },
    {
      id: 'h5',
      legacy: true,
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
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onClick={requestClose} aria-hidden="true" />
        <div className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none">
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="multi-sample-loader-title" onKeyDown={trapDialogFocus} className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl pointer-events-auto flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-7 pt-7 pb-5 border-b border-slate-800 flex-shrink-0">
              <div>
                <h3 id="multi-sample-loader-title" className="text-lg font-semibold text-white tracking-tight flex items-center gap-2">
                  Configure Multi-Sample Merge
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {multiPaths.length} folder{multiPaths.length !== 1 ? 's' : ''} selected — edit sample names and metadata column below.
                </p>
              </div>
              <button onClick={requestClose} disabled={isLoading} aria-label="Close dataset loader" className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition">
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
                <label className="text-xs font-semibold text-slate-400">Global Settings</label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={scanRoot10X}
                    title="Pick a root folder and auto-discover all nested 10X data directories"
                    className="flex items-center gap-1.5 px-2 py-1 rounded bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-semibold hover:bg-violet-500/20 transition-colors"
                  >
                    <Search size={12} /> Scan Root Folder
                  </button>
                  <button
                    onClick={addMore10X}
                    className="flex items-center gap-1.5 px-2 py-1 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-semibold hover:bg-cyan-500/20 transition-colors"
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
                className="grid gap-x-4 gap-y-2 items-center text-xs font-medium text-slate-400 mb-2 px-1 pb-2 border-b border-slate-700/50"
                style={{ gridTemplateColumns: `auto minmax(200px, 2fr) ${'minmax(120px, 1fr) '.repeat(extraMetaCols.length)}auto` }}
              >
                <span className="w-6 text-center">#</span>
                <span>Sample name (editable)</span>
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
                  <span className="text-xs font-semibold text-cyan-400 w-6 text-center flex-shrink-0">{i + 1}</span>
                  <div className="min-w-0">
                    <input
                      type="text"
                      value={sampleNames[i] || ''}
                      onChange={e => setSampleNames(prev => prev.map((n, j) => j === i ? e.target.value : n))}
                      className="w-full bg-slate-900 border border-slate-700 text-sm text-white px-3 py-1.5 rounded-lg focus:outline-none focus:border-cyan-500 font-bold mb-1"
                      placeholder={`Sample ${i + 1}`}
                    />
                    <p className="text-xs text-slate-400 truncate pl-1">Selected local folder</p>
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
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40" onClick={requestClose} aria-hidden="true" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 pointer-events-none">
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="dataset-loader-title" onKeyDown={trapDialogFocus} className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-xl pointer-events-auto max-h-[calc(100dvh-2rem)] sm:max-h-[90vh] overflow-y-auto custom-scrollbar">
          {/* Header */}
          <div className="flex items-center justify-between px-7 pt-7 pb-5 border-b border-slate-800">
            <div>
              <h3 id="dataset-loader-title" className="text-lg font-semibold text-white tracking-tight">Load dataset</h3>
              <p className="text-xs text-slate-400 mt-0.5">Choose a source to create a dataset and open a private analysis workspace.</p>
            </div>
            <button onClick={requestClose} disabled={isLoading} aria-label="Close demo loader" className="p-2 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition">
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
              className="flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-white transition"
            >
              <SlidersHorizontal size={11} />
              Filter Parameters
              {showFilters ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
            {showFilters && (
              <div className="flex flex-col sm:flex-row gap-3 mt-3 mb-1">
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
            {options.filter(opt => legacyLocalImportsEnabled || !opt.legacy).map(opt => {
              const active = loadingId === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={opt.action}
                  disabled={isLoading}
                className={`w-full flex items-center gap-4 p-4 rounded-xl border text-left transition-colors group ${
                    active
                      ? 'bg-primary/10 border-primary'
                      : 'bg-slate-800/60 border-slate-700/50 hover:border-slate-600 hover:bg-slate-800'
                  } ${isLoading && !active ? 'opacity-50' : ''}`}
                >
                  <div className="w-10 h-10 rounded-lg bg-background border border-border flex items-center justify-center flex-shrink-0 transition-colors">
                    {active
                      ? <Loader2 size={20} aria-hidden="true" className="text-primary animate-spin" />
                      : opt.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-0.5">
                      <span className="font-bold text-text text-sm">{opt.title}</span>
                      <span role={active ? 'status' : undefined} className={`text-xs font-semibold px-1.5 py-0.5 rounded border ${opt.tagColor}`}>
                        {active ? <>Loading…<span className="sr-only"> {opt.title}</span></> : opt.tag}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 leading-snug">{opt.desc}</p>
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
