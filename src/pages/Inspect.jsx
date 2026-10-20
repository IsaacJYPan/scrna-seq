import React, { useState, useEffect, useCallback } from 'react';
import {
  Database, Tag, Scissors, FileSpreadsheet,
  RefreshCw, CheckSquare, Square, AlertTriangle,
  Check, Plus
} from 'lucide-react';
import { publicErrorMessage } from '../publicError';

// Removed API constant
// ── Helpers ────────────────────────────────────────────────────────

function Badge({ children, color = 'primary' }) {
  const palette = {
    primary: 'bg-primary/15 text-blue-400 border-blue-400/30',
    green:   'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30',
    amber:   'bg-amber-500/15 text-amber-400 border-amber-500/30',
    slate:   'bg-slate-800 text-slate-300 border-slate-600',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${palette[color]}`}>
      {children}
    </span>
  );
}

function Spinner() {
  return <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />;
}

function forceArray(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'object') return []; // ignore {} empty lists from R jsonlite
  return [val];
}

// ── Tab components ─────────────────────────────────────────────────

function OverviewTab({ info }) {
  const reductionColor = (r) => {
    if (r === 'pca') return 'primary';
    if (r === 'umap') return 'green';
    return 'slate';
  };

  const assays = forceArray(info.assays).filter(v => typeof v === 'string');
  const reductions = forceArray(info.reductions).filter(v => typeof v === 'string');

  return (
    <div className="space-y-6">
      <section aria-label="Dataset summary" className="rounded-xl border border-border bg-surface p-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
          <div>
            <dt className="text-sm text-textMuted">Cells</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-text">{info.n_cells?.toLocaleString() ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-sm text-textMuted">Features</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-text">{info.n_features?.toLocaleString() ?? '—'}</dd>
          </div>
        </dl>
        <dl className="mt-5 grid gap-x-8 gap-y-3 border-t border-border pt-4 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-textMuted">Active assay</dt>
            <dd className="text-sm font-medium text-text">{info.active_assay || '—'}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-sm text-textMuted">Metadata columns</dt>
            <dd className="text-sm font-medium tabular-nums text-text">{info.meta_cols?.length ?? '—'}</dd>
          </div>
        </dl>
      </section>

      {/* Assays */}
      {assays.length > 1 && (
        <div>
          <h3 className="mb-2 text-sm font-medium text-text">Assays</h3>
          <div className="flex flex-wrap gap-2">
            {assays.map(a => (
              <Badge key={a} color={a === info.active_assay ? 'primary' : 'slate'}>{a}</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Reductions */}
      <div>
        <h3 className="mb-2 text-sm font-medium text-text">Reductions</h3>
        {reductions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {reductions.map(r => (
              <Badge key={r} color={reductionColor(r)}>{r.toUpperCase()} ✓</Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-textMuted">No reductions computed yet.</p>
        )}
      </div>
    </div>
  );
}

function MetadataTab({ info }) {
  const [search, setSearch] = useState('');
  // Defensively coerce name to string — jsonlite occasionally wraps length-1 R
  // character vectors as JSON arrays instead of scalars in nested list contexts.
  const toStr = (v) => (Array.isArray(v) ? v[0] : v) ?? '';
  const cols = (info.meta_cols || []).filter(c =>
    c && toStr(c.name).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <input
        type="text"
        placeholder="Filter columns…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-primary"
      />
      <div className="space-y-2 max-h-[480px] overflow-y-auto custom-scrollbar pr-1">
        {cols.map(col => (
          <div key={toStr(col.name)} className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-bold text-white font-mono">{toStr(col.name)}</span>
              <Badge color={toStr(col.type) === 'numeric' ? 'primary' : 'amber'}>{toStr(col.type)}</Badge>
            </div>
            <div className="text-[11px] text-slate-400">
              {toStr(col.type) === 'numeric' ? (
                <span>
                  <span className="text-slate-400">min </span><span className="text-slate-300">{col.min}</span>
                  <span className="text-slate-400 mx-2">·</span>
                  <span className="text-slate-400">mean </span><span className="text-slate-300">{col.mean}</span>
                  <span className="text-slate-400 mx-2">·</span>
                  <span className="text-slate-400">max </span><span className="text-slate-300">{col.max}</span>
                </span>
              ) : (
                <span>
                  <span className="text-slate-400">{col.n_unique} unique — </span>
                  {forceArray(col.preview).join(', ')}
                  {col.n_unique > 5 && <span className="text-slate-400"> …</span>}
                </span>
              )}
            </div>
          </div>
        ))}
        {cols.length === 0 && (
          <p className="text-slate-400 text-sm text-center py-8">No metadata columns found.</p>
        )}
      </div>
    </div>
  );
}

function AddMetadataTab({ onMetaAdded, info, callApi, legacyLiveMutationToolsEnabled = false }) {
  const [mode, setMode] = useState(legacyLiveMutationToolsEnabled ? 'csv' : 'map');
  
  // ── CSV Mode State ──
  const [csvPath, setCsvPath] = useState(null);
  const [columns, setColumns] = useState([]);
  const [keyColumn, setKeyColumn] = useState('');
  const [selectedCols, setSelectedCols] = useState([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // ── Map Mode State ──
  const [sourceCol, setSourceCol] = useState('');
  const [newCol, setNewCol] = useState('');
  const [sourceVals, setSourceVals] = useState([]);
  const [mapping, setMapping] = useState({});
  const [loadingVals, setLoadingVals] = useState(false);
  const [mappingSubmitting, setMappingSubmitting] = useState(false);

  // Fetch values when source column changes
  useEffect(() => {
    if (!sourceCol) { setSourceVals([]); setMapping({}); return; }
    setLoadingVals(true);
    callApi(`/meta-values?column=${encodeURIComponent(sourceCol)}`)
      .then(data => {
        setSourceVals(data.values || []);
        const initialMap = {};
        (data.values || []).forEach(v => { initialMap[v.value] = ''; });
        setMapping(initialMap);
        setLoadingVals(false);
      })
      .catch(() => setLoadingVals(false));
  }, [sourceCol, callApi]);

  const pickCsv = async () => {
    const path = await window.electronAPI?.openDataFileDialog('csv');
    if (!path) return;
    setCsvPath(path);
    setResult(null);
    setError(null);
    const data = await callApi(`/csv-columns?path=${encodeURIComponent(path)}`);
    if (data.error) { setError(publicErrorMessage(data.error)); return; }
    setColumns(data.columns || []);
    setKeyColumn(data.columns?.[0] || '');
    setSelectedCols(data.columns?.slice(1) || []);
  };

  const toggleCol = (col) => {
    setSelectedCols(prev =>
      prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
    );
  };

  const doImport = async () => {
    if (!csvPath || !keyColumn || selectedCols.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        csv_path: csvPath,
        key_column: keyColumn,
        value_columns: selectedCols.join(','),
      });
      const data = await callApi(`/add-metadata?${params}`);
      if (data.error) throw new Error(data.error);
      else { setResult(data); onMetaAdded?.(); }
    } catch (e) {
      setError(publicErrorMessage(e));
    }
    setImporting(false);
  };

  const doMap = async () => {
    if (!sourceCol || !newCol.trim()) return;
    setMappingSubmitting(true);
    setError(null);
    try {
      const data = await callApi('/add-meta-mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_col: sourceCol,
          new_col: newCol.trim(),
          mapping: mapping,
        }),
      });
      if (data.error) throw new Error(data.error);
      else { setResult(data); onMetaAdded?.(); }
    } catch (e) {
      setError(publicErrorMessage(e));
    }
    setMappingSubmitting(false);
  };

  return (
    <div className="space-y-5">
      {/* Mode Selector */}
      <div className="flex bg-slate-800/60 p-1 rounded-xl">
        {legacyLiveMutationToolsEnabled && (
          <button
            onClick={() => { setMode('csv'); setResult(null); setError(null); }}
            className={`flex-1 py-1.5 text-xs font-bold uppercase tracking-widest rounded-lg transition-all ${
              mode === 'csv' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-400 hover:text-slate-300'
            }`}
          >
            Import CSV
          </button>
        )}
        <button
          onClick={() => { setMode('map'); setResult(null); setError(null); }}
          className={`flex-1 py-1.5 text-xs font-bold uppercase tracking-widest rounded-lg transition-all ${
            mode === 'map' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-400 hover:text-slate-300'
          }`}
        >
          Map from Column
        </button>
      </div>

      {!legacyLiveMutationToolsEnabled && (
        <div className="flex items-start gap-2 text-amber-300 text-xs bg-amber-900/20 border border-amber-700/40 rounded-lg p-3">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          This import and subsetting option is not available in this deployment. You can still create bounded metadata mappings here.
        </div>
      )}

      {mode === 'csv' && (
        <>
          <p className="text-xs text-slate-400 leading-relaxed">
            Import a CSV/TSV file and join its columns to the saved analysis by cell barcode.
            The key column must contain barcodes exactly matching those in the saved analysis.
          </p>

      {/* File picker */}
      <div>
        <button
          onClick={pickCsv}
          className="w-full border-2 border-dashed border-slate-700 hover:border-primary/50 rounded-xl p-5 text-center transition-all group"
        >
          <FileSpreadsheet size={24} className="mx-auto mb-2 text-slate-400 group-hover:text-primary transition-colors" />
          <div className="text-sm font-bold text-slate-400 group-hover:text-white transition-colors">
            {csvPath ? csvPath.split(/[/\\]/).pop() : 'Click to select CSV / TSV'}
          </div>
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-red-400 text-xs bg-red-900/20 border border-red-900/40 rounded-lg p-3">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {columns.length > 0 && (
        <>
          {/* Key column */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
              Barcode / Key Column
            </label>
            <select
              value={keyColumn}
              onChange={e => setKeyColumn(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
            >
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Value columns */}
          <div>
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
              Columns to Import
            </label>
            <div className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
              {columns.filter(c => c !== keyColumn).map(col => {
                const checked = selectedCols.includes(col);
                return (
                  <button
                    key={col}
                    onClick={() => toggleCol(col)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 transition-all text-left"
                  >
                    {checked
                      ? <CheckSquare size={14} className="text-primary flex-shrink-0" />
                      : <Square size={14} className="text-slate-400 flex-shrink-0" />}
                    <span className="text-sm text-white font-mono">{col}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <button
            onClick={doImport}
            disabled={importing || selectedCols.length === 0}
            className="w-full btn btn-primary flex items-center justify-center gap-2"
          >
            {importing ? <Spinner /> : <Plus size={15} />}
            Import {selectedCols.length} Column{selectedCols.length !== 1 ? 's' : ''}
          </button>
        </>
      )}
      </>
      )}
      
      {mode === 'map' && (
        <div className="space-y-4">
          <p className="text-xs text-slate-400 leading-relaxed">
            Create a new metadata column by mapping values from an existing categorical column (like sample ID or cluster).
          </p>

          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                Source Column
              </label>
              <select
                value={sourceCol}
                onChange={e => setSourceCol(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
              >
                <option value="">— select source column —</option>
                {(info?.meta_cols || []).filter(c => c.type !== 'numeric').map(c => (
                  <option key={c.name} value={c.name}>{c.name} ({c.n_unique} unique)</option>
                ))}
              </select>
            </div>
            
            <div className="flex-1">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                New Column Name
              </label>
              <input
                type="text"
                value={newCol}
                onChange={e => setNewCol(e.target.value)}
                placeholder="e.g. Genotype"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          {sourceCol && (
            <div>
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                Value Mapping
              </label>
              {loadingVals ? (
                <div className="flex justify-center py-4"><Spinner /></div>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
                  {sourceVals.map(({ value, count }) => (
                    <div key={value} className="flex items-center gap-3 bg-slate-800/60 p-2 rounded-lg border border-slate-700/50">
                      <div className="w-1/2 flex items-center justify-between px-2">
                        <span className="text-sm font-mono text-white truncate" title={value}>{value}</span>
                        <span className="text-[10px] text-slate-400">{count?.toLocaleString()} cells</span>
                      </div>
                      <div className="text-slate-400">→</div>
                      <input
                        type="text"
                        value={mapping[value] ?? ''}
                        onChange={e => setMapping({ ...mapping, [value]: e.target.value })}
                        placeholder="Mapped value"
                        className="flex-1 bg-slate-900 border border-slate-700 rounded-md px-2 py-1.5 text-sm text-white focus:outline-none focus:border-primary"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            onClick={doMap}
            disabled={mappingSubmitting || !sourceCol || !newCol.trim()}
            className="w-full btn btn-primary flex items-center justify-center gap-2"
          >
            {mappingSubmitting ? <Spinner /> : <Plus size={15} />}
            Create Mapped Column
          </button>
        </div>
      )}

      {result && (
        <div className="flex items-start gap-2 text-emerald-400 text-xs bg-emerald-900/20 border border-emerald-900/40 rounded-lg p-3">
          <Check size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">{result.message}</div>
            <div className="text-emerald-400 mt-0.5">
              {result.added_columns ? `Added: ${result.added_columns.join(', ')}` : `${result.mapped_cells?.toLocaleString()} cells mapped.`}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SubsetTab({ info, obj, onSubsetCreated, parentSessionPath, workspaceObjects, callApi }) {
  const [column, setColumn] = useState('');
  const [valuesData, setValuesData] = useState([]);
  const [selected, setSelected] = useState([]);
  const [newName, setNewName] = useState('Subset');
  const [subsetting, setSubsetting] = useState(false);
  const [savingParent] = useState(false);
  const [error, setError] = useState(null);
  const [loadingVals, setLoadingVals] = useState(false);

  // Fetch values when column changes
  useEffect(() => {
    if (!column) { setValuesData([]); setSelected([]); return; }
    setLoadingVals(true);
    callApi(`/meta-values?column=${encodeURIComponent(column)}`)
      .then(data => {
        setValuesData(data.values || []);
        setSelected([]);
        setLoadingVals(false);
      })
      .catch(() => setLoadingVals(false));
  }, [column, callApi]);

  const toggleValue = (v) => {
    setSelected(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  };

  const doSubset = async () => {
    if (!column || selected.length === 0) return;
    
    const finalName = newName.trim();
    if (!finalName) {
      setError('Please provide a name for the new object.');
      return;
    }
    
    const existingNames = workspaceObjects.filter(o => o.projectId === obj.projectId).map(o => o.name);
    if (existingNames.includes(finalName)) {
      setError(`An object named "${finalName}" already exists in this project. Please choose a different name.`);
      return;
    }
    
    setSubsetting(true);
    setError(null);

    // ── Non-destructive Subsetting ────────────────────────────────
    // Subsetting updates private live R state only. The parent App callback
    // records the resulting child as DB-backed analysis-object metadata.
    try {
      const data = await callApi('/subset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          column,
          values: selected.join(','),
          new_name: newName,
        }),
      }, { useCache: false });
      if (data.error) throw new Error(data.error);
      onSubsetCreated?.(data, newName);
    } catch (e) {
      setError(publicErrorMessage(e));
      setSubsetting(false);
    }
  };

  const catCols = (info.meta_cols || []).filter(c => c.type !== 'numeric');
  const selectedCells = valuesData
    .filter(v => selected.includes(v.value))
    .reduce((sum, v) => sum + (v.count || 0), 0);

  const isWorking = subsetting || savingParent;

  return (
    <div className="space-y-5">
      <div className="bg-amber-900/20 border border-amber-700/40 rounded-xl p-3 text-xs text-amber-400 leading-relaxed">
        <strong>Standard practice:</strong> subsetting creates a new child analysis in your workspace.
        QC metrics are preserved (per-cell). Re-run from <strong>Normalization</strong> onward on the subset.
        {parentSessionPath && (
          <span className="block mt-1 text-amber-600">The parent object will be saved to disk before subsetting so you can restore it later.</span>
        )}
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
          Subset by Column
        </label>
        <select
          value={column}
          onChange={e => setColumn(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
        >
          <option value="">— pick a column —</option>
          {catCols.map(c => <option key={c.name} value={c.name}>{c.name} ({c.n_unique} unique)</option>)}
        </select>
      </div>

      {column && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Select Values
            </label>
            {selected.length > 0 && (
              <span className="text-[10px] text-primary font-bold">
                ~{selectedCells.toLocaleString()} cells
              </span>
            )}
          </div>
          {loadingVals ? (
            <div className="flex justify-center py-4"><Spinner /></div>
          ) : (
            <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">
              {valuesData.map(({ value, count }) => {
                const checked = selected.includes(value);
                const pct = info.n_cells ? Math.round((count / info.n_cells) * 100) : 0;
                return (
                  <button
                    key={value}
                    onClick={() => toggleValue(value)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-all text-left ${
                      checked
                        ? 'bg-primary/10 border-primary/40 text-white'
                        : 'bg-slate-800/60 border-slate-700/50 hover:border-slate-600'
                    }`}
                  >
                    {checked
                      ? <CheckSquare size={14} className="text-primary flex-shrink-0" />
                      : <Square size={14} className="text-slate-400 flex-shrink-0" />}
                    <span className="flex-1 text-sm font-mono text-white">{value}</span>
                    <div className="flex items-center gap-2 text-[10px]">
                      <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary/60 rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-slate-400 w-12 text-right">
                        {count?.toLocaleString()}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div>
        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
          New analysis name
        </label>
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
          placeholder="Subset"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 text-red-400 text-xs bg-red-900/20 border border-red-900/40 rounded-lg p-3">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <button
        onClick={doSubset}
        disabled={isWorking || selected.length === 0 || !column}
        className="w-full btn btn-primary flex items-center justify-center gap-2"
      >
        {savingParent ? (
          <><Spinner /> Saving parent…</>
        ) : subsetting ? (
          <><Spinner /> Creating subset…</>
        ) : (
          <><Scissors size={15} /> Create subset analysis ({selected.length} value{selected.length !== 1 ? 's' : ''})</>
        )}
      </button>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────

const TABS = [
  { id: 'overview',  label: 'Overview',     icon: <Database size={13} /> },
  { id: 'metadata',  label: 'Metadata',     icon: <Tag size={13} /> },
  { id: 'add-meta',  label: 'Add Metadata', icon: <Plus size={13} /> },
  { id: 'subset',    label: 'Subset',       icon: <Scissors size={13} /> },
];

export default function Inspect({
  obj,
  globalTab,
  onSubsetCreated,
  onMetaAdded,
  parentSessionPath,
  workspaceObjects = [],
  callApi,
  deploymentPolicy = {},
}) {
  const [activeTab, setActiveTab] = useState('overview');
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const legacyLiveMutationToolsEnabled = deploymentPolicy.legacyLiveMutationToolsEnabled === true;
  const visibleTabs = TABS.filter((tab) => legacyLiveMutationToolsEnabled || tab.id !== 'subset');

  const fetchInfo = useCallback(() => {
    setLoading(true);
    setError(null);
    callApi('/object-info', {}, { useCache: false })
      .then(data => {
        if (data.error) setError(publicErrorMessage(data.error));
        else setInfo(data);
        setLoading(false);
      })
      .catch(e => { setError(publicErrorMessage(e)); setLoading(false); });
  }, [callApi]);

  useEffect(() => {
    if (globalTab === 'inspect') {
      fetchInfo();
    }
  }, [obj?.id, globalTab, fetchInfo]); // Re-fetch if object changes or tab is opened

  if (!obj) {
    return (
      <div className="flex-1 w-full h-full flex flex-col items-center justify-center bg-background">
        <Database size={40} className="text-slate-400 mb-4 opacity-50" />
        <h4 className="text-text font-bold mb-2">No saved analysis selected</h4>
        <p className="text-sm text-textMuted text-center max-w-sm">
          Select a saved analysis in the workspace to inspect its contents.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 w-full h-full flex flex-col bg-background overflow-hidden relative">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface px-4 py-5 sm:px-8">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold text-text">
              {obj.name}
            </h2>
            <p className="mt-1 text-sm text-textMuted">
              {info && !loading
                ? `${info.n_cells?.toLocaleString()} cells · ${info.n_features?.toLocaleString()} features · ${info.meta_cols?.length} metadata columns`
                : loading ? 'Loading…' : 'Details unavailable'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchInfo}
              className="btn btn-secondary flex items-center gap-2 text-sm"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex overflow-x-auto custom-scrollbar border-b border-border px-2 sm:px-6" role="group" aria-label="Analysis detail views">
          {visibleTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
              className={`flex shrink-0 whitespace-nowrap items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-primary text-text'
                  : 'border-transparent text-textMuted hover:text-text'
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 sm:p-8">
          <div className="max-w-4xl mx-auto">
            {loading && !info && (
              <div className="flex flex-col items-center justify-center h-40 gap-3">
                <Spinner />
                <p className="text-xs text-slate-400">Fetching object info…</p>
              </div>
            )}

            {!loading && error && (
              <div className="flex items-start gap-2 text-red-400 text-sm bg-red-900/20 border border-red-900/40 rounded-xl p-4">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                {error}
              </div>
            )}

            {!error && info && (
              <>
                {activeTab === 'overview'  && <OverviewTab info={info} />}
                {activeTab === 'metadata'  && <MetadataTab info={info} />}
                {activeTab === 'add-meta' && <AddMetadataTab info={info} onMetaAdded={() => { onMetaAdded?.(); fetchInfo(); }} callApi={callApi} legacyLiveMutationToolsEnabled={legacyLiveMutationToolsEnabled} />}
                {activeTab === 'subset' && legacyLiveMutationToolsEnabled && <SubsetTab info={info} obj={obj} onSubsetCreated={onSubsetCreated} parentSessionPath={parentSessionPath} workspaceObjects={workspaceObjects} callApi={callApi} />}
              </>
            )}
          </div>
        </div>
      </div>
  );
}
