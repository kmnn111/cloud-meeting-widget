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

// 自检模式：重定向 userData，避免测试落盘覆盖真实日历数据
if (process.env.CM_TEST_DUP) {
  try { app.setPath('userData', path.join(__dirname, '.test-userdata')); } catch (e) { }
}
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

/* ---------------- 桌面部件贴附（对齐天气插件 v1.0.26 #70） ----------------
   「显示桌面」（Win+D / 任务栏右下角小竖条）对 skipTaskbar 工具窗既不最小化也不发 minimize
   事件，而是把全屏壁纸 WorkerW 从 z 序底部跃升到普通窗口带顶端盖住一切——非 topmost 窗口
   必被壁纸盖住（窗口仍"健康"但用户看不见）。
   ── 桌面部件语义（置顶关时）：小窗钉在「壁纸层」正上方——平时贴 z 序底部（所有程序窗口
   之下、不挡视线），壁纸跃升时跟着浮到壁纸之上；被点聚焦 / 展开时允许自然置前，失焦 /
   收起即归位；壁纸可见（桌面态）时强制钉住。
   ── 置顶开时：topmost('screen-saver') 天然免疫壁纸跃升。大窗态一律按用户置顶偏好走。 */
let glueTimer = null, glueU32 = null;
function glueInit() {
  if (glueU32) return glueU32;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    glueU32 = {
      getDesktop: u.func('void *GetDesktopWindow()'),
      getWindow: u.func('void *GetWindow(void *h, uint cmd)'),
      getClassName: u.func('int GetClassNameW(void *h, uint16 *buf, int max)'),
      getRect: u.func('bool GetWindowRect(void *h, void *rect)'),
      isVisible: u.func('bool IsWindowVisible(void *h)'),
      findChild: u.func('void *FindWindowExW(void *p, void *after, str16 cls, str16 name)'),
      setPos: u.func('bool SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint flags)'),
      isWindow: u.func('bool IsWindow(void *h)')
    };
  } catch (e) { glueU32 = null; }
  return glueU32;
}
/* 壁纸层定位：全屏 WorkerW（唯一恒定特征：class=WorkerW、w>1200、h>700）。
   实测：该窗常态沉在 z 序底（不可见）；explorer「显示桌面」把它「带 SHELLDLL_DefView」跃升
   到普通窗口带顶端盖一切——注意跃升后它「有」DefView（图标层搬进去了），按无 DefView 过滤
   会永远找不到跃升层。每 tick 重扫、不缓存句柄（跃升=换位+变形，缓存必失手）；自顶向下扫描、
   上限 2000。可见者取最靠上（跃升态）；全不可见取最靠下（常态）。 */
