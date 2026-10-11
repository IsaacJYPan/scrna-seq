import { publicErrorMessage } from '../publicError';
import { usePlotGeometry } from '../hooks/usePlotGeometry';
import './analysisUi.css';
import PageHeader from '../components/PageHeader';
import React, { useState } from 'react';
import { Search, BarChart3, Play, Layers, ChevronDown, ChevronRight, ImageDown } from 'lucide-react';
import Plot, { getPlotHoverStyle } from '../components/Plot';
import FigureSavePanel from '../components/FigureSavePanel';
import UmapPrerequisiteNotice, { hasUmapResult } from '../components/UmapPrerequisiteNotice';

const GENE_CATEGORIES = {
  'T-Cell': ['CD3E','CD3D','CD3G','CD4','CD8A','CD8B','IL7R','CCR7','TCF7','LEF1','CD2','CD27','CD28','ICOS','CTLA4','PDCD1','IL2RA','IFNG','TNF','GZMA','GZMB','GZMK','PRF1'],
  'B-Cell': ['CD79A','CD79B','MS4A1','CD19','CD22','CD40','PAX5','TCL1A','VPREB3','FCER2','IGHM','IGHD','IGKC','BLK','BANK1','LINC00926'],
  'Monocyte / Macrophage': ['LYZ','CD14','FCGR3A','S100A8','S100A9','S100A12','CST3','FCN1','VCAN','MNDA','CD68','CD163','AIF1','FTL','TYROBP','FCER1G','LGALS1','CFD'],
  'NK Cell': ['GNLY','NKG7','KLRD1','KLRB1','KLRC1','KLRF1','NCAM1','FGFBP2','SPON2','XCL1','CTSW','GZMB'],
  'Dendritic': ['FCER1A','CD1C','CLEC4C','CLEC10A','IRF4','IRF8','JCHAIN','IL3RA','NRP1','LILRA4','PLD4','TCF4'],
  'Platelet': ['PPBP','PF4','GP9','NRGN','TUBB1','SPARC','GNG11','SDPR','CLU'],
  'Housekeeping': ['ACTB','GAPDH','B2M','MALAT1','TMSB4X','EEF1A1','RPL13','RPS27'],
  'Proliferation': ['MKI67','TOP2A','STMN1','HMGB2','TYMS','CDK1','PCNA','MCM5'],
  'Mitochondrial': ['MT-CO1','MT-CO2','MT-ND1','MT-ND4','MT-ATP6','MT-CYB','MT-RNR1','MT-RNR2'],
};

const CLUSTERS = ['T-Cell', 'B-Cell', 'Monocyte', 'NK Cell', 'Dendritic', 'Platelet'];
const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#eab308'];

function formatViolinData(data) {
  if (!data) return [];
  const { expression, clusters } = data;
  const uniqueClusters = [...new Set(clusters)].sort();
  
  return uniqueClusters.map((cl, i) => {
    const pts = expression.filter((_, idx) => clusters[idx] === cl);
    return {
      type: 'violin',
      y: pts,
      name: `Cluster ${cl}`,
      box: { visible: true },
      meanline: { visible: true },
      line: { color: COLORS[i % COLORS.length] },
      fillcolor: COLORS[i % COLORS.length] + '40',
      points: false,
      hovertemplate: `<b>Cluster ${cl}</b><br>Expression: %{y:.2f}<extra></extra>`
    };
  });
}

function formatFeaturePlot(data, theme) {
  if (!data || !data.u1) return [];
  const { expression, u1, u2 } = data;
  // Theme-aware colorbar text; a fixed dark gray rendered at ~2.6:1 on the
  // light-mode transparent plot background.
  const colorbarText = theme === 'dark' ? '#94a3b8' : '#475569';

  return [{
    type: 'scattergl',
    mode: 'markers',
    x: u1,
    y: u2,
    marker: {
      size: 4,
      color: expression,
      colorscale: [[0, '#1e293b'], [0.5, '#7c3aed'], [1, '#facc15']],
      showscale: true,
      colorbar: { thickness: 15, tickfont: { color: colorbarText }, titlefont: { color: colorbarText } }
    },
    hovertemplate: `<b>${data.gene}</b><br>Expression: %{marker.color:.2f}<extra></extra>`
  }];
}

