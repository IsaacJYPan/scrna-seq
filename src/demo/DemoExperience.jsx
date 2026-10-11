import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Dna, Info, Loader2, RotateCcw } from 'lucide-react';
import Plot from '../components/Plot';
import { openDemo, applyDemoQC, processDemo, clusterDemo, resetDemo, readDemoGene,
  DEFAULT_QC, DEFAULT_PROCESSING, DEFAULT_CLUSTERING } from './demoApi';
import './demo.css';

const COLORS = ['#387b87', '#e5a253', '#8b7db3', '#d77283', '#69a48e', '#6a9ccd', '#b4a146', '#c38a69', '#8094a4', '#a676b1', '#6b8c53', '#bc6570'];
const GENES = ['CD3D', 'MS4A1', 'LYZ', 'NKG7', 'PPBP'];
const number = value => Number(value).toLocaleString('en-US');
const PLOT_LAYOUT = { autosize: true, paper_bgcolor: '#fff', plot_bgcolor: '#fff',
  font: { family: 'Inter, ui-sans-serif, system-ui, sans-serif', color: '#6b7885', size: 11 },
  margin: { l: 54, r: 22, t: 16, b: 46 }, hovermode: 'closest' };
const PLOT_CONFIG = { responsive: true, displaylogo: false, displayModeBar: true, scrollZoom: false,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'zoom2d', 'pan2d'], toImageButtonOptions: { format: 'png', scale: 2 } };
const parseNumericValue = value => {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return Number.NaN;
    return Number(normalized);
  }
  return Number(value);
};
const numericParameters = parameters => Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, parseNumericValue(value)]));
const sameParameters = (left, right) => Object.keys(left).every(key => left[key] === right[key]);
const inRange = (value, min, max, integer = false) => Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

