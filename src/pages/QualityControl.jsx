import React, { useState, useEffect } from 'react';
import { ShieldCheck, Activity, SlidersHorizontal, AlertTriangle, BarChart3, Info, Scissors, Check } from 'lucide-react';
import Plot from 'react-plotly.js';
import { useTabParams } from '../hooks/useTabParams';
import { usePipelineStep } from '../hooks/usePipelineStep';

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

function qcUnavailableMessage(rawError, { datasetInfo, sessionReady } = {}) {
  if (!datasetInfo) return 'Load a dataset in the Workspace first.';
  if (!sessionReady) {
    return 'A dataset is selected, but the live R session is not ready. Reload or restore the session before running QC.';
  }

  const message = String(rawError || '').trim();
  if (/analysis object not found/i.test(message)) {
    return 'This analysis object exists in project history, but its live R session is not currently attached. Reload the demo object or load a checkpoint when checkpoint restore is wired for this workflow.';
  }
  if (/no object loaded|load data first/i.test(message)) {
    return 'This analysis object exists in project history, but its live R session is not currently attached. Reload the demo object to continue interactive analysis.';
  }
  return message || 'QC distribution data is unavailable for the selected object.';
}

export default function QualityControl({ callApi, datasetInfo, currentProvId, openProvenance, pipelineState, theme, rSessionId, userEmail, objectId, sessionReady }) {
  const [activePlot, setActivePlot] = useState('mt');



  // Real distribution data from the backend
  const [distributions, setDistributions] = useState(null);
  const [loadingDist, setLoadingDist] = useState(false);

  // Persisted threshold state
  const [params, setParam] = useTabParams('qc', userEmail, objectId, {
    mtCutoff: 5,
    minFeatures: 200,
    maxFeatures: 5000,
    minCounts: 500,
  });
  const { mtCutoff, minFeatures, maxFeatures, minCounts, removeDoublets, filterFeatures } = params;

  // Fetch real distributions when data is loaded
  const [showPoints, setShowPoints] = useState({ mt: true, features: true, counts: true });
  const [pointOpacity, setPointOpacity] = useState({ mt: 1.0, features: 1.0, counts: 1.0, scatter: 1.0 });
  const [zoomY, setZoomY] = useState(true);
  const [scatterX, setScatterX] = useState('nCount_RNA');
  const [scatterY, setScatterY] = useState('percent.mt');


  useEffect(() => {
    if (datasetInfo && !sessionReady) {
      setDistributions(null);
      setError(qcUnavailableMessage(null, { datasetInfo, sessionReady }));
      return;
    }

    if (datasetInfo && !loadingDist) {
      // Re-fetch distributions when the R session changes (e.g. after session restore)
      // so a failed early fetch (before session restore) doesn't persist.
      setLoadingDist(true);
      setDistributions(null);
      callApi('/qc-distributions', {}, { useCache: false })
        .then(data => {
          if (data.error) {
            setError(qcUnavailableMessage(data.error, { datasetInfo, sessionReady }));
          } else {
            setDistributions(data);
            setError(null); // clear any previous 'no object' error
          }
          setLoadingDist(false);
        })
        .catch(err => {
          setError('Failed to fetch QC distributions.');
          setLoadingDist(false);
        });
    }
  // rSessionId triggers re-fetch when session is restored
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetInfo, rSessionId, sessionReady]);

  const mtCutoffNum = parseFloat(mtCutoff) || 0;
  const minFeatNum = parseInt(minFeatures) || 0;
  const maxFeatNum = parseInt(maxFeatures) || 0;
  const minCountsNum = parseInt(minCounts) || 0;

  const endpoint = '/qc';
  const qcPayload = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mt_threshold: mtCutoffNum,
      min_features: minFeatNum,
      max_features: maxFeatNum,
      min_counts: minCountsNum,
      remove_doublets: removeDoublets,
      filter_features: filterFeatures
    })
  };

  const { running: filtering, result, error, setError, runStep: runFiltering } = usePipelineStep({
    callApi,
    endpoint,
    payload: qcPayload,
    ipcContext: {
      operation: 'quality-control',
      step: 'qc',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: false,
      cacheParams: { type: 'qc', mtCutoffNum, minFeatNum, maxFeatNum, minCountsNum, removeDoublets, filterFeatures }
    },
    autoHydrate: false, // QC is manually triggered
    sessionReady,
    rSessionId
  });

  // --- Compute stats from real distribution data ---
  const mtValues = distributions?.percent_mt || [];
  const featureValues = distributions?.nFeature_RNA || [];
  const countValues = distributions?.nCount_RNA || [];

  const mtJitter = React.useMemo(() => mtValues.map(() => (Math.random() - 0.5) * 0.4), [mtValues]);
  const featureJitter = React.useMemo(() => featureValues.map(() => (Math.random() - 0.5) * 0.4), [featureValues]);
  const countJitter = React.useMemo(() => countValues.map(() => (Math.random() - 0.5) * 0.4), [countValues]);

  // Guard rendering AFTER all hooks so the hook call order stays stable across
  // renders (React rules-of-hooks). Returning before usePipelineStep / the useMemo
  // calls above would change the hook count when datasetInfo toggles (e.g. logout,
  // project switch, or clearing the selected object) and crash the page.
  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Activity size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted">Load a dataset in the Workspace first.</p>
        </div>
      </div>
    );
  }

  const median = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const stats = distributions ? {
    mt: [
      { label: 'Median', value: median(mtValues).toFixed(2) + '%' },
      { label: 'Mean', value: mean(mtValues).toFixed(2) + '%' },
      { label: 'Above Cutoff', value: mtValues.filter(v => v > mtCutoffNum).length }
    ],
    features: [
      { label: 'Median', value: Math.round(median(featureValues)).toLocaleString() },
      { label: 'Mean', value: Math.round(mean(featureValues)).toLocaleString() },
      { label: 'Outside Bounds', value: featureValues.filter(v => v < minFeatNum || v > maxFeatNum).length }
    ],
    counts: [
      { label: 'Median', value: Math.round(median(countValues)).toLocaleString() },
      { label: 'Mean', value: Math.round(mean(countValues)).toLocaleString() },
      { label: 'Low Counts', value: countValues.filter(v => v < minCountsNum).length }
    ],
    global: [
      { label: 'Total Cells', value: distributions.n_cells?.toLocaleString() || '—' },
      { label: 'Passing All', value: mtValues.filter((v, i) => v <= mtCutoffNum && featureValues[i] >= minFeatNum && featureValues[i] <= maxFeatNum && countValues[i] >= minCountsNum).length }
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

  const seuratViolin = (id, yvals, name, color, hover, jitteredX) => {
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

    // JitteredX is precomputed and passed in.

    return [
      {
        type: 'violin',
        x: Array(yvals.length).fill(0),
        y: yvals,
        points: false,
        spanmode: 'hard',
        fillcolor: color,
        line: { color: color, width: 2 },
        box: { visible: false },
        meanline: { visible: false },
        hoverinfo: 'skip',
        showlegend: false
      },
      ...(showPoints[id] ? [{
        type: 'scattergl',
        x: jitteredX,
        y: yvals,
        mode: 'markers',
        marker: { size: 2, opacity: pointOpacity[id], color: theme === 'light' ? '#000000' : '#ffffff' },
        hoverinfo: 'skip',
        showlegend: false
      }] : []),
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
      data: [...seuratViolin('mt', mtValues, 'percent.mt', '#22c55e', 'percent.mt: <b>%{y:.2f}%</b><extra></extra>', mtJitter)],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        hoverdistance: -1,
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: '% MT', autorange: true, zeroline: false },
        shapes: [{ type: 'line', x0: -0.5, x1: 0.5, y0: mtCutoff, y1: mtCutoff, line: { color: '#f43f5e', dash: 'dash', width: 2 } }]
      },
      title: 'Mitochondrial Content', color: '#22c55e', hint: 'Cells extending past the upper cutoff (red bounds) are removed.'
    },
    features: {
      data: [...seuratViolin('features', featureValues, 'nFeature_RNA', '#a855f7', 'nFeature_RNA: <b>%{y:,.0f}</b><extra></extra>', featureJitter)],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        hoverdistance: -1,
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: 'nFeature_RNA', autorange: true, zeroline: false },
        shapes: [
          { type: 'line', x0: -0.5, x1: 0.5, y0: minFeatures, y1: minFeatures, line: { color: '#f43f5e', dash: 'dash', width: 2 } },
          { type: 'line', x0: -0.5, x1: 0.5, y0: maxFeatures, y1: maxFeatures, line: { color: '#f43f5e', dash: 'dash', width: 2 } }
        ]
      },
      title: 'Genes Detected (nFeature_RNA)', color: '#a855f7', hint: 'Cells falling outside the min/max bounds are removed.'
    },
    counts: {
      data: [...seuratViolin('counts', countValues, 'nCount_RNA', '#3b82f6', 'nCount_RNA: <b>%{y:,.0f}</b><extra></extra>', countJitter)],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        hoverdistance: -1,
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: 'nCount_RNA', autorange: true, zeroline: false },
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
            disabled={filtering || !distributions}
            className={`btn ${(result || pipelineState?.qc) ? 'bg-success/20 text-success border border-success hover:bg-success/30' : 'btn-primary'} flex items-center gap-2`}
          >
            {filtering && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {!filtering && (result || pipelineState?.qc) && <ShieldCheck size={18} />}
            {!filtering && !result && !pipelineState?.qc && <SlidersHorizontal size={18} />}
            {filtering ? 'Applying...' : (result || pipelineState?.qc) ? 'Re-run QC Filters' : 'Apply QC Filters'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Summary Statistics Card */}
      {(result || pipelineState?.qcSummary || pipelineState?.qc) && (
        <div className={`card p-6 mb-6 border-t-4 ${result ? 'border-t-success' : 'border-t-primary/50'}`}>
          <div className="flex items-center justify-between mb-5 border-b border-border pb-3">
            <h3 className="font-semibold text-lg text-text">
              {result ? 'QC Filtering Summary' : 'QC Metrics Applied'}
            </h3>
            {(pipelineState?.isSubset || datasetInfo?.parentObjId) && !result && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-primary/10 text-primary text-[10px] font-bold rounded border border-primary/20 uppercase tracking-wider">
                <Scissors size={10} /> Subset Inherited
              </div>
            )}
          </div>

          <div className="grid grid-cols-5 gap-4 font-mono text-sm">
            {(result?.result || pipelineState?.qcSummary) ? (
              <>
                {/* Detailed stats from a fresh run or persisted summary */}
                {(() => {
                  const s = result?.result || pipelineState.qcSummary;
                  return (
                    <>
                      <div className="p-4 bg-black/20 rounded text-center">
                        <div className="text-[10px] text-textMuted uppercase mb-1 font-bold">Post-Filter Cells</div>
                        <div className="text-success font-black text-xl">{s.post_filter_cells?.toLocaleString() || '—'}</div>
                      </div>
                      <div className="p-4 bg-black/20 rounded text-center border border-border/5">
                        <div className="text-[10px] text-textMuted uppercase mb-1">Removed (MT)</div>
                        <div className="text-danger font-bold">{s.removed_mt ?? '—'}</div>
                      </div>
                      <div className="p-4 bg-black/20 rounded text-center border border-border/5">
                        <div className="text-[10px] text-textMuted uppercase mb-1">Removed (Features)</div>
                        <div className="text-danger font-bold">{s.removed_features ?? '—'}</div>
                      </div>
                      <div className="p-4 bg-black/20 rounded text-center border border-border/5">
                        <div className="text-[10px] text-textMuted uppercase mb-1">Removed (Counts)</div>
                        <div className="text-danger font-bold">{s.removed_counts ?? '—'}</div>
                      </div>
                      <div className="p-4 bg-black/20 rounded text-center border border-border/5">
                        <div className="text-[10px] text-textMuted uppercase mb-1 font-bold">Median MT %</div>
                        <div className="text-text font-black">{s.median_mt ?? '—'}%</div>
                      </div>
                    </>
                  );
                })()}
              </>
            ) : (
              <>
                {/* Fallback: Current Median Stats if no specific QC run was recorded for this object */}
                <div className="p-4 bg-black/20 rounded text-center border border-primary/20">
                  <div className="text-[10px] text-textMuted uppercase mb-1 font-bold">Total Cells</div>
                  <div className="text-primary font-black text-xl">{distributions?.n_cells?.toLocaleString() || '—'}</div>
                </div>
                <div className="p-4 bg-black/20 rounded text-center border border-border/5">
                  <div className="text-[10px] text-textMuted uppercase mb-1 font-bold">Median MT</div>
                  <div className="text-text font-bold">{stats?.mt[0].value || '—'}</div>
                </div>
                <div className="p-4 bg-black/20 rounded text-center border border-border/5">
                  <div className="text-[10px] text-textMuted uppercase mb-1 font-bold">Median Features</div>
                  <div className="text-text font-bold">{stats?.features[0].value || '—'}</div>
                </div>
                <div className="p-4 bg-black/20 rounded text-center border border-border/5">
                  <div className="text-[10px] text-textMuted uppercase mb-1 font-bold">Median Counts</div>
                  <div className="text-text font-bold">{stats?.counts[0].value || '—'}</div>
                </div>
                <div className="p-4 bg-black/20 rounded text-center border border-border/5">
                  <div className="text-[10px] text-textMuted uppercase mb-1 font-bold font-bold">Genes/Features</div>
                  <div className="text-text font-bold">{distributions?.n_features?.toLocaleString() || '—'}</div>
                </div>
              </>
            )}
          </div>
          {(result?.result || pipelineState?.qcSummary) && (
            <p className="text-xs text-textMuted mt-4 italic opacity-80 font-medium tracking-tight">
              ✓ {(result?.result || pipelineState.qcSummary).message}
            </p>
          )}
          {!result && pipelineState?.qc && (
            <p className="text-[11px] text-textMuted mt-4 flex items-center gap-2">
              <Check size={14} className="text-success" />
              <span>Thresholds applied. Adjust values and click <strong>Re-run QC Filters</strong> to re-filter from raw baseline.</span>
            </p>
          )}
        </div>
      )}

      {/* Manual Threshold Controls */}
      <div className="card p-6 mb-8 border-l-4 border-l-primary relative overflow-hidden">
        {(result || pipelineState?.qc) && (
          <div className="absolute top-0 right-0 px-3 py-1 bg-success/10 text-success text-[9px] font-black uppercase tracking-tighter rounded-bl-lg border-b border-l border-success/20">
            Active Filter Applied
          </div>
        )}
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold flex items-center gap-2 text-text">
            <SlidersHorizontal size={18} className="text-primary" /> Filtering Thresholds
          </h3>
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            {pipelineState?.isSubset || datasetInfo?.parentObjId ? 'Subset Inherited Mode' : 'Manual Mode'}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-6">
          <div>
            <label htmlFor="qc-mt" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Max MT %</label>
            <input id="qc-mt" type="number" step="0.5" value={mtCutoff}
              onChange={e => setParam('mtCutoff', e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
            <p className="text-[10px] text-slate-400 mt-1">Cells above this % are removed</p>
          </div>
          <div>
            <label htmlFor="qc-minf" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Min Features</label>
            <input id="qc-minf" type="number" value={minFeatures}
              onChange={e => setParam('minFeatures', e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
            <p className="text-[10px] text-slate-400 mt-1">nFeature_RNA lower bound</p>
          </div>
          <div>
            <label htmlFor="qc-maxf" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Max Features</label>
            <input id="qc-maxf" type="number" value={maxFeatures}
              onChange={e => setParam('maxFeatures', e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
            <p className="text-[10px] text-slate-400 mt-1">nFeature_RNA upper bound</p>
          </div>
          <div>
            <label htmlFor="qc-minc" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Min Counts</label>
            <input id="qc-minc" type="number" value={minCounts}
              onChange={e => setParam('minCounts', e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
            <p className="text-[10px] text-slate-400 mt-1">nCount_RNA lower bound</p>
          </div>
        </div>

        <details className="mt-6 border-t border-border/50 pt-4 group">
          <summary className="text-sm font-bold flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white transition-colors list-none">
            <span className="text-primary group-open:rotate-90 transition-transform">▶</span>
            ⚙️ Advanced Options
          </summary>
          <div className="mt-4 p-4 bg-black/10 rounded-lg border border-border/50 grid grid-cols-2 gap-6">
            <div>
              <label htmlFor="qc-filter-features" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Filter Features</label>
              <input
                id="qc-filter-features"
                type="text" 
                value={filterFeatures || ''}
                onChange={e => setParam('filterFeatures', e.target.value)}
                placeholder="e.g. TRBV, IGH, IGK"
                className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
              />
              <p className="text-[10px] text-slate-400 mt-1">Regex patterns of features/genes to remove before clustering</p>
            </div>
            <div>
              <label className="block text-xs text-textMuted mb-3 uppercase tracking-wide font-bold">Doublet Detection</label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!removeDoublets}
                  onChange={e => setParam('removeDoublets', e.target.checked)}
                  className="w-4 h-4 rounded border-slate-600 bg-surface text-primary focus:ring-primary focus:ring-offset-slate-900"
                />
                <span className="text-sm text-white font-medium">Remove Doublets (scDblFinder)</span>
              </label>
              <p className="text-[10px] text-slate-400 mt-1 ml-7">Increases runtime significantly</p>
            </div>
          </div>
        </details>
      </div>

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
                  ? 'text-blue-400 border-blue-400 bg-background/40'
                  : 'text-slate-400 border-transparent hover:text-slate-300 hover:border-slate-600'
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
            <div className="flex items-center justify-center h-[420px] text-slate-400 text-sm">
              {qcUnavailableMessage(error, { datasetInfo, sessionReady })}
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
                          <span className="text-[10px] text-blue-400 uppercase">{s.label}</span>
                          <span className="text-sm font-bold text-blue-400 font-mono">{s.value}</span>
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
                          aria-label="Point opacity"
                          value={pointOpacity[activePlot]} onChange={e => setPointOpacity({ ...pointOpacity, [activePlot]: parseFloat(e.target.value) })}
                          className="w-16 accent-primary"
                        />
                      </div>
                    )}
                    {activePlot === 'scatter' && (
                      <div className="flex items-center gap-3 text-xs text-textMuted font-medium">
                        <span>X Axis:</span>
                        <select aria-label="Scatter X axis" className="bg-surface border border-border rounded text-text p-1 px-2 focus:ring-1 focus:ring-primary focus:outline-none" value={scatterX} onChange={e => setScatterX(e.target.value)}>
                          <option value="nCount_RNA">nCount_RNA</option>
                          <option value="nFeature_RNA">nFeature_RNA</option>
                          <option value="percent.mt">percent.mt</option>
                        </select>
                        <span className="ml-2">Y Axis:</span>
                        <select aria-label="Scatter Y axis" className="bg-surface border border-border rounded text-text p-1 px-2 focus:ring-1 focus:ring-primary focus:outline-none" value={scatterY} onChange={e => setScatterY(e.target.value)}>
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
                    <div className="text-[10px] text-blue-400 uppercase font-bold tracking-wider mb-1">Total Dataset Size</div>
                    <div className="text-base font-bold text-blue-400 font-mono">{stats.global[0].value}</div>
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
