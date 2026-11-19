/* 截图选区逻辑（独立文件，CSP default-src 'self' 下内联脚本会被拒绝执行） */
'use strict';

const img = document.getElementById('shot');
const sel = document.getElementById('sel');
const tip = document.getElementById('tip');
let sx = 0, sy = 0, dragging = false, rect = null, ready = false;

// 主进程就绪握手：注册好监听再要预览路径，杜绝消息竞态
window.cap.onShotPath(p => {
  ready = true;
  tip.textContent = '拖动鼠标框选截图区域 · Esc 取消';
  // 用 pathToFileURL 语义拼 file://（不能直接字符串拼，中文/空格路径会失效）
  img.src = 'file:///' + String(p).replace(/\\/g, '/')
    .split('/').map(x => encodeURIComponent(x)).join('/').replace(/^file%3A%2F%2F%2F/i, 'file:///');
});
img.onerror = () => {
  tip.textContent = '截图预览加载失败 · 按 Esc 退出后重试';
};
window.cap.ready();

function update(x, y) {
  const l = Math.min(sx, x), t = Math.min(sy, y);
  const w = Math.abs(x - sx), h = Math.abs(y - sy);
  sel.style.left = l + 'px';
  sel.style.top = t + 'px';
  sel.style.width = w + 'px';
  sel.style.height = h + 'px';
  sel.querySelector('.size').textContent = Math.round(w) + ' × ' + Math.round(h);
}

document.addEventListener('mousedown', e => {
  if (e.target.closest('#hint-bar')) return;
  dragging = true;
  sx = e.clientX; sy = e.clientY;
  sel.style.display = 'block';
  tip.style.display = 'none';
  update(e.clientX, e.clientY);
});

document.addEventListener('mousemove', e => {
  if (dragging) update(e.clientX, e.clientY);
});

document.addEventListener('mouseup', e => {
  if (!dragging) return;
  dragging = false;
  update(e.clientX, e.clientY);
  const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
  if (w < 6 && h < 6) {          // 点击（非拖动）视为全屏
    rect = null;
    sel.style.display = 'none';
    window.cap.done(null);
    return;
  }
  rect = {
    x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY),
    w, h
  };
});

// 只回传选区矩形（几个数字），裁剪由主进程 nativeImage.crop 完成
function finishCrop() {
  if (!rect) { window.cap.done(null); return; }
  window.cap.done(rect);
}

document.getElementById('btn-ok').onclick = finishCrop;
document.getElementById('btn-full').onclick = () => { rect = null; sel.style.display = 'none'; window.cap.done(null); };
document.getElementById('btn-cancel').onclick = () => window.cap.cancel();
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.cap.cancel();
  if (e.key === 'Enter') finishCrop();
});
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('dragstart', e => e.preventDefault());