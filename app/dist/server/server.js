'use strict';
/**
 * 网页版 QQ 服务端
 *   - 托管 public/ 静态页面
 *   - REST：状态 / 会话 / 消息 / 发送 / 设置 / 好友群列表
 *   - SSE  ：实时把 QQ 消息、AI 状态推给网页
 *   - QQ   ：通过 qq-adapter 接入（OneBot 11 或演示模式）
 *   - AI   ：ai.js 自动回复
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const configLib = require('./config');
const { version: APP_VERSION } = require('./version');
const ports = require('./ports');
const { Store } = require('./store');
const { createAdapter } = require('./qq-adapter');
const { AIResponder } = require('./ai');
const { QQEngine } = require('./engine');
const { Updater } = require('./updater');
const { DeepSeekWeb, siteList } = require('./deepseek-web');
const { StickerLibrary } = require('./stickers');
const { OnlineGallery } = require('./sticker-gallery');
const { resolveDataDir, platformInfo } = require('./platform');

/* ---------------- 日志系统：控制台实时显示 + data\app.log 持久落盘（追加、不截断） ---------------- */
const _tsNow = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const _logDir = resolveDataDir(configLib.ROOT);
const _logFile = path.join(_logDir, 'app.log');
function _rotateIfNeeded() {
  try {
    fs.mkdirSync(_logDir, { recursive: true });
    // 超 5MB 自动留档，重新开一个（旧日志 app.<时间戳>.log 保留可查）
    if (fs.existsSync(_logFile) && fs.statSync(_logFile).size > 5 * 1024 * 1024) {
      fs.renameSync(_logFile, path.join(_logDir, `app.${Date.now()}.log`));
    }
  } catch { /* noop */ }
}
function _toLine(args) {
  return args.map((x) => {
    if (typeof x === 'string') return x;
    if (x && x.stack) return x.stack;
    try { return JSON.stringify(x); } catch { return String(x); }
  }).join(' ');
}
function _writeLog(line) {
  try { fs.appendFileSync(_logFile, line + '\n'); } catch { /* noop */ }
}
console.log = ((orig) => (...a) => { const l = `[${_tsNow()}] [INFO] ${_toLine(a)}`; orig(l); _writeLog(l); })(console.log);
console.warn = ((orig) => (...a) => { const l = `[${_tsNow()}] [WARN] ${_toLine(a)}`; orig(l); _writeLog(l); })(console.warn);
console.error = ((orig) => (...a) => { const l = `[${_tsNow()}] [ERROR] ${_toLine(a)}`; orig(l); _writeLog(l); })(console.error);
_rotateIfNeeded();
{
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  console.log(`======== 群崽 QunZai 服务启动 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ========`);
  console.log('  -----------------------------------------------');
  console.log('  ⚠️ 玩具级学习作品，非生产级产品。使用即表示你已接受：');
  console.log('     · 自动发送 AI 生成内容到 QQ，请勿用于骚扰/刷屏，建议小号');
  console.log('     · 本软件仅学习使用，请在 24h 内删除——它是玩具，试过就好');
  console.log('     · 非反代/无中转/无逆向，但 CDP 驱动网页版违反 DeepSeek 用户协议');
  console.log('     · 数据仅存本机，无遥测；一切后果由使用者自担');
  console.log('     · 问题反馈：github.com/BlushHorizon/QunZai/issues   MIT 开源');
  console.log('  -----------------------------------------------');
}
/** 运行计数（由 broadcast 汇总，供心跳行输出） */
const stats = { inMsgs: 0, aiReplies: 0, skips: 0 };

const cfg = configLib.load();
const ROOT = configLib.ROOT;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录（会话库 / 表情包缓存 / 日志）：安卓上可能与程序目录分开
const DATA_DIR = resolveDataDir(ROOT);

const store = new Store(ROOT, { dataDir: DATA_DIR });

/* ---------------- SSE 客户端 ---------------- */
const sseClients = new Set();

