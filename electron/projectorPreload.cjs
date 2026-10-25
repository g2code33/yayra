'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('yayraProjection', {
  onFrame(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, frame) => {
      if (typeof frame === 'string' && frame.startsWith('data:image/png;base64,')) callback(frame);
    };
    ipcRenderer.on('yayra:projector-frame', listener);
    return () => ipcRenderer.removeListener('yayra:projector-frame', listener);
  }
});
