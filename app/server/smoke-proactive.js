'use strict';
/**
 * 主动发言全链路验收
 * ---------------------------------------------------------------------------
 * smoke-memory.js 测的是「每个模块自己对不对」；这个脚本测的是「它们串起来会不会开口」。
 * 为什么需要它：这一整套能力的失败方式是**静默的**——不报错、不崩、只是永远不说话。
 * 单测全绿但链路一处配置读错（比如 `Number(x) || 默认值` 把 0 吞了），
 * 用户看到的就是「开了跟没开一样」。
 *
 * 用假适配器 + 假会话库，不碰网络、不碰 QQ，可以在任何机器上跑。
 * 运行：node smoke-proactive.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const { MemoryStore } = require('./memory-store');
const { MemoryExtractor } = require('./memory-extract');
const { InterestProfile } = require('./interest');
const { SpeakPolicy } = require('./speak-policy');
const { BrainGate } = require('./brain-gate');
const { ProactiveEngine } = require('./proactive');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log('      详情:', typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
}

function section(title) { console.log(`\n── ${title} ──`); }

/* ---------------- 假环境 ---------------- */

function makeWorld(ctxPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-pro-'));
  const BASE = {
    memory: { enabled: true, autoExtract: true, digestEvery: 5, digestMinChars: 2, promptTopN: 6 },
    interest: { enabled: true, capabilities: ['编程', '电脑', '游戏'], interjectThreshold: 0.5, initiateThreshold: 0.5, profileDecayPerDay: 0 },
    interestReply: { enabled: true, shadow: false, threshold: 0.5 },
    proactive: {
      enabled: true, shadow: true, idleMin: 1, minGroupMsgsToday: 0,
      nightFrom: '09:00', nightTo: '09:00',
      maxPerHour: 2, maxPerDay: 8, minGapMs: 0, ignoreWindowSec: 600, settleMs: 0,
      targetChatKeys: ['group:777'], candidateKinds: ['event', 'meme', 'fact']
    },
    ai: { enabled: true, quietFrom: '23:00', quietTo: '08:00' }
  };
  // 逐段深合并（一层足够）：先摊平 BASE 再盖 ctxPatch，
  // 不能只写 `...ctxPatch`——那样只给一两个字段的用例会把整段的 enabled 抹掉。
  const cfg = { ...BASE };
  for (const k of Object.keys(ctxPatch)) {
    const v = ctxPatch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) cfg[k] = { ...BASE[k], ...v };
    else cfg[k] = v;
  }
  const events = [];
  const broadcast = (e) => events.push(e);
  const getConfig = () => cfg;

  const memory = new MemoryStore({ dataDir: dir, log: () => {}, getConfig });
  memory.load();
  const interest = new InterestProfile({ getConfig, broadcast });
  const policy = new SpeakPolicy({ getConfig, interest, memory, broadcast });
  const gate = new BrainGate({ log: () => {} });
  const extractor = new MemoryExtractor({ memory, getConfig, broadcast });

  /* 假会话库：只要聊天目录能查到群，就是真实形状 */
  const chat = { id: 'group:777', type: 'group', targetId: '777', name: '测试群', lastText: '', lastTime: 0, unread: 0 };
  const store = {
    chats: new Map([['group:777', chat]]),
    messages: new Map(),
    addMessage(m) {
      const k = `${m.chatType}:${m.chatId}`;
      if (!this.messages.has(k)) this.messages.set(k, []);
      this.messages.get(k).push(m);
      return m;
    },
    getMessages(chatKey, n) { return (this.messages.get(chatKey) || []).slice(-n); }
  };

  /* 假适配器：记录发了什么，永不失败 */
  const sent = [];
  const adapter = {
    self: { userId: '999' },
    async sendText(target, text, opts) { sent.push({ target, text, opts }); return { ok: true }; }
  };

  let composeText = '这键盘最后选好了吗？';
  const compose = async () => composeText;

  const proactive = new ProactiveEngine({
    interest, policy, memory, gate, store, adapter, broadcast, getConfig, compose
  });

  return {
    dir, cfg, events, memory, interest, policy, gate, extractor, store, adapter, sent, proactive,
    setCompose(t) { composeText = t; },
    types(t) { return events.filter((e) => e.type === t); }
  };
}