function broadcast(evt) {
  // 运行计数（心跳行用）
  if (evt.type === 'message' && evt.message && !evt.message.self) stats.inMsgs++;
  if (evt.type === 'ai_replied') stats.aiReplies++;
  if (evt.type === 'ai_skip') stats.skips++;
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

/* ---------------- QQ 适配器 ---------------- */
let adapter = createAdapter(cfg.qq);
let qqStatus = { connected: false, message: '未连接', mode: cfg.qq.mode };

/**
 * 把适配器的事件绑到当前外壳。
 * 重建适配器后必须重新绑一遍——不然新实例收不到任何消息，
 * 界面显示"已连接"其实是个聋子（这是改端口那个修法的配套坑）。
 */
function bindAdapterEvents(a = adapter) {
  a.on('status', (s) => {
    qqStatus = { ...s, mode: configLib.get().qq.mode };
    console.log(`[qq:${qqStatus.mode}] ${s.message}`);
    broadcast({ type: 'qq_status', status: qqStatus, ai: ai.status() });
    if (s.connected && qqStatus.mode === 'onebot') seedContacts();
  });
  a.on('event', onAdapterEvent);
}
bindAdapterEvents();

/**
 * 用当前配置重建 QQ 适配器并重连。
 * 改过 OneBot WS 地址 / AccessToken / 接入模式后必须走这里——
 * 直接 adapter.connect() 会复用启动时的旧 wsUrl，填什么都没用。
 */
let adapterRetryTimer = null;
function rebuildAdapter(reason = '') {
  const qqCfg = configLib.get().qq;        // 重新从 config 取，确保拿到刚保存的值
  try { adapter.close(); } catch { /* noop */ }
  const next = createAdapter(qqCfg);
  adapter = next;
  bindAdapterEvents(next);
  // AI 回复、表情包发送都各自存了一份 adapter 引用，必须一起换成新实例，
  // 否则它们会继续对着已经 close() 的旧连接发消息 → 全部报「OneBot 未连接」
  try { ai.adapter = next; } catch { /* 启动早期还没建好 */ }
  try { stickerLib.adapter = next; } catch { /* 同上 */ }
  qqStatus = { connected: false, message: '正在重连…', mode: qqCfg.mode };
  broadcast({ type: 'qq_status', status: qqStatus, ai: ai.status() });
  console.log(`[qq] 按新配置重建适配器${reason ? '（' + reason + '）' : ''}：${qqCfg.mode === 'onebot' ? qqCfg.onebot?.wsUrl : '演示模式'}`);
  // 连点「保存」会短时间内调用多次：只保留最后一个待连实例，
  // 否则几次 300ms 定时器一起触发，会同时建出多条 OneBot 连接
  if (adapterRetryTimer) { clearTimeout(adapterRetryTimer); adapterRetryTimer = null; }
  adapterRetryTimer = setTimeout(() => {
    adapterRetryTimer = null;
    if (adapter !== next) return;          // 期间又被重建过，这个实例已作废
    try { next.connect(); } catch (e) { console.warn('[qq] 重连失败:', e.message); }
  }, 300);
}

/* ---------------- 群崽 QQ 内核 ---------------- */
const engine = new QQEngine({
  root: ROOT,
  getConfig: () => configLib.get(),
  saveConfig: (patch) => configLib.save(patch)
});
// 扫码登录完成后台自动接上：换适配器 + 把状态推给网页，用户不用再点一次
engine.onReady = (result) => {
  try {
    console.log(`[engine] 扫码登录完成：${result.login || result.info.account || '未知账号'} @ ${result.info.wsPort}`);
    if (result.changed) rebuildAdapter('QQ 内核登录完成');
    engine.status().then((st) => broadcast({ type: 'engine_status', engine: st })).catch(() => {});
  } catch (err) {
    console.warn('[engine] 登录后同步失败:', err.message);
  }
};

const updater = new Updater({
  root: ROOT,
  currentVersion: APP_VERSION,
  getConfig: () => configLib.get()
});

/** 把好友/群拉进会话列表，这样网页打开就能直接看到全部联系人 */
let seeding = false;
async function seedContacts() {
  if (seeding) return;
  seeding = true;
  try {
    const [friends, groups] = await Promise.all([
      adapter.fetchFriends().catch(() => []),
      adapter.fetchGroups().catch(() => [])
    ]);
    for (const f of friends || []) store.ensureChat('private', f.raw ?? f.id, f.name);
    for (const g of groups || []) store.ensureChat('group', g.raw ?? g.id, g.name);
    broadcast({ type: 'contacts_seeded', chats: store.listChats() });
    console.log(`[qq] 已载入联系人：${(friends || []).length} 好友 / ${(groups || []).length} 群`);
  } catch (err) {
    console.warn('[qq] 载入联系人失败:', err.message);
  } finally {
    seeding = false;
  }
}

/**
 * 收到一条 QQ 来信（事件处理主体）。
 * 用函数声明而不是就地绑箭头函数：它是被 bindAdapterEvents 复用的，
 * 重建适配器时才能把同一个处理函数重新挂到新实例上。
 */
function onAdapterEvent(msg) {
  const chat = store.ensureChat(msg.chatType, msg.chatId, msg.chatName || undefined);
  if (!msg.chatName && msg.chatType === 'private') chat.name = msg.fromName || chat.name;
  store.addMessage(msg);
  {
    // 每条来信入日志：群/私 + 来源 + 内容（或图片）
    const where = msg.chatType === 'group' ? `群[${chat.name || msg.chatId}]` : `私[${msg.fromName || msg.chatId}]`;
    const body = msg.text || (msg.images && msg.images.length ? `<图片x${msg.images.length}>` : msg.raw || '(空)');
    console.log(`[消息] 收到 ${where} ${msg.fromName || ''}: ${String(body).slice(0, 80)}`);
  }
  broadcast({ type: 'message', message: msg, chat });

  // 表情包素材收集（内置功能），出错不影响主流程
  try { stickerLib.collect(msg); } catch { /* noop */ }

  // 触发 AI 自动回复（EAgent 式自动应答）
  ai.handle(msg).catch((e) => console.warn('[ai] handle 出错:', e.message));
}

/* ---------------- AI ---------------- */
// 桌面内嵌模式会通过环境变量指定 CDP 端口，确保 WebView2 和 Node 驱动连的是同一个端口
const preferredCdpPort = Number(process.env.QUNZAI_CDP_PORT || cfg.ai?.cdpPort || 9222) || 9222;
const deepseek = new DeepSeekWeb({
  port: preferredCdpPort,
  profileDir: path.join(DATA_DIR, 'deepseek_profile'),
  browserPath: cfg.ai?.browserPath || '',
  site: cfg.ai?.webProvider || 'deepseek',   // 网页版站点：当前内置 deepseek
  // 提示词不在这给：等 ai 创建后统一 configure(ai._fullPrompt())——
  // 完整提示词 = 用户人设 + 【表情包能力】段，所有入口只认这一个来源
  prompt: '',
  maxRounds: cfg.ai?.webMaxRounds || 50,
  onStatus: (st) => {
    console.log(`[deepseek:${st.site}] ${st.state}: ${st.message}`);
    broadcast({ type: 'deepseek_status', status: st, ai: ai.status() });
  }
});

/* ---------------- 表情包（内置） ---------------- */
const stickerLib = new StickerLibrary({
  dataDir: DATA_DIR,
  adapter,
  log: (t) => console.log(`[表情包] ${t}`)
});

// 在线表情图库（梗鲸 · DeepSeek娘）：群友素材里找不到时按描述现取一张。
// 目录 7 天缓存一次；站点不可达就静默降级，不影响聊天。
const gallery = new OnlineGallery({
  dataDir: DATA_DIR,
  cacheDir: stickerLib.cacheDir,
  log: (t) => console.log(`[表情图库] ${t}`)
});
stickerLib.setGallery(gallery);

const ai = new AIResponder({
  config: cfg.ai,
  store,
  adapter,
  broadcast,
  deepseek,
  sticker: stickerLib,
  getConfig: () => configLib.get(),
  saveConfig: () => configLib.save({})
});

// 唯一提示词入口：完整提示词（人设 +【表情包能力】段）在此注入 DeepSeek 驱动。
// 之后启动自动发、②新建对话、50 轮换轮、保存设置、每条消息补发——全部用它。
deepseek.configure({ site: cfg.ai?.webProvider || 'deepseek', prompt: ai._fullPrompt(), maxRounds: cfg.ai?.webMaxRounds || 50 });

// 防抽风看门狗：DeepSeek 驱动思考卡死超时自动复位（每分钟检查一次）
setInterval(() => {
  try { deepseek.watchdog?.(); } catch { /* noop */ }
}, 60 * 1000).unref?.();

// 心跳行：每 60 秒一条运行状态（日志窗口始终“活着”，随时可巡检）
setInterval(() => {
  let dsState = '-';
  try { dsState = deepseek.status ? deepseek.status().state : '-'; } catch { /* noop */ }
  console.log(`[心跳] QQ=${qqStatus.connected ? '已连接' : '断开'} | 会话=${store.chats.size} | 收信=${stats.inMsgs} AI回=${stats.aiReplies} 跳过=${stats.skips} | DeepSeek=${dsState}`);
}, 60 * 1000).unref?.();

/* ---------------- 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400); res.end('bad request'); return;
  }
  if (decoded.includes('\0')) { res.writeHead(400); res.end('bad request'); return; }
  const rel = decoded === '/' ? '/index.html' : decoded;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([\\/])+/, ''));
  const relative = path.relative(PUBLIC_DIR, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // 单页应用兜底
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      qq: qqStatus,
      self: adapter.self,
      ai: ai.status(),
      version: APP_VERSION,
      runtime: ports.readRuntime(ROOT),
      embedded: process.env.QUNZAI_EMBEDDED === '1',
      // 平台信息：前端据此隐藏不适用的入口（安卓没有网页版/自更新）
      platform: platformInfo()
    });
  }

  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', qq: qqStatus, ai: ai.status() })}\n\n`);
    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* noop */ } }, 25000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  if (p === '/api/chats' && req.method === 'GET') {
    return sendJson(res, 200, { chats: store.listChats() });
  }

  if (p.startsWith('/api/chats/') && p.endsWith('/messages')) {
    const chatId = decodeURIComponent(p.slice('/api/chats/'.length, -'/messages'.length));
    return sendJson(res, 200, { messages: store.historyForDisplay(chatId) });
  }

  if (p === '/api/contacts' && req.method === 'GET') {
    try {
      const [friends, groups] = await Promise.all([
        adapter.fetchFriends().catch(() => []),
        adapter.fetchGroups().catch(() => [])
      ]);
      return sendJson(res, 200, { friends, groups });
    } catch (err) {
      return sendJson(res, 500, { error: err.message, friends: [], groups: [] });
    }
  }

  if (p === '/api/send' && req.method === 'POST') {
    const body = await readBody(req);
    const { chatId, text } = body;
    if (!chatId || !text || !String(text).trim()) {
      return sendJson(res, 400, { error: '缺少 chatId 或 text' });
    }
    const chat = store.chats.get(chatId);
    if (!chat) return sendJson(res, 404, { error: '会话不存在' });
    try {
      const trimmed = String(text).trim();
      // 可选调试参数：body.at 群聊@成员，body.quoteId 引用消息（仅群聊生效）
      const sendOpts = { at: body.at ? String(body.at) : '', quoteId: body.quoteId || '' };
      await adapter.sendText({ type: chat.type, targetId: chat.targetId }, trimmed, sendOpts);
      // 多数 OneBot 实现（SnowLuma / NapCat）默认不上报自己发送的消息，
      // 这里补一条本地回显，保证网页端能立即看到自己发出的内容
      const echoMsg = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        chatType: chat.type,
        chatId: String(chat.targetId),
        chatName: chat.name,
        fromId: String(adapter.self?.userId || ''),
        fromName: adapter.self?.nickname || '我',
        self: true,
        text: trimmed,
        raw: trimmed,
        mentionsMe: false,
        mentions: 0,
        time: Date.now()
      };
      store.addMessage(echoMsg);
      const updated = store.chats.get(chatId) || chat;
      broadcast({ type: 'message', message: echoMsg, chat: updated });
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (p === '/api/chat/read' && req.method === 'POST') {
    const body = await readBody(req);
    store.markRead(body.chatId);
    const chat = store.chats.get(body.chatId);
    return sendJson(res, 200, { ok: true, chat });
  }

  if (p === '/api/settings') {
    // 读=GET、写=POST（内层已限定），其他方法不放行
    if (req.method === 'GET') {
      const c = configLib.get();
      const token = c.qq?.onebot?.accessToken || '';
      // 凭证一律不回明文：Key 只回「已配置」，Token 只回后 4 位。
      // 面板是全屏可截图的，明文摆在那儿等于随手泄露。
      return sendJson(res, 200, {
        server: c.server,
        qq: {
          ...c.qq,
          onebot: {
            ...c.qq.onebot,
            accessToken: token ? '********' + token.slice(-4) : '',
            hasToken: !!token
          }
        },
        ai: { ...c.ai, apiKey: c.ai.apiKey ? '********' : '', hasKey: !!c.ai.apiKey },
        update: { ...(c.update || {}) }
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (body.ai) {
        patch.ai = { ...body.ai };
        if (!body.ai.apiKey || /^\*{3,}$/.test(String(body.ai.apiKey))) patch.ai.apiKey = configLib.get().ai.apiKey;
      }
      if (body.qq) {
        patch.qq = { ...body.qq };
        const nextOb = patch.qq.onebot;
        if (nextOb && typeof nextOb.accessToken === 'string') {
          const prev = configLib.get().qq?.onebot?.accessToken || '';
          // 掩码原样回传 → 保留原值（用户没动这一栏）；留空 → 明确清除
          if (/^\*{4,}[A-Za-z0-9_-]{0,8}$/.test(nextOb.accessToken)) nextOb.accessToken = prev;
        }
      }
      /* 先记下旧的 QQ 接入配置，判断是否需要重建适配器 */
      if (body.update) patch.update = { ...body.update };
      const beforeQQ = JSON.stringify(configLib.get().qq);
      configLib.save(patch);
      if (patch.ai) {
        const c = configLib.get();
        deepseek.configure({
          site: c.ai.webProvider || 'deepseek',   // 网页版站点档案见 server/web-sites.js
          prompt: ai._fullPrompt(),   // 用户人设 +【表情包能力】段（与启动/新建对话同源）
          maxRounds: c.ai.webMaxRounds ?? 50,
          port: c.ai.cdpPort,
          browserPath: c.ai.browserPath
        });
      }
      /* QQ 接入方式 / WS 地址 / AccessToken 变了 → 按新配置重建适配器并重连。
         不这么做的话，改了端口也白改：适配器启动时就固定了 wsUrl。 */
      let qqReconnected = false;
      if (patch.qq && JSON.stringify(configLib.get().qq) !== beforeQQ) {
        qqReconnected = true;
        rebuildAdapter('设置已修改');
      }
      broadcast({ type: 'settings_changed', ai: ai.status(), qq: qqStatus });
      return sendJson(res, 200, { ok: true, qqReconnected });
    }
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '仅支持 GET / POST' }));
    return;
  }

  /* ---------------- 网页版模型（切换模型） ---------------- */
  /* ---------------- 群崽 QQ 内核 ---------------- */
  if (p === '/api/engine/status' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, engine: await engine.status() });
  }

  if (p === '/api/engine/scan' && req.method === 'POST') {
    const body = await readBody(req);
    const found = await engine.discover({
      dir: String(body.dir || '').trim(),
      account: String(body.account || '').trim()
    });
    return sendJson(res, 200, found.ok
      ? { ok: true, engine: found.public }
      : { ok: false, error: found.error, tried: found.tried });
  }

  if (p === '/api/engine/start' && req.method === 'POST') {
    const body = await readBody(req);
    const result = await engine.start({
      dir: String(body.dir || '').trim(),
      account: String(body.account || '').trim()
    });
    if (result.ok) {
      if (result.changed) rebuildAdapter('QQ 内核已自动配置');
      broadcast({ type: 'engine_status', engine: await engine.status() });
    }
    return sendJson(res, 200, result);
  }

  if (p === '/api/engine/stop' && req.method === 'POST') {
    const result = engine.stop();
    broadcast({ type: 'engine_status', engine: await engine.status() });
    return sendJson(res, 200, result);
  }

  /* 未登录时的登录二维码：直接从内置运行时的 cache 目录读，不落 data/、不缓存 */
  if (p === '/api/engine/qr' && req.method === 'GET') {
    const file = engine.qrFile(engine.lastInfo || {});
    if (!file) return sendJson(res, 404, { error: '还没有生成二维码，先点「启动并同步」' });
    try {
      const buf = fs.readFileSync(file);
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs > 5 * 60 * 1000) {
        return sendJson(res, 410, { error: '二维码已过期，点「启动并同步」会重新生成' });
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      res.end(buf);
      return;
    } catch {
      return sendJson(res, 404, { error: '二维码读不到' });
    }
  }

  /* ---------------- 自动更新（只检查，下载/安装必须用户确认） ---------------- */
  if (p === '/api/update/check' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      return sendJson(res, 200, await updater.check());
    } catch (err) {
      return sendJson(res, 200, { ok: false, configured: true, error: err.message });
    }
  }

  if (p === '/api/update/download' && req.method === 'POST') {
    try {
      return sendJson(res, 200, await updater.download());
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  // 下载进度（前端轮询）：只暴露百分比和速度，不暴露地址
  if (p === '/api/update/progress' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, ...(updater.progress || { downloading: false }) });
  }

  if (p === '/api/update/install' && req.method === 'POST') {
    return sendJson(res, 200, updater.install());
  }

  if (p === '/api/web/sites' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, sites: siteList(), current: deepseek.status().site });
  }

  if (p === '/api/web/open' && req.method === 'POST') {
    const body = await readBody(req);
    const site = String(body.site || '').trim();
    if (site) deepseek.configure({ site });
    const st = deepseek.status();
    const okOpen = await deepseek.openPage();
    return sendJson(res, 200, { ok: !!okOpen, site: st.site, siteName: st.siteName, url: st.siteUrl });
  }

  if (p === '/api/ai/toggle' && req.method === 'POST') {
    const body = await readBody(req);
    configLib.save({ ai: { enabled: !!body.enabled } });
    broadcast({ type: 'settings_changed', ai: ai.status(), qq: qqStatus });
    return sendJson(res, 200, { ok: true, ai: ai.status() });
  }

  if (p === '/api/mock/incoming' && req.method === 'POST') {
    if (configLib.get().qq?.mode !== 'mock' || typeof adapter.simulateIncoming !== 'function') {
      return sendJson(res, 400, { error: '非演示模式' });
    }
    const body = await readBody(req);
    const chat = store.chats.get(body.chatId);
    adapter.simulateIncoming(chat?.type || 'private', chat?.targetId || body.chatId || '10001');
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/ai/deepseek/status' && req.method === 'GET') {
  return sendJson(res, 200, deepseek.status());
}

