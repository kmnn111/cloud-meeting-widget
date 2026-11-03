/* 云上会议 · 渲染逻辑 */
const $ = id => document.getElementById(id);

let settings = {};
let events = [];            // [{id,title,date,start_time,end_time,location,attendees,notes}]
let people = [];            // 常用参会人员 [{name}]
let viewYear, viewMonth;    // 当前查看的年月（1-12）
let selectedDate = null;    // 'YYYY-MM-DD'
let pendingImage = null;    // dataURL
let editingId = null;       // 详情编辑模式中的会议 id（null = 新建）

const pad2 = n => String(n).padStart(2, '0');
const fmtDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

// 官方节假日 / 调休映射（preload 注入）
const HOLIDAYS = window.api.holidaysData?.holidays || {};
const WORKDAYS = window.api.holidaysData?.workdays || {};

// 农历节日兜底
const LUNAR_FEST = {
  '1-1': '春节', '1-15': '元宵', '5-5': '端午', '7-7': '七夕',
  '8-15': '中秋', '9-9': '重阳', '12-8': '腊八', '12-23': '小年'
};
function fixedFestival(m, d) {
  if (m === 1 && d === 1) return '元旦';
  if (m === 5 && d === 1) return '劳动节';
  if (m === 10 && d <= 3) return '国庆';
  return '';
}
function hasOfficialData(year) {
  return Object.keys(HOLIDAYS).some(k => k.startsWith(year + '-'));
}

/* ---------------- 初始化 ---------------- */
(async function init() {
  const state = await window.api.loadState();
  settings = state.settings;
  events = state.events;
  people = state.people || [];
  const now = new Date();
  viewYear = now.getFullYear();
  viewMonth = now.getMonth() + 1;
  selectedDate = fmtDate(viewYear, viewMonth, now.getDate());
  fillSettings();
  renderCalendar();
  renderEvents();
  bindGlobal();
  initDock();
})();

/* ---------------- 吸顶胶囊（单窗口 setShape 架构） ---------------- */
function renderPill() {
  const n = new Date();
  $('pill-time').textContent = `${pad2(n.getHours())}:${pad2(n.getMinutes())}`;
  $('pill-sec').textContent = pad2(n.getSeconds());
  $('pill-date').textContent =
    `${n.getFullYear()}年${n.getMonth() + 1}月${n.getDate()}日 周${'日一二三四五六'[n.getDay()]}`;
  const today = fmtDate(n.getFullYear(), n.getMonth() + 1, n.getDate());
  const list = events.filter(e => e.date === today)
    .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  const line = $('pill-meet');
  if (!list.length) {
    line.textContent = '今日无会议';
    line.classList.remove('busy');
    $('pill-count').textContent = '无';
    return;
  }
  const first = list[0];
  const tp = first.start_time ? first.start_time + ' ' : '';   // 无具体时间不显示"时间待定"
  line.textContent = list.length === 1
    ? `${tp}${first.title || '会议'}${first.location ? ' · ' + first.location : ''}`
    : `${tp}${first.title || '会议'} 等 ${list.length} 场`;
  line.classList.add('busy');
  $('pill-count').textContent = list.length + '场';
}

function applyDockState(s) {
  document.body.classList.toggle('docked', !!s.docked);
  document.body.classList.toggle('expanded', !!s.expanded);
  if (s.docked && !s.expanded) renderPill();
}

