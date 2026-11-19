const { contextBridge, ipcRenderer } = require('electron');
// 可选模块按需加载：任一模块缺失（例如打包 files 白名单漏配）只降级对应功能，
// 绝不能因为一个 require 失败就让整个 window.api 消失、应用变成白屏。
let solarlunar = null, holidays = {}, workdays = {}, historyData = null;
try { solarlunar = require('solarlunar'); } catch (e) { console.error('[preload] solarlunar missing:', e.message); }
try { ({ holidays, workdays } = require('./holidays')); } catch (e) { console.error('[preload] holidays missing:', e.message); }
try { historyData = require('./history-data'); } catch (e) { console.error('[preload] history-data missing:', e.message); }

// 历史条目兜底：数据模块缺失时给一条通用文案，小窗不至于空白
const FALLBACK_HISTORY = { title: '历史上的今天 · 铭记来时路', year: '', source: 'fallback' };

contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('load-state'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  setAutoStart: (v) => ipcRenderer.invoke('set-auto-start', v),
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
  getHistoryToday: () => ipcRenderer.invoke('get-history-today'),
  getTodayEntry: (iso, online) => {
    if (!historyData) return FALLBACK_HISTORY;
    try { return historyData.getToday(iso ? new Date(iso) : new Date(), online || null); }
    catch (e) { return FALLBACK_HISTORY; }
  },
  onEventsUpdated: (cb) => ipcRenderer.on('events-updated', (e, list) => cb(list)),
  onDockState: (cb) => ipcRenderer.on('dock:state', (e, s) => cb(s)),
  solar2lunar: (y, m, d) => {
    if (!solarlunar) return null;
    try { return solarlunar.solar2lunar(y, m, d); } catch (e) { return null; }
  },
  holidaysData: { holidays, workdays }
});
