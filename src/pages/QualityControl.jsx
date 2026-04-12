import React, { useState, useEffect } from 'react';
import { ShieldCheck, Activity, SlidersHorizontal, AlertTriangle, BarChart3, Info } from 'lucide-react';
import Plot from 'react-plotly.js';

// Shared dark-themed hover template style
const hoverStyle = {
  bgcolor: '#1e293b',
  bordercolor: '#475569',
  font: { color: '#e2e8f0', size: 12, family: 'Inter, system-ui' }
};

const PLOT_TABS = [
  { id: 'mt', label: 'Mitochondrial %' },
  { id: 'features', label: 'nFeature_RNA' },
  { id: 'counts', label: 'nCount_RNA' },
  { id: 'scatter', label: 'Feature Scatter' },
  { id: 'stats', label: 'Distribution Summary' },
];

export default function QualityControl({ callApi, datasetInfo, currentProvId, openProvenance, pipelineState, theme }) {
  const [filtering, setFiltering] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [activePlot, setActivePlot] = useState('mt');

  // Inject explicit CSS overrides to prevent Plotly from rendering layout-breaking double-arrow drag cursors when fixedrange is applied to 1 axis.
  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      .js-plotly-plot .plotly .cursor-crosshair,
      .js-plotly-plot .plotly .cursor-ns-resize, 
      .js-plotly-plot .plotly .cursor-ew-resize {
        cursor: crosshair !important;
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  // Real distribution data from the backend
  const [distributions, setDistributions] = useState(null);
  const [loadingDist, setLoadingDist] = useState(false);

  // Manual threshold state
  const [mtCutoff, setMtCutoff] = useState(5);
  const [minFeatures, setMinFeatures] = useState(200);
  const [maxFeatures, setMaxFeatures] = useState(5000);
  const [minCounts, setMinCounts] = useState(500);

  // Fetch real distributions when data is loaded
  const [showPoints, setShowPoints] = useState({ mt: true, features: true, counts: true });
  const [pointOpacity, setPointOpacity] = useState({ mt: 1.0, features: 1.0, counts: 1.0, scatter: 1.0 });
  const [zoomY, setZoomY] = useState(true);
  const [scatterX, setScatterX] = useState('nCount_RNA');
  const [scatterY, setScatterY] = useState('percent.mt');

  useEffect(() => {
    if (datasetInfo && !distributions && !loadingDist) {
      setLoadingDist(true);
      fetch('http://localhost:8000/qc-distributions')
        .then(r => r.json())
        .then(data => {
          if (data.error) {
            setError(data.error);
          } else {
            setDistributions(data);
          }
          setLoadingDist(false);
        })
        .catch(err => {
          setError('Failed to fetch QC distributions.');
          setLoadingDist(false);
        });
    }
  }, [datasetInfo]);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Activity size={48} className="mx-auto text-slate-600 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted">Load a dataset in the Workspace first.</p>
        </div>
      </div>
    );
  }

  const runFiltering = async () => {
    setFiltering(true);
    setError(null);

    const data = await callApi(`/qc?mt_threshold=${mtCutoff}&min_features=${minFeatures}&max_features=${maxFeatures}`, {}, {
      operation: 'quality-control',
      step: 'qc',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: false
    });

    if (!data) {
      setError('R backend error: QC filtering failed. Check the R console for details.');
      setFiltering(false);
      return;
    }
    if (data.error) {
      setError(data.error);
      setFiltering(false);
      return;
    }

    setResult(data);
    setFiltering(false);
  };

  // --- Compute stats from real distribution data ---
  const mtValues = distributions?.percent_mt || [];
  const featureValues = distributions?.nFeature_RNA || [];
  const countValues = distributions?.nCount_RNA || [];

  const median = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const stats = distributions ? {
    mt: [
      { label: 'Median', value: median(mtValues).toFixed(2) + '%' },
      { label: 'Mean', value: mean(mtValues).toFixed(2) + '%' },
      { label: 'Above Cutoff', value: mtValues.filter(v => v > mtCutoff).length }
    ],
    features: [
      { label: 'Median', value: Math.round(median(featureValues)).toLocaleString() },
      { label: 'Mean', value: Math.round(mean(featureValues)).toLocaleString() },
      { label: 'Outside Bounds', value: featureValues.filter(v => v < minFeatures || v > maxFeatures).length }
    ],
    counts: [
      { label: 'Median', value: Math.round(median(countValues)).toLocaleString() },
      { label: 'Mean', value: Math.round(mean(countValues)).toLocaleString() },
      { label: 'Low Counts', value: countValues.filter(v => v < minCounts).length }
    ],
    global: [
      { label: 'Total Cells', value: distributions.n_cells?.toLocaleString() || '—' },
      { label: 'Passing All', value: mtValues.filter((v, i) => v <= mtCutoff && featureValues[i] >= minFeatures && featureValues[i] <= maxFeatures && countValues[i] >= minCounts).length }
    ]
  } : null;

  const baseLayout = {
    autosize: true,
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: theme === 'light' ? '#475569' : '#94a3b8', size: 11, family: 'Inter, system-ui' },
    margin: { l: 60, r: 30, t: 20, b: 55 },
    showlegend: false,
    hoverlabel: hoverStyle,
    hovermode: 'closest',
    hoverdistance: 30,
    spikedistance: 30,
    uirevision: activePlot // Preserves user zoom across state changes!
  };

  const seuratViolin = (id, yvals, name, color, hover) => {
    const ymin = Math.min(...yvals);
    const ymax = Math.max(...yvals);
    const gridX = [];
    const gridY = [];

    // Inject a 25 x 800 dense invisible scattergl bounding grid.
    // This perfectly hacks Plotly into treating the entire plot 
    // container as a mathematically un-jittered Cartesian hover surface.
    for (let i = 0; i < 25; i++) {
      const cx = -0.5 + (i * 1.0 / 24);
      for (let j = 0; j < 800; j++) {
        gridX.push(cx);
        gridY.push(ymin + (ymax - ymin) * (j / 799));
      }
    }

    return [
      {
        type: 'violin',
        x: Array(yvals.length).fill(0),
        y: yvals,
        points: 'all',
        pointpos: 0,
        spanmode: 'hard',
        jitter: 1.0,
        marker: { size: 2, opacity: showPoints[id] ? pointOpacity[id] : 0, color: theme === 'light' ? '#000000' : '#ffffff' },
        fillcolor: color,
        line: { color: color, width: 2 },
        box: { visible: false },
        meanline: { visible: false },
        hoverinfo: 'skip',
        showlegend: false
      },
      {
        type: 'scattergl',
        x: gridX,
        y: gridY,
        mode: 'markers',
        marker: { size: 10, opacity: 0 },
        hovertemplate: hover,
        hoverlabel: { bgcolor: '#1e293b', font: { color: color, size: 12 } },
        showlegend: false
      }
    ];
  };

  const getValues = (metric) => metric === 'nCount_RNA' ? countValues : (metric === 'nFeature_RNA' ? featureValues : mtValues);

  const plotConfigs = distributions ? {
    mt: {
      data: [...seuratViolin('mt', mtValues, 'percent.mt', '#22c55e', 'percent.mt: <b>%{y:.2f}%</b><extra></extra>')],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        hoverdistance: -1,
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: '% MT', range: zoomY ? [-0.5, Math.max(mtCutoff * 1.5, 15)] : undefined, zeroline: false },
        shapes: [{ type: 'line', x0: -0.5, x1: 0.5, y0: mtCutoff, y1: mtCutoff, line: { color: '#f43f5e', dash: 'dash', width: 2 } }]
      },
      title: 'Mitochondrial Content', color: '#22c55e', hint: 'Cells extending past the upper cutoff (red bounds) are removed.'
    },
    features: {
      data: [...seuratViolin('features', featureValues, 'nFeature_RNA', '#a855f7', 'nFeature_RNA: <b>%{y:,.0f}</b><extra></extra>')],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        hoverdistance: -1,
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: 'nFeature_RNA', range: zoomY ? [0, Math.max(maxFeatures * 1.2, 5000)] : undefined, zeroline: false },
        shapes: [
          { type: 'line', x0: -0.5, x1: 0.5, y0: minFeatures, y1: minFeatures, line: { color: '#f43f5e', dash: 'dash', width: 2 } },
          { type: 'line', x0: -0.5, x1: 0.5, y0: maxFeatures, y1: maxFeatures, line: { color: '#f43f5e', dash: 'dash', width: 2 } }
        ]
      },
      title: 'Genes Detected (nFeature_RNA)', color: '#a855f7', hint: 'Cells falling outside the min/max bounds are removed.'
    },
    counts: {
      data: [...seuratViolin('counts', countValues, 'nCount_RNA', '#3b82f6', 'nCount_RNA: <b>%{y:,.0f}</b><extra></extra>')],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        hoverdistance: -1,
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: 'nCount_RNA', range: zoomY ? [0, Math.max(minCounts * 15, 20000)] : undefined, zeroline: false },
        shapes: [{ type: 'line', x0: -0.5, x1: 0.5, y0: minCounts, y1: minCounts, line: { color: '#f43f5e', dash: 'dash', width: 2 } }]
      },
      title: 'Library Size (nCount_RNA)', color: '#3b82f6', hint: 'Low count cells (left tail) are likely empty droplets or debris.'
    },
    scatter: {
      data: [{
        type: 'scattergl', mode: 'markers',
        x: getValues(scatterX), y: getValues(scatterY),
        marker: { size: 3, color: '#f43f5e', opacity: pointOpacity['scatter'] },
        hovertemplate: `${scatterX}: %{x}<br>${scatterY}: %{y}<extra></extra>`
      }],
      layout: {
        ...baseLayout,
        xaxis: { title: scatterX },
        yaxis: { title: scatterY },
      },
      title: 'Feature Relationships', color: '#f43f5e', hint: 'Scatter plots reveal correlations between sequencing depth and cell quality.'
    }
  } : {};

  const currentPlot = plotConfigs[activePlot];

  return (
    <div className="h-full w-full p-8 overflow-y-auto bg-background custom-scrollbar">
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-text mb-1 tracking-tight">Quality Control</h2>
          <p className="text-textMuted">Set filtering thresholds and inspect cell quality distributions.</p>
        </div>
        <div className="flex items-center gap-3">
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            >📝 View Step Script</button>
          )}
          <button
            onClick={runFiltering}
            disabled={filtering || !!result || !distributions}
            className={`btn ${result ? 'bg-success/20 text-success border border-success' : 'btn-primary'} flex items-center gap-2`}
          >
            {filtering && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {!filtering && result && <ShieldCheck size={18} />}
            {!filtering && !result && <SlidersHorizontal size={18} />}
            {result ? 'QC Applied' : 'Apply QC Filters'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Manual Threshold Controls */}
      {!result && (
        <div className="card p-6 mb-8 border-l-4 border-l-primary">
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-bold flex items-center gap-2 text-text">
              <SlidersHorizontal size={18} className="text-primary" /> Filtering Thresholds
            </h3>
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Manual Mode</span>
          </div>
          <div className="grid grid-cols-4 gap-6">
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Max MT %</label>
              <input type="number" step="0.5" value={mtCutoff}
                onChange={e => setMtCutoff(parseFloat(e.target.value) || 0)}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
              <p className="text-[10px] text-slate-500 mt-1">Cells above this % are removed</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Min Features</label>
              <input type="number" value={minFeatures}
                onChange={e => setMinFeatures(parseInt(e.target.value) || 0)}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
              <p className="text-[10px] text-slate-500 mt-1">nFeature_RNA lower bound</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Max Features</label>
              <input type="number" value={maxFeatures}
                onChange={e => setMaxFeatures(parseInt(e.target.value) || 0)}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
              <p className="text-[10px] text-slate-500 mt-1">nFeature_RNA upper bound</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Min Counts</label>
              <input type="number" value={minCounts}
                onChange={e => setMinCounts(parseInt(e.target.value) || 0)}
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
              <p className="text-[10px] text-slate-500 mt-1">nCount_RNA lower bound</p>
            </div>
          </div>
        </div>
      )}

      {/* Post-QC result summary */}
      {result && (
        <div className="card p-6 mb-8 border-t-4 border-t-success">
          <h3 className="font-semibold text-lg border-b border-border pb-3 mb-5 text-text">QC Filtering Summary</h3>
          <div className="grid grid-cols-4 gap-4 font-mono text-sm">
            <div className="p-4 bg-black/20 rounded text-center">
              <div className="text-[10px] text-textMuted uppercase mb-1">Post-Filter Cells</div>
              <div className="text-success font-bold text-xl">{result.result?.post_filter_cells?.toLocaleString() || '—'}</div>
            </div>
            <div className="p-4 bg-black/20 rounded text-center">
              <div className="text-[10px] text-textMuted uppercase mb-1">Removed (MT)</div>
              <div className="text-danger font-bold">{result.result?.removed_mt ?? '—'}</div>
            </div>
            <div className="p-4 bg-black/20 rounded text-center">
              <div className="text-[10px] text-textMuted uppercase mb-1">Removed (Features)</div>
              <div className="text-danger font-bold">{result.result?.removed_features ?? '—'}</div>
            </div>
            <div className="p-4 bg-black/20 rounded text-center">
              <div className="text-[10px] text-textMuted uppercase mb-1">Median MT %</div>
              <div className="text-text font-bold">{result.result?.median_mt ?? '—'}%</div>
            </div>
          </div>
          <p className="text-xs text-textMuted mt-4 italic">{result.result?.message}</p>
        </div>
      )}

      {/* Tabbed Plot Viewer */}
      <div className="card overflow-hidden">
        {/* Tab bar */}
        <div className="flex border-b border-border bg-black/5 dark:bg-white/5 px-4 pt-2 gap-1">
          {PLOT_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActivePlot(tab.id)}
              className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-all border-b-2 -mb-[1px]
                ${activePlot === tab.id
                  ? 'text-primary border-primary bg-background/40'
                  : 'text-slate-500 border-transparent hover:text-slate-300 hover:border-slate-600'
                }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Plot area */}
        <div className="p-6">
          {loadingDist ? (
            <div className="flex flex-col items-center justify-center h-[420px] space-y-4">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
              <p className="text-textMuted font-medium animate-pulse">Computing QC distributions from Seurat object...</p>
            </div>
          ) : !distributions ? (
            <div className="flex items-center justify-center h-[420px] text-slate-500 text-sm">
              No distribution data available. Load a dataset first.
            </div>
          ) : activePlot === 'stats' ? (
            <div>
              <h3 className="text-sm font-bold text-text mb-6 flex items-center gap-2">
                <Info size={16} className="text-primary" />
                Distribution Summary
              </h3>

              <div className="space-y-6">
                <div className="grid grid-cols-4 gap-4">
                  {/* Mitochondrial Block */}
                  <div className="col-span-1 p-4 bg-black/20 rounded-xl border border-border">
                    <h4 className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">percent.mt</h4>
                    <div className="space-y-3">
                      {stats.mt.map((s, i) => (
                        <div key={i} className="flex justify-between items-center bottom-border pb-1 border-border/30">
                          <span className="text-[10px] text-textMuted uppercase">{s.label}</span>
                          <span className="text-sm font-bold text-text font-mono">{s.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Features Block */}
                  <div className="col-span-1 p-4 bg-black/20 rounded-xl border border-border">
                    <h4 className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">nFeature_RNA</h4>
                    <div className="space-y-3">
                      {stats.features.map((s, i) => (
                        <div key={i} className="flex justify-between items-center bottom-border pb-1 border-border/30">
                          <span className="text-[10px] text-textMuted uppercase">{s.label}</span>
                          <span className="text-sm font-bold text-text font-mono">{s.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Counts Block */}
                  <div className="col-span-1 p-4 bg-black/20 rounded-xl border border-border">
                    <h4 className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">nCount_RNA</h4>
                    <div className="space-y-3">
                      {stats.counts.map((s, i) => (
                        <div key={i} className="flex justify-between items-center bottom-border pb-1 border-border/30">
                          <span className="text-[10px] text-textMuted uppercase">{s.label}</span>
                          <span className="text-sm font-bold text-text font-mono">{s.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Global Block */}
                  <div className="col-span-1 p-4 bg-primary/5 rounded-xl border border-primary/20">
                    <h4 className="text-xs font-bold text-primary mb-3 uppercase tracking-wider">Overall Status</h4>
                    <div className="space-y-3">
                      {stats.global.map((s, i) => (
                        <div key={i} className="flex justify-between items-center bottom-border pb-1 border-border/30">
                          <span className="text-[10px] text-primary/70 uppercase">{s.label}</span>
                          <span className="text-sm font-bold text-primary font-mono">{s.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : currentPlot && (
            <div className="flex gap-8">
              {/* Plot Column */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: currentPlot.color }}></div>
                    <h3 className="text-sm font-bold text-text">{currentPlot.title}</h3>
                  </div>
                  {['mt', 'features', 'counts'].includes(activePlot) && (
                    <div className="flex items-center gap-5">
                      <label className="flex items-center gap-2 text-xs text-textMuted cursor-pointer hover:text-text transition-colors">
                        <input type="checkbox" checked={zoomY} onChange={e => setZoomY(e.target.checked)} title="Stretch the Y-axis to ignore extreme upper outliers" className="rounded border-slate-600 bg-slate-800 text-primary focus:ring-primary focus:ring-offset-slate-900" />
                        Stretch Vertical (Zoom)
                      </label>
                      <div className="flex items-center gap-3 bg-black/5 dark:bg-black/10 px-3 py-1 rounded-full border border-border/50">
                        <label className="flex items-center gap-2 text-xs text-textMuted cursor-pointer hover:text-text transition-colors">
                          <input type="checkbox" checked={showPoints[activePlot]} onChange={e => setShowPoints({ ...showPoints, [activePlot]: e.target.checked })} className="rounded border-slate-600 bg-slate-800 text-primary focus:ring-primary focus:ring-offset-slate-900" />
                          Show dots
                        </label>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-end">
                    {['mt', 'features', 'counts', 'scatter'].includes(activePlot) && (showPoints[activePlot] || activePlot === 'scatter') && (
                      <div className="flex items-center gap-2 border border-border/50 rounded-full px-3 py-1 bg-black/5 dark:bg-black/10 mr-4">
                        <span className="text-[10px] text-textMuted uppercase tracking-wider">Opacity</span>
                        <input
                          type="range" min="0.05" max="1" step="0.05"
                          value={pointOpacity[activePlot]} onChange={e => setPointOpacity({ ...pointOpacity, [activePlot]: parseFloat(e.target.value) })}
                          className="w-16 accent-primary"
                        />
                      </div>
                    )}
                    {activePlot === 'scatter' && (
                      <div className="flex items-center gap-3 text-xs text-textMuted font-medium">
                        <span>X Axis:</span>
                        <select className="bg-surface border border-border rounded text-text p-1 px-2 focus:ring-1 focus:ring-primary focus:outline-none" value={scatterX} onChange={e => setScatterX(e.target.value)}>
                          <option value="nCount_RNA">nCount_RNA</option>
                          <option value="nFeature_RNA">nFeature_RNA</option>
                          <option value="percent.mt">percent.mt</option>
                        </select>
                        <span className="ml-2">Y Axis:</span>
                        <select className="bg-surface border border-border rounded text-text p-1 px-2 focus:ring-1 focus:ring-primary focus:outline-none" value={scatterY} onChange={e => setScatterY(e.target.value)}>
                          <option value="nCount_RNA">nCount_RNA</option>
                          <option value="nFeature_RNA">nFeature_RNA</option>
                          <option value="percent.mt">percent.mt</option>
                        </select>
                      </div>
                    )}
                  </div>
                </div>
                <div className="h-[500px] bg-black/10 border border-border/50 rounded-xl relative">
                  <Plot
                    data={currentPlot.data}
                    layout={currentPlot.layout}
                    config={{ displayModeBar: false, responsive: true }}
                    className="w-full h-full"
                    useResizeHandler
                  />
                </div>
                <p className="text-xs text-textMuted mt-3 italic">{currentPlot.hint}</p>
              </div>

              {/* Side Panel for Individual Violin Plots */}
              {['mt', 'features', 'counts'].includes(activePlot) && (
                <div className="w-64 flex-shrink-0 flex flex-col gap-3">
                  <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                    <Info size={16} className="text-primary" />
                    Related Statistics
                  </h3>
                  {stats[activePlot]?.map((s, i) => (
                    <div key={i} className="p-3 bg-black/20 rounded-xl border border-border">
                      <div className="text-[10px] text-textMuted uppercase font-bold tracking-wider mb-1">{s.label}</div>
                      <div className="text-base font-bold text-white font-mono">{s.value}</div>
                    </div>
                  ))}
                  <div className="p-3 bg-primary/10 rounded-xl border border-primary/20 mt-2">
                    <div className="text-[10px] text-primary/70 uppercase font-bold tracking-wider mb-1">Total Dataset Size</div>
                    <div className="text-base font-bold text-primary font-mono">{stats.global[0].value}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