if (p === '/api/ai/deepseek/open' && req.method === 'POST') {
  const ok = await deepseek.openPage();
  return sendJson(res, 200, { ok, status: deepseek.status() });
}

if (p === '/api/ai/deepseek/new' && req.method === 'POST') {
  const ok = await deepseek.newConversation();
  broadcast({ type: 'deepseek_status', status: deepseek.status() });
  return sendJson(res, 200, { ok });
}

if (p === '/api/ai/api/new' && req.method === 'POST') {
  /* API 模式「新建对话」：OpenAI 兼容接口本身无状态，每轮都把完整 messages 发过去。
     所以「新建对话」= 清空喂给模型的上下文记忆，之后不再带上这次之前的聊天记录。
     选了会话就只清那个会话；不选就清全部。
     聊天记录本身（会话概览里的消息）不会被删，只是不再进 AI 的上下文。 */
  try {
    const body = await readBody(req);
    const chatId = String(body.chatId || '').trim();
    const at = ai.resetContext(chatId || null);
    broadcast({ type: 'ai_context_reset', chatId: chatId || null, at });
    return sendJson(res, 200, { ok: true, chatId: chatId || null, at });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

if (p === '/api/ai/deepseek/test' && req.method === 'POST') {
  try {
    const body = await readBody(req);
    const text = body.text || '用一句话跟朋友说你晚上有空吃饭。';
    const started = Date.now();
    const reply = await deepseek.ask(text);
    return sendJson(res, 200, { ok: true, reply, ms: Date.now() - started });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message, status: deepseek.status() });
  }
}

