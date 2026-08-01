'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', Object.freeze({
  configureServer: (url) => ipcRenderer.invoke('desktop:configure-server', url),
  getServerUrl: () => ipcRenderer.invoke('desktop:get-server-url'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
}));
