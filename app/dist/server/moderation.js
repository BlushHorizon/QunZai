'use strict';
/**
 * 群管理 · 宣传片里那六条
 * ---------------------------------------------------------------------------
 *   刷屏限流 / 广告拉人拦截 / 违禁词预警 / 重复消息合并 / 新人自动欢迎 / 深夜宵禁提醒
 *
 * 为什么单独一个模块
 *   这六件事和「机器人自己说不说话」（speak-policy）是两码事：那边决定 bot 要不要开口，
 *   这边处理**别人**发的消息。混在一起的话，改限流规则会碰到插话阈值，早晚出事故。
 *
 * 安全默认（每一条都是踩过的坑换来的）
 *   - 总开关 moderation.enabled 默认 false：装上就自动删消息是不可接受的，必须用户点头。
 *   - 删消息/禁言要求机器人是本群管理员；拿不到管理员身份就只提醒，绝不动手。
 *     （硬删别人的消息会失败，日志里一堆 120，用户还以为功能坏了）
 *   - autoPunish 默认 false：默认只删消息 + 提醒，禁言要用户自己打开。
 *   - shadow 演练：只记日志不动手，先看几天再放开——和主动发言一个套路。
 *   - 主人（ai.commandSenders）与白名单永远豁免，别让 bot 把自己的主人禁言了。
 */

const { dbg } = require('./debug');

/** 宣传片上的六个功能，顺序即面板上的顺序 */
const FEATURES = ['spam', 'ad', 'banned', 'duplicate', 'welcome', 'curfew'];
const FEATURE_NAMES = {
  spam: '刷屏限流',
  ad: '广告拦截',
  banned: '违禁词',
  duplicate: '重复合并',
  welcome: '新人欢迎',
  curfew: '深夜宵禁'
};

/** 广告/拉人的默认特征。刻意不用「网址」做唯一判据：
 *  群里正常分享链接的人远多于发广告的，只按链接删会误伤一大片。 */
const AD_PATTERNS = [
  /(加|进|扫)(群|V信|微信|vx|VX|v信|薇信)/,
  // 「私聊我领取」「找我拿」这类中间常夹一个「我」，不夹「我」的也要能中
  /(私聊|私我|私信|联系|找我)(我|一下|你)?\s*(领|拿|要|买|办|聊)/,
  /(免费|低价|特价|内部)(领|送|出|代)/,
  /(兼职|刷单|返利|代理|推广|引流|拉人|招收)(员|赚|日结|工资)?/,
  /(点击|戳|复制)(链接|这里|下方)/,
  /(QQ|qq|扣扣)\s*群\s*[:：]?\s*\d{5,}/,
  /群号\s*[:：]?\s*\d{5,}/,
  /(日赚|月入|躺赚|稳赚|包过|包下款|无抵押)/
];

/** 违禁词的默认表。只做「预警」，不删——误判成本太高，让人自己判断。 */
const DEFAULT_BANNED = '色情,裸聊,约炮,赌博,博彩,网赌,毒品,冰毒,枪支,代开发票,办证,洗钱,诈骗,刷单,裸条';

