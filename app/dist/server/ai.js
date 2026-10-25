'use strict';
/**
 * AI 自动回复
 * ---------------------------------------------------------------------------
 * 收到 QQ 消息 → 远程指令优先 → 判断是否该自动回复（开关/指定会话/免打扰/
 * 范围/@/关键词/概率/冷却）→ 组装上下文（可携带图片）→ 调用模型 → 回发 QQ。
 *
 * 远程指令：主人QQ发来的 /开 /暂停 /状态 等，不受免打扰与 AI 开关限制。
 */
const fs = require('fs');
const path = require('path');
const { STICKER_ABILITY_PROMPT, buildStickerPrompt } = require('./stickers');
const { resolveDataDir } = require('./platform');

const OPENAI_CHAT_PATH = '/chat/completions';

class AIResponder {
  /**
   * @param {object} opts
   * @param {object} opts.config   ai 配置（可热更新）
   * @param {import('./store').Store} opts.store
   * @param {object} opts.adapter  qq-adapter
   * @param {(evt:object)=>void} opts.broadcast  向前端推送事件
   * @param {(key:string)=>object} opts.getConfig
   * @param {()=>void} [opts.saveConfig] 指令改动配置后落盘
   */
  constructor({ config, store, adapter, broadcast, getConfig, deepseek, saveConfig, sticker }) {
    this.store = store;
    this.adapter = adapter;
    this.broadcast = broadcast;
    this.getConfig = getConfig;
    this.deepseek = deepseek;   // DeepSeekWeb 实例（网页版驱动）
    this.sticker = sticker || null; // 表情包库（内置）：AI 回复里的 [表情] 标记由它兑现
    this.saveConfig = typeof saveConfig === 'function' ? saveConfig : () => {};
    this._lastReplyAt = new Map();   // chatId -> 时间戳
    this._busy = new Set();          // 正在处理的会话，防止并发重复回复
    this._pauseTimer = null;         // /暂停 N 分钟 的自动恢复定时器
    this._ctxSince = new Map();      // chatId -> 时间戳：API 模式「新建对话」重置记忆的起点
    this._ctxSinceAll = 0;           // 全局重置起点（所有会话）
  }

  /**
   * API 模式「新建对话」= 清空喂给模型的上下文记忆。
   * OpenAI 兼容接口本身无状态，每轮都把完整 messages 发过去；
   * 所以「新建对话」= 之后不再把这次之前的聊天记录带进上下文。
   * 网页版模式下由 DeepSeek 站点自己管对话，不需要这里。
   * @param {string} [chatId] 指定会话；不给则清空所有会话的记忆
   */
  resetContext(chatId) {
    const at = Date.now();
    if (chatId) {
      this._ctxSince.set(String(chatId), at);
      console.log(`[AI] 已重置上下文记忆 → ${chatId}`);
    } else {
      this._ctxSinceAll = at;
      this._ctxSince.clear();
      console.log('[AI] 已重置上下文记忆 → 全部会话');
    }
    return at;
  }

  /** 该会话当前的上下文起点（没有重置过就是 0 = 全量） */
  contextSince(chatId) {
    return Math.max(this._ctxSinceAll || 0, this._ctxSince.get(String(chatId)) || 0);
  }

  get cfg() { return this.getConfig().ai || {}; }

  /** 指定会话列表（新版 targetChatKeys 多选数组；兼容旧版单选 targetChatKey 字段） */
  _targetKeys(c) {
    if (Array.isArray(c.targetChatKeys)) return c.targetChatKeys.map(String).filter(Boolean);
    return c.targetChatKey ? [String(c.targetChatKey)] : [];
  }

  /** 当前实际使用的 provider：显式配置优先，其次按是否有 Key 推断 */
  provider() {
    const c = this.cfg;
    if (c.provider) return c.provider;
    return c.apiKey ? 'openai-compatible' : 'builtin';
  }

