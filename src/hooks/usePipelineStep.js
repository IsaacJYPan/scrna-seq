import { useState, useCallback, useEffect, useRef } from 'react';

// Simple deep equal for the specific structures used
function deepEqual(obj1, obj2) {
  if (obj1 === obj2) return true;
  if (typeof obj1 !== 'object' || typeof obj2 !== 'object' || obj1 == null || obj2 == null) return false;
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  if (keys1.length !== keys2.length) return false;
  for (let key of keys1) {
    if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) return false;
  }
  return true;
}

function useDeepCompareMemoize(value) {
  const ref = useRef(value);
  if (!deepEqual(value, ref.current)) {
    ref.current = value;
  }
  return ref.current;
}

/**
 * Custom hook to manage the standard lifecycle of a bioinformatics pipeline step.
 * Handles running, error, result state, cache checking, and auto-hydration.
 *
 * @param {Object} options
 * @param {Function} options.callApi - The API fetcher function from App.jsx.
 * @param {string} options.endpoint - The REST endpoint (e.g. `/pca?npcs=50`).
 * @param {Object} [options.payload={}] - Additional payload for the API (usually {}).
 * @param {Object} options.ipcContext - Options passed to the IPC layer (operation, step, parentIds, cacheParams).
 * @param {boolean} options.readyToHydrate - Whether upstream dependencies are met (e.g. !!datasetInfo && !!pipelineState?.qc).
 * @param {boolean} options.sessionReady - Whether the R session has fully restored.
 * @param {string} options.rSessionId - The current R session ID (used to reset hydration).
 * @param {boolean} [options.autoHydrate=true] - If true, handles the hydration effect internally. Set to false for custom hydration (e.g. UMAP).
 * @param {Function} [options.onSuccess] - Optional callback after a successful run.
 */
export function usePipelineStep({
  callApi,
  endpoint,
  payload = {},
  ipcContext,
  readyToHydrate,
  sessionReady,
  rSessionId,
  autoHydrate = true,
  onSuccess
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [hasHydrated, setHasHydrated] = useState(false);

  const memoIpcContext = useDeepCompareMemoize(ipcContext);
  const memoPayload = useDeepCompareMemoize(payload);

  const isFirstRender = useRef(true);
  const abortControllerRef = useRef(null);
  
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // We intentionally DO NOT reset `result` here anymore so the UI doesn't 
    // flash blank when the user types in a parameter input box.
    // Auto-hydration won't fire until `result` is null, which means they must
    // explicitly click 'Run' to apply new parameters, which is the desired UX.
    setError(null);
  }, [memoIpcContext, memoPayload]);

  const runStep = useCallback(async (isInitial = false, overrideEndpoint = null, overrideIpcContext = null) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    
    setRunning(true);
    setError(null);
    
    const finalEndpoint = overrideEndpoint || endpoint;
    const baseIpcContext = overrideIpcContext || memoIpcContext;

    try {
      const data = await callApi(finalEndpoint, {
        signal: abortControllerRef.current.signal,
        ...memoPayload
      }, {
        ...baseIpcContext,
        onlyIfCached: isInitial
      });

      if (data?.result) {
        setResult(data);
        if (onSuccess) onSuccess(data, isInitial);
      } else if (data?.error && !isInitial) {
        setError(data.error);
      } else if (!data && !isInitial) {
        setError('R backend error. Check the console for details.');
      }
      setRunning(false);
      return data;
    } catch (e) {
      if (e.name === 'AbortError') return; // Ignore aborted requests
      setError(e.message);
      setRunning(false);
    }
  }, [callApi, endpoint, memoPayload, memoIpcContext, onSuccess]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  // Auto-hydrate
  useEffect(() => {
    if (autoHydrate && readyToHydrate && !result && !running && !hasHydrated && sessionReady) {
      setHasHydrated(true);
      runStep(true);
    }
  }, [autoHydrate, readyToHydrate, result, running, runStep, hasHydrated, sessionReady]);

  // Reset hydration when session changes so steps re-run to rebuild global_obj
  useEffect(() => {
    setHasHydrated(false);
  }, [rSessionId]);

  return {
    running,
    result,
    error,
    hasHydrated,
    setResult,      // Expose setter for manual clearing
    setHasHydrated, // Expose setter for manual management
    setError,       // Expose setter for custom error states
    runStep
  };
}
