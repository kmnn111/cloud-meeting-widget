/* local-extract 回归 + 单位名提取单测 */
const { localExtract } = require('./local-extract');
let pass = 0, fail = 0;
function t(name, got, expect) {
  const ok = typeof expect === 'function' ? expect(got) : got === expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  => ${JSON.stringify(got)}${ok ? '' : ' (expect ' + expect + ')'}`);
}

// —— 回归：既有 6 组场景 ——
// 1) 完整提取
let r = localExtract('关于召开项目推进会的通知\n时间：11月20日 9:00-11:30\n地点：一楼会议室\n参会人员：张三、李四、王五');
t('完整标题', r.title, '项目推进会');
t('完整日期', r.date, v => /^\d{4}-11-20$/.test(v));
t('完整时间', r.start_time + '-' + r.end_time, '09:00-11:30');
t('完整地点', r.location, '一楼会议室');
t('完整参会人', r.attendees.join(','), '张三,李四,王五');

// 2) 无具体时间 → start_time null，时段进 notes
r = localExtract('明天上午召开安全生产专题会议\n地点：三号会议室');
t('无时间日期', r.date, v => !!v);
t('无时间 start', r.start_time, null);
t('无时间备注含时段', r.notes, v => v === null || v.includes('上午'));

// 3) 时间范围"下午2点到4点"
r = localExtract('11月21日下午2点到4点召开经济运行分析会');
t('下午时段', r.start_time + '-' + r.end_time, '14:00-16:00');

// 4) 标题地点人名
r = localExtract('召开第三季度安全生产工作会议，地点在501会议室，请老王和小李参加');
t('含动词标题', r.title, v => v.includes('安全生产工作会议'));
t('在地点', r.location, '501会议室');
t('和拆人名', r.attendees.sort().join(','), '小李,老王');

// 5) 纯数字时间段不切碎标题
r = localExtract('9:00-11:30 召开安全生产工作会议');
t('纯数字时段', r.start_time + '-' + r.end_time, '09:00-11:30');
t('纯数字时段标题', r.title, v => !/^\d+$/.test(v) && v.includes('安全生产工作会议'));

// 6) 开工仪式不误伤（动词"开"剥离不能吃掉"开工"）
r = localExtract('11月22日举行新厂区开工仪式');
t('开工仪式', r.title, v => v.includes('开工仪式'));

// —— 新增：单位名补全 ——
// 7) 标题式发文机关："XX局关于召开…的通知"
r = localExtract('市公安局关于召开第X次党委会议的通知\n11月25日上午9:00在三楼会议室');
t('发文机关前缀', r.title, '市公安局第X次党委会议');

// 8) 行文主语："局党委定于…"
r = localExtract('局党委定于11月26日召开第X次党委会议');
t('行文主语前缀', r.title, v => (v.includes('局党委') || v.includes('局')) && v.includes('第X次党委会议'));

// 9) 落款行
r = localExtract('第X次党委会议\n时间：11月27日 上午9:00\n地点：三楼会议室\n市公安局党委');
t('落款前缀+党委去重', r.title, '市公安局第X次党委会议');

// 10) 已含单位名不重复叠加
r = localExtract('关于召开市公安局第X次党委会议的通知');
t('不重复叠加', r.title, '市公安局第X次党委会议');

// 11) 无单位信息时不动标题
r = localExtract('11月28日召开项目评审会');
t('无单位不动', r.title, '项目评审会');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
