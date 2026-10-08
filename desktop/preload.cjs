'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', Object.freeze({
  configureServer: (url) => ipcRenderer.invoke('desktop:configure-server', url),
  getServerUrl: () => ipcRenderer.invoke('desktop:get-server-url'),
  getCurrentTarget: () => ipcRenderer.invoke('desktop:get-current-target'),
  getTargetProfiles: () => ipcRenderer.invoke('desktop:get-target-profiles'),
  saveTargetProfile: (profile) => ipcRenderer.invoke('desktop:save-target-profile', profile),
  connectTargetProfile: (id) => ipcRenderer.invoke('desktop:connect-target-profile', id),
  saveAndConnectTargetProfile: (profile) => ipcRenderer.invoke('desktop:save-and-connect-target-profile', profile),
  removeTargetProfile: (id) => ipcRenderer.invoke('desktop:remove-target-profile', id),
  openTargetSettings: () => ipcRenderer.invoke('desktop:open-target-settings'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
}));