  status() {
    const c = this.cfg;
    const p = this.provider();
    const ds = this.deepseek?.status?.() || {};
    return {
      enabled: !!c.enabled,
      provider: p,
      providerLabel: p === 'deepseek-web' ? `网页版 ${ds.siteShort || ds.siteName || 'DeepSeek'}`
        : p === 'openai-compatible' ? `API（${c.model || ''}）`
        : '内置规则引擎',
      baseUrl: c.baseUrl || '',
      model: p === 'openai-compatible' ? c.model : '内置规则引擎',
      scope: c.scope || 'private',
      replyMode: c.replyMode === 'target' ? 'target' : 'all',
      targetChatKeys: this._targetKeys(c),
      groupReplyChance: typeof c.groupReplyChance === 'number' ? c.groupReplyChance : 100,
      groupKeywords: c.groupKeywords || '',
      quietEnabled: !!c.quietEnabled,
      quietFrom: c.quietFrom || '23:00',
      quietTo: c.quietTo || '08:00',
      quietNow: this._inQuiet(c),
      imageReply: c.imageReply !== false,
      groupAtSender: c.groupAtSender !== false,
      groupQuote: c.groupQuote !== false,
      commandSenders: c.commandSenders || '',
      deepseek: ds
    };
  }

  /* ---------------- 免打扰时段 ---------------- */
  _inQuiet(c) {
    if (!c.quietEnabled) return false;
    const parse = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
      if (!m) return null;
      const v = (+m[1]) * 60 + (+m[2]);
      return (v >= 0 && v < 1440) ? v : null;
    };
    const from = parse(c.quietFrom);
    const to = parse(c.quietTo);
    if (from === null || to === null || from === to) return false;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to);  // 支持跨天
  }

  /* ---------------- 群聊关键词 ---------------- */
  _keywords(c) {
    return String(c.groupKeywords || '')
      .split(/[,，;；\n]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /** 是否应该对这条消息自动回复 */
  shouldReply(msg) {
    const c = this.cfg;
    if (!c.enabled) return { ok: false, reason: 'AI 未开启' };
    if (msg.self) return { ok: false, reason: '自己发的消息' };
    if (msg.system) return { ok: false, reason: '系统消息' };
    const hasImg = Array.isArray(msg.images) && msg.images.length > 0;
    if (!msg.text && !hasImg) return { ok: false, reason: '非文本消息' };

    if (c.scope === 'private' && msg.chatType === 'group') {
      return { ok: false, reason: '当前设置只自动回复私聊' };
    }
    // 指定回复（可多选）：只回选中的会话，其他会话一律不回（一个都没选时退化为全部回复）
    if (c.replyMode === 'target') {
      const keys = this._targetKeys(c);
      if (keys.length) {
        const targetKey = this.store.chatKey(msg.chatType, msg.chatId);
        if (!keys.includes(targetKey)) {
          return { ok: false, reason: '未指定为回复对象' };
        }
      }
    }
    // 免打扰时段：期间一律不自动回复（主人的远程指令不受限，指令在 handle 里先行处理）
    if (c.quietEnabled && this._inQuiet(c)) {
      return { ok: false, reason: '免打扰时段' };
    }
    if (msg.chatType === 'group' && c.requireMentionInGroup && !msg.mentionsMe) {
      return { ok: false, reason: '群聊中未被 @' };
    }
    // 群聊关键词：命中任一关键词才回（@机器人/带图消息除外；留空=不限）
    if (msg.chatType === 'group' && !msg.mentionsMe && !hasImg) {
      const kws = this._keywords(c);
      if (kws.length) {
        const t = String(msg.text || '').toLowerCase();
        if (!kws.some((k) => t.includes(k))) {
          return { ok: false, reason: '群关键词未命中' };
        }
      }
    }
    // 主动群聊回复概率：群里的非 @ 消息按概率随机回复（@机器人的消息必回；私聊不受影响）
    if (msg.chatType === 'group' && !msg.mentionsMe) {
      const chance = c.groupReplyChance ?? 100;
      if (chance < 100 && Math.random() * 100 >= chance) {
        return { ok: false, reason: '群聊主动回复概率未命中' };
      }
    }

    const key = this.store.chatKey(msg.chatType, msg.chatId);
    const last = this._lastReplyAt.get(key) || 0;
    const cooldownMs = Math.max(0, Number(c.minIntervalMs) || 0);
    if (cooldownMs > 0 && Date.now() - last < cooldownMs) {
      return { ok: false, reason: '冷却中' };
    }
    return { ok: true };
  }

  /* ---------------- QQ 远程指令 ---------------- */

  /**
   * 主人发来的 /xxx：直接执行并回话，不走 AI、不受免打扰限制。
   * @returns {Promise<boolean>} 是否是指令（是则不再走自动回复）
   */
  async _maybeCommand(msg) {
    const c = this.cfg;
    if (!msg || msg.self || msg.system || !msg.text) return false;
    const owners = String(c.commandSenders || '').split(/[,，;；\s]+/).filter(Boolean);
    if (!owners.length) return false;
    if (!owners.includes(String(msg.fromId))) return false;
    const t = String(msg.text).trim();
    if (!t.startsWith('/')) return false;
    console.log(`[指令] 主人 ${msg.fromId}: ${t}`);

    const parts = t.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts[1] || '';
    const say = (text) => this._sendBotText(msg, text);

    switch (cmd) {
      case '/开': case '/开启': case '/on': {
        if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null; }
        c.enabled = true;
        this.saveConfig();
        this.broadcast({ type: 'settings_changed', ai: this.status() });
        await say('✅ 已开启自动回复');
        return true;
      }
      case '/关': case '/暂停': case '/off': {
        const mins = /^\d+$/.test(arg) ? Math.min(1440, parseInt(arg, 10)) : 0;
        c.enabled = false;
        this.saveConfig();
        if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null; }
        if (mins > 0) {
          this._pauseTimer = setTimeout(() => {
            try { this.cfg.enabled = true; this.saveConfig(); } catch { /* noop */ }
            this._pauseTimer = null;
            this.broadcast({ type: 'settings_changed', ai: this.status() });
          }, mins * 60 * 1000);
          this._pauseTimer.unref?.();
          await say(`⏸ 已暂停自动回复，${mins} 分钟后自动恢复`);
        } else {
          await say('⏸ 已关闭自动回复（发 /开 恢复）');
        }
        this.broadcast({ type: 'settings_changed', ai: this.status() });
        return true;
      }
      case '/状态': case '/status': {
        const st = this.status();
        const ds = st.deepseek || {};
        const lines = [
          '📊 群崽运行状态',
          `自动回复：${st.enabled ? '开' : '关'}`,
          `大脑：${st.providerLabel}`,
          `回复范围：${st.scope === 'private' ? '仅私聊' : '私聊+群聊'}${st.replyMode === 'target' ? `（只回选中会话${st.targetChatKeys.length ? ` x${st.targetChatKeys.length}` : ''}）` : ''}`,
          `群聊：概率${st.groupReplyChance}%${st.groupKeywords ? '，关键词[' + st.groupKeywords + ']' : ''}${st.imageReply ? '，看图开' : ''}`
        ];
        if (st.quietEnabled) lines.push(`免打扰：${st.quietFrom}-${st.quietTo}${st.quietNow ? '（生效中）' : ''}`);
        if (this.sticker) lines.push(`表情包素材：${this.sticker.count()} 个`);
        lines.push(`DeepSeek：${ds.state || '未连接'}${typeof ds.roundCount === 'number' ? `，轮次${ds.roundCount}/${ds.maxRounds}` : ''}`);
        await say(lines.join('\n'));
        return true;
      }
      case '/帮助': case '/help': {
        const lines = [
          '🤖 可用指令：',
          '/开 — 开启自动回复',
          '/暂停 [分钟] — 关闭（带数字则 N 分钟后自动恢复）',
          '/状态 — 查看运行状态',
          '/帮助 — 本菜单'
        ];
        await say(lines.join('\n'));
        return true;
      }
      default: {
        await say(`未知指令「${cmd}」，发送 /帮助 看用法`);
        return true;
      }
    }
  }

  /** 指令回复：直接经适配器发出 + 本地回显（前端标记为 AI 消息） */
  async _sendBotText(msg, text) {
    const chatKey = this.store.chatKey(msg.chatType, msg.chatId);
    const chat = this.store.chats.get(chatKey) || {};
    try {
      // 群聊里指令回复也 @ 一下发指令的人
      const cmdOpts = msg.chatType === 'group' && msg.fromId ? { at: String(msg.fromId) } : {};
      await this.adapter.sendText({ type: msg.chatType, targetId: msg.chatId }, text, cmdOpts);
    } catch {
      return;
    }
    console.log(`[指令] 回复 → ${msg.chatType === 'group' ? '群' : '私'}${msg.chatId}: ${String(text).slice(0, 50)}`);
    const echo = {
      id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      chatType: msg.chatType,
      chatId: String(msg.chatId),
      chatName: chat?.name || '',
      fromId: String(this.adapter.self?.userId || ''),
      fromName: this.adapter.self?.nickname || '我',
      self: true,
      ai: true,
      text,
      raw: text,
      mentionsMe: false,
      mentions: 0,
      time: Date.now()
    };
    this.store.addMessage(echo);
    this.broadcast({ type: 'message', message: echo, chat: this.store.chats.get(chatKey) || chat });
  }

  /** 主入口：处理一条收到的消息 */
  async handle(msg) {
    // 主人的远程指令优先：不走 AI、不受免打扰影响
    try {
      if (await this._maybeCommand(msg)) return;
    } catch (err) {
      console.warn('[ai] 指令处理出错:', err.message);
    }
    const check = this.shouldReply(msg);
    const chatKey = this.store.chatKey(msg.chatType, msg.chatId);
    if (!check.ok) {
      console.log(`[AI] 跳过(${check.reason}) ← ${msg.chatType === 'group' ? '群' : '私'}${msg.fromName || msg.chatId}: ${String(msg.text || '').slice(0, 60)}`);
      this.broadcast({ type: 'ai_skip', chatId: chatKey, reason: check.reason, at: Date.now() });
      return;
    }
    if (this._busy.has(chatKey)) return;
    this._busy.add(chatKey);
    try {
      this.broadcast({ type: 'ai_typing', chatId: chatKey, at: Date.now() });

      const delay = this.cfg.replyDelayMs ?? 900;
      if (delay > 0) await sleep(delay);

      const history = this.store.recentTurns(chatKey, this.cfg.historyTurns ?? 8, this.contextSince(chatKey));
      const chat = this.store.chats.get(chatKey) || {};
      const context = `（会话：${msg.chatType === 'group' ? '群聊 ' + (chat.name || msg.chatId) : '私聊 ' + (msg.fromName || msg.chatId)}）`;
      const reply = await this._ask(history, context, msg);
      if (!reply || !reply.trim()) {
        this.broadcast({ type: 'ai_error', chatId: chatKey, message: '模型没有返回内容', at: Date.now() });
        return;
      }

      this._lastReplyAt.set(chatKey, Date.now());

      // 表情包：AI 回复里的 [表情]/[表情:关键词] 标记 → 剥掉标记、挑表情包跟在文字后面
      // 一条回复可以多个标记（三连/四连），全部打包成【一条】消息发出，不算刷屏
      // 先翻群友发过的素材，翻不到再去在线图库（梗鲸 DeepSeek娘）按描述现取一张
      let outText = reply.trim();
      let stickerPicks = [];
      if (this.sticker) {
        const taken = await this.sticker.takeFromReplyAsync(outText);
        outText = taken.text;
        stickerPicks = taken.stickers || [];
      }
      const display = outText || (stickerPicks.length ? `〔表情包 x${stickerPicks.length}〕` : '');

      // 群聊回复自动 @ 触发消息的成员 + 引用其原话（设置可分别关）
      const sendOpts = {};
      if (msg.chatType === 'group') {
        if (this.cfg.groupAtSender !== false && msg.fromId) sendOpts.at = String(msg.fromId);
        if (this.cfg.groupQuote !== false && msg.id) sendOpts.quoteId = msg.id;
      }
      if (outText) {
        await this.adapter.sendText(
          { type: msg.chatType, targetId: msg.chatId },
          outText,
          sendOpts
        );
      }
      if (stickerPicks.length) {
        await this.sticker.sendBatch({ type: msg.chatType, targetId: msg.chatId }, stickerPicks);
      }
      if (!display) {
        // 标记被剥完又没表情可发（冷却/空库）：什么都不发，别空回复
        this.broadcast({ type: 'ai_skip', chatId: chatKey, reason: '回复为空', at: Date.now() });
        return;
      }

      // OneBot 实现默认不回报自己发送的消息，这里补一条本地回显（前端会打上 AI 标记）
      const echo = {
        id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        chatType: msg.chatType,
        chatId: String(msg.chatId),
        chatName: chat?.name || '',
        fromId: String(this.adapter.self?.userId || ''),
        fromName: this.adapter.self?.nickname || '我',
        self: true,
        ai: true,
        text: display,
        raw: display,
        mentionsMe: false,
        mentions: 0,
        time: Date.now()
      };
      this.store.addMessage(echo);
      this.broadcast({ type: 'message', message: echo, chat: this.store.chats.get(chatKey) || chat });

      console.log(`[AI] 已回复 → ${msg.chatType === 'group' ? '群' : '私'}${msg.chatId}: ${display.slice(0, 60)}${stickerPicks.length ? `（+表情x${stickerPicks.length}）` : ''}`);
      this.broadcast({ type: 'ai_replied', chatId: chatKey, text: display, at: Date.now() });
    } catch (err) {
      console.warn('[ai] 自动回复失败:', err.message);
      this.broadcast({ type: 'ai_error', chatId: chatKey, message: err.message, at: Date.now() });
    } finally {
      this._busy.delete(chatKey);
    }
  }

  /** 调用模型：按 provider 分发 */
  async _ask(history, context, msg) {
    const provider = this.provider();
    if (provider === 'deepseek-web') return this._askWeb(history, context, msg);
    if (provider === 'openai-compatible') {
      if (!this.cfg.apiKey) throw new Error('未配置 API Key，请在设置里填写，或改用「网页版 DeepSeek」');
      return this._askOpenAI(history, context, msg);
    }
    return this._builtin(history, msg);
  }

  /** 把消息里的图片 URL 下载为本地临时文件（DeepSeek 网页版上传用） */
  async _fetchImages(msg) {
    const urls = Array.isArray(msg.images) ? msg.images.slice(0, 4) : [];
    const files = [];
    const dir = path.join(resolveDataDir(path.resolve(__dirname, '..')), 'tmp');
    for (const u of urls) {
      try {
        const resp = await fetch(u, { signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
        if (!resp.ok) continue;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (!buf.length) continue;
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
        fs.writeFileSync(f, buf);
        files.push(f);
      } catch { /* 单张失败忽略 */ }
    }
    return files;
  }

  /** 只算表情包能力段（带图库数量），OpenAI 兼容接口用 */
  _stickerPrompt() {
    let n = 0;
    try { n = this.sticker && this.sticker.gallery ? this.sticker.gallery.stats().count : 0; } catch { /* 读不到就当没有 */ }
    return buildStickerPrompt(n);
  }

  /**
   * 发给模型的完整提示词 = 用户在网页端填的人设 + 内置能力段（表情包）。
   * 能力段写死在代码里，用户改人设不会弄丢——AI 永远知道自己有发表情包的本事、
   * 怎么触发（[表情]/[表情:关键词]）、什么时候该用什么时候别用。
   */
  _fullPrompt() {
    const base = this.cfg.webPrompt || '';
    if (!this.sticker) return base;
    const stickerPrompt = this._stickerPrompt();
    return base ? base + '\n\n' + stickerPrompt : stickerPrompt;
  }

  /**
   * 网页版 DeepSeek：把对方消息（可带图片）发给 chat.deepseek.com，取回回答。
   * 提示词（人设/规则 + 表情包能力）由新建对话时自动发送一次。
   */
  async _askWeb(history, context, msg) {
    if (!this.deepseek) throw new Error('未初始化网页版驱动');
    // 把完整提示词/轮次上限/当前站点同步给驱动（改了配置即时生效）
    this.deepseek.configure({
      site: this.cfg.webProvider || 'deepseek',
      prompt: this._fullPrompt(),
      maxRounds: this.cfg.webMaxRounds || 50
    });
    // 带图消息：下载后交给驱动上传到对话（需开启"看图回复"且该站点支持）
    let imgFiles = [];
    const siteImages = this.deepseek.status?.().images !== false;
    if (siteImages && this.cfg.imageReply !== false && Array.isArray(msg.images) && msg.images.length) {
      imgFiles = await this._fetchImages(msg);
    }
    try {
      const chat = this.store.chats.get(this.store.chatKey(msg.chatType, msg.chatId)) || {};
      // 群聊带"群名-昵称"前缀作上下文；私聊直接发原文；图片消息补一句引导
      let text = msg.chatType === 'group'
        ? `【${chat.name || msg.chatId}】${msg.fromName || '群友'}：${msg.text || '（发了一张图片）'}`
        : String(msg.text || '').trim() || '（发了一张图片，描述一下并自然回复）';
      return await this.deepseek.ask(text, { images: imgFiles.length ? imgFiles : null });
    } finally {
      // 上传完成后清理临时图片（延迟删除，确保驱动已读完）
      if (imgFiles.length) {
        setTimeout(() => {
          for (const f of imgFiles) { try { fs.unlinkSync(f); } catch { /* noop */ } }
        }, 5000).unref?.();
      }
    }
  }

  /** OpenAI 兼容接口 */
  async _askOpenAI(history, context, msg) {
    const c = this.cfg;
    const base = String(c.baseUrl || '').replace(/\/+$/, '');
    const url = base.endsWith(OPENAI_CHAT_PATH) ? base : base + OPENAI_CHAT_PATH;
    const messages = [
      { role: 'system', content: [c.systemPrompt, this.sticker ? this._stickerPrompt() : '', context].filter(Boolean).join('\n') },
      ...history,
      { role: 'user', content: msg.text }
    ];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`
        },
        body: JSON.stringify({
          model: c.model || 'deepseek-chat',
          messages,
          temperature: 0.8,
          stream: false
        })
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${(await resp.text()).slice(0, 120)}`);
      }
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('返回结构异常');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 内置规则应答：没配 API Key 也能看到完整自动回复流程 */
  _builtin(history, msg) {
    const t = msg.text;
    const who = msg.fromName || '朋友';
    const turns = history.length;
    if (!t && Array.isArray(msg.images) && msg.images.length) {
      return '收到图片～不过当前是内置规则引擎看不了图，换成「网页版 DeepSeek」就能看图回复了。';
    }
    if (/^(在吗|在不在|在么)/.test(t)) return `在的，怎么啦？`;
    if (/^(你好|hi|hello|嗨)/i.test(t)) return `你好呀${who}，有什么事？`;
    if (/方案|怎么写|文档/.test(t)) return `关于「${t}」，建议先列目标、再拆步骤，最后补一段风险说明。要我给你个模板吗？`;
    if (/开会|三点|几点/.test(t)) return `收到，我会准时参加。`;
    if (/工时|估时|排期/.test(t)) return `粗估 2～3 人日，具体等我确认完依赖再同步给你。`;
    if (/吃饭|聚餐|约/.test(t)) return `可以啊，你定时间地点～`;
    if (/谢谢|谢了|感谢/.test(t)) return `不客气，小事一桩。`;
    if (/[?？]$/.test(t)) return `关于「${t.slice(0, 20)}」：我理解是想让我给个结论。我的建议是先按最小可行方案推进，你看呢？`;
    const openings = ['嗯嗯，', '明白，', '收到，', '好的，'];
    return `${openings[turns % openings.length]}「${t.slice(0, 30)}」我记下了，稍后给你反馈。（当前为内置规则应答，配置 API Key 后由模型接管）`;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { AIResponder };
