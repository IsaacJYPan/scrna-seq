import { useState, useEffect, useRef } from 'react';

/**
 * Persist tab-level parameters in localStorage, scoped per user + object.
 *
 * @param {string} step      - Unique step name, e.g. 'qc', 'pca', 'cluster'
 * @param {string} email     - Current user email (null if not logged in)
 * @param {string} objectId  - Active dataset object ID (null if none)
 * @param {object} defaults  - Default parameter values
 * @returns [params, setParam] where setParam(key, value) updates one field
 */
export function useTabParams(step, email, objectId, defaults) {
  const storageKey = email && objectId
    ? `benchone_params_${step}_${email.replace(/[^a-zA-Z0-9]/g, '_')}_${objectId}`
    : null;

  // Read saved params once on mount (merged with defaults so new fields always have a value)
  const [params, setParams] = useState(() => {
    if (!storageKey) return defaults;
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
    } catch {
      return defaults;
    }
  });

  // Track the last key we loaded so we can reload when the object changes
  const lastKeyRef = useRef(storageKey);

  // Reload when user/object changes (e.g. switching active dataset)
  useEffect(() => {
    if (storageKey === lastKeyRef.current) return;
    lastKeyRef.current = storageKey;
    if (!storageKey) {
      setParams(defaults);
      return;
    }
    try {
      const saved = localStorage.getItem(storageKey);
      setParams(saved ? { ...defaults, ...JSON.parse(saved) } : defaults);
    } catch {
      setParams(defaults);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Persist on every change
  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(params));
    } catch {
      // quota exceeded — fail silently
    }
  }, [storageKey, params]);

  // Convenience updater: setParam('key', value)
  const setParam = (key, value) =>
    setParams(prev => ({ ...prev, [key]: value }));

  return [params, setParam, setParams];
}
