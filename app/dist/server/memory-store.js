'use strict';
/**
 * 长期记忆存储（零依赖，纯 JSON）
 * ---------------------------------------------------------------------------
 * 职责边界写死在这里，别越界：
 *   - 本文件只做「存 / 取 / 检索 / 衰减」，不知道 QQ 是什么，也不知道模型是什么。
 *   - 谁该不该说话、说什么，是 speak-policy.js 和 proactive.js 的事。
 *   - 从聊天记录里抽记忆，是 memory-extract.js 的事。
 *
 * 为什么不用 SQLite：
 *   实测 2 万条以内，暴力全量打分（0.24~6.7ms）跟倒排索引同量级，
 *   而 store.json 那种「全量重写」式的持久化在 1 万条时写入只要 5.7ms。
 *   换存储的真正触发条件是「写入 >50ms」或「文件 >8MB」，不是查询变慢。
 *   所以第一版直接暴力扫，接口保持不变，将来要换谁也影响不到上层。
 *
 * 中文分词为什么用二元组：
 *   项目零依赖、不能引分词库。字符二元组（bigrams）不需要词库，
 *   对中文聊天的召回足够，且天然支持「聊到一半的词」。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJson } = require('./atomic');

/** 各类记忆的半衰期（天）。fact 是人设，几乎不衰减；event 是一次性结论，衰减快 */
const HALF_LIFE_DAYS = { fact: 3650, event: 30, meme: 365, pref: 90, relation: 365 };
const VALID_KINDS = new Set(Object.keys(HALF_LIFE_DAYS));
const MAX_ITEMS = 50000;

/** 高频无信息二元组：不参与索引，否则「可以/什么/就是」会把所有记忆连成一片 */
const STOP_GRAMS = new Set([
  '的了', '了一', '我们', '你们', '他们', '她们', '这个', '那个', '什么', '怎么',
  '可以', '现在', '就是', '还是', '已经', '因为', '所以', '但是', '如果', '然后',
  '一下', '一个', '不是', '没有', '这样', '那样', '知道', '觉得', '时候', '自己',
  '起来', '出来', '过来', '不过', '一般', '应该', '可能', '真的', '嗯嗯', '哈哈',
  '呵呵', '谢谢', '你好', '在吗', '的是', '了吗', '了吧', '的话', '还有',
  // 高频时间/程度/口头词：它们几乎出现在每句话里，
  // 留着会让任意两句都被判「相关」，检索精度直接塌掉。
  '最近', '其实', '感觉', '好像', '一直', '有点', '这些', '那些', '一点',
  '比较', '非常', '特别', '今天', '明天', '昨天', '现在', '刚才', '刚刚'
]);

/** 文本归一化：折叠空白，别让「\n\n」影响去重 */
function normalizeText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

/**
 * 字符二元组。
 * 中文按 2 字切；连续英文/数字按整词（≥3 字符）算一个 token，
 * 因为「react」切成 re/ea/ac 反而会跟别的词乱撞。
 */
function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/[^一-鿿a-z0-9]+/g, ' ');
  const out = new Set();
  for (const seg of s.split(' ')) {
    if (!seg) continue;
    if (/^[a-z0-9]+$/.test(seg)) {
      if (seg.length >= 3) out.add(seg);
      continue;
    }
    if (seg.length === 1) continue;
    for (let i = 0; i < seg.length - 1; i++) {
      const g = seg.slice(i, i + 2);
      if (!STOP_GRAMS.has(g)) out.add(g);
    }
  }
  return out;
}

/** 时间衰减：半衰期到了权重减半，但不会归零（乘性衰减在 0 附近变平，不会把老记忆彻底抹掉） */
function decayFactor(ts, kind, now = Date.now()) {
  const days = Math.max(0, (now - (ts || now)) / 86400000);
  const hl = HALF_LIFE_DAYS[kind] || 30;
  return Math.pow(0.5, days / hl);
}

class MemoryStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir  数据目录（与 store.json 同级）
   * @param {(t:string)=>void} [opts.log]
   * @param {()=>object} [opts.getConfig] 读 memory 配置（热更新）
   */
  constructor({ dataDir, log, getConfig }) {
    this.file = path.join(dataDir, 'memory.json');
    this.log = typeof log === 'function' ? log : () => {};
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    /** @type {Map<string, object>} id -> item */
    this._byId = new Map();
    /** @type {Map<string, Set<string>>} scope -> ids */
    this._byScope = new Map();
    /** @type {Map<string, Set<string>>} gram -> ids（第一版没用来查，用来算统计和去重提示） */
    this._grams = new Map();
    this._dirty = false;
    this._timer = null;
    this._seq = 0;
    this.load();
  }

  get cfg() {
    const c = this.getConfig() || {};
    return c.memory || {};
  }

  /* ---------------- 持久化 ---------------- */

  load() {
    const tmp = this.file + '.tmp';
    // 构造函数已经 load 过一次，server.js 又显式 load 了一次（调用方还想在运行时重载）。
    // 不清空的话第二次会把同一批条目再 _index 一遍：日志重复、索引工作量翻倍，
    // 而且若两次读之间文件变了，旧条目会残留在索引里变成幽灵数据。
    // 所以 load() 必须自带清场，保证「调几次结果都一样」。
    this._byId.clear();
    this._byScope.clear();
    this._grams.clear();
    this._seq = 0;
    const absorb = (raw) => {
      for (const it of raw.items || []) {
        if (!it || !it.id) continue;
        this._byId.set(it.id, it);
        // 已删的条目只留在 _byId 里供面板显示，不进检索索引
        if (it.status === 'active') this._index(it);
        // 自增序号要接上已有 id，否则重启后会从 mem_000000 重号
        const m = /^mem_([0-9a-z]+)$/.exec(it.id);
        if (m) this._seq = Math.max(this._seq, parseInt(m[1], 36) || 0);
      }
    };
    try {
      if (fs.existsSync(this.file)) {
        absorb(readJson(this.file));
        this.log(`已载入 ${this._byId.size} 条记忆`);
      } else if (fs.existsSync(tmp)) {
        absorb(readJson(tmp));
        try { fs.renameSync(tmp, this.file); } catch { /* noop */ }
        this.log(`记忆主文件缺失，已从临时文件恢复 ${this._byId.size} 条`);
      }
    } catch (err) {
      // 记忆坏掉绝不能连累主流程：直接当空的继续跑，旧文件改名留档给用户查
      this.log(`记忆载入失败（已忽略，不影响聊天）：${err.message}`);
      try { fs.renameSync(this.file, this.file + '.broken-' + Date.now()); } catch { /* noop */ }
      this._byId.clear();
      this._byScope.clear();
      this._grams.clear();
    }
  }

  /** 落盘比 store.json 慢（1s）：记忆丢了不致命，聊天记录丢了才要命 */
  scheduleSave() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) this.save();
    }, 1000);
    this._timer.unref?.();
  }

  save() {
    try {
      const items = [...this._byId.values()];
      writeFileAtomic(this.file, JSON.stringify({ version: 1, savedAt: Date.now(), items }));
      this._dirty = false;
    } catch (err) {
      this.log(`记忆保存失败：${err.message}`);
    }
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._dirty) this.save();
  }

  /* ---------------- 索引 ---------------- */

  _index(it) {
    if (!this._byScope.has(it.scope)) this._byScope.set(it.scope, new Set());
    this._byScope.get(it.scope).add(it.id);
    for (const g of it.tokens || []) {
      if (!this._grams.has(g)) this._grams.set(g, new Set());
      this._grams.get(g).add(it.id);
    }
  }

  _unindex(it) {
    this._byScope.get(it.scope)?.delete(it.id);
    for (const g of it.tokens || []) {
      const s = this._grams.get(g);
      if (!s) continue;
      s.delete(it.id);
      if (!s.size) this._grams.delete(g);
    }
  }

  _newId() {
    this._seq += 1;
    return 'mem_' + this._seq.toString(36).padStart(5, '0');
  }

  /* ---------------- CRUD ---------------- */

  get(id) {
    return this._byId.get(String(id)) || null;
  }

  /**
   * 写入或合并一条记忆。
   * 同 scope + 同 kind 且相似度 >0.82 的视为同一条：
   *   不新增，而是抬权重、更新时间、并把来源并进去——
   *   否则「他养了只猫」在群里说 20 次就会变成 20 条记忆。
   * @returns {{item:object, merged:boolean}}
   */
  upsert(input) {
    const now = Date.now();
    const scope = String(input.scope || 'global');
    const kind = VALID_KINDS.has(input.kind) ? input.kind : 'fact';
    const text = normalizeText(input.text).slice(0, 400);
    if (!text) return { item: null, merged: false };
    const tokens = [...bigrams(text)];

    if (input.origin !== 'manual') {
      const dup = this._findSimilar(scope, kind, tokens);
      if (dup) {
        dup.weight = Math.min(3, (dup.weight || 1) + 0.15);
        dup.conf = Math.max(dup.conf || 0, input.conf ?? 0.7);
        dup.ts = now;
        dup.hitCount = (dup.hitCount || 0) + 1;
        dup.sourceIds = [...new Set([...(dup.sourceIds || []), ...(input.sourceIds || [])])].slice(-12);
        // tokens 变了（原文变长）就重建索引，别漏词
        const merged = new Set([...(dup.tokens || []), ...tokens]);
        if (merged.size !== (dup.tokens || []).length) {
          this._unindex(dup);
          dup.tokens = [...merged];
          this._index(dup);
        }
        this.scheduleSave();
        return { item: dup, merged: true };
      }
    }

    const item = {
      id: this._newId(),
      scope,
      kind,
      subject: String(input.subject || ''),
      text,
      tokens,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
      weight: Math.min(3, Math.max(0.1, Number(input.weight) || 1)),
      conf: Math.min(1, Math.max(0, Number(input.conf) ?? 0.7)),
      origin: input.origin || 'auto',
      sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds.slice(-12) : [],
      ts: now,
      lastHitAt: 0,
      hitCount: 0,
      status: 'active'
    };
    this._byId.set(item.id, item);
    this._index(item);
    this._pruneOverflow(scope);
    this.scheduleSave();
    return { item, merged: false };
  }

  _findSimilar(scope, kind, tokens) {
    const ids = this._byScope.get(scope);
    if (!ids || !tokens.length) return null;
    const qset = new Set(tokens);
    let best = null;
    let bestSim = 0;
    for (const id of ids) {
      const it = this._byId.get(id);
      if (!it || it.kind !== kind || it.status !== 'active') continue;
      const inter = (it.tokens || []).reduce((n, g) => n + (qset.has(g) ? 1 : 0), 0);
      if (!inter) continue;
      const sim = inter / Math.sqrt(qset.size * Math.max(1, (it.tokens || []).length));
      if (sim > bestSim) { bestSim = sim; best = it; }
    }
    return bestSim > 0.82 ? best : null;
  }

  /** 单 scope 条数上限，超了按「权重 × 时间衰减」从最低开始淘汰 */
  _pruneOverflow(scope) {
    const max = Math.max(100, Number(this.cfg.maxPerScope) || 20000);
    const ids = this._byScope.get(scope);
    if (!ids || ids.size <= max) return;
    const ranked = [...ids]
      .map((id) => this._byId.get(id))
      .filter(Boolean)
      .sort((a, b) => this._rankScore(a) - this._rankScore(b));
    for (const it of ranked.slice(0, ids.size - max)) this.forget(it.id, true);
  }

  /** 内部：只用来排序淘汰，不是检索分 */
  _rankScore(it) {
    return (it.weight || 1) * decayFactor(it.ts, it.kind);
  }

  forget(id, hard = false) {
    const it = this._byId.get(String(id));
    if (!it) return false;
    if (hard) {
      this._unindex(it);
      this._byId.delete(it.id);
    } else {
      // 软删也要从索引里摘掉。
      // 只改 status 的话，条目永远挂在 _byScope/_grams 里：前端每点一次「忘掉」，
      // 内存里其实一条都没少，search() 每轮还要全量遍历并跳过它们。
      // 用户的直觉是「忘掉了 = 不占地方了」，索引必须跟着一起忘。
      it.status = 'deleted';
      this._unindex(it);
      it.tokens = [];
    }
    this.scheduleSave();
    return true;
  }

  /** 标记命中：命中过的记忆权重会缓慢上升（被反复用到的才是真记忆） */
  touchHits(ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const now = Date.now();
    let changed = false;
    for (const id of ids) {
      const it = this._byId.get(String(id));
      if (!it) continue;
      it.lastHitAt = now;
      it.hitCount = (it.hitCount || 0) + 1;
      if ((it.hitCount & 3) === 0) it.weight = Math.min(3, (it.weight || 1) + 0.05);
      changed = true;
    }
    if (changed) this.scheduleSave();
  }

  /* ---------------- 检索 ---------------- */

  /**
   * 检索：暴力全量打分（2 万条内与倒排同量级，见文件头）。
   * score = 余弦相似度 × 权重 × 时间衰减 × 置信度
   * @param {object} q {scope, text, kinds?, topN?, minScore?}
   */
  search(q = {}) {
    const scope = String(q.scope || '');
    const topN = Math.max(1, Math.min(50, Number(q.topN) || 6));
    const minScore = Number(q.minScore ?? 0.12);
    const kinds = Array.isArray(q.kinds) && q.kinds.length ? new Set(q.kinds) : null;
    const ids = scope ? (this._byScope.get(scope) || new Set()) : this._byId.keys();
    const qset = bigrams(q.text);
    const now = Date.now();
    const out = [];
    for (const id of ids) {
      const it = this._byId.get(id);
      if (!it || it.status !== 'active') continue;
      if (kinds && !kinds.has(it.kind)) continue;
      let score;
      if (!qset.size) {
        // 没给查询词（主动发言挑候选）→ 纯靠「记忆本身值不值得说」
        score = (it.weight || 1) * decayFactor(it.ts, it.kind, now) * (it.conf || 0.7) * 0.5;
      } else {
        const inter = (it.tokens || []).reduce((n, g) => n + (qset.has(g) ? 1 : 0), 0);
        if (!inter) continue;
        const cos = inter / Math.sqrt(qset.size * Math.max(1, (it.tokens || []).length));
        score = cos * (it.weight || 1) * decayFactor(it.ts, it.kind, now) * (0.5 + 0.5 * (it.conf || 0.7));
      }
      if (score >= minScore) out.push({ item: it, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topN);
  }

  /** 面板用：按 scope 列（含已删除标记，方便恢复） */
  list({ scope, kind, status = 'active', limit = 200, offset = 0 } = {}) {
    let arr = [...this._byId.values()];
    if (scope) arr = arr.filter((m) => m.scope === scope);
    if (kind) arr = arr.filter((m) => m.kind === kind);
    if (status && status !== 'all') arr = arr.filter((m) => m.status === status);
    arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return { total: arr.length, items: arr.slice(offset, offset + limit) };
  }

  scopes() {
    return [...this._byScope.entries()]
      .map(([scope, ids]) => ({ scope, count: ids.size }))
      .sort((a, b) => b.count - a.count);
  }

  stats() {
    const byKind = {};
    const byScope = {};
    let bytes = 0;
    for (const it of this._byId.values()) {
      if (it.status !== 'active') continue;
      byKind[it.kind] = (byKind[it.kind] || 0) + 1;
      byScope[it.scope] = (byScope[it.scope] || 0) + 1;
      bytes += it.text.length;
    }
    let fileBytes = 0;
    try { fileBytes = fs.statSync(this.file).size; } catch { /* 还没落盘 */ }
    return {
      total: [...this._byId.values()].filter((m) => m.status === 'active').length,
      byKind,
      byScope,
      grams: this._grams.size,
      textBytes: bytes,
      fileBytes,
      file: this.file
    };
  }

  /** 衰减整理：把长期没被命中、权重掉到地板以下的记忆标成 deleted（不是硬删，可恢复） */
  decay() {
    const days = Number(this.cfg.decayDays) || 30;
    const cutoff = days * 86400000;
    const now = Date.now();
    let n = 0;
    for (const it of this._byId.values()) {
      if (it.status !== 'active') continue;
      if (it.kind === 'fact' || it.kind === 'meme') continue;   // 人设和群梗不自动清
      const last = Math.max(it.ts || 0, it.lastHitAt || 0);
      if (now - last > cutoff * 6 && (it.weight || 1) < 0.3) {
        // 归档必须同时踢出索引：否则「已归档」的条目还躺在 _byScope/_grams 里，
        // search() 每轮全量扫过去再跳过它们——跑上几个月，库里的死条目会越积越多，
        // 用户看到统计里 total 很小，检索却越来越慢。
        this._unindex(it);
        it.tokens = [];
        it.status = 'deleted';
        n++;
      }
    }
    if (n) { this.scheduleSave(); this.log(`衰减整理：归档 ${n} 条低价值记忆`); }
    return n;
  }
}

module.exports = { MemoryStore, bigrams, decayFactor, normalizeText, HALF_LIFE_DAYS };
