/* history-data 小窗适配单测：联网条目长度优选 + 内置/兜底路径
   背景：小窗只有两行可显示空间（约 42 字），联网接口常返回 60+ 字长条目，
   直接 slice(0,60) 会溢出被裁。getToday 应优先挑「长度能完整显示」的条目。 */
const h = require('./history-data');

let pass = 0, fail = 0;
function t(name, actual, expect) {
  const ok = typeof expect === 'function' ? expect(actual) : actual === expect;
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '→ 实际:', JSON.stringify(actual)); }
}

console.log('[history-data 小窗适配测试]');

const LONG = '1954年9月20日 第一届全国人民代表大会第一次会议一致通过《中华人民共和国宪法》，这是新中国第一部社会主义类型的宪法，具有里程碑意义';
const SHORT = '1929年 古田会议确立思想建党、政治建军原则';
const MED = '1935年 遵义会议实现党的历史上生死攸关的转折';

// 1) 长条目不会被原样返回（必须被优选或截断到可显示长度）
const longOnly = h.getToday(new Date('2026-01-15'), [LONG]);
t('超长联网条目已裁剪至可显示长度', longOnly.title.length, v => v <= 43);
t('超长条目来源仍标记 online', longOnly.source, 'online');

// 2) 混合列表优先挑能完整显示且命中会议关键词的条目
const mixed = h.getToday(new Date('2026-01-15'), [LONG, SHORT, MED, '今天是世界读书日，各地举办阅读推广活动']);
t('混合列表选中长度合适的会议条目', mixed.title, v => v.length <= 43 && /会议|大会|全会/.test(v));

// 3) 无会议关键词但长度合适 → 仍选长度合适的
const noKw = h.getToday(new Date('2026-01-15'), [LONG, '某地举办群众文化活动']);
t('无关键词时取可完整显示条目', noKw.title, v => v.length <= 43);

// 4) 极短垃圾条目不应被选中（<10 字无信息量）
const junk = h.getToday(new Date('2026-01-15'), ['无', LONG, MED]);
t('过短条目被跳过', junk.title, v => v.length >= 10);

// 5) 内置数据集条目不超两行可显示上限
let maxBuiltin = 0;
for (const k in h.BY_DATE) maxBuiltin = Math.max(maxBuiltin, h.BY_DATE[k].length);
t('内置条目最长 ' + maxBuiltin + ' 字，两行可完整显示', maxBuiltin, v => v <= 44);

// 6) 兜底池同样检查
const maxFallback = Math.max(...h.FALLBACK_POOL.map(s => s.length));
t('兜底池最长 ' + maxFallback + ' 字', maxFallback, v => v <= 44);

// 7) 无联网数据时走内置
const builtin = h.getToday(new Date('2026-12-28'), null);
t('无联网数据走内置', builtin.source, 'builtin');
t('内置标题含古田会议', builtin.title, v => v.includes('古田会议'));

// 8) 联网传空数组 → 不该崩，应回退内置
const emptyOnline = h.getToday(new Date('2026-12-28'), []);
t('空联网数组回退内置', emptyOnline.source, 'builtin');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);