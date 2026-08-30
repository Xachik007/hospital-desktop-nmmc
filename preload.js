const { contextBridge, ipcRenderer } = require('electron');

// Flag for the hospital web app (hold-to-talk, Inspect button, etc.)
contextBridge.exposeInMainWorld('__ELECTRON__', true);
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  openDevTools: () => ipcRenderer.invoke('devtools:open'),
});
