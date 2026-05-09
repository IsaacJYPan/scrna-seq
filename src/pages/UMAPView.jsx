import React, { useState, useCallback, useEffect } from 'react';
import { Layers, ListFilter, AlertTriangle } from 'lucide-react';
import Plot from 'react-plotly.js';
import { useTabParams } from '../hooks/useTabParams';

const CLUSTER_COLORS = ['#f8766d', '#d89000', '#a3a500', '#39b600', '#00bf7d', '#00bfc4', '#00b0f6', '#9590ff', '#e76bf3', '#ff62bc', '#ff6a6a', '#c49a00'];

function generate2DData(nClusters) {
  const traces = [];
  for (let i = 0; i < nClusters; i++) {
    const n = Math.floor(Math.random() * 180) + 80;
    const cx = (Math.random() - 0.5) * 16;
    const cy = (Math.random() - 0.5) * 16;
    traces.push({
      x: Array.from({ length: n }, () => cx + (Math.random() - 0.5) * 4),
      y: Array.from({ length: n }, () => cy + (Math.random() - 0.5) * 4),
      mode: 'markers',
      type: 'scatter',
      name: `Cluster ${i}`,
      marker: { size: 4, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 0.7 },
      hovertemplate: `<b>Cluster ${i}</b><br>UMAP1: %{x:.2f}<br>UMAP2: %{y:.2f}<extra></extra>`
    });
  }
  return traces;
}

function generate3DData(nClusters) {
  const traces = [];
  for (let i = 0; i < nClusters; i++) {
    const n = Math.floor(Math.random() * 180) + 80;
    const cx = (Math.random() - 0.5) * 16;
    const cy = (Math.random() - 0.5) * 16;
    const cz = (Math.random() - 0.5) * 16;
    traces.push({
      x: Array.from({ length: n }, () => cx + (Math.random() - 0.5) * 4),
      y: Array.from({ length: n }, () => cy + (Math.random() - 0.5) * 4),
      z: Array.from({ length: n }, () => cz + (Math.random() - 0.5) * 4),
      mode: 'markers',
      type: 'scatter3d',
      name: `Cluster ${i}`,
      marker: { size: 3, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 0.7 },
    });
  }
  return traces;
}