if (p === '/api/dev/ai-reply' && req.method === 'POST') {
    // 本地调试用：模拟一条"对方发来的消息"，跑通 消息 → DeepSeek 网页版 → 回发 QQ 全链路
    const body = await readBody(req);
    const chatId = String(body.chatId || '');
    if (!chatId) return sendJson(res, 400, { error: '缺少 chatId（如 private:12345 / group:67890）' });
    const chat = store.chats.get(chatId);
    if (!chat) return sendJson(res, 404, { error: '会话不存在' });
    const synthetic = {
      id: `dev-${Date.now()}`,
      chatType: chat.type,
      chatId: String(chat.targetId),
      chatName: chat.name,
      fromId: body.fromId ? String(body.fromId) : 'dev-tester',
      fromName: body.fromName || '测试消息',
      self: false,
      text: body.text || (body.imageUrl ? '' : '在吗？晚上有空一起吃饭吗'),
      raw: body.text || '',
      mentionsMe: body.mentionsMe !== false,   // 传 {mentionsMe:false} 可测群聊规则（@/概率/关键词闸门）
      mentions: body.mentionsMe !== false ? 1 : 0,
      images: body.imageUrl ? [String(body.imageUrl)] : [],
      time: Date.now()
    };
    store.addMessage(synthetic);
    broadcast({ type: 'message', message: synthetic, chat });
    const reply = await ai.handle(synthetic);
    return sendJson(res, 200, { ok: true, handled: true, ai: ai.status() });
  }

