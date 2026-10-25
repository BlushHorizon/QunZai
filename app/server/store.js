'use strict';
/**
 * 轻量会话存储：内存 + 落盘（data/store.json）。
 * 只保留最近若干条消息，避免文件无限增长。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJson } = require('./atomic');

const MAX_MESSAGES_PER_CHAT = 300;
const MAX_CHATS = 200;

class Store {
  constructor(root, opts = {}) {
    // 安卓上数据目录可能被指到别处（应用私有目录），所以允许单独传
    this.file = path.join(opts.dataDir || path.join(root, 'data'), 'store.json');
    /** @type {Map<string, object>} key: 'private:123' | 'group:456' */
    this.chats = new Map();
    /** @type {Map<string, object[]>} */
    this.messages = new Map();
    this._dirty = false;
    this._timer = null;
    this.load();
  }

  load() {
    const tmpFile = this.file + '.tmp';
    try {
      if (!fs.existsSync(this.file)) {
        // 主文件不在，但临时文件在 = 上次恰好死在 rename 之前，内容其实是新的
        if (fs.existsSync(tmpFile)) {
          const rawT = readJson(tmpFile);
          for (const c of rawT.chats || []) this.chats.set(c.id, c);
          for (const [k, arr] of Object.entries(rawT.messages || {})) this.messages.set(k, arr);
          console.log(`[store] 主文件缺失，已从临时文件恢复 ${this.chats.size} 个会话`);
          try { fs.renameSync(tmpFile, this.file); } catch { /* noop */ }
          return;
        }
        return;
      }
      let raw;
      try {
        raw = readJson(this.file);
      } catch (err) {
        // 主文件坏了（旧版本非原子写留下的半截 JSON）→ 试试临时文件还能不能救
        if (fs.existsSync(tmpFile)) {
          raw = readJson(tmpFile);
          console.warn('[store] 主文件损坏，已从临时文件恢复');
          try { fs.renameSync(tmpFile, this.file); } catch { /* noop */ }
        } else {
          throw err;
        }
      }
      for (const c of raw.chats || []) this.chats.set(c.id, c);
      for (const [k, arr] of Object.entries(raw.messages || {})) this.messages.set(k, arr);
      console.log(`[store] 已载入 ${this.chats.size} 个会话、${[...this.messages.values()].reduce((a, b) => a + b.length, 0)} 条消息`);
    } catch (err) {
      console.warn('[store] 载入失败:', err.message);
    }
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* noop */ }
  }

  scheduleSave() {
    this._dirty = true;
    if (this._timer) return;
    // 短防抖：进程被强杀时最多丢 200ms 内的数据
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) this.save();
    }, 200);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = {
        savedAt: Date.now(),
        chats: [...this.chats.values()],
        messages: Object.fromEntries(this.messages)
      };
      writeFileAtomic(this.file, JSON.stringify(payload));
      this._dirty = false;
    } catch (err) {
      console.warn('[store] 保存失败:', err.message);
    }
  }

  chatKey(type, id) {
    return `${type}:${id}`;
  }

  ensureChat(type, id, name, extra = {}) {
    const key = this.chatKey(type, id);
    let chat = this.chats.get(key);
    if (!chat) {
      chat = { id: key, type, targetId: String(id), name: name || String(id), lastText: '', lastTime: 0, unread: 0 };
      this.chats.set(key, chat);
      if (this.chats.size > MAX_CHATS) {
        const oldest = [...this.chats.values()].sort((a, b) => (a.lastTime || 0) - (b.lastTime || 0))[0];
        if (oldest) {
          this.chats.delete(oldest.id);
          this.messages.delete(oldest.id);
        }
      }
    }
    if (name) chat.name = name;
    Object.assign(chat, extra);
    this.scheduleSave();
    return chat;
  }

  _touchChat(msg) {
    const chat = this.ensureChat(msg.chatType, msg.chatId, msg.chatName);
    if (msg.text) chat.lastText = msg.text;
    chat.lastTime = msg.time || Date.now();
    return chat;
  }

  addMessage(msg) {
    const key = this.chatKey(msg.chatType, msg.chatId);
    if (!this.messages.has(key)) this.messages.set(key, []);
    const arr = this.messages.get(key);
    // 去重：同一 chat 下相同 id 只留一条
    if (msg.id) {
      const exist = arr.find((m) => m.id === msg.id);
      if (exist) {
        Object.assign(exist, msg);
        this._touchChat(msg);
        this.scheduleSave();
        return exist;
      }
    }
    // 去重：3 秒内相同内容、相同发送者的消息只保留一条。
    // 必须在 push 之前查，否则会匹配到刚 push 的自己；也不能把本次消息
    // 留在数组里，否则重复 ID 会污染历史记录。
    // （OneBot 实现可能同时回报动作响应与事件，或本地已先做乐观回显）
    const tail = arr.slice(-4);
    const dup = tail.find((m) =>
      !!msg.text && m.chatType === msg.chatType && m.chatId === msg.chatId &&
      m.self === msg.self && m.text === msg.text &&
      Math.abs((m.time || 0) - (msg.time || 0)) < 3000
    );
    if (dup) {
      Object.assign(dup, msg);
      this._touchChat(msg);
      this.scheduleSave();
      return dup;
    }
    arr.push(msg);
    if (arr.length > MAX_MESSAGES_PER_CHAT) arr.splice(0, arr.length - MAX_MESSAGES_PER_CHAT);
    this._touchChat(msg);
    this.scheduleSave();
    return msg;
  }

  getMessages(chatId, limit = 200) {
    const arr = this.messages.get(chatId) || [];
    return arr.slice(-limit);
  }

  setUnread(chatId, n) {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    chat.unread = n;
    this.scheduleSave();
  }

  markRead(chatId) {
    this.setUnread(chatId, 0);
  }

  listChats() {
    return [...this.chats.values()].sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  }

  /** 供 AI 使用的会话上下文
   *  since：只取该时间点之后的消息（API 模式「新建对话」用它重置 AI 记忆） */
  recentTurns(chatId, turns, since = 0) {
    const all = this.messages.get(chatId) || [];
    const arr = all
      .filter((m) => m.text && !m.system && (m.time || 0) >= since)
      .slice(-turns * 2);
    return arr.map((m) => ({ role: m.self ? 'assistant' : 'user', content: m.text }));
  }

  historyForDisplay(chatId, limit = 200) {
    return this.getMessages(chatId, limit);
  }
}

module.exports = { Store };