'use strict';
/* QQ 官方机器人适配器（q.qq.com 开放平台，v2 API）。
 *
 * 与 OneBotAdapter 同事件面：'event'（消息）/ 'notice'（进退群）/ 'status'（连接状态）。
 * 协议要点（依据官方 botpy SDK 源码逐行核对）：
 *  - Access Token: POST https://bots.qq.com/app/getAppAccessToken {appId, clientSecret}
 *      → { access_token, expires_in }；提前 60s 刷新，Authorization 头用 "QQBot <token>"
 *  - API 域名: https://api.sgroup.qq.com（沙箱 sandbox.api.sgroup.qq.com）
 *  - 网关: GET /gateway → { url }，WSS op 协议与 Discord 同族：
 *      10 Hello(心跳间隔) → 2 Identify{token, intents, shard} → 0 Dispatch
 *      心跳 op1 每 30s（按 Hello 的 d.heartbeat_interval），ack op11
 *  - intents: 1<<25 = public_messages（群/C2C 公域消息）
 *  - 群消息事件 GROUP_AT_MESSAGE_CREATE：{id, content, author:{member_openid}, group_openid}
 *  - 发群消息: POST /v2/groups/{group_openid}/messages {content, msg_id, msg_seq}
 *      被动回复以 msg_id 为凭证，5 分钟内有效；同 msg_id+msg_seq 重复会失败
 *
 * 官方限制（写进设置面板提示，别让用户以为程序坏了）：
 *  - 只能收到 @机器人 的消息（公域机器人）
 *  - 主动消息个人主体仅 4 条/月，日常聊天基本只能被动回复
 *  - 文本里带链接需 ICP 备案，否则发送失败
 *  - 收不到图片/表情（官方不下发），rich media 要单独传文件接口
 */
const EventEmitter = require('events');
const https = require('https');

const AUTH_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';
const INTENT_PUBLIC_MESSAGES = 1 << 25;

function dbg(...args) {
  if (process.env.QUNZAI_DEBUG) console.log('[qqbot]', ...args);
}

