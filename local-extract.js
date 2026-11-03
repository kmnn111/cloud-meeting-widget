'use strict';
/**
 * 免 Key 本地解析：从中文会议通知文本中规则提取会议信息。
 * 供未配置 AI 模型的用户使用（无需联网、零成本），尽力而为，
 * 识别不到的字段填 null，输出结构与 AI 提取完全一致。
 */
const WEEK = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 };
const pad2 = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function parseDate(text, now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rel = { '今天': 0, '今日': 0, '明天': 1, '明日': 1, '后天': 2, '大后天': 3 };
  for (const [k, v] of Object.entries(rel)) {
    if (text.includes(k)) return fmtDate(new Date(base.getTime() + v * 86400000));
  }
  // YYYY年X月X日 / X月X日 / X月X号 / X-X / X.X
  let m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`;
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    let y = now.getFullYear();
    if (+m[1] < now.getMonth() + 1) y++; // 已过去的月份按明年
    return `${y}-${pad2(+m[1])}-${pad2(+m[2])}`;
  }
  m = text.match(/(?:^|[^\d])(\d{1,2})[-\.\/](\d{1,2})(?!\d)/);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] <= 31) {
    let y = now.getFullYear();
    if (+m[1] < now.getMonth() + 1) y++;
    return `${y}-${pad2(+m[1])}-${pad2(+m[2])}`;
  }
  // 周X/星期X/礼拜X（含下周/本周/下下周）
  const wk = text.match(/(下{1,2}周|本{0,1}周|下{1,2}星期|本{0,1}星期|礼拜)([日天一二三四五六])/);
  if (wk) {
    const target = WEEK[wk[2]];
    const cur = now.getDay();
    let delta = (target - cur + 7) % 7;
    if (wk[1].startsWith('下')) delta += 7;
    else if (wk[1].startsWith('本') && delta === 0) delta = 0; // 本周日等
    else if (!wk[1].startsWith('下') && delta === 0) delta = 7; // "周X"指未来最近一次
    return fmtDate(new Date(base.getTime() + delta * 86400000));
  }
  return null;
}

function parseTime(text) {
  // 9:00-11:30 / 9：00～11：30 / 下午2点到4点
  let m = text.match(/(上午|早上|中午|下午|晚上)?\s*(\d{1,2})[:：点时](\d{2})?(分|半)?\s*[-–—~～至到]\s*(\d{1,2})[:：点时](\d{2})?(分|半)?/);
  const toHHMM = (h, mi) => `${pad2(Math.min(23, +h))}:${pad2(mi ? +mi : 0)}`;
  if (m) {
    let h1 = +m[2], h2 = +m[5];
    const mi1 = m[4] === '半' ? 30 : (m[3] ? +m[3] : 0);
    const mi2 = m[7] === '半' ? 30 : (m[6] ? +m[6] : 0);
    const period = m[1] || '';
    if ((period === '下午' || period === '晚上') && h1 < 12) h1 += 12;
    if (period === '中午' && h1 < 11) h1 += 12;
    if (h2 < h1) h2 += 12; // "下午2点到4点" → 14:00-16:00
    return { start_time: toHHMM(h1, mi1), end_time: toHHMM(h2, mi2) };
  }
  // 单个时刻：14:30 / 14点30分 / 14点半 / 下午2点
  m = text.match(/(上午|早上|中午|下午|晚上)?\s*(\d{1,2})[:：点时](\d{2})?(分|半)?/);
  if (m) {
    let h = +m[2];
    const mi = m[4] === '半' ? 30 : (m[3] ? +m[3] : 0);
    const period = m[1] || '';
    if ((period === '下午' || period === '晚上') && h < 12) h += 12;
    if (period === '中午' && h < 11) h += 12;
    if (h <= 23) return { start_time: `${pad2(h)}:${pad2(mi)}`, end_time: null };
  }
  return { start_time: null, end_time: null };
}

function parseVagueTime(text) {
  for (const k of ['上午', '早上', '中午', '下午', '晚上', '晚间', '全天', '全天']) {
    if (text.includes(k)) return k;
  }
  return null;
}

function parseTitle(text, lines) {
  const key = /(会议|大会|座谈会|研讨会|培训|动员|部署|推进|协调|通报|评审|答辩|例会|活动|仪式|宣讲|讲座|论坛|视频会|电话会)/;
  const generic = /^[\s关于的]*(会议|大会)[\s通知公告方案安排]*$/; // "会议通知""会议"等空壳
  const specific = /(部署|推进|评审|答辩|培训|动员|协调|通报|座谈|研讨|宣讲|讲座|论坛|例会|启动|总结|表彰|交流|洽谈|签约|开幕|闭幕)/;
  // 去掉标题前的日期/时间词："下周三评审会"→"评审会"，"下午2点到4点开项目推进会"→"项目推进会"
  const stripLead = s => {
    let x = s
      .replace(/^(今|明|后|大后)(天|日)\s*/, '')
      .replace(/^下{1,2}(周|星期|礼拜)[一二三四五六日天]\s*/, '')
      .replace(/^(本|这)(周|星期)[一二三四五六日天]?\s*/, '')
      .replace(/^\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]?\s*/, '')
      .replace(/^\d{1,2}\s*月\s*\d{1,2}\s*[日号]?\s*/, '')
      .replace(/^\d{1,2}[-\.\/]\d{1,2}\s*/, '')
      .replace(/^((上午|早上|中午|下午|晚上)\s*)?\d{1,2}\s*[:：点时]\s*\d{0,2}\s*(分|半)?\s*(?:[-–—~～至到]\s*\d{1,2}\s*[:：点时]\s*\d{0,2}\s*(?:分|半)?)?\s*/, '')
      .replace(/^(上午|早上|中午|下午|晚上)\s*/, '')
      .replace(/^(召开|举办|举行|组织)\s*/, '');
    // "开项目推进会"→"项目推进会"（仅动词用法，"开工仪式/开题答辩"不动）
    if (/^开(项目|专题|现场|座谈|研讨|评审|推进|部署|协调|总结|动员|通报|例会|大会|会议|培训|论坛|讲座)/.test(x)) x = x.slice(1);
    return x;
  };
  const cands = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s || !key.test(s)) continue;
    // 取含会议关键词的短句：去掉"关于…的通知"等外壳
    let t = s
      .replace(/^关于\s*/, '')
      .replace(/的?(通知|公告|方案|安排)$/, '')
      .replace(/^(召开|举办|举行|组织)\s*/, '')
      .replace(/[：:，,。]+$/, '')
      .trim();
    t = stripLead(t); // 先剥日期/时间，避免"9:00-11:30"里的冒号干扰分段
    const seg = t.split(/[，,。；;：:]/).find(p => key.test(p) && p.length >= 3) || t;
    const c = seg.trim();
    if (c.length >= 2 && !generic.test(c)) cands.push(c.slice(0, 40));
  }
  if (cands.length) {
    // 优先"部署/评审…"类具体标题；同类取最长（信息最全）
    const spec = cands.filter(c => specific.test(c));
    const pool = spec.length ? spec : cands;
    return pool.sort((a, b) => b.length - a.length)[0];
  }
  // 兜底：第一行非空文本（跳过"会议通知"空壳）
  const first = lines.find(l => {
    const s = stripLead(l.trim()).replace(/的?(通知|公告)$/, '');
    return s.length >= 2 && !generic.test(s);
  });
  return first ? stripLead(first.trim()).replace(/的?(通知|公告)$/, '').slice(0, 40) : null;
}

function parseLocation(text) {
  // 去掉"在/位于/于"前缀："在501会议室" → "501会议室"
  const strip = s => s.replace(/^[在于位于]+/, '').trim();
  let m = text.match(/(?:地点|会议地点|会场|地址)\s*[：:]\s*([^\s，,。；;]{2,30})/);
  if (m) return strip(m[1]);
  m = text.match(/(?:位于|在)\s*([^\s，,。；;]{2,20}?(?:会议室|会议厅|大厅|报告厅|中心|大楼|会议室\d+|楼|党校|酒店))\s*(?:召开|举行|进行|开)/);
  if (m) return strip(m[1]);
  m = text.match(/([^\s，,。；;]{2,20}?(?:号?会议室|会议厅|报告厅|多功能厅))/);
  return m ? strip(m[1]) : null;
}

function parseAttendees(text) {
  const names = [];
  const addOne = x => {
    const n = x.replace(/(同志|先生|女士|老师|各位|等|及相关人员)$/g, '').trim();
    if (n && n.length >= 2 && n.length <= 4 && /^[\u4e00-\u9fa5A-Za-z·]+$/.test(n)) names.push(n);
  };
  const add = raw => {
    raw.split(/[、，,／/\s]+/).forEach(x => {
      // "老王和小李" → 按连接词"和"拆分（仅短片段，避免拆散机构名）
      if (x.length <= 7 && x.includes('和')) x.split('和').forEach(addOne);
      else addOne(x);
    });
  };
  let m = text.match(/(?:参加人员|参会人员|出席人员|参会人|参加人|出席|与会人员)\s*[：:]\s*([^\n。；;]{2,80})/);
  if (m) add(m[1]);
  m = text.match(/请\s*([^\s，,。；;]{2,40}?)\s*(?:参加|出席|参会|与会)/);
  if (m) add(m[1]);
  return [...new Set(names)].slice(0, 12);
}

function localExtract(text, now = new Date()) {
  const clean = String(text || '').replace(/\r/g, '');
  const lines = clean.split('\n').filter(l => l.trim());
  const whole = lines.join(' ');
  const t = parseTime(whole);
  const vague = parseVagueTime(whole);
  const notes = [];
  if (!t.start_time && vague && vague !== '全天') notes.push(vague);
  const m = text.match(/(?:备注|说明|注)\s*[：:]\s*([^\n]{2,60})/);
  if (m) notes.push(m[1].trim());
  return {
    title: parseTitle(whole, lines),
    date: parseDate(whole, now),
    start_time: t.start_time,
    end_time: t.end_time,
    location: parseLocation(whole),
    attendees: parseAttendees(whole),
    notes: notes.length ? notes.join('；') : null,
    local: true   // 标记：本地规则解析结果
  };
}

module.exports = { localExtract };
