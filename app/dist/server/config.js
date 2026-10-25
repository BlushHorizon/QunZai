'use strict';
/**
 * 配置读写：首次运行生成 config.json，之后以文件为准。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readFileText } = require('./atomic');
const { resolveRoot } = require('./platform');

// 应用根目录：默认是 server/ 的父目录。
// 安卓上整套资源会被复制到应用私有目录再运行，这时用 QUNZAI_ROOT 指过去。
const ROOT = resolveRoot(path.resolve(__dirname, '..'));
const CONFIG_PATH = path.join(ROOT, 'config.json');
const OFFICIAL_UPDATE_MANIFEST = 'https://blushhorizon.github.io/QunZai/update.json';

const DEFAULT_CONFIG = {
  server: {
    host: '127.0.0.1',
    port: 8787
  },
  qq: {
    // mock  = 本地模拟（无需安装任何东西，打开网页即可体验完整链路）
    // onebot = 连接 NapCatQQ 的 OneBot 11 正向 WebSocket（真实 QQ）
    mode: 'mock',
    onebot: {
      wsUrl: 'ws://127.0.0.1:3001',
      accessToken: ''
    },
    // 群崽 QQ 内核：只做本机运行时的发现/启动/配置同步，不打包第三方运行时
    engine: {
      enabled: true,
      autoStart: true,
      // source: bundled = 只用随包内置的那份；custom = 只用用户填的目录；auto = 内置优先，再找本机其他
      source: 'auto',
      dir: '',
      account: '',
      apiPort: 3000
    }
  },
  ai: {
    enabled: false,
    // deepseek-web      = 驱动 chat.deepseek.com 网页版（对应 EAgent 的做法，无需 API Key）
    // openai-compatible = 走 OpenAI 兼容 API（需要 Key）
    // builtin           = 内置规则引擎（离线演示用）
    provider: 'deepseek-web',
    // 网页版 DeepSeek 相关
    cdpPort: 9222,
    browserPath: '',
    // 提示词（人设/规则）由用户在网页端填写；留空=不发提示词，只转发消息
    // 每次"新建对话"时自动发送一次；对话轮数达到 webMaxRounds 后自动新建对话并重发
    webPrompt: '',
    webMaxRounds: 50,
    // OpenAI 兼容接口
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    systemPrompt:
      '你是「网页版 QQ 助手」，正在通过 QQ 与好友聊天。要求：中文回复、简洁自然、不要用 Markdown 语法、不要自称 AI 模型、长度控制在 100 字以内。',
    scope: 'all',                // private = 只私聊自动回复；all = 私聊 + 群聊
    // 回复范围：all = 所有会话都自动回复；target = 只回复指定会话（可多选，其他会话一律不回）
    replyMode: 'all',
    targetChatKey: '',           // 旧版单选字段（兼容保留，读取时并入 targetChatKeys）
    targetChatKeys: [],          // replyMode='target' 时生效：选中的会话全部回复（多选）；空 = 全部回复
    requireMentionInGroup: false, // 群聊中需 @机器人 或 @全体成员 才回复（false=群里任何消息都回）
    groupReplyChance: 100,        // 群里"非 @"消息的主动回复概率 0-100（@机器人的消息不受限、必回）
    groupKeywords: '',            // 群聊关键词过滤：逗号分隔；非空时群聊非@消息须命中任一关键词（@/带图消息除外）；留空=不限
    quietEnabled: false,          // 免打扰时段：期间不自动回复（主人的远程指令不受限）
    quietFrom: '23:00',           // 免打扰开始 HH:MM
    quietTo: '08:00',             // 免打扰结束 HH:MM（支持跨天）
    commandSenders: '',           // 可发 /指令 的主人QQ号（逗号分隔；留空=禁用远程指令）
    imageReply: true,             // 看图回复：收到图片时让 DeepSeek 看图后回复
    groupAtSender: true,          // 群聊回复时自动 @ 触发消息的成员
    groupQuote: true,             // 群聊回复时自动引用原消息
    minIntervalMs: 2500,         // 同一会话两次回复的最小间隔；0 = 不冷却
    historyTurns: 8,             // 送给模型的上下文轮数
    replyDelayMs: 900            // 模拟“正在输入”的思考时间
  },
  // 自动更新：只检查，下载/安装必须用户确认
  update: {
    manifestUrl: OFFICIAL_UPDATE_MANIFEST,
    autoCheck: true
  }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * 旧版升级会保留原 config.json；旧文件里的 update.manifestUrl 往往是空字符串。
 * 空值无法自动更新，这里回填官方清单地址。用户仍可在设置里改成自己的地址。
 */
function normalizeConfig(cfg) {
  if (!isPlainObject(cfg.update)) cfg.update = {};
  if (!String(cfg.update.manifestUrl || '').trim()) cfg.update.manifestUrl = OFFICIAL_UPDATE_MANIFEST;
  return cfg;
}

let current = normalizeConfig(deepMerge(DEFAULT_CONFIG, {}));

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      // 兼容带 BOM 的文件（PowerShell 的 UTF8 编码会写入 BOM）
      const rawText = readFileText(CONFIG_PATH);
      current = normalizeConfig(deepMerge(DEFAULT_CONFIG, JSON.parse(rawText)));
    } else {
      // 主文件不在，但临时文件在 = 上次死在 rename 之前，内容其实是新的
      const tmp = CONFIG_PATH + '.tmp';
      if (fs.existsSync(tmp)) {
        current = normalizeConfig(deepMerge(DEFAULT_CONFIG, JSON.parse(readFileText(tmp))));
        try { fs.renameSync(tmp, CONFIG_PATH); } catch { /* noop */ }
        console.log('[config] 主文件缺失，已从临时文件恢复设置');
      } else {
        save();
      }
    }
  } catch (err) {
    console.warn('[config] 读取失败，使用默认配置:', err.message);
    // 主文件坏了 → 看看临时文件能不能救回来，尽量别让用户重填全部设置
    try {
      const tmp = CONFIG_PATH + '.tmp';
      if (fs.existsSync(tmp)) {
        current = normalizeConfig(deepMerge(DEFAULT_CONFIG, JSON.parse(readFileText(tmp))));
        console.warn('[config] 已从临时文件恢复设置');
        return current;
      }
    } catch { /* 临时文件也救不了 */ }
    current = normalizeConfig(deepMerge(DEFAULT_CONFIG, {}));
  }
  return current;
}

function save(patch) {
  if (patch) current = deepMerge(current, patch);
  try {
    // 写回时同样不带 BOM；原子写避免被强杀时写坏配置
    writeFileAtomic(CONFIG_PATH, JSON.stringify(current, null, 2));
    console.log('[配置] 设置已保存');
  } catch (err) {
    console.warn('[config] 写入失败:', err.message);
  }
  return current;
}

module.exports = { load, save, get: () => current, DEFAULT_CONFIG, ROOT, CONFIG_PATH };