export default function UMAPView({ callApi, datasetInfo, currentProvId, openProvenance, pipelineState, rSessionId, sessionReady, userEmail, objectId, currentWs }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [hasHydrated, setHasHydrated] = useState(false);

  // Persisted parameters
  const [params, setParam] = useTabParams('umap', userEmail, objectId, {
    nComponents: 2,
    nNeighbors: 30,
    minDist: 0.3,
  });
  const { nComponents, nNeighbors, minDist } = params;
  // dims defaults to the PC count used for clustering (from pipelineState)
  const [dims, setDims] = useState(pipelineState?.clusterDims || 15);

  // Track which n_components was actually computed last — persisted so hydration
  // attempts the right cache key on reload (e.g. if user last ran 3D UMAP).
  const [params2, setParam2] = useTabParams('umap_meta', userEmail, objectId, { resultNComponents: null, camera3D: null });
  const savedResultNComponents = params2.resultNComponents;

  // Bug A fix: keep the debounce timer in its own ref (not on cameraRef itself).
  // cameraRef holds the latest camera position for the debounce closure.
  const cameraRef = React.useRef(params2.camera3D || null);
  const debounceRef = React.useRef(null);

  // The initial camera is set ONCE from localStorage and never changes during the session.
  // Plotly's uirevision then owns the camera state — we never feed it back in.
  // This prevents both the jitter (no re-renders during drag) and the 2D↔3D toggle
  // angle shift (Plotly keeps its own state while the div stays mounted).
  const initialCamera3D = React.useRef(params2.camera3D || null);

  // resultNComponents: in-session state that mirrors savedResultNComponents
  // We initialize from the persisted value so traces render correctly after hydration.
  const [resultNComponents, setResultNComponents] = useState(() => savedResultNComponents);

  // Keep dims in sync if the user re-clusters with different dims (before running UMAP)
  useEffect(() => {
    if (pipelineState?.clusterDims && !result) {
      setDims(pipelineState.clusterDims);
    }
  }, [pipelineState?.clusterDims]);

  // In-memory UI cache dictionary to enable zero-latency dimension toggling
  const [cachedDims, setCachedDims] = useState({});
  useEffect(() => {
    // Drop in-memory UI cache if clustering parameters change
    setCachedDims({});
  }, [pipelineState?.clusterDims, pipelineState?.clusterCount]);

  const runUMAP = useCallback(async (isInitial = false, nComponentsOverride = null) => {
    setRunning(true);
    setError(null);
    const nc = nComponentsOverride ?? nComponents;
    const data = await callApi(`/umap?dims=${dims}&n_components=${nc}&n_neighbors=${nNeighbors}&min_dist=${minDist}`, {}, {
      operation: 'umap',
      step: 'umap',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: true,
      cacheParams: { type: 'umap', dims, n_components: nc, n_neighbors: nNeighbors, min_dist: minDist },
      onlyIfCached: isInitial
    });

    if (data && data.result) {
      setResult(data);
      setCachedDims(prev => ({ ...prev, [nc]: data }));
      setParam2('resultNComponents', nc);  // persist for hydration on reload
    } else if (data && data.error && !isInitial) {
      setError(data.error);
    } else if (!data && !isInitial) {
      setError('R backend error. Check the console for details.');
    }
    setRunning(false);
  }, [callApi, currentProvId, dims, nComponents, nNeighbors, minDist, pipelineState?.clusterCount]);

  // Silent cache-only prefetch — populates cachedDims without touching running/error state.
  // Used to warm the other dimension during hydration so 2D↔3D toggle is instant.
  const prefetchDim = useCallback(async (nc) => {
    const data = await callApi(`/umap?dims=${dims}&n_components=${nc}&n_neighbors=${nNeighbors}&min_dist=${minDist}`, {}, {
      operation: 'umap',
      step: 'umap',
      parentIds: currentProvId ? [currentProvId] : [],
      useCache: true,
      cacheParams: { type: 'umap', dims, n_components: nc, n_neighbors: nNeighbors, min_dist: minDist },
      onlyIfCached: true  // never triggers a real R computation
    });
    if (data?.result) {
      setCachedDims(prev => ({ ...prev, [nc]: data }));
    }
  }, [callApi, currentProvId, dims, nNeighbors, minDist]);

  const is2D = nComponents === 2;

  // Derive Plotly traces from cached results.
  const activeAnnotations = currentWs?.annotations || {};

  const buildTraces = (dataObj, targetDims) => {
    return dataObj?.result?.trace_data
      ? dataObj.result.trace_data.map((trace, i) => {
          const safeName = String(trace.name || '');
          const originalId = safeName.replace('Cluster ', '');
          const newName = activeAnnotations[originalId] || trace.name;
          const tr = {
            x: trace.x,
            y: trace.y,
            mode: 'markers',
            type: targetDims === 2 ? 'scatter' : 'scatter3d',
            name: newName,
            marker: { size: targetDims === 2 ? 4 : 3, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 1 },
            hovertemplate: targetDims === 2
              ? `<b>${newName}</b><br>UMAP1: %{x:.2f}<br>UMAP2: %{y:.2f}<extra></extra>`
              : `<b>${newName}</b><br>UMAP1: %{x:.2f}<br>UMAP2: %{y:.2f}<br>UMAP3: %{z:.2f}<extra></extra>`,
          };
          if (targetDims === 3) tr.z = trace.z;
          return tr;
        })
      : [];
  };

  const traces2D = buildTraces(cachedDims[2], 2);
  const traces3D = buildTraces(cachedDims[3], 3);
  
  // Traces corresponding to the actively viewed dimension
  const activeTraces = is2D ? traces2D : traces3D;

  // Hydration: use the last-computed nComponents (from localStorage) so that
  // e.g. a previously-computed 3D UMAP cache key is matched correctly.
  useEffect(() => {
    if (datasetInfo && pipelineState?.cluster && !result && !running && !hasHydrated && sessionReady) {
      setHasHydrated(true);
      const savedNC = savedResultNComponents ?? null;
      const activeNC = nComponents; // dimension currently shown in the UI
      // Hydrate the active view first, then silently prefetch the other dimension
      // so toggling 2D↔3D is instant without an extra network round-trip.
      ;(async () => {
        await runUMAP(true, activeNC);
        if (savedNC && savedNC !== activeNC) {
          await prefetchDim(savedNC);  // silent — no spinner, no error state
        }
      })();
    }
  }, [datasetInfo, pipelineState?.cluster, result, running, runUMAP, prefetchDim, hasHydrated, sessionReady, savedResultNComponents]);

  // Reset hydration flag when the R session ID changes (new R process started)
  // so that we re-run the step in R to rebuild global_obj.
  // Watch rSessionId directly — NOT callApi, which changes on every workspace update.
  useEffect(() => {
    setHasHydrated(false);
  }, [rSessionId]);

  // When the user toggles the dimension in the UI, clear the stale result
  // and eagerly try to load the required dimension from the local cache.
  const [prevNComponents, setPrevNComponents] = useState(nComponents);
  useEffect(() => {
    if (nComponents !== prevNComponents && hasHydrated && sessionReady) {
      setPrevNComponents(nComponents);
      if (cachedDims[nComponents]) {
        setResult(cachedDims[nComponents]); // Instant UI switch from memory
      } else {
        setResult(null);             // Instantly clear the plot to prevent "visible on both tabs"
        runUMAP(true, nComponents);  // Try to load cached data for this specific dimension
      }
    }
  }, [nComponents, prevNComponents, hasHydrated, sessionReady, cachedDims, runUMAP]);

  // layout2D is simple and doesn't have camera state, so we just declare it inline
  const layout2D = {
    autosize: true,
    uirevision: 'true',
    margin: { l: 50, r: 20, t: 10, b: 50 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#94a3b8' },
    xaxis: { title: 'UMAP 1', showgrid: false, zeroline: false },
    yaxis: { title: 'UMAP 2', showgrid: false, zeroline: false },
    showlegend: false,
    hovermode: 'closest'
  };

  // layout3D is memoized with no dependencies so the object reference never changes.
  // A stable layout is the key to letting Plotly's uirevision own the 3D camera:
  // Plotly only re-applies scene.camera when the layout object itself changes.
  // With a stable object, the initial camera is applied once and never overwritten.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout3D = React.useMemo(() => ({
    autosize: true,
    uirevision: 'umap-3d',  // stable string — Plotly never resets camera across re-renders
    margin: { l: 0, r: 0, b: 0, t: 0 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    scene: {
      // Set once from localStorage; after first render Plotly owns this via uirevision
      camera: initialCamera3D.current,
      xaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      yaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      zaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      bgcolor: 'transparent'
    },
    showlegend: false
  }), []); // intentionally empty deps — layout must be stable for uirevision to work

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Layers size={48} className="mx-auto text-slate-600 mb-4 opacity-50" />
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
          <p className="text-textMuted">Complete the Clustering step before computing UMAP. UMAP colors cells by cluster identity.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-background p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white mb-1 tracking-tight">UMAP Embedding</h2>
          <p className="text-textMuted">Uniform Manifold Approximation and Projection for visualization.</p>
        </div>
        <div className="flex gap-3">
          {result && (
            <button
              className="text-primary border border-primary/50 hover:bg-primary/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            >📝 View Step Script</button>
          )}
          <button
            onClick={() => runUMAP()}
            disabled={running}
            className={`btn ${
              result && resultNComponents === nComponents
                ? 'btn-secondary border-primary text-primary'
                : 'btn-primary'
            } flex items-center gap-2`}
          >
            {running && <span className="animate-spin border-2 border-white border-t-transparent rounded-full w-4 h-4"></span>}
            {result && resultNComponents === nComponents
              ? 'Re-compute UMAP'
              : `Run ${nComponents}D UMAP`}
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-4 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Parameters */}
      <div className="card p-5 mb-6 border-l-4 border-l-primary">
        <div className="grid grid-cols-4 gap-5">
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Dimensions</label>
            <div className="flex bg-slate-800 rounded-lg p-0.5 border border-border">
              <button
                onClick={() => setParam('nComponents', 2)}
                className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${nComponents === 2 ? 'bg-primary text-white shadow' : 'text-slate-500'}`}
              >2D</button>
              <button
                onClick={() => setParam('nComponents', 3)}
                className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${nComponents === 3 ? 'bg-primary text-white shadow' : 'text-slate-500'}`}
              >3D</button>
            </div>
            <p className="text-[10px] text-slate-500 mt-1">2D for publications</p>
          </div>
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">n_neighbors</label>
            <input
              type="number" value={nNeighbors} min={5} max={100}
              onChange={e => setParam('nNeighbors', parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-500 mt-1">Local vs global structure</p>
          </div>
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">min_dist</label>
            <input
              type="number" value={minDist} min={0.01} max={1} step={0.05}
              onChange={e => setParam('minDist', parseFloat(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-500 mt-1">Packing density</p>
          </div>
          <div>
            <label className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">PC Dims</label>
            <input
              type="number" value={dims} min={5} max={50}
              onChange={e => setDims(parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-white focus:outline-none focus:border-primary"
            />
            <p className="text-[10px] text-slate-500 mt-1">From PCA</p>
          </div>
        </div>
      </div>

      {/* Plot area */}
      <div className="flex-1 flex gap-5 min-h-0">
        <div className="flex-1 bg-surface border border-border rounded-lg relative overflow-hidden flex items-center justify-center">
          {!result && !running && (
            <div className="text-center p-8 opacity-40">
              <Layers size={48} className="mx-auto mb-4" />
              <p className="text-slate-400">Configure parameters and click "Run UMAP".</p>
            </div>
          )}

          {running && (
            <div className="text-center p-8">
              <div className="flex gap-2 justify-center mb-4">
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-3 h-3 rounded-full bg-primary animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
              <p className="text-textMuted animate-pulse">Computing {nComponents}D UMAP...</p>
            </div>
          )}

          {/* Parallel Mounting strictly protects 3D Camera Angles and avoids graph-lines visual glitches */}
          <div className={`w-full h-full absolute inset-0 ${is2D && cachedDims[2] && result ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
            <Plot
              data={traces2D}
              layout={layout2D}
              useResizeHandler
              className="w-full h-full"
              config={{ displayModeBar: true, displaylogo: false, responsive: true }}
            />
          </div>
          <div className={`w-full h-full absolute inset-0 ${!is2D && cachedDims[3] && result ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
            <Plot
              data={traces3D}
              layout={layout3D}
              useResizeHandler
              className="w-full h-full"
              config={{ displayModeBar: true, displaylogo: false, responsive: true }}
              onRelayout={(e) => {
                let updated = false;
                let newCamera = cameraRef.current ? { ...cameraRef.current } : {};

                // Merge partial camera fragments that Plotly emits during drag
                if (e['scene.camera'])        { newCamera = { ...e['scene.camera'] }; updated = true; }
                if (e['scene.camera.eye'])    { newCamera = { ...newCamera, eye:    e['scene.camera.eye'] };    updated = true; }
                if (e['scene.camera.center']) { newCamera = { ...newCamera, center: e['scene.camera.center'] }; updated = true; }
                if (e['scene.camera.up'])     { newCamera = { ...newCamera, up:     e['scene.camera.up'] };     updated = true; }

                if (updated) {
                  // Update the ref only — no React state update, no re-render, no jitter.
                  // Plotly owns the live camera; we only persist it to localStorage.
                  cameraRef.current = newCamera;
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  debounceRef.current = setTimeout(() => {
                    setParam2('camera3D', cameraRef.current);
                  }, 1500);
                }
              }}
            />
          </div>
        </div>

        {/* Cluster legend sidebar */}
        {result && (
          <div className="w-64 flex flex-col gap-4 flex-shrink-0">
            <div className="card p-4 flex-1 flex flex-col">
              <h4 className="font-semibold border-b border-border pb-2 mb-3 text-white text-sm">
                <ListFilter size={14} className="inline text-primary mr-2" />Clusters
              </h4>
              <div className="space-y-1.5 overflow-y-auto flex-1 custom-scrollbar">
                {activeTraces.map((trace, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-white/5">
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: trace.marker?.color || CLUSTER_COLORS[i] }}></div>
                    <span className="text-slate-300">{trace.name}</span>
                    <span className="ml-auto text-slate-500 font-mono">{trace.x?.length}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