const DEFAULT_MODERATION = {
  enabled: false,              // 总开关：默认关
  shadow: false,               // 演练：只记录不执行
  autoPunish: false,           // 自动禁言（默认只删消息 + 提醒）
  whitelistUsers: '',          // 豁免的 QQ（逗号分隔），主人自动豁免
  whitelistChats: '',          // 豁免的群号（逗号分隔）

  spam: {
    enabled: true,
    windowSec: 10,             // 多少秒内
    maxMsgs: 6,                // 超过这么多条算刷屏
    strikesDecayMin: 10,       // 几次算「惯犯」的衰减时间
    muteMin: 5                 // autoPunish 时禁言几分钟
  },
  ad: {
    enabled: true,
    deleteMsg: true,           // 拦截时删掉原消息
    blockLinks: false          // 连纯链接也拦（默认关，误伤太大）
  },
  banned: {
    enabled: true,
    words: DEFAULT_BANNED,
    deleteMsg: false,          // 默认只预警不删
    notifyAdmin: true          // 私聊主人
  },
  duplicate: {
    enabled: true,
    windowSec: 60,
    times: 3,                  // 同样的内容第几次开始合并
    minChars: 6,               // 太短的不算（「哈哈」「+1」是正常聊天）
    notice: true,              // 合并时在群里说一句
    deleteMsg: true            // 能删就删掉重复的那几条
  },
  welcome: {
    enabled: true,
    text: '欢迎 {name} 加入本群 👋 群公告里有规则，有问题直接问就好。',
    delaySec: 2                // 等人进群站稳再说，太急像机器人
  },
  curfew: {
    enabled: true,
    from: '00:00',
    to: '06:00',
    text: '夜深了，{name} 早点睡吧，明天再聊 🌙',
    maxPerNight: 3,            // 一个群一晚最多提醒几次
    gapMin: 30                 // 两次提醒至少隔多久
  }
};

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** 逐层补默认值：老 config.json 里没有 moderation 段时也能正常工作 */
function withDefaults(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = isObj(v) && isObj(base?.[k]) ? withDefaults(base[k], v) : v;
  }
  return out;
}