function initDock() {
  // 1s 轻量刷新：只更新胶囊时钟与当日会议，收起态也保持走时
  renderPill();
  setInterval(renderPill, 1000);

  applyDockState({ docked: !!settings.docked, expanded: false });
  if (window.api.onDockState) window.api.onDockState(applyDockState);

  // 悬停展开/收起：主进程光标轮询为主（拖拽区吞事件兜底），DOM 事件提升响应速度
  document.addEventListener('mouseenter', () => {
    if (document.body.classList.contains('docked')) window.api.dockHover(true);
  });
  document.addEventListener('mouseleave', () => {
    if (document.body.classList.contains('docked')) window.api.dockHover(false);
  });
  let hoverTick = 0;
  document.addEventListener('mousemove', () => {
    if (!document.body.classList.contains('docked')) return;
    const now = Date.now();
    if (now - hoverTick > 300) { hoverTick = now; window.api.dockHover(true); }
  });
  // 按住鼠标拖拽期间也算「正在使用」，拖拽中途不收起
  let holdTick = 0;
  const endHold = () => { clearInterval(holdTick); holdTick = 0; };
  document.addEventListener('pointerdown', () => {
    if (!document.body.classList.contains('docked') || holdTick) return;
    holdTick = setInterval(() => window.api.dockHover(true), 250);
  });
  document.addEventListener('pointerup', endHold);
  document.addEventListener('pointercancel', endHold);
  window.addEventListener('blur', endHold);

  // 输入框打字时保持展开（鼠标可能移开）
  const input = $('msg-input');
  input.addEventListener('focus', () => window.api.dockHover(true));

  // 胶囊右键菜单
  $('pill').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.api.pillMenu();
  });
}

/* ---------------- 万年历渲染 ---------------- */
function renderCalendar() {
  $('cal-year').textContent = viewYear;
  $('cal-month').textContent = viewMonth;

  const first = new Date(viewYear, viewMonth - 1, 1);
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();
  const startWeek = first.getDay();
  const grid = $('cal-grid');
  grid.innerHTML = '';
  const todayStr = fmtDate(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());

  const cells = [];
  for (let i = startWeek - 1; i >= 0; i--) {
    const d = new Date(viewYear, viewMonth - 1, 0 - i);
    cells.push({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), other: true });
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ y: viewYear, m: viewMonth, d, other: false });
  while (cells.length % 7 !== 0) {
    const d = new Date(viewYear, viewMonth, cells.length - startWeek - daysInMonth + 1);
    cells.push({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), other: true });
  }

  for (const c of cells) {
    const ds = fmtDate(c.y, c.m, c.d);
    const dow = new Date(c.y, c.m - 1, c.d).getDay();
    const lunar = window.api.solar2lunar(c.y, c.m, c.d);
    const el = document.createElement('div');
    el.className = 'day';
    if (c.other) el.classList.add('other');
    if (ds === todayStr) el.classList.add('today');
    if (ds === selectedDate) el.classList.add('selected');
    if (dow === 0 || dow === 6) el.classList.add('weekend');

    // 副行：官方节假日名 > 农历节日 > 节气 > 固定节日 > 农历日
    let sub = '', isFestival = false;
    const lunarFest = lunar.festival || LUNAR_FEST[`${lunar.lMonth}-${lunar.lDay}`] || '';
    const term = lunar.term || '';
    const fixed = hasOfficialData(c.y) ? '' : fixedFestival(c.m, c.d);
    if (HOLIDAYS[ds]) { sub = HOLIDAYS[ds]; isFestival = true; el.classList.add('holiday'); }
    else if (fixed) { sub = fixed; isFestival = true; el.classList.add('holiday'); }
    else if (lunarFest && !lunar.isLeap) { sub = lunarFest; isFestival = true; }
    else if (term) { sub = term; isFestival = true; }
    else sub = lunar.dayCn;

    const isWork = !!WORKDAYS[ds];

    const dayEvents = events.filter(e => e.date === ds);
    if (dayEvents.length) el.classList.add('has-event');
    let dots = '';
    if (dayEvents.length) {
      dots = `<span class="event-dots">${dayEvents.slice(0, 3).map(() => '<i></i>').join('')}</span>`;
    }
    el.innerHTML = `
      <span class="solar">${c.d}</span>
      <span class="sub ${isFestival ? 'festival' : ''}">${sub}</span>
      ${isWork ? '<span class="badge-ban">班</span>' : ''}
      ${dots}`;

    el.addEventListener('click', () => {
      selectedDate = ds;
      grid.querySelectorAll('.day.selected').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      renderEvents();
    });
    grid.appendChild(el);
  }
}

