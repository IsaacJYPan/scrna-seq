import WorkbenchOverview from '../components/WorkbenchOverview';
import DetailsPopover from '../components/DetailsPopover';
import SeuratPipelineSettings from '../components/SeuratPipelineSettings';
import React, { useRef, useState } from 'react';
import {
  Database, FileUp, Zap, CheckCircle, Info, Globe, Lock,
  LayoutGrid, List, Edit2, FolderOpen, HardDrive, FlaskConical,
  X, SlidersHorizontal, ChevronDown, ChevronUp, Search, Scissors, Trash2,
  FolderTree, Plus, MoreVertical, Loader2, RefreshCw, Archive
} from 'lucide-react';
import { mapBackendAnalysisObject } from '../backendWorkspaceModel';
import { publicErrorMessage } from '../publicError';

function isLiveLoadResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const cells = Number(result.cells ?? result.n_cells);
  const features = Number(result.features ?? result.genes ?? result.n_features);
  return Number.isFinite(cells) && cells > 0 && Number.isFinite(features) && features > 0;
}

function boundedDemoSetting(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function datasetResearchStatus(dataset) {
  if (dataset?.uploadStatus === 'failed' || dataset?.validationStatus === 'invalid') return 'Needs attention';
  if (dataset?.uploadStatus === 'uploaded' && dataset?.validationStatus === 'valid') return 'Ready for analysis';
  if (dataset?.uploadStatus === 'uploaded') return 'Checking data';
  return 'Preparing data';
}

const CLASSIC_VISIUM_REQUIRED_FILES = [
  'filtered_feature_bc_matrix.h5',
  'spatial/tissue_positions.csv or spatial/tissue_positions_list.csv',
  'spatial/scalefactors_json.json',
  'spatial/tissue_lowres_image.png',
];

const MAX_MULTI_SAMPLE_INPUTS = 48;
const SAFE_MULTI_SAMPLE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;
const PROJECT_WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);

function isValidMultiSampleLabel(value, { optional = false } = {}) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return optional;
  return normalized.length <= 80 && SAFE_MULTI_SAMPLE_LABEL_PATTERN.test(normalized);
}

function datasetValidationMessages(dataset) {
  const value = dataset?.validationErrors;
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').slice(0, 4);
  if (value && typeof value === 'object' && Array.isArray(value.errors)) {
    return value.errors.filter((item) => typeof item === 'string').slice(0, 4);
  }
  return [];
}