function glueWallpaper() {
  const A = glueInit(); if (!A) return null;
  let p = A.getWindow(A.getDesktop(), 5), n = 0; // GW_CHILD：自顶向下
  const seen = new Set();
  const nameBuf = Buffer.alloc(256);
  let visBest = null, hidBest = null;
  while (p && p !== 0n && n < 2000) {
    const s = String(p); if (seen.has(s)) break; seen.add(s);
    const len = A.getClassName(p, nameBuf, 128);
    if (nameBuf.subarray(0, len * 2).toString('utf16le') === 'WorkerW') {
      const r = Buffer.alloc(16); A.getRect(p, r);
      const w = r.readInt32LE(8) - r.readInt32LE(0), h = r.readInt32LE(12) - r.readInt32LE(4);
      if (w > 1200 && h > 700) {
        if (A.isVisible(p)) { if (!visBest) visBest = p; } // 第一个可见 = 最靠上（跃升壁纸层）
        else hidBest = p;                                  // 最后写入 = 最靠下（常态壁纸层）
      }
    }
    p = A.getWindow(p, 2); n++; // GW_HWNDNEXT 向 z 序下方
  }
  return visBest || hidBest;
}
function glueTick() {
  const A = glueInit(); if (!A || !win || win.isDestroyed()) return;
  const W = glueWallpaper(); if (!W) return; // 找不到壁纸层（异形系统）→ 退回自然 z 序，不硬抬
  const wallUp = A.isVisible(W);
  // 常态下交互放行（聚焦/展开允许自然置前）；壁纸可见=桌面态必须钉住
  if (!wallUp && (win.isFocused() || dockExpanded)) return;
  const hw = win.getNativeWindowHandle().readBigUInt64LE(0);
  // 目标态：小窗紧贴壁纸层「上方」（其下邻=壁纸层）。
  // SetWindowPos(A, B) 是把 A 插到 B【下方】——要插壁纸层上方须用「壁纸层的上邻」做锚；
  // W 已是链顶时上邻为 NULL(=HWND_TOP)，仍在 W 上方。
  if (A.getWindow(hw, 2) !== W) {
    const anchor = A.getWindow(W, 3) || 0n;
    A.setPos(hw, anchor, 0, 0, 0, 0, 0x1B); // SWP_NOSIZE|NOMOVE|NOSENDCHANGING|NOACTIVATE
  }
}
function setGlue(on) {
  if (on) {
    if (!glueTimer) glueTimer = setInterval(glueTick, 100);
    glueTick();
  } else if (glueTimer) {
    clearInterval(glueTimer); glueTimer = null;
  }
}
function applyTopmost() {
  if (!win || win.isDestroyed()) return;
  try {
    if (settings.docked && settings.alwaysOnTop) {
      win.setAlwaysOnTop(true, 'screen-saver'); // 置顶用户：浮最上层，「显示桌面」天然免疫
      setGlue(false);
    } else {
      win.setAlwaysOnTop(!!settings.alwaysOnTop, 'floating');
      setGlue(!!settings.docked && !settings.alwaysOnTop); // 桌面部件：钉壁纸层上沿
    }
  } catch (e) { }
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
  applyTopmost(); // 桌面部件贴附：钉壁纸层上沿（置顶开时 topmost 免疫壁纸跃升）
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
  applyTopmost(); // 脱离吸顶 → 回归用户置顶偏好（大窗态系统行为不变）
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
  // 最小化时窗口飞到屏外 (-32000)，b.y - wa.y 恒「贴顶」会把最小化误判成吸顶反手 dock
  if (win.isMinimized()) return;
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
  applyTopmost();
  /* 吸顶小窗常驻桌面：系统级最小化（Win+D / Win+M / 任务栏「显示桌面」）是唯一能让本窗
     最小化的入口（skipTaskbar+无边框没有最小化按钮），故 docked 态拦截 minimize 原地恢复；
     大窗态保持系统正常行为。恢复用 showInactive 不抢焦点，用户仍停留在桌面；置顶层级/
     形状在恢复后重申一次（最小化可能掉档）。 */
  const undoMinimize = () => {
    if (!win || win.isDestroyed() || !settings.docked) return;
    if (!win.isMinimized()) return;
    try { win.showInactive(); } catch (e) { try { win.restore(); } catch (e2) { } }
    try { win.moveTop(); } catch (e3) { }
    try { applyTopmost(); } catch (e4) { }
    if (settings.docked && !dockExpanded) setShapePill();
  };
  win.on('minimize', () => {
    if (!settings.docked) return;
    setImmediate(undoMinimize);        // 最小化事件后立即拉回
    setTimeout(undoMinimize, 40);      // 系统最小化动画期间再兜一次（事件时序竞争）
    setTimeout(undoMinimize, 250);
  });
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
  win.on('closed', () => { setGlue(false); win = null; stopHoverPoll(); });

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
      if (process.env.CM_SHOT_CAPTURE) {
        // 端到端自检：自动跑通"抓屏→预览文件→遮罩→选区→主进程裁剪→回传"全链路
        setTimeout(async () => {
          console.log('[main] capture pipeline test start');
          const p = win.webContents.executeJavaScript('window.api.captureScreen()');
          await new Promise(r => setTimeout(r, 2500));
          const overlay = BrowserWindow.getAllWindows().find(w => w !== win && !w.isDestroyed());
          if (overlay) {
            await overlay.webContents.executeJavaScript('window.cap.done({x:100,y:100,w:300,h:200})');
          } else {
            console.log('[main] capture pipeline FAIL: overlay not found');
          }
          const dataUrl = await p;
          if (dataUrl && dataUrl.startsWith('data:image')) {
            const img = nativeImage.createFromDataURL(dataUrl);
            fs.writeFileSync(path.join(__dirname, 'debug-shot-capture.png'), img.toPNG());
            console.log('[main] capture pipeline OK', JSON.stringify(img.getSize()));
          } else {
            console.log('[main] capture pipeline FAIL, result =', dataUrl);
          }
          setTimeout(() => app.exit(0), 300);
        }, 1500);
      }
      if (process.env.CM_SHOT_GLUE) {
        // 桌面部件贴附自检：收起为胶囊 → z 序断言（下邻=壁纸 WorkerW）→ 真实「显示桌面」截证
        setTimeout(async () => {
          dockWindow();
          await new Promise(r => setTimeout(r, 900));
          const A = glueInit();
          const hw = win.getNativeWindowHandle().readBigUInt64LE(0);
          const { execSync } = require('child_process');
          const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type 'using System.Runtime.InteropServices;public class D{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[D]::SetProcessDPIAware() | Out-Null
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
$bmp.Save('${path.join(__dirname, 'debug-shot-glue.png').replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()`;
          execSync('powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).MinimizeAll()"');
          await new Promise(r => setTimeout(r, 1200));
          // 断言在「显示桌面」态内做：此时壁纸可见=强制钉住（常态聚焦态允许自然置前，不钉是预期）
          const W = A && glueWallpaper();
          const clsOf = (h) => {
            if (!h || h === 0n) return '(null)';
            const b = Buffer.alloc(256); const l = A.getClassName(h, b, 128);
            return b.subarray(0, l * 2).toString('utf16le');
          };
          const next = A && A.getWindow(hw, 2);
          console.log('[main] glue diag:', JSON.stringify({
            hw: String(hw), next: String(next), nextCls: clsOf(next),
            W: W ? String(W) : null, wallUp: W ? A.isVisible(W) : null,
            focused: win.isFocused(), minimized: win.isMinimized()
          }));
          const glued = !!(A && W && next === W);
          if (A && W && !glued) {
            const ret = A.setPos(hw, A.getWindow(W, 3) || 0n, 0, 0, 0, 0, 0x1B);
            console.log('[main] manual pin ret:', ret, 'now nextCls:', clsOf(A.getWindow(hw, 2)));
          }
          const pinned = !!(A && W && A.getWindow(hw, 2) === W);
          console.log('[main] glue pin check:', !A ? 'FAIL koffi unavailable'
            : glued ? 'OK glued-above-wallpaper'
              : pinned ? 'OK manual-pin-works' : 'FAIL pin failed');
          execSync('powershell -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64'), { timeout: 8000 });
          console.log('[main] glue desktop shot saved');
          execSync('powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).UndoMinimizeAll()"');
          await new Promise(r => setTimeout(r, 400));
          setTimeout(() => app.exit(0), 300);
        }, 1500);
      }
      if (process.env.CM_TEST_DUP) {
        // 改期识别端到端自检：旧会议 + AI 识别改期 → 同名匹配 → 勾选移除 → 只剩新日期
        setTimeout(async () => {
          const out = await win.webContents.executeJavaScript(`(async () => {
            const pad2 = n => String(n).padStart(2, '0');
            const dOf = off => { const n = new Date(Date.now() + off * 864e5);
              return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate()); };
            // 场景1：具体会议改期 → 旧记录默认勾选移除，只留新日期
            const dOld = dOf(1), dNew = dOf(3);
            events = [{ id: 'old1', title: '关于召开项目推进会的通知', date: dOld,
              start_time: '09:00', end_time: '10:00', location: '一楼会议室', attendees: [], notes: null }];
            fillConfirm({ title: '项目推进会', date: dNew, start_time: '14:00', end_time: '15:00',
              location: '二楼', attendees: ['张三'], notes: null });
            const dupShown = !$('cf-dup').classList.contains('hidden');
            const checked1 = document.querySelectorAll('#cf-dup-list input:checked').length;
            await saveMeeting();
            const kept = events.map(e => e.id + ':' + e.date + ':' + (e.start_time || ''));
            const s1 = { dupShown, checked: checked1, count: events.length, kept };
            // 场景2：周例会（过去日期 + 短泛标题）→ 默认不勾选，保存后历史例会保留
            const dPast = dOf(-2);
            events = [{ id: 'old2', title: '周例会', date: dPast,
              start_time: '10:00', end_time: '11:00', location: null, attendees: [], notes: null }];
            fillConfirm({ title: '周例会', date: dOf(1), start_time: '10:00', end_time: '11:00',
              location: null, attendees: [], notes: null });
            const checked2 = document.querySelectorAll('#cf-dup-list input:checked').length;
            await saveMeeting();
            const s2 = { checked: checked2, count: events.length, kept: events.map(e => e.id + ':' + e.date) };
            return JSON.stringify({ s1, s2 });
          })()`);
          console.log('[main] dup-reschedule test:', out);
          const r = JSON.parse(out);
          const ok1 = r.s1.dupShown && r.s1.checked === 1 && r.s1.count === 1 && r.s1.kept[0].includes(':14:00');
          const ok2 = r.s2.checked === 0 && r.s2.count === 2 && r.s2.kept.some(k => k.startsWith('old2:'));
          console.log('[main] dup-reschedule check:', (ok1 && ok2) ? 'OK' : `FAIL (s1=${ok1} s2=${ok2})`);
          setTimeout(() => app.exit(ok1 && ok2 ? 0 : 1), 300);
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
        applyTopmost();
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
  applyTopmost();
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
  applyTopmost();
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
  // 未配置 AI 模型：走免 Key 本地规则解析（纯文字可用；图片必须有视觉模型）
  const hasKey = s && s.apiKey && s.baseUrl;
  if (!hasKey) {
    if (!text && imageDataUrl) {
      return {
        ok: false,
        error: '图片识别需要配置 AI 模型：请在设置填入任意 OpenAI 兼容接口的 API Key（推荐免费方案：智谱 GLM-4V-Flash、SiliconFlow 免费额度）。纯文字通知无需 Key，直接点“AI识别”即可本地解析。'
      };
    }
    const { localExtract } = require('./local-extract');
    return { ok: true, meeting: localExtract(text || ''), local: true };
  }
  const now = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const todayStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${week}`;
  const sys = `你是会议信息提取助手。今天是${todayStr}。
从用户提供的文字或图片中提取会议信息，严格只输出一个JSON对象，不要输出任何其他文字：
{"title":"会议名称","date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM或null","location":"地点或null","attendees":["人名",...],"notes":"补充说明或null"}
规则：
1. 相对日期（今天/明天/下周三等）以今天为基准推算；
2. 只有日期没有时间时，start_time 填 null；若原文只有“上午/下午/晚上”等模糊时段而无具体时分，start_time 填 null 并把该时段写入 notes；
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
  let timeLines;
  if (meeting.start_time) {
    const start = dt(meeting.date, meeting.start_time);
    const end = meeting.end_time ? dt(meeting.date, meeting.end_time)
      : dt(meeting.date, meeting.start_time, 60);
    timeLines = [
      `DTSTART;TZID=Asia/Shanghai:${start}`,
      end ? `DTEND;TZID=Asia/Shanghai:${end}` : null
    ];
  } else {
    // 只到日期（或仅上午/下午）的会议 → 全天事件导入系统日历，不硬塞 09:00
    const d0 = new Date(meeting.date + 'T00:00:00');
    const d1 = new Date(d0.getTime() + 86400000);
    const fmt = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    timeLines = [
      `DTSTART;VALUE=DATE:${fmt(d0)}`,
      `DTEND;VALUE=DATE:${fmt(d1)}`
    ];
  }
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CloudMeeting//CN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@cloudmeeting`,
    ...timeLines.filter(Boolean),
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
  if (process.env.CM_TEST_DUP) return file;   // 自检模式不弹资源管理器
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

/* ---------------- IPC：截图选区 ----------------
   成熟方案（对齐业界通行做法）：
   1. desktopCapturer 抓屏后 NativeImage 全程留在主进程；
   2. 预览写临时文件给遮罩窗 file:// 加载——4K+DPI 下 base64 大图走 IPC 是黑屏/卡死主因；
   3. 遮罩窗只回传选区矩形（几个数字），裁剪在主进程 nativeImage.crop 完成（无 canvas、无大对象传输）；
   4. cap-ready 就绪握手投递预览路径，杜绝消息先到未注册的竞态；
   5. 120 秒安全兜底强制退出，任何异常都不会把用户卡在黑屏里。 */
async function grabDisplayShot(display) {
  try {
    const b = display.bounds;
    const dpr = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      fetchWindowIcons: false,
      thumbnailSize: { width: Math.round(b.width * dpr), height: Math.round(b.height * dpr) }
    });
    const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return src.thumbnail;   // NativeImage，留在主进程内存
  } catch (e) {
    return null;
  }
}

ipcMain.handle('capture-screen-region', async () => {
  const wasVisible = win && !win.isDestroyed() && win.isVisible();
  if (wasVisible) win.hide();
  await new Promise(r => setTimeout(r, 650));

  // 抓鼠标所在显示器（多屏可用）
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const shot = await grabDisplayShot(disp);
  if (!shot || shot.isEmpty()) {
    if (wasVisible && win && !win.isDestroyed()) win.show();
    return null;
  }
  // 预览写临时文件（不走 IPC）
  const previewFile = path.join(app.getPath('temp'), 'cm-capture-preview.png');
  try { fs.writeFileSync(previewFile, shot.toPNG()); } catch (e) {
    if (wasVisible && win && !win.isDestroyed()) win.show();
    return null;
  }

  return await new Promise((resolve) => {
    const overlay = new BrowserWindow({
      x: disp.bounds.x, y: disp.bounds.y,
      width: disp.bounds.width, height: disp.bounds.height,
      frame: false, transparent: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, movable: false, maximizable: false,
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

    let settled = false;
    const finish = (dataUrl) => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      ipcMain.removeListener('cap-ready', onReady);
      ipcMain.removeListener('crop-done', onDone);
      ipcMain.removeListener('crop-cancel', onCancel);
      if (!overlay.isDestroyed()) overlay.destroy();
      try { fs.unlinkSync(previewFile); } catch (e) { }
      if (wasVisible && win && !win.isDestroyed()) win.show();
      resolve(dataUrl);
    };
    // 就绪握手：遮罩窗脚本注册完监听后主动来要预览路径
    const onReady = (e) => {
      if (e.sender !== overlay.webContents) return;
      overlay.webContents.send('shot-path', previewFile);
    };
    // crop-done 收到的是选区矩形（窗口 CSS 像素）或 null=全屏，裁剪在主进程做
    const onDone = (e, rect) => {
      if (e.sender !== overlay.webContents) return;
      const imgSize = shot.getSize();
      const kx = imgSize.width / disp.bounds.width;
      const ky = imgSize.height / disp.bounds.height;
      if (!rect || !rect.w || !rect.h) { finish(shot.toDataURL()); return; }
      try {
        const x = clamp(Math.round(rect.x * kx), 0, imgSize.width - 2);
        const y = clamp(Math.round(rect.y * ky), 0, imgSize.height - 2);
        const w = clamp(Math.round(rect.w * kx), 2, imgSize.width - x);
        const h = clamp(Math.round(rect.h * ky), 2, imgSize.height - y);
        finish(shot.crop({ x, y, width: w, height: h }).toDataURL());
      } catch (err) {
        finish(shot.toDataURL());
      }
    };
    const onCancel = (e) => {
      if (e.sender !== overlay.webContents) return;
      finish(null);
    };
    ipcMain.on('cap-ready', onReady);
    ipcMain.on('crop-done', onDone);
    ipcMain.on('crop-cancel', onCancel);
    // 兜底：任何情况下不把用户卡在黑屏（异常/消息丢失 120 秒后自动恢复）
    const safety = setTimeout(() => finish(null), 120000);
  });
});