/* ---------------- 当日事件列表 ---------------- */
function renderEvents() {
  if (!selectedDate) return;
  const [sy, sm, sd] = selectedDate.split('-').map(Number);
  const lunar = window.api.solar2lunar(sy, sm, sd);
  const wk = '日一二三四五六'[new Date(sy, sm - 1, sd).getDay()];
  $('day-title').innerHTML = `<b>${selectedDate}</b> 周${wk} · 农历${lunar.monthCn}${lunar.dayCn}` +
    (HOLIDAYS[selectedDate] ? ` · <b style="color:var(--red)">${HOLIDAYS[selectedDate]}</b>` : '');

  const list = events.filter(e => e.date === selectedDate).sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  const box = $('event-list');
  if (!list.length) {
    box.innerHTML = '<div class="empty-day">这一天暂无会议 · 把通知粘贴到下方输入框试试</div>';
    return;
  }
  box.innerHTML = list.map(e => {
    // 没填具体时分的会议（只到日期或上午/下午）不显示"时间待定"，时间行整段省略
    const meta = [];
    if (e.start_time) meta.push(e.start_time + (e.end_time ? ' - ' + e.end_time : ''));
    if (e.location) meta.push(e.location);
    return `
    <div class="event-card" data-id="${e.id}" title="点击查看会议详情">
      <div class="e-title">${esc(e.title || '会议')}</div>
      ${meta.length ? `<div class="e-meta">${esc(meta.join(' · '))}</div>` : ''}
      ${e.attendees && e.attendees.length ? `<div class="e-people">👥 ${esc(e.attendees.join('、'))}</div>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => {
      const e = events.find(x => x.id === card.dataset.id);
      if (e) openEventDetail(e);
    });
  });
}

/* ---------------- 全局绑定 ---------------- */
function bindGlobal() {
  $('btn-hide').onclick = () => window.api.hideWin();
  $('btn-min').onclick = () => {
    // 吸顶展开态不占任务栏，最小化会"丢窗" → 收起回胶囊；自由态正常最小化
    if (document.body.classList.contains('docked')) window.api.dockPill();
    else window.api.minWin();
  };
  $('btn-mini').onclick = async () => {
    await window.api.dockPill();
    toast('已收起为吸顶小窗 · 悬停小窗即可展开');
  };
  // 会议数据变化时同步（其他入口改动）
  window.api.onEventsUpdated(list => {
    events = list || [];
    renderCalendar();
    renderEvents();
    renderPill();
  });
  $('prev-month').onclick = () => { viewMonth--; if (viewMonth < 1) { viewMonth = 12; viewYear--; } renderCalendar(); };
  $('next-month').onclick = () => { viewMonth++; if (viewMonth > 12) { viewMonth = 1; viewYear++; } renderCalendar(); };
  $('btn-today').onclick = () => {
    const n = new Date();
    viewYear = n.getFullYear(); viewMonth = n.getMonth() + 1;
    selectedDate = fmtDate(viewYear, viewMonth, n.getDate());
    renderCalendar(); renderEvents();
  };

  // 附件 / 截屏
  $('btn-attach').onclick = async () => {
    const img = await window.api.pickImage();
    if (img) setPreview(img);
  };
  $('btn-shot').onclick = captureScreen;

  // 粘贴截图
  document.addEventListener('paste', ev => {
    for (const item of ev.clipboardData?.items || []) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        const r = new FileReader();
        r.onload = () => setPreview(r.result);
        r.readAsDataURL(f);
        ev.preventDefault();
        return;
      }
    }
  });

  const input = $('msg-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(62, input.scrollHeight) + 'px';
  });

  $('btn-ai').onclick = runAI;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runAI();
  });

  // 设置面板
  $('btn-settings').onclick = () => { fillSettings(); renderPeopleEdit(); showPanel('settings-panel'); };
  $('key-eye').onclick = () => {
    const k = $('set-apikey');
    k.type = k.type === 'password' ? 'text' : 'password';
  };
  $('btn-save-settings').onclick = saveSettings;
  $('btn-test').onclick = testConnection;
  $('btn-check-update').onclick = async () => {
    const r = $('test-result');
    r.textContent = '正在检查更新…';
    const res = await window.api.checkUpdate();
    r.textContent = res.msg || (res.ok ? '正在检查…' : '检查失败');
  };
  window.api.onUpdateStatus(msg => { $('test-result').textContent = msg; });

  // 人员录入
  $('btn-add-people').onclick = addPerson;
  $('people-input').addEventListener('keydown', e => { if (e.key === 'Enter') addPerson(); });

  // 确认面板
  $('btn-cancel-meeting').onclick = () => hideOverlay();
  $('btn-save-meeting').onclick = saveMeeting;
  $('btn-delete-meeting').onclick = deleteMeeting;
  $('cf-people-add').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      if (!v) return;
      // 输入过的人自动记忆到人员库，下次直接勾选
      if (!people.some(p => p.name === v)) { people.push({ name: v }); window.api.savePeople(people); }
      // 保留当前勾选状态，并把新输入的人自动打勾
      const checked = [...$('cf-people').querySelectorAll('.chip.on')].map(c => c.dataset.name);
      renderCfPeople([v]);
      markCfPeopleChecked([...checked, v]);
      e.target.value = '';
    }
  });
  document.querySelectorAll('.panel-close').forEach(b => { b.onclick = () => hideOverlay(); });
}

