import { usePlotGeometry, categoryTickAngle, categoryPlotWidth } from '../hooks/usePlotGeometry';
import PageHeader from '../components/PageHeader';
import React, { useState, useEffect } from 'react';
import Plot from '../components/Plot';
import { CircleDot, AlertTriangle, ImageDown } from 'lucide-react';
import FigureSavePanel from '../components/FigureSavePanel';
import { publicErrorMessage } from '../publicError';

// Removed API constant
export default function DotPlot({ datasetInfo, pipelineState, sessionReady, userEmail, objectId, callApi, theme, deploymentPolicy }) {
  const chart = usePlotGeometry();
  const [savePanelOpen, setSavePanelOpen] = useState(false);
  const [dotData, setDotData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [geneInput, setGeneInput] = useState('');
  const [genes, setGenes] = useState([]);
  const [geneList, setGeneList] = useState([]);
  const [suggestions, setSuggestions] = useState([]);

  const hasClusters = pipelineState?.cluster;

  useEffect(() => {
    if (!sessionReady || !datasetInfo) return;
    callApi('/genes', {}, { useCache: false })
      .then(d => { if (d.genes) setGeneList(d.genes); })
      .catch(() => {});
  }, [sessionReady, datasetInfo, callApi]);

  const handleInputChange = (val) => {
    setGeneInput(val);
    if (val.length >= 2) {
      setSuggestions(geneList.filter(g => g.toLowerCase().startsWith(val.toLowerCase())).slice(0, 8));
    } else {
      setSuggestions([]);
    }
  };

  const addGene = (g) => {
    const target = (g || geneInput).trim();
    if (target && !genes.includes(target)) setGenes(prev => [...prev, target]);
    setGeneInput('');
    setSuggestions([]);
  };

  const removeGene = (g) => setGenes(prev => prev.filter(x => x !== g));

  const fetchDotPlot = async () => {
    if (genes.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const data = await callApi(`/dot-plot?genes=${encodeURIComponent(genes.join(','))}`, {}, { useCache: false });
      if (data.error) throw new Error(data.error);
      setDotData(data);
    } catch (e) {
      setError(publicErrorMessage(e, 'The dot plot could not be prepared. Please try again.'));
    }
    setLoading(false);
  };

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <CircleDot size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted">Load a dataset in the Workspace first.</p>
        </div>
      </div>
    );
  }

  if (!hasClusters) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-text mb-2">Clustering Required</h2>
          <p className="text-textMuted">Run Clustering first to group cells into identities for dot plot visualization.</p>
        </div>
      </div>
    );
  }

  const plottedGenes = dotData?.genes == null ? [] : Array.isArray(dotData.genes) ? dotData.genes : [dotData.genes];
  const selectionChanged = dotData && (genes.length !== plottedGenes.length || genes.some((gene, index) => gene !== plottedGenes[index]));

  // Build Plotly bubble chart from dot plot data
  const traces = [];
  if (dotData) {
    const ensureArray = (v) => {
      if (v === undefined || v === null) return [];
      return Array.isArray(v) ? v : [v];
    };

    const allClusters = ensureArray(dotData.clusters);
    const allGenes = ensureArray(dotData.genes);
    // Theme-aware colorbar text (matches plotText below); a hardcoded dark gray
    // here rendered at ~2.6:1 on the light-mode transparent plot background.
    const colorbarText = theme === 'dark' ? '#94a3b8' : '#475569';

    const avgData = (allGenes.length === 1 && !Array.isArray(dotData.avg_expr?.[0])) 
      ? [dotData.avg_expr] 
      : dotData.avg_expr;
    const pctData = (allGenes.length === 1 && !Array.isArray(dotData.pct_expr?.[0])) 
      ? [dotData.pct_expr] 
      : dotData.pct_expr;

    const x = [];
    const y = [];
    const sizes = [];
    const colors = [];
    const hoverText = [];

    allGenes.forEach((g, gi) => {
      allClusters.forEach((cl, ci) => {
        const avgExpr = avgData?.[gi]?.[ci] ?? 0;
        const pctExpr = pctData?.[gi]?.[ci] ?? 0;
        
        x.push(cl);
        y.push(g);
        sizes.push(Math.max(4, pctExpr * 28));
        colors.push(avgExpr);
        hoverText.push(`<b>${g}</b> in ${cl}<br>Avg expr: ${avgExpr.toFixed(3)}<br>Pct expr: ${(pctExpr * 100).toFixed(1)}%`);
      });
    });

    traces.push({
      x,
      y,
      type: 'scatter',
      mode: 'markers',
      marker: {
        size: sizes,
        sizemode: 'diameter',
        color: colors,
        colorscale: [
          [0, '#3b0f70'],   // magma-style visible dark
          [0.25, '#8c2981'],
          [0.5, '#de4968'],
          [0.75, '#fe9f6d'],
          [1, '#fcfdbf']
        ],
        showscale: true,
        colorbar: {
          title: { text: 'Avg Expr', side: 'top', font: { color: colorbarText } },
          thickness: 15,
          orientation: 'h', yref: 'container', y: 0.015, xref: 'container', x: 0.5, xanchor: 'center', yanchor: 'bottom',
          len: 0.6,
          tickfont: { color: colorbarText }
        },
        line: { color: '#1e293b', width: 0.5 },
      },
      hoverinfo: 'text',
      text: hoverText,
      showlegend: false,
    });
  }

  const isDark = theme === 'dark';
  const plotText = isDark ? '#94a3b8' : '#475569';
  const plotGrid = isDark ? '#1e293b' : '#d8e0ea';
  const axisTitle = isDark ? '#f8fafc' : '#334155';
  const layout = {
    autosize: true,
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: plotText, size: 12, family: 'Inter, system-ui' },
    margin: { l: 58, r: 12, t: 24, b: 120 },
    xaxis: { 
      title: { text: 'Cluster ID', font: { size: 13, color: axisTitle }, standoff: 20 },
      type: 'category',
      tickangle: categoryTickAngle(dotData?.clusters || [], Math.max(chart.width, categoryPlotWidth(dotData?.genes, dotData?.clusters)) - 100),
      gridcolor: plotGrid,
      zeroline: false
    },
    yaxis: { 
      title: { text: 'Gene Symbol', font: { size: 13, color: axisTitle }, standoff: 20 },
      automargin: true, 
      gridcolor: plotGrid,
      zeroline: false
    },
    showlegend: false,
  };

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-y-auto custom-scrollbar">
      <PageHeader title="Dot Plot" description="Bubble size represents the percentage of cells expressing a gene; color represents average expression." className="px-4 sm:px-8 pt-6 pb-4 border-b border-border" actions={
<div className="flex min-w-0 flex-col gap-2 items-start sm:items-end">
          <div className="relative flex flex-wrap items-center gap-2">
            <div className="relative">
              <input
                type="text"
                aria-label="Add gene to dot plot"
                value={geneInput}
                onChange={e => handleInputChange(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addGene()}
                placeholder="Add gene…"
                className="bg-surface border border-border text-text text-sm px-3 py-2 rounded-lg w-44 focus:outline-none focus:border-primary"
              />
              {suggestions.length > 0 && (
                <div className="absolute top-full left-0 mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg shadow-2xl z-50 overflow-hidden">
                  {suggestions.map(s => (
                    <button key={s} onClick={() => addGene(s)} className="w-full text-left px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-white">
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => addGene()} disabled={!geneInput.trim()} className="btn btn-ghost border border-border text-sm px-3 py-2 text-slate-400 hover:text-white">
              Add
            </button>
            <button onClick={fetchDotPlot} disabled={loading || genes.length === 0} className="btn btn-primary text-sm px-4 py-2">
              {loading ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4 inline-block" /> : 'Plot'}
            </button>
            {dotData && (
              <button onClick={() => setSavePanelOpen(true)} className="btn btn-ghost border border-border text-sm px-3 py-2 text-primary hover:bg-primary/10 flex items-center gap-1.5">
                <ImageDown size={14} /> Save Figure
              </button>
            )}
          </div>
          {genes.length > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-end max-w-xs">
              {genes.map(g => (
                <button type="button" key={g} onClick={() => removeGene(g)} aria-label={`Remove ${g}`} className="inline-flex items-center min-h-8 gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/30 text-primary text-xs font-medium">
                  {g}
                  <span aria-hidden="true" className="text-primary/60">×</span>
                </button>
              ))}
            </div>
          )}
        </div>
      } />

      {selectionChanged && <p role="status" className="mx-4 sm:mx-8 mt-3 text-sm text-textMuted">Showing the last plotted gene set. Click Plot to apply your current selection.</p>}

      {error && (
        <div className="mx-8 mt-4 p-3 bg-danger/10 border border-danger/30 rounded-lg text-danger text-sm flex items-center gap-2 shrink-0">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      {dotData && categoryPlotWidth(dotData.genes, dotData.clusters) > chart.width - 48 && <p role="note" className="mx-4 sm:mx-6 mt-3 text-xs text-textMuted">Scroll horizontally to inspect all clusters; hover a cell for its values.</p>}

      <div ref={chart.ref} className="min-w-0 p-3 sm:p-6 overflow-x-auto shrink-0" style={{ height: Math.max(380, Math.min(1000, (Array.isArray(dotData?.genes) ? dotData.genes.length : dotData?.genes ? 1 : 3) * 28 + (chart.compact ? 180 : 120))) }}>
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-slate-400">
              <span className="animate-spin border-2 border-primary border-t-transparent rounded-full w-8 h-8 inline-block mb-3" />
              <p className="text-sm">Fetching expression data…</p>
            </div>
          </div>
        ) : dotData ? (
          <Plot
            data={traces}
            layout={layout}
            config={{ responsive: true, displayModeBar: true, displaylogo: false }}
            style={{ width: '100%', minWidth: categoryPlotWidth(dotData?.genes, dotData?.clusters), height: '100%' }}
            useResizeHandler
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-slate-400">
              <CircleDot size={48} className="mx-auto mb-4 opacity-30" />
              <p className="text-sm">Add genes and click Plot to visualize expression.</p>
            </div>
          </div>
        )}
      </div>

      <FigureSavePanel
        isOpen={savePanelOpen}
        onClose={() => setSavePanelOpen(false)}
        plotType="DotPlot"
        baseParams={{ features: plottedGenes, groupBy: 'seurat_clusters' }}
        userEmail={userEmail || ''}
        objectId={objectId || ''}
        deploymentPolicy={deploymentPolicy}
      />
    </div>
  );
}