if (p === '/api/qq/reconnect' && req.method === 'POST') {
    /* 必须重建而不是复用，否则仍然连的是启动时的旧地址 */
    rebuildAdapter('手动重连');
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------- 表情包 API ---------------- */
  if (p === '/api/stickers' && req.method === 'GET') {
    const st = stickerLib.stats();
    const items = stickerLib.list(40).map((x) => ({
      key: x.key,
      kind: x.kind,
      text: x.kind === 'mface'
        ? String(x.text || x.emojiId)
        : (String(x.url || '').match(/fileid=([^&]+)/) ? 'fileid …' + String(x.url).match(/fileid=([^&]+)/)[1].slice(-22) : String(x.url || '').slice(-46)),
      local: !!x.file,
      count: x.count || 1,
      seenAt: x.seenAt || 0
    }));
    return sendJson(res, 200, { ok: true, ...st, items });
  }

  // 缩略图：发本地副本（QQ 图链会过期，面板必须永远能看）
  if (p === '/api/stickers/img' && req.method === 'GET') {
    const key = new URL(req.url, 'http://localhost').searchParams.get('key') || '';
    const item = stickerLib.get(key);
    const m = item && item.file && String(item.file).match(/^([a-f0-9]{16,32})\.(png|jpe?g|gif|webp)$/i);
    if (!m) return sendJson(res, 404, { error: '该素材没有本地副本' });
    const abs = path.join(stickerLib.cacheDir, item.file);
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[m[2].toLowerCase()] || 'application/octet-stream';
    fs.readFile(abs, (err, buf) => {
      if (err) return sendJson(res, 404, { error: '本地副本不存在' });
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      res.end(buf);
    });
    return;
  }

  if (p === '/api/ai/api/test' && req.method === 'POST') {
    /* API 接口（OpenAI 兼容）连通性 + 测速 + 余额检测：
       - 发一条 max_tokens=1 的请求，验证 Key 可用并测出延迟（速度/ping）；
       - 仅 DeepSeek 官方接口暴露 /user/balance，其他接口大多不支持，不强求。
       取的是面板里当前填的值（baseUrl/apiKey/model），apiKey 留空则回落到已保存的。 */
    try {
      const body = await readBody(req);
      const baseRaw = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      const apiKey = String(body.apiKey || '').trim() || (configLib.get().ai.apiKey || '');
      const model = String(body.model || '').trim() || 'deepseek-chat';
      if (!baseRaw) return sendJson(res, 400, { ok: false, error: '请先填写接口地址' });
      if (!apiKey) return sendJson(res, 400, { ok: false, error: '请先填写 API Key（或先保存一次）' });
      const chatUrl = baseRaw.endsWith('/chat/completions') ? baseRaw : baseRaw + '/chat/completions';
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const resp = await fetch(chatUrl, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false })
        });
        const latencyMs = Date.now() - started;
        if (!resp.ok) {
          const txt = (await resp.text().catch(() => '')).slice(0, 160);
          return sendJson(res, 200, { ok: false, latencyMs, error: `HTTP ${resp.status} ${txt}` });
        }
        const data = await resp.json().catch(() => null);
        if (!data || !Array.isArray(data.choices) || !data.choices[0]) {
          return sendJson(res, 200, { ok: false, latencyMs, error: '返回结构异常（不是标准 OpenAI 兼容接口）' });
        }
        /* 余额检测：DeepSeek 官方接口暴露 /user/balance，其余接口多数不支持，不强求 */
        let balance = null;
        let balanceNote = '该接口未提供余额查询（仅 DeepSeek 官方接口支持）';
        try {
          const origin = (() => { try { return new URL(baseRaw).origin; } catch { return ''; } })();
          if (/deepseek/i.test(origin)) {
            const bresp = await fetch(origin + '/user/balance', {
              method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }
            }).catch(() => null);
            if (bresp && bresp.ok) {
              const bj = await bresp.json().catch(() => null);
              if (bj && Array.isArray(bj.balance_infos) && bj.balance_infos[0]) {
                const info = bj.balance_infos[0];
                balance = parseFloat(info.total_balance) || 0;
                balanceNote = `${info.currency}：总额 ${info.total_balance}（赠送 ${info.granted_balance} / 充值 ${info.topped_up_balance}）`;
              }
            } else if (bresp) {
              balanceNote = `余额接口返回 HTTP ${bresp.status}（Key 可用，余额查询受限）`;
            }
          }
        } catch (be) {
          balanceNote = '余额查询跳过：' + be.message;
        }
        return sendJson(res, 200, { ok: true, latencyMs, model, balance, balanceNote });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  if (p === '/api/stickers' && req.method === 'DELETE') {
    const body = await readBody(req);
    const gone = stickerLib.remove(String(body.key || ''));
    if (!gone) return sendJson(res, 404, { error: '没有这条素材' });
    return sendJson(res, 200, { ok: true, count: stickerLib.stats().count });
  }

  if (p === '/api/stickers/clear' && req.method === 'POST') {
    const removed = stickerLib.clear();
    return sendJson(res, 200, { ok: true, removed });
  }

  if (p === '/api/stickers/test' && req.method === 'POST') {
    const body = await readBody(req);
    const st = stickerLib.stats();
    // 测试发给"指令发送人"名单里的主人 QQ；没配就发给机器人自己
    const owner = String(configLib.get().ai?.commandSenders || '').split(/[,，;；\s]+/).filter(Boolean)[0];
    const target = owner || String(adapter.self?.userId || '');
    if (!target) return sendJson(res, 400, { error: 'QQ 未连接' });
    const kw = String(body.keyword || '').trim().slice(0, 24);
    // 本地严格匹配（有关键词就得真命中，不能拿随机图凑数）；空关键词才随机
    let pick = stickerLib.pickStrict(kw);
    let fromGallery = false;
    if (!pick && gallery.stats().count) {
      const item = gallery.pick(kw, null, { strict: true });
      if (item) {
        try {
          const abs = await gallery.ensureLocal(item);
          pick = { kind: 'image', file: abs, text: item.title, galleryId: item.id };
          fromGallery = true;
        } catch (e) {
          return sendJson(res, 502, { error: '在线图库取图失败：' + e.message });
        }
      }
    }
    if (!pick) {
      return sendJson(res, 400, {
        error: st.count
          ? `没有匹配「${kw}」的素材`
          : '素材库和在线图库都没东西可发——先确认网络能连上梗鲸图库（点「刷新图库」），或给机器人丢几个表情包让它收藏'
      });
    }
    const okSend = await stickerLib.send({ type: 'private', targetId: target }, pick);
    if (!okSend) return sendJson(res, 500, { error: '发送失败（看日志：可能图链失效）' });
    return sendJson(res, 200, {
      ok: true,
      fromGallery,
      sent: { kind: pick.kind, text: pick.text || pick.emojiId || '图片' },
      to: 'private:' + target
    });
  }

  /* ---------------- 在线表情图库 API ---------------- */
  if (p === '/api/gallery' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const kw = String(u.searchParams.get('q') || '').slice(0, 40);
    const st = gallery.stats();
    const items = gallery.list(kw, 60);
    return sendJson(res, 200, { ok: true, ...st, items });
  }

  if (p === '/api/gallery/refresh' && req.method === 'POST') {
    const r = await gallery.refresh(true);
    return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, ...gallery.stats(), error: r.error });
  }

  // 缩略图：先看本地缓存，没有就当场拉一次（面板浏览用，AI 发图不经过这里）
  if (p === '/api/gallery/img' && req.method === 'GET') {
    const id = String(new URL(req.url, 'http://localhost').searchParams.get('id') || '').replace(/\D/g, '');
    const item = id && gallery.get(id);
    if (!item) return sendJson(res, 404, { error: '没有这张图' });
    let abs = gallery.cachedPath(id);
    if (!abs) {
      try { abs = await gallery.ensureLocal(item); } catch (e) { return sendJson(res, 502, { error: '取图失败：' + e.message }); }
    }
    const ext = String(abs).split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
    fs.readFile(abs, (err, buf) => {
      if (err) return sendJson(res, 404, { error: '本地副本不存在' });
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400', 'Content-Length': buf.length });
      res.end(buf);
    });
    return;
  }

  return sendJson(res, 404, { error: 'unknown api' });
}

