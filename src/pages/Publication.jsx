import React, { useState, useEffect, useCallback } from 'react';
import {
  ImageIcon, Trash2, Filter, Check, X,
  BookImage, Loader2, LayoutGrid, Rows3, RefreshCw
} from 'lucide-react';

const PLOT_TYPE_COLORS = {
  UMAP:        { bg: 'bg-indigo-500/15', text: 'text-indigo-400', border: 'border-indigo-500/30' },
  FeaturePlot: { bg: 'bg-violet-500/15', text: 'text-violet-400', border: 'border-violet-500/30' },
  DotPlot:     { bg: 'bg-cyan-500/15',   text: 'text-cyan-400',   border: 'border-cyan-500/30'   },
  Heatmap:     { bg: 'bg-rose-500/15',   text: 'text-rose-400',   border: 'border-rose-500/30'   },
  Violin:      { bg: 'bg-amber-500/15',  text: 'text-amber-400',  border: 'border-amber-500/30'  },
  Unknown:     { bg: 'bg-slate-500/15',  text: 'text-slate-400',  border: 'border-slate-500/30'  },
};

function PlotTypeBadge({ plotType }) {
  const c = PLOT_TYPE_COLORS[plotType] || PLOT_TYPE_COLORS.Unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wider ${c.bg} ${c.text} ${c.border}`}>
      {plotType}
    </span>
  );
}

function safeFigureFileName(value) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim().replace(/[?#].*$/, '');
  if (!candidate || /[\0\r\n]/.test(candidate)) return '';
  const fileName = candidate.split(/[\\/]+/).pop();
  return fileName && fileName !== '.' && fileName !== '..' ? fileName.slice(0, 180) : '';
}

function FigureCard({ figure, onDelete, compact }) {
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [imgError, setImgError] = useState(false);
  const fileName = safeFigureFileName(figure.filePath);
  const dateStr = figure.createdAt
    ? new Date(figure.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

  const handleDelete = async () => {
    setDeleting(true);
    try {
      if (window.electronAPI?.deleteFigure) {
        await window.electronAPI.deleteFigure(figure.id);
      }
      onDelete(figure.id);
    } finally {
      setDeleting(false);
    }
  };

  if (compact) {
    return (
      <div className="flex items-center gap-3 p-3 bg-surface border border-border rounded-lg hover:border-primary/40 transition-all group">
        {/* Thumbnail */}
        <div className="w-16 h-12 bg-white rounded border border-slate-200 flex items-center justify-center flex-shrink-0 overflow-hidden">
          {figure.thumbnailB64 && !imgError ? (
            <img src={figure.thumbnailB64} alt={figure.title} className="w-full h-full object-contain" onError={() => setImgError(true)} />
          ) : (
            <ImageIcon size={20} className="text-slate-300" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <PlotTypeBadge plotType={figure.plotType} />
            <span className="text-xs text-textMuted">{dateStr}</span>
          </div>
          <p className="text-sm font-semibold text-text truncate">{figure.title || figure.plotType}</p>
          {fileName && (
            <p className="text-[10px] text-slate-500 truncate font-mono">{fileName}</p>
          )}
        </div>
        <div className={`flex gap-1 transition-opacity ${confirming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
          {confirming ? (
            <>
              <button onClick={handleDelete} disabled={deleting} title="Confirm delete" aria-label="Confirm delete figure" className="p-1.5 text-on-accent bg-danger hover:bg-danger/80 transition-colors rounded">
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              </button>
              <button onClick={() => setConfirming(false)} disabled={deleting} title="Cancel" aria-label="Cancel delete" className="p-1.5 text-textMuted hover:text-text transition-colors rounded hover:bg-black/5">
                <X size={14} />
              </button>
            </>
          ) : (
            <button onClick={() => setConfirming(true)} title="Delete" aria-label="Delete figure" className="p-1.5 text-textMuted hover:text-danger transition-colors rounded hover:bg-danger/10">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden hover:border-primary/40 transition-all group flex flex-col">
      {/* Thumbnail */}
      <div className="bg-white flex items-center justify-center h-48 overflow-hidden relative">
        {figure.thumbnailB64 && !imgError ? (
          <img
            src={figure.thumbnailB64}
            alt={figure.title || figure.plotType}
            className="w-full h-full object-contain p-2"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="text-center text-slate-300">
            <ImageIcon size={36} className="mx-auto mb-1 opacity-40" />
            <p className="text-[10px] text-slate-400">No preview</p>
          </div>
        )}
        {/* Overlay actions */}
        <div className={`absolute inset-0 bg-black/50 transition-opacity flex items-center justify-center gap-3 ${confirming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
          {confirming ? (
            <>
              <button onClick={handleDelete} disabled={deleting} title="Confirm delete" aria-label="Confirm delete figure" className="px-3 py-2 bg-danger hover:bg-danger/80 rounded-full text-on-accent text-xs font-bold transition-colors flex items-center gap-1.5">
                {deleting ? <Loader2 size={16} className="animate-spin" /> : <><Trash2 size={16} /> Confirm</>}
              </button>
              <button onClick={() => setConfirming(false)} disabled={deleting} title="Cancel" aria-label="Cancel delete" className="px-3 py-2 bg-white/15 hover:bg-white/25 rounded-full text-on-accent text-xs font-bold transition-colors">
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => setConfirming(true)} title="Delete from gallery" aria-label="Delete figure from gallery" className="p-2.5 bg-white/10 hover:bg-danger/40 rounded-full text-on-accent transition-colors">
              <Trash2 size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Card body */}
      <div className="p-4 flex-1 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold text-text text-sm leading-tight line-clamp-2 flex-1">
            {figure.title || figure.plotType}
          </p>
          <PlotTypeBadge plotType={figure.plotType} />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wide border border-border/50 rounded px-1.5 py-0.5">
            {(figure.fileFormat || 'png').toUpperCase()}
          </span>
          <span className="text-[10px] text-slate-500">{dateStr}</span>
        </div>

        {fileName && (
          <p className="text-[10px] text-slate-500 truncate font-mono">
            {fileName}
          </p>
        )}
      </div>
    </div>
  );
}

const ALL_TYPES = ['UMAP', 'FeaturePlot', 'DotPlot', 'Heatmap', 'Violin'];

export default function Publication({ userEmail, isActive = true }) {
  const [figures, setFigures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState('All');
  const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'list'

  const loadFigures = useCallback(async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.getFigures) {
        const figs = await window.electronAPI.getFigures(userEmail || '');
        setFigures(figs || []);
      }
    } catch (e) {
      console.error('Failed to load figures:', e);
    } finally {
      setLoading(false);
    }
  }, [userEmail]);

  // TabContent keeps this page mounted while another workspace view is active.
  // Refresh on entry so a figure saved elsewhere appears immediately instead of
  // requiring the user to discover and press the manual refresh control.
  useEffect(() => {
    if (isActive) loadFigures();
  }, [isActive, loadFigures]);

  const handleDelete = (id) => {
    setFigures(prev => prev.filter(f => f.id !== id));
  };

  const filtered = filterType === 'All'
    ? figures
    : figures.filter(f => f.plotType === filterType);

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-8 pt-6 pb-4 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <BookImage size={24} className="text-primary" />
          <div>
            <h2 className="text-2xl font-bold text-text tracking-tight">Figure Gallery</h2>
            <p className="text-textMuted text-sm">
              {figures.length} figure{figures.length !== 1 ? 's' : ''} saved. Figures remain in this private gallery.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Refresh */}
          <button
            onClick={loadFigures}
            disabled={loading}
            className="p-2 text-textMuted hover:text-primary border border-border hover:border-primary/50 rounded-lg transition-colors"
            title="Refresh gallery"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
          {/* View toggle */}
          <div className="flex bg-surface border border-border rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded transition-colors ${viewMode === 'grid' ? 'bg-primary text-white' : 'text-textMuted hover:text-text'}`}
              title="Grid view"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded transition-colors ${viewMode === 'list' ? 'bg-primary text-white' : 'text-textMuted hover:text-text'}`}
              title="List view"
            >
              <Rows3 size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="px-8 py-3 border-b border-border/50 flex items-center gap-2 flex-wrap shrink-0 bg-surface/40">
        <Filter size={14} className="text-textMuted" />
        <span className="text-xs text-textMuted mr-1">Filter:</span>
        {['All', ...ALL_TYPES].map(type => (
          <button
            key={type}
            onClick={() => setFilterType(type)}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
              filterType === type
                ? 'bg-primary text-white border-primary'
                : 'border-border text-textMuted hover:text-text hover:border-primary/40'
            }`}
          >
            {type}
            {type !== 'All' && (
              <span className="ml-1 text-slate-400">
                ({figures.filter(f => f.plotType === type).length})
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto text-xs text-textMuted">{filtered.length} shown</span>
      </div>

      {/* Gallery body */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-8">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64">
            <Loader2 size={36} className="text-primary animate-spin mb-4" />
            <p className="text-textMuted text-sm">Loading figure gallery…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="w-20 h-20 rounded-2xl bg-primary/10 border-2 border-primary/20 flex items-center justify-center mb-5">
              <BookImage size={36} className="text-primary/50" />
            </div>
            <h3 className="text-lg font-bold text-text mb-2">
              {filterType !== 'All' ? `No ${filterType} figures saved` : 'No figures yet'}
            </h3>
            <p className="text-textMuted text-sm max-w-xs">
              {filterType !== 'All'
                ? `Try selecting "All" or create a ${filterType} figure from the analysis tab.`
                : 'Click "Save Figure" in any analysis tab (UMAP, FeaturePlot, DotPlot, Heatmap, or Violin) to add figures here.'}
            </p>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {filtered.map(fig => (
              <FigureCard key={fig.id} figure={fig} onDelete={handleDelete} compact={false} />
            ))}
          </div>
        ) : (
          <div className="space-y-2 max-w-4xl">
            {filtered.map(fig => (
              <FigureCard key={fig.id} figure={fig} onDelete={handleDelete} compact={true} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
