'use strict';
const assert = require('assert');
const path = require('path');
const { Moderation, DEFAULT_MODERATION, withDefaults, FEATURES } = require('./app/server/moderation');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

function mkCfg(over = {}) {
  const base = {
    ai: { commandSenders: '1413214574' },
    moderation: withDefaults(DEFAULT_MODERATION, { enabled: true, ...over })
  };
  return base;
}

function mkAdapter(opts = {}) {
  const sent = [];
  const actions = [];
  return {
    sent, actions,
    self: { userId: 999 },
    async sendText(chat, text, o) { sent.push({ chat, text, opts: o }); return { message_id: Date.now() }; },
    async callAction(action, params) {
      actions.push({ action, params });
      if (action === 'get_group_member_info') {
        // 查的是机器人自己（999）→ 回管理员身份；查别人 → 回群名片
        if (Number(params.user_id) === 999) return { role: opts.role || 'member' };
        return { card: '小明', nickname: '小明' };
      }
      return {};
    }
  };
}

function mkMsg(over = {}) {
  return {
    id: String(Date.now()) + Math.random(),
    chatType: 'group', chatId: '123456', chatName: '测试群',
    fromId: '777', fromName: '捣蛋鬼', self: false,
    text: '普通消息', time: Date.now(), ...over
  };
}

