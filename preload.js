const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadSessions: () => ipcRenderer.invoke('load-sessions'),
  saveSessions: (sessions) => ipcRenderer.invoke('save-sessions', sessions),
  createTerminal: (tabId, session, cols, rows) =>
    ipcRenderer.invoke('create-terminal', tabId, session, cols, rows),
  killTerminal: (tabId) => ipcRenderer.invoke('kill-terminal', tabId),
  sendInput: (tabId, data) => ipcRenderer.send('terminal-input', tabId, data),
  resizeTerminal: (tabId, cols, rows) =>
    ipcRenderer.send('terminal-resize', tabId, cols, rows),
  onTerminalData: (callback) =>
    ipcRenderer.on('terminal-data', (_e, tabId, data) => callback(tabId, data)),
  onTerminalExit: (callback) =>
    ipcRenderer.on('terminal-exit', (_e, tabId, exitCode) => callback(tabId, exitCode)),
  pasteClipboardImage: () => ipcRenderer.invoke('paste-clipboard-image'),
  scpUpload: (sshHost, localPath) => ipcRenderer.invoke('scp-upload', sshHost, localPath),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
});