/* ---------------- 截屏（区域选择） ---------------- */
async function captureScreen() {
  toast('请拖动鼠标框选要识别的区域…');
  const img = await window.api.captureScreen();
  if (img) {
    setPreview(img);
    toast('已截取选区，点“AI识别”开始提取');
  }
}

/* ---------------- 输入 / AI ---------------- */
function setPreview(dataUrl) {
  pendingImage = dataUrl;
  $('preview-img').src = dataUrl;
  $('img-preview').classList.remove('hidden');
}
$('preview-clear').onclick = () => {
  pendingImage = null;
  $('img-preview').classList.add('hidden');
};

async function runAI() {
  const text = $('msg-input').value.trim();
  let img = pendingImage;
  if (!img && !text) {
    img = await window.api.readClipboardImage();
    if (img) setPreview(img);
  }
  if (!text && !img) { toast('先粘贴通知文字、截图，或点相机按钮截屏'); return; }

  const hasModel = settings.apiKey && settings.baseUrl;
  if (!hasModel && !text) {
    // 只有图片且没配模型：图片识别必须有视觉模型，引导配置（纯文字无需 Key）
    fillSettings(); renderPeopleEdit(); showPanel('settings-panel');
    $('test-result').textContent = '图片识别需要 AI 模型：请填写接口地址和 API Key。纯文字通知无需 Key，直接点“AI识别”即可本地解析';
    return;
  }

  const btn = $('btn-ai');
  btn.disabled = true;
  const st = $('ai-status');
  st.classList.remove('hidden', 'err');
  st.textContent = hasModel ? 'AI 正在阅读通知…' : '正在本地解析（无需 Key）…';

  const r = await window.api.aiExtract({ text, imageDataUrl: img, settings });
  btn.disabled = false;
  st.textContent = '';

  if (!r.ok) {
    st.classList.add('err');
    st.textContent = r.error;
    return;
  }
  st.textContent = r.local ? '本地解析完成 · 结果仅供参考，请核对' : '识别完成';
  setTimeout(() => st.classList.add('hidden'), 2600);
  fillConfirm(r.meeting);
  if (settings.autoWrite) { saveMeeting(); }
  else showPanel('confirm-panel');
}

/* ---------------- 人员管理 ---------------- */
function addPerson() {
  const v = $('people-input').value.trim();
  if (!v) return;
  if (!people.some(p => p.name === v)) {
    people.push({ name: v });
    window.api.savePeople(people);
  }
  $('people-input').value = '';
  renderPeopleEdit();
}

