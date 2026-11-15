import { useState, useEffect, useRef, useCallback } from 'react';

function paramsKey(step, email, objectId) {
  return email && objectId
    ? `traceomics_params_${step}_${email.replace(/[^a-zA-Z0-9]/g, '_')}_${objectId}`
    : null;
}

/**
 * Saving an analysis creates a new version with a new object id. Carry every
 * step's settings to it, so pages keep showing the settings that were used
 * (and any typed while the save ran) instead of falling back to defaults.
 * Settings already stored for the new version are kept.
 */
export function carryTabParams(email, fromObjectId, toObjectId, storage = globalThis.localStorage) {
  if (!email || !fromObjectId || !toObjectId || fromObjectId === toObjectId || !storage) return 0;
  const prefix = 'traceomics_params_';
  const suffix = `_${email.replace(/[^a-zA-Z0-9]/g, '_')}_${fromObjectId}`;
  let copied = 0;
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) keys.push(storage.key(index));
    for (const key of keys) {
      if (!key || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
      const step = key.slice(prefix.length, key.length - suffix.length);
      const target = paramsKey(step, email, toObjectId);
      if (storage.getItem(target) !== null) continue;
      storage.setItem(target, storage.getItem(key));
      copied += 1;
    }
  } catch {
    // Storage unavailable: pages fall back to their defaults.
  }
  return copied;
}

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
  const storageKey = paramsKey(step, email, objectId);

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
  const setParam = useCallback((key, value) => {
    setParams(prev => ({ ...prev, [key]: value }));
  }, []);

  return [params, setParam, setParams];
}
