/* v1.2.4 改期匹配单测：从 app.js 抽真实函数跑用例 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'renderer', 'app.js'), 'utf8');

// 抽取 normTitle ~ isSameMeeting 段（renderDupBox 之前的纯函数区）
const seg = src.slice(src.indexOf('function normTitle'), src.indexOf('function renderDupBox'));
const mod = {};
new Function('exports', seg + '\nexports.normTitle = normTitle; exports.isSameMeeting = isSameMeeting; exports.GENERIC_TITLES = GENERIC_TITLES;')(mod);

const { normTitle, isSameMeeting } = mod;
let pass = 0, fail = 0;
function t(a, b, expect) {
  const got = isSameMeeting(a, b);
  const ok = got === expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  isSameMeeting(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got} (expect ${expect})`);
}

// 同名精确匹配
t('项目推进会', '项目推进会', true);
t('项目推进会', '项目推进会 ', true);
// 通知壳剥离（AI 识别标题常带“关于…的通知”）
t('关于召开项目推进会的通知', '项目推进会', true);
t('关于安全生产工作会议的通知', '安全生产工作会议', true);
// 大小写 / 标点 / 空白
t('Q3 经营分析会', 'q3经营分析会', true);
t('《年度总结》会议', '年度总结会议', true);
// 包含关系（长短标题）
t('第三季度安全生产工作会议', '安全生产工作会议', true);
// 不同会议不误伤
t('项目推进会', '预算评审会', false);
t('安全生产工作会议', '安全生产会议', false);   // 中间多“工作”两字 → 不同会议
// 通用空壳标题不参与匹配（防误删）
t('会议', '项目推进会', false);
t('会议通知', '项目推进会', false);
t('会议', '会议', false);
// 周例会：允许提示（由默认勾选规则控制保留），仅验证匹配行为
t('周例会', '周例会', true);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
