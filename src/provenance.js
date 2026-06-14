/**
 * Provenance Tracking System (Frontend)
 * 
 * This module talks to the SQLite-backed database via Electron IPC.
 * Supports:
 *   - Persisting provenance records across sessions
 *   - DAG traversal (ancestors of a result)
 *   - Full pipeline export (topologically sorted, deduplicated)
 *   - Result caching by operation+params+dataVersion
 */

const api = typeof window !== 'undefined' ? window.electronAPI : null;

// ── Fallback in-memory store for dev/browser mode ────────────────
const memStore = new Map();

// ── Provenance API ───────────────────────────────────────────────

/**
 * Save a provenance envelope (persisted to SQLite via IPC).
 */
export async function saveProvenance(envelope) {
  if (!envelope?.provenance?.id) return null;

  // Always keep in memory too for instant access
  memStore.set(envelope.provenance.id, envelope);

  // Persist to SQLite
  if (api?.saveProvenance) {
    await api.saveProvenance(envelope);
  }
  return envelope.provenance.id;
}

/**
 * Get a provenance record by ID.
 */
export async function getProvenance(id) {
  // Check memory first
  if (memStore.has(id)) return memStore.get(id).provenance;

  // Fall back to SQLite
  if (api?.getProvenance) {
    return await api.getProvenance(id);
  }
  return null;
}

/**
 * Get the full provenance envelope (provenance + result) by ID.
 */
export function getEnvelope(id) {
  return memStore.get(id) || null;
}

/**
 * Get all provenance records (from SQLite, most recent first).
 */
export async function getAllProvenance() {
  if (api?.getAllProvenance) {
    return await api.getAllProvenance();
  }
  // Fallback: return from memory
  return Array.from(memStore.values())
    .map(e => e.provenance)
    .reverse();
}

/**
 * Load persisted provenance from SQLite on app startup.
 */
export async function loadPersistedProvenance() {
  if (!api?.getAllProvenance) return [];
  const records = await api.getAllProvenance();
  return records || [];
}

/**
 * Get the full ancestor chain for a provenance ID (topologically sorted,
 * shared ancestors deduplicated). Returned in dependency order: 
 * earliest ancestor first, target last.
 */
export async function getProvenanceChain(id) {
  if (api?.getProvenanceChain) {
    return await api.getProvenanceChain(id);
  }
  // Fallback: just return the single record
  const prov = await getProvenance(id);
  return prov ? [prov] : [];
}

/**
 * Delete a provenance record by ID (from SQLite and in-memory).
 */
export async function deleteProvenance(id) {
  if (memStore.has(id)) {
    memStore.delete(id);
  }
  if (api?.deleteProvenance) {
    await api.deleteProvenance(id);
  }
}

// ── Caching ──────────────────────────────────────────────────────

/**
 * Generate a cache key for an operation.
 */
export async function makeCacheKey(operation, params, dataVersion, parentIds = []) {
  if (api?.makeCacheKey) {
    return await api.makeCacheKey(operation, params, dataVersion, parentIds);
  }
  // Fallback: simple string hash
  return `${operation}-${JSON.stringify(params)}-${dataVersion}-${JSON.stringify(parentIds)}`;
}

/**
 * Check if a cached result exists for this cache key.
 */
export async function getCachedResult(cacheKey) {
  if (api?.getCachedResult) {
    return await api.getCachedResult(cacheKey);
  }
  return null;
}

/**
 * Store a result in the cache.
 */
export async function setCachedResult(cacheKey, provenanceId, resultData) {
  if (api?.setCachedResult) {
    await api.setCachedResult(cacheKey, provenanceId, resultData);
  }
}

/**
 * Clear all cached results (e.g., when data changes).
 */
export async function clearCache() {
  if (api?.clearCache) {
    await api.clearCache();
  }
}

// ── Pipeline Export ──────────────────────────────────────────────

const LANG_EXTENSIONS = {
  'R': '.R',
  'Python': '.py',
  'Julia': '.jl',
  'JavaScript': '.js',
};

