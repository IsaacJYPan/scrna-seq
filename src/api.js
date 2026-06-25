// src/api.js
// Replaces the window.electronAPI object with standard fetch calls to our Express server.

const BASE_URL = 'http://localhost:3000'; // Or rely on relative path if served from same origin
const CLIENT_ID = localStorage.getItem('client_id') || Math.random().toString(36).substr(2, 9);
localStorage.setItem('client_id', CLIENT_ID);
const AUTH_TOKEN_KEY = 'benchone_auth_token';
const AUTH_USER_KEY = 'benchone_auth_user';

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || 'null');
  } catch {
    return null;
  }
}

function persistAuthResponse(data) {
  if (!data?.token || !data?.user) return data;
  localStorage.setItem(AUTH_TOKEN_KEY, data.token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(data.user));
  return { ...data.user, token: data.token };
}

function attachAuthHeader(headers) {
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
}

function pickFiles({ accept = '', directory = false, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple || directory;
    if (directory) {
      input.webkitdirectory = true;
      input.directory = true;
    }
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(Array.from(input.files || []));
      input.remove();
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

async function uploadSingleFile(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  const headers = {};
  attachAuthHeader(headers);

  const res = await fetch(`${BASE_URL}/api/upload`, { method: 'POST', headers, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.path;
}

async function uploadDirectory(files) {
  const form = new FormData();
  files.forEach((file) => {
    form.append('files', file, file.name);
    form.append('relativePaths', file.webkitRelativePath || file.name);
  });
  const headers = {};
  attachAuthHeader(headers);

  const res = await fetch(`${BASE_URL}/api/upload-directory`, { method: 'POST', headers, body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.path;
}

async function pickAndUploadFile(kind = '') {
  const accepts = {
    csv: '.csv,.tsv,.txt',
    rds: '.rds',
    h5: '.h5,.h5ad,.h5seurat'
  };
  const files = await pickFiles({ accept: accepts[kind] || '', multiple: false });
  if (!files[0]) return null;
  return uploadSingleFile(files[0]);
}

async function pickAndUploadDirectory() {
  const files = await pickFiles({ directory: true });
  if (files.length === 0) return null;
  return uploadDirectory(files);
}

function formatRequestError(error) {
  try {
    const parsed = JSON.parse(error.message);
    return parsed?.error || error.message;
  } catch {
    return error.message;
  }
}

async function req(endpoint, options = {}) {
  options.headers = options.headers || {};
  options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
  options.headers['X-Client-ID'] = CLIENT_ID;
  attachAuthHeader(options.headers);
  
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
      attachAuthHeader(options.headers);
      
      const res = await fetch(`${BASE_URL}/api/r${endpoint}`, options);
      const contentType = res.headers.get('content-type');
      let data;
      if (contentType && contentType.includes('application/json')) {
        data = await res.json();
      } else {
        data = await res.text();
      }
      
      if (!res.ok) {
        if (typeof data === 'object' && data.error) return data;
        return { error: typeof data === 'string' ? data : res.statusText };
      }
      
      return data;
    } catch (e) {
      return { error: e.message };
    }
  },

  // Auth / DB calls
  signup: async (email, password, displayName) => {
    try {
      const data = await req('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });
      return persistAuthResponse(data);
    } catch (error) {
      return { error: formatRequestError(error) };
    }
  },
  login: async (email, password) => {
    try {
      const data = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      return persistAuthResponse(data);
    } catch (error) {
      return { error: formatRequestError(error) };
    }
  },
  getCurrentUser,
  logout: async () => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  },
  
  // Figures
  getFigures: async () => req('/api/db/figures'),
  saveFigure: async (record) => req('/api/db/figures', { method: 'POST', body: JSON.stringify(record) }),
  deleteFigure: async (id) => req(`/api/db/figures/${id}`, { method: 'DELETE' }),

  // Provenance
  saveProvenance: async (envelope) => req('/api/db/provenance', { method: 'POST', body: JSON.stringify(envelope) }),
  dbSaveProvenance: async (envelope) => req('/api/db/provenance', { method: 'POST', body: JSON.stringify(envelope) }),
  getProvenance: async (id) => req(`/api/db/provenance/${id}`),
  dbGetProvenance: async (id) => req(`/api/db/provenance/${id}`),
  getAllProvenance: async () => req('/api/db/provenance'),
  dbGetAllProvenance: async () => req('/api/db/provenance'),
  getProvenanceChain: async (id) => req(`/api/db/provenance-chain/${id}`),
  dbGetProvenanceChain: async (id) => req(`/api/db/provenance-chain/${id}`),
  deleteProvenance: async (id) => req(`/api/db/provenance/${id}`, { method: 'DELETE' }),
  dbDeleteProvenance: async (id) => req(`/api/db/provenance/${id}`, { method: 'DELETE' }),

  // Cache
  makeCacheKey: async (op, params, ver, pids) => {
    const res = await req('/api/db/cache-key', { method: 'POST', body: JSON.stringify({ operation: op, params, dataVersion: ver, parentIds: pids }) });
    return res.key;
  },
  dbMakeCacheKey: async (op, params, ver, pids) => {
    const res = await req('/api/db/cache-key', { method: 'POST', body: JSON.stringify({ operation: op, params, dataVersion: ver, parentIds: pids }) });
    return res.key;
  },
  getCachedResult: async (key) => req(`/api/db/cache/${key}`),
  dbGetCachedResult: async (key) => req(`/api/db/cache/${key}`),
  setCachedResult: async (key, pid, data) => req(`/api/db/cache/${key}`, { method: 'POST', body: JSON.stringify({ provenanceId: pid, resultData: data }) }),
  dbSetCachedResult: async (key, pid, data) => req(`/api/db/cache/${key}`, { method: 'POST', body: JSON.stringify({ provenanceId: pid, resultData: data }) }),
  clearCache: async () => req('/api/db/cache', { method: 'DELETE' }),
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
  openCsvDialog: async () => pickAndUploadFile('csv'),
  openDirectoryDialog: async () => pickAndUploadDirectory(),
  openMultiDirectoryDialog: async () => {
    const path = await pickAndUploadDirectory();
    return path ? [path] : [];
  },
  openDataFileDialog: async (kind) => pickAndUploadFile(kind),
  saveScriptDialog: async () => { alert("File dialogs are not supported in web mode yet."); return null; },
  openExportsFolder: async () => { alert("Cannot open local folders from web mode."); return false; },
  scan10xRoot: async () => { return { root: null, found: [] }; }
};