/* ---------------- 启动 ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.warn('[http] api 出错:', err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.on('error', (err) => {
  // 启动阶段的 EADDRINUSE 由 listenWithFallback 自己处理；这里只兜底运行期错误
  if (err && err.code === 'EADDRINUSE') return;
  console.error('[服务错误]', err && err.message ? err.message : err);
});

const serverHost = process.env.QUNZAI_SERVER_HOST || cfg.server.host || '127.0.0.1';
const preferredServerPort = Number(process.env.QUNZAI_SERVER_PORT || cfg.server.port) || 8787;

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      if (err && err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    };
    const onListening = () => {
      cleanup();
      resolve(server.address().port);
    };
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, serverHost);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

async function resolveCdpPort() {
  const current = Number(deepseek.port) || 9222;
  // 端口上已经是 CDP（可能是桌面窗口 / 上次启动的浏览器）就复用
  if (await ports.isCdp(current)) return current;
  if (await ports.isPortFree(current)) return current;
  const next = await ports.findFreePort(current + 1, { max: 60 });
  console.log(`[端口] CDP ${current} 被占用，自动切换到 ${next}`);
  deepseek.configure({ port: next });
  return next;
}

async function startHttpServer() {
  // 先定 CDP 端口，再监听 HTTP：否则网页已经能打开、但 CDP 还没定，
  // 桌面窗口可能抢先占一个端口，导致 Node 和 WebView2 连不到一起。
  const cdpPort = await resolveCdpPort();

  let actualPort = preferredServerPort;
  let listened = null;
  for (let i = 0; i < 60; i++) {
    listened = await listenOnce(actualPort);
    if (listened) break;
    console.warn(`[端口] ${actualPort} 被占用，自动尝试 ${actualPort + 1}`);
    actualPort++;
  }
  if (!listened) throw new Error('连续 60 个服务端口都被占用，无法启动');

  const url = `http://${serverHost}:${listened}`;
  ports.writeRuntime(ROOT, {
    serverPort: listened,
    cdpPort,
    host: serverHost,
    embedded: process.env.QUNZAI_EMBEDDED === '1',
    stopped: false
  });

  console.log('--------------------------------------------------');
  console.log('  网页版 QQ 助手已启动');
  console.log(`  地址：${url}`);
  if (listened !== preferredServerPort) {
    console.log(`  （端口 ${preferredServerPort} 被占用，已自动改用 ${listened}）`);
  }
  console.log(`  QQ 接入模式：${cfg.qq.mode === 'onebot' ? `OneBot 11 (${cfg.qq.onebot.wsUrl})` : '演示模式（模拟消息）'}`);
  console.log(`  AI 自动回复：${ai.status().provider}`);
  console.log(`  DeepSeek CDP：${cdpPort}`);
  console.log('--------------------------------------------------');
  adapter.connect();

  // 在线表情图库：过期才真去拉，拉失败不影响任何聊天功能
  setTimeout(() => { try { gallery.warm(); } catch { /* noop */ } }, 3000);

  // 群崽 QQ 内核：延迟一点启动，避免和网页/DeepSeek 抢启动资源。
  // 找到已运行的运行时就只同步配置；没运行才按它自己的入口启动。
  setTimeout(() => {
    engine.auto().then(async (result) => {
      if (result.ok && result.needLogin) {
        // 首次使用：内核起来了但还没登录，3001 要等扫码后才会监听
        console.log(`[engine] QQ 内核已启动，等待扫码登录：${result.loginUrl || ''}`);
        broadcast({ type: 'engine_status', engine: await engine.status() });
      } else if (result.ok) {
        console.log(`[engine] QQ 内核已就绪：${result.info.account || '未命名账号'} @ ${result.info.wsPort}`);
        if (result.changed) rebuildAdapter('QQ 内核自动同步');
        broadcast({ type: 'engine_status', engine: await engine.status() });
      } else if (!result.skipped) {
        console.log('[engine] ' + result.error);
      }
    }).catch((err) => console.warn('[engine] 自动配置失败:', err.message));
  }, 1200);
}

startHttpServer().catch((err) => {
  console.error('[启动失败]', err && err.message ? err.message : err);
  process.exit(1);
});

// 定时心跳事件，便于前端确认连接
setInterval(() => broadcast({ type: 'ping', t: Date.now() }), 30000).unref?.();

const shutdown = () => {
  console.log('\n退出中…');
  try { ports.writeRuntime(ROOT, { serverPort: 0, stopped: true }); } catch { /* noop */ }
  try { adapter.close(); } catch { /* noop */ }
  try { store.save(); } catch { /* noop */ }
  try { server.close(); } catch { /* noop */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);