export default function GeneViewer({ datasetInfo, pipelineState, userEmail, objectId, callApi, theme, deploymentPolicy, onNavigateToUmap }) {
  const chart = usePlotGeometry();
  const [browserOpen, setBrowserOpen] = useState(false);
  const [savePanelOpen, setSavePanelOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeGene, setActiveGene] = useState(null);
  const [geneData, setGeneData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState('violin');
  const [expandedCats, setExpandedCats] = useState({ 'T-Cell': true });
  const [suggestions, setSuggestions] = useState([]);
  const [error, setError] = useState(null);

  // All gene symbols from categories
  const allGenes = [...new Set(Object.values(GENE_CATEGORIES).flat())];

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <BarChart3 size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  const fetchGeneData = async (gene) => {
    setLoading(true);
    setError(null);
    try {
      const data = await callApi(`/gene-expression?gene=${encodeURIComponent(gene)}`, {}, { useCache: false });
      if (data.error) {
        setError(publicErrorMessage(data.error, 'Gene expression could not be loaded. Check the gene symbol and try again.'));
      } else {
        setGeneData(data);
        setActiveGene(gene);
      }
    } catch {
      setError("Failed to fetch gene data.");
    }
    setLoading(false);
  };

  const selectGene = (gene) => {
    setQuery(gene);
    setSuggestions([]);
    fetchGeneData(gene);
  };

  const handleSearch = (e) => {
    e.preventDefault();
    if (query.trim()) {
      fetchGeneData(query.trim().toUpperCase());
      setSuggestions([]);
    }
  };

  const handleQueryChange = (val) => {
    setQuery(val);
    if (val.length >= 2) {
      const matches = allGenes.filter(g => g.toLowerCase().startsWith(val.toLowerCase())).slice(0, 8);
      setSuggestions(matches);
    } else {
      setSuggestions([]);
    }
  };

  const toggleCategory = (cat) => {
    setExpandedCats(prev => ({ ...prev, [cat]: !prev[cat] }));
  };

  const isDark = theme === 'dark';
  const plotText = isDark ? '#94a3b8' : '#475569';
  const plotGrid = isDark ? '#334155' : '#d8e0ea';
  const hasUmap = hasUmapResult(pipelineState);

  return (
    <div className="h-full w-full flex flex-col lg:flex-row bg-background overflow-hidden">
      {/* Gene browser sidebar */}
      <div className="gene-browser w-full lg:w-64 border-b lg:border-b-0 lg:border-r border-border flex flex-col bg-surface flex-shrink-0">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-bold text-text">Gene Browser</h3><button type="button" className="lg:hidden text-sm text-primary min-h-10 px-2" aria-expanded={browserOpen} aria-controls="gene-category-browser" onClick={() => setBrowserOpen(open => !open)}>{browserOpen ? 'Hide categories' : 'Browse categories'}</button></div>
          <form onSubmit={handleSearch} className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              aria-label="Search gene by symbol"
              value={query}
              onChange={e => handleQueryChange(e.target.value)}
              placeholder="Search gene (CD3E, LYZ...)"
              className="w-full bg-background border border-border rounded-lg py-2 pl-9 pr-3 text-sm text-text focus:outline-none focus:border-primary placeholder:text-slate-400"
            />
            {suggestions.length > 0 && (
              <div className="absolute top-full mt-1 left-0 right-0 bg-slate-800 border border-border rounded-lg overflow-hidden z-20 shadow-xl">
                {suggestions.map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => selectGene(g)}
                    className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-primary/20 hover:text-primary font-mono"
                  >{g}</button>
                ))}
              </div>
            )}
          </form>
        </div>

        <div id="gene-category-browser" className={`gene-browser-body flex-1 overflow-y-auto custom-scrollbar p-2 ${browserOpen ? 'block' : 'hidden lg:block'}`}>
          {Object.entries(GENE_CATEGORIES).map(([cat, genes]) => (
            <div key={cat} className="mb-1">
              <button
                onClick={() => toggleCategory(cat)}
                aria-expanded={!!expandedCats[cat]} className="gene-category w-full flex items-center gap-2 px-2 py-1.5 text-xs font-bold text-slate-400 hover:text-text rounded hover:bg-white/5 transition-colors"
              >
                {expandedCats[cat] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="uppercase tracking-wider">{cat}</span>
                <span className="ml-auto text-slate-400 font-mono text-[10px]">{genes.length}</span>
              </button>
              {expandedCats[cat] && (
                <div className="flex flex-wrap gap-1 px-2 pb-2 pt-1">
                  {genes.map(g => (
                    <button
                      key={g}
                      onClick={() => selectGene(g)}
                      aria-pressed={activeGene === g} className={`gene-chip rounded font-bold uppercase tracking-wider transition-all border
                        ${activeGene === g 
                          ? 'bg-primary/20 border-primary text-primary' 
                          : 'bg-surface border-border text-textMuted hover:border-primary hover:text-text'}`}
                    >{g}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-border text-[10px] text-slate-400 text-center">
          {allGenes.length} suggested markers · search any dataset gene
        </div>
      </div>

      {/* Main plot area */}
      <div className="flex-1 min-w-0 flex flex-col p-4 sm:p-6 overflow-y-auto custom-scrollbar">
        <PageHeader title="Gene Expression Viewer" description="Compare expression across cell groups or inspect expression on UMAP." className="mb-6" actions={<>
          {activeGene && (
            <div className="flex flex-wrap shrink-0 items-center gap-2 sm:gap-3 max-w-full">
              <div className="flex flex-wrap shrink-0 bg-surface rounded-lg p-1 border border-border">
                <button 
                  onClick={() => setViewMode('violin')}
                  className={`px-4 py-2 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'violin' ? 'bg-primary text-white shadow' : 'text-slate-400 hover:text-text'}`}
                >
                  <BarChart3 size={14} /> VlnPlot
                </button>
                <button 
                  onClick={() => setViewMode('feature')}
                  className={`px-4 py-2 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'feature' ? 'bg-primary text-white shadow' : 'text-slate-400 hover:text-text'}`}
                >
                  <Layers size={14} /> FeaturePlot
                </button>
              </div>
              <button
                onClick={() => setSavePanelOpen(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-primary/50 text-primary hover:bg-primary/10 transition-colors text-xs font-bold"
              >
                <ImageDown size={14} /> Save Figure
              </button>
            </div>
          )}
        </>} />

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center space-y-4">
            <div className="flex gap-2">
              <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
              <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
              <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
            </div>
            <p className="text-textMuted font-medium animate-pulse">Fetching expression matrix for {query}...</p>
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-danger max-w-sm">
              <Play className="mx-auto mb-4 opacity-50 rotate-90" size={48} />
              <p className="font-bold">{error}</p>
              <p className="text-sm opacity-70 mt-2">Check that the symbol exists in this dataset and that the analysis session is available. UMAP is required only for the feature view.</p>
            </div>
          </div>
        ) : !activeGene ? (
          <div className="flex-1 flex items-center justify-center ">
            <div className="text-center">
              <BarChart3 size={64} className="mx-auto mb-4" />
              <p className="text-xl font-black text-slate-300 tracking-tight">Select a gene to visualize</p>
              <p className="text-sm text-slate-400 mt-2">Search by gene symbol or browse marker categories.</p>
            </div>
          </div>
        ) : viewMode === 'feature' && !hasUmap ? (
          <div className="flex-1 rounded-lg border border-border bg-surface/40">
            <UmapPrerequisiteNotice compact onNavigateToUmap={onNavigateToUmap} />
          </div>
        ) : (
          <div className="flex-1">
            <div className="card p-3 sm:p-6 bg-surface">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[10px] font-black text-primary uppercase tracking-[.2em]">
                  {viewMode === 'violin' ? 'Violin Plot' : 'Feature Plot'}
                </span>
                <span className="text-lg font-black text-text">{activeGene}</span>
              </div>
              <div ref={chart.ref} className="w-full h-[340px] sm:h-[440px]">
                <Plot 
                  preferSvg={viewMode === 'feature'}
                  data={viewMode === 'violin' ? formatViolinData(geneData) : formatFeaturePlot(geneData, theme)}
                  layout={{
                    autosize: true,
                    paper_bgcolor: 'transparent',
                    plot_bgcolor: 'transparent',
                    font: { color: plotText, size: 12 },
                    margin: { l: 48, r: viewMode === 'feature' ? 64 : 12, t: 20, b: 64 },
                    hoverlabel: getPlotHoverStyle(theme),
                    ...(viewMode === 'violin' ? {
                      xaxis: { gridcolor: plotGrid, title: { text: 'Cluster' }, automargin: true },
                      yaxis: { title: { text: 'Expression' }, automargin: true, gridcolor: plotGrid },
                      showlegend: false
                    } : {
                      xaxis: { title: { text: 'UMAP 1' }, automargin: true, showgrid: false, zeroline: false },
                      yaxis: { title: { text: 'UMAP 2' }, automargin: true, showgrid: false, zeroline: false },
                      showlegend: false
                    })
                  }}
                  config={{ responsive: true, displaylogo: false }}
                  className="w-full h-full"
                  useResizeHandler
                />
              </div>
            </div>
          </div>
        )}
      </div>
      <FigureSavePanel
        isOpen={savePanelOpen}
        onClose={() => setSavePanelOpen(false)}
        plotType={viewMode === 'violin' ? 'Violin' : 'FeaturePlot'}
        baseParams={{ features: activeGene ? [activeGene] : [], groupBy: 'seurat_clusters' }}
        userEmail={userEmail || ''}
        objectId={objectId || ''}
        deploymentPolicy={deploymentPolicy}
      />
    </div>
  );
}
