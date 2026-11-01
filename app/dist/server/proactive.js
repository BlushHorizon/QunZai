'use strict';
/**
 * 主动发言
 * ---------------------------------------------------------------------------
 * 职责：发现「可以开口的时机」→ 从记忆里挑一个具体的话题 → 请决策器批准 → 生成 → 发送。
 * 它自己**不判断该不该说**（那是 speak-policy.js），也**不管理大脑占用**（那是 brain-gate.js）。
 *
 * 核心设计：候选从记忆里挑，不让模型自由发挥。
 *   自由发挥的模型 90% 会产出「大家好呀，今天有什么想聊的吗」这种空气话——
 *   没人会回。真正可能被接的是「上次你们聊到那个机械键盘，最后买了哪款？」，
 *   它必须基于「这个群确实聊过、并且还没结论」的事实。
 *   所以候选来源只有记忆，模型只负责把候选说成人话。
 */

const { dbg } = require('./debug');

/**
 * 负反馈词表：命中就熔断。宁可错杀，也不能让用户觉得被机器人顶嘴。
 * 注意「别说话」和「别说了」是两种说法，都得覆盖——
 * 只写「别说了」会漏掉最常见的「能不能别说话了」。
 */
const NEG_RE = /别说了|别说话|少说|闭嘴|别刷|烦死|安静|别吵|谁问你了|滚|别叫|吵死|别打扰|消停/;

class ProactiveEngine {
  /**
   * @param {object} opts
   * @param {object} opts.interest  InterestProfile
   * @param {object} opts.policy    SpeakPolicy
   * @param {object} opts.memory    MemoryStore
   * @param {object} opts.gate      BrainGate
   * @param {object} opts.store     会话库（取群列表/最近记录）
   * @param {object} opts.adapter   QQ 适配器
   * @param {(evt:object)=>void} opts.broadcast
   * @param {()=>object} opts.getConfig
   * @param {(chatKey:string, prompt:string)=>Promise<string>} opts.compose 生成一句人话
   */
  constructor({ interest, policy, memory, gate, store, adapter, broadcast, getConfig, compose }) {
    this.interest = interest;
    this.policy = policy;
    this.memory = memory;
    this.gate = gate;
    this.store = store;
    this.adapter = adapter;
    this.broadcast = broadcast;
    this.getConfig = getConfig;
    this.compose = compose;
    /** 群内当日消息计数：chatKey -> {day, count} */
    this._daily = new Map();
    /** 每个群一轮只尝试一次，避免 tick 太密时反复抢大脑 */
    this._lastTry = new Map();
    /** tick 重入锁：上一轮还没跑完时丢弃新的一拍（见 tick 内注释） */
    this._ticking = false;
  }

  get cfg() { return (this.getConfig() || {}).proactive || {}; }
  get aiCfg() { return (this.getConfig() || {}).ai || {}; }

  /* ---------------- 信号 ---------------- */

  /** 每条来信：更新冷场计时 + 当日活跃度 + 负反馈熔断 */
  notifyInbound(msg) {
    if (!msg || msg.self || msg.system) return;
    const chatKey = `${msg.chatType}:${msg.chatId}`;
    this.policy.notifyInbound(chatKey);

    const today = new Date().toDateString();
    const rec = this._daily.get(chatKey);
    if (!rec || rec.day !== today) this._daily.set(chatKey, { day: today, count: 1 });
    else rec.count++;

    // 有人在机器人刚说过话之后发言 → 说明被接话了
    if (this.interest) {
      const picked = this.interest.settleBotSpeak(chatKey, this._topicOf(chatKey));
      if (picked === 'picked') {
        this.policy.notePicked(chatKey);
        console.log(`[主动] ${chatKey} 有人接话了，退避已复位`);
      }
    }

    // 负反馈：直接静音，并把相关记忆降权
    const text = String(msg.text || '');
    if (text && NEG_RE.test(text)) {
      this.policy.triggerNegative(chatKey, text);
      this._downgradeRecentMemory(chatKey);
    }
  }

