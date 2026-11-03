const { contextBridge, ipcRenderer } = require('electron');
const solarlunar = require('solarlunar');
const { holidays, workdays } = require('./holidays');

contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('load-state'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  saveEvents: (e) => ipcRenderer.invoke('save-events', e),
  savePeople: (p) => ipcRenderer.invoke('save-people', p),
  captureScreen: () => ipcRenderer.invoke('capture-screen-region'),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('set-always-on-top', v),
  showWin: () => ipcRenderer.invoke('win-show'),
  aiExtract: (payload) => ipcRenderer.invoke('ai-extract', payload),
  testConnection: (s) => ipcRenderer.invoke('test-connection', s),
  saveIcs: (m) => ipcRenderer.invoke('save-ics', m),
  readClipboardImage: () => ipcRenderer.invoke('read-clipboard-image'),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  hideWin: () => ipcRenderer.invoke('win-hide'),
  minWin: () => ipcRenderer.invoke('win-min'),
  dockPill: () => ipcRenderer.invoke('dock-pill'),
  dockHover: (v) => ipcRenderer.invoke('dock-hover', v),
  openMain: () => ipcRenderer.invoke('open-main'),
  setHoverLock: (v) => ipcRenderer.invoke('set-hover-lock', v),
  pillMenu: () => ipcRenderer.invoke('pill-menu'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (e, msg) => cb(msg)),
  onEventsUpdated: (cb) => ipcRenderer.on('events-updated', (e, list) => cb(list)),
  onDockState: (cb) => ipcRenderer.on('dock:state', (e, s) => cb(s)),
  solar2lunar: (y, m, d) => solarlunar.solar2lunar(y, m, d),
  holidaysData: { holidays, workdays }
});
