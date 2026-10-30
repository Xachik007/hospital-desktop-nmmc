const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('presenceUI', {
  onUpdate(callback) {
    ipcRenderer.on('presence:update', (_event, data) => callback(data));
  },
});
