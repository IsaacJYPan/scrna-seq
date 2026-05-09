import React, { useState, useEffect } from 'react';
import {
  X, Database, Tag, Layers, Scissors, FileSpreadsheet,
  ChevronDown, RefreshCw, CheckSquare, Square, AlertTriangle,
  Check, Plus, Cpu, BarChart3
} from 'lucide-react';

const API = 'http://localhost:8000';

// ── Helpers ────────────────────────────────────────────────────────

function Badge({ children, color = 'primary' }) {
  const palette = {
    primary: 'bg-primary/15 text-primary border-primary/30',
    green:   'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    amber:   'bg-amber-500/15 text-amber-400 border-amber-500/30',
    slate:   'bg-slate-700 text-slate-400 border-slate-600',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wide ${palette[color]}`}>
      {children}
    </span>
  );
}

function Spinner() {
  return <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />;
}

// ── Tab components ─────────────────────────────────────────────────

function OverviewTab({ info }) {
  const reductionColor = (r) => {
    if (r === 'pca') return 'primary';
    if (r === 'umap') return 'green';
    return 'slate';
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Cells', value: info.n_cells?.toLocaleString(), icon: <Database size={14} /> },
          { label: 'Features', value: info.n_features?.toLocaleString(), icon: <BarChart3 size={14} /> },
          { label: 'Active Assay', value: info.active_assay, icon: <Cpu size={14} /> },
          { label: 'Metadata Cols', value: info.meta_cols?.length, icon: <Tag size={14} /> },
        ].map((s, i) => (
          <div key={i} className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/50">
            <div className="flex items-center gap-1.5 text-slate-500 mb-2 text-[10px] font-bold uppercase tracking-wide">
              {s.icon} {s.label}
            </div>
            <div className="text-lg font-black text-white">{s.value ?? '—'}</div>
          </div>
        ))}
      </div>

      {/* Assays */}
      {info.assays?.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Assays</div>
          <div className="flex flex-wrap gap-2">
            {info.assays.map(a => (
              <Badge key={a} color={a === info.active_assay ? 'primary' : 'slate'}>{a}</Badge>
            ))}
          </div>
        </div>
      )}

      {/* Reductions */}
      <div>
        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Reductions</div>
        {info.reductions?.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {info.reductions.map(r => (
              <Badge key={r} color={reductionColor(r)}>{r.toUpperCase()} ✓</Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500 italic">No reductions computed yet.</p>
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
                  <span className="text-slate-500">min </span><span className="text-slate-300">{col.min}</span>
                  <span className="text-slate-500 mx-2">·</span>
                  <span className="text-slate-500">mean </span><span className="text-slate-300">{col.mean}</span>
                  <span className="text-slate-500 mx-2">·</span>
                  <span className="text-slate-500">max </span><span className="text-slate-300">{col.max}</span>
                </span>
              ) : (
                <span>
                  <span className="text-slate-500">{col.n_unique} unique — </span>
                  {col.preview?.join(', ')}
                  {col.n_unique > 5 && <span className="text-slate-600"> …</span>}
                </span>
              )}
            </div>
          </div>
        ))}
        {cols.length === 0 && (
          <p className="text-slate-500 text-sm text-center py-8">No metadata columns found.</p>
        )}
      </div>
    </div>
  );
}

function AddMetadataTab({ onMetaAdded }) {
  const [csvPath, setCsvPath] = useState(null);
  const [columns, setColumns] = useState([]);
  const [keyColumn, setKeyColumn] = useState('');
  const [selectedCols, setSelectedCols] = useState([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const pickCsv = async () => {
    const path = await window.electronAPI?.openDataFileDialog('csv');
    if (!path) return;
    setCsvPath(path);
    setResult(null);
    setError(null);
    const res = await fetch(`${API}/csv-columns?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.error) { setError(data.error); return; }
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
      const res = await fetch(`${API}/add-metadata?${params}`);
      const data = await res.json();
      if (data.error) setError(data.error);
      else { setResult(data); onMetaAdded?.(); }
    } catch (e) {
      setError(e.message);
    }
    setImporting(false);
  };

  return (
    <div className="space-y-5">
      <p className="text-xs text-slate-400 leading-relaxed">
        Import a CSV/TSV file and join its columns to the Seurat object by cell barcode.
        The key column must contain barcodes exactly matching those in the object.
      </p>

      {/* File picker */}
      <div>
        <button
          onClick={pickCsv}
          className="w-full border-2 border-dashed border-slate-700 hover:border-primary/50 rounded-xl p-5 text-center transition-all group"
        >
          <FileSpreadsheet size={24} className="mx-auto mb-2 text-slate-600 group-hover:text-primary transition-colors" />
          <div className="text-sm font-bold text-slate-400 group-hover:text-white transition-colors">
            {csvPath ? csvPath.split(/[/\\]/).pop() : 'Click to select CSV / TSV'}
          </div>
          {csvPath && <div className="text-[10px] text-slate-600 mt-1 truncate">{csvPath}</div>}
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
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">
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
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
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
                      : <Square size={14} className="text-slate-600 flex-shrink-0" />}
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

      {result && (
        <div className="flex items-start gap-2 text-emerald-400 text-xs bg-emerald-900/20 border border-emerald-900/40 rounded-lg p-3">
          <Check size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">{result.message}</div>
            <div className="text-emerald-600 mt-0.5">
              Added: {result.added_columns?.join(', ')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SubsetTab({ info, onSubsetCreated, parentSessionPath }) {
  const [column, setColumn] = useState('');
  const [valuesData, setValuesData] = useState([]);
  const [selected, setSelected] = useState([]);
  const [newName, setNewName] = useState('Subset');
  const [subsetting, setSubsetting] = useState(false);
  const [savingParent, setSavingParent] = useState(false);
  const [error, setError] = useState(null);
  const [loadingVals, setLoadingVals] = useState(false);

  // Fetch values when column changes
  useEffect(() => {
    if (!column) { setValuesData([]); setSelected([]); return; }
    setLoadingVals(true);
    fetch(`${API}/meta-values?column=${encodeURIComponent(column)}`)
      .then(r => r.json())
      .then(data => {
        setValuesData(data.values || []);
        setSelected([]);
        setLoadingVals(false);
      })
      .catch(() => setLoadingVals(false));
  }, [column]);

  const toggleValue = (v) => {
    setSelected(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  };

  const doSubset = async () => {
    if (!column || selected.length === 0) return;
    setSubsetting(true);
    setError(null);

    // ── Save parent before subsetting ─────────────────────────────
    // The /subset endpoint replaces global_obj in R. We save the parent RDS
    // first so the user can restore it by clicking the parent card later.
    if (parentSessionPath) {
      setSavingParent(true);
      try {
        const saveRes = await fetch(`${API}/save-session?path=${encodeURIComponent(parentSessionPath)}`);
        const saveData = await saveRes.json();
        if (saveData.error) {
          console.warn('[Subset] Parent save failed (non-blocking):', saveData.error);
        } else {
          console.log('[Subset] Parent saved to', parentSessionPath);
        }
      } catch (e) {
        console.warn('[Subset] Parent save request failed (non-blocking):', e);
      } finally {
        setSavingParent(false);
      }
    }
    // ──────────────────────────────────────────────────────────────

    try {
      const params = new URLSearchParams({
        column,
        values: selected.join(','),
        new_name: newName,
      });
      const res = await fetch(`${API}/subset?${params}`);
      const data = await res.json();
      if (data.error) { setError(data.error); setSubsetting(false); return; }
      onSubsetCreated?.(data, newName);
    } catch (e) {
      setError(e.message);
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
        <strong>Standard practice:</strong> subsetting creates a new child object in your workspace.
        QC metrics are preserved (per-cell). Re-run from <strong>Normalization</strong> onward on the subset.
        {parentSessionPath && (
          <span className="block mt-1 text-amber-600">The parent object will be saved to disk before subsetting so you can restore it later.</span>
        )}
      </div>

      <div>
        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">
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
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
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
                      : <Square size={14} className="text-slate-600 flex-shrink-0" />}
                    <span className="flex-1 text-sm font-mono text-white">{value}</span>
                    <div className="flex items-center gap-2 text-[10px]">
                      <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary/60 rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-slate-500 w-12 text-right">
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
        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">
          New Object Name
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
          <><Scissors size={15} /> Create Subset Object ({selected.length} value{selected.length !== 1 ? 's' : ''})</>
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

export default function ObjectInspector({ obj, onClose, onSubsetCreated, onMetaAdded, parentSessionPath }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchInfo = () => {
    setLoading(true);
    setError(null);
    fetch(`${API}/object-info`)
      .then(r => r.json())
      .then(data => {
        if (data.error) setError(data.error);
        else setInfo(data);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  useEffect(() => { fetchInfo(); }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-[480px] bg-slate-900 border-l border-slate-700/80 z-50 flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800">
          <div>
            <h3 className="text-base font-bold text-white">{obj?.name || 'Object Inspector'}</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {info && !loading
                ? `${info.n_cells?.toLocaleString()} cells · ${info.n_features?.toLocaleString()} features · ${info.meta_cols?.length} metadata columns`
                : 'Loading…'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchInfo}
              className="p-2 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-white transition"
              title="Refresh"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-white transition"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 px-2">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-3 text-[11px] font-bold uppercase tracking-wide border-b-2 transition-all ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
          {loading && (
            <div className="flex flex-col items-center justify-center h-40 gap-3">
              <Spinner />
              <p className="text-xs text-slate-500">Fetching object info…</p>
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 text-red-400 text-sm bg-red-900/20 border border-red-900/40 rounded-xl p-4">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          {!loading && !error && info && (
            <>
              {activeTab === 'overview'  && <OverviewTab info={info} />}
              {activeTab === 'metadata'  && <MetadataTab info={info} />}
              {activeTab === 'add-meta'  && (
                <AddMetadataTab onMetaAdded={() => { onMetaAdded?.(); fetchInfo(); }} />
              )}
              {activeTab === 'subset' && (
                <SubsetTab info={info} onSubsetCreated={onSubsetCreated} parentSessionPath={parentSessionPath} />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
