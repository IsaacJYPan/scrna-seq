import { useCallback, useEffect, useRef, useState } from 'react';
import { isTransientComputeBusy, publicErrorMessage } from '../publicError';

// A stored browser result cannot establish what exists in the active R object.
// Read the current reduction without entering the analysis/provenance path.
export function useRestoredReduction({ callApi, reduction, contextKey, enabled, onResult, onReset }) {
  const callbacks = useRef({ callApi, onResult, onReset });
  const generation = useRef(0);
  const controller = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ key: null, loading: false, missing: false, error: null });

  useEffect(() => { callbacks.current = { callApi, onResult, onReset }; }, [callApi, onResult, onReset]);
  useEffect(() => {
    const token = ++generation.current;
    const request = new AbortController();
    controller.current = request;
    callbacks.current.onReset?.();
    setState({ key: contextKey, loading: !!enabled, missing: false, error: null });
    if (enabled) {
      (async () => {
        try {
          let data;
          for (let retry = 0; retry < 3; retry += 1) {
            data = await callbacks.current.callApi(`/reduction-results?reduction=${reduction}`,
              { signal: request.signal }, { useCache: false });
            if (generation.current !== token || request.signal.aborted) return;
            if (!isTransientComputeBusy(data?.error) || retry === 2) break;
            await new Promise(resolve => window.setTimeout(resolve, 300 * (retry + 1)));
          }
          if (generation.current !== token || request.signal.aborted) return;
          if (data?.error) throw new Error(data.error);
          const exists = data?.result?.exists !== false && !!data?.result;
          if (exists) callbacks.current.onResult?.(data);
          setState({ key: contextKey, loading: false, missing: !exists, error: null });
        } catch (error) {
          if (generation.current !== token || request.signal.aborted) return;
          setState({ key: contextKey, loading: false, missing: false,
            error: publicErrorMessage(error, 'The existing result could not be loaded. Try again.') });
        }
      })();
    }
    return () => { request.abort(); generation.current += 1; };
  }, [contextKey, enabled, reduction, attempt]);

  const invalidate = useCallback(() => {
    generation.current += 1;
    controller.current?.abort();
    setState(previous => ({ ...previous, loading: false, error: null }));
  }, []);
  const retry = useCallback(() => setAttempt(previous => previous + 1), []);
  return { ...(state.key === contextKey ? state : { loading: !!enabled, missing: false, error: null }), invalidate, retry };
}
