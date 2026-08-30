const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SyncWatchPlatform', Object.freeze({
  version: 1,
  runtime: 'electron',
  role: 'client',
  serverApp: false,
  clientApp: true
}));

contextBridge.exposeInMainWorld('SyncWatchClient', {
  inspect: (address) => ipcRenderer.invoke('syncwatch-client:inspect', address),
  loadLoginModel: (address) => ipcRenderer.invoke('syncwatch-client:load-login-model', address),
  open: (address) => ipcRenderer.invoke('syncwatch-client:open', address),
  openExternal: (value) => ipcRenderer.invoke('syncwatch-client:open-external', String(value || '')),
  readClipboardText: () => ipcRenderer.invoke('syncwatch-client:read-clipboard-text'),
  writeClipboardText: (value) => ipcRenderer.invoke('syncwatch-client:write-clipboard-text', String(value || '')),
  setAudioMuted: (muted) => ipcRenderer.invoke('syncwatch-client:audio-muted', Boolean(muted)),
  listAudioSources: () => ipcRenderer.invoke('syncwatch-client:list-audio-sources')
});
