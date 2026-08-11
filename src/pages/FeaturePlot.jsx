import React, { useState, useEffect } from 'react';
import Plot from '../components/Plot';
import { Palette, AlertTriangle, Sun, Moon, ImageDown } from 'lucide-react';
import FigureSavePanel from '../components/FigureSavePanel';
import { publicErrorMessage } from '../publicError';

// Removed API constant
// Dark mode: faithful magma ramp, starting at a dark purple visible against the navy background
const DARK_COLORSCALE = [
  [0,    '#3b0f70'],   // deep indigo-purple (visible on dark bg, not blue)
  [0.25, '#8c2981'],   // magenta-purple
  [0.5,  '#de4968'],   // crimson-pink
  [0.75, '#fe9f6d'],   // peach-orange
  [1,    '#fcfdbf'],   // pale yellow-white
];

// Light mode: standard Blues scale (white → dark blue) — common in scRNA-seq publications
const LIGHT_COLORSCALE = 'Blues';

export default function FeaturePlot({ datasetInfo, pipelineState, sessionReady, userEmail, objectId, callApi, deploymentPolicy }) {
  const [savePanelOpen, setSavePanelOpen] = useState(false);
  const [gene, setGene] = useState('');
  const [geneInput, setGeneInput] = useState('');
  const [plotData, setPlotData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [geneList, setGeneList] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [lightMode, setLightMode] = useState(false);

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

  const fetchFeaturePlot = async (g) => {
    const requested = String(g || geneInput).trim();
    const target = geneList.find(item => item.toLowerCase() === requested.toLowerCase());
    if (requested && !target) {
      setError(`Gene "${requested}" was not found.`);
      setPlotData(null);
      setSuggestions([]);
      return;
    }
    if (!target) return;
    setLoading(true);
    setError(null);
    setPlotData(null);
    setSuggestions([]);
    try {
      const data = await callApi(`/feature-values?gene=${encodeURIComponent(target)}`, {}, { useCache: false });
      if (data.error) throw new Error(data.error);
      setPlotData(data);
      setGene(target);
      setGeneInput(target);
    } catch (e) {
      setError(publicErrorMessage(e, 'The feature plot could not be prepared. Please try again.'));
    }
    setLoading(false);
  };

  const hasUmap = pipelineState?.umap;

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <Palette size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
          <p className="text-textMuted">Load a dataset in the Workspace first.</p>
        </div>
      </div>
    );
  }

  if (!hasUmap) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-text mb-2">UMAP Required</h2>
          <p className="text-textMuted">Run the UMAP step in Core Preprocessing before generating feature plots.</p>
        </div>
      </div>
    );
  }

  const colorscale = lightMode ? LIGHT_COLORSCALE : DARK_COLORSCALE;
  // Plotly's 'Blues' goes dark→light by default; reverse so low expression = white
  const reversescale = lightMode;

  const trace = plotData ? [{
    type: 'scattergl',
    mode: 'markers',
    x: plotData.u1,
    y: plotData.u2,
    marker: {
      size: 4,
      color: plotData.expression,
      colorscale,
      reversescale,
      showscale: true,
      colorbar: {
        title: { text: gene, side: 'right' },
        thickness: 14,
        len: 0.6,
        tickfont: { color: lightMode ? '#334155' : '#94a3b8' },
        titlefont: { color: lightMode ? '#334155' : '#94a3b8' },
      },
      opacity: 0.9,
    },
    hovertemplate: `<b>${gene}</b>: %{marker.color:.3f}<extra></extra>`,
  }] : [];

  const layout = {
    autosize: true,
    paper_bgcolor: lightMode ? '#ffffff' : 'transparent',
    plot_bgcolor: lightMode ? '#ffffff' : 'transparent',
    font: {
      color: lightMode ? '#334155' : '#94a3b8',
      size: 11,
      family: 'Inter, system-ui',
    },
    margin: { l: 50, r: 60, t: 30, b: 50 },
    xaxis: {
      title: 'UMAP 1',
      gridcolor: lightMode ? '#e2e8f0' : '#1e293b',
      linecolor: lightMode ? '#cbd5e1' : 'transparent',
      zeroline: false,
    },
    yaxis: {
      title: 'UMAP 2',
      gridcolor: lightMode ? '#e2e8f0' : '#1e293b',
      linecolor: lightMode ? '#cbd5e1' : 'transparent',
      zeroline: false,
    },
    showlegend: false,
  };

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      <div className="px-8 pt-6 pb-4 border-b border-border flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-2xl font-bold text-text tracking-tight">Feature Plot</h2>
          <p className="text-textMuted text-sm">Visualize gene expression overlaid on UMAP coordinates.</p>
        </div>

        <div className="relative flex items-center gap-2">
          {/* Light / Dark toggle */}
          <button
            onClick={() => setLightMode(m => !m)}
            title={lightMode ? 'Switch to dark background' : 'Switch to white background'}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-textMuted hover:text-text hover:border-primary transition-colors text-sm"
          >
            {lightMode
              ? <><Moon size={14} /> Dark</>
              : <><Sun size={14} /> Light</>
            }
          </button>

          <div className="relative">
            <input
              type="text"
              value={geneInput}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchFeaturePlot()}
              placeholder="Gene symbol (e.g. CD3E)"
              className="bg-surface border border-border text-text text-sm px-3 py-2 rounded-lg w-52 focus:outline-none focus:border-primary"
            />
            {suggestions.length > 0 && (
              <div className="absolute top-full left-0 mt-1 w-full bg-surface border border-border rounded-lg shadow-2xl z-50 overflow-hidden">
                {suggestions.map(s => (
                  <button
                    key={s}
                    onClick={() => fetchFeaturePlot(s)}
                    className="w-full text-left px-3 py-1.5 text-sm text-textMuted hover:bg-primary/10 hover:text-text transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => fetchFeaturePlot()}
            disabled={loading || !geneInput.trim()}
            className="btn btn-primary text-sm px-4 py-2"
          >
            {loading ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4 inline-block" /> : 'Plot'}
          </button>
          {plotData && (
            <button onClick={() => setSavePanelOpen(true)} className="btn btn-ghost border border-border text-sm px-3 py-2 text-primary hover:bg-primary/10 flex items-center gap-1.5">
              <ImageDown size={14} /> Save Figure
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-8 mt-4 p-3 bg-danger/10 border border-danger/30 rounded-lg text-danger text-sm flex items-center gap-2 shrink-0">
          <AlertTriangle size={16} /> {error}
        </div>
      )}

      <div className="flex-1 p-6 overflow-hidden">
        {plotData ? (
          <Plot
            data={trace}
            layout={layout}
            config={{ responsive: true, displayModeBar: true, displaylogo: false }}
            style={{ width: '100%', height: '100%' }}
            useResizeHandler
          />
        ) : (
          <div className="h-full flex items-center justify-center">
            <div className="text-center text-slate-400">
              <Palette size={48} className="mx-auto mb-4 opacity-30" />
              <p className="text-sm">Search for a gene above to generate a feature plot.</p>
            </div>
          </div>
        )}
      </div>
      <FigureSavePanel
        isOpen={savePanelOpen}
        onClose={() => setSavePanelOpen(false)}
        plotType="FeaturePlot"
        baseParams={{ features: gene ? [gene] : [], groupBy: 'seurat_clusters' }}
        userEmail={userEmail || ''}
        objectId={objectId || ''}
        deploymentPolicy={deploymentPolicy}
      />
    </div>
  );
}
