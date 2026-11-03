'use strict';
/**
 * 云上会议 - 桌面会议日历挂件
 * Electron 主进程：单窗口吸顶胶囊架构（移植自天气插件）
 * 窗口尺寸永远不变，收起/展开只做 CSS 淡入淡出 + setShape 裁剪
 * （形状外不渲染、不挡鼠标），避免 Win11 透明窗 resize 白底/闪烁。
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage, dialog, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let tray = null;
let quitting = false;   // 真正退出标志：托盘“退出/更新安装”时置真

/* ---------------- 吸顶小窗（setShape 胶囊） ---------------- */
const PILL_W = 248, PILL_H = 64;      // 胶囊小窗尺寸（与天气插件一致）
const SNAP_IN = 26, SNAP_OUT = 90;    // 拖到距顶端 <=26px 吸附；拖离 >90px 解除
const DESIGN_W = 400, DESIGN_H = 680; // 窗口设计尺寸（固定，resizable:false）
let baseSize = { w: DESIGN_W, h: DESIGN_H };
let dockExpanded = false;             // 吸顶后是否处于悬停展开态
let dockTimer = null;
let programmatic = 0;                 // 程序改 bounds 的时间戳，抑制吸附
let hoverPoll = null;
let hoverArmed = true;                // "离开再进入"才展开，避免刚放下小窗就弹开
let hoverLock = false;                // 设置/确认面板打开时锁定，避免误收起

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/* ---------------- 设置持久化 ---------------- */
const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  style: 0.2,
  autoWrite: false,
  autoStart: false,
  alwaysOnTop: false,     // 默认关：不遮挡其他应用（托盘/设置可开，floating 级别）
  updateUrl: '',          // OTA 更新源（选填，留空走内置 GitHub Releases 源）
  autoOpenIcs: false,     // 写入日历后自动打开 .ics（会触发系统文件关联弹窗，默认关）
  docked: true,           // 吸顶收起状态（首启默认吸顶小窗）
  dockX: null,            // 吸顶小窗 x 位置记忆
  winPos: null            // 未吸顶时的窗口位置记忆
};
// 内置更新源：GitHub Releases 直链（latest.yml 与安装包同目录）
const DEFAULT_UPDATE_URL = 'https://github.com/kmnn111/cloud-meeting-widget/releases/latest/download';
let settings = { ...DEFAULT_SETTINGS };

const dataDir = () => app.getPath('userData');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const eventsFile = () => path.join(dataDir(), 'events.json');
const peopleFile = () => path.join(dataDir(), 'people.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch (e) { /* 首次运行 */ }
}
function persist(patch = {}) {
  Object.assign(settings, patch);
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8'); } catch (e) { }
}

/* ---------------- setShape：窗口只在胶囊矩形内渲染/响应鼠标 ---------------- */
function setBoundsSafe(r) {
  if (!win || win.isDestroyed()) return;
  programmatic = Date.now();
  win.setBounds(r);
}
function pillShapeRect() {
  return [{ x: Math.round((baseSize.w - PILL_W) / 2), y: 0, width: PILL_W, height: PILL_H }];
}
function setShapePill() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape(pillShapeRect()); } catch (e) { }
}
function setShapeFull() {
  if (!win || win.isDestroyed()) return;
  try { win.setShape([{ x: 0, y: 0, width: baseSize.w, height: baseSize.h }]); } catch (e) { }
}
function sendDockState() {
  if (win && !win.isDestroyed()) win.webContents.send('dock:state', { docked: !!settings.docked, expanded: dockExpanded });
}

