import PageHeader from '../components/PageHeader';
import React, { useState, useCallback, useEffect } from 'react';
import { Layers, ListFilter, AlertTriangle, ImageDown, FileText } from 'lucide-react';
import Plot, { getPlotHoverStyle, supportsWebGL } from '../components/Plot';
import { useTabParams } from '../hooks/useTabParams';
import { usePipelineStep } from '../hooks/usePipelineStep';
import FigureSavePanel from '../components/FigureSavePanel';
import { isTransientComputeBusy } from '../publicError';
import { useRestoredReduction } from '../hooks/useRestoredReduction';

const CLUSTER_COLORS = ['#f8766d', '#d89000', '#a3a500', '#39b600', '#00bf7d', '#00bfc4', '#00b0f6', '#9590ff', '#e76bf3', '#ff62bc', '#ff6a6a', '#c49a00'];

export default function UMAPView({ callApi, datasetInfo, pcaProvId, clusterProvId, openProvenance, pipelineState, rSessionId, sessionReady, userEmail, objectId, currentWs, activeProjectSeed, theme, deploymentPolicy }) {

  const [savePanelOpen, setSavePanelOpen] = useState(false);
  const isPbmcTutorial = datasetInfo?.source === 'pbmc3k_demo' || datasetInfo?.metadata?.sourceType === 'pbmc3k_demo';
  const umapSeed = activeProjectSeed || (isPbmcTutorial ? 42 : '');

  // Persisted parameters
  const [params, setParam, setParams] = useTabParams('umap', userEmail, objectId, {
    nComponents: 2,
    nNeighbors: 30,
    minDist: 0.3,
  });
  const { nComponents: storedNComponents, nNeighbors: storedNNeighbors, minDist: storedMinDist } = params;
  const [nNeighborsInput, setNNeighborsInput] = useState(String(storedNNeighbors));
  const [minDistInput, setMinDistInput] = useState(String(storedMinDist));
  // Plotly's scatter3d renderer has no SVG equivalent. Never mount or request
  // it in a renderer without WebGL; a saved 3D preference safely falls back to
  // the usable 2D view instead.
  const canUse3D = React.useMemo(() => supportsWebGL(), []);
  const nComponents = canUse3D ? storedNComponents : 2;
  // dims defaults to the PC count used for clustering (from pipelineState)
  const [clusterParams] = useTabParams('cluster', userEmail, objectId, { dims: isPbmcTutorial ? 10 : 15 });
  const [dims, setDims] = useState(clusterParams.dims);
  const [dimsInput, setDimsInput] = useState(String(clusterParams.dims));
  const parsedNNeighbors = Number(nNeighborsInput);
  const parsedMinDist = Number(minDistInput);
  const parsedDims = Number(dimsInput);
  const nNeighborsValid = Number.isInteger(parsedNNeighbors) && parsedNNeighbors >= 2 && parsedNNeighbors <= 100;
  const minDistValid = minDistInput.trim() !== '' && Number.isFinite(parsedMinDist) && parsedMinDist >= 0 && parsedMinDist <= 1;
  const dimsValid = Number.isInteger(parsedDims) && parsedDims >= 1 && parsedDims <= 100;
  const umapValidationError = !nNeighborsValid
    ? 'Number of neighbors must be a whole number from 2 to 100.'
    : !minDistValid
      ? 'Minimum distance must be from 0 to 1.'
      : !dimsValid
        ? 'Input dimensions must be a whole number from 1 to 100.'
        : null;
  const nNeighbors = nNeighborsValid ? parsedNNeighbors : storedNNeighbors;
  const minDist = minDistValid ? parsedMinDist : storedMinDist;
  const currentDims = dimsValid ? parsedDims : dims;
  const [base64Image, setBase64Image] = useState(null);
  const [loadingBase64, setLoadingBase64] = useState(false);
  const cellCount = Number(datasetInfo?.cells) || 0;
  // SVG is more portable and produces deterministic publication/acceptance
  // captures for ordinary datasets. Reserve WebGL for the range where it
  // materially improves interaction; render a server-side image when a large
  // dataset is opened in a renderer without dependable WebGL.
  const useSvg2D = cellCount <= 10000 || !canUse3D;
  const isHighPerfMode = cellCount > 50000 || (!canUse3D && cellCount > 10000);
  const umapParentIds = React.useMemo(
    () => [pcaProvId, pipelineState?.cluster ? clusterProvId : null].filter(Boolean),
    [pcaProvId, clusterProvId, pipelineState?.cluster]
  );

  // Pipeline step hook for state and cache-checking
  const { running, error, setResult, runStep } = usePipelineStep({
    callApi,
    endpoint: `/umap?dims=${currentDims}&n_components=${nComponents}&n_neighbors=${nNeighbors}&min_dist=${minDist}&seed=${umapSeed}`,
    ipcContext: {
      operation: 'umap',
      step: 'umap',
      parentIds: umapParentIds,
      useCache: true,
      cacheParams: { type: 'umap', dims: currentDims, n_components: nComponents, n_neighbors: nNeighbors, min_dist: minDist, seed: umapSeed || 'random' }
    },
    readyToHydrate: !!(datasetInfo && pipelineState?.pca),
    sessionReady,
    rSessionId,
    autoHydrate: false // Existing reductions are inspected through a read-only route.
  });

  // Camera preferences may be local; reduction existence comes from R.
  const [params2, setParam2] = useTabParams('umap_meta', userEmail, objectId, { camera3D: null });

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


  // Keep dims in sync if the user re-clusters with different dims
  useEffect(() => {
    if (pipelineState?.clusterDims) {
      setDims(pipelineState.clusterDims);
    }
  }, [pipelineState?.clusterDims]);

  useEffect(() => setNNeighborsInput(String(storedNNeighbors)), [storedNNeighbors]);
  useEffect(() => setMinDistInput(String(storedMinDist)), [storedMinDist]);
  useEffect(() => setDimsInput(String(dims)), [dims]);

  // In-memory UI cache dictionary to enable zero-latency dimension toggling
  const [cachedDims, setCachedDims] = useState({});
  const contextKey = JSON.stringify([userEmail, objectId, rSessionId, sessionReady]);
  const runGeneration = React.useRef(0);
  const currentReductionComponents = React.useRef(null);
  const settingsKeyFor = (values) => JSON.stringify([values.dims, values.nNeighbors, values.minDist, umapSeed, rSessionId, pcaProvId, clusterProvId]);
  const settingsKey = settingsKeyFor({
    dims: dimsValid ? parsedDims : dimsInput,
    nNeighbors: nNeighborsValid ? parsedNNeighbors : nNeighborsInput,
    minDist: minDistValid ? parsedMinDist : minDistInput,
  });
  useEffect(() => {
    // Drop in-memory UI cache if clustering parameters change
    setCachedDims({});
  }, [pipelineState?.clusterDims, pipelineState?.clusterCount]);

  const { invalidate: invalidateRestored, ...restored } = useRestoredReduction({
    callApi, reduction: 'umap', contextKey,
    enabled: !!(datasetInfo && (pipelineState?.pca || pipelineState?.umap) && sessionReady),
    onReset: () => {
      runGeneration.current += 1;
      currentReductionComponents.current = null;
      setCachedDims({}); setResult(null); setBase64Image(null);
    },
    onResult: (data) => {
      const actualComponents = Number(data.result.n_components) || 2;
      const viewComponents = !canUse3D && actualComponents === 3 ? 2 : actualComponents;
      currentReductionComponents.current = viewComponents;
      const settings = data.result.settings || {};
      const restoredDims = Number(settings.dims) || dims;
      const restoredNeighbors = Number(settings.n_neighbors) || nNeighbors;
      const restoredMinDist = Number.isFinite(settings.min_dist) ? settings.min_dist : minDist;
      setDims(restoredDims);
      setDimsInput(String(restoredDims));
      setNNeighborsInput(String(restoredNeighbors));
      setMinDistInput(String(restoredMinDist));
      setParams(previous => ({ ...previous, nComponents: viewComponents,
        nNeighbors: restoredNeighbors, minDist: restoredMinDist }));
      const restoredKey = settingsKeyFor({ dims: restoredDims, nNeighbors: restoredNeighbors, minDist: restoredMinDist });
      setCachedDims({ [viewComponents]: { ...data, contextKey, settingsKey: restoredKey,
        projectedFrom3D: actualComponents === 3 && !canUse3D } });
      setResult(data);
    }
  });

  const runUMAP = useCallback(async () => {
    if (umapValidationError) return;
    const runDims = parsedDims;
    const runNeighbors = parsedNNeighbors;
    const runMinDist = parsedMinDist;
    setDims(runDims);
    setParams(previous => ({ ...previous, nNeighbors: runNeighbors, minDist: runMinDist }));
    invalidateRestored();
    const generation = ++runGeneration.current;
    const requestedComponents = nComponents;
    const nc = !canUse3D && requestedComponents === 3 ? 2 : requestedComponents;
    const ep = `/umap?dims=${runDims}&n_components=${nc}&n_neighbors=${runNeighbors}&min_dist=${runMinDist}&seed=${umapSeed}`;
    const ipc = {
      operation: 'umap',
      step: 'umap',
      parentIds: umapParentIds,
      useCache: true,
      cacheParams: { type: 'umap', dims: runDims, n_components: nc, n_neighbors: runNeighbors, min_dist: runMinDist, seed: umapSeed || 'random' }
    };

    let data = null;
    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      data = await runStep(false, ep, ipc);
      if (generation !== runGeneration.current) return;
      if (!isTransientComputeBusy(data?.error) || attempt + 1 >= attempts) break;
      await new Promise(resolve => window.setTimeout(resolve, 500 * (attempt + 1)));
    }

    if (data?.result) {
      currentReductionComponents.current = nc;
      setCachedDims(prev => ({ ...prev, [nc]: { ...data, settingsKey, contextKey } }));
    }
  }, [runStep, parsedDims, parsedNNeighbors, parsedMinDist, nComponents, umapSeed, umapParentIds, canUse3D, settingsKey, contextKey, invalidateRestored, umapValidationError, setParams]);

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
          type: useSvg2D ? 'scatter' : 'scattergl',
          name: newName,
          marker: { size: 4, color: CLUSTER_COLORS[i % CLUSTER_COLORS.length], opacity: 1 },
          hovertemplate: '<b>%{fullData.name}</b><extra></extra>',
          hoverlabel: getPlotHoverStyle(theme),
        };
      })
      : [];
  }, [cachedDims, activeAnnotations, useSvg2D, theme]);

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
          hovertemplate: '<b>%{fullData.name}</b><extra></extra>',
          hoverlabel: getPlotHoverStyle(theme),
        };
      })
      : [];
  }, [cachedDims, activeAnnotations, theme]);

  // Traces corresponding to the actively viewed dimension
  const activeTraces = is2D ? traces2D : traces3D;
  const displayedResult = cachedDims[nComponents]?.contextKey === contextKey ? cachedDims[nComponents] : null;
  const result = displayedResult;
  const resultNComponents = result ? nComponents : null;
  const settingsChanged = !!displayedResult && displayedResult.settingsKey !== settingsKey;

  // Fetch base64 fallback for large datasets
  useEffect(() => {
    let active = true;
    if (result && isHighPerfMode && nComponents === 2) {
      setLoadingBase64(true);
      callApi('/render-plot-base64', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plot_type: 'UMAP', width: 8, height: 6, res: 200 })
      })
      .then(data => {
        if (!active) return;
        if (data.result?.base64) setBase64Image(data.result.base64);
        setLoadingBase64(false);
      })
      .catch(() => { if (active) setLoadingBase64(false); });
    }
    return () => { active = false; };
  }, [result, isHighPerfMode, nComponents, callApi]);

  const isDark = theme === 'dark';
  const plotText = isDark ? '#94a3b8' : '#475569';
  const layout2D = React.useMemo(() => ({
    autosize: true,
    uirevision: 'true',
    margin: { l: 50, r: 20, t: 10, b: 50 },
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: plotText, size: 12 },
    xaxis: { title: { text: 'UMAP 1' }, automargin: true, showgrid: false, zeroline: false, constrain: 'domain' },
    yaxis: { title: { text: 'UMAP 2' }, automargin: true, showgrid: false, zeroline: false, scaleanchor: 'x', scaleratio: 1 },
    showlegend: false,
    hovermode: 'closest',
    hoverlabel: getPlotHoverStyle(theme),
  }), [plotText, theme]);

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

  if (!pipelineState?.pca && !pipelineState?.umap) {
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
    <div className="h-full w-full flex flex-col bg-background p-4 sm:p-6 overflow-y-auto custom-scrollbar">
      <PageHeader title="UMAP Embedding" description="Uniform Manifold Approximation and Projection for visualization." className="mb-6" actions={<>
{result && !settingsChanged && currentReductionComponents.current === nComponents && activeTraces.length > 0 && <button
              className="text-blue-500 dark:text-blue-400 border border-blue-500/50 hover:bg-blue-500/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => setSavePanelOpen(true)}
            ><ImageDown size={15} /> Save Figure</button>}
          {displayedResult?.provenance?.id && (
            <button
              className="text-blue-500 dark:text-blue-400 border border-blue-500/50 hover:bg-blue-500/10 px-3 py-2 rounded text-sm flex items-center gap-2 transition"
              onClick={() => openProvenance(displayedResult.provenance.id)}
            ><FileText size={15} /> View recorded analysis</button>
          )}
          <button
            onClick={() => runUMAP()}
            disabled={running || restored.loading || !pipelineState?.pca || Boolean(umapValidationError)}
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
        </>} />

      {deploymentPolicy?.demoMode && isPbmcTutorial && (
        <p role="note" className="text-sm text-textMuted mb-4">
          Public 10x PBMC3k tutorial: measured gene expression, processed with Seurat QC, PCA, graph clustering and UMAP.
          Numeric clusters are computed groups, not validated cell-type annotations. This is one sample, without treatment replicates.{' '}
          <a href="https://satijalab.org/seurat/articles/pbmc3k_tutorial" target="_blank" rel="noreferrer">Source and workflow</a>
        </p>
      )}
      {deploymentPolicy?.demoMode && !isPbmcTutorial && (
        <p role="note" className="text-sm text-textMuted mb-4">
          Synthetic tutorial: 800 simulated cells and 200 features with deliberately strong group signals.
          Seurat calculates the embedding; the input is not measured patient data and these results are not biological evidence.
        </p>
      )}
      {restored.loading && <p role="status" className="text-sm text-textMuted mb-4">Loading the existing UMAP result...</p>}
      {!pipelineState?.pca && <p role="status" className="text-sm text-textMuted mb-4">
        The existing UMAP can be inspected. PCA is required to compute another embedding.
      </p>}
      {restored.error && <div role="alert" className="card p-4 mb-4 text-danger">
        {restored.error} <button onClick={restored.retry} className="underline">Retry loading result</button>
      </div>}
      {displayedResult?.result?.restored && <p role="note" className="text-sm text-textMuted mb-4">
        Showing the saved UMAP result.
        {displayedResult.projectedFrom3D && ' Showing the first two coordinates of the saved 3D embedding.'}
      </p>}
      {displayedResult?.result?.restored && <details className="mb-4 text-sm text-textMuted">
        <summary className="w-fit cursor-pointer rounded px-1 py-1 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Original computation settings</summary>
        <p className="mt-2 pl-1">
          {Object.keys(displayedResult.result.settings || {}).length
            ? <>{displayedResult.result.settings.dims != null && `Input PCs: ${displayedResult.result.settings.dims}. `}{displayedResult.result.settings.n_neighbors != null && `Neighbors: ${displayedResult.result.settings.n_neighbors}. `}{displayedResult.result.settings.min_dist != null && `Minimum distance: ${displayedResult.result.settings.min_dist}. `}{displayedResult.result.settings.seed != null && `Seed: ${displayedResult.result.settings.seed}.`}</>
            : 'Settings were not recorded for this UMAP result.'}
        </p>
      </details>}
      {displayedResult?.result?.sampled && <p role="note" className="text-sm text-textMuted mb-4">
        Preview shows {displayedResult.result.n_points?.toLocaleString()} of {displayedResult.result.n_cells?.toLocaleString()} cells.
        {displayedResult.result.clusters_truncated && ' Some cell groups are omitted by the preview limit.'}
      </p>}
      {settingsChanged && (
        <p role="status" className="text-sm text-textMuted mb-4">
          Showing a previous calculation. Settings or analysis state have changed; re-compute UMAP to apply them.
        </p>
      )}
      {error && (
        <div className="card p-4 mb-4 bg-danger/10 border-danger text-danger flex items-center gap-3">
          <AlertTriangle size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Parameters */}
      <div className="card shrink-0 p-5 mb-6 border-l-4 border-l-primary">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
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
              type="number" value={nNeighborsInput} min={2} max={100} step={1}
              aria-invalid={!nNeighborsValid}
              onChange={e => setNNeighborsInput(e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-textMuted mt-1">Local vs global structure</p>
          </div>
          <div>
            <label htmlFor="umap-dist" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Minimum Distance</label>
            <input
              id="umap-dist"
              type="number" value={minDistInput} min={0} max={1.0} step={0.05}
              aria-invalid={!minDistValid}
              onChange={e => setMinDistInput(e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-textMuted mt-1">Packing density</p>
          </div>
          <div>
            <label htmlFor="umap-dims" className="block text-xs text-textMuted mb-1.5 uppercase tracking-wide font-bold">Input Dimensions (PCs)</label>
            <input
              id="umap-dims"
              type="number" value={dimsInput} min={1} max={100} step={1}
              aria-invalid={!dimsValid}
              onChange={e => setDimsInput(e.target.value)}
              className="w-full bg-surface border border-border rounded p-2.5 text-sm text-text focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-textMuted mt-1">From PCA</p>
          </div>
        </div>
        {umapValidationError && <p role="alert" className="mt-4 text-sm text-danger">{umapValidationError}</p>}
      </div>

      {/* Plot area */}
      <div className="flex-1 flex flex-col xl:flex-row gap-5 min-h-0">
        <div className="flex-1 min-w-0 min-h-[320px] bg-surface border border-border rounded-lg relative overflow-hidden flex items-center justify-center">
          {!result && !running && !restored.loading && (
            <div className="text-center p-8">
              <Layers size={48} className="mx-auto mb-4 text-slate-600" />
              <p className="text-textMuted">{restored.missing
                ? 'No UMAP reduction is present in this analysis. Configure parameters and run UMAP to create one.'
                : `No existing ${nComponents}D UMAP is available. Configure parameters and run UMAP to create one.`}</p>
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
              {cachedDims[2] && <div aria-hidden={!is2D} className={`w-full h-full absolute inset-0 ${is2D && result ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
                <Plot
                  data={traces2D}
                  layout={layout2D}
                  useResizeHandler
                  className="w-full h-full"
                  config={plotConfig}
                />
              </div>}
              {canUse3D && cachedDims[3] && (
                <div aria-hidden={is2D} className={`w-full h-full absolute inset-0 ${!is2D && result ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
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
          <div className="w-full xl:w-64 flex flex-col gap-4 flex-shrink-0">
            <div className="card p-4 flex-1 flex flex-col">
              <h4 className="font-semibold border-b border-border pb-2 mb-3 text-text text-sm">
                <ListFilter size={14} className="inline text-primary mr-2" />Cell groups
              </h4>
              <div role="region" aria-label="Cell group counts" tabIndex={0} className="space-y-1.5 overflow-y-auto flex-1 custom-scrollbar rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
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
