'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSshConnectionManager } = require('./sshConnection.cjs');
const { unlockNativeIdentity } = require('./sshCredentials.cjs');
const packageMetadata = require('../package.json');
const { isAllowedNavigation, normalizeServerUrl, verifyServerConnection,
  normalizeTargetProfile, normalizeTargetSettings, profileForServerUrl,
  targetServiceIdentity, targetSessionPartition } = require('./desktopConfig.cjs');

const SETTINGS_FILE = 'desktop-settings.json';
const SETUP_FILE = path.join(__dirname, 'setup.html');
const SETUP_URL = pathToFileURL(SETUP_FILE).href;
let mainWindow = null;
let setupWindow = null;
let serverUrl = null;
let connectedProfile = null;
let settings = normalizeTargetSettings(null);
let settingsWarning = null;
let changingTarget = false;
let starting = true;
let sshManager = null;
const selectedIdentities = new Set();
const sshVerificationVersions = new Map();
const windowTargets = new Map();
const userDataOverride = app.commandLine.getSwitchValue('user-data-dir');
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

// Plotly needs a usable WebGL renderer for large and three-dimensional views.
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

function settingsPath() { return path.join(app.getPath('userData'), SETTINGS_FILE); }

async function readTargetSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    settings = normalizeTargetSettings(saved);
    if (saved.serverUrl) await writeTargetSettings(settings);
  } catch (error) {
    if (error.code !== 'ENOENT') settingsWarning = 'Saved connection settings could not be read. Add or correct a target to continue.';
  }
}

async function writeTargetSettings(next) {
  const normalized = normalizeTargetSettings(next);
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsPath() + '.tmp', JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.rename(settingsPath() + '.tmp', settingsPath());
  settings = normalized;
  settingsWarning = null;
}

function targetSummary(profile, status = 'connected') {
  if (!profile) return null;
  return { id: profile.id, name: profile.name, kind: profile.kind,
    endpoint: profile.endpoint || null, serviceIdentity: targetServiceIdentity(profile), status,
    capabilities: status === 'connected' ? { projectService: true } : null,
    ...(profile.kind === 'ssh' ? { sshAuthentication: sshManager?.status(profile) || null } : {}) };
}

function currentTarget() {
  if (connectedProfile) return targetSummary(connectedProfile);
  const selected = settings.profiles.find(profile => profile.id === settings.selectedProfileId);
  return targetSummary(selected, selected?.kind === 'ssh' ? 'configuration_only' : 'disconnected');
}

function createWindow({ profile = null, parent = null } = {}) {
  const isSetup = !profile;
  const window = new BrowserWindow({
    width: isSetup ? 760 : 1440, height: isSetup ? 900 : 960,
    minWidth: isSetup ? 600 : 1024, minHeight: 720,
    show: false, ...(parent ? { parent, modal: true } : {}),
    backgroundColor: '#f5f5f7', title: 'TraceOmics',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      partition: profile ? targetSessionPartition(profile) : 'traceomics-target-setup' },
  });
  windowTargets.set(window.webContents.id, { window, profile });
  const allowedNavigation = url => isSetup ? url === SETUP_URL : isAllowedNavigation(url, profile.endpoint);
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
        void shell.openExternal(parsed.toString()).catch(() => {});
      }
    } catch { /* Unsupported links remain inside the navigation boundary. */ }
    return { action: 'deny' };
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  for (const eventName of ['will-navigate', 'will-redirect']) {
    window.webContents.on(eventName, (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
  }
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const contentsId = window.webContents.id;
  window.on('closed', () => {
    sshVerificationVersions.set(contentsId, (sshVerificationVersions.get(contentsId) || 0) + 1);
    sshManager?.cancel(contentsId);
    windowTargets.delete(contentsId);
    sshVerificationVersions.delete(contentsId);
    if (mainWindow === window) mainWindow = null;
    if (setupWindow === window) setupWindow = null;
  });
  return window;
}

async function showSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = createWindow({ parent: connectedProfile ? mainWindow : null });
  if (!mainWindow) mainWindow = setupWindow;
  await setupWindow.loadFile(SETUP_FILE);
  setupWindow.show();
}

function assertTrustedFrame(event, { setupOnly = false } = {}) {
  const entry = windowTargets.get(event.sender.id);
  if (!entry || event.senderFrame !== event.sender.mainFrame) throw new Error('This action is available only in the desktop connection settings.');
  const frameUrl = event.senderFrame.url;
  if (!entry.profile) {
    if (frameUrl !== SETUP_URL) throw new Error('The connection settings page is unavailable.');
  } else if (setupOnly || !isAllowedNavigation(frameUrl, entry.profile.endpoint)) {
    throw new Error('Edit target profiles through the desktop connection settings.');
  }
  return entry;
}

