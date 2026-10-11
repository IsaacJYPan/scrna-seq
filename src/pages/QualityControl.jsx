import React, { useState, useEffect } from 'react';
import { ShieldCheck, Activity, SlidersHorizontal, AlertTriangle, BarChart3, Info, Scissors, Check, FileText, ChevronRight, Settings } from 'lucide-react';
import Plot, { getPlotHoverStyle } from '../components/Plot';
import { useTabParams } from '../hooks/useTabParams';
import { usePipelineStep } from '../hooks/usePipelineStep';
import { publicErrorMessage } from '../publicError';
import PageHeader from '../components/PageHeader';

const QC_METRICS = {
  'percent.mt': { label: 'Mitochondrial RNA', format: '.2f', suffix: '%' },
  nFeature_RNA: { label: 'Genes detected', format: ',.0f' },
  nCount_RNA: { label: 'RNA counts', format: ',.0f' },
};

function qcMetricLabel(metric) {
  return QC_METRICS[metric]?.label || metric;
}

function qcMetricHover(metric, axis) {
  const { label, format, suffix = '' } = QC_METRICS[metric] || { label: metric, format: '.2f' };
  return `${label}: %{${axis}:${format}}${suffix}`;
}

const PLOT_TABS = [
  { id: 'mt', label: 'Mitochondrial %' },
  { id: 'features', label: 'Detected genes' },
  { id: 'counts', label: 'RNA counts' },
  { id: 'scatter', label: 'Feature Scatter' },
  { id: 'stats', label: 'Distribution Summary' },
];

function qcUnavailableMessage(rawError, { datasetInfo, sessionReady } = {}) {
  if (!datasetInfo) return 'Load a dataset in the Workspace first.';
  if (!sessionReady) {
    return 'A dataset is selected, but the private analysis workspace is not ready. Reload or open the saved version before running QC.';
  }

  const message = String(rawError || '').trim();
  if (/analysis object not found/i.test(message)) {
    return 'This saved analysis appears in Runs & Results, but it is not open in your private analysis workspace. Reload the demo analysis or open its saved version when that workflow is available.';
  }
  if (/no object loaded|load data first/i.test(message)) {
    return 'This saved analysis appears in Runs & Results, but it is not open in your private analysis workspace. Reload the demo analysis to continue interactive work.';
  }
  return publicErrorMessage(message, 'QC distribution data is unavailable for the selected analysis.');
}

