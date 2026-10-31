'use strict';
/**
 * 三能力模块冒烟测试（零依赖，node smoke-memory.js）
 * 只验证「逻辑正确」，不碰网络/QQ/浏览器。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const { MemoryStore, bigrams } = require('./memory-store');
const { MemoryExtractor } = require('./memory-extract');
const { InterestProfile } = require('./interest');
const { SpeakPolicy } = require('./speak-policy');
const { BrainGate } = require('./brain-gate');
const { ProactiveEngine, NEG_RE } = require('./proactive');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`); }
}
function section(t) { console.log(`\n[${t}]`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-mem-'));
const cfg = {
  memory: { enabled: true, digestEvery: 3, digestMinChars: 6, maxPerScope: 20000, decayDays: 30, autoExtract: true, promptTopN: 6 },
  interest: { enabled: true, capabilities: ['编程', '电脑', '游戏', '番剧', '学习', '做饭', '数码'], interjectThreshold: 0.55, initiateThreshold: 0.65 },
  proactive: { enabled: true, shadow: true, idleMin: 25, minGroupMsgsToday: 2, nightFrom: '00:00', nightTo: '09:00', maxPerHour: 2, maxPerDay: 8, minGapMs: 0, candidateKinds: ['event', 'meme', 'fact'], targetChatKeys: ['group:100'] },
  interestReply: { enabled: true, shadow: true, threshold: 0.55 },
  ai: { enabled: true, quietFrom: '23:00', quietTo: '08:00' }
};
const getConfig = () => cfg;

(async () => {
  /* ---------- 1. bigrams ---------- */
  section('分词 bigrams');
  const gs = bigrams('我最近在学 Rust 编程，超级喜欢');
  const g = [...gs];
  ok('返回 Set（自带去重）', gs instanceof Set, Object.prototype.toString.call(gs));
  ok('切成二元组且有英文整词', gs.has('编程') && gs.has('rust'), g.slice(0, 8));
  ok('过滤停用词', !gs.has('我的') && !gs.has('最近') && !gs.has('可以'), g.slice(0, 6));
  ok('英文短词(<3)丢弃', ![...bigrams('我是 ai 啊')].includes('ai'), [...bigrams('我是 ai 啊')]);
  ok('标点被切成独立段', [...bigrams('键盘，红轴')].includes('键盘') && [...bigrams('键盘，红轴')].includes('红轴'), null);

  /* ---------- 2. MemoryStore ---------- */
  section('MemoryStore 增删查');
  const mem = new MemoryStore({ dataDir: tmp, getConfig });
  mem.load();
  const a = mem.upsert({ scope: 'group:100', kind: 'event', text: '小王说想买一把机械键盘，还在纠结红轴还是茶轴', origin: 'auto' });
  ok('写入返回条目', !!a.item.id, a.item.id);
  const b = mem.upsert({ scope: 'group:100', kind: 'fact', text: '小李住在杭州，做前端开发', origin: 'auto' });
  mem.upsert({ scope: 'group:200', kind: 'event', text: '隔壁群聊的是显卡价格', origin: 'auto' });

  const hit = mem.search({ scope: 'group:100', text: '机械键盘最后买了吗', topN: 5 });
  ok('检索命中键盘那条', hit.length > 0 && /键盘/.test(hit[0].item.text), hit.map((h) => h.item.text.slice(0, 12)));
  ok('scope 隔离（不串群）', mem.search({ scope: 'group:100', text: '显卡' }).every((h) => !/显卡/.test(h.item.text)), null);

  const dup = mem.upsert({ scope: 'group:100', kind: 'event', text: '小王说想买一把机械键盘，还在纠结红轴还是茶轴' });
  ok('重复写入合并而非新增', dup.merged === true, dup.merged);
  ok('合并后总数没涨', mem.list({ scope: 'group:100' }).items.length === 2, mem.list({ scope: 'group:100' }).items.length);

  ok('按 kind 过滤', mem.search({ scope: 'group:100', text: '杭州', kinds: ['fact'] }).length === 1, null);
  mem.touchHits([a.item.id]);
  ok('touchHits 计数', mem.get(a.item.id).hitCount >= 1, mem.get(a.item.id).hitCount);
  ok('stats 有文件大小', typeof mem.stats().fileBytes === 'number', mem.stats());

  mem.flush();
  ok('落盘文件存在', fs.existsSync(path.join(tmp, 'memory.json')), null);
  const reload = new MemoryStore({ dataDir: tmp, getConfig });
  reload.load();
  ok('重启后能读回', reload.list({ scope: 'group:100' }).items.length === 2, reload.list({}).total);
  reload.forget(b.item.id);
  ok('软删除', reload.list({ scope: 'group:100' }).items.length === 1, reload.list({ scope: 'group:100' }).items.length);

  /* ---------- 3. MemoryExtractor ---------- */
  section('MemoryExtractor 抽取');
  const events = [];
  const ex = new MemoryExtractor({ memory: mem, getConfig, broadcast: (e) => events.push(e) });
  const mk = (text, over = {}) => ({ chatType: 'group', chatId: '100', fromId: '1', fromName: '小王', text, ...over });
  ex.observe(mk('我最近喜欢上了骑行，周末都去郊区'));
  ex.observe(mk('哦'));
  ex.observe(mk('这个群今天人好少啊'));
  ok('短文本不入缓冲', ex.state().buffered <= 2, ex.state());
  const n = ex.flush('group:100');
  ok('flush 抽出记忆', n >= 1, n);
  ok('广播 memory_written', events.some((e) => e.type === 'memory_written'), events.map((e) => e.type));
  ok('跳过自己发的', (() => { const before = ex.state().buffered; ex.observe(mk('我喜欢我自己说的一切', { self: true })); return ex.state().buffered === before; })(), null);

  /* ---------- 4. InterestProfile ---------- */
  section('InterestProfile 打分');
  const it = new InterestProfile({ getConfig, broadcast: () => {} });
  for (let i = 0; i < 30; i++) it.observeMessage(mk('最近在写 rust 编程，电脑配置也想升级'));
  it.observeMessage(mk('晚上看番剧'));
  const hi = it.score('group:100', '你们的 rust 编程项目怎么样了');
  const lo = it.score('group:100', '今天天气不错适合散步');
  ok('相关话题分高于无关话题', hi.score > lo.score, { hi: hi.score, lo: lo.score });
  ok('分数在 0~1', hi.score <= 1 && lo.score >= 0, hi.score);
  it.markBotSpoke('group:100');
  const picked = it.settleBotSpeak('group:100', it.topWords('group:100', 5));
  ok('2 分钟内接话算 picked', picked === 'picked', picked);
  ok('画像有词', it.profile('group:100', 5).top.length > 0, it.profile('group:100', 3));

  /* ---------- 5. SpeakPolicy ---------- */
  section('SpeakPolicy 闸门');
  const decisions = [];
  const pol = new SpeakPolicy({ getConfig, interest: it, memory: mem, broadcast: (e) => decisions.push(e) });
  cfg.proactive.shadow = true;
  cfg.proactive.minGapMs = 0;

  const inter = pol.verdict({ kind: 'interject', chatKey: 'group:100', text: 'rust 编程' });
  ok('兴趣相关的插话被批准', inter.ok === true, inter);
  const interLow = pol.verdict({ kind: 'interject', chatKey: 'group:100', text: '天气不错' });
  ok('无关话题被拦下', interLow.ok === false && /兴趣相关度不足/.test(interLow.reason), interLow.reason);

  cfg.interestReply.enabled = false;
  const off = pol.verdict({ kind: 'interject', chatKey: 'group:100', text: 'rust 编程' });
  ok('关掉兴趣回复后立刻不批', off.ok === false, off.reason);
  cfg.interestReply.enabled = true;

  const init = pol.verdict({ kind: 'initiate', chatKey: 'group:100', text: '机械键盘最后买了哪款' });
  ok('主动发言判定可跑通', typeof init.ok === 'boolean', init);
  const notInList = pol.verdict({ kind: 'initiate', chatKey: 'group:999', text: '机械键盘' });
  ok('不在白名单的群一律不主动', notInList.ok === false, notInList.reason);

  pol.noteSent('group:100', 'initiate');
  pol.noteSent('group:100', 'initiate');
  // 直接测闸门：预算闸门排在分数/夜间之后，走 verdict 会被前面闸门挡住，测不到它本身
  const budget = pol._gBudget({ kind: 'initiate', now: Date.now() });
  ok('预算用尽会拦（maxPerHour=2）', !!budget && /预算/.test(budget.reason || ''), budget);
  cfg.proactive.maxPerHour = 5;
  cfg.proactive.maxPerDay = 5;
  ok('调大预算后放行', pol._gBudget({ kind: 'initiate', now: Date.now() }) === null, null);

  // 夜间闸门：可注入 now，不受跑测试的真实时间影响
  const nightTs = new Date('2026-06-01T03:00:00').getTime();
  const dayTs = new Date('2026-06-01T15:00:00').getTime();
  ok('凌晨 3 点拦主动发言', /夜间/.test((pol._gInitiateNight({ now: nightTs }) || {}).reason || ''), null);
  ok('下午 3 点放行', pol._gInitiateNight({ now: dayTs }) === null, null);

  const p2 = new SpeakPolicy({ getConfig, interest: it, memory: mem, broadcast: () => {} });
  p2.noteSent('group:100', 'interject');
  for (let i = 0; i < 3; i++) p2.noteIgnored('group:100');
  const back = p2.verdict({ kind: 'interject', chatKey: 'group:100', text: 'rust 编程' });
  ok('连续被无视 3 次后自动降频', back.ok === false && /降频/.test(back.reason || ''), back.reason);
  p2.notePicked('group:100');
  const after = p2.verdict({ kind: 'interject', chatKey: 'group:100', text: 'rust 编程' });
  ok('被接话后复位', after.ok === true, after.reason);

  const p3 = new SpeakPolicy({ getConfig, interest: it, memory: mem, broadcast: () => {} });
  p3.triggerNegative('group:100', '闭嘴');
  const muted = p3.verdict({ kind: 'interject', chatKey: 'group:100', text: 'rust 编程' });
  ok('被骂后静音', muted.ok === false && /冷静/.test(muted.reason || ''), muted.reason);
  ok('决策历史有记录', pol.decisions(10).length > 0, pol.decisions(3).length);
  ok('promptBlock 是字符串', typeof pol.promptBlock('group:100') === 'string', (pol.promptBlock('group:100') || '').slice(0, 30));

  /* ---------- 6. BrainGate ---------- */
  section('BrainGate 优先级');
  const gate = new BrainGate({ log: () => {} });
  const order = [];
  const slow = () => new Promise((r) => setTimeout(() => { order.push('first'); r('a'); }, 30));
  const p = [
    gate.run('initiate', slow),
    gate.run('initiate', async () => { order.push('initiate'); return 'b'; }),
    gate.run('reply', async () => { order.push('reply'); return 'c'; })
  ];
  ok('忙碌时 tryRun 直接放弃', (await gate.tryRun('initiate', async () => 1)).ok === false, gate.state());
  await Promise.all(p);
  ok('高优先级插队：reply 在 initiate 之前', order.indexOf('reply') < order.lastIndexOf('initiate'), order);
  ok('全部执行完毕', order.length === 3, order);
  ok('空闲后 tryRun 成功', (await gate.tryRun('initiate', async () => 42)).ok === true, null);

  /* ---------- 7. ProactiveEngine ---------- */
  section('ProactiveEngine（演练模式，不发送）');
  const sent = [];
  const adapter = { self: { userId: 'bot' }, async sendText(t, text) { sent.push(text); return true; } };
  const chats = new Map([['group:100', { id: 'group:100', type: 'group', targetId: '100', name: '测试群' }]]);
  const store = {
    chats,
    getMessages: () => [{ self: false, fromName: '小王', text: '那个机械键盘你最后买了哪款啊' }],
    addMessage: () => {}
  };
  const proEvents = [];
  const composes = [];
  const pro = new ProactiveEngine({
    interest: it, policy: pol, memory: mem, gate, store, adapter,
    broadcast: (e) => proEvents.push(e), getConfig,
    compose: async (k, p) => { composes.push(p); return '上次说的那把键盘，最后买了红轴还是茶轴？'; }
  });
  cfg.proactive.enabled = true;
  cfg.proactive.shadow = true;
  // 默认夜间静默是 00:00-09:00；如果在夜里跑测试，主动发言会被正确拦下（这不是 bug）。
  // from === to 表示「不设静默窗口」，用它把时间因素从这条链路里隔离掉——
  // 夜间闸门本身已经在上面用注入的 now 单独测过了。
  cfg.proactive.nightFrom = '09:00';
  cfg.proactive.nightTo = '09:00';

  ok('负反馈正则命中', NEG_RE.test('你别说话了') && !NEG_RE.test('今天真热'), null);

  const key = 'group:100';
  // 真实链路里同一条消息既进记忆也进兴趣画像；测试里建记忆时直接 upsert 了，
  // 兴趣画像没学到「键盘」，initiate 的分数闸门就会正确地把它拦下。
  // 这里补上兴趣画像的学习，让这条链路按生产路径跑。
  for (let i = 0; i < 20; i++) it.observeMessage({ chatType: 'group', chatId: '100', text: '那把机械键盘到底买红轴还是茶轴啊' });
  pro.notifyInbound({ chatType: 'group', chatId: '100', text: '聊点别的' });
  pro.notifyInbound({ chatType: 'group', chatId: '100', text: '再聊点' });
  ok('当日计数累加', pro.state().daily.find((d) => d.chatKey === key)?.count >= 2, pro.state().daily);
  // 冷场判定要求「最后一条来信」已过去 idleMin 分钟，测试里把它拨到 2 小时前
  pol._lastInboundAt.set(key, Date.now() - 2 * 3600000);
  // 候选是加权随机抽的，单抽一次断言「必过」会随机挂；真正的保证是
  // 「候选池里至少有一条能过判决」——只要池子里有过得去的，tick 迟早会挑到。
  const poolKinds = cfg.proactive.candidateKinds;
  const pool = mem.search({ scope: key, text: '', kinds: poolKinds, topN: 12, minScore: 0 });
  const passes = pool.filter((h) => pol.verdict({ kind: 'initiate', chatKey: key, text: h.item.text, now: Date.now() }).ok);
  ok('候选池里至少有一条能过主动发言判决', passes.length > 0,
    { pool: pool.length, scored: pool.map((h) => ({ t: h.item.text.slice(0, 10), s: it.score(key, h.item.text).score.toFixed(2) })) });

  // 清掉新近限制，让 tick 有机会走
  await pro.tick();
  ok('演练模式没有发送', sent.length === 0, sent);
  const decided = proEvents.filter((e) => e.type === 'proactive_decision');
  ok('演练会广播 proactive_decision(shadow)', decided.length > 0 && decided[0].shadow === true, decided.map((e) => e.shadow));

  // 关演练：应该真的发
  cfg.proactive.shadow = false;
  pol.notePicked(key);
  pro.interest.markBotSpoke(key);
  const p4 = new ProactiveEngine({
    interest: it, policy: new SpeakPolicy({ getConfig, interest: it, memory: mem, broadcast: () => {} }),
    memory: mem, gate, store, adapter, broadcast: (e) => proEvents.push(e), getConfig,
    compose: async () => '那把键盘最后买了哪款？'
  });
  p4.notifyInbound({ chatType: 'group', chatId: '100', text: 'a' });
  p4.notifyInbound({ chatType: 'group', chatId: '100', text: 'b' });
  p4.policy._lastInboundAt.set('group:100', Date.now() - 2 * 3600000);
  await p4.tick();
  ok('非演练模式会真发', sent.length === 1, sent);
  ok('发送后广播 proactive_sent', proEvents.some((e) => e.type === 'proactive_sent'), proEvents.map((e) => e.type));

  pro.kill();
  ok('kill 清空调度', pro.state().lastTry.length === 0, pro.state().lastTry);

  // 负反馈降权
  const before = mem.get(a.item.id)?.weight;
  const p5 = new ProactiveEngine({ interest: it, policy: pol, memory: mem, gate, store, adapter, broadcast: () => {}, getConfig, compose: async () => '' });
  p5._lastTry.set(key, { at: Date.now(), grams: [], memoryId: a.item.id });
  p5.notifyInbound({ chatType: 'group', chatId: '100', text: '闭嘴别刷了' });
  const afterW = mem.get(a.item.id)?.weight;
  ok('被骂后那条记忆降权', afterW < before, { before, after: afterW });

  /* ---------- 8. 空数据不崩 ---------- */
  section('异常输入');
  const mem2 = new MemoryStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qz-mem2-')), getConfig });
  mem2.load();
  ok('空库检索返回空数组', Array.isArray(mem2.search({ scope: 'group:x', text: '任意' })), null);
  ok('空库 stats 不崩', typeof mem2.stats().total === 'number', mem2.stats());
  const p6 = new ProactiveEngine({ interest: it, policy: pol, memory: mem2, gate, store, adapter, broadcast: () => {}, getConfig, compose: async () => '' });
  await p6.tick();
  ok('空库 tick 不崩', true, null);
  ok('bigrams(空) 返回空 Set', bigrams('').size === 0 && bigrams(null).size === 0 && bigrams(undefined).size === 0, null);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