async function changeSettings(action) {
  if (changingTarget) throw new Error('Another connection change is in progress. Wait a moment and try again.');
  changingTarget = true;
  try { return await action(); } finally {
    changingTarget = false;
    if (!starting && process.platform !== 'darwin' && BrowserWindow.getAllWindows().length === 0) app.quit();
  }
}

async function saveProfile(value) {
  const profile = normalizeTargetProfile(value);
  const previous = settings.profiles.find(saved => saved.id === profile.id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(profile)) sshManager?.invalidate(profile.id);
  if (profile.ssh?.identityFile && !selectedIdentities.has(profile.ssh.identityFile)
      && !settings.profiles.some(saved => saved.ssh?.identityFile === profile.ssh.identityFile)) {
    throw new Error('Choose the identity reference through the native file picker.');
  }
  const profiles = settings.profiles.filter(existing => existing.id !== profile.id);
  profiles.push(profile);
  await writeTargetSettings({ ...settings, profiles,
    selectedProfileId: settings.selectedProfileId || profile.id });
  return profile;
}

async function openProfile(id) {
  const profile = settings.profiles.find(item => item.id === id);
  if (!profile) throw new Error('Choose a saved target profile.');
  return connectProfile(profile);
}

async function connectProfile(profile, nextSettings = settings) {
  if (profile.kind === 'ssh') throw new Error('Verify SSH access in the connection settings. Opening the project service through a managed SSH tunnel is not available yet.');
  await verifyServerConnection(profile.endpoint);
  const candidate = createWindow({ profile });
  try {
    await candidate.loadURL(profile.endpoint);
    await writeTargetSettings({ ...nextSettings, selectedProfileId: profile.id });
  } catch (error) {
    candidate.destroy();
    throw error;
  }
  const previousMain = mainWindow;
  const previousSetup = setupWindow;
  mainWindow = candidate;
  serverUrl = profile.endpoint;
  connectedProfile = profile;
  setupWindow = null;
  candidate.show();
  if (previousSetup && previousSetup !== candidate && !previousSetup.isDestroyed()) previousSetup.destroy();
  if (previousMain && previousMain !== previousSetup && previousMain !== candidate && !previousMain.isDestroyed()) previousMain.destroy();
  return targetSummary(profile);
}

async function openServer(value) {
  const endpoint = normalizeServerUrl(value);
  const existing = settings.profiles.find(item => item.endpoint === endpoint);
  const profile = existing || profileForServerUrl(endpoint, 'Configured server');
  const nextSettings = existing ? settings : { ...settings, profiles: [...settings.profiles, profile] };
  return (await connectProfile(profile, nextSettings)).endpoint;
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'TraceOmics', submenu: [
      { label: 'Execution Targets…', click: () => showSetup() },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'About TraceOmics', click: () => dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'About TraceOmics', message: 'TraceOmics',
      detail: 'Version ' + app.getVersion() + '\nCollaborative transcriptomic analysis workbench',
      buttons: ['OK'], defaultId: 0,
    }) }] },
  ]));
}