  _topicOf(chatKey) {
    const last = this._lastTry.get(String(chatKey));
    return last ? (last.grams || []) : [];
  }

  /** 被骂之后，刚说过的那条记忆降权——它已经证明不好笑/不合适 */
  _downgradeRecentMemory(chatKey) {
    try {
      const last = this._lastTry.get(String(chatKey));
      if (!last || !last.memoryId || !this.memory) return;
      const it = this.memory.get(last.memoryId);
      if (!it) return;
      it.weight = Math.max(0.1, (it.weight || 1) * 0.5);
      this.memory.scheduleSave();
      console.log(`[主动] 记忆 ${it.id} 因负反馈降权到 ${it.weight.toFixed(2)}`);
    } catch { /* noop */ }
  }

  /* ---------------- 调度 ---------------- */

  /**
   * 定时器入口（默认 30s 一次）。
   * 它必须便宜：绝大多数 tick 什么都不做，只在冷场时才去碰记忆。
   */
  async tick() {
    // 重入保护：tick 每 30 秒来一次，而里面要 await 大脑生成文案（最长 90 秒），
    // 白名单里有几个群就是几个 90 秒串起来。没有这道锁的话，上一轮还没跑完，
    // 后面每 30 秒就会再压一轮进来，冷场时间越长堆得越多——最后是一次冷场
    // 触发几十个并发的 tick 同时翻记忆、同时抢大脑。这里直接丢弃重叠的那一轮，
    // 等下一拍即可（主动发言本来就不要求准时）。
    if (this._ticking) return;
    this._ticking = true;
    try {
      const c = this.cfg;
      if (c.enabled !== true) return;
      const now = Date.now();

      // 无视超时判定：发出去 10 分钟没人接 → 兴趣降权。
      // 只有真的发过（sent=true）才算「被无视」，否则会把自己的犹豫也算成群的冷漠。
      if (this.interest) {
        for (const [chatKey, rec] of this._lastTry) {
          if (!rec.sent) continue;
          if (this.interest.expireBotSpeak(chatKey, rec.grams || [])) {
            this.policy.noteIgnored(chatKey);
            console.log(`[主动] ${chatKey} 上一条没人接，已降频`);
          }
        }
      }

      const targets = this._candidateChats();
      for (const { chatKey, chat } of targets) {
        // 同一群 5 分钟内不重复尝试（退避另算）
        const last = this._lastTry.get(chatKey);
        if (last && now - last.at < 5 * 60000) continue;
        const todayCount = this._daily.get(chatKey)?.count || 0;
        // 注意不能写 `Number(c.minGroupMsgsToday) || 20`：用户把门槛设成 0（= 不限）时，
        // || 会把它变成 20，然后在冷清的群里永远不开口——改配置却不生效。
        const minMsgs = Number.isFinite(Number(c.minGroupMsgsToday)) ? Number(c.minGroupMsgsToday) : 20;
        if (todayCount < minMsgs) continue;

        await this._tryInitiate(chatKey, chat);
      }
    } catch (err) {
      console.warn('[主动] tick 出错（已忽略）:', err.message);
    } finally {
      this._ticking = false;
    }
  }

  /** 候选群：只考虑「主动发言白名单」里的、且是群聊 */
  _candidateChats() {
    const list = Array.isArray(this.cfg.targetChatKeys) ? this.cfg.targetChatKeys.filter(Boolean) : [];
    if (!list.length) return [];
    const out = [];
    for (const key of list) {
      const chat = this.store.chats.get(key);
      if (!chat) continue;
      if (chat.type !== 'group' && !String(key).startsWith('group:')) continue;
      out.push({ chatKey: key, chat });
    }
    return out;
  }

