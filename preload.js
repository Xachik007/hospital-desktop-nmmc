const { contextBridge, ipcRenderer } = require('electron');

// Flag for the hospital web app (hold-to-talk, Inspect button, etc.)
contextBridge.exposeInMainWorld('__ELECTRON__', true);

const api = {
  isElectron: true,
  onNfcEvent: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('nfc:event', listener);
    return () => ipcRenderer.removeListener('nfc:event', listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

// DevTools bridge only when main allows it (unpackaged / explicit debug).
ipcRenderer
  .invoke('devtools:allowed')
  .then((allowed) => {
    if (!allowed) return;
    api.openDevTools = () => ipcRenderer.invoke('devtools:open');
  })
  .catch(() => {});