function toNum(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 'HH:MM' → 当天的分钟数；不合法返回 null */
function toMinutes(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 跨天时段判断（22:00–06:00 这种） */
function inWindow(minutes, from, to) {
  if (from == null || to == null) return false;
  if (from === to) return false;
  return from < to ? (minutes >= from && minutes < to) : (minutes >= from || minutes < to);
}

/** 逗号/空格/顿号分隔的列表 */
function splitList(s) {
  return String(s || '')
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 消息里提取可以匹配的纯文本（图片/表情没有文本） */
function plainText(msg) {
  return String(msg?.text || '').trim();
}

class Moderation {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig 取整份配置
   * @param {object} opts.adapter OneBot 适配器（删消息/禁言/查成员）
   * @param {object} opts.store 会话存储
   * @param {(e:object)=>void} opts.broadcast 推 SSE
   * @param {(t:string)=>void} opts.log 写日志
   */
  constructor(opts = {}) {
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
    this.adapter = opts.adapter || null;
    this.store = opts.store || null;
    this.broadcast = typeof opts.broadcast === 'function' ? opts.broadcast : () => {};
    this.log = typeof opts.log === 'function' ? opts.log : (t) => console.log('[群管] ' + t);

    /** chatId:userId → { times:number[], strikes:number, lastStrikeAt:number } */
    this._spam = new Map();
    /** chatId:userId:textHash → { ids:string[], count:number, firstAt:number, noticed:boolean } */
    this._dup = new Map();
    /** chatId → { count:number, lastAt:number, night:number } */
    this._curfew = new Map();
    /** chatId → { ok:boolean, at:number } 机器人是不是本群管理员 */
    this._adminCache = new Map();
    /** chatId:userId → { name:string, at:number } */
    this._nameCache = new Map();

    this._log = [];
    this._counts = {};
    this._handledTotal = 0;
    this._lastAdminDmAt = 0;

    // 清理定时器：内存里的窗口数据不清会一直长
    this._sweepTimer = setInterval(() => this._sweep(), 5 * 60 * 1000);
    this._sweepTimer.unref?.();
  }

  /* ======================== 对外入口 ======================== */

  /**
   * 处理一条别人发的消息。
   * 必须在 ai.handle 之前调用：返回 handled=true 表示「这条已经被群管处理了」，
   * 主流程就不要再去问模型了——跟一个发广告的对聊没有任何意义。
   * @returns {Promise<{handled:boolean, reason?:string, feature?:string}>}
   */
  async observe(msg) {
    try {
      const cfg = this._cfg();
      if (!cfg.enabled) return { handled: false };
      if (!msg || msg.self) return { handled: false };
      if (msg.chatType !== 'group') return { handled: false };   // 只管群，私聊不设限
      if (this._exempt(msg)) return { handled: false };

      const text = plainText(msg);

      // 顺序有讲究：广告最严重先判；重复比刷屏更具体，先判重复免得同一条被罚两次
      const ad = cfg.ad?.enabled ? await this._checkAd(msg, text, cfg) : null;
      if (ad) return ad;

      const banned = cfg.banned?.enabled ? await this._checkBanned(msg, text, cfg) : null;
      if (banned) return banned;

      const dup = cfg.duplicate?.enabled ? await this._checkDuplicate(msg, text, cfg) : null;
      if (dup) return dup;

      const spam = cfg.spam?.enabled ? await this._checkSpam(msg, cfg) : null;
      if (spam) return spam;

      // 宵禁只是提醒，不拦截：拦住了 AI 也不该跟人聊了，那不对
      if (cfg.curfew?.enabled) await this._checkCurfew(msg, cfg);

      return { handled: false };
    } catch (err) {
      // 群管是增强功能，任何异常都不能影响聊天主链路
      console.warn('[群管] 处理失败:', err.message);
      return { handled: false };
    }
  }

  /**
   * 处理群通知（进群/退群/禁言）。
   * 目前只有「新人进群」会真的做事，其余先落日志——踢人/退群这类信息
   * 面板上看得见比看不见好，但没必要为它多发一条消息。
   */
  async onNotice(notice) {
    try {
      const cfg = this._cfg();
      if (!notice) return;
      if (!cfg.enabled) return;
      if (notice.type !== 'group_increase') {
        dbg('[群管] 通知:', notice.type, notice.chatId, notice.userId);
        return;
      }
      if (!cfg.welcome?.enabled) return;
      if (this._exemptChat(notice.chatId)) return;
      if (String(notice.userId) === String(notice.selfId || '')) return;   // 自己进群不欢迎自己

      const name = await this._memberName(notice.chatId, notice.userId, notice.userName);
      const text = this._fill(cfg.welcome.text, { name, group: notice.chatName || notice.chatId });
      const delay = Math.max(0, toNum(cfg.welcome.delaySec, 2)) * 1000;

      const send = async () => {
        await this._say(notice.chatId, text, { at: notice.userId });
        this._note({
          feature: 'welcome',
          chatId: notice.chatId,
          chatName: notice.chatName,
          userName: name,
          userId: notice.userId,
          summary: `欢迎 ${name}（${notice.userId}）进群`
        });
      };

      if (cfg.shadow) {
        this._note({ feature: 'welcome', chatId: notice.chatId, userId: notice.userId, shadow: true, summary: `[演练] 会欢迎 ${name}` });
        return;
      }
      if (delay > 0) {
        const t = setTimeout(() => { send().catch((e) => dbg('[群管] 欢迎发送失败:', e.message)); }, delay);
        t.unref?.();
      } else {
        await send();
      }
    } catch (err) {
      console.warn('[群管] 通知处理失败:', err.message);
    }
  }

  /** 面板用：统计 + 最近记录 */
  status() {
    const cfg = this._cfg();
    return {
      enabled: !!cfg.enabled,
      shadow: !!cfg.shadow,
      autoPunish: !!cfg.autoPunish,
      features: FEATURES.map((k) => ({ key: k, name: FEATURE_NAMES[k], enabled: !!(cfg[k] && cfg[k].enabled) })),
      counts: { ...this._counts },
      handled: this._handledTotal,
      decisions: this.decisions(30)
    };
  }

  decisions(limit = 30) {
    const n = Math.max(1, Math.min(200, toNum(limit, 30)));
    return this._log.slice(-n).reverse();
  }

  /** 关掉时释放定时器（服务退出/测试用） */
  close() {
    try { clearInterval(this._sweepTimer); } catch { /* noop */ }
  }

  /* ======================== 四个「会拦」的检查 ======================== */

  /** 刷屏限流：窗口内条数超限 → 提醒 → 删 → 禁言（逐级升级） */
  async _checkSpam(msg, cfg) {
    const c = cfg.spam || {};
    const key = `${msg.chatId}:${msg.fromId}`;
    const now = Date.now();
    const windowMs = Math.max(1, toNum(c.windowSec, 10)) * 1000;
    const maxMsgs = Math.max(2, toNum(c.maxMsgs, 6));

    let st = this._spam.get(key);
    if (!st) { st = { times: [], strikes: 0, lastStrikeAt: 0 }; this._spam.set(key, st); }
    st.times = st.times.filter((t) => now - t < windowMs);
    st.times.push(now);
    if (st.times.length <= maxMsgs) return null;

    // 惯犯判定：一段时间内不再触发就清零，别让人一天被记一辈子
    const decayMs = Math.max(1, toNum(c.strikesDecayMin, 10)) * 60 * 1000;
    if (st.lastStrikeAt && now - st.lastStrikeAt > decayMs) st.strikes = 0;
    st.strikes += 1;
    st.lastStrikeAt = now;
    st.times = [];                       // 记一次就清窗口，否则后面每条都会触发

    const n = st.strikes;
    const canPunish = await this._canPunish(msg.chatId);
    const name = msg.fromName || msg.fromId;

    if (n === 1) {
      if (!cfg.shadow) await this._say(msg.chatId, `@${name} 慢点发，一条一条说 🙂`, { at: msg.fromId });
      this._note({ feature: 'spam', chatId: msg.chatId, chatName: msg.chatName, userName: name, userId: msg.fromId, summary: `${name} 刷屏（第1次）→ 提醒`, shadow: !!cfg.shadow });
      return { handled: false };            // 第一次只提醒，还让他说话
    }

    let deleted = false;
    if (canPunish && !cfg.shadow) deleted = await this._deleteMsg(msg);

    if (n >= 3 && cfg.autoPunish && canPunish && !cfg.shadow) {
      const muteMin = Math.max(1, toNum(c.muteMin, 5));
      const muted = await this._mute(msg.chatId, msg.fromId, muteMin * 60);
      this._note({ feature: 'spam', chatId: msg.chatId, chatName: msg.chatName, userName: name, userId: msg.fromId, summary: `${name} 连续刷屏 → 禁言 ${muteMin} 分钟`, deleted, muted });
      if (muted) await this._say(msg.chatId, `@${name} 刷屏了，先安静 ${muteMin} 分钟`, { at: msg.fromId }).catch(() => {});
      return { handled: true, reason: 'spam', feature: 'spam' };
    }

    this._note({ feature: 'spam', chatId: msg.chatId, chatName: msg.chatName, userName: name, userId: msg.fromId, summary: `${name} 继续刷屏（第${n}次）→ ${deleted ? '已删' : '未删（无管理员权限）'}`, deleted });
    return { handled: true, reason: 'spam', feature: 'spam' };
  }

  /** 广告/拉人：命中特征 → 删消息 + 提醒 */
  async _checkAd(msg, text, cfg) {
    if (!text) return null;
    const c = cfg.ad || {};
    let hit = AD_PATTERNS.some((re) => re.test(text));
    if (!hit && c.blockLinks && /(https?:\/\/|www\.)/i.test(text)) hit = true;
    if (!hit) return null;

    const name = msg.fromName || msg.fromId;
    const canPunish = await this._canPunish(msg.chatId);
    let deleted = false;
    if (c.deleteMsg && canPunish && !cfg.shadow) deleted = await this._deleteMsg(msg);

    if (!cfg.shadow) {
      const tip = deleted
        ? `@${name} 广告/拉人的消息已删除，本群不允许发这类内容`
        : `@${name} 本群不允许发广告或拉人，请自觉`;
      await this._say(msg.chatId, tip, { at: msg.fromId }).catch(() => {});
    }
    this._note({
      feature: 'ad',
      chatId: msg.chatId,
      chatName: msg.chatName,
      userName: name,
      userId: msg.fromId,
      summary: `${name}：${text.slice(0, 40)}`,
      deleted,
      shadow: !!cfg.shadow
    });
    return { handled: true, reason: 'ad', feature: 'ad' };
  }

  /** 违禁词：只预警，默认不删 */
  async _checkBanned(msg, text, cfg) {
    if (!text) return null;
    const c = cfg.banned || {};
    const words = splitList(c.words).filter(Boolean);
    if (!words.length) return null;
    const lower = text.toLowerCase();
    const hit = words.find((w) => lower.includes(w.toLowerCase()));
    if (!hit) return null;

    const name = msg.fromName || msg.fromId;
    let deleted = false;
    if (c.deleteMsg && !cfg.shadow) {
      const canPunish = await this._canPunish(msg.chatId);
      if (canPunish) deleted = await this._deleteMsg(msg);
    }

    if (!cfg.shadow) {
      // 不把命中的词原样念出来：念一遍等于又发了一遍
      await this._say(msg.chatId, `@${name} 这句话里有不适合本群的内容，请注意`, { at: msg.fromId }).catch(() => {});
      if (c.notifyAdmin) await this._notifyAdmin(msg, hit, text);
    }
    this._note({
      feature: 'banned',
      chatId: msg.chatId,
      chatName: msg.chatName,
      userName: name,
      userId: msg.fromId,
      summary: `${name} 命中「${hit}」`,
      deleted,
      shadow: !!cfg.shadow
    });
    return { handled: true, reason: 'banned', feature: 'banned' };
  }

  /** 重复消息合并：同一个人短时间发同样的内容 → 删重复 + 只提示一次 + 不再让 AI 回 */
  async _checkDuplicate(msg, text, cfg) {
    const c = cfg.duplicate || {};
    if (!text) return null;
    const minChars = Math.max(2, toNum(c.minChars, 6));
    const norm = text.replace(/\s+/g, '').toLowerCase();
    if (norm.length < minChars) return null;

    const times = Math.max(2, toNum(c.times, 3));
    const windowMs = Math.max(1, toNum(c.windowSec, 60)) * 1000;
    const now = Date.now();
    const key = `${msg.chatId}:${msg.fromId}:${norm.slice(0, 80)}`;

    let st = this._dup.get(key);
    if (!st || now - st.firstAt > windowMs) {
      st = { ids: [], count: 0, firstAt: now, noticed: false };
      this._dup.set(key, st);
    }
    st.count += 1;
    if (msg.id) st.ids.push(msg.id);
    if (st.count < times) return null;

    const name = msg.fromName || msg.fromId;
    let deleted = 0;
    if (c.deleteMsg && !cfg.shadow) {
      const canPunish = await this._canPunish(msg.chatId);
      if (canPunish) {
        // 留第一条，删后面的重复——全删了会让人以为消息没发出去
        for (const id of st.ids.slice(1)) {
          if (await this._deleteMsgId(id)) deleted += 1;
        }
        st.ids = st.ids.slice(0, 1);
      }
    }

    if (!st.noticed) {
      st.noticed = true;
      if (c.notice && !cfg.shadow) {
        const tip = deleted > 0
          ? `@${name} 同样的消息发了 ${st.count} 遍，重复的已经删掉了`
          : `@${name} 同样的消息发了 ${st.count} 遍，说一次就够啦`;
        await this._say(msg.chatId, tip, { at: msg.fromId }).catch(() => {});
      }
      this._note({
        feature: 'duplicate',
        chatId: msg.chatId,
        chatName: msg.chatName,
        userName: name,
        userId: msg.fromId,
        summary: `${name} 重复 ${st.count} 遍：${text.slice(0, 30)}`,
        deleted,
        shadow: !!cfg.shadow
      });
    }
    // 之后的重复一律吞掉：不让 AI 一条条回，也不再刷屏
    return { handled: true, reason: 'duplicate', feature: 'duplicate' };
  }

  /** 深夜宵禁：只提醒，不拦截 */
  async _checkCurfew(msg, cfg) {
    const c = cfg.curfew || {};
    const from = toMinutes(c.from);
    const to = toMinutes(c.to);
    const now = new Date();
    if (!inWindow(now.getHours() * 60 + now.getMinutes(), from, to)) return;

    const key = msg.chatId;
    const nowMs = Date.now();
    let st = this._curfew.get(key);
    // 跨天窗口：用一个「今晚」的标记，换天后重新计数
    const nightTag = now.getHours() < 12 ? -1 : 0;   // 凌晨算前一天晚上
    if (!st || st.nightTag !== nightTag || nowMs - st.lastAt > 12 * 3600 * 1000) {
      st = { count: 0, lastAt: 0, nightTag };
      this._curfew.set(key, st);
    }
    const max = Math.max(1, toNum(c.maxPerNight, 3));
    if (st.count >= max) return;
    const gapMs = Math.max(0, toNum(c.gapMin, 30)) * 60 * 1000;
    if (st.lastAt && nowMs - st.lastAt < gapMs) return;

    st.count += 1;
    st.lastAt = nowMs;
    const name = msg.fromName || msg.fromId;
    if (!cfg.shadow) {
      const text = this._fill(c.text, { name, group: msg.chatName || msg.chatId });
      await this._say(msg.chatId, text, { at: msg.fromId }).catch(() => {});
    }
    this._note({ feature: 'curfew', chatId: msg.chatId, chatName: msg.chatName, userName: name, userId: msg.fromId, summary: `提醒 ${name} 早点睡`, shadow: !!cfg.shadow });
  }

  /* ======================== 动作 ======================== */

  async _say(chatId, text, opts = {}) {
    if (!text) return false;
    if (!this.adapter || typeof this.adapter.sendText !== 'function') return false;
    try {
      await this.adapter.sendText({ type: 'group', targetId: String(chatId) }, text, opts);
      return true;
    } catch (err) {
      dbg('[群管] 发送失败:', err.message);
      return false;
    }
  }

  async _deleteMsg(msg) {
    return this._deleteMsgId(msg?.id);
  }

  async _deleteMsgId(id) {
    if (!id || !/^-?\d+$/.test(String(id))) return false;
    if (!this.adapter || typeof this.adapter.callAction !== 'function') return false;
    try {
      await this.adapter.callAction('delete_msg', { message_id: Number(id) });
      return true;
    } catch (err) {
      dbg('[群管] 删消息失败:', err.message);
      return false;
    }
  }

  async _mute(chatId, userId, seconds) {
    if (!this.adapter || typeof this.adapter.callAction !== 'function') return false;
    try {
      await this.adapter.callAction('set_group_ban', {
        group_id: Number(chatId),
        user_id: Number(userId),
        duration: Math.max(60, Math.round(seconds))
      });
      return true;
    } catch (err) {
      dbg('[群管] 禁言失败:', err.message);
      return false;
    }
  }

  /** 机器人是不是本群管理员/群主。查不到一律当「不是」——宁可少动手 */
  async _canPunish(chatId) {
    const hit = this._adminCache.get(String(chatId));
    const now = Date.now();
    if (hit && now - hit.at < 5 * 60 * 1000) return hit.ok;
    const selfId = this.adapter?.self?.userId;
    if (!selfId) { this._adminCache.set(String(chatId), { ok: false, at: now }); return false; }
    try {
      const info = await this.adapter.callAction('get_group_member_info', {
        group_id: Number(chatId),
        user_id: Number(selfId),
        no_cache: false
      });
      const role = String(info?.role || info?.data?.role || '');
      const ok = role === 'admin' || role === 'owner';
      this._adminCache.set(String(chatId), { ok, at: now });
      return ok;
    } catch (err) {
      dbg('[群管] 查管理员身份失败:', err.message);
      this._adminCache.set(String(chatId), { ok: false, at: now });
      return false;
    }
  }

  async _memberName(chatId, userId, fallback = '') {
    const key = `${chatId}:${userId}`;
    const now = Date.now();
    const hit = this._nameCache.get(key);
    if (hit && now - hit.at < 10 * 60 * 1000) return hit.name;
    let name = String(fallback || '');
    if (!name) {
      try {
        const info = await this.adapter.callAction('get_group_member_info', {
          group_id: Number(chatId),
          user_id: Number(userId)
        });
        name = String(info?.card || info?.nickname || info?.data?.card || info?.data?.nickname || '');
      } catch { /* 查不到就用 QQ 号 */ }
    }
    if (!name) name = String(userId);
    this._nameCache.set(key, { name, at: now });
    return name;
  }

  /** 违禁词私聊主人。5 分钟最多一条，别把主人自己刷屏了 */
  async _notifyAdmin(msg, word, text) {
    const now = Date.now();
    if (now - this._lastAdminDmAt < 5 * 60 * 1000) return;
    const owners = splitList(this._root().ai?.commandSenders).filter((s) => /^\d{5,}$/.test(s));
    if (!owners.length) return;
    this._lastAdminDmAt = now;
    const body = `【违禁词预警】\n群：${msg.chatName || msg.chatId}\n成员：${msg.fromName || msg.fromId}（${msg.fromId}）\n命中：${word}\n内容：${String(text).slice(0, 120)}`;
    for (const uid of owners) {
      try {
        await this.adapter.sendText({ type: 'private', targetId: uid }, body);
        return;
      } catch (err) {
        dbg('[群管] 私聊主人失败:', err.message);
      }
    }
  }

  /* ======================== 内部工具 ======================== */

  /** 整份配置（moderation 段之外的字段要从这里取，比如 ai.commandSenders） */
  _root() {
    try { return this.getConfig() || {}; } catch { return {}; }
  }

  /** 合并过默认值的 moderation 段 */
  _cfg() {
    return withDefaults(DEFAULT_MODERATION, this._root().moderation || {});
  }

  /** 豁免判断：主人、白名单用户、白名单群 */
  _exempt(msg) {
    if (this._exemptChat(msg.chatId)) return true;
    const cfg = this._cfg();
    const users = new Set([
      ...splitList(cfg.whitelistUsers),
      // 主人永远豁免：bot 不能把自己的主人当成违规用户处理
      ...splitList(this._root().ai?.commandSenders)
    ]);
    return users.has(String(msg.fromId));
  }

  _exemptChat(chatId) {
    const cfg = this._cfg();
    return splitList(cfg.whitelistChats).includes(String(chatId));
  }

  _fill(tpl, vars) {
    return String(tpl || '').replace(/\{(name|group)\}/g, (_, k) => String(vars[k] ?? ''));
  }

  _note(entry) {
    // userName/chatName 面板要显示「谁、哪个群」；调用点没传就留空，UI 兜底显示 id
    const rec = { userName: '', chatName: '', at: Date.now(), ...entry };
    this._log.push(rec);
    if (this._log.length > 200) this._log.shift();
    if (!rec.shadow) {
      this._handledTotal += 1;
      this._counts[rec.feature] = (this._counts[rec.feature] || 0) + 1;
    }
    try { this.broadcast({ type: 'moderation', decision: rec }); } catch { /* noop */ }
    try {
      this.log(`${FEATURE_NAMES[rec.feature] || rec.feature}｜${rec.shadow ? '[演练] ' : ''}${rec.summary || ''}`);
    } catch { /* noop */ }
    return rec;
  }

  /** 清掉过期的窗口数据，防止长跑内存涨 */
  _sweep() {
    const now = Date.now();
    for (const [k, st] of this._spam) {
      if (!st.lastStrikeAt && (!st.times.length || now - st.times[st.times.length - 1] > 60 * 60 * 1000)) this._spam.delete(k);
    }
    for (const [k, st] of this._dup) {
      if (now - st.firstAt > 10 * 60 * 1000) this._dup.delete(k);
    }
    for (const [k, st] of this._curfew) {
      if (now - st.lastAt > 24 * 3600 * 1000) this._curfew.delete(k);
    }
    for (const [k, v] of this._adminCache) {
      if (now - v.at > 30 * 60 * 1000) this._adminCache.delete(k);
    }
    for (const [k, v] of this._nameCache) {
      if (now - v.at > 60 * 60 * 1000) this._nameCache.delete(k);
    }
  }
}

module.exports = { Moderation, DEFAULT_MODERATION, FEATURES, FEATURE_NAMES, AD_PATTERNS, DEFAULT_BANNED, withDefaults };
