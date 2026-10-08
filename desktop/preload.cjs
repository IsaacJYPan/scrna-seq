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
  chooseSshIdentity: () => ipcRenderer.invoke('desktop:choose-ssh-identity'),
  verifySshTarget: (profile) => ipcRenderer.invoke('desktop:verify-ssh-target', profile),
  confirmSshHost: (challengeId, fingerprint) => ipcRenderer.invoke('desktop:confirm-ssh-host', challengeId, fingerprint),
  cancelSshVerification: () => ipcRenderer.invoke('desktop:cancel-ssh-verification'),
  openSshHostTrust: () => ipcRenderer.invoke('desktop:open-ssh-host-trust'),
  unlockSshIdentity: (identityFile) => ipcRenderer.invoke('desktop:unlock-ssh-identity', identityFile),
  openTargetSettings: () => ipcRenderer.invoke('desktop:open-target-settings'),
  disconnectTarget: () => ipcRenderer.invoke('desktop:disconnect-target'),
  onTargetStatus: listener => {
    if (typeof listener !== 'function') throw new TypeError('A status listener is required.');
    const handler = (_event, target) => listener(target);
    ipcRenderer.on('desktop:target-status', handler);
    return () => ipcRenderer.removeListener('desktop:target-status', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
}));