function Brand() {
  return <div className="demo-brand"><Dna size={23} /><span>TraceOmics</span><span className="demo-badge">DEMO</span></div>;
}
export function DemoLoading({ error, onRetry }) {
  return <div className="demo-shell demo-loading"><Brand /><main>
    {error ? <><h1>Unable to load analysis</h1><p role="alert">{error}</p><button className="demo-primary" onClick={onRetry}>Retry <ArrowRight size={16} /></button></>
      : <><Loader2 className="demo-spin" size={26} /><h1>Loading PBMC3k</h1><p role="status">Loading counts and QC metrics…</p></>}
  </main></div>;
}
export function expressionSummary(expression) {
  const values = expression.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return null;
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    percent: 100 * values.filter(value => value > 0).length / values.length, count: values.length };
}
export function qcPassing(metrics, parameters) {
  if (!metrics) return 0;
  return metrics.nFeature_RNA.filter((value, i) => value > parameters.min_features && value < parameters.max_features
    && metrics.percent_mt[i] < parameters.mt_threshold && metrics.nCount_RNA[i] > parameters.min_counts).length;
}
function NumberField({ label, value, onChange, min, max, step = 1, integer = false, disabled, hint, invalidHint }) {
  const parsedValue = parseNumericValue(value);
  const valueValid = inRange(parsedValue, min, max, integer);
  const message = !valueValid
    ? invalidHint || `Enter a value from ${number(min)} to ${number(max)}${integer ? ' (whole number)' : ''}.`
    : hint;
  const hintId = `demo-hint-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return <label className="demo-field"><span>{label}</span><input aria-label={label} aria-invalid={!valueValid || Boolean(invalidHint)} aria-describedby={message ? hintId : undefined}
    type="text" inputMode={step % 1 === 0 ? 'numeric' : 'decimal'} value={value} disabled={disabled}
    onChange={event => onChange(event.target.value)} />{message && <small id={hintId}>{message}</small>}</label>;
}
function Chart({ data, layout, label, height = 290, compact = false }) {
  return <div className="demo-chart" role="region" aria-label={label} style={{ height }}><Plot data={data} layout={{ ...PLOT_LAYOUT, ...layout, margin: { ...PLOT_LAYOUT.margin, ...layout?.margin, t: 50 } }}
    config={compact ? { ...PLOT_CONFIG, modeBarButtons: [['toImage']] } : PLOT_CONFIG} style={{ width: '100%', height: '100%' }} useResizeHandler /></div>;
}
function EmptyPlot({ title, children }) {
  return <div className="demo-empty"><h3>{title}</h3><p>{children}</p></div>;
}
function QCPlots({ metrics, parameters, view }) {
  if (view === 'scatter') return <Chart label="QC scatter plot" height={440} data={[{ type: 'scatter', mode: 'markers',
    x: metrics.nCount_RNA, y: metrics.nFeature_RNA, marker: { size: 4, opacity: 0.65, color: metrics.percent_mt,
      colorscale: [[0, '#8cb9b1'], [1, '#bc6170']], colorbar: { title: { text: '% MT' }, thickness: 10 } },
    hovertemplate: 'Counts: %{x}<br>Genes: %{y}<br>MT: %{marker.color:.2f}%<extra></extra>' }]} layout={{
      margin: { l: 65, r: 60, t: 20, b: 50 }, xaxis: { title: { text: 'RNA counts per cell' }, zeroline: false },
      yaxis: { title: { text: 'Detected genes per cell' }, zeroline: false },
      shapes: [parameters.min_features, parameters.max_features].filter(Number.isFinite).map(y => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: y, y1: y, line: { color: '#bd6974', dash: 'dot', width: 1 } })),
    }} />;
  const series = [
    { key: 'nFeature_RNA', title: 'Detected genes', lines: [parameters.min_features, parameters.max_features].filter(Number.isFinite) },
    { key: 'nCount_RNA', title: 'RNA counts', lines: Number.isFinite(parameters.min_counts) && parameters.min_counts ? [parameters.min_counts] : [] },
    { key: 'percent_mt', title: 'Mitochondrial counts (%)', lines: Number.isFinite(parameters.mt_threshold) ? [parameters.mt_threshold] : [] },
  ];
  return <div className="demo-qc-plots">{series.map(item => <div key={item.key}><h3>{item.title}</h3><Chart compact label={item.title + ' distribution'} height={340}
    data={[{ type: 'violin', y: metrics[item.key], name: 'Cells', points: false, box: { visible: true }, meanline: { visible: false },
      line: { color: '#397e79', width: 1.5 }, fillcolor: '#bcd7d2', hovertemplate: '%{y}<extra></extra>' }]}
    layout={{ margin: { l: 45, r: 12, t: 18, b: 20 }, xaxis: { showticklabels: false, showgrid: false },
      yaxis: { zeroline: false, gridcolor: '#eef1f4' }, shapes: item.lines.filter(Number.isFinite).map(y => ({ type: 'line', xref: 'paper', x0: 0, x1: 1, y0: y, y1: y,
        line: { color: '#bd6974', dash: 'dot', width: 1 } })) }} /></div>)}</div>;
}

export default function DemoExperience() {
  const [result, setResult] = useState(null);
  const [loadingError, setLoadingError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [step, setStep] = useState('qc');
  const [qc, setQC] = useState({ ...DEFAULT_QC });
  const [processing, setProcessing] = useState({ ...DEFAULT_PROCESSING });
  const [clustering, setClustering] = useState({ ...DEFAULT_CLUSTERING });
  const [qcView, setQCView] = useState('distributions');
  const [qcSource, setQCSource] = useState('input');
  const [view, setView] = useState('clusters');
  const [gene, setGene] = useState('');
  const [geneData, setGeneData] = useState(null);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const workflowTabRefs = useRef({});
  useEffect(() => {
    let active = true;
    openDemo().then(value => {
      if (!active) return;
      setResult(value); setQC(value.context.appliedQC || { ...DEFAULT_QC });
      setProcessing(value.context.processing || { ...DEFAULT_PROCESSING });
      setClustering(value.context.clustering || { ...DEFAULT_CLUSTERING });
      setStep(value.map ? 'clustering' : value.context.appliedQC ? 'pca' : 'qc');
    }).catch(e => { if (active) setLoadingError(e.message); });
    return () => { active = false; };
  }, [attempt]);
  const preview = useMemo(() => qcPassing(result?.baseline, numericParameters(qc)), [result, qc]);
  const summary = useMemo(() => geneData ? expressionSummary(geneData.expression) : null, [geneData]);
  const traces = useMemo(() => {
    if (!result?.map) return [];
    if (view === 'gene' && geneData) return [{ type: 'scatter', mode: 'markers', x: geneData.u1, y: geneData.u2,
      marker: { size: 5, color: geneData.expression, colorscale: [[0, '#e6e9ed'], [0.2, '#abc8c2'], [0.55, '#4d998c'], [1, '#155f56']],
        colorbar: { title: { text: 'Expression', font: { size: 11 } }, thickness: 10, len: 0.55 }, cmin: 0 },
      hovertemplate: `${gene}: %{marker.color:.2f}<extra></extra>`, showlegend: false }];
    return result.map.trace_data.map((trace, i) => ({ ...trace, type: 'scatter', mode: 'markers',
      marker: { size: 5, color: COLORS[i % COLORS.length], opacity: selectedCluster && selectedCluster !== trace.name ? 0.12 : 0.85 },
      hovertemplate: `${trace.name}<extra></extra>`, showlegend: false }));
  }, [result, view, geneData, gene, selectedCluster]);
  if (!result) return <DemoLoading error={loadingError} onRetry={() => { setLoadingError(''); setAttempt(value => value + 1); }} />;

  const { context, info, baseline, pca, map } = result;
  const parsedQC = numericParameters(qc);
  const parsedProcessing = numericParameters(processing);
  const parsedClustering = numericParameters(clustering);
  const plotQC = {
    min_features: inRange(parsedQC.min_features, 0, 2500, true) ? parsedQC.min_features : Number.NaN,
    max_features: inRange(parsedQC.max_features, 1000, 6000, true) ? parsedQC.max_features : Number.NaN,
    mt_threshold: inRange(parsedQC.mt_threshold, 0.5, 30) ? parsedQC.mt_threshold : Number.NaN,
    min_counts: inRange(parsedQC.min_counts, 0, 20000) ? parsedQC.min_counts : Number.NaN,
  };
  const runAction = async (action, parameters, completed, nextStep) => {
    if (busy) return;
    setBusy('Loading analysis…'); setError(''); setNotice('');
    try {
      const next = await action(context, parameters, setBusy);
      setResult(next); setGeneData(null); setGene(''); setView('clusters'); setSelectedCluster(null);
      setNotice(completed(next)); if (nextStep) setStep(nextStep);
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };
  const selectGene = async requested => {
    if (busy || !map) return;
    setBusy(`Loading ${requested} expression…`); setError('');
    try {
      const values = await readDemoGene(context, requested);
      if (!Array.isArray(values.expression) || values.expression.length !== values.u1?.length || values.expression.length !== values.u2?.length) throw new Error('Gene expression could not be displayed. Please retry.');
      setGeneData(values); setGene(requested); setView('gene'); setSelectedCluster(null);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const reset = async () => {
    if (busy) return;
    setBusy('Loading original counts…'); setError(''); setNotice('');
    try {
      setResult(await resetDemo(context)); setQC({ ...DEFAULT_QC }); setProcessing({ ...DEFAULT_PROCESSING }); setClustering({ ...DEFAULT_CLUSTERING });
      setStep('qc'); setQCSource('input'); setGeneData(null); setGene(''); setView('clusters'); setSelectedCluster(null);
      setNotice('Analysis reset to input counts.');
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const updateQC = key => value => setQC(old => ({ ...old, [key]: value }));
  const updateProcessing = key => value => setProcessing(old => ({ ...old, [key]: value }));
  const updateClustering = key => value => setClustering(old => ({ ...old, [key]: value }));
  const validQC = parsedQC.max_features > parsedQC.min_features && Number.isInteger(parsedQC.min_features) && Number.isInteger(parsedQC.max_features)
    && parsedQC.min_features >= 0 && parsedQC.min_features <= 2500 && parsedQC.max_features >= 1000 && parsedQC.max_features <= 6000
    && parsedQC.mt_threshold >= 0.5 && parsedQC.mt_threshold <= 30 && parsedQC.min_counts >= 0 && parsedQC.min_counts <= 20000 && preview >= 60;
  const validProcessing = parsedProcessing.variableFeatures >= 500 && parsedProcessing.variableFeatures <= 3000 && Number.isInteger(parsedProcessing.variableFeatures)
    && parsedProcessing.scaleFactor >= 1000 && parsedProcessing.scaleFactor <= 100000 && Number.isInteger(parsedProcessing.scaleFactor)
    && parsedProcessing.npcs >= 10 && parsedProcessing.npcs <= 50 && parsedProcessing.npcs < info.n_cells && Number.isInteger(parsedProcessing.npcs);
  const validClustering = Number.isInteger(parsedClustering.dims) && parsedClustering.dims >= 2 && parsedClustering.dims <= (pca?.npcs || 0)
    && parsedClustering.resolution >= 0.1 && parsedClustering.resolution <= 1.2 && Number.isInteger(parsedClustering.neighbors)
    && parsedClustering.neighbors >= 5 && parsedClustering.neighbors <= 50 && parsedClustering.minDist >= 0 && parsedClustering.minDist <= 0.8;
  const qcChanged = Boolean(context.appliedQC && !sameParameters(parsedQC, context.appliedQC));
  const processingChanged = Boolean(context.processing && !sameParameters(parsedProcessing, context.processing));
  const clusteringChanged = Boolean(context.clustering && !sameParameters(parsedClustering, context.clustering));
  const workflowTabs = [
    { key: 'qc', label: 'Quality control', enabled: true, done: !!context.appliedQC },
    { key: 'pca', label: 'Normalization & PCA', enabled: !!context.appliedQC && !qcChanged, done: !!pca },
    { key: 'clustering', label: 'Clustering & UMAP', enabled: !!pca && !qcChanged && !processingChanged, done: !!map },
  ];
  const handleWorkflowKeyDown = (event, currentKey) => {
    const tabs = workflowTabs.filter(tab => tab.enabled && !busy);
    const currentIndex = tabs.findIndex(tab => tab.key === currentKey);
    if (currentIndex < 0) return;
    let nextIndex;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    setStep(nextTab.key);
    setError('');
    workflowTabRefs.current[nextTab.key]?.focus();
  };

  return <div className="demo-shell">
    <header className="demo-topbar"><Brand /><span className="demo-top-context">Single-cell RNA analysis</span></header>
    <main className="demo-main">
      <section className="demo-intro"><div><h1>PBMC3k analysis</h1><p>10x Genomics · Human peripheral blood mononuclear cells · One sample</p></div>
        <button className="demo-reset" onClick={reset} disabled={!!busy}><RotateCcw size={14} /> Reset analysis</button></section>
      <div className="demo-limits"><Info size={16} /><p>Some capabilities are disabled for this demo: uploads, custom R, collaboration, and advanced analyses.</p></div>
      <section className="demo-stats" aria-label="Dataset summary">
        <div><span>Input cells</span><strong>{number(baseline.n_cells)}</strong></div>
        <div><span>{context.appliedQC ? 'Cells after QC' : 'Genes'}</span><strong>{number(context.appliedQC ? info.n_cells : info.n_features)}</strong></div>
        <div><span>{map ? 'Clusters' : pca ? 'Principal components' : 'Analysis status'}</span><strong className={!map && !pca ? 'demo-status-value' : ''}>{map ? number(map.n_clusters) : pca ? pca.npcs : context.appliedQC ? 'QC complete' : 'Input counts'}</strong></div>
      </section>
      <nav className="demo-workflow" aria-label="Analysis steps" role="tablist">
        {workflowTabs.map(({ key, label, enabled, done }, i) =>
          <button role="tab" key={key} ref={element => { workflowTabRefs.current[key] = element; }} id={`demo-tab-${key}`} aria-controls={`demo-panel-${key}`}
            aria-selected={step === key} tabIndex={step === key && enabled ? 0 : -1} disabled={!!busy || !enabled}
            onKeyDown={event => handleWorkflowKeyDown(event, key)} onClick={() => { setStep(key); setError(''); }}>
            <span>{done ? <Check size={14} /> : i + 1}</span>{label}</button>)}
      </nav>
      {error && <p className="demo-error" role="alert">{error}</p>}
      {notice && <p className="demo-success" role="status"><Check size={15} />{notice}</p>}
      {busy && <p className="demo-progress" role="status"><Loader2 className="demo-spin" size={16} />{busy}</p>}
      <section className="demo-workspace" role="tabpanel" id={`demo-panel-${step}`} aria-labelledby={`demo-tab-${step}`} aria-busy={!!busy}>
        <aside className="demo-controls">
          {step === 'qc' && <><h2>Quality filters</h2><p>Set thresholds using the input QC distributions.</p>
            <NumberField label="Minimum genes per cell" value={qc.min_features} onChange={updateQC('min_features')} min={0} max={2500} integer disabled={!!busy}
              invalidHint={parsedQC.min_features >= parsedQC.max_features ? 'Must be lower than the maximum genes per cell.' : undefined} />
            <NumberField label="Maximum genes per cell" value={qc.max_features} onChange={updateQC('max_features')} min={1000} max={6000} integer disabled={!!busy}
              invalidHint={parsedQC.max_features <= parsedQC.min_features ? 'Must be higher than the minimum genes per cell.' : undefined} />
            <NumberField label="Maximum mitochondrial counts (%)" value={qc.mt_threshold} onChange={updateQC('mt_threshold')} min={0.5} max={30} step={0.5} disabled={!!busy} />
            <NumberField label="Minimum RNA counts per cell" value={qc.min_counts} onChange={updateQC('min_counts')} min={0} max={20000} step={100} integer disabled={!!busy} />
            <div className="demo-filter-preview"><span>Passing thresholds (preview)</span><strong>{number(preview)} <small>/ {number(baseline.n_cells)}</small></strong></div>
            {qcChanged && <p className="demo-hint">Filters changed. Apply QC to update the analysis.</p>}
            {!validQC && <p className="demo-hint">Use valid thresholds retaining at least 60 cells.</p>}
            <button className="demo-primary" disabled={!!busy || !validQC} onClick={() => runAction(applyDemoQC, parsedQC, next => `QC complete: ${number(next.info.n_cells)} cells retained.`, 'pca')}>Apply QC <ArrowRight size={15} /></button>
            <p className="demo-hint">Filters apply to the original counts on every run.</p></>}
          {step === 'pca' && <><h2>Normalization & PCA</h2><p>Log-normalize counts, select variable genes, scale, and compute principal components.</p>
            <label className="demo-field"><span>Normalization method</span><select disabled value="LogNormalize"><option>LogNormalize</option></select></label>
            <NumberField label="Normalization scale factor" value={processing.scaleFactor} onChange={updateProcessing('scaleFactor')} min={1000} max={100000} step={1000} integer disabled={!!busy} />
            <NumberField label="Variable genes" value={processing.variableFeatures} onChange={updateProcessing('variableFeatures')} min={500} max={3000} step={500} integer disabled={!!busy} />
            <NumberField label="Principal components to compute" value={processing.npcs} onChange={updateProcessing('npcs')} min={10} max={50} step={5} integer disabled={!!busy} />
            {processingChanged && <p className="demo-hint">Parameters changed. Run PCA to update the result.</p>}
            <button className="demo-primary" disabled={!!busy || !validProcessing} onClick={() => runAction(processDemo, parsedProcessing, next => `PCA complete: ${next.pca.npcs} components computed.`)}>Run normalization & PCA <ArrowRight size={15} /></button>
            {pca && <button className="demo-secondary" disabled={!!busy || processingChanged || qcChanged} onClick={() => setStep('clustering')}>Continue to clustering <ArrowRight size={15} /></button>}</>}
          {step === 'clustering' && <><h2>Clustering & UMAP</h2><p>Choose PCs from the elbow plot, then set graph clustering and UMAP parameters.</p>
            <NumberField label="Principal components to use" value={clustering.dims} onChange={updateClustering('dims')} min={2} max={pca.npcs} integer disabled={!!busy} hint={`${pca.npcs} components available`} />
            <NumberField label="Clustering resolution" value={clustering.resolution} onChange={updateClustering('resolution')} min={0.1} max={1.2} step={0.1} disabled={!!busy} />
            <NumberField label="UMAP neighbors" value={clustering.neighbors} onChange={updateClustering('neighbors')} min={5} max={50} step={5} integer disabled={!!busy} />
            <NumberField label="UMAP minimum distance" value={clustering.minDist} onChange={updateClustering('minDist')} min={0} max={0.8} step={0.1} disabled={!!busy} />
            {clusteringChanged && <p className="demo-hint">Parameters changed. Run clustering to update the plot.</p>}
            <button className="demo-primary" disabled={!!busy || !validClustering} onClick={() => runAction(clusterDemo, parsedClustering, next => `Clustering complete: ${next.map.n_clusters} clusters.`)}>Run clustering & UMAP <ArrowRight size={15} /></button>
            {map && <section className="demo-gene-controls"><h3>Gene expression</h3><div className="demo-genes">{GENES.map(item => <button key={item} disabled={!!busy} aria-pressed={view === 'gene' && gene === item} onClick={() => selectGene(item)}>{item}</button>)}</div></section>}</>}
        </aside>
        <div className="demo-output">
          {step === 'qc' && <><section className="demo-plot-card"><div className="demo-plot-header"><div><h2>QC metrics</h2><p>{number((qcSource === 'input' ? baseline : result.qc).n_cells)} cells · Dashed lines show thresholds</p></div>
            <div className="demo-view-switch"><button disabled={!!busy} aria-pressed={qcView === 'distributions'} onClick={() => setQCView('distributions')}>Distributions</button><button disabled={!!busy} aria-pressed={qcView === 'scatter'} onClick={() => setQCView('scatter')}>Scatter</button></div></div>
            <div className="demo-data-toggle"><button disabled={!!busy} aria-pressed={qcSource === 'input'} onClick={() => setQCSource('input')}>Input cells</button><button disabled={!!busy || !context.appliedQC} aria-pressed={qcSource === 'filtered'} onClick={() => setQCSource('filtered')}>Filtered cells</button></div>
            <QCPlots metrics={qcSource === 'input' ? baseline : result.qc} parameters={plotQC} view={qcView} />
            <p className="demo-plot-caption">QC uses detected genes, total RNA counts, and the fraction of counts from genes beginning with MT-.</p></section></>}
          {step === 'pca' && <><section className="demo-plot-card"><div className="demo-plot-header"><div><h2>PCA elbow plot</h2><p>Standard deviation of each computed principal component</p></div></div>
            {pca ? <Chart label="PCA elbow plot" height={360} data={[{ type: 'scatter', mode: 'lines+markers', x: pca.stdevs.map((_, i) => i + 1), y: pca.stdevs,
              line: { color: '#397e79', width: 2 }, marker: { size: 6 }, hovertemplate: 'PC %{x}<br>SD %{y:.3f}<extra></extra>' }]}
              layout={{ xaxis: { title: { text: 'Principal component' }, dtick: 5, gridcolor: '#eef1f4', zeroline: false }, yaxis: { title: { text: 'Standard deviation' }, gridcolor: '#eef1f4', zeroline: false } }} />
              : <EmptyPlot title="PCA has not been computed">Run normalization and PCA to inspect component variance before clustering.</EmptyPlot>}
            <p className="demo-plot-caption">The elbow can help select the number of PCs to use in clustering and UMAP.</p></section>
            {pca?.gene_loadings && <section className="demo-plot-card demo-loadings"><h2>Leading genes by component</h2><table><thead><tr><th>PC</th><th>Positive and negative loadings</th></tr></thead><tbody>{Object.entries(pca.gene_loadings).map(([key, genes]) => <tr key={key}><td>{key}</td><td>{genes.join(', ')}</td></tr>)}</tbody></table></section>}</>}
          {step === 'clustering' && <section className="demo-plot-card"><div className="demo-plot-header"><div><h2>{view === 'gene' && gene ? `${gene} expression` : 'UMAP'}</h2><p>{map ? `${number(map.n_cells)} cells · ${map.n_clusters} clusters · Resolution ${context.clustering.resolution}` : 'Embedding is computed after clustering'}</p></div>
            {map && <div className="demo-view-switch"><button aria-pressed={view === 'clusters'} disabled={!!busy} onClick={() => { setView('clusters'); setSelectedCluster(null); }}>Clusters</button><button aria-pressed={view === 'gene'} disabled={!!busy} onClick={() => geneData ? setView('gene') : selectGene('CD3D')}>Gene expression</button></div>}</div>
            {map ? <><Chart label="UMAP cell embedding" height={440} data={traces} layout={{ margin: { l: 48, r: view === 'gene' ? 75 : 24, t: 20, b: 40 }, dragmode: 'pan',
              xaxis: { title: { text: 'UMAP 1' }, showgrid: false, zeroline: false, showticklabels: false, constrain: 'domain' }, yaxis: { title: { text: 'UMAP 2' }, showgrid: false, zeroline: false, showticklabels: false, scaleanchor: 'x', scaleratio: 1 }, uirevision: context.currentObjectId }} />
              {view === 'clusters' ? <div className="demo-cluster-key" aria-label="Cluster sizes">{map.trace_data.map((trace, i) => <button key={trace.name} disabled={!!busy} aria-pressed={selectedCluster === trace.name} onClick={() => setSelectedCluster(selectedCluster === trace.name ? null : trace.name)}><i style={{ background: COLORS[i % COLORS.length] }} />{trace.name}<span>{number(trace.x.length)}</span></button>)}</div>
                : summary && <div className="demo-expression-stats"><span><strong>{summary.percent.toFixed(1)}%</strong> of cells expressing {gene}</span><span><strong>{summary.mean.toFixed(2)}</strong> mean log-normalized expression</span></div>}
              <p className="demo-plot-caption">Each point represents a cell. Numeric clusters are not cell-type annotations. Plot controls provide zoom, pan, and PNG export.</p></>
              : <EmptyPlot title="UMAP has not been computed">Run clustering and UMAP with the selected parameters to generate the embedding.</EmptyPlot>}
          </section>}
        </div>
      </section>
      <details className="demo-method"><summary>Method and data source</summary><p>Input: public 10x PBMC3k counts, initialized with genes detected in at least three cells and cells with at least 200 detected genes. QC filters use strict thresholds and are applied to the original counts. The analysis uses Seurat LogNormalize, vst variable-gene selection, scaling, PCA, FindNeighbors, Louvain clustering, and UMAP. PCA, clustering, and UMAP use seed 42.</p>
        <p><a href="https://www.10xgenomics.com/datasets/3-k-pbm-cs-from-a-healthy-donor-1-standard-1-1-0" target="_blank" rel="noreferrer">PBMC3k dataset ↗</a><a href="https://satijalab.org/seurat/articles/pbmc3k_tutorial" target="_blank" rel="noreferrer">Seurat workflow ↗</a></p></details>
    </main>
  </div>;
}
