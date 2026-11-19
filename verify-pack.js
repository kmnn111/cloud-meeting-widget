/* 打包产物完整性校验（v1.3.1）
   教训：v1.3.0 新增 history-data.js 后忘了加进 package.json 的 build.files 白名单，
   打包后 preload 的 require 直接抛错 → window.api 缺失 → 整个界面空白。
   开发态永远测不出来，只有安装后才炸。此脚本在打包后运行：
   1) 扫描源码中所有相对 require（./xxx）与 files 白名单比对，漏配直接报错；
   2) 解开 app.asar 清单，确认这些模块真的在包里；
   3) 确认作为入口的 main.js / preload.js 均存在。
   用法：node verify-pack.js   （npm run dist 结束自动执行） */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const pkg = require('./package.json');
const asar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');

let failed = false;
const fail = (msg) => { failed = true; console.error('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

if (!fs.existsSync(asar)) {
  console.error('[verify-pack] 找不到 app.asar，请先执行打包');
  process.exit(1);
}

// 1) 找出会被打进包里的源文件（按 files 白名单的根级 js 判断，renderer 单独处理）
const rootJs = fs.readdirSync(root).filter(f => f.endsWith('.js')
  && !f.startsWith('test-') && f !== 'verify-pack.js' && f !== 'clean-dist.js');

// 2) 收集这些文件里的相对 require（只关心本地模块，忽略 node_modules 包名）
const localReqs = new Map(); // target -> Set(from)
for (const f of rootJs) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    let target = m[1].replace(/^\.\//, '');
    if (!target.endsWith('.js')) target += '.js';
    if (!localReqs.has(target)) localReqs.set(target, new Set());
    localReqs.get(target).add(f);
  }
}

console.log('[verify-pack] 检查本地模块依赖是否都进了包：');
const files = pkg.build.files;
for (const [target, from] of localReqs) {
  const inWhitelist = files.some(p =>
    p === target || p === '**/*' ||
    (p.endsWith('/**/*') && target.startsWith(p.slice(0, -5))));
  if (!inWhitelist) {
    fail(`${target} 被 ${[...from].join(', ')} 引用，但未列入 build.files 白名单`);
  } else {
    ok(`${target} 已在白名单（被 ${[...from].join(', ')} 引用）`);
  }
}

// 3) 解开 asar 清单逐项确认（白名单对了也可能被 ignore 规则误伤）
let listing = '';
try {
  const asarCli = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'asar.cmd' : 'asar');
  listing = execFileSync(asarCli, ['list', asar], { encoding: 'utf8', shell: process.platform === 'win32' });
} catch (e) {
  console.warn('[verify-pack] 无法列出 asar 内容（跳过硬校验）:', e.message);
}

if (listing) {
  console.log('[verify-pack] 检查 asar 实际内容：');
  const mustHave = ['main.js', 'preload.js', ...localReqs.keys()];
  for (const f of [...new Set(mustHave)]) {
    // asar 清单是反斜杠开头的 Windows 风格路径
    const present = listing.split(/\r?\n/).some(l => l.replace(/^[\\/]+/, '') === f);
    if (present) ok(`${f} 已在 asar 内`);
    else fail(`${f} 不在 asar 内（安装后必然报错）`);
  }
  // 渲染层入口
  for (const f of ['renderer/index.html', 'renderer/app.js', 'renderer/style.css']) {
    const present = listing.split(/\r?\n/).some(l => l.replace(/^[\\/]+/, '').replace(/\\/g, '/') === f);
    if (present) ok(`${f} 已在 asar 内`);
    else fail(`${f} 不在 asar 内`);
  }
}

// 4) preload 必须能被 require（语法错/路径错同样导致 window.api 消失）
try {
  const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  new (require('vm').Script)(preloadSrc, { filename: 'preload.js' });
  ok('preload.js 语法可解析');
} catch (e) {
  fail('preload.js 无法解析: ' + e.message);
}

if (failed) {
  console.error('\n[verify-pack] 校验未通过：打包产物不完整，禁止发布。');
  process.exit(1);
}
console.log('\n[verify-pack] 全部通过 ✓ 产物可用于发布');