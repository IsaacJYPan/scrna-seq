// LEGACY / PROTOTYPE — NOT IMPORTED.
// Cell annotation is not a production-integrated UI workflow; App.jsx renders a
// PlaceholderPage for the "annotate" tab instead of this component. This file is
// kept as a legacy live-R prototype (it calls the authenticated /api/r/* proxy).
// Do not build on it without deciding the annotation product direction first.
// See the "Implemented vs UI-wired" table in README.md.
import React, { useState, useCallback, useEffect } from 'react';
import { Tag, AlertTriangle, Save, Play } from 'lucide-react';
import { useTabParams } from '../hooks/useTabParams';

// Removed API constant
export default function Annotation({ callApi, datasetInfo, currentProvId, openProvenance, pipelineState, rSessionId, sessionReady, userEmail, objectId, updateActiveWorkspace }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  
  const [clusters, setClusters] = useState([]);
  const [loadingClusters, setLoadingClusters] = useState(false);

  // We persist the mappings in the tab params so you don't lose your work if you swap tabs.
  const [params, setParam, setParams] = useTabParams('annotation', userEmail, objectId, {
    mappings: {}
  });

  const fetchClusters = useCallback(async () => {
    setLoadingClusters(true);
    try {
      const data = await callApi('/meta-values?column=seurat_clusters');
      if (data.error) {
        // usually means missing or not clustered
        setClusters([]);
      } else {
        // Sort numerically
        const sorted = (data.values || []).sort((a, b) => Number(a.value) - Number(b.value));
        setClusters(sorted);
        
        // Fill only missing labels without capturing a stale mapping snapshot.
        setParams(previous => {
          const initMap = { ...previous.mappings };
          let changed = false;
          sorted.forEach(c => {
            if (initMap[c.value] === undefined) {
              initMap[c.value] = `Cluster ${c.value}`;
              changed = true;
            }
          });
          return changed ? { ...previous, mappings: initMap } : previous;
        });
      }
    } catch (e) {
      console.warn("Failed to fetch clusters", e);
    }
    setLoadingClusters(false);
  }, [callApi, setParams]);

  useEffect(() => {
    if (datasetInfo && pipelineState?.cluster && sessionReady) {
      fetchClusters();
    }
  }, [datasetInfo, pipelineState?.cluster, sessionReady, rSessionId, fetchClusters]);

  const handleMappingChange = (clusterId, newText) => {
    setParam('mappings', { ...params.mappings, [clusterId]: newText });
  };

  const runAnnotation = async () => {
    setRunning(true);
    setError(null);
    
    // Filter down mapping just to the active clusters to send to backend
    const currentMappings = {};
    clusters.forEach(c => {
      currentMappings[c.value] = params.mappings[c.value] || `Cluster ${c.value}`;
    });

    const data = await callApi('/annotate-clusters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mappings: currentMappings })
    }, {
      operation: 'annotate',
      step: 'annotate',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: false, // We always want to post the new definitions
    });

    if (data && data.result) {
      setResult(data);
      updateActiveWorkspace({ annotations: currentMappings });
    } else if (data && data.error) {
      setError(data.error);
    } else if (!data) {
      setError('The annotation could not be completed. Check the labels and try again.');
    }
    setRunning(false);
  };

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Tag size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-white mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  if (!pipelineState?.cluster) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Clustering Required</h2>
          <p className="text-textMuted">Complete the Clustering step before you can assign biological cell types to clusters.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full p-8 overflow-y-auto bg-background custom-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">Biological Annotation</h2>
          <p className="text-textMuted">Map numerical clusters to biological cell types based on marker genes.</p>
        </div>
        <div className="flex items-center gap-3">
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            >📝 View recorded analysis</button>
          )}
          <button
            onClick={runAnnotation}
            disabled={running || loadingClusters || clusters.length === 0}
            className={`btn ${result ? 'btn-secondary text-success border-success/30' : 'btn-primary'} flex items-center gap-2`}
          >
            {running ? (
               <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>
            ) : (
               <Save size={16} />
            )}
            {result ? 'Annotations Saved' : 'Apply Annotations'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Main Panel */}
      <div className="card p-8 border-l-4 border-l-primary flex flex-col md:flex-row gap-8">
        {/* Left Side: Info */}
        <div className="md:w-1/3 flex flex-col justify-start">
          <h3 className="font-bold flex items-center gap-2 text-white mb-3">
            <Tag size={18} className="text-primary" /> Assign Cell Types
          </h3>
          <p className="text-sm text-textMuted mb-6 leading-relaxed">
            By mapping generic numerical IDs to biological cell types (e.g. "CD4+ T Cells"), your downstream visualizations like UMAPs and tables will display professional, publication-ready labels.
          </p>
          
          <div className="card p-5 bg-slate-800/40 border-border/50">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Tips</h4>
            <ul className="text-xs text-textMuted space-y-2 list-disc pl-4">
               <li>Review the <strong>DEGs</strong> tab to identify top marker genes per cluster.</li>
               <li>Use standardized ontology names where possible.</li>
               <li>Annotations are preserved across UMAP re-inferences.</li>
            </ul>
          </div>
        </div>

        {/* Right Side: Inputs */}
        <div className="md:w-2/3">
          {loadingClusters ? (
            <div className="flex items-center justify-center h-48">
              <span className="animate-pulse text-textMuted">Loading clusters...</span>
            </div>
          ) : clusters.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-slate-400 border-2 border-dashed border-border rounded-xl">
              No clusters found. Ensure clustering was successful.
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-xl overflow-hidden">
              <div className="grid grid-cols-12 gap-4 px-6 py-3 bg-slate-800 border-b border-border text-xs font-bold text-slate-400 uppercase tracking-wider">
                <div className="col-span-2">Cluster ID</div>
                <div className="col-span-3 text-right pr-4">Cell Count</div>
                <div className="col-span-7">Biological Name</div>
              </div>
              <div className="max-h-[500px] overflow-y-auto custom-scrollbar">
                {clusters.map((c, i) => (
                  <div key={c.value} className={`grid grid-cols-12 gap-4 px-6 py-4 items-center ${i !== clusters.length - 1 ? 'border-b border-border/50' : ''} hover:bg-slate-800/20 transition-colors`}>
                    <div className="col-span-2">
                       <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-black border border-primary/20">
                         {c.value}
                       </span>
                    </div>
                    <div className="col-span-3 text-right pr-4">
                       <span className="font-mono text-xs text-slate-400">{Number(c.count).toLocaleString()}</span>
                    </div>
                    <div className="col-span-7">
                       <input
                         type="text"
                         value={params.mappings[c.value] || ''}
                         onChange={(e) => handleMappingChange(c.value, e.target.value)}
                         placeholder={`Cluster ${c.value}`}
                         className="w-full bg-slate-800/80 border border-slate-700/50 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary transition"
                       />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
