import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Image, Download, RefreshCw, ChevronDown, ChevronRight,
  Type, Palette, Settings2, Layers, Loader2, CheckCircle2, AlertCircle
} from 'lucide-react';

const PALETTES = [
  { name: 'Set2',    label: 'Set2 (Default)',    colors: ['#66c2a5','#fc8d62','#8da0cb','#e78ac3','#a6d854'] },
  { name: 'Set1',    label: 'Set1 (High Contrast)', colors: ['#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00'] },
  { name: 'Paired',  label: 'Paired',             colors: ['#a6cee3','#1f78b4','#b2df8a','#33a02c','#fb9a99'] },
  { name: 'Dark2',   label: 'Dark2',              colors: ['#1b9e77','#d95f02','#7570b3','#e7298a','#66a61e'] },
  { name: 'Spectral',label: 'Spectral (Diverging)', colors: ['#d53e4f','#fc8d59','#fee08b','#e6f598','#3288bd'] },
  { name: 'npg',     label: 'NPG (Nature)',        colors: ['#e64b35','#4dbbd5','#00a087','#3c5488','#f39b7f'] },
  { name: 'nejm',    label: 'NEJM',               colors: ['#bc3c29','#0072b5','#e18727','#20854e','#7876b1'] },
  { name: 'lancet',  label: 'Lancet',             colors: ['#00468b','#ed0000','#42b540','#0099b4','#925e9f'] },
  { name: 'jama',    label: 'JAMA',               colors: ['#374e55','#df8f44','#00a1d5','#b24745','#79af97'] },
];

const LEGEND_POS = ['right', 'bottom', 'none', 'top', 'left'];

function CollapsibleSection({ title, icon: Icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border/50 rounded-lg overflow-hidden mb-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 bg-surface/60 hover:bg-surface text-left transition-colors"
      >
        {Icon && <Icon size={14} className="text-primary shrink-0" />}
        <span className="text-xs font-bold text-text uppercase tracking-wider flex-1">{title}</span>
        {open ? <ChevronDown size={14} className="text-textMuted" /> : <ChevronRight size={14} className="text-textMuted" />}
      </button>
      {open && <div className="p-4 space-y-4">{children}</div>}
    </div>
  );
}

function SliderRow({ label, value, min, max, step = 0.1, onChange, hint }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <label className="text-xs text-textMuted font-medium">{label}</label>
        <span className="text-xs font-mono text-primary">{value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full accent-primary"
      />
      {hint && <p className="text-[10px] text-slate-500 mt-0.5">{hint}</p>}
    </div>
  );
}

function FieldRow({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <div>
      <label className="block text-xs text-textMuted font-medium mb-1">{label}</label>
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(type === 'number' ? parseFloat(e.target.value) : e.target.value)}
        className="w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-text focus:outline-none focus:border-primary"
      />
    </div>
  );
}