/* ---------------- 悬停展开/收起（对齐天气插件状态机） ---------------- */
function handleDockHover(inside) {
  if (!win || win.isDestroyed() || !settings.docked) return;
  if (process.env.CM_DEBUG) return; // 截图调试：冻结悬停自动收/展，避免抓不到大窗
  if (inside) {
    if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
    if (hoverArmed && !dockExpanded) expandDock();
  } else {
    hoverArmed = true; // 离开 → 重新武装，下次进入才展开
    if (hoverLock) return; // 面板打开时不收起
    // 已有待触发的收起定时器就不重建（轮询会反复进来，重建会永远不触发）
    if (dockExpanded && !dockTimer) {
      dockTimer = setTimeout(() => {
        dockTimer = null;
        if (win && !win.isDestroyed() && settings.docked && dockExpanded && !hoverLock) collapseDock();
      }, 450);
    }
  }
}
function ensureHoverPoll() {
  if (hoverPoll) return;
  hoverPoll = setInterval(() => {
    if (!win || win.isDestroyed() || !settings.docked) return;
    if (!win.isVisible()) return; // 隐藏到托盘时不空转光标轮询
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    // 收起态只认胶囊矩形；展开态认整个窗口
    const z = dockExpanded ? b : (r => ({ x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height }))(pillShapeRect()[0]);
    const inZone = p.x >= z.x && p.x <= z.x + z.width && p.y >= z.y && p.y <= z.y + z.height;
    if (!dockExpanded && inZone && p.x < z.x + 46) return; // 收起态左侧抓手只用于拖拽，不触发展开
    handleDockHover(inZone);
  }, 260);
}
function stopHoverPoll() {
  clearInterval(hoverPoll); hoverPoll = null;
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
}

/* ---------------- 吸顶 / 解除 / 展开 / 收起 ---------------- */
function dockWindow() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  // 只移动、不改尺寸：胶囊 x 为中心记忆位
  const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  hoverArmed = false; // 刚放下不展开，等光标离开后再进入才展开
  persist({ docked: true, dockX: px });
  setBoundsSafe({ x: px - Math.round((baseSize.w - PILL_W) / 2), y: wa.y, width: baseSize.w, height: baseSize.h });
  setShapePill();
  try { win.setSkipTaskbar(true); } catch (e) { }
  sendDockState();
  ensureHoverPoll();
}
function undockWindow() {
  if (!win || win.isDestroyed()) return;
  if (dockTimer) { clearTimeout(dockTimer); dockTimer = null; }
  dockExpanded = false;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  // 吸顶位（贴顶）不算自由位置记忆，否则下次展开会被吸附自检吸回
  const patch = { docked: false };
  if (b.y - wa.y > SNAP_OUT) patch.winPos = { x: b.x, y: b.y };
  persist(patch);
  setShapeFull();
  try { win.setSkipTaskbar(false); } catch (e) { }
  sendDockState();
  stopHoverPoll();
}
function expandDock() {
  if (!win || win.isDestroyed()) return;
  dockExpanded = true;
  setShapeFull();          // 先放开整个窗口，再由 CSS 淡入
  sendDockState();
  ensureHoverPoll();
}
function collapseDock() {
  if (!win || win.isDestroyed()) return;
  dockExpanded = false;
  hoverArmed = false;
  sendDockState();         // CSS 先淡出
  setTimeout(() => {       // 淡出（~240ms）完成后再裁剪形状，避免内容突然消失
    if (!win || win.isDestroyed() || !settings.docked || dockExpanded) return;
    // 胶囊按大窗平移后的位置对位：x 跟随大窗中心、y 贴回顶边，并固化位置记忆
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa.x, wa.x + wa.width - PILL_W);
    const nx = px - Math.round((baseSize.w - PILL_W) / 2);
    if (nx !== b.x || b.y !== wa.y) setBoundsSafe({ x: nx, y: wa.y, width: baseSize.w, height: baseSize.h });
    if (px !== settings.dockX) persist({ dockX: px });
    setShapePill();
  }, 260);
  ensureHoverPoll();
}
/* 拖拽结束：距顶端够近 → 吸顶收起；吸顶态拖离 → 恢复完整面板 */
function checkSnap() {
  if (!win || win.isDestroyed()) return;
  if (Date.now() - programmatic < 600) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (!settings.docked) {
    if (b.y - wa.y <= SNAP_IN) dockWindow();
  } else if (b.y - wa.y > SNAP_OUT) {
    undockWindow();
  } else if (!dockExpanded) {
    dockWindow(); // 仍在顶部附近松手 → 回吸对齐
  }
}

