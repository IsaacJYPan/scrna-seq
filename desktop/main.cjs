'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { isAllowedNavigation, normalizeServerUrl } = require('./desktopConfig.cjs');

const SETTINGS_FILE = 'desktop-settings.json';
let mainWindow = null;
let serverUrl = null;

// Plotly uses WebGL for high-density single-cell views. Ask Chromium to keep
// WebGL available when a desktop session's GPU is blocklisted, while leaving
// backend selection to Chromium so an unavailable software renderer cannot
// blank the entire desktop window.
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

async function readSavedServerUrl() {
  try {
    const raw = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    return normalizeServerUrl(raw?.serverUrl);
  } catch {
    return null;
  }
}

async function saveServerUrl(value) {
  const normalized = normalizeServerUrl(value);
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsPath(), `${JSON.stringify({ serverUrl: normalized }, null, 2)}\n`, 'utf8');
  serverUrl = normalized;
  return serverUrl;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#f5f5f7',
    title: 'TraceOmics',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!serverUrl || !isAllowedNavigation(url, serverUrl)) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function showSetup() {
  await mainWindow?.loadFile(path.join(__dirname, 'setup.html'));
}

async function openServer(value) {
  const normalized = await saveServerUrl(value);
  await mainWindow?.loadURL(normalized);
  return normalized;
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'TraceOmics',
      submenu: [
        { label: 'Server Connection…', click: () => showSetup() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(async () => {
  ipcMain.handle('desktop:get-server-url', () => serverUrl);
  ipcMain.handle('desktop:configure-server', async (_event, value) => openServer(value));
  ipcMain.handle('desktop:open-external', async (_event, value) => {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links can be opened.');
    await shell.openExternal(url.toString());
  });

  createWindow();
  installMenu();
  const configuredUrl = process.env.TRACEOMICS_DESKTOP_URL || await readSavedServerUrl();
  if (configuredUrl) {
    try {
      await openServer(configuredUrl);
      return;
    } catch {
      // The local setup screen gives the user a recoverable path without exposing technical details.
    }
  }
  await showSetup();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    if (serverUrl) mainWindow.loadURL(serverUrl);
    else showSetup();
  }
});
