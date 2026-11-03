// 截图选区窗口预载：与主进程通信
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cap', {
  onShot: (cb) => ipcRenderer.on('shot', (e, dataUrl) => cb(dataUrl)),
  done: (dataUrl) => ipcRenderer.send('crop-done', dataUrl),
  cancel: () => ipcRenderer.send('crop-cancel')
});