function renderPeopleEdit() {
  const box = $('people-list');
  if (!people.length) {
    box.innerHTML = '<div class="hint">还没有录入人员，先添加常用参会人</div>';
    return;
  }
  box.innerHTML = people.map((p, i) => `
    <span class="chip">${esc(p.name)}<span class="del" data-i="${i}" title="删除">×</span></span>
  `).join('');
  box.querySelectorAll('.del').forEach(d => {
    d.onclick = () => {
      people.splice(+d.dataset.i, 1);
      window.api.savePeople(people);
      renderPeopleEdit();
    };
  });
}

// 确认面板：人员勾选（AI 识别到的人自动选中并临时并入名单）
function renderCfPeople(extraNames = []) {
  const names = [];
  // 先保留当前已展示的（含 AI 提取的临时参会人），再并入人员库与新名单
  $('cf-people').querySelectorAll('.chip').forEach(c => names.push(c.dataset.name));
  people.forEach(p => { if (!names.includes(p.name)) names.push(p.name); });
  extraNames.forEach(n => { if (n && !names.includes(n)) names.push(n); });
  const box = $('cf-people');
  box.innerHTML = names.map(n => `
    <span class="chip" data-name="${esc(n)}">
      <span class="tick">✓</span>${esc(n)}
    </span>
  `).join('');
  box.querySelectorAll('.chip').forEach(chip => {
    chip.onclick = () => {
      chip.classList.toggle('on');
      if (chip.classList.contains('on')) chip.querySelector('.tick').textContent = '✓';
      else chip.querySelector('.tick').textContent = '';
    };
  });
  return box;
}

function markCfPeopleChecked(names) {
  const box = $('cf-people');
  box.querySelectorAll('.chip').forEach(chip => {
    const n = chip.dataset.name;
    const on = names.some(x => n === x || (n.length >= 2 && x.length >= 2 && (n.includes(x) || x.includes(n))));
    chip.classList.toggle('on', on);
    chip.querySelector('.tick').textContent = on ? '✓' : '';
  });
}

/* ---------------- 确认卡片 / 会议详情 ---------------- */
function fillConfirm(m) {
  editingId = null;
  $('cf-head-title').textContent = 'AI 识别结果';
  $('btn-delete-meeting').classList.add('hidden');
  $('btn-save-meeting').textContent = '写入日历';
  $('btn-cancel-meeting').textContent = '忽略';
  $('cf-title').value = m.title && m.title !== 'null' ? m.title : '';
  $('cf-date').value = m.date && m.date !== 'null' ? m.date : selectedDate;
  $('cf-start').value = m.start_time && m.start_time !== 'null' ? m.start_time : '';
  $('cf-end').value = m.end_time && m.end_time !== 'null' ? m.end_time : '';
  $('cf-location').value = m.location && m.location !== 'null' ? m.location : '';
  $('cf-notes').value = m.notes && m.notes !== 'null' ? m.notes : '';
  const extracted = Array.isArray(m.attendees) ? m.attendees.filter(a => a && a !== 'null') : [];
  renderCfPeople(extracted);
  markCfPeopleChecked(extracted);
}

// 点击会议卡片 -> 详情（可修改/删除）
function openEventDetail(e) {
  editingId = e.id;
  $('cf-head-title').textContent = '会议详情';
  $('btn-delete-meeting').classList.remove('hidden');
  $('btn-save-meeting').textContent = '保存修改';
  $('btn-cancel-meeting').textContent = '关闭';
  $('cf-title').value = e.title || '';
  $('cf-date').value = e.date || '';
  $('cf-start').value = e.start_time || '';
  $('cf-end').value = e.end_time || '';
  $('cf-location').value = e.location || '';
  $('cf-notes').value = e.notes || '';
  renderCfPeople(e.attendees || []);
  markCfPeopleChecked(e.attendees || []);
  showPanel('confirm-panel');
}

