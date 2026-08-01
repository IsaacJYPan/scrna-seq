import React, { useState, useCallback, useEffect } from 'react';
import { Layers, ListFilter, AlertTriangle, ImageDown, FileText } from 'lucide-react';
import Plot, { supportsWebGL } from '../components/Plot';
import { useTabParams } from '../hooks/useTabParams';
import { usePipelineStep } from '../hooks/usePipelineStep';
import FigureSavePanel from '../components/FigureSavePanel';

const CLUSTER_COLORS = ['#f8766d', '#d89000', '#a3a500', '#39b600', '#00bf7d', '#00bfc4', '#00b0f6', '#9590ff', '#e76bf3', '#ff62bc', '#ff6a6a', '#c49a00'];

export default function UMAPView({ callApi, datasetInfo, pcaProvId, clusterProvId, openProvenance, pipelineState, rSessionId, sessionReady, userEmail, objectId, currentWs, activeProjectSeed, theme, deploymentPolicy }) {

  const [savePanelOpen, setSavePanelOpen] = useState(false);

  // Persisted parameters
  const [params, setParam] = useTabParams('umap', userEmail, objectId, {
    nComponents: 2,
    nNeighbors: 30,
    minDist: 0.3,
  });
  const { nComponents: storedNComponents, nNeighbors, minDist } = params;
  // Plotly's scatter3d renderer has no SVG equivalent. Never mount or request
  // it in a renderer without WebGL; a saved 3D preference safely falls back to
  // the usable 2D view instead.
  const canUse3D = React.useMemo(() => supportsWebGL(), []);
  const nComponents = canUse3D ? storedNComponents : 2;
  // dims defaults to the PC count used for clustering (from pipelineState)
  const [clusterParams] = useTabParams('cluster', userEmail, objectId, { dims: 15 });
  const [dims, setDims] = useState(clusterParams.dims);
  const [base64Image, setBase64Image] = useState(null);
  const [loadingBase64, setLoadingBase64] = useState(false);
  const isHighPerfMode = datasetInfo?.cells > 50000;
  const umapParentIds = React.useMemo(
    () => [pcaProvId, pipelineState?.cluster ? clusterProvId : null].filter(Boolean),
    [pcaProvId, clusterProvId, pipelineState?.cluster]
  );

  // Pipeline step hook for state and cache-checking
  const { running, result, error, setResult, hasHydrated, setHasHydrated, runStep } = usePipelineStep({
    callApi,
    endpoint: `/umap?dims=${dims}&n_components=${nComponents}&n_neighbors=${nNeighbors}&min_dist=${minDist}&seed=${activeProjectSeed || ''}`,
    ipcContext: {
      operation: 'umap',
      step: 'umap',
      parentIds: umapParentIds,
      useCache: true,
      cacheParams: { type: 'umap', dims, n_components: nComponents, n_neighbors: nNeighbors, min_dist: minDist, seed: activeProjectSeed || 'random' }
    },
    readyToHydrate: !!(datasetInfo && pipelineState?.pca),
    sessionReady,
    rSessionId,
    autoHydrate: false // Manages its own complex hydration sequence
  });

  // Track which n_components was actually computed last — persisted so hydration
  // attempts the right cache key on reload (e.g. if user last ran 3D UMAP).
  const [params2, setParam2] = useTabParams('umap_meta', userEmail, objectId, { resultNComponents: null, camera3D: null });
  const savedResultNComponents = params2.resultNComponents;

  useEffect(() => {
    if (!canUse3D && storedNComponents === 3) {
      setParam('nComponents', 2);
    }
  }, [canUse3D, storedNComponents, setParam]);

  // Bug A fix: keep the debounce timer in its own ref (not on cameraRef itself).
  // cameraRef holds the latest camera position for the debounce closure.
  const cameraRef = React.useRef(params2.camera3D || null);
  const debounceRef = React.useRef(null);

  // The initial camera is set ONCE from localStorage and never changes during the session.
  // Plotly's uirevision then owns the camera state — we never feed it back in.
  // This prevents both the jitter (no re-renders during drag) and the 2D↔3D toggle
  // angle shift (Plotly keeps its own state while the div stays mounted).
  const initialCamera3D = React.useRef(params2.camera3D || null);

  // Mirrors persisted completion metadata so the primary action reflects a
  // successful run immediately after setParam2('resultNComponents', ...).
  const resultNComponents = savedResultNComponents;

  // Keep dims in sync if the user re-clusters with different dims
  useEffect(() => {
    if (pipelineState?.clusterDims) {
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
    const requestedComponents = nComponentsOverride ?? nComponents;
    const nc = !canUse3D && requestedComponents === 3 ? 2 : requestedComponents;
    const ep = `/umap?dims=${dims}&n_components=${nc}&n_neighbors=${nNeighbors}&min_dist=${minDist}&seed=${activeProjectSeed || ''}`;
    const ipc = {
      operation: 'umap',
      step: 'umap',
      parentIds: umapParentIds,
      useCache: true,
      cacheParams: { type: 'umap', dims, n_components: nc, n_neighbors: nNeighbors, min_dist: minDist, seed: activeProjectSeed || 'random' }
    };

    const data = await runStep(isInitial, ep, ipc);

    if (data?.result) {
      setCachedDims(prev => ({ ...prev, [nc]: data }));
      setParam2('resultNComponents', nc);  // persist for hydration on reload
    }
  }, [runStep, dims, nComponents, nNeighbors, minDist, activeProjectSeed, setParam2, umapParentIds, canUse3D]);

  // Silent cache-only prefetch — populates cachedDims without touching running/error state.
  // Used to warm the other dimension during hydration so 2D↔3D toggle is instant.
  const prefetchDim = useCallback(async (nc) => {
    if (!canUse3D && nc === 3) return;
    const data = await callApi(`/umap?dims=${dims}&n_components=${nc}&n_neighbors=${nNeighbors}&min_dist=${minDist}&seed=${activeProjectSeed || ''}`, {}, {
      operation: 'umap',
      step: 'umap',
      parentIds: umapParentIds,
      useCache: true,
      cacheParams: { type: 'umap', dims, n_components: nc, n_neighbors: nNeighbors, min_dist: minDist, seed: activeProjectSeed || 'random' },
      onlyIfCached: true  // never triggers a real R computation
    });
    if (data?.result) {
      setCachedDims(prev => ({ ...prev, [nc]: data }));
    }
  }, [callApi, umapParentIds, dims, nNeighbors, minDist, activeProjectSeed, canUse3D]);

  const is2D = nComponents === 2;

  // Derive Plotly traces from cached results (memoized to prevent jitter on state updates)
  const annotationsStr = JSON.stringify(currentWs?.annotations || {});
  const activeAnnotations = React.useMemo(() => JSON.parse(annotationsStr), [annotationsStr]);

  const traces2D = React.useMemo(() => {
    const dataObj = cachedDims[2];
    return dataObj?.result?.trace_data
      ? dataObj.result.trace_data.map((trace, i) => {
        const safeName = String(trace.name || '');
        const originalId = safeName.replace('Cluster ', '');
        const newName = activeAnnotations[originalId] || trace.name;
        return {
          x: trace.x,
          y: trace.y,
          mode: 'markers',
          type: 'scattergl',
          name: newName,
          marker: { size: 4, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 1 },
          hovertemplate: `<b>${newName}</b><br>UMAP1: %{x:.2f}<br>UMAP2: %{y:.2f}<extra></extra>`,
        };
      })
      : [];
  }, [cachedDims, activeAnnotations]);

  const traces3D = React.useMemo(() => {
    const dataObj = cachedDims[3];
    return dataObj?.result?.trace_data
      ? dataObj.result.trace_data.map((trace, i) => {
        const safeName = String(trace.name || '');
        const originalId = safeName.replace('Cluster ', '');
        const newName = activeAnnotations[originalId] || trace.name;
        return {
          x: trace.x,
          y: trace.y,
          z: trace.z,
          mode: 'markers',
          type: 'scatter3d',
          name: newName,
          marker: { size: 3, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 1 },
          hovertemplate: `<b>${newName}</b><br>UMAP1: %{x:.2f}<br>UMAP2: %{y:.2f}<br>UMAP3: %{z:.2f}<extra></extra>`,
        };
      })
      : [];
  }, [cachedDims, activeAnnotations]);

  // Traces corresponding to the actively viewed dimension
  const activeTraces = is2D ? traces2D : traces3D;

  // Hydration effect is intact because it uses async IIFE to prefetch
  useEffect(() => {
    if (datasetInfo && pipelineState?.pca && !result && !running && !hasHydrated && sessionReady) {
      setHasHydrated(true);
      const savedNC = savedResultNComponents ?? null;
      const activeNC = nComponents; // dimension currently shown in the UI
      // Hydrate the active view first, then silently prefetch the other dimension
      // so toggling 2D↔3D is instant without an extra network round-trip.
      ; (async () => {
        await runUMAP(true, activeNC);
        if (canUse3D && savedNC && savedNC !== activeNC) {
          await prefetchDim(savedNC);  // silent — no spinner, no error state
        }
      })();
    }
  }, [datasetInfo, pipelineState?.pca, result, running, runUMAP, prefetchDim, hasHydrated, sessionReady, savedResultNComponents, setHasHydrated, canUse3D]);

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

  // Fetch base64 fallback for large datasets
  useEffect(() => {
    if (result && isHighPerfMode && nComponents === 2) {
      setLoadingBase64(true);
      callApi('/render-plot-base64', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plot_type: 'UMAP', width: 8, height: 6, res: 200 })
      })
      .then(data => {
        if (data.result?.base64) setBase64Image(data.result.base64);
        setLoadingBase64(false);
      })
      .catch(() => setLoadingBase64(false));
    }
  }, [result, isHighPerfMode, nComponents]);

  const isDark = theme === 'dark';
  const plotText = isDark ? '#94a3b8' : '#475569';
  const layout2D = React.useMemo(() => ({
    autosize: true,
    uirevision: 'true',
    margin: { l: 50, r: 20, t: 10, b: 50 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: plotText },
    xaxis: { title: 'UMAP 1', showgrid: false, zeroline: false },
    yaxis: { title: 'UMAP 2', showgrid: false, zeroline: false },
    showlegend: false,
    hovermode: 'closest'
  }), [plotText]);

  // layout3D is memoized with NO dependencies to ensure perfect stability.
  // By keeping this object reference the same for the entire life of the mount,
  // we let Plotly's uirevision own the camera state without any "fights" from React.
  // The camera is set ONCE from localStorage at mount; subsequent state saves 
  // do not trigger a layout prop update, eliminating the "rubber-band" jump.
  const layout3D = React.useMemo(() => ({
    autosize: true,
    uirevision: 'umap-3d',
    margin: { l: 0, r: 0, b: 0, t: 0 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    scene: {
      camera: initialCamera3D.current,
      xaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      yaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      zaxis: { showgrid: false, zeroline: false, showticklabels: false, title: '' },
      bgcolor: 'transparent'
    },
    showlegend: false
  }), []); // intentionally empty deps — layout must be perfectly stable

  const plotConfig = React.useMemo(() => ({ displayModeBar: true, displaylogo: false, responsive: true }), []);

  if (!datasetInfo) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <Layers size={48} className="mx-auto text-slate-400 mb-4 opacity-50" />
          <h2 className="text-xl font-bold text-text mb-2">No Dataset Loaded</h2>
        </div>
      </div>
    );
  }

  if (!pipelineState?.pca) {
    return (
      <div className="h-full flex items-center justify-center p-8 bg-background">
        <div className="text-center max-w-sm">
          <AlertTriangle size={48} className="mx-auto text-amber-500 mb-4" />
          <h2 className="text-xl font-bold text-text mb-2">PCA Required</h2>
          <p className="opacity-80">UMAP requires Principal Component Analysis (PCA) to be completed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-background p-6">
      <div className="flex flex-wrap gap-y-3 justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-text mb-1 tracking-tight">UMAP Embedding</h2>
          <p className="text-textMuted">Uniform Manifold Approximation and Projection for visualization.</p>
        </div>
        <div className="flex gap-3">
          {result && activeTraces.length > 0 && <button
              className="text-blue-500 dark:text-blue-400 border border-blue-500/50 hover:bg-blue-500/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => setSavePanelOpen(true)}
            ><ImageDown size={15} /> Save Figure</button>}
          {result && (
            <button
              className="text-blue-500 dark:text-blue-400 border border-blue-500/50 hover:bg-blue-500/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(result.provenance.id)}
            ><FileText size={15} /> View Step Script</button>
          )}
          <button
            onClick={() => runUMAP()}
            disabled={running}
            className={`btn ${result && resultNComponents === nComponents
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
            <div className="flex bg-black/5 dark:bg-slate-800 rounded-lg p-0.5 border border-border">
              <button
                onClick={() => setParam('nComponents', 2)}
                className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${nComponents === 2 ? 'bg-primary text-white shadow' : 'text-textMuted'}`}
              >2D</button>
              <button
                onClick={() => setParam('nComponents', 3)}
                disabled={!canUse3D}
                aria-describedby={!canUse3D ? 'umap-3d-unavailable' : undefined}
                title={!canUse3D ? '3D UMAP requires WebGL, which is unavailable in this renderer.' : undefined}
                className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${nComponents === 3 ? 'bg-blue-600 text-white shadow' : 'text-textMuted'} ${!canUse3D ? 'cursor-not-allowed opacity-50' : ''}`}
              >3D</button>
            </div>
            <p className="text-[10px] text-textMuted mt-1">2D for publications</p>
            {!canUse3D && (
              <p id="umap-3d-unavailable" role="status" className="text-[10px] text-textMuted mt-1.5">
                3D UMAP requires WebGL. This renderer supports the 2D view only.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="umap-neighbors" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Number of Neighbors</label>
            <input
              id="umap-neighbors"
              type="number" value={nNeighbors} min={5} max={100}
              onChange={e => setParam('nNeighbors', parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-textMuted mt-1">Local vs global structure</p>
          </div>
          <div>
            <label htmlFor="umap-dist" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Minimum Distance</label>
            <input
              id="umap-dist"
              type="number" value={minDist} min={0.01} max={1.0} step={0.05}
              onChange={e => setParam('minDist', parseFloat(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-textMuted mt-1">Packing density</p>
          </div>
          <div>
            <label htmlFor="umap-dims" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Input Dimensions (PCs)</label>
            <input
              id="umap-dims"
              type="number" value={dims} min={5} max={100}
              onChange={e => setDims(parseInt(e.target.value))}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-textMuted mt-1">From PCA</p>
          </div>
        </div>
      </div>

      {/* Plot area */}
      <div className="flex-1 flex gap-5 min-h-0">
        <div className="flex-1 bg-surface border border-border rounded-lg relative overflow-hidden flex items-center justify-center">
          {!result && !running && (
            <div className="text-center p-8">
              <Layers size={48} className="mx-auto mb-4 text-slate-600" />
              <p className="text-textMuted">Configure parameters and click "Run UMAP".</p>
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
          {isHighPerfMode && nComponents === 2 ? (
            <div className={`w-full h-full absolute inset-0 z-10 flex items-center justify-center bg-slate-900/50 ${result ? 'opacity-100' : 'opacity-0'}`}>
              {loadingBase64 ? (
                <div className="flex flex-col items-center">
                  <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
                  <p className="text-textMuted font-bold uppercase tracking-widest text-xs">Rendering High-Res PNG...</p>
                </div>
              ) : base64Image ? (
                <>
                  <img src={base64Image} alt={`UMAP embedding scatter plot (${nComponents}D), cells colored by cluster`} className="max-w-full max-h-full object-contain p-2" />
                  <div className="absolute top-4 right-4 bg-primary/20 text-primary border border-primary/40 px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase">
                    High-Performance View
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <>
              <div className={`w-full h-full absolute inset-0 ${is2D && cachedDims[2] && result ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
                <Plot
                  data={traces2D}
                  layout={layout2D}
                  useResizeHandler
                  className="w-full h-full"
                  config={plotConfig}
                />
              </div>
              {canUse3D && (
                <div className={`w-full h-full absolute inset-0 ${!is2D && cachedDims[3] && result ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
                  <Plot
                  data={traces3D}
                  layout={layout3D}
                  useResizeHandler
                  className="w-full h-full"
                  config={plotConfig}
                  onRelayout={(e) => {
                    let updated = false;
                    let newCamera = cameraRef.current ? { ...cameraRef.current } : {};
    
                    // Merge partial camera fragments that Plotly emits during drag
                    if (e['scene.camera']) { newCamera = { ...e['scene.camera'] }; updated = true; }
                    if (e['scene.camera.eye']) { newCamera = { ...newCamera, eye: e['scene.camera.eye'] }; updated = true; }
                    if (e['scene.camera.center']) { newCamera = { ...newCamera, center: e['scene.camera.center'] }; updated = true; }
                    if (e['scene.camera.up']) { newCamera = { ...newCamera, up: e['scene.camera.up'] }; updated = true; }
    
                    if (updated) {
                      // Update the ref only — no React state update, no re-render, no jitter.
                      // Plotly owns the live camera; we only persist it to localStorage.
                      cameraRef.current = newCamera;
                      if (debounceRef.current) clearTimeout(debounceRef.current);
                      debounceRef.current = setTimeout(() => {
                        // Only save if we have a reasonably complete camera object
                        if (cameraRef.current?.eye) {
                          setParam2('camera3D', cameraRef.current);
                        }
                      }, 1000); // 1000ms provides a safer buffer to avoid saving mid-interaction
                    }
                  }}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Cluster legend sidebar */}
        {result && (
          <div className="w-64 flex flex-col gap-4 flex-shrink-0">
            <div className="card p-4 flex-1 flex flex-col">
              <h4 className="font-semibold border-b border-border pb-2 mb-3 text-text text-sm">
                <ListFilter size={14} className="inline text-primary mr-2" />Clusters
              </h4>
              <div className="space-y-1.5 overflow-y-auto flex-1 custom-scrollbar">
                {activeTraces.map((trace, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-white/5">
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: trace.marker?.color || CLUSTER_COLORS[i] }}></div>
                    <span className="text-text">{trace.name}</span>
                    <span className="ml-auto text-textMuted font-mono">{trace.x?.length}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <FigureSavePanel
        isOpen={savePanelOpen}
        onClose={() => setSavePanelOpen(false)}
        plotType="UMAP"
        baseParams={{ features: [], groupBy: 'seurat_clusters' }}
        userEmail={userEmail || ''}
        objectId={objectId || ''}
        deploymentPolicy={deploymentPolicy}
      />
    </div>
  );
}