app.whenReady().then(async () => {
  app.setAppUserModelId('org.traceomics.workbench');
  await readTargetSettings();
  sshManager = createSshConnectionManager({ knownHostsFile: path.join(app.getPath('userData'), 'ssh_known_hosts') });
  ipcMain.handle('desktop:get-server-url', event => {
    const entry = assertTrustedFrame(event);
    return entry.profile?.endpoint || serverUrl;
  });
  ipcMain.handle('desktop:get-current-target', event => {
    const entry = assertTrustedFrame(event);
    return entry.profile ? targetSummary(entry.profile) : currentTarget();
  });
  ipcMain.handle('desktop:get-target-profiles', event => {
    assertTrustedFrame(event, { setupOnly: true });
    return { ...settings, currentTarget: currentTarget(), warning: settingsWarning,
      sshStatuses: Object.fromEntries(settings.profiles.filter(profile => profile.kind === 'ssh').map(profile => [profile.id, sshManager.status(profile)])) };
  });
  ipcMain.handle('desktop:choose-ssh-identity', async event => {
    assertTrustedFrame(event, { setupOnly: true });
    const choice = await dialog.showOpenDialog(setupWindow, { title: 'Choose OpenSSH identity reference', properties: ['openFile'] });
    const identityFile = choice.canceled ? null : choice.filePaths[0];
    if (identityFile) selectedIdentities.add(identityFile);
    return identityFile;
  });
  ipcMain.handle('desktop:verify-ssh-target', (event, value) => {
    assertTrustedFrame(event, { setupOnly: true });
    return changeSettings(async () => {
      const version = (sshVerificationVersions.get(event.sender.id) || 0) + 1;
      sshVerificationVersions.set(event.sender.id, version);
      const profile = await saveProfile(value);
      assertTrustedFrame(event, { setupOnly: true });
      if (sshVerificationVersions.get(event.sender.id) !== version) throw new Error('SSH verification was canceled.');
      return sshManager.verify(profile, event.sender.id);
    });
  });
  ipcMain.handle('desktop:confirm-ssh-host', (event, challengeId, fingerprint) => {
    assertTrustedFrame(event, { setupOnly: true });
    return changeSettings(() => sshManager.confirm(challengeId, fingerprint, event.sender.id));
  });
  ipcMain.handle('desktop:cancel-ssh-verification', event => {
    assertTrustedFrame(event, { setupOnly: true });
    sshVerificationVersions.set(event.sender.id, (sshVerificationVersions.get(event.sender.id) || 0) + 1);
    sshManager.cancel(event.sender.id); return true;
  });
  ipcMain.handle('desktop:open-ssh-host-trust', async event => {
    assertTrustedFrame(event, { setupOnly: true });
    const filename = path.join(app.getPath('userData'), 'ssh_known_hosts');
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const handle = await fs.open(filename, 'a', 0o600); await handle.close();
    shell.showItemInFolder(filename); return true;
  });
  ipcMain.handle('desktop:unlock-ssh-identity', async (event, identityFile) => {
    assertTrustedFrame(event, { setupOnly: true });
    if (!selectedIdentities.has(identityFile) && !settings.profiles.some(profile => profile.ssh?.identityFile === identityFile)) {
      throw new Error('Choose an identity reference first.');
    }
    return unlockNativeIdentity(identityFile, { showInstructions: options => dialog.showMessageBox(setupWindow, options) });
  });
  ipcMain.handle('desktop:save-target-profile', (event, value) => {
    assertTrustedFrame(event, { setupOnly: true });
    return changeSettings(() => saveProfile(value));
  });
  ipcMain.handle('desktop:connect-target-profile', (event, id) => {
    assertTrustedFrame(event, { setupOnly: true });
    return changeSettings(() => openProfile(id));
  });
  ipcMain.handle('desktop:save-and-connect-target-profile', (event, value) => {
    assertTrustedFrame(event, { setupOnly: true });
    return changeSettings(async () => {
      const profile = normalizeTargetProfile(value);
      const profiles = [...settings.profiles.filter(existing => existing.id !== profile.id), profile];
      return connectProfile(profile, { ...settings, profiles });
    });
  });
  ipcMain.handle('desktop:remove-target-profile', (event, id) => {
    assertTrustedFrame(event, { setupOnly: true });
    return changeSettings(async () => {
      if (!settings.profiles.some(profile => profile.id === id)) throw new Error('Choose a saved target profile.');
      if (connectedProfile?.id === id) throw new Error('Connect to another target before removing the current connection.');
      await writeTargetSettings({ ...settings, profiles: settings.profiles.filter(profile => profile.id !== id),
        selectedProfileId: settings.selectedProfileId === id ? null : settings.selectedProfileId });
      sshManager.invalidate(id);
      return true;
    });
  });
  ipcMain.handle('desktop:open-target-settings', event => { assertTrustedFrame(event); return showSetup(); });
  ipcMain.handle('desktop:configure-server', (event, value) => {
    assertTrustedFrame(event, { setupOnly: true });
    return changeSettings(() => openServer(value));
  });
  ipcMain.handle('desktop:open-external', async (event, value) => {
    assertTrustedFrame(event);
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public web links can be opened.');
    await shell.openExternal(url.toString());
  });
  installMenu();
  const configuredUrl = process.env.TRACEOMICS_DESKTOP_URL || packageMetadata.traceomicsDesktop?.defaultServerUrl;
  try {
    if (configuredUrl) { await openServer(configuredUrl); return; }
    if (settings.selectedProfileId) {
      const selected = settings.profiles.find(profile => profile.id === settings.selectedProfileId);
      if (selected?.kind === 'ssh') { await showSetup(); return; }
      await openProfile(settings.selectedProfileId); return;
    }
  } catch {
    settingsWarning = 'The selected target could not be connected. Check its settings or choose another target.';
  }
  await showSetup();
}).finally(() => { starting = false; });

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !starting && !changingTarget) app.quit(); });
app.on('before-quit', () => sshManager?.dispose());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (connectedProfile) openProfile(connectedProfile.id).catch(() => showSetup());
    else showSetup();
  }
});