/* ---------------- 主窗口 ---------------- */
function createWindow() {
  loadSettings();
  const wa = screen.getPrimaryDisplay().workArea;
  const startDocked = !!settings.docked;
  let x, y;
  if (startDocked) {
    // 上次退出时处于吸顶态：窗口尺寸不变，只把胶囊对位到顶部
    const px = Number.isFinite(settings.dockX) ? settings.dockX : wa.x + Math.round((wa.width - PILL_W) / 2);
    x = clamp(px - Math.round((DESIGN_W - PILL_W) / 2), wa.x, wa.x + wa.width - DESIGN_W);
    y = wa.y;
  } else if (settings.winPos && Number.isFinite(settings.winPos.x)) {
    x = settings.winPos.x; y = settings.winPos.y;
  } else {
    x = wa.x + Math.round((wa.width - DESIGN_W) / 2);
    y = wa.y + 40;
  }
  // 位置自愈：落盘位置已完全离开所有屏幕 → 回退默认位
  const onScreen = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return x < a.x + a.width && x + DESIGN_W > a.x && y < a.y + a.height && y + DESIGN_H > a.y;
  });
  if (!onScreen) { x = wa.x + Math.round((wa.width - DESIGN_W) / 2); y = wa.y + 40; }

  win = new BrowserWindow({
    x: Math.round(x), y: Math.round(y),
    width: DESIGN_W, height: DESIGN_H,
    frame: false,
    transparent: true,
    thickFrame: false,        // 关掉 Win11 DWM 边框/圆角，彻底无边框沉浸
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: !!settings.alwaysOnTop,
    skipTaskbar: startDocked, // 吸顶胶囊不占任务栏；展开为完整面板时恢复
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    title: '云上会议',
    icon: path.join(process.resourcesPath || __dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  // 导航防护（Electron 安全基线）：单页本地应用不允许外跳/开窗
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating');
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    sendDockState();
    if (settings.docked) setShapePill();
  });

  if (startDocked) { hoverArmed = true; ensureHoverPoll(); }
  // 启动自愈：窗口贴在屏幕顶端（比如上次拖到顶没吸附成功）→ 自动收起为胶囊
  setTimeout(checkSnap, 1200);

  win.on('close', (e) => {
    if (quitting) return;          // 真正退出时不拦截
    e.preventDefault();
    dockWindow();                  // 关闭 = 收起回吸顶小窗
  });
  win.on('closed', () => { win = null; stopHoverPoll(); });

  // 固定尺寸窗口：任何交互/系统触发的 resize 都是异常，直接拒绝
  win.on('will-resize', (e) => e.preventDefault());

  // 位置记忆 + 顶部吸附（拖拽结束 350ms 后检测）
  const saveGeom = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (settings.docked) {
      // 吸顶态不覆盖 winPos，但胶囊位置记忆跟上大窗平移
      const wa2 = screen.getDisplayMatching(b).workArea;
      const px = clamp(Math.round(b.x + baseSize.w / 2 - PILL_W / 2), wa2.x, wa2.x + wa2.width - PILL_W);
      if (px !== settings.dockX) persist({ dockX: px });
    } else {
      persist({ winPos: { x: b.x, y: b.y } });
    }
  };
  const scheduleSnap = () => {
    if (Date.now() - programmatic < 600) return;
    clearTimeout(scheduleSnap._t);
    scheduleSnap._t = setTimeout(() => { saveGeom(); checkSnap(); }, 350);
  };
  win.on('move', scheduleSnap);
  win.on('moved', scheduleSnap);

  // 渲染进程崩溃自愈：记录后原地 reload（限次防崩溃循环）
  let goneCount = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (!details || details.reason === 'clean-exit') return;
    console.error('[main] renderer gone:', details.reason);
    if (goneCount++ >= 2) return;
    try { win.webContents.reload(); } catch (err) { }
  });

  if (process.env.CM_DEBUG) {
    win.webContents.on('did-finish-load', () => {
      console.log('[main] page loaded');
      if (process.env.CM_SHOT) {
        setTimeout(async () => {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, 'debug-shot.png'), img.toPNG());
          console.log('[main] shot saved');
          setTimeout(() => app.exit(0), 300);
        }, 1500);
      }
      if (process.env.CM_SHOT_DOCK) {
        setTimeout(async () => {
          dockWindow();
          await new Promise(r => setTimeout(r, 900));
          let img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, 'debug-shot-dock.png'), img.toPNG());
          console.log('[main] dock shot saved');
          expandDock();
          await new Promise(r => setTimeout(r, 900));
          img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(__dirname, 'debug-shot-expand.png'), img.toPNG());
          console.log('[main] expand shot saved');
          setTimeout(() => app.exit(0), 300);
        }, 1500);
      }
    });
  }
}