/** 极简 JSON POST（不引第三方依赖，群崽全程零 npm 依赖） */
function httpJson(url, { method = 'POST', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        ...(data ? { 'Content-Length': data.length } : {}),
        ...headers
      },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else {
          const err = new Error('HTTP ' + res.statusCode + ': ' + raw.slice(0, 300));
          err.status = res.statusCode;
          err.body = json;
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 剥掉 @ 段（官方 content 形如 "<@!ABCDE_123>/text"），得到纯文本 */
function stripAtPrefix(content) {
  return String(content || '')
    .replace(/^\s*<@!?[A-Za-z0-9_]+>\s*/g, '')
    .replace(/^\s+/g, '');
}

class QQOfficialAdapter extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.appId = String(opts.appId || '');
    this.clientSecret = String(opts.clientSecret || '');
    this.sandbox = !!opts.sandbox;
    this._token = null;          // { value, expiresAt }
    this._ws = null;
    this._helloTimer = null;     // 心跳定时器
    this._refreshTimer = null;   // token 刷新定时器
    this._sessionId = null;      // 断线 resume 用
    this._lastSeq = null;
    this._everOpened = false;
    this._closedByUs = false;
    this._reconnectDelay = 5000;
    this._seqMap = new Map();    // msg_id -> 下一个 msg_seq（被动回复去重）
    this.self = { userId: this.appId, nickname: 'QQ机器人' };
  }

  start() {
    this._closedByUs = false;
    this._refreshTokenLoop();
    this._connectGateway();
  }

  /** 与 OneBotAdapter 对齐的生命周期名（server.js rebuildAdapter 统一调 connect()） */
  connect() {
    this.start();
  }

  close() {
    this._closedByUs = true;
    clearTimeout(this._helloTimer);
    clearTimeout(this._refreshTimer);
    this._closeWs(1000);
    // 凭证作废：飞行的异步 tick 恢复后看到 closedByUs 直接退出，不会再发请求
    this._token = null;
  }

  /* ---------- Access Token ---------- */
  async _fetchToken() {
    const r = await httpJson(AUTH_URL, {
      body: { appId: this.appId, clientSecret: this.clientSecret },
      headers: { 'Content-Type': 'application/json' }
    });
    if (!r || !r.access_token) throw new Error('获取 access_token 失败: ' + JSON.stringify(r).slice(0, 200));
    // expires_in 秒；提前 2 分钟过期，避免临界
    const ttlMs = Math.max(60, (Number(r.expires_in) || 7200) - 120) * 1000;
    this._token = { value: r.access_token, expiresAt: Date.now() + ttlMs };
    dbg('token refreshed, ttl', Math.round(ttlMs / 1000), 's');
    return this._token.value;
  }

  _refreshTokenLoop() {
    clearTimeout(this._refreshTimer);
    const tick = async () => {
      /* close() 之后必须彻底停摆：飞行的 tick 恢复执行时若不检查，
         会再挂一个新的 setTimeout —— 旧适配器变成僵尸，每分钟报一次
         「invalid appid or secret」，用户明明改对了还是看到红条 */
      if (this._closedByUs) return;
      try {
        if (!this._token || Date.now() >= this._token.expiresAt) await this._fetchToken();
      } catch (e) {
        if (!this._closedByUs) {
          this.emit('status', { connected: false, message: '获取官方凭证失败：' + e.message + '（检查 AppID/AppSecret）' });
        }
      }
      if (this._closedByUs) return;
      // 到期前 5 分钟再刷
      const wait = this._token ? Math.max(30 * 1000, this._token.expiresAt - Date.now() - 5 * 60 * 1000) : 60 * 1000;
      this._refreshTimer = setTimeout(tick, wait);
      this._refreshTimer.unref?.();
    };
    tick();
  }

  async _authHeaders() {
    if (!this._token || Date.now() >= this._token.expiresAt) await this._fetchToken();
    return {
      Authorization: 'QQBot ' + this._token.value,
      'X-Union-Openid': this.appId
    };
  }

  /* ---------- WebSocket 网关 ---------- */
  async _connectGateway() {
    try {
      if (!this._token) await this._fetchToken();
      const headers = await this._authHeaders();
      const gw = await httpJson((this.sandbox ? 'https://sandbox.api.sgroup.qq.com' : API_BASE) + '/gateway', {
        method: 'GET', headers
      });
      const wsUrl = gw?.url;
      if (!wsUrl) throw new Error('网关地址为空');
      dbg('gateway:', wsUrl);

      const WebSocket = globalThis.WebSocket || (await import('ws')).default;
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.onopen = () => {
        this._everOpened = true;
        this._reconnectDelay = 5000;
        if (this._sessionId) this._resume();
        // identify 在收到 hello（op10）后发，见 onmessage
      };
      ws.onmessage = (ev) => this._onWsMessage(String(ev.data));
      ws.onclose = () => this._onWsClose();
      ws.onerror = () => { /* close 事件会跟上来，状态提示放 _onWsClose */ };
    } catch (e) {
      if (!this._closedByUs) {
        this.emit('status', { connected: false, message: '连接官方网关失败：' + e.message });
        this._scheduleReconnect();
      }
    }
  }

  _onWsMessage(raw) {
    let p;
    try { p = JSON.parse(raw); } catch { return; }
    const op = p.op;
    if (op === 10) {   // Hello：下发心跳间隔
      const interval = (p.d && p.d.heartbeat_interval) || 30 * 1000;
      this._identifyOrResume();
      clearInterval(this._helloTimer);
      this._helloTimer = setInterval(() => this._sendJson({ op: 1, d: this._lastSeq }), interval);
      this._helloTimer.unref?.();
      return;
    }
    if (op === 11) return;   // heartbeat ack
    if (op === 9) {          // invalid session：丢弃 resume，重新 identify
      this._sessionId = null;
      setTimeout(() => this._identifyOrResume(), 1000);
      return;
    }
    if (op === 7) {          // 服务端要求重连
      this._closeWs(4000);
      return;
    }
    if (op === 0) {          // Dispatch
      this._lastSeq = p.s;
      if (p.t === 'READY') {
        this._sessionId = p.d?.session_id;
        this.self = { userId: p.d?.user?.id || this.appId, nickname: p.d?.user?.username || 'QQ机器人' };
        this.emit('status', { connected: true, message: '已连接官方机器人（' + this.self.userId + '）' });
        return;
      }
      if (p.t === 'RESUMED') {
        this.emit('status', { connected: true, message: '已重连官方网关' });
        return;
      }
      this._dispatch(p.t, p.d);
    }
  }

  _identifyOrResume() {
    if (this._sessionId && this._lastSeq != null) return this._resume();
    this._sendJson({
      op: 2,
      d: {
        token: 'QQBot ' + (this._token ? this._token.value : ''),
        intents: INTENT_PUBLIC_MESSAGES,
        shard: [0, 1]
      }
    });
  }

  _resume() {
    this._sendJson({
      op: 6,
      d: { token: 'QQBot ' + (this._token ? this._token.value : ''), session_id: this._sessionId, seq: this._lastSeq }
    });
  }

  _sendJson(obj) {
    if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(obj));
  }

  _closeWs(code) {
    clearInterval(this._helloTimer);
    if (this._ws) { try { this._ws.close(code); } catch { /* ignore */ } this._ws = null; }
  }

  _onWsClose() {
    clearInterval(this._helloTimer);
    this._ws = null;
    if (this._closedByUs) return;
    this.emit('status', {
      connected: false,
      message: this._everOpened ? '连接中断，正在重连…' : '无法连接官方网关（检查网络/AppID/AppSecret）'
    });
    this._scheduleReconnect();
  }

  /* _connectGateway 的 catch 分支同样受 _closedByUs 保护（放在方法里统一判） */

  _scheduleReconnect() {
    if (this._closedByUs) return;
    setTimeout(() => {
      if (!this._closedByUs) this._connectGateway();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(60 * 1000, Math.round(this._reconnectDelay * 1.5));
  }

  /* ---------- 事件归一化：对齐 OneBotAdapter 的 msg 形状 ---------- */
  _dispatch(t, d) {
    if (!d) return;
    if (t === 'GROUP_AT_MESSAGE_CREATE') {
      const msg = {
        id: String(d.id || ''),
        chatType: 'group',
        chatId: String(d.group_openid || ''),
        chatName: '',                      // 官方不下发群名，用 openid 兜底
        fromId: String(d.author?.member_openid || ''),
        fromName: '',                      // 公域不下发昵称 —— 面板显示 openid
        self: false,
        text: stripAtPrefix(d.content),
        raw: d.content || '',
        mentionsMe: true,                  // 公域群消息本来就是 @机器人 才有的
        mentions: 1,
        images: [],
        stickers: [],
        time: Date.now(),
        official: true                     // 标记来源，方便别处区分能力差异
      };
      this.emit('event', msg);
      return;
    }
    if (t === 'C2C_MESSAGE_CREATE') {
      this.emit('event', {
        id: String(d.id || ''),
        chatType: 'private',
        chatId: String(d.author?.user_openid || ''),
        chatName: '',
        fromId: String(d.author?.user_openid || ''),
        fromName: '',
        self: false,
        text: String(d.content || ''),
        raw: d.content || '',
        mentionsMe: false,
        mentions: 0,
        images: [],
        stickers: [],
        time: Date.now(),
        official: true
      });
      return;
    }
    if (t === 'GROUP_ADD_ROBOT' || t === 'GROUP_DEL_ROBOT') {
      this.emit('notice', {
        type: t === 'GROUP_ADD_ROBOT' ? 'group_increase' : 'group_decrease',
        chatId: String(d.group_openid || ''),
        chatName: '',
        userId: String(d.op_member_openid || d.user_openid || ''),
        userName: '',
        selfId: this.appId,
        time: Date.now(),
        raw: d
      });
      return;
    }
    dbg('未处理事件:', t);
  }

  /* ---------- 发消息 ---------- */
  _nextSeq(msgId) {
    if (!msgId) return undefined;
    const n = (this._seqMap.get(msgId) || 0) + 1;
    this._seqMap.set(msgId, n);
    // 防 Map 无限长：只留最近的
    if (this._seqMap.size > 500) {
      const first = this._seqMap.keys().next().value;
      this._seqMap.delete(first);
    }
    return n;
  }

  async sendText(chat, text, opts = {}) {
    const isGroup = chat.type === 'group';
    const url = isGroup
      ? API_BASE + '/v2/groups/' + encodeURIComponent(chat.targetId) + '/messages'
      : API_BASE + '/v2/users/' + encodeURIComponent(chat.targetId) + '/messages';
    // 被动回复：带 msg_id（触发那条消息的官方 id）。超过 5 分钟的凭证已失效，降级成主动消息（个人额度极少）。
    // ai.js 的约定是 sendOpts.quoteId = 触发消息的 msg.id —— qqbot 模式下那就是官方消息 id，
    // 直接拿来当 msg_id 用（别要求什么前缀，OneBot 的数字 id 进不了这个适配器）。
    const passiveId = opts.quoteId ? String(opts.quoteId) : null;
    const body = {
      msg_type: 0,
      content: text,
      msg_id: passiveId || undefined,
      msg_seq: this._nextSeq(passiveId),
      event_id: undefined
    };
    const headers = await this._authHeaders();
    headers['Content-Type'] = 'application/json';
    try {
      return await httpJson(url, { body, headers });
    } catch (e) {
      // 被动凭证过期（code 304023/304024 官方文档值，这里宽匹配 3040**）→ 明确提示而不是反复失败
      if (e.status === 400 && /3040/.test(String(e.body?.message || e.message))) {
        throw new Error('被动回复窗口已过（官方限制 5 分钟），这条没法回了');
      }
      // 主动消息无权限：个人主体默认只发 4 条/月，且要用户先接受机器人
      if (e.status === 400 && /40034105/.test(String(e.body?.message || e.message))) {
        throw new Error('官方限制：没有主动发消息权限（个人额度 4 条/月），只能在收到消息后 5 分钟内回复');
      }
      throw e;
    }
  }

  async sendSegments(chat, segments) {
    // 官方公域机器人不支持任意段拼接，文本以外的走富媒体接口（v2 阶段先降级：拼出纯文本）
    const text = segments.map((s) => (s.type === 'text' ? s.data?.text : '')).join('');
    // 全是图片/表情段时拼出来是空串 → 官方 400「content字段不能为空」（真实踩过）。
    // 给个占位，让回复至少发得出去。
    return this.sendText(chat, text.trim() || '（表情）');
  }

  /** 管理操作官方 API 没有（禁言/踢人），统一明确报错，别静默吞掉 */
  async callAction(action) {
    throw new Error('官方机器人 API 不支持 ' + action + '（群管理能力未开放）');
  }
}

module.exports = { QQOfficialAdapter, stripAtPrefix, INTENT_PUBLIC_MESSAGES };