export default function QualityControl({ callApi, datasetInfo, currentProvId, openProvenance, pipelineState, theme, rSessionId, userEmail, userId, objectId, sessionReady, currentWs }) {
  const isPbmcTutorial = datasetInfo?.source === 'pbmc3k_demo' || datasetInfo?.metadata?.sourceType === 'pbmc3k_demo';
  const [activePlot, setActivePlot] = useState('mt');
  const projectId = datasetInfo?.projectId || currentWs?.selectedProjectId || null;
  const projectRole = currentWs?.projects?.find((project) => project.id === projectId)?.role;
  const ownsObject = !datasetInfo?.ownerUserId || Number(datasetInfo.ownerUserId) === Number(userId);
  const canMutate = ['owner', 'admin', 'analyst'].includes(projectRole) && ownsObject;



  // Real distribution data from the backend
  const [distributions, setDistributions] = useState(null);
  const [loadingDist, setLoadingDist] = useState(false);

  // Persisted threshold state
  const [params, setParam] = useTabParams('qc', userEmail, objectId, {
    mtCutoff: 5,
    minFeatures: 200,
    maxFeatures: isPbmcTutorial ? 2500 : 5000,
    minCounts: isPbmcTutorial ? 0 : 500,
  });
  const { mtCutoff, minFeatures, maxFeatures, minCounts, removeDoublets, filterFeatures } = params;

  // Fetch real distributions when data is loaded
  const [showPoints, setShowPoints] = useState({ mt: true, features: true, counts: true });
  const [pointOpacity, setPointOpacity] = useState({ mt: 1.0, features: 1.0, counts: 1.0, scatter: 1.0 });
  const [zoomY, setZoomY] = useState(true);
  const [scatterX, setScatterX] = useState('nCount_RNA');
  const [scatterY, setScatterY] = useState('percent.mt');


  useEffect(() => {
    if (datasetInfo && !canMutate) {
      // Detailed distributions come from the owner's private live R object.
      // Project viewers may inspect persisted summary metrics only.
      setDistributions(null);
      setLoadingDist(false);
      setError(null);
      return;
    }
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
        .catch(() => {
          setError('Failed to fetch QC distributions.');
          setLoadingDist(false);
        });
    }
  // rSessionId triggers re-fetch when session is restored
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetInfo, rSessionId, sessionReady]);

  const mtCutoffNum = Number(mtCutoff);
  const minFeatNum = Number(minFeatures);
  const maxFeatNum = Number(maxFeatures);
  const minCountsNum = Number(minCounts);
  const validationError = !Number.isFinite(mtCutoffNum) || mtCutoffNum <= 0 || mtCutoffNum > 100
    ? 'Max MT % must be greater than 0 and no more than 100.'
    : !Number.isInteger(minFeatNum) || minFeatNum < 0
      ? 'Min Features must be a whole number of 0 or more.'
      : !Number.isInteger(maxFeatNum) || maxFeatNum <= minFeatNum
        ? 'Max Features must be a whole number greater than Min Features.'
        : !Number.isInteger(minCountsNum) || minCountsNum < 0
          ? 'Min Counts must be a whole number of 0 or more.'
          : null;

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
  const handleFiltering = () => {
    if (!canMutate) {
      setError(projectRole === 'viewer'
        ? 'This is a read-only project view. Your role can inspect recorded QC results but cannot change filtering.'
        : 'Create or open your private saved-analysis copy before changing QC filters.');
      return;
    }
    if (validationError) {
      setError(validationError);
      return;
    }
    runFiltering();
  };

  // --- Compute stats from real distribution data ---
  const mtValues = React.useMemo(() => distributions?.percent_mt || [], [distributions]);
  const featureValues = React.useMemo(() => distributions?.nFeature_RNA || [], [distributions]);
  const countValues = React.useMemo(() => distributions?.nCount_RNA || [], [distributions]);

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
    hoverlabel: getPlotHoverStyle(theme),
    hovermode: 'closest',
    hoverdistance: 30,
    spikedistance: 30,
    uirevision: activePlot // Preserves user zoom across state changes!
  };

  const seuratViolin = (id, yvals, color, hover, jitteredX) => {
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
        hovertemplate: hover,
        hoverlabel: getPlotHoverStyle(theme),
        showlegend: false
      }] : [])
    ];
  };

  const getValues = (metric) => metric === 'nCount_RNA' ? countValues : (metric === 'nFeature_RNA' ? featureValues : mtValues);

  const plotConfigs = distributions ? {
    mt: {
      data: [...seuratViolin('mt', mtValues, '#22c55e', `<b>${qcMetricHover('percent.mt', 'y')}</b><extra></extra>`, mtJitter)],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: '% MT', autorange: true, zeroline: false },
        shapes: [{ type: 'line', x0: -0.5, x1: 0.5, y0: mtCutoff, y1: mtCutoff, line: { color: '#f43f5e', dash: 'dash', width: 2 } }]
      },
      title: 'Mitochondrial Content', color: '#22c55e', hint: 'Cells extending past the upper cutoff (red bounds) are removed.'
    },
    features: {
      data: [...seuratViolin('features', featureValues, '#a855f7', `<b>${qcMetricHover('nFeature_RNA', 'y')}</b><extra></extra>`, featureJitter)],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: 'Genes detected per cell', autorange: true, zeroline: false },
        shapes: [
          { type: 'line', x0: -0.5, x1: 0.5, y0: minFeatures, y1: minFeatures, line: { color: '#f43f5e', dash: 'dash', width: 2 } },
          { type: 'line', x0: -0.5, x1: 0.5, y0: maxFeatures, y1: maxFeatures, line: { color: '#f43f5e', dash: 'dash', width: 2 } }
        ]
      },
      title: 'Genes detected per cell', color: '#a855f7', hint: 'Cells falling outside the min/max bounds are removed.'
    },
    counts: {
      data: [...seuratViolin('counts', countValues, '#3b82f6', `<b>${qcMetricHover('nCount_RNA', 'y')}</b><extra></extra>`, countJitter)],
      layout: {
        ...baseLayout,
        hovermode: 'closest',
        xaxis: { range: [-0.6, 0.6], fixedrange: true, showticklabels: false },
        yaxis: { title: 'RNA counts per cell', autorange: true, zeroline: false },
        shapes: [{ type: 'line', x0: -0.5, x1: 0.5, y0: minCounts, y1: minCounts, line: { color: '#f43f5e', dash: 'dash', width: 2 } }]
      },
      title: 'RNA counts per cell', color: '#3b82f6', hint: 'Low count cells (left tail) are likely empty droplets or debris.'
    },
    scatter: {
      data: [{
        type: 'scattergl', mode: 'markers',
        x: getValues(scatterX), y: getValues(scatterY),
        marker: { size: 3, color: '#f43f5e', opacity: pointOpacity['scatter'] },
        hovertemplate: `${qcMetricHover(scatterX, 'x')}<br>${qcMetricHover(scatterY, 'y')}<extra></extra>`
      }],
      layout: {
        ...baseLayout,
        xaxis: { title: qcMetricLabel(scatterX) },
        yaxis: { title: qcMetricLabel(scatterY) },
      },
      title: 'Feature Relationships', color: '#f43f5e', hint: 'Scatter plots reveal correlations between sequencing depth and cell quality.'
    }
  } : {};

  const currentPlot = plotConfigs[activePlot];

  return (
    <div className="h-full w-full p-4 sm:p-6 lg:p-8 overflow-y-auto bg-background custom-scrollbar">
      {/* Header */}
      <PageHeader title="Quality Control" description="Set filtering thresholds and inspect cell quality distributions." className="mb-6" actions={<>
          {result && (
            <button
              className="btn btn-secondary"
              onClick={() => openProvenance(result.provenance.id)}
            ><FileText size={15} /> View recorded analysis</button>
          )}
          <button
            onClick={handleFiltering}
            disabled={!canMutate || filtering || !distributions || Boolean(validationError)}
            className={`btn ${(result || pipelineState?.qc) ? 'bg-success/20 text-text border border-success hover:bg-success/30' : 'btn-primary'} flex items-center justify-center gap-2`}
          >
            {filtering && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {!filtering && (result || pipelineState?.qc) && <ShieldCheck size={18} />}
            {!filtering && !result && !pipelineState?.qc && <SlidersHorizontal size={18} />}
            {filtering ? 'Applying...' : (result || pipelineState?.qc) ? 'Re-run QC Filters' : 'Apply QC Filters'}
          </button>
        </>} />

      {!canMutate && (
        <div role="note" className="card p-4 mb-6 border-primary/30 bg-primary/5 text-sm text-textMuted">
          {projectRole === 'viewer'
            ? 'Read-only project view: saved QC summary metrics remain available when recorded. Detailed distributions and plots stay private to the analysis owner.'
            : 'QC filtering is disabled until this analysis is opened as your private saved-analysis copy.'}
        </div>
      )}

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Summary Statistics Card */}
      {(result || pipelineState?.qcSummary || pipelineState?.qc) && (() => {
        const summary = result?.result || pipelineState?.qcSummary;
        const count = summary?.post_filter_cells ?? distributions?.n_cells;
        const removed = [
          ['mitochondrial', summary?.removed_mt],
          ['gene range', summary?.removed_features],
          ['RNA counts', summary?.removed_counts],
        ].filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0);
        const medians = [
          ['mitochondrial RNA', summary?.median_mt != null ? `${summary.median_mt}%` : stats?.mt[0].value],
          ['genes detected', stats?.features[0].value],
          ['RNA counts', stats?.counts[0].value],
        ].filter(([, value]) => value != null);
        return (
          <div className={`card px-4 py-3 mb-4 border-t-4 ${result ? 'border-t-success' : 'border-t-primary/50'}`}>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <h3 className="text-sm font-semibold text-text">{result ? 'QC Filtering Summary' : 'QC Metrics Applied'}</h3>
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-textMuted">{summary?.post_filter_cells != null ? 'Post-filter cells' : 'Total cells'}</span>
                <strong className="text-lg font-black text-success">{count?.toLocaleString() || '—'}</strong>
              </div>
              {(pipelineState?.isSubset || datasetInfo?.parentObjId) && !result && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-primary/10 text-primary text-[10px] font-bold rounded border border-primary/20 uppercase tracking-wider">
                  <Scissors size={10} /> Subset inherited
                </span>
              )}
              {Number.isFinite(distributions?.n_features) && <span className="text-xs text-textMuted">{distributions.n_features.toLocaleString()} genes measured</span>}
            </div>
            {(medians.length > 0 || removed.length > 0) && (
              <div className="mt-2 pt-2 border-t border-border/70 flex flex-wrap gap-x-4 gap-y-1 text-xs text-textMuted">
                {medians.length > 0 && <span>Medians: {medians.map(([label, value]) => `${label} ${value}`).join(' · ')}</span>}
                {removed.length > 0 && <span className="text-danger">Removed {removed.map(([label, value]) => `${Number(value).toLocaleString()} ${label}`).join(' · ')}</span>}
              </div>
            )}
            {(summary?.message || (!result && pipelineState?.qc)) && (
              <p className="text-xs text-textMuted mt-2 flex items-center gap-2">
                <Check size={14} className="text-success" />
                <span>{summary?.message || <>Thresholds applied. Adjust values and click <strong>Re-run QC Filters</strong> to re-filter from raw baseline.</>}</span>
              </p>
            )}
          </div>
        );
      })()}

      {/* Manual Threshold Controls */}
      <fieldset disabled={!canMutate} className="card p-6 mb-8 border-l-4 border-l-primary relative overflow-hidden disabled:opacity-60">
        {(result || pipelineState?.qc) && (
          <div className="absolute top-0 right-0 px-3 py-1 bg-success/10 text-success text-[9px] font-black uppercase tracking-tighter rounded-bl-lg border-b border-l border-success/20">
            Active Filter Applied
          </div>
        )}
        <div className="flex flex-col gap-3 mb-5 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="font-bold flex items-center gap-2 text-text">
            <SlidersHorizontal size={18} className="text-primary" /> Filtering Thresholds
          </h3>
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            {pipelineState?.isSubset || datasetInfo?.parentObjId ? 'Subset Inherited Mode' : 'Manual Mode'}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label htmlFor="qc-mt" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Max MT %</label>
            <input id="qc-mt" type="number" min="0.1" max="100" step="0.5" value={mtCutoff} aria-invalid={Boolean(validationError)}
              onChange={e => setParam('mtCutoff', e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
            <p className="text-[10px] text-slate-400 mt-1">Cells above this % are removed</p>
          </div>
          <div>
            <label htmlFor="qc-minf" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Min Features</label>
            <input id="qc-minf" type="number" min="0" step="1" value={minFeatures} aria-invalid={Boolean(validationError)}
              onChange={e => setParam('minFeatures', e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
            <p className="text-[10px] text-slate-400 mt-1">Cells with fewer detected genes are removed</p>
          </div>
          <div>
            <label htmlFor="qc-maxf" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Max Features</label>
            <input id="qc-maxf" type="number" min="1" step="1" value={maxFeatures} aria-invalid={Boolean(validationError)}
              onChange={e => setParam('maxFeatures', e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
            <p className="text-[10px] text-slate-400 mt-1">Cells with more detected genes are removed</p>
          </div>
          <div>
            <label htmlFor="qc-minc" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Min Counts</label>
            <input id="qc-minc" type="number" min="0" step="1" value={minCounts} aria-invalid={Boolean(validationError)}
              onChange={e => setParam('minCounts', e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-primary transition-colors" />
            <p className="text-[10px] text-slate-400 mt-1">Cells with fewer RNA counts are removed</p>
          </div>
        </div>
        {validationError && <p className="mt-4 text-sm text-danger" role="alert">{validationError}</p>}

        <details className="mt-6 border-t border-border/50 pt-4 group">
          <summary className="text-sm font-bold flex items-center gap-2 cursor-pointer text-slate-400 hover:text-white transition-colors list-none">
            <ChevronRight size={14} className="text-primary group-open:rotate-90 transition-transform" aria-hidden="true" />
            <Settings size={15} className="text-primary" aria-hidden="true" />
            <span>Advanced Options</span>
          </summary>
          <div className="mt-4 p-4 bg-black/10 rounded-lg border border-border/50 grid grid-cols-1 gap-6 md:grid-cols-2">
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
      </fieldset>

      {/* Tabbed Plot Viewer */}
      <div className="card overflow-hidden">
        {/* Tab bar */}
        <div className="flex overflow-x-auto custom-scrollbar border-b border-border bg-black/5 dark:bg-white/5 px-4 pt-2 gap-1" role="group" aria-label="QC distribution views">
          {PLOT_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActivePlot(tab.id)}
              aria-pressed={activePlot === tab.id}
              className={`shrink-0 whitespace-nowrap px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 -mb-[1px]
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
        <div className="p-4 sm:p-6">
          {loadingDist ? (
            <div className="flex flex-col items-center justify-center h-[420px] space-y-4">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
              <p className="text-textMuted font-medium animate-pulse">Computing QC distributions from the selected analysis...</p>
            </div>
          ) : !distributions ? (
            <div className="flex items-center justify-center h-[420px] text-slate-400 text-sm">
              {!canMutate
                ? 'Detailed QC distributions are private to the analysis owner.'
                : qcUnavailableMessage(error, { datasetInfo, sessionReady })}
            </div>
          ) : activePlot === 'stats' ? (
            <div>
              <h3 className="text-sm font-bold text-text mb-6 flex items-center gap-2">
                <Info size={16} className="text-primary" />
                Distribution Summary
              </h3>

              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
                  {/* Mitochondrial Block */}
                  <div className="col-span-1 p-4 bg-black/20 rounded-xl border border-border">
                    <h4 className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">Mitochondrial RNA</h4>
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
                    <h4 className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">Genes detected</h4>
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
                    <h4 className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">RNA counts</h4>
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
            <div className="flex flex-col lg:flex-row gap-8">
              {/* Plot Column */}
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-3 justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: currentPlot.color }}></div>
                    <h3 className="text-sm font-bold text-text">{currentPlot.title}</h3>
                  </div>
                  {['mt', 'features', 'counts'].includes(activePlot) && (
                    <div className="flex flex-wrap items-center gap-3">
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
                  <div className="flex flex-wrap items-center gap-3">
                    {['mt', 'features', 'counts', 'scatter'].includes(activePlot) && (showPoints[activePlot] || activePlot === 'scatter') && (
                      <div className="flex items-center gap-2 border border-border/50 rounded-full px-3 py-1 bg-black/5 dark:bg-black/10">
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
                      <div className="grid grid-cols-[auto_minmax(0,1fr)] sm:flex items-center gap-2 sm:gap-3 text-xs text-textMuted font-medium">
                        <span>X Axis:</span>
                        <select aria-label="Scatter X axis" className="bg-surface border border-border rounded text-text p-1 px-2 focus:ring-1 focus:ring-primary focus:outline-none" value={scatterX} onChange={e => setScatterX(e.target.value)}>
                          <option value="nCount_RNA">RNA counts</option>
                          <option value="nFeature_RNA">Detected genes</option>
                          <option value="percent.mt">Mitochondrial %</option>
                        </select>
                        <span>Y Axis:</span>
                        <select aria-label="Scatter Y axis" className="bg-surface border border-border rounded text-text p-1 px-2 focus:ring-1 focus:ring-primary focus:outline-none" value={scatterY} onChange={e => setScatterY(e.target.value)}>
                          <option value="nCount_RNA">RNA counts</option>
                          <option value="nFeature_RNA">Detected genes</option>
                          <option value="percent.mt">Mitochondrial %</option>
                        </select>
                      </div>
                    )}
                  </div>
                </div>
                <div className="h-[500px] bg-black/10 border border-border/50 rounded-xl relative">
                  <Plot
                    preferSvg
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
                <div className="w-full lg:w-64 lg:flex-shrink-0 flex flex-col gap-3">
                  <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                    <Info size={16} className="text-primary" />
                    Related Statistics
                  </h3>
                  <dl className="divide-y divide-border/70 text-xs">
                    {stats[activePlot]?.map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-3 py-2.5">
                        <dt className="text-textMuted">{s.label}</dt>
                        <dd className="font-semibold text-text font-mono">{s.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
