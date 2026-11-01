'use strict';
/**
 * 发言决策器（共用）
 * ---------------------------------------------------------------------------
 * 一个地方决定「这次该不该说话」，无论触发源是：
 *   - interject：群友发了消息，兴趣命中，想插一句
 *   - initiate ：群里冷场，没人说话，想主动开个头
 *
 * 它不生成文本、不发送消息、不碰模型。只会回一个判决：
 *   { ok, reason, score, gate }
 * 这样「该不该说」和「说什么/怎么发」彻底解耦——
 * 调阈值不用动发送逻辑，换发送实现也不影响安全阀。
 *
 * 为什么不是一个巨大的 if：
 *   两个 kind 的闸门不一样（深夜静默时段不同、白名单语义不同、阈值不同），
 *   写成一个大 if 最后一定会变成「if (kind==='x' && ...) else if (...）」的迷宫。
 *   这里每个闸门是独立函数，按 kind 装配成流水线，加闸门只加一行。
 *
 * 预算必须共享（重要）：
 *   如果 interject 和 initiate 各自有配额，用户实际感知是「说 2 条主动 + 5 条插话」，
 *   也就是一小时内被机器人搭话 7 次——那不是礼貌，是骚扰。
 */

const INTERJECT_REASONS = {
  off: 'AI 未开启',
  disabled: '兴趣回复未开启',
  quiet: '免打扰时段',
  whitelist: '未指定为回复对象',
  lowScore: '兴趣相关度不足',
  budget: '主动发言预算用尽',
  gap: '冷却中',
  backoff: '连续被无视，已自动降频',
  negative: '刚被制止，正在冷静',
  busy: '大脑正忙',
  connected: '前一条还没说完'
};

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const v = (+m[1]) * 60 + (+m[2]);
  return (v >= 0 && v < 1440) ? v : null;
}

/**
 * 取数字配置，允许 0。
 * 不能用 `Number(x) || d`——0 是合法配置（「不设阈值」「不设冷却」），
 * 用 || 会被静默改成默认值，用户改了配置却不生效，最难查的那类 bug。
 */
