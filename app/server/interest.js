'use strict';
/**
 * 兴趣画像
 * ---------------------------------------------------------------------------
 * 只负责「这个群最近对什么感兴趣」和「这句话跟兴趣有多相关」，不做任何决策。
 * 决策在 speak-policy.js——分开的好处是：调阈值不用碰打分，改算法不用碰闸门。
 *
 * 权重只记在 gram（二元组）上，不建主题词库：
 *   主题词库要靠人维护，一改产品就要跟着改；gram 从聊天里长出来，
 *   用户聊什么它就学什么，「机械键盘」「显卡」「考研」自己会浮上来。
 *
 * 信号方向不对称（故意）：负向比正向狠。
 *   有人接话 +0.15，无人接话 −0.20——
 *   因为「说错话」的代价远大于「少说一句」。
 */
const { bigrams } = require('./memory-store');

const MAX_GRAMS_PER_SCOPE = 4000;

class InterestProfile {
  /**
   * @param {object} opts
   * @param {()=>object} opts.getConfig
   * @param {(evt:object)=>void} [opts.broadcast]
   */
  constructor({ getConfig, broadcast }) {
    this.getConfig = getConfig;
    this.broadcast = typeof broadcast === 'function' ? broadcast : () => {};
    /** @type {Map<string, Map<string, number>>} chatKey -> gram -> weight */
    this._interest = new Map();
    /** @type {Set<string>} 能力词：机器人「会」的话题，默认从配置来 */
    this._capability = new Set();
    /** chatKey -> 最近一次机器人发言（等接话结果用） */
    this._lastBotAt = new Map();
    this._seedCapability();
  }

  get cfg() {
    return (this.getConfig() || {}).interest || {};
  }

  enabled() {
    return this.cfg.enabled !== false;
  }

  _seedCapability() {
    this._capability.clear();
    const list = Array.isArray(this.cfg.capabilities) && this.cfg.capabilities.length
      ? this.cfg.capabilities
      : ['编程', '电脑', '游戏', '番剧', '学习', '做饭', '数码'];
    for (const w of list) {
      for (const g of bigrams(String(w))) this._capability.add(g);
    }
  }

  _bucket(chatKey) {
    let m = this._interest.get(chatKey);
    if (!m) { m = new Map(); this._interest.set(chatKey, m); }
    return m;
  }

  /* ---------------- 学习信号 ---------------- */

  /**
   * 群友发言：频次是弱信号，+0.01 每次，上限 2.0。
   * 只靠频次会把「在吗」「哈哈哈」也学成兴趣，所以上限压得低，
   * 真正抬权重的是「有人接话」。
   */
  observeMessage(msg) {
    try {
      if (!this.enabled()) return;
      if (!msg || msg.self || msg.system) return;
      if (msg.chatType !== 'group') return;      // 兴趣画像只对群有意义
      const text = String(msg.text || '');
      if (text.length < 6) return;
      const chatKey = `${msg.chatType}:${msg.chatId}`;
      const bucket = this._bucket(chatKey);
      for (const g of bigrams(text)) {
        const cur = bucket.get(g) || 0;
        if (cur < 2) bucket.set(g, cur + 0.01);
      }
      this._trim(chatKey);
    } catch { /* noop */ }
  }

  /** 有人 @ 机器人：说明这个话题跟机器人强相关，+0.30 */
  observeMention(msg) {
    try {
      if (!this.enabled() || !msg || msg.chatType !== 'group') return;
      const chatKey = `${msg.chatType}:${msg.chatId}`;
      const bucket = this._bucket(chatKey);
      for (const g of bigrams(String(msg.text || ''))) {
        bucket.set(g, Math.min(2, (bucket.get(g) || 0) + 0.30));
      }
      this._trim(chatKey);
    } catch { /* noop */ }
  }

  /** 机器人刚发过言：记下时间，之后 2 分钟内有人说话 = 被接话 */
  markBotSpoke(chatKey) {
    this._lastBotAt.set(String(chatKey), Date.now());
  }

  /**
   * 机器人发言后有人发消息 → 判定「接话」还是「无视」。
   * 窗口：2 分钟内算接话（+0.15），10 分钟仍无人接算无视（−0.20）。
   * @returns {'picked'|'ignored'|null}
   */
  settleBotSpeak(chatKey, topicGrams) {
    try {
      const at = this._lastBotAt.get(String(chatKey));
      if (!at) return null;
      const dt = Date.now() - at;
      if (dt > 10 * 60 * 1000) { this._lastBotAt.delete(String(chatKey)); return null; }
      const bucket = this._bucket(String(chatKey));
      // 2 分钟内有人说话 → 接话
      if (dt <= 2 * 60 * 1000) {
        for (const g of topicGrams || []) bucket.set(g, Math.min(2, (bucket.get(g) || 0) + 0.15));
        this._lastBotAt.delete(String(chatKey));
        return 'picked';
      }
      // 2~10 分钟：还没到判无视的时候，保持观察（返回 null 不清时间戳）
      return null;
    } catch { return null; }
  }

