'use strict';
/**
 * 记忆抽取
 * ---------------------------------------------------------------------------
 * 只干一件事：观察消息流，攒够一批后产出「记忆候选」交给 MemoryStore。
 * 它绝不发消息、绝不改配置、绝不碰模型——
 * 所以整个长期记忆系统即使完全坏掉，用户也只会感觉「它好像记性不好」，
 * 不会出现「机器人突然乱说话」。这是先把记忆做成第一块的原因。
 *
 * 抽取两档：
 *   1) 规则档（永远开着，零成本）：自报家门、偏好、约定时间、群梗…
 *      命中率高但保守，宁缺毋滥——抽错的记忆比没有记忆更糟。
 *   2) 模型档（可选，默认关）：一批消息丢给大脑总结成结构化条目。
 *      默认关的原因：它要抢大脑，而大脑是单飞的（deepseek-web.js 的 _busy）。
 */
const { normalizeText } = require('./memory-store');

/** 规则库：每条 = 一个正则 + 产出（type 用于判 kind 与置信度） */
const RULES = [
  // 「我叫」「我是」——最容易误抓，排除「我是说/我是真的」这类口语
  { re: /我叫\s*([一-鿿A-Za-z0-9_]{1,12})/, type: 'fact', conf: 0.9, subject: 'self' },
  { re: /我是\s*(?:个|一名|一个)?\s*([一-鿿A-Za-z0-9_]{2,16})(?=[，。！？,.!?\s]|$)/, type: 'fact', conf: 0.55, subject: 'self' },
  // 允许「我」和「喜欢」之间插副词：「我最近喜欢上了骑行」「我特别喜欢打游戏」
  // ——紧邻写法漏掉了口语里最常见的一类自述。
  { re: /我[^，。！？,.!?\s]{0,6}?(?:最喜欢|最爱|喜欢|爱)([了过])?(?:吃|玩|看|听|喝|上|做|搞)?\s*([一-鿿A-Za-z0-9_]{2,16})/, type: 'pref', conf: 0.75, subject: 'self' },
  { re: /我[^，。！？,.!?\s]{0,6}?(?:讨厌|不喜欢|受不了|恶心)([了过])?\s*([一-鿿A-Za-z0-9_]{2,16})/, type: 'pref', conf: 0.75, subject: 'self' },
  { re: /我(?:在|住在|人在)\s*([一-鿿A-Za-z0-9_]{2,12})(?=[，。！？,.!?\s]|$)/, type: 'fact', conf: 0.6, subject: 'self' },
  { re: /我(?:在做|在弄|在写|在学|在研究|在搞)\s*([一-鿿A-Za-z0-9_]{2,20})/, type: 'fact', conf: 0.7, subject: 'self' },
  { re: /我(?:养了|有)(?:一)?(?:只|条|个)\s*([一-鿿A-Za-z0-9_]{1,10})/, type: 'fact', conf: 0.8, subject: 'self' },
  { re: /(?:明天|后天|周末|下周[一二三四五六日天]?)\s*(?:要|得|会)?\s*([一-鿿A-Za-z0-9_]{2,20})/, type: 'event', conf: 0.5, subject: 'when' },
  { re: /(?:最后|结论|决定)(?:是|就)?\s*([一-鿿A-Za-z0-9_，,。.]{2,40})/, type: 'event', conf: 0.6, subject: 'conclusion' },
  { re: /(?:以后|从今往后|下次)(?:就)?\s*([一-鿿A-Za-z0-9_]{2,30})/, type: 'event', conf: 0.5, subject: 'conclusion' }
];

