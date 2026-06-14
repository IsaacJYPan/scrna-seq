import React, { useState } from 'react';
import { Layers, MousePointer2, ListFilter, Play } from 'lucide-react';
import Plot from 'react-plotly.js';

const generateMock3DData = () => {
  const traces = [];
  const clusters = ['T-Cell', 'B-Cell', 'Monocyte', 'NK Cell', 'Dendritic'];
  const colors = ['#f8766d', '#a3a500', '#00bf7d', '#00b0f6', '#e76bf3'];

  clusters.forEach((cluster, i) => {
    const numPoints = Math.floor(Math.random() * 200) + 100;
    const cx = Math.random() * 10;
    const cy = Math.random() * 10;
    const cz = Math.random() * 10;

    const x = Array.from({ length: numPoints }, () => cx + (Math.random() - 0.5) * 3);
    const y = Array.from({ length: numPoints }, () => cy + (Math.random() - 0.5) * 3);
    const z = Array.from({ length: numPoints }, () => cz + (Math.random() - 0.5) * 3);

    traces.push({
      x, y, z,
      mode: 'markers',
      type: 'scatter3d',
      name: cluster,
      marker: { size: 3, color: colors[i], opacity: 0.8 },
    });
  });
  return traces;
};

export default function Exploration({ callApi, datasetInfo, selectedObjects, currentProvId, openProvenance }) {
  const [computing, setComputing] = useState(false);
  const [plotted, setPlotted] = useState(false);
  const [plotData, setPlotData] = useState([]);
  const [exploreResult, setExploreResult] = useState(null);
  const [activeTabObjId, setActiveTabObjId] = useState(null);

  // Default to the first selected object if none selected on startup
  const displayObj = (selectedObjects && selectedObjects.length > 0) ? 
    selectedObjects.find(o => o.id === (activeTabObjId || selectedObjects[0].id)) 
    : datasetInfo;

  if (!displayObj) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Layers size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  const runPCA_UMAP = async () => {
    setComputing(true);
    const data = await callApi('/umap', {}, {
      operation: 'umap',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: true,
      cacheParams: { type: 'umap' }
    });
    
    if (data && data.result) {
      setPlotData(generateMock3DData());
      setExploreResult(data);
      setPlotted(true);
    }
    setComputing(false);
  };

  return (
    <div className="h-full w-full flex flex-col bg-background p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">3D Spatial & UMAP Exploration</h2>
          <p className="text-textMuted">Interactive dimensional reduction and clustering topology for <span className="text-primary font-bold">{displayObj.name}</span>.</p>
        </div>
        
        <div className="flex gap-3">
          {exploreResult && (
             <button 
               className="btn btn-ghost border border-primary/50 text-primary text-sm flex items-center gap-2"
               onClick={() => openProvenance(exploreResult.provenance.id)}
             >
               🔗 View Script
             </button>
          )}
          <select className="bg-surface border border-border text-white rounded px-3 py-2 text-sm focus:outline-none focus:border-primary">
            <option>Seurat Leiden (Res 0.6)</option>
            <option>Louvain Clustering</option>
            <option>CellTypist (Auto Annotate)</option>
          </select>
          <button 
            onClick={runPCA_UMAP}
            className="btn btn-primary flex items-center gap-2"
            disabled={computing}
          >
            {computing ? <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span> : <Play size={16} />}
            Run 3D UMAP
          </button>
        </div>
      </div>

      {selectedObjects && selectedObjects.length > 1 && (
        <div className="flex gap-2 overflow-x-auto mb-4 border-b border-border/50 pb-2 custom-scrollbar">
          {selectedObjects.map((obj) => {
            const isActive = (activeTabObjId || selectedObjects[0].id) === obj.id;
            return (
              <button
                key={obj.id}
                onClick={() => { setActiveTabObjId(obj.id); setPlotted(false); }}
                className={`px-4 py-2 rounded-lg text-xs font-bold transition-all border ${isActive ? 'bg-primary/20 border-primary text-primary' : 'bg-surface border-border text-slate-400'}`}
              >
                {obj.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 flex gap-6 min-h-0">
        <div className="flex-1 bg-surface border border-border rounded-lg relative overflow-hidden flex flex-col">
          {!plotted && !computing && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center p-8">
                <MousePointer2 size={40} className="mx-auto text-textMuted mb-4 opacity-40" />
                <p className="text-textMuted">Configure clustering parameters and click "Run 3D UMAP" to hit the R backend.</p>
              </div>
            </div>
          )}
          
          {computing && (
             <div className="flex-1 flex items-center justify-center">
               <div className="text-center p-8">
                 <div className="text-primary tracking-widest uppercase font-bold text-sm mb-4">COMPUTING PCA & NEIGHBORHOOD GRAPH VIA SEURAT V5...</div>
                 <div className="w-64 h-2 bg-black/50 rounded-full overflow-hidden mx-auto">
                   <div className="h-full bg-primary animate-[translate_1s_infinite]"></div>
                 </div>
               </div>
             </div>
          )}

          {plotted && (
            <div className="w-full h-full p-2 flex items-center justify-center bg-black/40 relative">
              {exploreResult?._fromCache && <div className="absolute top-4 right-4 z-10 text-[10px] bg-primary/20 text-primary px-2 py-0.5 rounded">CACHED MODEL</div>}
              <Plot
                data={plotData}
                layout={{
                  autosize: true, margin: { l: 0, r: 0, b: 0, t: 0 },
                  paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
                  scene: {
                    xaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
                    yaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
                    zaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
                    bgcolor: 'transparent', camera: { eye: { x: 1.5, y: 1.5, z: 1.5 } }
                  },
                  showlegend: false
                }}
                useResizeHandler={true} className="w-full h-full" config={{ displayModeBar: true, displaylogo: false, responsive: true }}
              />
            </div>
          )}
        </div>

        {/* Info Sidebar */}
        <div className="w-80 flex flex-col gap-4 flex-shrink-0">
          <div className="card p-4 flex-1 flex flex-col">
            <h4 className="font-semibold border-b border-border pb-2 mb-3 flex items-center gap-2 text-white">
              <ListFilter size={16} className="text-primary"/> Highlight Gene
            </h4>
            <div className="mb-4">
              <input type="text" placeholder="e.g. CD8A" className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary placeholder-slate-600" />
            </div>
            
            <h4 className="font-semibold border-b border-border pb-2 mb-3 mt-4 text-white">Cluster Annotations</h4>
            <div className="space-y-2 overflow-y-auto flex-1 custom-scrollbar">
              {exploreResult ? (
                ['Cluster 0 (T-Cell)', 'Cluster 1 (B-Cell)', 'Cluster 2 (Monocyte)', 'Cluster 3 (NK Cell)', 'Cluster 4 (Dendritic)'].map((c, i) => {
                  const colors = ['bg-[#f8766d]', 'bg-[#a3a500]', 'bg-[#00bf7d]', 'bg-[#00b0f6]', 'bg-[#e76bf3]'];
                  return (
                  <div key={i} className="flex justify-between items-center text-sm p-2 hover:bg-white/5 rounded cursor-pointer border border-transparent hover:border-border transition-colors">
                    <div className="flex items-center gap-2">
                      <div className={`w-3 h-3 rounded-full ${colors[i]}`}></div>
                      <span className="text-slate-300 font-medium">{c}</span>
                    </div>
                  </div>
                );
                })
              ) : (
                <div className="text-xs text-textMuted p-2">Awaiting computation...</div>
              )}
            </div>
            {exploreResult && (
              <div className="text-xs text-textMuted mt-4 pt-4 border-t border-border/50">
                {exploreResult.result.message}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
