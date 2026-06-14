// src/api.js
// Replaces the window.electronAPI object with standard fetch calls to our Express server.

const BASE_URL = 'http://localhost:3000'; // Or rely on relative path if served from same origin
const CLIENT_ID = localStorage.getItem('client_id') || Math.random().toString(36).substr(2, 9);
localStorage.setItem('client_id', CLIENT_ID);

async function req(endpoint, options = {}) {
  options.headers = options.headers || {};
  options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
  options.headers['X-Client-ID'] = CLIENT_ID;
  
  const res = await fetch(`${BASE_URL}${endpoint}`, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json();
}

export const electronAPI = {
  // R Plumber Proxy
  apiRequest: async (endpoint, options = {}) => {
    try {
      options.headers = options.headers || {};
      options.headers['X-Client-ID'] = CLIENT_ID;
      
      const res = await fetch(`${BASE_URL}/api/r${endpoint}`, options);
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await res.json();
      }
      return await res.text();
    } catch (e) {
      return { error: e.message };
    }
  },

  // Auth / DB calls
  signup: async (email, password, displayName) => {
    return req('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });
  },
  login: async (email, password) => {
    return req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  },
  
  // Figures
  getFigures: async (email) => req(`/api/db/figures?email=${encodeURIComponent(email)}`),
  saveFigure: async (record) => req('/api/db/figures', { method: 'POST', body: JSON.stringify(record) }),
  deleteFigure: async (id) => req(`/api/db/figures/${id}`, { method: 'DELETE' }),

  // Provenance
  dbSaveProvenance: async (envelope) => req('/api/db/provenance', { method: 'POST', body: JSON.stringify(envelope) }),
  getProvenance: async (id) => req(`/api/db/provenance/${id}`),
  dbGetProvenance: async (id) => req(`/api/db/provenance/${id}`),
  dbGetAllProvenance: async () => req('/api/db/provenance'),
  dbGetProvenanceChain: async (id) => req(`/api/db/provenance-chain/${id}`),
  dbDeleteProvenance: async (id) => req(`/api/db/provenance/${id}`, { method: 'DELETE' }),

  // Cache
  dbMakeCacheKey: async (op, params, ver, pids) => {
    const res = await req('/api/db/cache-key', { method: 'POST', body: JSON.stringify({ operation: op, params, dataVersion: ver, parentIds: pids }) });
    return res.key;
  },
  dbGetCachedResult: async (key) => req(`/api/db/cache/${key}`),
  dbSetCachedResult: async (key, pid, data) => req(`/api/db/cache/${key}`, { method: 'POST', body: JSON.stringify({ provenanceId: pid, resultData: data }) }),
  dbClearCache: async () => req('/api/db/cache', { method: 'DELETE' }),

  // Theme
  setTheme: (theme) => { /* No-op in browser, handled by CSS */ },

  // Diagnostics (Dummy for web)
  getRScriptPath: async () => '/usr/bin/Rscript',
  setRScriptPath: async () => true,
  checkREnv: async () => ({ version: 'R 4.5.1', packages: { Seurat: true } }),
  restartPlumber: () => {},
  runRInstaller: () => {},
  onRInstallerOutput: () => () => {},
  onRInstallerDone: () => () => {},

  // Dialogs (Mocked or unsupported in web)
  openCsvDialog: async () => { alert("File dialogs are not supported in web mode yet."); return null; },
  openDirectoryDialog: async () => { alert("File dialogs are not supported in web mode yet."); return null; },
  openMultiDirectoryDialog: async () => { alert("File dialogs are not supported in web mode yet."); return []; },
  openDataFileDialog: async () => { alert("File dialogs are not supported in web mode yet."); return null; },
  saveScriptDialog: async () => { alert("File dialogs are not supported in web mode yet."); return null; },
  openExportsFolder: async () => { alert("Cannot open local folders from web mode."); return false; },
  scan10xRoot: async () => { return { root: null, found: [] }; }
};
