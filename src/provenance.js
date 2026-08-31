// `electronAPI` is the historical name of the browser API facade in src/api.js.
const api = typeof window !== 'undefined' ? window.electronAPI : null;
const memStore = new Map();

export async function saveProvenance(envelope) {
  if (!envelope?.provenance?.id) return null;

  memStore.set(envelope.provenance.id, envelope);

  if (api?.saveProvenance) {
    await api.saveProvenance(envelope);
  }
  return envelope.provenance.id;
}

export async function getProvenance(id) {
  if (memStore.has(id)) return memStore.get(id).provenance;

  if (api?.getProvenance) {
    return await api.getProvenance(id);
  }
  return null;
}

export async function loadPersistedProvenance() {
  if (!api?.getAllProvenance) return [];
  const records = await api.getAllProvenance();
  return records || [];
}

export async function getProvenanceChain(id) {
  if (api?.getProvenanceChain) {
    return await api.getProvenanceChain(id);
  }
  const prov = await getProvenance(id);
  return prov ? [prov] : [];
}

export async function makeCacheKey(operation, params, dataVersion, parentIds = []) {
  if (api?.makeCacheKey) {
    return await api.makeCacheKey(operation, params, dataVersion, parentIds);
  }
  return `${operation}-${JSON.stringify(params)}-${dataVersion}-${JSON.stringify(parentIds)}`;
}

export async function getCachedResult(cacheKey) {
  if (api?.getCachedResult) {
    return await api.getCachedResult(cacheKey);
  }
  return null;
}

export async function setCachedResult(cacheKey, provenanceId, resultData) {
  if (api?.setCachedResult) {
    await api.setCachedResult(cacheKey, provenanceId, resultData);
  }
}