  async _tryInitiate(chatKey, chat) {
    // 一次拿一批候选，逐条问决策器，最多试 3 条。
    // 为什么不能只抽一条：候选是加权随机抽的，抽到「小李住在杭州」这种群里
    // 没人关心的事会被分数闸门正确地拦下；如果抽一条就收工，这一轮就白费了，
    // 而下面会记 5 分钟冷却——等于每 5 分钟白白丢一次开口机会。
    // 逐条试的意义是：只要记忆里有一条「这个群确实在聊」的，就该被说出来。
    const ranked = this._rankCandidates(chatKey);
    if (!ranked.length) {
      // 静默 return 是这套系统最难查的失败：面板上什么都看不到。
      // 没记忆可挑是「正常空转」，但必须留痕，否则用户只会觉得「它从来不开口」。
      this._lastTry.set(chatKey, { at: Date.now(), grams: [], memoryId: '' });
      this.broadcast({ type: 'proactive_skipped', chatKey, reason: '没有可聊的记忆', at: Date.now() });
      return;
    }

    let cand = null;
    let v = null;
    let lastVerdict = null;
    for (const h of this._sampleOrder(ranked, 3)) {
      // 用候选文本去问决策器：相关性就是针对这个话题算的
      // 注意是 h.item.text —— 候选结构是 {item, score}，写成 cand.text 会拿到 undefined，
      // 决策器按空文本打分恒为 0，主动发言就永远发不出去。
      const verdict = this.policy.verdict({ kind: 'initiate', chatKey, text: h.item.text });
      lastVerdict = verdict;
      if (verdict.ok) { cand = h; v = verdict; break; }
    }
    if (!cand) {
      // 试过的都不过，记下最后一次的原因（面板上能看到是被哪道闸拦的），进冷却
      this._lastTry.set(chatKey, { at: Date.now(), grams: (lastVerdict && lastVerdict.grams) || [], memoryId: '' });
      return;
    }
    this._lastTry.set(chatKey, { at: Date.now(), grams: v.grams || [], memoryId: cand.item.id });

    // 演练模式：判决通过、也生成文案，但不发送
    const shadow = this.cfg.shadow !== false;
    this.broadcast({
      type: 'proactive_decision', chatKey, ok: true, score: v.score,
      candidate: { id: cand.item.id, kind: cand.item.kind, text: cand.item.text },
      shadow, at: Date.now()
    });
    if (shadow) {
      // 演练模式下每次判决通过都会走到这里，一个群一天几十上百条 → 走调试日志
      dbg(`[主动] 演练（不发送）→ ${chatKey}: ${cand.item.text.slice(0, 40)}`);
      return;
    }

    // QQ 断线时 adapter 是 null（server.js 重建适配器期间也会短暂为 null）。
    // 不在这里挡一下，就会先花一次大脑生成文案（90 秒），再在 sendText 上崩成
    // 一句「Cannot read properties of null」，面板上只看到一个看不懂的 reason。
    if (!this.adapter || typeof this.adapter.sendText !== 'function') {
      this.broadcast({ type: 'proactive_skipped', chatKey, reason: 'QQ 未连接', at: Date.now() });
      return;
    }

    const text = await this._composeText(chatKey, chat, cand);
    if (!text) return;

    const res = await this.gate.tryRun('initiate', async () => {
      await this.adapter.sendText({ type: 'group', targetId: String(chat.targetId) }, text, {});
      return text;
    });
    if (!res.ok) {
      this.broadcast({ type: 'proactive_skipped', chatKey, reason: res.reason || '大脑正忙', at: Date.now() });
      return;
    }

    this.policy.noteSent(chatKey, 'initiate');
    this.interest?.markBotSpoke(chatKey);
    this.memory?.touchHits?.([cand.item.id]);
    const echo = this._echo(chat, text);
    this.store.addMessage(echo);
    this.broadcast({ type: 'message', message: echo, chat });
    this.broadcast({ type: 'proactive_sent', chatKey, text, memoryId: cand.item.id, at: Date.now() });
    console.log(`[主动] 已发送 → ${chat.name || chatKey}: ${text.slice(0, 60)}`);
  }

