const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SyncWatchPlatform', Object.freeze({
  version: 1,
  runtime: 'electron',
  role: 'server',
  serverApp: true,
  clientApp: false
}));

contextBridge.exposeInMainWorld('SyncWatchDesktop', {
  openExternal: (value) => ipcRenderer.invoke('syncwatch:open-external', String(value || '')),
  readClipboardText: () => ipcRenderer.invoke('syncwatch:read-clipboard-text'),
  writeClipboardText: (value) => ipcRenderer.invoke('syncwatch:write-clipboard-text', String(value || '')),
  setAudioMuted: (muted) => ipcRenderer.invoke('syncwatch:audio-muted', Boolean(muted)),
  listAudioSources: () => ipcRenderer.invoke('syncwatch:list-audio-sources'),
  openConvertedMediaFolder: () => ipcRenderer.invoke('syncwatch:open-compatible-media-folder'),
  showNotification: (payload) => ipcRenderer.invoke('syncwatch:show-notification', {
    title: String(payload?.title || ''), body: String(payload?.body || '')
  }),
  onCloseRequested: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('syncwatch:request-close-choice', listener);
    return () => ipcRenderer.removeListener('syncwatch:request-close-choice', listener);
  },
  completeCloseChoice: (requestedChoice) => {
    const choice = String(requestedChoice || '').trim().toLowerCase();
    if (!['minimize', 'quit', 'restart', 'new-server', 'cancel'].includes(choice)) return Promise.resolve({ success: false, error: '无效的关闭方式' });
    return ipcRenderer.invoke('syncwatch:close-choice', choice);
  },
  onDisplayCaptureFallbackRequested: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('syncwatch:display-capture-fallback-requested', listener);
    ipcRenderer.send('syncwatch:display-capture-fallback-ready');
    return () => ipcRenderer.removeListener('syncwatch:display-capture-fallback-requested', listener);
  },
  completeDisplayCaptureFallback: (approved) => (
    ipcRenderer.invoke('syncwatch:display-capture-fallback-choice', approved === true)
  )
});
