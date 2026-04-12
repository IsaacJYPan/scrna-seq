const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

// Database module
const db = require('./src/database');

// Path to Rscript — update if your R installation is elsewhere
const RSCRIPT_PATH = 'C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe';
const PLUMBER_PORT = 8000;
const VITE_DEV_URL = 'http://localhost:5173';

let mainWindow;
let rProcess;

// ── Database setup ───────────────────────────────────────────────
const DB_DIR = path.join(app.getPath('userData'), 'data');
const DB_PATH = path.join(DB_DIR, 'dashboard.db');

// ── Launch the R Plumber API server ──────────────────────────────
function startPlumber() {
  const plumberScript = path.join(__dirname, 'r-backend', 'run.R');
  
  rProcess = spawn(RSCRIPT_PATH, [plumberScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  rProcess.stdout.on('data', (data) => {
    console.log(`[R] ${data.toString().trim()}`);
  });

  rProcess.stderr.on('data', (data) => {
    console.log(`[R stderr] ${data.toString().trim()}`);
  });

  rProcess.on('error', (err) => {
    console.error('Failed to start R process:', err.message);
  });

  rProcess.on('close', (code) => {
    console.log(`R process exited with code ${code}`);
  });
}

// ── Wait for Plumber to be ready ─────────────────────────────────
function waitForPlumber(retries = 30) {
  return new Promise((resolve, reject) => {
    const check = (attempt) => {
      http.get(`http://localhost:${PLUMBER_PORT}/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else if (attempt < retries) setTimeout(() => check(attempt + 1), 500);
        else reject(new Error('Plumber not healthy'));
      }).on('error', () => {
        if (attempt < retries) setTimeout(() => check(attempt + 1), 500);
        else reject(new Error('Plumber never started'));
      });
    };
    check(0);
  });
}

// ── Create the Electron window ───────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'scRNA-seq Workbench',
    backgroundColor: '#0f172a',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f172a',
      symbolColor: '#94a3b8',
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL(VITE_DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

// ── Register IPC handlers ────────────────────────────────────────
function registerIPC() {
  ipcMain.on('set-theme', (event, theme) => {
    if (mainWindow) {
      mainWindow.setTitleBarOverlay({
        color: theme === 'light' ? '#f8fafc' : '#0f172a',
        symbolColor: theme === 'light' ? '#475569' : '#94a3b8'
      });
      mainWindow.setBackgroundColor(theme === 'light' ? '#f8fafc' : '#0f172a');
    }
  });

  // File dialogs
  ipcMain.handle('open-csv-dialog', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Open CSV File',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  });

  ipcMain.handle('save-script-dialog', async (event, defaultName) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Script',
      defaultPath: defaultName,
      filters: [
        { name: 'R Script', extensions: ['R'] },
        { name: 'Python Script', extensions: ['py'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (canceled) return null;
    return filePath;
  });

  // ── Provenance IPC ──────────────────────────────────────────────
  ipcMain.handle('db-save-provenance', (event, envelope) => {
    return db.saveProvenance(envelope);
  });

  ipcMain.handle('db-get-provenance', (event, id) => {
    return db.getProvenance(id);
  });

  ipcMain.handle('db-get-all-provenance', () => {
    return db.getAllProvenance();
  });

  ipcMain.handle('db-get-provenance-chain', (event, id) => {
    return db.getProvenanceChain(id);
  });

  // ── Cache IPC ────────────────────────────────────────────────────
  ipcMain.handle('db-make-cache-key', (event, operation, params, dataVersion) => {
    return db.makeCacheKey(operation, params, dataVersion);
  });

  ipcMain.handle('db-get-cached-result', (event, cacheKey) => {
    return db.getCachedResult(cacheKey);
  });

  ipcMain.handle('db-set-cached-result', (event, cacheKey, provenanceId, resultData) => {
    return db.setCachedResult(cacheKey, provenanceId, resultData);
  });

  ipcMain.handle('db-clear-cache', () => {
    return db.clearCache();
  });

  // ── File save for script export ──────────────────────────────────
  ipcMain.handle('save-file', async (event, filePath, content) => {
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  });

  // ── Auth IPC ────────────────────────────────────────────────────
  ipcMain.handle('auth-signup', (event, email, password, displayName) => {
    return db.createUser(email, password, displayName);
  });

  ipcMain.handle('auth-login', (event, email, password) => {
    return db.verifyUser(email, password);
  });
}

// ── App lifecycle ────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Initialize database
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  db.initDatabase(DB_PATH);

  // Register IPC handlers
  registerIPC();

  // Remove default menu
  Menu.setApplicationMenu(null);

  // Start R Plumber
  startPlumber();
  try {
    await waitForPlumber();
    console.log('Plumber API is ready!');
  } catch (err) {
    console.error('Could not start Plumber API:', err.message);
  }

  createWindow();
});

app.on('window-all-closed', () => {
  if (rProcess) rProcess.kill();
  db.closeDatabase();
  app.quit();
});

app.on('before-quit', () => {
  if (rProcess) rProcess.kill();
  db.closeDatabase();
});