  /**
   * 挑候选：只从记忆里挑，且只要「能被问起」的类型。
   * meme（群梗）和 event（结论）最容易被接话，fact 次之，pref 容易变尬聊。
   * 返回按「值不值得说 × 这个群有多在意」排序后的完整候选池。
   */
  _rankCandidates(chatKey) {
    if (!this.memory) return this._rankFromChatHistory(chatKey);
    const kinds = Array.isArray(this.cfg.candidateKinds) && this.cfg.candidateKinds.length
      ? this.cfg.candidateKinds
      : ['event', 'meme', 'fact'];
    const hits = this.memory.search({ scope: chatKey, text: '', kinds, topN: 12, minScore: 0 });
    if (!hits.length) return [];

    // 只按「记忆本身值不值得说」挑是错的：新条目的分数几乎都相同（0.35），
    // 等于纯随机——很容易挑到「小李住在杭州」这种群里根本没人关心的事，
    // 然后被兴趣闸门判死，一晚上什么也说不出。
    // 真正能被人接话的是「这个群确实在聊、且还没聊完」的话题，
    // 所以候选要按兴趣画像加权：不相关的保留一点概率（偶尔也能起话头），
    // 但相关的必须明显占优。
    const ranked = hits.map((h) => {
      const iscore = this.interest ? this.interest.score(chatKey, h.item.text).score : 0;
      return { ...h, interestScore: iscore, weight: Math.max(1e-4, h.score) * (0.15 + 0.85 * iscore) };
    });
    ranked.sort((a, b) => b.weight - a.weight);
    return ranked;
  }

  /**
   * 长期记忆移除后的降级素材源：从会话历史里挑「群里最近聊过什么」。
   * 挑选标准：别人说的、5~80 字有实际内容、同文本去重、最近的优先。
   * 候选结构伪装成记忆条目（{item:{id,text,kind}, score}），下游兴趣加权/决策器管线原样复用。
   * 这样「删除长记忆」和「主动发言有话说」两个需求同时成立——素材从「过去存的」变成「刚聊的」。
   */
  _rankFromChatHistory(chatKey) {
    if (!this.store) return [];
    try {
      const msgs = (this.store.getMessages ? this.store.getMessages(chatKey, 40) : [])
        .filter((m) => m && m.text && !m.self && !m.system);
      const seen = new Set();
      const candidates = [];
      for (let i = msgs.length - 1; i >= 0 && candidates.length < 8; i--) {
        const m = msgs[i];
        const text = String(m.text).trim();
        // 太短（"哈哈""？"）没话可接；太长（贴小说）不适合直接引用
        if (text.length < 5 || text.length > 80) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        // 越新越值得接话：时间越近 score 越高（0.35~0.6，和记忆分数同量级）
        const fresh = 1 - Math.min(1, (msgs.length - i) / msgs.length);
        candidates.push({
          item: { id: 'chat:' + chatKey + ':' + i, text, kind: 'chat' },
          score: 0.35 + 0.25 * fresh
        });
      }
      const ranked = candidates.map((h) => {
        const iscore = this.interest ? this.interest.score(chatKey, h.item.text).score : 0;
        return { ...h, interestScore: iscore, weight: Math.max(1e-4, h.score) * (0.15 + 0.85 * iscore) };
      });
      ranked.sort((a, b) => b.weight - a.weight);
      return ranked;
    } catch { return []; }
  }

