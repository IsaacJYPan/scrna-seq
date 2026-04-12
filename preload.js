const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // R Plumber API base URL
  apiBase: 'http://localhost:8000',

  // File dialogs
  openCsvDialog: () => ipcRenderer.invoke('open-csv-dialog'),
  saveScriptDialog: (defaultName) => ipcRenderer.invoke('save-script-dialog', defaultName),
  saveFile: (filePath, content) => ipcRenderer.invoke('save-file', filePath, content),

  // ── Appearance ─────────────────────────────────────────────
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),

  // ── Provenance (persisted in SQLite) ─────────────────────────
  saveProvenance: (envelope) => ipcRenderer.invoke('db-save-provenance', envelope),
  getProvenance: (id) => ipcRenderer.invoke('db-get-provenance', id),
  getAllProvenance: () => ipcRenderer.invoke('db-get-all-provenance'),
  getProvenanceChain: (id) => ipcRenderer.invoke('db-get-provenance-chain', id),

  // ── Results Cache ────────────────────────────────────────────
  makeCacheKey: (operation, params, dataVersion) =>
    ipcRenderer.invoke('db-make-cache-key', operation, params, dataVersion),
  getCachedResult: (cacheKey) => ipcRenderer.invoke('db-get-cached-result', cacheKey),
  setCachedResult: (cacheKey, provenanceId, resultData) =>
    ipcRenderer.invoke('db-set-cached-result', cacheKey, provenanceId, resultData),
  clearCache: () => ipcRenderer.invoke('db-clear-cache'),

  // ── Auth ────────────────────────────────────────────────────
  signup: (email, password, displayName) =>
    ipcRenderer.invoke('auth-signup', email, password, displayName),
  login: (email, password) =>
    ipcRenderer.invoke('auth-login', email, password),
});