/**
 * Build a header comment for an exported script.
 */
function makeHeader(prov, commentChar = '#') {
  const lines = [
    `${commentChar} ──────────────────────────────────────────────────`,
    `${commentChar} Auto-exported from R Data Dashboard`,
    `${commentChar} Provenance ID: ${prov.id}`,
    `${commentChar} Timestamp:     ${prov.timestamp}`,
    `${commentChar} Language:      ${prov.language} ${prov.languageVersion}`,
    `${commentChar} Packages:      ${(prov.packages || []).join(', ') || 'none'}`,
  ];
  if (prov.parameters && Object.keys(prov.parameters).length > 0) {
    lines.push(`${commentChar} Parameters:    ${JSON.stringify(prov.parameters)}`);
  }
  if (prov.parentIds && prov.parentIds.length > 0) {
    lines.push(`${commentChar} Depends on:    ${prov.parentIds.join(', ')}`);
  }
  lines.push(`${commentChar} ──────────────────────────────────────────────────`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Build a complete pipeline script from a provenance chain.
 * The chain should be topologically sorted (ancestors first).
 */
export function buildPipelineScript(chain) {
  if (!chain || chain.length === 0) return '';

  const lang = chain[0].language || 'R';
  const commentChar = '#'; // works for R, Python, Julia

  // Collect all unique packages
  const allPackages = new Set();
  chain.forEach(p => (p.packages || []).forEach(pkg => allPackages.add(pkg)));

  // Build header
  const header = [
    `${commentChar} ══════════════════════════════════════════════════`,
    `${commentChar} Complete Pipeline — Exported from R Data Dashboard`,
    `${commentChar} Steps: ${chain.length}`,
    `${commentChar} Generated: ${new Date().toISOString()}`,
    `${commentChar} ══════════════════════════════════════════════════`,
    '',
  ];

  // Package loading (deduplicated, skip built-ins)
  const builtins = new Set(['base', 'utils', 'stats', 'graphics', 'grDevices', 'methods']);
  const externalPkgs = Array.from(allPackages).filter(p => !builtins.has(p));
  if (externalPkgs.length > 0 && lang === 'R') {
    header.push(`${commentChar} ── Required packages ──`);
    externalPkgs.forEach(p => header.push(`library(${p})`));
    header.push('');
  } else if (externalPkgs.length > 0 && lang === 'Python') {
    header.push(`${commentChar} ── Required packages ──`);
    externalPkgs.forEach(p => header.push(`import ${p}`));
    header.push('');
  }

  // Each step
  const steps = chain.map((prov, i) => {
    const stepHeader = [
      `${commentChar} ── Step ${i + 1}: ${prov.id} ──`,
    ];
    if (prov.parameters && Object.keys(prov.parameters).length > 0) {
      stepHeader.push(`${commentChar} Parameters: ${JSON.stringify(prov.parameters)}`);
    }
    stepHeader.push('');
    return stepHeader.join('\n') + prov.script;
  });

  return header.join('\n') + '\n' + steps.join('\n\n') + '\n';
}

/**
 * Build and export the full pipeline for a given provenance ID.
 * Walks the DAG, deduplicates, and produces a single script file.
 */
export async function exportPipeline(provenanceId) {
  const chain = await getProvenanceChain(provenanceId);
  if (chain.length === 0) return;

  const lang = chain[0].language || 'R';
  const ext = LANG_EXTENSIONS[lang] || '.txt';
  const scriptContent = buildPipelineScript(chain);

  const blob = new Blob([scriptContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pipeline_${provenanceId}${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export a single provenance record's script (no chain).
 */
export function downloadSingleScript(prov) {
  if (!prov) return;
  const ext = LANG_EXTENSIONS[prov.language] || '.txt';
  const header = makeHeader(prov);
  const scriptContent = header + prov.script + '\n';

  const blob = new Blob([scriptContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `script_${prov.id}${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