  /**
   * 从候选池里按权重抽 n 条、不重复。
   * 总是取最高分那条会反复说同一件事，所以保留随机；
   * 但抽取顺序决定「先问谁」，权重高的先被问更重要——它更可能过闸。
   */
  _sampleOrder(ranked, n) {
    const pool = ranked.slice();
    const out = [];
    while (out.length < n && pool.length) {
      const total = pool.reduce((s, h) => s + h.weight, 0) || 1;
      let r = Math.random() * total;
      let idx = pool.length - 1;
      for (let i = 0; i < pool.length; i++) {
        r -= pool[i].weight;
        if (r <= 0) { idx = i; break; }
      }
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }

  /** 兼容旧调用点：抽一条 */
  _pickCandidate(chatKey) {
    const ranked = this._rankCandidates(chatKey);
    if (!ranked.length) return null;
    return this._sampleOrder(ranked, 1)[0] || null;
  }

  /** 把记忆条目说成人话。失败就不说——宁可不发，也不要发半截 */
  async _composeText(chatKey, chat, cand) {
    const cfg = this.cfg;
    const recent = this.store.getMessages(chatKey, 12)
      .map((m) => `${m.self ? '你' : (m.fromName || '群友')}：${String(m.text || '').slice(0, 60)}`)
      .join('\n');
    const prompt = [
      `你正在群「${chat.name || chat.targetId}」里，已经安静了一段时间，想主动起个话头。`,
      `你记得这件事：${cand.item.text}`,
      '',
      '最近的聊天记录：',
      recent || '（还没什么记录）',
      '',
      '要求：',
      '1. 就着上面那件「你记得的事」自然地问一句或说一句，像是在接着以前的话往下聊；',
      '2. 一句话，不超过 40 字，不要提问式开场白（不要「大家好啊」这种）；',
      '3. 不要提「记忆」「记录」「之前你说过」这类词，就像你自己记得一样；',
      '4. 不要用 Markdown，不要写解释，只输出这一句话本身。'
    ].join('\n');

    try {
      const out = await this.gate.run('initiate', () => this.compose(chatKey, prompt));
      const text = String(out || '').trim().replace(/^["'「]|["'」]$/g, '');
      if (!text || text.length > 80) return '';
      // 明显是模型在解释自己（不是说话）就丢掉
      if (/^(抱歉|对不起|作为一个|我是AI|我无法)/.test(text)) return '';
      void cfg;
      return text;
    } catch (err) {
      console.warn('[主动] 生成失败:', err.message);
      return '';
    }
  }

  _echo(chat, text) {
    return {
      id: `pro-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      chatType: 'group',
      chatId: String(chat.targetId),
      chatName: chat.name || '',
      fromId: String(this.adapter.self?.userId || ''),
      fromName: this.adapter.self?.nickname || '我',
      self: true,
      ai: true,
      proactive: true,   // 前端据此把「主动开口」标出来，方便用户判断
      text,
      raw: text,
      mentionsMe: false,
      mentions: 0,
      time: Date.now()
    };
  }

  /** 一键闭嘴：清空调度状态，让运行期立刻停下（不动配置，重启后按配置来） */
  kill() {
    this._lastTry.clear();
    console.log('[主动] 已一键闭嘴（运行期停止，配置未改）');
  }

  state() {
    return {
      enabled: this.cfg.enabled === true,
      shadow: this.cfg.shadow !== false,
      targets: Array.isArray(this.cfg.targetChatKeys) ? this.cfg.targetChatKeys : [],
      daily: [...this._daily.entries()].map(([chatKey, r]) => ({ chatKey, date: r.day, count: r.count })),
      lastTry: [...this._lastTry.entries()].map(([chatKey, r]) => ({
        chatKey, msAgo: Date.now() - r.at, memoryId: r.memoryId
      })),
      /* 白名单里的群在实际会话库里找不到 = 白名单写错了。
         面板必须能看见这个，否则用户配了群号却永远不触发，只能靠猜。 */
      unresolved: (Array.isArray(this.cfg.targetChatKeys) ? this.cfg.targetChatKeys : [])
        .filter((k) => k && !this.store.chats.get(k)),
      gate: this.gate.state()
    };
  }
}

module.exports = { ProactiveEngine, NEG_RE };
