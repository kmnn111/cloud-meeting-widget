// 截图选区窗口预载：与主进程通信（只传小消息：就绪/路径/选区矩形/取消）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cap', {
  ready: () => ipcRenderer.send('cap-ready'),
  onShotPath: (cb) => ipcRenderer.on('shot-path', (e, p) => cb(p)),
  done: (rect) => ipcRenderer.send('crop-done', rect),   // rect {x,y,w,h}（窗口 CSS 像素）或 null = 全屏
  cancel: () => ipcRenderer.send('crop-cancel')
});