/** 太短 / 纯表情 / 纯链接的消息不抽——它们进记忆只会变噪音 */
function worthObserving(text) {
  const t = String(text || '').trim();
  if (t.length < 6) return false;
  // 陷阱：JS 正则里 \W 是「非 ASCII 单词字符」，汉字全部落在 \W 里，
  // 所以 /^[\d\s\W_]+$/ 对任何一句话中文都成立——
  // 用它判「没内容」会把所有中文消息判成噪音，长期记忆一条都抽不出来，而且完全静默。
  // 正确写法：只判「标点 / 符号 / 数字 / 空白」这些确实没有语义的东西。
  if (/^[\d\s\p{P}\p{S}]+$/u.test(t)) return false;
  if (/^https?:\/\//.test(t)) return false;
  return true;
}

class MemoryExtractor {
  /**
   * @param {object} opts
   * @param {import('./memory-store').MemoryStore} opts.memory
   * @param {()=>object} opts.getConfig
   * @param {(evt:object)=>void} [opts.broadcast]
   */
  constructor({ memory, getConfig, broadcast }) {
    this.memory = memory;
    this.getConfig = getConfig;
    this.broadcast = typeof broadcast === 'function' ? broadcast : () => {};
    /** chatKey -> 待处理的观察（只留最近若干条，避免内存涨） */
    this._buffer = new Map();
  }

  get cfg() {
    return (this.getConfig() || {}).memory || {};
  }

  enabled() {
    return this.cfg.enabled !== false;
  }

  /**
   * 观察一条消息。必须同步、廉价、绝不抛错——
   * 它挂在 onAdapterEvent 的主链路上，抛一次就可能吞掉一条真实消息。
   */
  observe(msg) {
    try {
      if (!this.enabled()) return;
      if (!msg || msg.self || msg.system) return;      // 自己说的话不算记忆
      const cfg = this.cfg;
      if (cfg.autoExtract === false) return;
      const text = String(msg.text || '');
      if (!worthObserving(text)) return;

      const chatKey = `${msg.chatType}:${msg.chatId}`;
      const scope = this.scopeOf(msg);
      let b = this._buffer.get(chatKey);
      if (!b) { b = []; this._buffer.set(chatKey, b); }
      b.push({
        scope,
        text: normalizeText(text),
        fromId: String(msg.fromId || ''),
        fromName: String(msg.fromName || ''),
        id: msg.id || '',
        time: msg.time || Date.now()
      });
      // 只留最近 200 条待处理，防止长时间跑着把内存吃掉
      if (b.length > 200) b.splice(0, b.length - 200);

      const every = Math.max(5, Number(cfg.digestEvery) || 40);
      if (b.length >= every) this.flush(chatKey);
    } catch { /* 记忆链路永不影响主流程 */ }
  }

  /** 记忆归属：群按群、私聊按人，群里的事实也记在群里（不跨群串味） */
  scopeOf(msg) {
    return `${msg.chatType}:${msg.chatId}`;
  }

  /** 一批消息 → 若干条记忆。规则档。 */
  extractFrom(items) {
    const out = [];
    for (const it of items) {
      const text = it.text;
      for (const rule of RULES) {
        const m = rule.re.exec(text);
        if (!m) continue;
        // 命中词固定取最后一个捕获组：前面若有权态的「了/过」之类可选中缀，
        // 写死 m[1] 会把「了」当成「我喜欢的东西」存进记忆。
        const hit = String(m[m.length - 1] || '').trim();
        if (!hit || hit.length < 2) continue;
        // 「我是谁」「我喜欢什么」这种带疑问的不算陈述
        if (/[?？]/.test(text)) continue;
        const entity = rule.subject === 'self'
          ? (it.fromName ? `「${it.fromName}」` : '')
          : '';
        out.push({
          scope: it.scope,
          kind: rule.type,
          subject: rule.subject === 'self' ? `u:${it.fromId}` : `topic:${rule.subject}`,
          text: entity ? `${entity}${statementOf(it.text)}` : statementOf(it.text),
          conf: rule.conf,
          origin: 'auto',
          sourceIds: it.id ? [it.id] : [],
          fromId: it.fromId
        });
        break;   // 一条消息只产一条记忆，避免同一句话被多条规则重复固化
      }
    }
    return out;
  }

  /**
   * 处理缓冲区。
   * @param {string} [chatKey] 不给 = 全部会话
   * @returns {number} 写入条数
   */
  flush(chatKey) {
    if (!this.enabled()) return 0;
    const keys = chatKey ? [chatKey] : [...this._buffer.keys()];
    let written = 0;
    for (const key of keys) {
      const items = this._buffer.get(key) || [];
      if (!items.length) continue;
      this._buffer.set(key, []);
      try {
        for (const cand of this.extractFrom(items)) {
          const { item, merged } = this.memory.upsert(cand);
          if (!item) continue;
          written++;
          this.broadcast({
            type: 'memory_written',
            merged,
            item: { id: item.id, scope: item.scope, kind: item.kind, text: item.text, weight: item.weight },
            at: Date.now()
          });
        }
      } catch (err) {
        console.warn('[记忆] 抽取失败（已忽略）:', err.message);
      }
    }
    if (written) console.log(`[记忆] 本轮写入 ${written} 条`);
    return written;
  }

  /** 定时器入口：定期强制处理一次，别让最后一批消息一直躺在缓冲里 */
  tick() {
    try {
      if (!this.enabled()) return 0;
      return this.flush();
    } catch { return 0; }
  }

  /** 面板/诊断用 */
  state() {
    const buffered = [...this._buffer.entries()].map(([chatKey, arr]) => ({ chatKey, pending: arr.length }));
    return {
      enabled: this.enabled(),
      autoExtract: this.cfg.autoExtract !== false,
      digestEvery: Math.max(5, Number(this.cfg.digestEvery) || 40),
      buffered: buffered.reduce((n, b) => n + b.pending, 0),
      chats: buffered.filter((b) => b.pending > 0)
    };
  }
}

/** 把口语压成陈述句：去掉语气词尾巴，避免把「我养了只猫哈哈哈」整句记下来 */
function statementOf(text) {
  return String(text)
    .replace(/[哈嘿嘻]+$/g, '')
    .replace(/[~～。！!，,]{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

module.exports = { MemoryExtractor, RULES, worthObserving };