(async () => {
  console.log('== 默认值与合并 ==');
  t('六项功能都在', () => {
    assert.strictEqual(FEATURES.length, 6);
    for (const k of FEATURES) assert.ok(DEFAULT_MODERATION[k], k);
  });
  t('总开关默认关', () => assert.strictEqual(DEFAULT_MODERATION.enabled, false));
  t('自动禁言默认关', () => assert.strictEqual(DEFAULT_MODERATION.autoPunish, false));
  t('withDefaults 补全缺失字段', () => {
    const m = withDefaults(DEFAULT_MODERATION, { spam: { maxMsgs: 9 } });
    assert.strictEqual(m.spam.maxMsgs, 9);
    assert.strictEqual(m.spam.windowSec, DEFAULT_MODERATION.spam.windowSec);
  });

  console.log('== 总开关 ==');
  await ta('enabled=false 时什么都不做', async () => {
    const a = mkAdapter();
    const m = new Moderation({ getConfig: () => ({ moderation: { enabled: false } }), adapter: a });
    const r = await m.observe(mkMsg({ text: '加群 123456789 免费领' }));
    assert.strictEqual(r.handled, false);
    assert.strictEqual(a.sent.length, 0);
    m.close();
  });
  await ta('私聊不管', async () => {
    const a = mkAdapter();
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const r = await m.observe(mkMsg({ chatType: 'private', text: '加群 123456789 免费领' }));
    assert.strictEqual(r.handled, false);
    m.close();
  });
  await ta('自己发的消息不管', async () => {
    const a = mkAdapter();
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const r = await m.observe(mkMsg({ self: true, text: '加群 123456789 免费领' }));
    assert.strictEqual(r.handled, false);
    m.close();
  });
  await ta('主人豁免', async () => {
    const a = mkAdapter();
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const r = await m.observe(mkMsg({ fromId: '1413214574', text: '加群 123456789 免费领' }));
    assert.strictEqual(r.handled, false);
    m.close();
  });
  await ta('白名单用户豁免', async () => {
    const a = mkAdapter();
    const m = new Moderation({ getConfig: () => mkCfg({ whitelistUsers: '888' }), adapter: a });
    const r = await m.observe(mkMsg({ fromId: '888', text: '加群 123456789 免费领' }));
    assert.strictEqual(r.handled, false);
    m.close();
  });
  await ta('白名单群豁免', async () => {
    const a = mkAdapter();
    const m = new Moderation({ getConfig: () => mkCfg({ whitelistChats: '123456' }), adapter: a });
    const r = await m.observe(mkMsg({ text: '加群 123456789 免费领' }));
    assert.strictEqual(r.handled, false);
    m.close();
  });

  console.log('== 广告拦截 ==');
  await ta('命中「加群+群号」→ 拦截', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const r = await m.observe(mkMsg({ text: '加群 123456789 免费领福利' }));
    assert.strictEqual(r.handled, true);
    assert.strictEqual(r.reason, 'ad');
    m.close();
  });
  await ta('有管理员权限 → 删原消息', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    await m.observe(mkMsg({ id: '555', text: '私聊我领取内部资源' }));
    assert.ok(a.actions.some((x) => x.action === 'delete_msg' && x.params.message_id === 555));
    m.close();
  });
  await ta('不是管理员 → 只提醒不删', async () => {
    const a = mkAdapter({ role: 'member' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    await m.observe(mkMsg({ id: '555', text: '私聊我领取内部资源' }));
    assert.strictEqual(a.actions.filter((x) => x.action === 'delete_msg').length, 0);
    assert.ok(a.sent.some((s) => /不允许发广告/.test(s.text)));
    m.close();
  });
  await ta('普通聊天不误伤', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const r = await m.observe(mkMsg({ text: '今天中午吃什么好呢' }));
    assert.strictEqual(r.handled, false);
    m.close();
  });
  await ta('纯链接默认不拦（blockLinks=false）', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const r = await m.observe(mkMsg({ text: '这个教程不错 https://example.com/a' }));
    assert.strictEqual(r.handled, false);
    m.close();
  });
  await ta('blockLinks=true 时拦链接', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ ad: { enabled: true, deleteMsg: true, blockLinks: true } }), adapter: a });
    const r = await m.observe(mkMsg({ text: '看这个 https://spam.example.com/a' }));
    assert.strictEqual(r.handled, true);
    m.close();
  });

  console.log('== 违禁词 ==');
  await ta('命中违禁词 → 提醒，默认不删', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const r = await m.observe(mkMsg({ id: '777', text: '有人玩网赌吗' }));
    assert.strictEqual(r.handled, true);
    assert.strictEqual(r.reason, 'banned');
    assert.strictEqual(a.actions.filter((x) => x.action === 'delete_msg').length, 0);
    m.close();
  });
  await ta('提醒里不重复命中的词', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    await m.observe(mkMsg({ text: '有人玩网赌吗' }));
    const said = a.sent.filter((s) => s.chat.type === 'group').map((s) => s.text).join(' ');
    assert.ok(!said.includes('网赌'), '不该把违禁词再念一遍');
    m.close();
  });
  await ta('私聊主人预警', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    await m.observe(mkMsg({ text: '有人玩网赌吗' }));
    assert.ok(a.sent.some((s) => s.chat.type === 'private' && s.chat.targetId === '1413214574'));
    m.close();
  });

  console.log('== 重复消息 ==');
  await ta('第 3 次同样内容 → 合并', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const text = '这条消息我要发三遍';
    assert.strictEqual((await m.observe(mkMsg({ text }))).handled, false);
    assert.strictEqual((await m.observe(mkMsg({ text }))).handled, false);
    const r = await m.observe(mkMsg({ text }));
    assert.strictEqual(r.handled, true);
    assert.strictEqual(r.reason, 'duplicate');
    m.close();
  });
  await ta('短消息（哈哈）不算重复', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    for (let i = 0; i < 5; i++) {
      const r = await m.observe(mkMsg({ text: '哈哈' }));
      assert.strictEqual(r.handled, false);
    }
    m.close();
  });
  await ta('重复时只提示一次', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const text = '重复测试内容在这里';
    for (let i = 0; i < 6; i++) await m.observe(mkMsg({ text }));
    const notices = a.sent.filter((s) => /同样的消息发了/.test(s.text));
    assert.strictEqual(notices.length, 1, '只该提示一次，实际 ' + notices.length);
    m.close();
  });
  await ta('保留第一条，删后面的', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    const text = '保留第一条删后面几条';
    await m.observe(mkMsg({ id: '1001', text }));
    await m.observe(mkMsg({ id: '1002', text }));
    await m.observe(mkMsg({ id: '1003', text }));
    const dels = a.actions.filter((x) => x.action === 'delete_msg').map((x) => x.params.message_id);
    assert.ok(!dels.includes(1001), '第一条不该删');
    assert.ok(dels.includes(1002) && dels.includes(1003));
    m.close();
  });

  console.log('== 刷屏限流 ==');
  await ta('窗口内超限 → 第一次只提醒', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ duplicate: { enabled: false } }), adapter: a });
    let r;
    for (let i = 0; i < 8; i++) r = await m.observe(mkMsg({ text: '刷屏内容' + i + '号' }));
    assert.strictEqual(r.handled, false, '第一次只提醒，还让他说话');
    assert.ok(a.sent.some((s) => /慢点发/.test(s.text)));
    m.close();
  });
  await ta('第二次继续刷 → 拦截', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ duplicate: { enabled: false } }), adapter: a });
    for (let i = 0; i < 8; i++) await m.observe(mkMsg({ text: '刷屏内容' + i + '号' }));
    const hits = [];
    for (let i = 0; i < 8; i++) hits.push(await m.observe(mkMsg({ text: '又来一波' + i + '号' })));
    const caught = hits.find((r) => r.handled && r.reason === 'spam');
    assert.ok(caught, '第二轮里必须有一次被判刷屏');
    m.close();
  });
  await ta('autoPunish=false 时不禁言', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ duplicate: { enabled: false } }), adapter: a });
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 8; i++) await m.observe(mkMsg({ text: '刷' + round + '-' + i }));
    }
    assert.strictEqual(a.actions.filter((x) => x.action === 'set_group_ban').length, 0);
    m.close();
  });
  await ta('autoPunish=true 且是管理员 → 第3次禁言', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ autoPunish: true, duplicate: { enabled: false } }), adapter: a });
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) await m.observe(mkMsg({ text: '刷' + round + '-' + i }));
    }
    assert.ok(a.actions.some((x) => x.action === 'set_group_ban'), '该禁言了');
    m.close();
  });
  await ta('不是管理员时绝不禁言', async () => {
    const a = mkAdapter({ role: 'member' });
    const m = new Moderation({ getConfig: () => mkCfg({ autoPunish: true, duplicate: { enabled: false } }), adapter: a });
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 8; i++) await m.observe(mkMsg({ text: '刷' + round + '-' + i }));
    }
    assert.strictEqual(a.actions.filter((x) => x.action === 'set_group_ban').length, 0);
    m.close();
  });

  console.log('== 新人欢迎 ==');
  await ta('进群通知 → 发欢迎语', async () => {
    const a = mkAdapter({ role: 'admin' });
    // delaySec 必须给 0：默认 2 秒是定时器，测试里等不到
    const m = new Moderation({ getConfig: () => mkCfg({ welcome: { enabled: true, text: '欢迎 {name} 加入本群', delaySec: 0 } }), adapter: a });
    await m.onNotice({ type: 'group_increase', chatId: '123456', userId: '8888', userName: '', selfId: '999' });
    const w = a.sent.find((s) => /欢迎/.test(s.text));
    assert.ok(w, '应该发欢迎语');
    assert.ok(w.text.includes('小明'), '用群名片而不是 QQ 号：' + w.text);
    m.close();
  });
  await ta('欢迎语 @ 新成员', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ welcome: { enabled: true, text: '欢迎 {name}', delaySec: 0 } }), adapter: a });
    await m.onNotice({ type: 'group_increase', chatId: '123456', userId: '8888', selfId: '999' });
    const w = a.sent.find((s) => /欢迎/.test(s.text));
    assert.strictEqual(w.opts.at, '8888');
    m.close();
  });
  await ta('自己进群不欢迎自己', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    await m.onNotice({ type: 'group_increase', chatId: '123456', userId: '999', selfId: '999' });
    assert.strictEqual(a.sent.length, 0);
    m.close();
  });
  await ta('welcome.enabled=false 不发', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ welcome: { enabled: false } }), adapter: a });
    await m.onNotice({ type: 'group_increase', chatId: '123456', userId: '8888', selfId: '999' });
    assert.strictEqual(a.sent.length, 0);
    m.close();
  });

  console.log('== 深夜宵禁 ==');
  await ta('在时段内 → 提醒', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ curfew: { enabled: true, from: '00:00', to: '23:59', text: '夜深了 {name}', maxPerNight: 3, gapMin: 0 } }), adapter: a });
    await m.observe(mkMsg({ text: '还没睡' }));
    assert.ok(a.sent.some((s) => /夜深了/.test(s.text)));
    m.close();
  });
  await ta('不在时段 → 不提醒', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ curfew: { enabled: true, from: '03:00', to: '03:01', text: '夜深了 {name}', maxPerNight: 3, gapMin: 0 } }), adapter: a });
    await m.observe(mkMsg({ text: '还没睡' }));
    assert.strictEqual(a.sent.filter((s) => /夜深了/.test(s.text)).length, 0);
    m.close();
  });
  await ta('一晚不超过 maxPerNight', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ curfew: { enabled: true, from: '00:00', to: '23:59', text: '夜深了 {name}', maxPerNight: 2, gapMin: 0 } }), adapter: a });
    for (let i = 0; i < 6; i++) await m.observe(mkMsg({ fromId: String(100 + i), text: 'msg' + i }));
    assert.strictEqual(a.sent.filter((s) => /夜深了/.test(s.text)).length, 2);
    m.close();
  });

  console.log('== 演练模式 ==');
  await ta('shadow 只记录不动手', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg({ shadow: true }), adapter: a });
    const r = await m.observe(mkMsg({ id: '999', text: '加群 123456789 免费领' }));
    assert.strictEqual(r.handled, true, '演练也算拦截（不进模型）');
    assert.strictEqual(a.sent.length, 0, '演练不该发消息');
    assert.strictEqual(a.actions.filter((x) => x.action === 'delete_msg').length, 0, '演练不该删消息');
    m.close();
  });
  await ta('shadow 记录带 [演练] 前缀', async () => {
    const a = mkAdapter({ role: 'admin' });
    const logs = [];
    const m = new Moderation({ getConfig: () => mkCfg({ shadow: true }), adapter: a, log: (t) => logs.push(t) });
    await m.observe(mkMsg({ text: '加群 123456789 免费领' }));
    assert.ok(logs.some((l) => l.includes('[演练]')), logs.join('|'));
    m.close();
  });

  console.log('== 统计 ==');
  await ta('status() 给出六项和计数', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    await m.observe(mkMsg({ text: '加群 123456789 免费领' }));
    const st = m.status();
    assert.strictEqual(st.features.length, 6);
    assert.strictEqual(st.counts.ad, 1);
    assert.ok(st.decisions.length >= 1);
    m.close();
  });
  await ta('decisions 倒序（最新的在前）', async () => {
    const a = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a });
    await m.observe(mkMsg({ text: '加群 123456789 免费领' }));
    await m.observe(mkMsg({ text: '私聊我领取内部资源' }));
    const d = m.decisions(5);
    assert.ok(d.length >= 2, '应该有两条记录，实际 ' + d.length);
    assert.ok(d[0].at >= d[1].at);
    m.close();
  });
  await ta('adapter 换了之后能跟着换', async () => {
    const a1 = mkAdapter({ role: 'admin' });
    const a2 = mkAdapter({ role: 'admin' });
    const m = new Moderation({ getConfig: () => mkCfg(), adapter: a1 });
    m.adapter = a2;
    await m.observe(mkMsg({ text: '加群 123456789 免费领' }));
    assert.strictEqual(a1.sent.length, 0);
    assert.ok(a2.sent.length > 0);
    m.close();
  });

  console.log('');
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