async function deleteMeeting() {
  if (!editingId) return;
  events = events.filter(x => x.id !== editingId);
  await window.api.saveEvents(events);
  hideOverlay();
  renderCalendar(); renderEvents();
  toast('已删除该会议');
}

async function saveMeeting() {
  const attendees = [...$('cf-people').querySelectorAll('.chip.on')]
    .map(chip => chip.dataset.name);
  const meeting = {
    id: editingId || Date.now().toString(36),
    title: $('cf-title').value.trim() || '会议',
    date: $('cf-date').value,
    start_time: $('cf-start').value || null,
    end_time: $('cf-end').value || null,
    location: $('cf-location').value.trim() || null,
    attendees,
    notes: $('cf-notes').value.trim() || null
  };
  if (!meeting.date) { toast('请填写会议日期'); return; }
  if (editingId) {
    // 详情编辑：更新原会议，不重复生成 .ics
    events = events.map(x => x.id === editingId ? meeting : x);
  } else {
    events.push(meeting);
    await window.api.saveIcs(meeting);   // 生成 .ics 并打开，导入系统日历
  }
  await window.api.saveEvents(events);
  // 勾选过的新人自动录入人员库
  let changed = false;
  attendees.forEach(n => { if (!people.some(p => p.name === n)) { people.push({ name: n }); changed = true; } });
  if (changed) await window.api.savePeople(people);

  selectedDate = meeting.date;
  $('msg-input').value = '';
  $('msg-input').style.height = 'auto';
  pendingImage = null;
  $('img-preview').classList.add('hidden');
  const wasEdit = !!editingId;
  editingId = null;
  hideOverlay();
  const [y, m] = meeting.date.split('-').map(Number);
  viewYear = y; viewMonth = m;
  renderCalendar(); renderEvents();
  toast(wasEdit ? '修改已保存' : '已写入日历 ✓（.ics 已生成并在文件夹中显示，双击可导入系统日历）');
}

/* ---------------- 设置 ---------------- */
function fillSettings() {
  $('set-baseurl').value = settings.baseUrl || '';
  $('set-model').value = settings.model || '';
  $('set-apikey').value = settings.apiKey || '';
  $('set-style').value = settings.style ?? 0.2;
  $('set-autowrite').checked = !!settings.autoWrite;
  $('set-autoopenics').checked = !!settings.autoOpenIcs;
  $('set-autostart').checked = !!settings.autoStart;
  $('set-alwaysontop').checked = !!settings.alwaysOnTop;
  $('set-updateurl').value = settings.updateUrl || '';
}

async function saveSettings() {
  settings = {
    ...settings,
    baseUrl: $('set-baseurl').value.trim(),
    model: $('set-model').value.trim(),
    apiKey: $('set-apikey').value.trim(),
    style: parseFloat($('set-style').value),
    autoWrite: $('set-autowrite').checked,
    autoOpenIcs: $('set-autoopenics').checked,
    autoStart: $('set-autostart').checked,
    alwaysOnTop: $('set-alwaysontop').checked,
    updateUrl: $('set-updateurl').value.trim()
  };
  await window.api.saveSettings(settings);
  hideOverlay();
  toast('设置已保存');
}

async function testConnection() {
  const s = {
    baseUrl: $('set-baseurl').value.trim(),
    model: $('set-model').value.trim(),
    apiKey: $('set-apikey').value.trim()
  };
  const r = $('test-result');
  r.textContent = '正在测试…';
  const res = await window.api.testConnection(s);
  r.textContent = res.ok ? `连接成功 ✓ 模型回复：${res.reply}` : `连接失败：${res.error}`;
}

/* ---------------- 工具 ---------------- */
function showPanel(id) {
  $('overlay').classList.remove('hidden');
  ['settings-panel', 'confirm-panel'].forEach(p => $(p).classList.toggle('hidden', p !== id));
  window.api.setHoverLock(true);   // 面板打开时禁止悬停收起
}
function hideOverlay() {
  $('overlay').classList.add('hidden');
  window.api.setHoverLock(false);
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