function num(x, dflt) {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

/** 跨零点时段判断（与 ai.js 的 _inQuiet 同一套语义，别各写一份） */
function inWindow(fromStr, toStr, now = new Date()) {
  const from = parseHM(fromStr);
  const to = parseHM(toStr);
  if (from === null || to === null || from === to) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

class SpeakPolicy {
  /**
   * @param {object} opts
   * @param {()=>object} opts.getConfig
   * @param {import('./interest').InterestProfile} opts.interest
   * @param {import('./memory-store').MemoryStore} opts.memory
   * @param {(evt:object)=>void} [opts.broadcast]
   */
  constructor({ getConfig, interest, memory, broadcast }) {
    this.getConfig = getConfig;
    this.interest = interest;
    this.memory = memory;
    this.broadcast = typeof broadcast === 'function' ? broadcast : () => {};
    /** 共享预算：时间戳环形数组，两个 kind 都用它 */
    this._sent = [];
    /** chatKey -> {consecutive, backoff, lastAt} */
    this._ignore = new Map();
    /** chatKey -> 冷静到期时间戳（负反馈熔断） */
    this._muteUntil = new Map();
    /** chatKey -> 最后一次来信时间（冷场判定） */
    this._lastInboundAt = new Map();
    /** 最近的判决，面板用（限制长度，别无限涨） */
    this._decisions = [];
  }

  get cfg() { return this.getConfig() || {}; }
  get aiCfg() { return this.cfg.ai || {}; }
  get interestCfg() { return this.cfg.interest || {}; }
  get proactiveCfg() { return this.cfg.proactive || {}; }
  get replyCfg() { return this.cfg.interestReply || {}; }

  /* ---------------- 外部信号 ---------------- */

  notifyInbound(chatKey) {
    this._lastInboundAt.set(String(chatKey), Date.now());
    // 有人说话 = 上一轮「被无视」的计数中断，但还是要求连续 2 次才完全复位
    this._noteInterrupted(String(chatKey));
  }

  lastInboundAt(chatKey) {
    return this._lastInboundAt.get(String(chatKey)) || 0;
  }

  /** 发出去一条（不管 interject 还是 initiate），记进共享预算 */
  noteSent(chatKey, kind) {
    const now = Date.now();
    this._sent.push({ at: now, chatKey: String(chatKey), kind });
    // 只留最近 24h 的，防止数组无限涨
    const cutoff = now - 86400000;
    while (this._sent.length && this._sent[0].at < cutoff) this._sent.shift();
  }

  /** 有人对机器人说的话有反应 → 退避完全复位 */
  notePicked(chatKey) {
    const st = this._ignore.get(String(chatKey));
    if (st) { st.consecutive = 0; st.backoff = 1; }
  }

  /** 连发了消息但没人理 → 连击 +1 */
  noteIgnored(chatKey) {
    const key = String(chatKey);
    const st = this._ignore.get(key) || { consecutive: 0, backoff: 1, lastAt: 0 };
    st.consecutive += 1;
    // 1→1, 2→2, 3→4, 4→8, 5→8（封顶 8 倍间隔）
    st.backoff = Math.min(8, Math.pow(2, Math.max(0, st.consecutive - 1)));
    st.lastAt = Date.now();
    this._ignore.set(key, st);
  }

  _noteInterrupted(chatKey) {
    const st = this._ignore.get(String(chatKey));
    if (!st) return;
    // 有人在自己说话之后发言 = 至少不是纯无视，连击减半而不是清零
    st.consecutive = Math.max(0, st.consecutive - 1);
    st.backoff = Math.min(8, Math.pow(2, Math.max(0, st.consecutive - 1)));
  }

  /** 负反馈熔断：有人骂「别刷了」→ 静音一段时间 */
  triggerNegative(chatKey, matchedText) {
    const mins = 30;
    this._muteUntil.set(String(chatKey), Date.now() + mins * 60000);
    this.noteIgnored(chatKey);
    this.noteIgnored(chatKey);   // 一次骂 = 连击 +2，降频立刻生效
    console.log(`[发言] 检测到负反馈「${String(matchedText || '').slice(0, 20)}」→ ${chatKey} 静音 ${mins} 分钟`);
    this.broadcast({ type: 'proactive_skipped', chatKey, reason: '负反馈熔断', at: Date.now() });
  }

  isMuted(chatKey) {
    const until = this._muteUntil.get(String(chatKey)) || 0;
    return until > Date.now();
  }

  /* ---------------- 判决 ---------------- */

  /**
   * 主入口。
   * @param {object} req
   * @param {'interject'|'initiate'} req.kind
   * @param {object} [req.msg]       interject 时的来信
   * @param {string} req.chatKey
   * @param {string} [req.text]      用来算相关性的文本（interject 默认取 msg.text）
   * @param {number} [req.now]
   * @returns {{ok:boolean, reason?:string, score:number, gate?:string, kind:string, chatKey:string, grams?:string[]}}
   */
  verdict({ kind, msg, chatKey, text, now = Date.now() }) {
    const key = String(chatKey || '');
    const cfg = this.cfg;
    const scoreInfo = this.interest
      ? this.interest.score(key, text != null ? text : (msg ? String(msg.text || '') : ''))
      : { score: 0, grams: [], hits: [] };
    const base = { kind, chatKey: key, score: Number(scoreInfo.score.toFixed(3)), grams: scoreInfo.grams };

    // 闸门按顺序执行，第一个不通过的即为「判决理由」。
    // 顺序有意义：先便宜且必定的（开关/时段），最后才是要花钱的（要看大脑状态）。
    const gates = kind === 'initiate'
      ? [this._gInitiateEnabled, this._gInitiateNight, this._gInitiateWhitelist, this._gInitiateSettle,
         this._gScore, this._gMute, this._gBudget, this._gGap, this._gBackoff]
      : [this._gInterjectEnabled, this._gInterjectQuiet, this._gScore, this._gMute, this._gBudget,
         this._gGap, this._gBackoff];

    for (const gate of gates) {
      const r = gate.call(this, { kind, key, msg, text, now, scoreInfo });
      if (r) {
        const decision = { ...base, ok: false, reason: r.reason, gate: gate.name };
        this._record(decision);
        this._announce(decision, now);
        return decision;
      }
    }
    const decision = { ...base, ok: true };
    this._record(decision);
    this._announce(decision, now);
    return decision;
  }

  /**
   * 对外广播判决。
   * 这个函数对**每一条**非 @ 群消息都会被调用一次，而前端收到 speak_decision 会立刻
   * 发一次 HTTP 请求刷新面板。活跃群里一秒几十条消息 = 几十个请求，
   * 浏览器会被自己的面板拖死。所以这里必须限流：
   *   - 拦下的判决：同一 chatKey 同一 reason 每 10 秒最多广播一次（面板看到的是
   *     「它现在为什么不说」，不是逐条流水账）
   *   - 通过的判决：永远广播（这是真事件，不能丢）
   */
  _announce(decision, now) {
    try {
      if (!decision.ok) {
        if (!this._announceAt) this._announceAt = new Map();
        const k = `${decision.chatKey}|${decision.reason}`;
        const last = this._announceAt.get(k) || 0;
        if (now - last < 10000) return;
        this._announceAt.set(k, now);
        // 顺手清理过期键，避免被无限多个不同的 reason 撑大
        if (this._announceAt.size > 500) {
          for (const [kk, at] of this._announceAt) if (now - at > 60000) this._announceAt.delete(kk);
        }
      }
      this.broadcast({ type: 'speak_decision', ...decision, at: now });
    } catch { /* 广播失败不影响判决 */ }
  }

  /** 闸门实现：返回 null = 通过；返回 {reason} = 拦下 */

  _gInterjectEnabled() {
    if (!this.aiCfg.enabled) return { reason: INTERJECT_REASONS.off };
    if (this.replyCfg.enabled === false) return { reason: INTERJECT_REASONS.disabled };
    return null;
  }

  /** 插话沿用 AI 自己的免打扰时段（23:00-08:00），不另开一套 */
  _gInterjectQuiet({ now }) {
    const c = this.aiCfg;
    if (!c.quietEnabled) return null;
    if (inWindow(c.quietFrom || '23:00', c.quietTo || '08:00', new Date(now))) return { reason: INTERJECT_REASONS.quiet };
    return null;
  }

  _gInitiateEnabled() {
    if (!this.aiCfg.enabled) return { reason: INTERJECT_REASONS.off };
    if (this.proactiveCfg.enabled !== true) return { reason: '主动发言未开启' };
    return null;
  }

  /**
   * 主动开头的静默时段比插话更严（00:00-09:00）。
   * 插话是回应别人，夜里回一句还能接受；主动开口是打扰，夜里绝对不行。
   */
  _gInitiateNight({ now }) {
    const c = this.proactiveCfg;
    if (inWindow(c.nightFrom || '00:00', c.nightTo || '09:00', new Date(now))) return { reason: '夜间静默' };
    return null;
  }

  /**
   * 白名单语义故意不对称：
   *   interject 留空 = 不限（跟着 ai.targetChatKeys 走）
   *   initiate 留空 = 全部不主动（主动开口必须显式授权，默认闭嘴）
   */
  _gInitiateWhitelist({ key }) {
    const list = Array.isArray(this.proactiveCfg.targetChatKeys) ? this.proactiveCfg.targetChatKeys.filter(Boolean) : [];
    if (!list.length) return { reason: '未指定主动发言的群' };
    if (!list.includes(key)) return { reason: '未指定主动发言的群' };
    return null;
  }

  /** 冷场：最后一条来信之后要安静够久（默认 25 分钟），否则就是抢话 */
  _gInitiateSettle({ key, now }) {
    const idleMin = Math.max(1, num(this.proactiveCfg.idleMin, 25));
    const last = this._lastInboundAt.get(key) || 0;
    if (!last) return { reason: '这个会话还没聊过' };
    if (now - last < idleMin * 60000) return { reason: '群里正在聊别的' };
    return null;
  }

  /** 相关性阈值：主动开口要求更高（0.65 vs 0.55）。0 表示不设门槛，必须生效 */
  _gScore({ kind, scoreInfo }) {
    const th = kind === 'initiate'
      ? num(this.proactiveCfg.initiateThreshold, num(this.interestCfg.initiateThreshold, 0.65))
      : num(this.replyCfg.threshold, num(this.interestCfg.interjectThreshold, 0.55));
    if (scoreInfo.score < th) return { reason: INTERJECT_REASONS.lowScore };
    return null;
  }

  _gMute({ key }) {
    if (this.isMuted(key)) return { reason: INTERJECT_REASONS.negative };
    return null;
  }

  /** 共享预算：两个 kind 用同一个池子 */
  _gBudget({ kind, now }) {
    const c = this.proactiveCfg;
    const maxHour = Math.max(1, num(c.maxPerHour, 2));
    const maxDay = Math.max(1, num(c.maxPerDay, 8));
    const hourAgo = now - 3600000;
    const dayAgo = now - 86400000;
    const inHour = this._sent.filter((s) => s.at >= hourAgo).length;
    const inDay = this._sent.filter((s) => s.at >= dayAgo).length;
    // 插话占用 1，主动占用 1（都算「机器人主动说话」）
    if (inHour >= maxHour) return { reason: INTERJECT_REASONS.budget };
    if (inDay >= maxDay) return { reason: INTERJECT_REASONS.budget };
    void kind;
    return null;
  }

  /** 最小间隔（含退避倍数）。minGapMs=0 表示不限，必须真的生效 */
  _gGap({ key, now }) {
    const c = this.proactiveCfg;
    const base = Math.max(0, num(c.minGapMs, 1200000));
    if (!base) return null;
    const st = this._ignore.get(key);
    const backoff = st ? (st.backoff || 1) : 1;
    const gap = base * backoff;
    const last = this._sent.filter((s) => s.chatKey === key).pop();
    if (last && now - last.at < gap) return { reason: INTERJECT_REASONS.gap };
    return null;
  }

  _gBackoff({ key }) {
    const st = this._ignore.get(key);
    if (st && st.consecutive >= 3) return { reason: INTERJECT_REASONS.backoff };
    return null;
  }

  _record(d) {
    this._decisions.push(d);
    if (this._decisions.length > 200) this._decisions.splice(0, this._decisions.length - 200);
  }

  decisions(limit = 50) {
    return this._decisions.slice(-limit).reverse();
  }

  state() {
    const now = Date.now();
    return {
      sentHour: this._sent.filter((s) => s.at >= now - 3600000).length,
      sentDay: this._sent.filter((s) => s.at >= now - 86400000).length,
      ignored: [...this._ignore.entries()].map(([chatKey, s]) => ({
        chatKey, consecutive: s.consecutive, backoff: s.backoff
      })),
      muted: [...this._muteUntil.entries()].filter(([, until]) => until > now)
        .map(([chatKey, until]) => ({ chatKey, remainMin: Math.ceil((until - now) / 60000) })),
      recent: this.decisions(20)
    };
  }

  /**
   * 拼进提示词的「发言约束」段。
   * 目的不是让模型更聪明，是让它知道「什么时候闭嘴」——
   * 模型天然倾向多说话，不写这段它会把每句群聊都当成邀约。
   */
  promptBlock(chatKey) {
    if (!this.interest) return '';
    const words = this.interest.topWords(chatKey, 6);
    if (!words.length) return '';
    return [
      '【群聊背景】',
      `这个群最近聊得比较多的是：${words.join('、')}。`,
      '你不需要对每条消息都回应。只有当你确实有具体内容可说时才开口；',
      '没有真东西可说时，保持沉默比硬接一句更自然。',
      '不要在回复里提到「记忆」「记录」「系统」这些词。'
    ].join('\n');
  }
}

module.exports = { SpeakPolicy, inWindow, INTERJECT_REASONS };