function openMain() {
  if (!win || win.isDestroyed()) createWindow();
  undockWindow();
  // 从吸顶位展开时窗口贴在屏幕顶端，会被吸附自检吸回 → 落到可见的自由位
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (b.y - wa.y <= SNAP_OUT) {
    const saved = settings.winPos;
    const useSaved = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
      && saved.y - wa.y > SNAP_OUT;
    const nx = useSaved ? saved.x : b.x;
    const ny = useSaved ? saved.y : wa.y + 60;
    setBoundsSafe({ x: nx, y: ny, width: baseSize.w, height: baseSize.h });
    persist({ winPos: { x: nx, y: ny } });
  }
  if (!win.isVisible()) win.show();
  win.focus();
}

/* ---------------- 托盘 ---------------- */
function trayIcon() {
  // 打包后在 resources 目录，开发模式在项目目录（process.resourcesPath 指向 Electron 自带目录）
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, 'icon.png')
  ];
  const p = candidates.find(f => { try { return fs.existsSync(f); } catch (e) { return false; } });
  return p ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}
function createTray() {
  try {
    tray = new Tray(trayIcon().resize({ width: 16, height: 16 }));
    tray.setToolTip('云上会议 · 今日会议');
    const buildMenu = () => Menu.buildFromTemplate([
      { label: '打开主面板', click: () => openMain() },
      { label: '收起为吸顶小窗', click: () => dockWindow() },
      { label: '窗口置顶', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (mi) => {
        persist({ alwaysOnTop: mi.checked });
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(mi.checked, 'floating');
      } },
      { type: 'separator' },
      { label: '检查更新', click: () => runUpdateCheck() },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(buildMenu());
    tray.on('click', () => { const m = buildMenu(); tray.setContextMenu(m); tray.popUpContextMenu(m); });
  } catch (e) {
    console.error('[tray] create failed:', e.message);
  }
}

// 胶囊右键菜单
ipcMain.handle('pill-menu', () => {
  const menu = Menu.buildFromTemplate([
    { label: '打开主面板', click: () => openMain() },
    { label: '隐藏到托盘', click: () => { if (win && !win.isDestroyed()) win.hide(); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
  menu.popup({ window: win });
});

/* ---------------- OTA 更新 ---------------- */
function initUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.setFeedURL({ provider: 'generic', url: settings.updateUrl || DEFAULT_UPDATE_URL });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => sendUpdateStatus(`发现新版本 v${info.version}，正在下载…`));
    autoUpdater.on('update-not-available', () => sendUpdateStatus('已是最新版本 ✓'));
    autoUpdater.on('download-progress', (p) => sendUpdateStatus(`正在下载新版本… ${Math.round(p.percent)}%`));
    autoUpdater.on('update-downloaded', (info) => {
      sendUpdateStatus(`新版本 v${info.version} 已就绪`);
      dialog.showMessageBox({
        type: 'info', title: '更新就绪',
        message: `云上会议 v${info.version} 已下载完成。\n立即重启安装吗？`,
        buttons: ['立即安装', '稍后'], defaultId: 0, cancelId: 1
      }).then(r => { if (r.response === 0) { quitting = true; autoUpdater.quitAndInstall(); } });
    });
    autoUpdater.on('error', (e) => sendUpdateStatus('更新检查失败：' + e.message));
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (e) {
    console.log('[updater] init failed:', e.message);
  }
}

function sendUpdateStatus(msg) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-status', msg);
  } else if (tray) {
    try { tray.displayBalloon({ title: '云上会议', content: msg }); } catch (e) { }
  }
}

async function runUpdateCheck() {
  if (!app.isPackaged) {
    sendUpdateStatus('开发模式不支持更新检查');
    return { ok: false, msg: '开发模式不支持更新检查' };
  }
  try {
    const { autoUpdater } = require('electron-updater');
    if (settings.updateUrl) autoUpdater.setFeedURL({ provider: 'generic', url: settings.updateUrl });
    sendUpdateStatus('正在检查更新…');
    await autoUpdater.checkForUpdates();
    return { ok: true, msg: '正在检查更新…' };
  } catch (e) {
    sendUpdateStatus('更新检查失败：' + e.message);
    return { ok: false, msg: e.message };
  }
}

/* ---------------- 启动 ---------------- */
app.whenReady().then(() => {
  // 桌面挂件形态：时钟不停摆
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  createWindow();               // 单窗口：吸顶胶囊 / 完整面板一体
  if (!settings.apiKey || process.env.CM_DEBUG) openMain();   // 首次使用（未配置模型）打开主面板引导设置
  createTray();
  initUpdater();
});

app.on('window-all-closed', () => { });   // 常驻托盘，不退出

/* ---------------- IPC：窗口 ---------------- */
ipcMain.handle('set-hover-lock', (e, v) => { hoverLock = !!v; });
ipcMain.handle('dock-hover', (e, v) => handleDockHover(!!v));
ipcMain.handle('dock-pill', () => { dockWindow(); return true; });
ipcMain.handle('win-hide', () => { if (win && !win.isDestroyed()) win.hide(); });
ipcMain.handle('win-show', () => { openMain(); return true; });
ipcMain.handle('win-min', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.handle('set-always-on-top', (e, v) => {
  persist({ alwaysOnTop: !!v });
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!v, 'floating');
});
ipcMain.handle('open-main', () => { openMain(); return true; });
ipcMain.handle('check-update', () => runUpdateCheck());

function broadcastEvents() {
  const list = readJson(eventsFile(), []);
  if (win && !win.isDestroyed()) win.webContents.send('events-updated', list);
}

/* ---------------- IPC：数据 ---------------- */
ipcMain.handle('load-state', () => ({
  settings: { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) },
  events: readJson(eventsFile(), []),
  people: readJson(peopleFile(), [])
}));

ipcMain.handle('save-settings', (e, incoming) => {
  // 渲染层传来的配置合并时保留主进程维护的窗口几何状态（docked/dockX/winPos）
  const s = {
    ...DEFAULT_SETTINGS, ...settings, ...incoming,
    docked: settings.docked, dockX: settings.dockX, winPos: settings.winPos
  };
  persist(s);
  try { app.setLoginItemSettings({ openAtLogin: !!s.autoStart }); } catch (err) { }
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(!!s.alwaysOnTop, 'floating');
  return true;
});

ipcMain.handle('save-events', (e, events) => {
  writeJson(eventsFile(), events);
  broadcastEvents();
  return true;
});

ipcMain.handle('save-people', (e, people) => {
  writeJson(peopleFile(), people);
  return true;
});

ipcMain.handle('read-clipboard-image', () => {
  const { clipboard } = require('electron');
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return 'data:image/png;base64,' + img.toPNG().toString('base64');
});

/* ---------------- IPC：AI ---------------- */
ipcMain.handle('ai-extract', async (e, { text, imageDataUrl, settings: s }) => {
  const now = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const todayStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${week}`;
  const sys = `你是会议信息提取助手。今天是${todayStr}。
从用户提供的文字或图片中提取会议信息，严格只输出一个JSON对象，不要输出任何其他文字：
{"title":"会议名称","date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM或null","location":"地点或null","attendees":["人名",...],"notes":"补充说明或null"}
规则：
1. 相对日期（今天/明天/下周三等）以今天为基准推算；
2. 只有日期没有时间时，start_time 填 null；
3. attendees 提取通知中出现的参会人姓名或称谓，提取不到给空数组；
4. 严禁编造原文没有的信息，无法确定的字段填 null。`;
  const temp = Math.min(0.9, Math.max(0.1, Number(s.style) || 0.2));
  const userContent = imageDataUrl
    ? [{ type: 'text', text: text || '请从这张图片中提取会议信息' },
       { type: 'image_url', image_url: { url: imageDataUrl } }]
    : (text || '请提取会议信息');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(s.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.apiKey
      },
      body: JSON.stringify({
        model: s.model,
        temperature: temp,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userContent }
        ]
      })
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `接口返回 ${res.status}：${body.slice(0, 300)}` };
    }
    const data = await res.json();
    let content = data.choices?.[0]?.message?.content || '';
    content = content.replace(/```json|```/g, '').trim();
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: '模型未返回有效JSON：' + content.slice(0, 200) };
    return { ok: true, meeting: JSON.parse(m[0]) };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.name === 'AbortError' ? '请求超时（60秒）' : ('请求失败：' + err.message) };
  }
});

ipcMain.handle('test-connection', async (e, s) => {
  try {
    const res = await fetch(s.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey },
      body: JSON.stringify({
        model: s.model,
        max_tokens: 5,
        messages: [{ role: 'user', content: '回复OK两个字母即可' }]
      })
    });
    if (!res.ok) return { ok: false, error: `接口返回 ${res.status}` };
    const data = await res.json();
    return { ok: true, reply: data.choices?.[0]?.message?.content || '(空)' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------------- IPC：日历文件 ---------------- */
ipcMain.handle('save-ics', async (e, meeting) => {
  const pad = n => String(n).padStart(2, '0');
  const dt = (d, t, addMin) => {
    if (!d || !t) return null;
    let [h, mi] = t.split(':').map(Number);
    if (addMin) { mi += addMin; h += Math.floor(mi / 60); mi %= 60; }
    return `${d.replace(/-/g, '')}T${pad(h)}${pad(mi)}00`;
  };
  const start = dt(meeting.date, meeting.start_time || '09:00');
  const end = meeting.end_time ? dt(meeting.date, meeting.end_time)
    : dt(meeting.date, meeting.start_time || '09:00', 60);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CloudMeeting//CN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@cloudmeeting`,
    `DTSTART;TZID=Asia/Shanghai:${start}`,
    end ? `DTEND;TZID=Asia/Shanghai:${end}` : null,
    `SUMMARY:${(meeting.title || '会议').replace(/[,;\\]/g, ' ')}`,
    meeting.location ? `LOCATION:${meeting.location}` : null,
    meeting.attendees?.length ? `DESCRIPTION:参会人：${meeting.attendees.join('、')}${meeting.notes ? '；' + meeting.notes : ''}` :
      (meeting.notes ? `DESCRIPTION:${meeting.notes}` : null),
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  const file = path.join(dataDir(), `${meeting.date || 'meeting'}-${meeting.title || '会议'}.ics`.replace(/[\\/:*?"<>|]/g, '_'));
  fs.writeFileSync(file, '\ufeff' + ics, 'utf-8');
  // 默认只在资源管理器中定位文件：shell.openPath 会触发 Windows"始终使用此应用打开 .ics"关联弹窗
  // 用户可在设置里开启"自动打开 .ics"走 openPath（首次仍会弹一次系统关联选择）
  const s = { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) };
  if (s.autoOpenIcs) shell.openPath(file);
  else shell.showItemInFolder(file);
  return { ok: true, file };
});

ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const ext = path.extname(r.filePaths[0]).slice(1).toLowerCase() || 'png';
  const b64 = fs.readFileSync(r.filePaths[0]).toString('base64');
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,` + b64;
});

/* ---------------- IPC：截图选区 ---------------- */
async function grabFullScreen() {
  try {
    const { width, height } = screen.getPrimaryDisplay().size;
    const dpr = screen.getPrimaryDisplay().scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * dpr), height: Math.round(height * dpr) }
    });
    const src = sources.find(s => s.display_id === String(screen.getPrimaryDisplay().id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return 'data:image/png;base64,' + src.thumbnail.toPNG().toString('base64');
  } catch (e) {
    return null;
  }
}

ipcMain.handle('capture-screen-region', async () => {
  const wasVisible = win && !win.isDestroyed() && win.isVisible();
  if (wasVisible) win.hide();
  await new Promise(r => setTimeout(r, 650));
  const full = await grabFullScreen();
  if (!full) { if (wasVisible) win.show(); return null; }

  return await new Promise((resolve) => {
    const disp = screen.getPrimaryDisplay();
    const overlay = new BrowserWindow({
      x: disp.bounds.x, y: disp.bounds.y,
      width: disp.bounds.width, height: disp.bounds.height,
      frame: false, transparent: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, movable: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
    overlay.webContents.once('did-finish-load', () => overlay.webContents.send('shot', full));

    let settled = false;
    const cleanup = (dataUrl) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('crop-done', onDone);
      ipcMain.removeListener('crop-cancel', onCancel);
      if (!overlay.isDestroyed()) overlay.destroy();
      if (wasVisible && win && !win.isDestroyed()) win.show();
      resolve(dataUrl);
    };
    const onDone = (e, dataUrl) => cleanup(dataUrl);
    const onCancel = () => cleanup(null);
    ipcMain.on('crop-done', onDone);
    ipcMain.on('crop-cancel', onCancel);
  });
});
