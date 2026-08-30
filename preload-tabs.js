const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabsApi', {
  createTab: (url) => ipcRenderer.send('tabs:create', url || null),
  activateTab: (id) => ipcRenderer.send('tabs:activate', id),
  closeTab: (id) => ipcRenderer.send('tabs:close', id),
  onState: (callback) => {
    ipcRenderer.on('tabs:state', (_event, state) => callback(state));
  },
});
