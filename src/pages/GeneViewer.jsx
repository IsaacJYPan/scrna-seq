import React, { useState, useEffect } from 'react';
import { Search, BarChart3, Play, Layers, ChevronDown, ChevronRight, ImageDown } from 'lucide-react';
import Plot from 'react-plotly.js';
import FigureSavePanel from '../components/FigureSavePanel';

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

const hoverStyle = {
  bgcolor: '#1e293b', bordercolor: '#475569',
  font: { color: '#e2e8f0', size: 12, family: 'Inter, system-ui' }
};

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

function formatFeaturePlot(data) {
  if (!data || !data.u1) return [];
  const { expression, u1, u2 } = data;
  
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
      colorbar: { thickness: 15, tickfont: { color: '#94a3b8' }, titlefont: { color: '#94a3b8' } }
    },
    hovertemplate: `<b>${data.gene}</b><br>Expr: %{marker.color:.2f}<extra></extra>`
  }];
}

export default function GeneViewer({ datasetInfo, userEmail, objectId }) {
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
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  const fetchGeneData = async (gene) => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.electronAPI.apiRequest(`/gene-expression?gene=${encodeURIComponent(gene)}`);
      if (data.error) {
        setError(data.error);
      } else {
        setGeneData(data);
        setActiveGene(gene);
      }
    } catch (err) {
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

  return (
    <div className="h-full w-full flex bg-background overflow-hidden">
      {/* Gene browser sidebar */}
      <div className="w-72 border-r border-border flex flex-col bg-surface flex-shrink-0">
        <div className="p-4 border-b border-border">
          <h3 className="text-sm font-bold text-white mb-3">Gene Browser</h3>
          <form onSubmit={handleSearch} className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text"
              value={query}
              onChange={e => handleQueryChange(e.target.value)}
              placeholder="Search gene (CD3E, LYZ...)"
              className="w-full bg-background border border-border rounded-lg py-2 pl-9 pr-3 text-xs text-white focus:outline-none focus:border-primary placeholder:text-slate-400"
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

        <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
          {Object.entries(GENE_CATEGORIES).map(([cat, genes]) => (
            <div key={cat} className="mb-1">
              <button
                onClick={() => toggleCategory(cat)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-bold text-slate-400 hover:text-white rounded hover:bg-white/5 transition-colors"
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
                      className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-all border
                        ${activeGene === g 
                          ? 'bg-primary/20 border-primary text-primary' 
                          : 'bg-slate-800 border-border text-slate-400 hover:border-slate-600 hover:text-slate-300'}`}
                    >{g}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="p-3 border-t border-border text-[10px] text-slate-400 text-center">
          {allGenes.length} genes available
        </div>
      </div>

      {/* Main plot area */}
      <div className="flex-1 flex flex-col p-6 overflow-y-auto custom-scrollbar">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">Gene Expression Viewer</h2>
            <p className="text-textMuted text-sm">Visualize per-cluster expression profiles via VlnPlot and FeaturePlot.</p>
          </div>
          {activeGene && (
            <div className="flex items-center gap-3">
              <div className="flex bg-slate-800 rounded-lg p-1 border border-border">
                <button 
                  onClick={() => setViewMode('violin')}
                  className={`px-4 py-2 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'violin' ? 'bg-primary text-white shadow' : 'text-slate-400 hover:text-white'}`}
                >
                  <BarChart3 size={14} /> VlnPlot
                </button>
                <button 
                  onClick={() => setViewMode('feature')}
                  className={`px-4 py-2 rounded-md text-xs font-bold transition-all flex items-center gap-2 ${viewMode === 'feature' ? 'bg-primary text-white shadow' : 'text-slate-400 hover:text-white'}`}
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
        </div>

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
              <p className="text-sm opacity-70 mt-2">Try another gene or ensure the pipeline is complete up to UMAP.</p>
            </div>
          </div>
        ) : !activeGene ? (
          <div className="flex-1 flex items-center justify-center ">
            <div className="text-center">
              <BarChart3 size={64} className="mx-auto mb-4" />
              <p className="text-xl font-black text-slate-300 tracking-tight">Select a gene to visualize</p>
              <p className="text-sm text-slate-400 mt-2">Browse categories on the left or search by symbol.</p>
            </div>
          </div>
        ) : (
          <div className="flex-1">
            <div className="card p-6 bg-slate-800/40">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[10px] font-black text-primary uppercase tracking-[.2em]">
                  {viewMode === 'violin' ? 'Violin Plot' : 'Feature Plot'}
                </span>
                <span className="text-lg font-black text-white">{activeGene}</span>
              </div>
              <div className="w-full h-[480px]">
                <Plot 
                  data={viewMode === 'violin' ? formatViolinData(geneData) : formatFeaturePlot(geneData)}
                  layout={{
                    autosize: true,
                    paper_bgcolor: 'transparent',
                    plot_bgcolor: 'transparent',
                    font: { color: '#94a3b8' },
                    margin: { l: 60, r: 20, t: 20, b: 60 },
                    hoverlabel: hoverStyle,
                    ...(viewMode === 'violin' ? {
                      xaxis: { gridcolor: '#334155', title: 'Clusters' },
                      yaxis: { title: 'Expression Level', gridcolor: '#334155' },
                      showlegend: false
                    } : {
                      xaxis: { title: 'UMAP1', showgrid: false, zeroline: false },
                      yaxis: { title: 'UMAP2', showgrid: false, zeroline: false },
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
      />
    </div>
  );
}