export default function FigureSavePanel({
  isOpen,
  onClose,
  plotType,         // 'UMAP' | 'FeaturePlot' | 'DotPlot' | 'Heatmap' | 'Violin'
  baseParams = {},  // { features: [], groupBy: 'seurat_clusters', ... }
  userEmail = '',
  objectId = '',
  onSaved,          // callback(figureRecord)
}) {
  // ── Label params ────────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [xLabel, setXLabel] = useState('');
  const [yLabel, setYLabel] = useState('');

  // ── Appearance ──────────────────────────────────────────────────
  const [ptSize, setPtSize] = useState(1.0);
  const [alpha, setAlpha] = useState(1.0);
  const [doLabel, setDoLabel] = useState(true);
  const [labelSize, setLabelSize] = useState(4);
  const [repel, setRepel] = useState(true);
  const [legendPos, setLegendPos] = useState('right');
  const [fontSize, setFontSize] = useState(12);
  const [palette, setPalette] = useState('Set2');
  const [dotScale, setDotScale] = useState(6);
  const [logScale, setLogScale] = useState(false);

  // ── Advanced ────────────────────────────────────────────────────
  const [dpi, setDpi] = useState(300);
  const [format, setFormat] = useState('png');
  const [width, setWidth] = useState(8);
  const [height, setHeight] = useState(6);
  const [splitBy, setSplitBy] = useState('');
  const [ncol, setNcol] = useState('');

  // ── Preview state ───────────────────────────────────────────────
  const [previewB64, setPreviewB64] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  // ── Save state ──────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(null);
  const [saveError, setSaveError] = useState(null);

  const debounceRef = useRef(null);

  // Build params object for R
  const buildParams = useCallback(() => ({
    plot_type:       plotType,
    group_by:        baseParams.groupBy || 'seurat_clusters',
    features:        baseParams.features || [],
    title,
    subtitle,
    x_label:         xLabel || null,
    y_label:         yLabel || null,
    pt_size:         ptSize,
    alpha,
    label:           doLabel,
    label_size:      labelSize,
    repel,
    legend_position: legendPos,
    font_size:       fontSize,
    color_palette:   palette,
    dot_scale:       dotScale,
    log_scale:       logScale,
    split_by:        splitBy || null,
    ncol:            ncol ? parseInt(ncol) : null,
  }), [plotType, baseParams, title, subtitle, xLabel, yLabel,
       ptSize, alpha, doLabel, labelSize, repel, legendPos,
       fontSize, palette, dotScale, logScale, splitBy, ncol]);

  // ── Auto-refresh preview (debounced 800ms) ───────────────────────
  const refreshPreview = useCallback(async (params) => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const data = await window.electronAPI.apiRequest('/export-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      if (data.error) throw new Error(data.error);
      if (data.result?.base64) setPreviewB64(data.result.base64);
    } catch (e) {
      setPreviewError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  // Trigger debounced refresh on any param change
  useEffect(() => {
    if (!isOpen) return;
    const params = buildParams();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => refreshPreview(params), 800);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [buildParams, isOpen, refreshPreview]);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setPreviewB64(null);
      setSaveSuccess(null);
      setSaveError(null);
    }
  }, [isOpen]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    const params = buildParams();
    const exportParams = { ...params, format, width, height, dpi };

    try {
      const data = await window.electronAPI.apiRequest('/export-figure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exportParams),
      });
      if (data.error) throw new Error(data.error);

      const result = data.result;

      // Persist to figure gallery via Electron IPC
      const record = {
        id:           `fig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userEmail:    userEmail,
        objectId:     objectId,
        plotType:     plotType,
        title:        title || plotType,
        params:       exportParams,
        filePath:     result.file_path || '',
        fileFormat:   format,
        thumbnailB64: result.thumbnail_b64 || previewB64 || '',
      };

      if (window.electronAPI?.saveFigure) {
        await window.electronAPI.saveFigure(record);
      }

      setSaveSuccess(`Saved as ${result.file_name}`);
      if (onSaved) onSaved(record);
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const isUMAP       = plotType === 'UMAP';

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-[900px] max-w-[95vw] bg-background border-l border-border flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0 bg-surface">
          <div className="flex items-center gap-3">
            <Image size={20} className="text-primary" />
            <div>
              <h3 className="font-bold text-text text-sm">Save to Figure Gallery</h3>
              <p className="text-[11px] text-textMuted">{plotType} · Publication-quality export</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close figure editor" className="text-textMuted hover:text-text transition-colors p-1 rounded hover:bg-white/10">
            <X size={18} />
          </button>
        </div>

        {/* Body: params (left) + preview (right) */}
        <div className="flex-1 flex min-h-0">
          {/* Left: parameter controls */}
          <div className="w-72 flex-shrink-0 overflow-y-auto custom-scrollbar p-4 border-r border-border">

            <CollapsibleSection title="Labels" icon={Type}>
              <FieldRow label="Title" value={title} onChange={setTitle} placeholder={plotType} />
              <FieldRow label="Subtitle" value={subtitle} onChange={setSubtitle} placeholder="Optional subtitle" />
              <FieldRow label="X-Axis Label" value={xLabel} onChange={setXLabel} placeholder="Auto" />
              <FieldRow label="Y-Axis Label" value={yLabel} onChange={setYLabel} placeholder="Auto" />
              {isUMAP && (
                <div className="space-y-3 pt-1 border-t border-border/30">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-textMuted font-medium">Cluster Labels</label>
                    <button
                      onClick={() => setDoLabel(v => !v)}
                      className={`relative w-10 h-5 rounded-full transition-colors ${doLabel ? 'bg-primary' : 'bg-slate-600'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${doLabel ? 'translate-x-5' : ''}`} />
                    </button>
                  </div>
                  {doLabel && (
                    <>
                      <SliderRow label="Label Size" value={labelSize} min={2} max={10} step={0.5} onChange={setLabelSize} />
                      <div className="flex items-center justify-between">
                        <label className="text-xs text-textMuted font-medium">Repel Labels</label>
                        <button
                          onClick={() => setRepel(v => !v)}
                          className={`relative w-10 h-5 rounded-full transition-colors ${repel ? 'bg-primary' : 'bg-slate-600'}`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${repel ? 'translate-x-5' : ''}`} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </CollapsibleSection>

            <CollapsibleSection title="Appearance" icon={Palette}>
              {/* Color palette picker */}
              <div>
                <label className="block text-xs text-textMuted font-medium mb-2">Color Palette</label>
                <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                  {PALETTES.map(p => (
                    <button
                      key={p.name}
                      onClick={() => setPalette(p.name)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-all border ${
                        palette === p.name
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-transparent hover:border-border text-textMuted hover:text-text'
                      }`}
                    >
                      <div className="flex gap-0.5 shrink-0">
                        {p.colors.map((c, i) => (
                          <div key={i} className="w-3 h-3 rounded-sm" style={{ backgroundColor: c }} />
                        ))}
                      </div>
                      <span className="text-[11px] font-medium truncate">{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {isUMAP && (
                <SliderRow label="Point Size" value={ptSize} min={0.1} max={5} step={0.1} onChange={setPtSize} hint="pt.size in DimPlot" />
              )}
              <SliderRow label="Point Alpha" value={alpha} min={0.1} max={1} step={0.05} onChange={setAlpha} hint="Transparency (1 = opaque)" />
              <SliderRow label="Base Font Size" value={fontSize} min={8} max={24} step={1} onChange={setFontSize} />

              {/* Legend position */}
              <div>
                <label className="block text-xs text-textMuted font-medium mb-2">Legend Position</label>
                <div className="flex flex-wrap gap-1.5">
                  {LEGEND_POS.map(p => (
                    <button
                      key={p}
                      onClick={() => setLegendPos(p)}
                      className={`px-2 py-1 rounded text-[11px] font-medium capitalize border transition-all ${
                        legendPos === p
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-textMuted hover:text-text'
                      }`}
                    >{p}</button>
                  ))}
                </div>
              </div>

              {plotType === 'DotPlot' && (
                <SliderRow label="Dot Scale" value={dotScale} min={1} max={20} step={1} onChange={setDotScale} hint="Max dot diameter" />
              )}
              {plotType === 'FeaturePlot' && (
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-xs text-textMuted font-medium">Log Scale Colors</label>
                    <p className="text-[10px] text-slate-500">log_scale in FeaturePlot</p>
                  </div>
                  <button
                    onClick={() => setLogScale(v => !v)}
                    className={`relative w-10 h-5 rounded-full transition-colors ${logScale ? 'bg-primary' : 'bg-slate-600'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${logScale ? 'translate-x-5' : ''}`} />
                  </button>
                </div>
              )}
            </CollapsibleSection>

            <CollapsibleSection title="Export Settings" icon={Settings2} defaultOpen={false}>
              {/* Format */}
              <div>
                <label className="block text-xs text-textMuted font-medium mb-2">Format</label>
                <div className="flex gap-1.5">
                  {['png','pdf','svg'].map(f => (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      className={`flex-1 py-1.5 rounded text-xs font-bold uppercase border transition-all ${
                        format === f ? 'border-primary bg-primary/10 text-primary' : 'border-border text-textMuted'
                      }`}
                    >{f}</button>
                  ))}
                </div>
              </div>
              {/* DPI - only for png */}
              {format === 'png' && (
                <div>
                  <label className="block text-xs text-textMuted font-medium mb-2">Resolution (DPI)</label>
                  <div className="flex gap-1.5">
                    {[150, 300, 600].map(d => (
                      <button
                        key={d}
                        onClick={() => setDpi(d)}
                        className={`flex-1 py-1.5 rounded text-xs font-bold border transition-all ${
                          dpi === d ? 'border-primary bg-primary/10 text-primary' : 'border-border text-textMuted'
                        }`}
                      >{d}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <FieldRow label="Width (in)" value={width} onChange={setWidth} type="number" />
                <FieldRow label="Height (in)" value={height} onChange={setHeight} type="number" />
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Split / Multi-panel" icon={Layers} defaultOpen={false}>
              <FieldRow
                label="Split By (metadata column)"
                value={splitBy}
                onChange={setSplitBy}
                placeholder="e.g. sample_id"
              />
              <FieldRow
                label="Columns (ncol)"
                value={ncol}
                onChange={setNcol}
                type="number"
                placeholder="Auto"
              />
            </CollapsibleSection>
          </div>

          {/* Right: preview */}
          <div className="flex-1 flex flex-col min-w-0 p-5">
            {/* Preview card — white background mimics publication */}
            <div className="flex-1 relative flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold text-textMuted uppercase tracking-wider">Preview (white background)</span>
                <button
                  onClick={() => refreshPreview(buildParams())}
                  disabled={previewLoading}
                  className="flex items-center gap-1.5 text-xs text-primary hover:text-white border border-primary/40 hover:border-primary px-2.5 py-1.5 rounded transition-all"
                >
                  <RefreshCw size={12} className={previewLoading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>

              <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-inner flex items-center justify-center relative overflow-hidden min-h-0">
                {previewLoading && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 z-10">
                    <Loader2 size={28} className="text-primary animate-spin mb-2" />
                    <p className="text-slate-500 text-xs font-medium">Rendering preview…</p>
                  </div>
                )}
                {previewError && !previewLoading && (
                  <div className="text-center p-6 text-slate-500">
                    <AlertCircle size={32} className="mx-auto mb-2 text-amber-500" />
                    <p className="text-xs font-medium text-slate-600 mb-1">Preview failed</p>
                    <p className="text-[11px] text-slate-400">{previewError}</p>
                  </div>
                )}
                {previewB64 && !previewError && (
                  <img
                    src={previewB64}
                    alt="Plot preview"
                    className="max-w-full max-h-full object-contain"
                  />
                )}
                {!previewB64 && !previewLoading && !previewError && (
                  <div className="text-center text-slate-400 p-6">
                    <Image size={40} className="mx-auto mb-3 opacity-30" />
                    <p className="text-xs">Preview will appear here after R renders it</p>
                  </div>
                )}
              </div>
            </div>

            {/* Save button + status */}
            <div className="mt-4 space-y-2 shrink-0">
              {saveSuccess && (
                <div className="flex items-center gap-2 text-success text-xs p-2.5 bg-success/10 border border-success/30 rounded-lg">
                  <CheckCircle2 size={14} />
                  <span>{saveSuccess}</span>
                </div>
              )}
              {saveError && (
                <div className="flex items-center gap-2 text-danger text-xs p-2.5 bg-danger/10 border border-danger/30 rounded-lg">
                  <AlertCircle size={14} />
                  <span>{saveError}</span>
                </div>
              )}
              <button
                onClick={handleSave}
                disabled={saving || previewLoading || !previewB64 || Boolean(previewError)}
                className="w-full btn btn-primary h-12 flex items-center justify-center gap-2 text-sm font-bold"
              >
                {saving
                  ? <><Loader2 size={16} className="animate-spin" /> Saving…</>
                  : <><Download size={16} /> Save to Figure Gallery</>
                }
              </button>
              <p className="text-[10px] text-slate-500 text-center">
                Saves figure metadata and preview to the gallery; no public download route is created
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