  /** 超时判定无视：由 proactive 的定时器调用 */
  expireBotSpeak(chatKey, topicGrams) {
    try {
      const key = String(chatKey);
      const at = this._lastBotAt.get(key);
      if (!at) return false;
      if (Date.now() - at < 10 * 60 * 1000) return false;
      const bucket = this._bucket(key);
      for (const g of topicGrams || []) bucket.set(g, Math.max(-1, (bucket.get(g) || 0) - 0.20));
      this._lastBotAt.delete(key);
      return true;
    } catch { return false; }
  }

  /** 人工标记群梗/兴趣：直接锁到 2.0，压过一切自动学习 */
  seed(chatKey, words) {
    const bucket = this._bucket(String(chatKey));
    const list = Array.isArray(words) ? words : String(words || '').split(/[,，\s]+/);
    let n = 0;
    for (const w of list) {
      const clean = String(w || '').trim();
      if (!clean) continue;
      for (const g of bigrams(clean)) { bucket.set(g, 2.0); n++; }
    }
    console.log(`[兴趣] 人工标记 ${chatKey}: ${list.filter(Boolean).join('/')}（${n} 个 gram）`);
    return n;
  }

  /** 每日轻微衰减：不衰减的话老兴趣会永远霸榜，新话题永远上不来 */
  decay() {
    const rate = Math.max(0, Math.min(0.2, Number(this.cfg.profileDecayPerDay) || 0.02));
    if (!rate) return;
    for (const bucket of this._interest.values()) {
      for (const [g, w] of bucket) {
        const next = w * (1 - rate);
        if (Math.abs(next) < 0.02) bucket.delete(g);
        else bucket.set(g, next);
      }
    }
  }

  _trim(chatKey) {
    const bucket = this._interest.get(String(chatKey));
    if (!bucket || bucket.size <= MAX_GRAMS_PER_SCOPE) return;
    const sorted = [...bucket.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    this._interest.set(String(chatKey), new Map(sorted.slice(0, MAX_GRAMS_PER_SCOPE)));
  }

  /* ---------------- 打分 ---------------- */

  /**
   * 相关性：消息里有多少比例的 token 是这个群聊过的，以及这些话题有多热。
   *
   * 校准说明（踩过的坑）：
   *   原先 `sum / sqrt(n) * 0.35`，而频次学习每次才 +0.01、要 200 次才到上限 2.0，
   *   真实群聊里话题权重就在 0.1~0.5 徘徊 → 算出来永远 0.1~0.3，
   *   而阈值是 0.55，**这个功能上线后一次都不会触发**。
   *   现在改成「覆盖率 × 强度」两段：
   *     coverage = 命中 gram 占全部 gram 的比例（这句有多贴这个群）
   *     strength = 平均权重 / 0.5（这个兴趣有多热，0.5 视为「足够热」）
   *   两边都开方，避免单个高频词一票通过。
   *
   * @returns {{score:number, grams:string[], hits:Array<{gram:string,weight:number}>}}
   */
  score(chatKey, text) {
    const empty = { score: 0, grams: [], hits: [] };
    try {
      if (!this.enabled()) return empty;
      const bucket = this._interest.get(String(chatKey));
      const grams = [...bigrams(text)];
      if (!grams.length) return empty;
      let sum = 0;
      const hits = [];
      let capHit = 0;
      for (const g of grams) {
        const w = bucket ? (bucket.get(g) || 0) : 0;
        if (w > 0) { sum += w; hits.push({ gram: g, weight: w }); }
        if (this._capability.has(g)) capHit++;
      }
      if (!hits.length && !capHit) return { score: 0, grams, hits: [] };
      const coverage = hits.length / grams.length;
      const avgW = hits.length ? sum / hits.length : 0;
      const strength = Math.min(1, avgW / 0.5);
      // 主项看覆盖率（贴不贴题），强度做加权（聊得热不热）
      const base = 0.70 * Math.sqrt(coverage) + 0.30 * Math.sqrt(strength);
      // 能力命中率加成：命中的是机器人真能聊的话题，最多 +0.15
      const capBonus = Math.min(0.15, (capHit / grams.length) * 0.30);
      hits.sort((a, b) => b.weight - a.weight);
      return {
        score: Math.max(0, Math.min(1, base + capBonus)),
        grams,
        hits: hits.slice(0, 8)
      };
    } catch { return empty; }
  }

  /** 面板用：这个群最热的 N 个话题 */
  profile(chatKey, topN = 20) {
    const bucket = this._interest.get(String(chatKey));
    if (!bucket) return { chatKey, isEmpty: true, top: [] };
    const top = [...bucket.entries()]
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([gram, weight]) => ({ gram, weight: Number(weight.toFixed(3)) }));
    return { chatKey, isEmpty: false, size: bucket.size, top };
  }

  /** 当前画像里最强的几个词，给提示词用 */
  topWords(chatKey, n = 6) {
    return this.profile(chatKey, n).top.map((x) => x.gram);
  }

  stats() {
    let total = 0;
    for (const b of this._interest.values()) total += b.size;
    return {
      scopes: this._interest.size,
      grams: total,
      capabilities: [...this._capability].length
    };
  }
}

/** 反查已删除：_trim 现在直接收 chatKey，不再需要反向索引 */

module.exports = { InterestProfile };