function defaultSampleName(dataset) {
  const raw = String(dataset?.originalFilename || dataset?.name || 'sample')
    .replace(/\.h5$/i, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .trim()
    .slice(0, 80);
  return /^[A-Za-z0-9]/.test(raw) ? raw : `sample_${raw}`.slice(0, 80);
}

// Removed API constant
// ── Load Object Modal ──────────────────────────────────────────────

function LoadModal({
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
      desc: 'Upload a 10X filtered feature-barcode .h5 dataset and run the approved Seurat workflow.',
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
      title: 'Saved analysis file (.rds)',
      desc: 'Load a trusted local saved analysis file. This option is available only in approved local environments.',
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
                <h3 id="multi-sample-loader-title" className="text-lg font-black text-white tracking-tight flex items-center gap-2">
                  <FolderTree size={18} className="text-cyan-400" />
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
                  <span className="text-[10px] font-black text-cyan-400 w-6 text-center flex-shrink-0">{i + 1}</span>
                  <div className="min-w-0">
                    <input
                      type="text"
                      value={sampleNames[i] || ''}
                      onChange={e => setSampleNames(prev => prev.map((n, j) => j === i ? e.target.value : n))}
                      className="w-full bg-slate-900 border border-slate-700 text-sm text-white px-3 py-1.5 rounded-lg focus:outline-none focus:border-cyan-500 font-bold mb-1"
                      placeholder={`Sample ${i + 1}`}
                    />
                    <p className="text-[10px] text-slate-400 truncate pl-1">Selected local folder</p>
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
              <h3 id="dataset-loader-title" className="text-lg font-black text-white tracking-tight">Load saved analysis</h3>
              <p className="text-xs text-slate-400 mt-0.5">Choose a source to create a saved analysis and open a private analysis workspace.</p>
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
              className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white transition"
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
                      <span role={active ? 'status' : undefined} className={`text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide ${opt.tagColor}`}>
                        {active ? <>Loading…<span className="sr-only"> {opt.title}</span></> : opt.tag}
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

function displayRunStatus(status) {
  return {
    queued: 'Waiting for compute',
    running: 'Running',
    completed: 'Complete',
    failed: 'Needs attention',
    canceled: 'Canceled',
  }[status] || 'Unknown';
}

function researcherRunNote(entry) {
  if (entry?.level === 'error') return 'This analysis needs attention.';
  const message = String(entry?.message || '');
  if (/completed|finished|published/i.test(message)) return 'Analysis finished.';
  if (/claim|start|running|comput/i.test(message)) return 'Compute started.';
  if (entry?.level === 'warn') return 'Analysis warning recorded.';
  return 'Analysis update recorded.';
}

function isSupportedTenxH5File(file) {
  return !!file?.name && /\.h5$/i.test(file.name);
}

function isSupportedClassicVisiumZipFile(file) {
  return !!file?.name && /\.zip$/i.test(file.name);
}

function parseApiError(error) {
  const raw = error?.message || String(error || 'Request failed.');
  try {
    const parsed = JSON.parse(raw);
    return publicErrorMessage(parsed?.error || raw);
  } catch {
    return publicErrorMessage(raw);
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
    if (value !== '') out[key] = value !== null && (key === 'seed' || key === 'umapComponents' || SEURAT_NUMERIC_CONTROLS.some(control => control.key === key))
      ? Number(value) : value;
  }
  return out;
}

export function SeuratPipelinePanel({
  activeProjectId,
  selectedObject,
  currentWs,
  updateActiveWorkspace,
  onSelectAnalysisObject,
  setActiveTab,
  datasetUploadsEnabled = true,
  canWriteProject = false,
}) {
  const [analysisApproach, setAnalysisApproach] = useState('automatic');
  const approachId = React.useId();
  const [workflowMode, setWorkflowMode] = useState('scrna');
  const [datasets, setDatasets] = useState([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [multiSampleRows, setMultiSampleRows] = useState([]);
  const [datasetStatus, setDatasetStatus] = useState({ loading: false, uploading: false, error: null });
  const [job, setJob] = useState(null);
  const [loadJob, setLoadJob] = useState(null);
  const [logs, setLogs] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [jobStatus, setJobStatus] = useState({ launching: false, refreshing: false, error: null });
  const [loadStatus, setLoadStatus] = useState({ launching: false, refreshing: false, error: null });
  const [params, setParams] = useState(() => ({ ...DEFAULT_SEURAT_PIPELINE_PARAMS }));

  const spatialMode = workflowMode === 'spatial';
  const multiSampleMode = workflowMode === 'multisample';
  const workflow = spatialMode ? {
    datasetFileType: 'visium_zip',
    jobType: 'spatial.seurat.v1',
    sourceType: 'classic_visium_dataset',
    formatLabel: 'classic 10x Visium Space Ranger ZIP bundle',
    shortFormatLabel: 'Visium ZIP',
  } : multiSampleMode ? {
    datasetFileType: 'tenx_h5',
    jobType: 'seurat.multisample.v1',
    sourceType: 'tenx_h5_multisample_dataset',
    formatLabel: 'two or more 10x Genomics filtered feature-barcode matrix HDF5 files (.h5)',
    shortFormatLabel: 'Multi-sample 10x HDF5',
  } : {
    datasetFileType: 'tenx_h5',
    jobType: 'seurat.pipeline.v1',
    sourceType: 'tenx_h5_dataset',
    formatLabel: '10x Genomics filtered feature-barcode matrix HDF5 (.h5)',
    shortFormatLabel: '10x HDF5',
  };

  const activeDataset = datasets.find(dataset => dataset.id === selectedDatasetId) || null;
  const selectedMultiDatasets = multiSampleRows.map(row => datasets.find(dataset => dataset.id === row.datasetId));
  const activeDatasetReady = multiSampleMode
    ? selectedMultiDatasets.length >= 2 && selectedMultiDatasets.every(dataset => (
      dataset?.uploadStatus === 'uploaded' && dataset?.validationStatus === 'valid'
    ))
    : activeDataset?.uploadStatus === 'uploaded' && activeDataset?.validationStatus === 'valid';
  const multiSampleConditionCounts = multiSampleRows.reduce((counts, row) => {
    const condition = String(row.conditionName || '').trim().toLocaleLowerCase('en-US');
    if (condition) counts.set(condition, (counts.get(condition) || 0) + 1);
    return counts;
  }, new Map());
  const multiSampleDesignValid = multiSampleRows.length >= 2
    && multiSampleRows.length <= MAX_MULTI_SAMPLE_INPUTS
    && multiSampleRows.every(row => (
      isValidMultiSampleLabel(row.sampleName)
      && isValidMultiSampleLabel(row.conditionName)
      && isValidMultiSampleLabel(row.donorCode, { optional: true })
      && isValidMultiSampleLabel(row.batch, { optional: true })
    ))
    && new Set(multiSampleRows.map(row => String(row.sampleName || '').trim().toLocaleLowerCase('en-US'))).size === multiSampleRows.length
    && multiSampleConditionCounts.size >= 2;
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
  const checkpointAttached = (loadJob?.status === 'completed' && loadJob.analysisObjectId === resultObjectId) || resultObject?.liveState === 'attached';
  const loadCompleted = checkpointAttached;
  const loadJobErrorMessage = loadJob?.status === 'failed'
    ? publicErrorMessage(loadJob.error, 'Opening this saved version needs attention.')
    : null;
  const canContinueToDeg = Boolean(resultObjectId && checkpointAttached);
  const guidedReady = selectedObject?.projectId === activeProjectId && selectedObject?.liveState === 'attached';
  const hasRunActivity = Boolean(job || loadJob || jobStatus.launching || jobStatus.error || loadStatus.error);
  const changeApproachWithKeys = event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'automatic' : event.key === 'End' ? 'guided' : analysisApproach === 'automatic' ? 'guided' : 'automatic';
    setAnalysisApproach(next);
    document.getElementById(`${approachId}-${next}-tab`)?.focus();
  };
  const openGuidedStep = route => {
    if (!guidedReady) return;
    onSelectAnalysisObject?.(activeProjectId, selectedObject.id);
    setActiveTab?.(route);
  };
  const inspectPipelineResult = () => {
    if (!canContinueToDeg) return;
    onSelectAnalysisObject?.(activeProjectId, resultObjectId);
    setActiveTab?.('qc');
  };

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
      const rows = await api.listDatasets(activeProjectId, { fileType: workflow.datasetFileType });
      const next = Array.isArray(rows) ? rows : [];
      setDatasets(next);
      if (multiSampleMode) {
        setMultiSampleRows(prev => prev.filter(row => next.some(dataset => dataset.id === row.datasetId)));
      } else {
        setSelectedDatasetId(prev => (next.some(dataset => dataset.id === prev) ? prev : (next[0]?.id || '')));
      }
    } catch (error) {
      setDatasetStatus(prev => ({ ...prev, error: parseApiError(error) }));
    } finally {
      setDatasetStatus(prev => ({ ...prev, loading: false }));
    }
  }, [activeProjectId, multiSampleMode, workflow.datasetFileType]);

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
      throw new Error('Creating a saved analysis is temporarily unavailable.');
    }
    const created = await api.createProjectAnalysisObject(activeProjectId, {
      datasetId: selectedDatasetId,
      objectType: 'matrix',
      displayName: rawDatasetObjectName(activeDataset),
      metadata: {
        source: 'dataset',
        sourceType: workflow.sourceType,
        datasetId: selectedDatasetId,
        fileType: activeDataset?.fileType || workflow.datasetFileType,
        supportedWorkflow: workflow.jobType,
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
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!canWriteProject) {
      setDatasetStatus(prev => ({ ...prev, error: 'Your project role is read-only and cannot upload datasets.' }));
      return;
    }
    if (files.length === 0) return;
    const selectedFiles = multiSampleMode ? files : files.slice(0, 1);
    if (multiSampleMode && multiSampleRows.length + selectedFiles.length > MAX_MULTI_SAMPLE_INPUTS) {
      setDatasetStatus({
        loading: false,
        uploading: false,
        error: `A multi-condition run supports at most ${MAX_MULTI_SAMPLE_INPUTS} sample datasets.`,
      });
      return;
    }
    const unsupported = selectedFiles.some(file => (
      spatialMode ? !isSupportedClassicVisiumZipFile(file) : !isSupportedTenxH5File(file)
    ));
    if (unsupported) {
      setDatasetStatus({
        loading: false,
        uploading: false,
        error: spatialMode
          ? 'Unsupported for this pipeline: upload one classic 10x Visium Space Ranger output bundle as a .zip file.'
          : 'Unsupported for this pipeline: upload a 10x Genomics filtered feature-barcode matrix HDF5 file with a .h5 extension.',
      });
      return;
    }
    const api = window.electronAPI || {};
    if (!api.uploadDataset) {
      setDatasetStatus(prev => ({ ...prev, error: 'Dataset upload is temporarily unavailable.' }));
      return;
    }
    setDatasetStatus({ loading: false, uploading: true, error: null });
    try {
      for (const file of selectedFiles) {
        const created = await api.uploadDataset(activeProjectId, file, {
          supportedWorkflow: workflow.jobType,
          supportedFormat: workflow.formatLabel,
        }, workflow.datasetFileType);
        setDatasets(prev => [created, ...prev.filter(dataset => dataset.id !== created.id)]);
        if (multiSampleMode) {
          setMultiSampleRows(prev => prev.some(row => row.datasetId === created.id) ? prev : [...prev, {
            datasetId: created.id,
            sampleName: defaultSampleName(created),
            conditionName: '',
            donorCode: '',
            batch: '',
          }]);
          setSelectedDatasetId(prev => prev || created.id);
        } else {
          setSelectedDatasetId(created.id);
        }
      }
    } catch (error) {
      setDatasetStatus(prev => ({ ...prev, error: parseApiError(error) }));
    } finally {
      setDatasetStatus(prev => ({ ...prev, uploading: false }));
    }
  };

  const launchPipeline = async () => {
    if (!canWriteProject) {
      setJobStatus(prev => ({ ...prev, error: 'Your project role is read-only and cannot start analysis jobs.' }));
      return;
    }
    if (!activeProjectId || !selectedDatasetId) return;
    const api = window.electronAPI || {};
    const createJob = spatialMode
      ? api.createSpatialSeuratPipelineJob
      : multiSampleMode
        ? api.createMultiSampleSeuratPipelineJob
        : api.createSeuratPipelineJob;
    if (!createJob) {
      setJobStatus(prev => ({ ...prev, error: 'This approved workflow is temporarily unavailable.' }));
      return;
    }
    setJobStatus({ launching: true, refreshing: false, error: null });
    setLoadJob(null);
    setLoadStatus({ launching: false, refreshing: false, error: null });
    setLogs([]);
    setArtifacts([]);
    try {
      const input = await ensureDatasetInputObject();
      const created = await createJob(activeProjectId, {
        datasetId: selectedDatasetId,
        ...(multiSampleMode ? { samples: multiSampleRows } : {}),
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
      setLoadStatus(prev => ({ ...prev, error: 'Opening a saved version is temporarily unavailable.' }));
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

  const canLaunch = canWriteProject && !!activeProjectId && !!selectedDatasetId && !jobStatus.launching
    && (!spatialMode || activeDatasetReady)
    && (!multiSampleMode || (activeDatasetReady && multiSampleDesignValid));

  const selectWorkflowMode = (nextMode) => {
    if (nextMode === workflowMode) return;
    setWorkflowMode(nextMode);
    setDatasets([]);
    setSelectedDatasetId('');
    setMultiSampleRows([]);
    setJob(null);
    setLoadJob(null);
    setLogs([]);
    setArtifacts([]);
    setDatasetStatus({ loading: false, uploading: false, error: null });
    setJobStatus({ launching: false, refreshing: false, error: null });
    setLoadStatus({ launching: false, refreshing: false, error: null });
  };

  const continueToStudyDesign = () => {
    if (!canContinueToDeg) return;
    onSelectAnalysisObject?.(activeProjectId, resultObjectId);
    setActiveTab('study-design');
  };

  const toggleMultiSampleDataset = (dataset) => {
    const alreadySelected = multiSampleRows.some(row => row.datasetId === dataset.id);
    if (!alreadySelected && multiSampleRows.length >= MAX_MULTI_SAMPLE_INPUTS) {
      setDatasetStatus(prev => ({
        ...prev,
        error: `A multi-condition run supports at most ${MAX_MULTI_SAMPLE_INPUTS} sample datasets.`,
      }));
      return;
    }
    setMultiSampleRows(prev => {
      const exists = prev.some(row => row.datasetId === dataset.id);
      return exists
        ? prev.filter(row => row.datasetId !== dataset.id)
        : [...prev, {
          datasetId: dataset.id,
          sampleName: defaultSampleName(dataset),
          conditionName: '',
          donorCode: '',
          batch: '',
        }];
    });
  };

  const updateMultiSampleRow = (datasetId, field, value) => {
    setMultiSampleRows(prev => prev.map(row => (
      row.datasetId === datasetId ? { ...row, [field]: value } : row
    )));
  };

  React.useEffect(() => {
    if (!multiSampleMode) return;
    setSelectedDatasetId(multiSampleRows[0]?.datasetId || '');
  }, [multiSampleMode, multiSampleRows]);

  return (
    <section className="rounded-lg border border-border bg-surface/70 p-4 sm:p-5" data-testid="seurat-pipeline-panel">
      <h3 className="text-xl font-bold tracking-tight text-text">Seurat analysis</h3>
      <div className="mt-4 flex border-b border-border" role="tablist" aria-label="Analysis approach">
        {[['automatic', 'Run whole pipeline'], ['guided', 'Inspect step by step']].map(([mode, label]) => (
          <button key={mode} type="button" role="tab" id={`${approachId}-${mode}-tab`}
            aria-controls={`${approachId}-${mode}-panel`} aria-selected={analysisApproach === mode}
            tabIndex={analysisApproach === mode ? 0 : -1} onKeyDown={changeApproachWithKeys}
            onClick={() => setAnalysisApproach(mode)}
            className={`min-h-12 border-b-2 px-3 py-3 text-sm font-semibold transition-colors sm:px-5 ${analysisApproach === mode ? 'border-primary text-primary' : 'border-transparent text-textMuted hover:text-text hover:border-border'}`}
          >{label}</button>
        ))}
      </div>

      {!activeProjectId ? (
        <div className="mt-5 rounded border border-dashed border-border p-5 text-sm text-textMuted">
          Select or create a project before uploading data or running the Seurat workflow.
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {!canWriteProject && (
            <div className="rounded border border-border bg-surface px-3 py-2 text-sm text-textMuted" role="note">
              This project is read-only for your role. You can review workflow settings and results, but only an owner, administrator, or analyst can upload data or start a run.
            </div>
          )}
          <div role="tabpanel" id={`${approachId}-automatic-panel`} aria-labelledby={`${approachId}-automatic-tab`}
            hidden={analysisApproach !== 'automatic'} className="space-y-4">
            <p className="text-sm text-textMuted">Set every step below, then submit one job from input to UMAP. Inspect the results when it finishes.</p>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Seurat workflow type">
            <button
              type="button"
              aria-pressed={workflowMode === 'scrna'}
              onClick={() => selectWorkflowMode('scrna')}
              className={`btn text-xs ${workflowMode === 'scrna' ? 'btn-primary' : 'btn-secondary'}`}
            >
              Single-cell RNA
            </button>
            <button
              type="button"
              aria-pressed={multiSampleMode}
              onClick={() => selectWorkflowMode('multisample')}
              className={`btn text-xs ${multiSampleMode ? 'btn-primary' : 'btn-secondary'}`}
            >
              Multiple conditions
            </button>
            <button
              type="button"
              aria-pressed={spatialMode}
              onClick={() => selectWorkflowMode('spatial')}
              className={`btn text-xs ${spatialMode ? 'btn-primary' : 'btn-secondary'}`}
            >
              Spatial transcriptomics (Visium)
            </button>
              </div>
              <button onClick={loadDatasets} disabled={datasetStatus.loading} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
                {datasetStatus.loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                Refresh datasets
              </button>
            </div>
            <div className="rounded border border-border bg-background/40 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="font-bold text-text">Dataset upload / selection</h4>
                  <p className="mt-1 text-xs text-textMuted">Supported format: {workflow.formatLabel}.</p>
                  {spatialMode && <p className="mt-1 text-xs text-textMuted">Visium HD and Xenium are not accepted by this workflow.</p>}
                  {multiSampleMode && <p className="mt-1 text-xs text-textMuted">Use one file per biological sample and assign its condition below.</p>}
                </div>
                {datasetUploadsEnabled && canWriteProject ? <label className="btn btn-primary inline-flex cursor-pointer items-center gap-2 text-sm">
                  <FileUp size={16} />
                  {datasetStatus.uploading
                    ? 'Uploading...'
                    : spatialMode
                      ? 'Upload Visium .zip'
                      : multiSampleMode ? 'Upload sample .h5 files' : 'Upload 10x .h5'}
                  <input
                    data-testid="seurat-pipeline-upload"
                    type="file"
                    accept={spatialMode ? '.zip' : '.h5'}
                    multiple={multiSampleMode}
                    className="sr-only"
                    disabled={datasetStatus.uploading || !canWriteProject}
                    onChange={uploadDataset}
                  />
                </label> : (
                  <span className="rounded border border-border px-3 py-2 text-xs text-textMuted">
                    {canWriteProject
                      ? 'Public demo uses curated data; uploads are disabled.'
                      : 'Read-only project; uploads are disabled for your role.'}
                  </span>
                )}
              </div>
              {datasetStatus.error && (
                <div className="mb-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {safeMessage(datasetStatus.error)}
                </div>
              )}
              {datasets.length === 0 ? (
                <div className="rounded border border-dashed border-border p-4 text-sm text-textMuted">
                  No compatible {workflow.shortFormatLabel} datasets are recorded for this project yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {datasets.map(dataset => {
                    const designRow = multiSampleRows.find(row => row.datasetId === dataset.id);
                    const selected = multiSampleMode ? Boolean(designRow) : selectedDatasetId === dataset.id;
                    return (
                      <div key={dataset.id} className="rounded border border-border bg-surface p-3 hover:border-primary/40">
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type={multiSampleMode ? 'checkbox' : 'radio'}
                            name="seurat-pipeline-dataset"
                            checked={selected}
                            onChange={() => (multiSampleMode
                              ? toggleMultiSampleDataset(dataset)
                              : setSelectedDatasetId(dataset.id))}
                            className="mt-1"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-bold text-text">{dataset.originalFilename || dataset.name || 'Uploaded dataset'}</span>
                            <span className="mt-1 block text-xs text-textMuted">
                              {workflow.shortFormatLabel} · {datasetResearchStatus(dataset)}
                            </span>
                            {dataset.validationStatus === 'invalid' && (
                              <span className="mt-2 block text-xs text-danger">
                                {datasetValidationMessages(dataset)[0]
                                  ? safeMessage(datasetValidationMessages(dataset)[0])
                                  : 'This upload did not pass format validation.'}
                              </span>
                            )}
                          </span>
                        </label>
                        {multiSampleMode && designRow && (
                          <div className="mt-3 grid grid-cols-1 gap-2 border-t border-border pt-3 sm:grid-cols-2">
                            <label className="text-xs text-textMuted">
                              Sample name
                              <input className="input mt-1 w-full" aria-label={`Sample name for ${dataset.originalFilename || dataset.id}`} value={designRow.sampleName} onChange={event => updateMultiSampleRow(dataset.id, 'sampleName', event.target.value)} />
                            </label>
                            <label className="text-xs text-textMuted">
                              Condition
                              <input className="input mt-1 w-full" aria-label={`Condition for ${dataset.originalFilename || dataset.id}`} placeholder="e.g. treated" value={designRow.conditionName} onChange={event => updateMultiSampleRow(dataset.id, 'conditionName', event.target.value)} />
                            </label>
                            <label className="text-xs text-textMuted">
                              Donor code (optional)
                              <input className="input mt-1 w-full" aria-label={`Donor code for ${dataset.originalFilename || dataset.id}`} value={designRow.donorCode} onChange={event => updateMultiSampleRow(dataset.id, 'donorCode', event.target.value)} />
                            </label>
                            <label className="text-xs text-textMuted">
                              Batch (optional)
                              <input className="input mt-1 w-full" aria-label={`Batch for ${dataset.originalFilename || dataset.id}`} value={designRow.batch} onChange={event => updateMultiSampleRow(dataset.id, 'batch', event.target.value)} />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded border border-border bg-background/40">
              <h4 className="border-b border-border px-4 py-3 font-semibold text-text sm:px-5">Pipeline settings</h4>
              <SeuratPipelineSettings params={params} setParams={setParams} controls={SEURAT_NUMERIC_CONTROLS} />
              <div className="border-t border-border p-4 sm:p-5">
              {multiSampleMode && (
                <div className="mt-3 rounded border border-primary/20 bg-primary/5 px-3 py-3 text-xs text-textMuted" role="status">
                  <p className="font-bold text-text">Multi-condition preparation</p>
                  <p className="mt-1">
                    {multiSampleRows.length} selected sample{multiSampleRows.length === 1 ? '' : 's'} across {multiSampleConditionCounts.size} condition{multiSampleConditionCounts.size === 1 ? '' : 's'}.
                  </p>
                  {!multiSampleDesignValid && (
                    <p className="mt-2 text-amber-800 dark:text-amber-200">
                      Select 2-{MAX_MULTI_SAMPLE_INPUTS} datasets, enter unique sample names, and assign at least two conditions. Labels must be 1-80 characters and use letters, numbers, spaces, periods, underscores, or hyphens.
                    </p>
                  )}
                  {multiSampleDesignValid && [...multiSampleConditionCounts.values()].some(count => count < 2) && (
                    <p className="mt-2 text-amber-800 dark:text-amber-200">
                      The combined analysis can run, but replicate-aware condition testing requires at least two independent samples in each compared condition.
                    </p>
                  )}
                  {multiSampleDesignValid && [...multiSampleConditionCounts.values()].every(count => count >= 2) && (
                    <p className="mt-2 text-success">
                      The sample counts meet the minimum replication gate for sample-level condition comparisons.
                    </p>
                  )}
                  <p className="mt-2">The saved object will contain <code>sample_id</code>, <code>condition</code>, <code>donor_code</code>, and <code>batch</code> metadata.</p>
                </div>
              )}
              {spatialMode && activeDataset && !activeDatasetReady && (
                <div className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs text-textMuted" role="status">
                  <p className="font-bold text-text">
                    {activeDataset.validationStatus === 'invalid'
                      ? 'This Visium ZIP cannot be started until its contents are corrected.'
                      : 'This Visium ZIP is still being checked. Refresh datasets before starting the run.'}
                  </p>
                  <p className="mt-2">Required files under one Space Ranger output directory:</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {CLASSIC_VISIUM_REQUIRED_FILES.map((file) => <li key={file}>{file}</li>)}
                  </ul>
                  {datasetValidationMessages(activeDataset).map((message) => (
                    <p key={message} className="mt-2 text-danger">{safeMessage(message)}</p>
                  ))}
                </div>
              )}
              <button
                onClick={launchPipeline}
                disabled={!canLaunch}
                className="btn btn-primary mt-4 inline-flex items-center gap-2 text-sm disabled:opacity-50"
              >
                {jobStatus.launching ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                {spatialMode
                  ? 'Run spatial Seurat preprocessing'
                  : multiSampleMode ? 'Prepare multi-condition analysis' : 'Run Seurat preprocessing'}
              </button>
              </div>
            </div>
          </div>

          <div role="tabpanel" id={`${approachId}-guided-panel`} aria-labelledby={`${approachId}-guided-tab`}
            hidden={analysisApproach !== 'guided'} className="space-y-4">
            <p className="max-w-3xl text-sm leading-relaxed text-textMuted">Run and review one step at a time. Use each result to choose the settings for the next step.</p>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-background/40 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs text-textMuted">Analysis to inspect</p>
                <p className="mt-1 break-words font-semibold text-text">{selectedObject?.displayName || selectedObject?.name || 'No analysis selected'}</p>
                {!guidedReady && <p className="mt-1 text-sm text-textMuted">Open an analysis in the workspace to start inspecting its steps.</p>}
              </div>
              <button type="button" onClick={() => setActiveTab?.('workspace')} className="btn btn-secondary text-sm">
                {guidedReady ? 'Change analysis' : 'Choose / open analysis'}
              </button>
            </div>
            <ol className="divide-y divide-border rounded border border-border bg-background/40">
              {[
                ['inspect', 'Inspect', 'Check the input data and metadata.'],
                ['qc', 'Quality control', 'Review distributions and choose cell filters.'],
                ['normalize', 'Normalization', 'Choose a method and variable features.'],
                ['integrate', 'Integration (optional)', 'Combine samples when integration is needed.'],
                ['pca', 'PCA', 'Review principal components before choosing dimensions.'],
                ['cluster', 'Clustering', 'Compare groups and adjust resolution.'],
                ['umap', 'UMAP', 'Review the cell embedding.'],
              ].map(([route, title, description], index) => (
                <li key={route} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="flex min-w-0 flex-1 items-baseline gap-3">
                    <span className="pipeline-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                    <div><h4 className="font-semibold text-text">{title}</h4><p className="mt-1 text-xs leading-relaxed text-textMuted">{description}</p></div>
                  </div>
                  <button type="button" onClick={() => openGuidedStep(route)} disabled={!guidedReady}
                    className="btn btn-secondary text-sm" aria-label={`Open ${title}`}>Open</button>
                </li>
              ))}
            </ol>
          </div>

          {hasRunActivity && <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Pipeline run">
            <div className="rounded border border-border bg-background/40 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h4 className="font-bold text-text">Run status</h4>
                {job?.id && (
                  <button onClick={() => refreshJob(job.id)} disabled={jobStatus.refreshing} className="btn btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs">
                    {jobStatus.refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    Refresh run
                  </button>
                )}
              </div>
              {jobStatus.error && <div className="mb-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{safeMessage(jobStatus.error)}</div>}
              {!job ? (
                <p className="text-sm text-textMuted">No {spatialMode ? 'spatial Seurat' : multiSampleMode ? 'multi-condition Seurat' : 'Seurat'} preprocessing run has been launched from this panel yet.</p>
              ) : (
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-text">{spatialMode ? 'Spatial Seurat preprocessing' : multiSampleMode ? 'Multi-condition Seurat preparation' : 'Seurat preprocessing'}</span>
                    <StatusPill label={displayRunStatus(job.status)} tone={job.status === 'completed' ? 'green' : job.status === 'failed' ? 'amber' : 'blue'} />
                  </div>
                  <div className="text-xs text-textMuted">Created: {formatDate(job.createdAt)}</div>
                  <div className="grid grid-cols-1 gap-2 text-xs">
                    <div>{multiSampleMode ? 'Primary dataset' : 'Dataset'}: <span className="text-text">{activeDataset?.originalFilename || activeDataset?.displayName || 'Selected dataset'}</span></div>
                    <div>Input analysis: <span className="text-text">{inputObject?.displayName || inputObject?.name || selectedObject?.displayName || selectedObject?.name || 'Selected analysis'}</span></div>
                    <div>Result: <span className="text-text">{resultObject?.displayName || resultObject?.name || (resultObjectId ? 'Saved analysis is ready' : 'Preparing saved analysis')}</span></div>
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
              <h4 className="mb-3 flex items-center gap-2 font-bold text-text"><Archive size={16} /> Continue this analysis</h4>
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
                <p className="text-sm text-textMuted">A summary will appear here when the analysis run finishes.</p>
              )}
              <div className="mt-3 space-y-2 text-xs text-textMuted">
                <p>Result: <span className="text-text">{resultObject?.displayName || resultObject?.name || (resultObjectId ? 'Saved analysis is ready' : 'Not available yet')}</span></p>
                <p>Saved version: <span className="text-text">{checkpointArtifact ? 'Available' : 'Not available yet'}</span></p>
                {resultObjectId && resultObject?.liveState !== 'attached' && (
                  <p>Open this saved version in your private analysis workspace before continuing with downstream analysis.</p>
                )}
                {multiSampleMode && resultObjectId && (
                  <p>Before condition-level inference, confirm the biological samples, conditions, and object bindings in Study Design.</p>
                )}
                {loadJob?.id && (
                  <p>Open saved version: <span className="text-text">{displayRunStatus(loadJob.status)}</span></p>
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
                  {loadCompleted ? 'Saved version opened' : 'Open saved version'}
                </button>
                {loadJob?.id && loadJob.status !== 'completed' && (
                  <button
                    onClick={() => refreshLoadJob(loadJob.id)}
                    disabled={loadStatus.refreshing}
                    className="btn btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                  >
                    {loadStatus.refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                    Refresh
                  </button>
                )}
                <button
                  onClick={inspectPipelineResult}
                  disabled={!canContinueToDeg}
                  className="btn btn-secondary text-sm disabled:opacity-50"
                >Inspect this result step by step</button>
                <button
                  onClick={continueToDeg}
                  disabled={!canContinueToDeg}
                  className="btn btn-primary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  Continue to marker analysis
                </button>
                {multiSampleMode && (
                  <button
                    onClick={continueToStudyDesign}
                    disabled={!canContinueToDeg}
                    className="btn btn-secondary inline-flex items-center gap-2 text-sm disabled:opacity-50"
                  >
                    Continue to Study Design
                  </button>
                )}
                <button onClick={() => setActiveTab('history')} className="btn btn-secondary text-sm">
                  Open Runs & Results
                </button>
              </div>
            </div>

            <details className="rounded border border-border bg-background/40 p-4 lg:col-span-2">
              <summary className="cursor-pointer font-semibold text-textMuted hover:text-text">Run notes</summary>
              {logs.length === 0 ? (
                <p className="text-sm text-textMuted">Run notes will appear when compute begins.</p>
              ) : (
                <div className="mt-3 max-h-44 space-y-2 overflow-y-auto custom-scrollbar">
                  {logs.map((entry, index) => (
                    <div key={`${entry?.ts || index}-${index}`} className="rounded border border-border bg-surface p-2 text-xs">
                      <div className="font-mono text-textMuted">{formatDate(entry?.ts)} / {entry?.level || 'info'}</div>
                      <div className="mt-1 text-textMuted">{researcherRunNote(entry)}</div>
                    </div>
                  ))}
                </div>
              )}
            </details>
          </div>}
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
  userId,
  backendModelStatus,
  onSelectProject,
  onCreateProject,
  onCreateAnalysisObjectForLoad,
  onAnalysisObjectLoaded,
  onAnalysisObjectLoadFailed,
  onSelectAnalysisObject,
  pipelineState,
  deploymentPolicy = {},
}) {
  const selectedObjects = currentWs.objects.filter(obj => currentWs.selectedObjectIds?.includes(obj.id));
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadingId, setLoadingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Projects come from the backend. The selected project ID may be cached as a
  // UI preference, but the project list itself is not localStorage truth.
  const defaultProjectId = currentWs.selectedProjectId || currentWs.projects?.[0]?.id || null;
  const [activeProjectId, setActiveProjectId] = useState(defaultProjectId);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const createProjectInFlightRef = useRef(false);
  const [isSubmittingProject, setIsSubmittingProject] = useState(false);
  const analysisCardsRef = useRef(new Map());
  const analysisHeadingRef = useRef(null);
  const deleteFocusRef = useRef(null);

  React.useLayoutEffect(() => {
    const pending = deleteFocusRef.current;
    if (!pending || currentWs.objects.some(object => object.id === pending.deleted)) return;
    deleteFocusRef.current = null;
    (analysisCardsRef.current.get(pending.next) || analysisHeadingRef.current)?.focus();
  }, [currentWs.objects]);

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
    setLoadError(null);
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

  const handleLoadFailed = (analysisObject) => {
    if (!analysisObject?.id) return;
    onAnalysisObjectLoadFailed?.(activeProjectId, analysisObject);
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

  const handleDeleteObject = (objId) => {
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

    // 2. App State update
    const remainingObjects = currentWs.objects.filter(o => o.id !== objId);
    deleteFocusRef.current = { deleted: objId, next: remainingObjects.find(object => object.projectId === activeProjectId)?.id };
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
    if (createProjectInFlightRef.current || !newProjectName.trim() || newProjectName.trim().length > 100) return;
    createProjectInFlightRef.current = true;
    setIsSubmittingProject(true);
    try {
      const project = await onCreateProject?.({ name: newProjectName.trim(), description: '' });
      if (project?.id) setActiveProjectId(project.id);
      setNewProjectName('');
      setIsCreatingProject(false);
    } catch (err) {
      alert(publicErrorMessage(err, 'The project could not be created. Please try again.'));
    } finally {
      createProjectInFlightRef.current = false;
      setIsSubmittingProject(false);
    }
  };

  const handleChangeObjectProject = (objId, newProjectId) => {
    
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
  const canWriteProject = PROJECT_WRITE_ROLES.has(activeProject?.role);
  const canReloadPbmcDemo = selectedObject?.source === 'pbmc3k_demo'
    && selectedObject?.metadata?.curatedDemo !== true
    && canWriteProject
    && (!selectedObject?.ownerUserId || Number(selectedObject.ownerUserId) === Number(userId));

  const reloadPbmcDemo = async () => {
    if (!selectedObject?.id || !canReloadPbmcDemo) return;
    const minCells = boundedDemoSetting(selectedObject.metadata?.minCells, 3, 1, 1000);
    const minFeatures = boundedDemoSetting(selectedObject.metadata?.minFeatures, 200, 1, 100000);
    setLoadError(null);
    setLoadingId('reload-demo');
    try {
      const data = await window.electronAPI.apiRequest(
        `/load-data?min_cells=${minCells}&min_features=${minFeatures}`,
        { headers: { 'X-Object-ID': selectedObject.id } }
      );
      if (data?.error) throw new Error(data.error);
      if (!isLiveLoadResult(data?.result)) {
        throw new Error('The R runtime returned an incomplete load summary.');
      }
      handleLoaded(data, selectedObject.name || 'PBMC_3k_Tutorial', {
        ...selectedObject,
        displayName: selectedObject.name || 'PBMC_3k_Tutorial',
      });
    } catch (error) {
      setLoadError(publicErrorMessage(error, 'The PBMC demo could not be opened. Please try again.'));
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-5 pb-4 flex justify-between items-end border-b border-border bg-slate-800/10 sm:px-8 sm:pt-6">
        <div className="min-w-0">
          <h2 className="page-title min-w-0">
            <span className="truncate">{currentWs.name}</span>
            {currentWs.type === 'personal'
              ? <Lock size={16} className="text-slate-400" />
              : <Globe size={16} className="text-primary" />}
          </h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 sm:p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          <WorkbenchOverview
            activeProject={activeProject}
            selectedObject={selectedObject}
            activeProjectObjects={activeProjectObjects}
            pipelineState={pipelineState}
            setActiveTab={setActiveTab}
            setShowLoadModal={setShowLoadModal}
            onReloadPbmcDemo={canReloadPbmcDemo ? reloadPbmcDemo : undefined}
          />

          {loadError && (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              {loadError}
            </div>
          )}

          {/* Stats Block */}
          {displayObject && (
            <div className="flex flex-wrap items-center justify-between gap-4" aria-label="Dataset summary">
              <dl className="flex flex-wrap gap-x-8 gap-y-3">
                {[
                  { label: 'Cells', value: Number.isFinite(displayObject.cells) ? displayObject.cells.toLocaleString() : 'Unavailable' },
                  { label: 'Features', value: Number.isFinite(displayObject.features) ? displayObject.features.toLocaleString() : 'Unavailable' },
                ].map(stat => <div key={stat.label}>
                  <dt className="text-xs text-textMuted">{stat.label}</dt>
                  <dd className="mt-1 text-xl font-semibold tabular-nums text-text">{stat.value}</dd>
                </div>)}
              </dl>
              <DetailsPopover label="Dataset details">
                {activeCount > 1 && <p className="mb-2">{activeCount} analyses selected. Counts describe the primary analysis.</p>}
                <dl className="space-y-2">
                  <div><dt className="text-textMuted">Matrix density</dt><dd>{Number.isFinite(displayObject.density) ? `${displayObject.density}% non-zero values` : 'Unavailable for this saved analysis'}</dd></div>
                  <div><dt className="text-textMuted">Branch</dt><dd className="break-words">{currentWs.activeBranch}</dd></div>
                </dl>
                <p className="mt-3 text-textMuted">Your live workspace is private. Share saved versions through Runs &amp; Results.</p>
              </DetailsPopover>
            </div>
          )}

          {/* Projects Navigation */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
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
                    maxLength={100}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newProjectName.trim()) handleCreateProject();
                      if (e.key === 'Escape') setIsCreatingProject(false);
                    }}
                    className="bg-surface border border-border text-sm text-text px-3 py-1.5 rounded focus:outline-none focus:border-primary w-40"
                    autoFocus
                  />
                  <button onClick={handleCreateProject} disabled={!newProjectName.trim() || isSubmittingProject} className="btn btn-primary text-xs px-3 py-1.5">{isSubmittingProject ? 'Saving…' : 'Save'}</button>
                  <button onClick={() => setIsCreatingProject(false)} disabled={isSubmittingProject} aria-label="Cancel project creation" className="text-textMuted hover:text-text px-2"><X size={14} /></button>
                </div>
              ) : (
                <button
                  onClick={() => setIsCreatingProject(true)}
                  className="btn btn-primary text-xs px-4 py-2 flex items-center gap-2 font-bold shadow-sm transition-colors"
                >
                  <Plus size={14} /> New Project
                </button>
              )}
            </div>

            {backendModelStatus?.error && (
              <div className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {publicErrorMessage(backendModelStatus.error, 'Project information is temporarily unavailable.')}
              </div>
            )}

            <div className="flex gap-2 overflow-x-auto pb-4 border-b border-border/50 custom-scrollbar">
              {backendModelStatus?.projectsLoading ? (
                <div className="text-sm text-textMuted px-1 py-3">Loading projects...</div>
              ) : currentWs.projects?.length === 0 ? (
                <div className="w-full rounded border border-dashed border-border p-6 text-center">
                  <h4 className="text-text font-bold mb-2">No projects yet</h4>
                  <p className="text-sm text-textMuted mb-4">Create a project before loading a saved analysis.</p>
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
                  <button
                    type="button"
                    key={proj.id}
                    onClick={() => handleProjectSelect(proj.id)}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border transition-colors min-w-max group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      isActive ? 'bg-primary/10 border-primary text-primary shadow-sm' : 'bg-slate-800/50 border-slate-700/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
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
                  </button>
                );
              })}
            </div>
          </div>

          {/* Objects List */}
          <div className="pt-2">
            <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
              <h3 ref={analysisHeadingRef} tabIndex={-1} className="text-lg font-bold text-text flex items-center gap-3">
                Saved analyses{' '}
                <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">
                  {activeProjectObjects.length}
                </span>
              </h3>
              {activeProjectObjects.length > 0 && <button
                onClick={() => setShowLoadModal(true)}
                disabled={!!loadingId || !activeProjectId || !canWriteProject}
                title={!canWriteProject && activeProjectId ? 'Your project role is read-only.' : undefined}
                className="btn btn-primary flex items-center gap-2 px-5 text-sm shadow-lg shadow-primary/20"
              >
                <FileUp size={16} /> Add analysis
              </button>}
            </div>

            <div className="grid grid-cols-1 gap-3">
              {!activeProjectId ? (
                <div className="p-6 sm:p-16 text-center border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center">
                  <FolderTree size={40} className="text-slate-400 mb-4 opacity-50" />
                  <h4 className="text-text font-bold mb-2">Select a project</h4>
                  <p className="text-sm text-textMuted mb-6">
                    Select or create a project to list saved analyses.
                  </p>
                </div>
              ) : backendModelStatus?.objectsLoading ? (
                <div className="p-6 sm:p-16 text-center border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center">
                  <Database size={40} className="text-slate-400 mb-4 opacity-50" />
                  <h4 className="text-text font-bold mb-2">Loading saved analyses</h4>
                  <p className="text-sm text-textMuted">Loading saved analysis details.</p>
                </div>
              ) : activeProjectObjects.length === 0 ? (
                <div className="p-6 sm:p-16 text-center border-2 border-dashed border-border rounded-2xl flex flex-col items-center justify-center">
                  <Database size={40} className="text-slate-400 mb-4 opacity-50" />
                  <h4 className="text-text font-bold mb-2">No saved analyses in this project</h4>
                  <p className="text-sm text-textMuted mb-6">
                    {canWriteProject
                      ? 'Use an approved workflow or the PBMC demo to create a saved analysis.'
                      : 'Your project role is read-only. An owner, administrator, or analyst can add a saved analysis.'}
                  </p>
                  <button
                    onClick={() => setShowLoadModal(true)}
                    disabled={!canWriteProject}
                    title={!canWriteProject ? 'Your project role is read-only.' : undefined}
                    className="btn btn-primary flex items-center gap-2"
                  >
                    <FileUp size={15} /> Add analysis
                  </button>
                </div>
              ) : activeProjectObjects.map(obj => {
                const isSelected = currentWs.selectedObjectIds?.includes(obj.id);
                return (
                  <div
                    key={obj.id}
                    ref={element => { if (element) analysisCardsRef.current.set(obj.id, element); else analysisCardsRef.current.delete(obj.id); }}
                    onClick={() => selectObject(obj.id)}
                    onKeyDown={event => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        selectObject(obj.id);
                      }
                    }}
                    role="group"
                    aria-label={`Saved analysis ${obj.name}. Press Enter or Space to select.`}
                    tabIndex={0}
                    className={`p-4 sm:p-5 rounded-xl border transition-colors cursor-pointer group relative grid grid-cols-[40px_minmax(0,1fr)_44px] items-start gap-3 sm:flex sm:items-center sm:gap-5 ${
                      isSelected
                        ? 'bg-primary/5 border-primary shadow-lg'
                        : 'bg-surface border-border hover:border-slate-700'
                    }`}
                  >
                    {/* Icon */}
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors flex-shrink-0 ${
                      isSelected ? 'bg-primary text-white' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {obj.isSubset ? <Scissors size={18} /> : <LayoutGrid size={20} />}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 group/edit min-h-6">
                        {editingId === obj.id ? (
                          <input
                            type="text" autoFocus
                            className="bg-background text-text px-2 py-0.5 rounded border border-primary text-sm font-bold w-48 focus:outline-none"
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            maxLength={100}
                            onBlur={e => saveRename(e, obj.id)}
                            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <div className="text-sm font-bold text-text break-words" title={obj.name}>{obj.name}</div>
                            {obj.isSubset && (
                              <span className="text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide text-amber-400 bg-amber-500/10 border-amber-500/20">
                                subset
                              </span>
                            )}
                            {!obj.isBackendAnalysisObject && (
                              <button
                                onClick={e => handleRenameObject(e, obj.id, obj.name)}
                                className="text-textMuted hover:text-text opacity-0 group-hover/edit:opacity-100 group-focus-within/edit:opacity-100 focus-visible:opacity-100 transition-opacity"
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
                          {Number.isFinite(obj.cells) && Number.isFinite(obj.features)
                            ? `${obj.cells.toLocaleString()} cells × ${obj.features.toLocaleString()} features`
                            : 'Dimensions unavailable'}
                        </span>
                        <div className="w-1 h-1 rounded-full bg-slate-700"></div>
                        <span className="text-[10px] text-slate-400">
                          {new Date(obj.timestamp).toLocaleDateString()}
                        </span>
                        {obj.isBackendAnalysisObject && (
                          <>
                            <div className="w-1 h-1 rounded-full bg-slate-700"></div>
                            <span className="text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide text-text bg-primary/10 border-primary/20">
                              Saved
                            </span>
                          </>
                        )}
                        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border uppercase tracking-wide ${
                          obj.liveState === 'attached'
                            ? 'text-success bg-success/10 border-success/30'
                            : 'text-amber-400 bg-amber-500/10 border-amber-500/30'
                        }`}>
                          {obj.liveState === 'attached' ? 'Ready in your workspace' : 'Open saved version'}
                        </span>
                      </div>
                    </div>

                    {/* Right side: active badge + menu */}
                    <div className="flex items-center gap-3 flex-shrink-0 relative">

                      {isSelected && (
                        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-primary/10 border border-primary/20 rounded-full text-[9px] font-black text-text uppercase shadow-sm">
                          <CheckCircle size={10} /> Selected
                        </div>
                      )}

                      {/* 3-dot Menu */}
                      <div onClick={e => e.stopPropagation()}>
                        <DetailsPopover
                          label={<><MoreVertical size={16} aria-hidden="true" /><span className="sr-only">Object options</span></>}
                          summaryClassName="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg text-textMuted hover:bg-black/5 hover:text-text transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          preferredWidth={224}
                          panelClassName="!p-1.5"
                          onOpenChange={() => setConfirmDeleteId(null)}
                        >
                            <button
                              data-close-popover
                              onClick={() => {
                                selectObject(obj.id);
                                setActiveTab('inspect');
                              }}
                              className="min-h-11 w-full rounded-lg text-left px-3 py-2 text-sm text-text hover:bg-black/5 flex items-center gap-2"
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
                                    data-close-popover
                                    onClick={() => handleChangeObjectProject(obj.id, p.id)}
                                    className="min-h-11 w-full rounded-lg text-left px-3 py-2 text-sm text-textMuted hover:bg-black/5 hover:text-text flex items-center justify-between"
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
                                      data-close-popover
                                      onClick={() => handleDeleteObject(obj.id)}
                                      className="btn btn-primary flex-1 !bg-danger"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      onClick={() => setConfirmDeleteId(null)}
                                      className="btn btn-secondary flex-1"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => handleDeleteObject(obj.id)}
                                    className="min-h-11 w-full rounded-lg text-left px-3 py-2 text-sm text-danger hover:bg-danger/10 flex items-center gap-2"
                                  >
                                    <Trash2 size={14} /> Delete Object
                                  </button>
                                )}
                              </>
                            )}
                        </DetailsPopover>
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
      {showLoadModal && canWriteProject && (
        <LoadModal
          onClose={() => setShowLoadModal(false)}
          onLoaded={handleLoaded}
          loadingId={loadingId}
          setLoadingId={setLoadingId}
          activeProjectId={activeProjectId}
          onCreateAnalysisObjectForLoad={onCreateAnalysisObjectForLoad}
          onLoadFailed={handleLoadFailed}
          legacyLocalImportsEnabled={deploymentPolicy.legacyLocalImportsEnabled === true}
          onOpenPipelineManager={() => {
            setShowLoadModal(false);
            setActiveTab?.('pipeline-manager');
          }}
        />
      )}
    </div>
  );
}
