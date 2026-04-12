import React, { useState } from 'react';
import { Microscope, Activity, ChevronRight, AlertTriangle, Download } from 'lucide-react';
import Plot from 'react-plotly.js';

export default function Enrichment({ callApi, datasetInfo, currentProvId, openProvenance }) {
  const [computing, setComputing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Microscope size={48} className="mx-auto text-slate-600 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  const runGSEA = async () => {
    setComputing(true);
    setError(null);

    const data = await callApi('/enrichment', {}, {
      operation: 'enrichment',
      step: 'enrichment',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: false
    });

    if (!data) {
      setError('R backend error: Enrichment analysis failed. Check the R console for details.');
      setComputing(false);
      return;
    }
    if (data.error) {
      setError(data.error);
      setComputing(false);
      return;
    }

    setResult(data);
    setComputing(false);
  };

  const pathways = result?.result?.top_pathways || [];

  const chartData = [{
    type: 'bar',
    orientation: 'h',
    x: pathways.map(p => -Math.log10(p.p_adj)),
    y: pathways.map(p => p.name),
    marker: {
      color: ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e'],
      opacity: 0.85
    },
    hovertemplate: '<b>%{y}</b><br>-log10(p-adj): %{x:.1f}<extra></extra>'
  }];

  const layout = {
    autosize: true, margin: { l: 150, r: 20, t: 30, b: 50 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#94a3b8', size: 11 },
    xaxis: { title: '-log10(p-adj)', gridcolor: '#334155', zeroline: false },
    yaxis: { gridcolor: '#334155' },
    hoverlabel: { bgcolor: '#1e293b', bordercolor: '#475569', font: { color: '#e2e8f0', size: 12 } }
  };

  return (
    <div className="h-full w-full flex flex-col bg-background p-8 overflow-y-auto custom-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">Pathway Enrichment (GSEA)</h2>
          <p className="text-textMuted">Identify biological processes over-represented in your marker genes via Reactome/KEGG.</p>
        </div>
        <div className="flex gap-3">
          {result && (
            <button 
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            >📝 View Step Script</button>
          )}
          <button 
            onClick={runGSEA}
            disabled={computing || !!result}
            className={`btn ${result ? 'bg-success/20 text-success border border-success' : 'btn-primary'} flex items-center gap-2`}
          >
            {computing ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span> : <Activity size={18} />}
            {result ? 'Analysis Complete' : 'Run GSEA / ORA'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {!result && !computing && !error && (
        <div className="card p-12 text-center flex flex-col items-center justify-center flex-1 bg-black/10 border-dashed border-2">
           <Microscope size={56} className="text-primary opacity-40 mb-4" />
           <p className="text-slate-400 max-w-sm mb-6">Requires DEGs to have been computed. Transforms marker gene lists into biological pathway insights.</p>
           <div className="flex gap-4">
              <div className="px-3 py-1.5 bg-surface border border-border rounded text-xs text-textMuted">Database: Reactome</div>
              <div className="px-3 py-1.5 bg-surface border border-border rounded text-xs text-textMuted">Species: H. sapiens</div>
           </div>
        </div>
      )}

      {computing && (
        <div className="flex flex-col items-center justify-center flex-1">
          <div className="flex gap-2 mb-4">
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
            <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
          </div>
          <span className="text-xs uppercase tracking-widest font-black text-primary animate-pulse">Running clusterProfiler Algorithm...</span>
        </div>
      )}

      {result && (
        <div className="grid grid-cols-12 gap-8 flex-1">
          <div className="col-span-12 card p-6 h-[400px]">
             <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
               <div className="w-1.5 h-1.5 rounded-full bg-primary"></div> Pathway Over-Representation
             </h3>
             <div className="flex-1 w-full min-h-0">
                <Plot 
                  data={chartData} 
                  layout={layout} 
                  config={{ displayModeBar: false, responsive: true }} 
                  className="w-full h-full"
                  useResizeHandler
                />
             </div>
          </div>

          <div className="col-span-12 card">
            <div className="p-4 border-b border-border bg-slate-800/40 flex justify-between items-center">
               <h4 className="font-bold text-white text-xs uppercase tracking-widest">Enrichment Table</h4>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                 <thead className="bg-black/20 text-textMuted font-bold uppercase border-b border-border">
                   <tr>
                     <th className="p-4">Pathway Name</th>
                     <th className="p-4 text-center">Count</th>
                     <th className="p-4 text-center">Gene Ratio</th>
                     <th className="p-4 text-center">p-adj (BH)</th>
                     <th className="p-4">Leading Edge Genes</th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-border/30">
                   {pathways.map((row, i) => (
                      <tr key={i} className="hover:bg-white/5 transition-colors">
                         <td className="p-4 font-bold text-white flex items-center gap-2">
                           <ChevronRight size={14} className="text-primary" /> {row.name}
                         </td>
                         <td className="p-4 text-center">{row.count}</td>
                         <td className="p-4 text-center font-mono opacity-60 text-[10px]">{row.ratio}</td>
                         <td className="p-4 text-center text-success font-mono">{row.p_adj.toExponential(2)}</td>
                         <td className="p-4 text-slate-400 italic truncate max-w-[200px]">{row.genes}</td>
                      </tr>
                    ))}
                 </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
