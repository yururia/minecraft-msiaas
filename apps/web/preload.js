const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  readFileAsBase64: (filePath) => ipcRenderer.invoke('read-file-base64', filePath),
  readFileAsBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  importModpack: (filePath, fileName) => ipcRenderer.invoke('import-modpack', filePath, fileName),
});