function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } }

/* ---------------- 用例 ---------------- */

(async () => {
  /* ============ 1. 冷启动：没记忆就不该开口 ============ */
  section('1. 没记忆时保持安静，但要留痕');
  {
    const w = makeWorld();
    await w.proactive.tick();
    ok('没记忆 → 一条都没发', w.sent.length === 0);
    const skipped = w.types('proactive_skipped');
    ok('没记忆 → 广播了「没有可聊的记忆」（不能静默）',
      skipped.some((e) => e.reason === '没有可聊的记忆'), skipped);

    // 白名单写了不存在的群：面板必须能看出来
    w.cfg.proactive.targetChatKeys = ['group:777', 'group:888'];
    const st = w.proactive.state();
    ok('白名单里不存在的群被标成 unresolved', st.unresolved.includes('group:888'), st.unresolved);
    cleanup(w.dir);
  }

  /* ============ 2. 全链路：记忆 + 兴趣 → 演练决策 ============ */
  section('2. 全链路：有记忆有��趣，演练模式通过判决');
  {
    const w = makeWorld();
    w.memory.upsert({ scope: 'group:777', kind: 'event', text: '小王在纠结机械键盘买红轴还是茶轴', weight: 1.2, conf: 0.9 });
    for (let i = 0; i < 20; i++) w.interest.observeMessage({ chatType: 'group', chatId: '777', text: '那把机械键盘到底买红轴还是茶轴啊' });
    // 冷场：最后来信拨到 2 分钟前（idleMin=1）
    w.policy.notifyInbound('group:777');
    w.policy._lastInboundAt.set('group:777', Date.now() - 2 * 60000);

    await w.proactive.tick();

    const dec = w.types('proactive_decision');
    ok('演练模式：产生了 proactive_decision', dec.length === 1, dec);
    ok('演练模式：判决通过', dec[0] && dec[0].ok === true, dec[0]);
    ok('演练模式：标了 shadow=true', dec[0] && dec[0].shadow === true, dec[0]);
    ok('演练模式：一条都没真发', w.sent.length === 0, w.sent);
    ok('候选来自记忆，不是自由发挥', dec[0] && /机械键盘/.test(JSON.stringify(dec[0].candidate || {})), dec[0] && dec[0].candidate);
    cleanup(w.dir);
  }

  /* ============ 3. 关掉演练 → 真的发 ============ */
  section('3. 关掉演练模式 → 真的发送并留痕');
  {
    const w = makeWorld({ proactive: { shadow: false } });
    w.memory.upsert({ scope: 'group:777', kind: 'event', text: '小王在纠结机械键盘买红轴还是茶轴', weight: 1.2, conf: 0.9 });
    for (let i = 0; i < 20; i++) w.interest.observeMessage({ chatType: 'group', chatId: '777', text: '那把机械键盘到底买红轴还是茶轴啊' });
    w.policy.notifyInbound('group:777');
    w.policy._lastInboundAt.set('group:777', Date.now() - 2 * 60000);

    await w.proactive.tick();

    ok('非演练：真的发了一条', w.sent.length === 1, w.sent);
    ok('非演练：发到正确的群', w.sent[0] && w.sent[0].target.targetId === '777', w.sent[0] && w.sent[0].target);
    ok('非演练：内容是生成的那句', w.sent[0] && w.sent[0].text === '这键盘最后选好了吗？', w.sent[0] && w.sent[0].text);
    const sentEvt = w.types('proactive_sent');
    ok('非演练：广播了 proactive_sent', sentEvt.length === 1, sentEvt);
    ok('非演练：消息进了会话库（网页端能看到）',
      (w.store.getMessages('group:777', 5) || []).length >= 1, w.store.getMessages('group:777', 5));
    ok('非演练：预算被扣（防刷屏）', w.policy.state().sentHour === 1, w.policy.state());
    cleanup(w.dir);
  }

  /* ============ 4. 闸门真的拦得住 ============ */
  section('4. 闸门：配错也要拦住');
  {
    // 4.1 白名单为空 → 一个都不主动
    const w1 = makeWorld({ proactive: { targetChatKeys: [] } });
    w1.memory.upsert({ scope: 'group:777', kind: 'event', text: '小王在纠结机械键盘买红轴还是茶轴', weight: 1.2, conf: 0.9 });
    await w1.proactive.tick();
    ok('白名单空 → 不主动', w1.sent.length === 0);
    cleanup(w1.dir);

    // 4.2 总开关关掉 → 什么都不做
    const w2 = makeWorld({ proactive: { enabled: false } });
    w2.memory.upsert({ scope: 'group:777', kind: 'event', text: '小王在纠结机械键盘买红轴还是茶轴' });
    await w2.proactive.tick();
    ok('enabled=false → 连决策都不产生', w2.events.length === 0, w2.events.length);
    cleanup(w2.dir);

    // 4.3 夜里（注入时间）→ 拦
    const w3 = makeWorld({ proactive: { enabled: true, nightFrom: '00:00', nightTo: '09:00', shadow: false } });
    const night = new Date('2026-06-01T03:00:00').getTime();
    const vNight = w3.policy.verdict({ kind: 'initiate', chatKey: 'group:777', text: '机械键盘', now: night });
    ok('凌晨 3 点 → 夜间静默', vNight.ok === false && /夜/.test(vNight.reason), vNight);
    const day = new Date('2026-06-01T15:00:00').getTime();
    const vDay = w3.policy.verdict({ kind: 'initiate', chatKey: 'group:777', text: '机械键盘', now: day });
    ok('下午 3 点 → 夜间闸门放行（可能被别的闸拦）', vDay.gate !== '_gInitiateNight', vDay);
    cleanup(w3.dir);

    // 4.4 预算耗尽 → 拦
    const w4 = makeWorld({ proactive: { shadow: false, maxPerHour: 1 } });
    w4.policy.noteSent('group:777', 'initiate');
    // 预算闸门排在冷场/分数之后，前面几道得先放行才测得到它本身。
    // 这正好也是真实场景的顺序：一个天天聊键盘的冷清群，先过热度和兴趣，才轮到预算。
    w4.policy.notifyInbound('group:777');
    w4.policy._lastInboundAt.set('group:777', Date.now() - 2 * 60000);
    for (let i = 0; i < 20; i++) w4.interest.observeMessage({ chatType: 'group', chatId: '777', text: '那把机械键盘到底买红轴还是茶轴啊' });
    const vBudget = w4.policy.verdict({ kind: 'initiate', chatKey: 'group:777', text: '那把机械键盘到底买红轴还是茶轴' });
    ok('预算用完 → 主动发言预算用尽', vBudget.ok === false && /预算/.test(vBudget.reason), vBudget);
    cleanup(w4.dir);

    // 4.5 「闭嘴」→ 静音 + 熔断
    const w5 = makeWorld();
    w5.policy.triggerNegative('group:777', '你能不能别说话了');
    ok('说「别说话」→ 进入静音', w5.policy.isMuted('group:777') === true);
    const vMute = w5.policy.verdict({ kind: 'initiate', chatKey: 'group:777', text: '机械键盘' });
    ok('静音期间 → 被拦', vMute.ok === false, vMute);
    cleanup(w5.dir);
  }

  /* ============ 5. 连续被无视 → 自动降频 ============ */
  section('5. 连续被无视自动降频');
  {
    const w = makeWorld();
    w.policy.noteSent('group:777', 'initiate');
    w.policy.noteIgnored('group:777');
    const s1 = w.policy.state();
    const rec1 = (s1.ignored || []).find((x) => x.chatKey === 'group:777');
    ok('第 1 次被无视 → backoff 1', rec1 && rec1.backoff === 1, rec1);

    w.policy.noteIgnored('group:777');
    w.policy.noteIgnored('group:777');
    const s3 = w.policy.state();
    const rec3 = (s3.ignored || []).find((x) => x.chatKey === 'group:777');
    ok('第 3 次被无视 → backoff 4', rec3 && rec3.backoff === 4, rec3);
    const v = w.policy.verdict({ kind: 'initiate', chatKey: 'group:777', text: '机械键盘' });
    ok('连续被无视 3 次 → 直接拦下', v.ok === false, v);

    w.policy.notePicked('group:777');
    const s4 = w.policy.state();
    const rec4 = (s4.ignored || []).find((x) => x.chatKey === 'group:777');
    ok('有人接话 → 完全复位', !rec4 || rec4.backoff === 1, rec4);
    cleanup(w.dir);
  }

  /* ============ 6. 大脑互斥：真人 @ 优先 ============ */
  section('6. 大脑互斥：真人回复优先于主动发言');
  {
    const { BrainGate, PRI } = require('./brain-gate');
    ok('优先级 reply > interject > initiate',
      PRI.reply > PRI.interject && PRI.interject > PRI.initiate, PRI);

    const g = new BrainGate({ log: () => {} });
    let order = [];
    // 先占住大脑
    const busy = g.run('reply', () => new Promise((r) => setTimeout(() => { order.push('reply'); r('a'); }, 120)));
    // 主动发言在忙的时候应该立刻放弃，不排队
    const tryRes = await g.tryRun('initiate', async () => { order.push('initiate'); return 'b'; });
    ok('大脑忙时主动发言立刻放弃（不排队抢）', tryRes.ok === false, tryRes);
    ok('放弃原因可读', /忙/.test(String(tryRes.reason || '')), tryRes.reason);
    await busy;
    ok('真人回复正常完成', order.join(',') === 'reply', order);
  }

  /* ============ 7. 负反馈降权记忆 ============ */
  section('7. 被制止后相关记忆降权');
  {
    const w = makeWorld();
    const r = w.memory.upsert({ scope: 'group:777', kind: 'event', text: '小王在纠结机械键盘买红轴还是茶轴', weight: 1.0, conf: 0.9 });
    // 降权对象是「刚刚说过的那条」，所以必须先把这条记成 lastTry，
    // 否则 _downgradeRecentMemory 找不到要降权的记忆（它不会去猜）
    w.proactive._lastTry.set('group:777', { at: Date.now(), grams: ['机械', '键盘'], memoryId: r.item.id, sent: true });
    w.proactive.notifyInbound({ chatType: 'group', chatId: '777', self: false, system: false, text: '小王：别说了别说了' });
    const after = w.memory.get(r.item.id);
    ok('说「别说了」→ 该记忆权重下降', after && after.weight < 1.0, after && after.weight);
    ok('说「别说了」→ 群被静音', w.policy.isMuted('group:777') === true);
    cleanup(w.dir);
  }

  /* ============ 8. 抽取器：真实句子能记住 ============ */
  section('8. 真实句子进得了记忆（中文不能判成噪音）');
  {
    const w = makeWorld({ memory: { digestEvery: 2 } });
    const msgs = [
      '我叫小林',
      '我最近喜欢上了骑行',
      '明天要去医院复查',
      '这周末要搬家'
    ];
    for (const text of msgs) {
      const m = { chatType: 'group', chatId: '777', chatIdStr: '777', self: false, system: false, text, fromName: '小林', time: Date.now() };
      w.extractor.observe(m);
    }
    w.extractor.flush();
    const list = w.memory.list({ scope: 'group:777' });
    ok('4 句人话抽出至少 3 条记忆（中文没被当噪音）', list.total >= 3, list.items.map((x) => x.text));
    ok('抽出的内容不是「了某某」这种残缺词',
      list.items.every((x) => !/^[了过]/.test(x.text)), list.items.map((x) => x.text));
    cleanup(w.dir);
  }

  section('9. tick 重入保护：上一轮没跑完时不能叠着压进来');
  {
    // 真实场景：tick 每 30 秒一拍，而里面要 await 大脑（最长 90 秒）。
    // 没有这道锁，冷场时间越长就堆得越多——一次冷场会触发几十个并发 tick
    // 同时翻记忆、同时抢大脑。用桩替掉 _tryInitiate，只数调用次数。
    const chats = new Map([
      ['group:1', { id: '1', type: 'group', targetId: '1' }],
      ['group:2', { id: '2', type: 'group', targetId: '2' }]
    ]);
    const pro = new ProactiveEngine({
      interest: null,
      policy: { noteIgnored() {}, verdict() { return { ok: false }; } },
      memory: null,
      gate: null,
      store: { chats, addMessage() {} },
      adapter: {},
      broadcast: () => {},
      getConfig: () => ({ ai: { enabled: true }, proactive: { enabled: true, targetChatKeys: ['group:1', 'group:2'], idleMin: 1, minGroupMsgsToday: 0, maxPerHour: 9, maxPerDay: 99, minGapMs: 0 } }),
      compose: async () => ''
    });
    let calls = 0;
    pro._tryInitiate = async () => { calls++; await new Promise((r) => setTimeout(r, 120)); };
    for (const k of ['group:1', 'group:2']) pro._daily.set(k, { day: new Date().toDateString(), count: 100 });

    await Promise.all([pro.tick(), pro.tick(), pro.tick(), pro.tick(), pro.tick()]);
    ok('5 拍重叠只跑了一轮（两个群各一次 = 2，无锁会是 10）', calls === 2, { calls });

    const before = calls;
    pro._lastTry.clear();
    await pro.tick();
    ok('锁在 finally 里放开，下一拍还能正常跑', calls > before, { before, after: calls });
  }

  section('10. QQ 断线时不白烧一次大脑，也不报看不懂的错');
  {
    // 真实场景：OneBot 没起来或正在重建适配器时 adapter 为 null。
    // 不挡这一下，就会先花 90 秒让大脑生成文案，再崩在 sendText 上，
    // 面板上只看到「Cannot read properties of null」。
    const chats = new Map([['group:1', { id: '1', type: 'group', targetId: '1', name: 'g1' }]]);
    const evts = [];
    let composed = 0;
    const pro = new ProactiveEngine({
      interest: { settleBotSpeak: () => null, expireBotSpeak: () => false, markBotSpoke() {}, score: () => ({ score: 0.9 }) },
      policy: { verdict: () => ({ ok: true, score: 0.9, grams: [] }), noteSent() {}, notePicked() {}, noteIgnored() {}, isMuted: () => false },
      memory: { search: () => [{ item: { id: 'm1', text: '小王想买机械键盘', kind: 'fact' }, score: 0.5 }], touchHits() {} },
      gate: null,
      store: { chats, addMessage() {}, getMessages: () => [] },
      adapter: null, // ← 断线
      broadcast: (e) => evts.push(e),
      getConfig: () => ({ ai: { enabled: true }, proactive: { enabled: true, shadow: false, targetChatKeys: ['group:1'], idleMin: 1, minGroupMsgsToday: 0, maxPerHour: 9, maxPerDay: 99, minGapMs: 0, candidateKinds: ['fact'] } }),
      compose: async () => { composed++; return '键盘买了吗？'; }
    });
    pro._daily.set('group:1', { day: new Date().toDateString(), count: 50 });
    await pro.tick();
    const skip = evts.find((e) => e.type === 'proactive_skipped');
    ok('断线时给出可读原因「QQ 未连接」', !!skip && skip.reason === 'QQ 未连接', skip || evts.map((e) => e.type));
    ok('断线时不该白烧一次大脑生成', composed === 0, { composed });
  }

  /* ---------------- 汇总 ---------------- */
  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log(' -', f.name);
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本自身出错:', e);
  process.exit(1);
});
