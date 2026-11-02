'use strict';
/**
 * 打包前隐私闸门：dist/ 是安装包的唯一来源，一旦混入真实隐私就会随安装包散播。
 * 任何一项命中即 exit 1，中止打包。
 * 用法：node precheck-package.js
 */
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, 'dist');
const problems = [];

/* 占位符不算隐私（README 里的示例值） */
const PLACEHOLDER = /^(你的|这里|填写|xxx+|XXX+|<.*>|\.\.\.|CHANGEME|changeme|todo|TODO|null|undefined|示例|example|token|\w*令牌\w*|此处.*|请填.*)$/i;

/** 检查单个 JSON 配置文件（真正会泄漏的地方） */
function checkJsonConfig(rel) {
  const p = path.join(DIST, rel);
  if (!fs.existsSync(p)) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    problems.push(`${rel} :: 不是合法 JSON（${e.message}）`); return;
  }
  const fail = (field, why) => problems.push(`${rel} -> ${field}  ::  ${why}`);

  const tok = cfg?.qq?.onebot?.accessToken;
  if (typeof tok === 'string' && tok.trim() && !PLACEHOLDER.test(tok.trim())) fail('qq.onebot.accessToken', `明文令牌 ${JSON.stringify(tok).slice(0, 24)}…`);

  const key = cfg?.ai?.apiKey;
  if (typeof key === 'string' && key.trim() && !PLACEHOLDER.test(key.trim())) fail('ai.apiKey', `明文 Key ${JSON.stringify(key).slice(0, 24)}…`);

  const cs = cfg?.ai?.commandSenders;
  if (typeof cs === 'string' && cs.trim() && !PLACEHOLDER.test(cs.trim())) fail('ai.commandSenders', `含真实 QQ 号 ${JSON.stringify(cs).slice(0, 24)}…`);

  const tk = cfg?.ai?.targetChatKey;
  if (typeof tk === 'string' && tk.trim()) fail('ai.targetChatKey', `含真实会话目标 ${JSON.stringify(tk).slice(0, 24)}…`);

  // 多选目标同样会暴露私聊 QQ / 群号；旧检查只看了单选字段 targetChatKey
  const tks = cfg?.ai?.targetChatKeys;
  if (Array.isArray(tks) && tks.length) {
    fail('ai.targetChatKeys', `含 ${tks.length} 个真实会话目标 ${JSON.stringify(tks).slice(0, 32)}…`);
  } else if (typeof tks === 'string' && tks.trim()) {
    fail('ai.targetChatKeys', `不是数组且非空 ${JSON.stringify(tks).slice(0, 24)}…`);
  }

  // wsUrl 里附带的 access_token 也会随配置泄漏
  const ws = cfg?.qq?.onebot?.wsUrl;
  if (typeof ws === 'string') {
    const m = ws.match(/[?&](?:access_token|token)=([^&]+)/i);
    if (m) {
      let v = m[1];
      try { v = decodeURIComponent(v); } catch { /* 原样判断 */ }
      if (v && !PLACEHOLDER.test(v)) fail('qq.onebot.wsUrl', `URL 查询参数含明文令牌 ${JSON.stringify(v).slice(0, 24)}…`);
    }
  }

  /* 任意字段里出现 11 位 QQ/手机号，或 group:数字，或私人域名 */
  const raw = fs.readFileSync(p, 'utf8');
  const m11 = raw.match(/\b1[3-9]\d{9}\b/);
  if (m11) fail('(全文)', `疑似真实 QQ/手机号 ${m11[0]}`);
  // 很多 QQ（包括机器人号）是 10 位，旧的 11 位规则会漏掉；配置 JSON 里
  // 除了端口/轮次等短数字，不应出现完整的 10 位账号。
  const m10 = raw.match(/\b[1-9]\d{9}\b/);
  if (m10) fail('(全文)', `疑似 10 位 QQ ${m10[0]}`);
  const mg = raw.match(/\bgroup:\d{6,}\b/);
  if (mg) fail('(全文)', `疑似真实群号 ${mg[0]}`);
  const md = raw.match(/\b[a-z0-9][a-z0-9-]{2,}\.(top|xyz|cc|vip|cn)\b/);
  if (md && !/^(example|test)\./.test(md[1])) fail('(全文)', `疑似私人服务器域名 ${md[0]}`);
}

/** 禁止出现的浏览器配置目录（会导致别人装完自动登录你的账号） */
const PROFILE_DIR_NAMES = ['deepseek_profile', '.edge-audit', '.edge-dbg', '.edge-prev',
  '.edge-profile', '.edge-redact', '.edge-shots', '.edge-profile-tut', '.edge-profile-promo',
  '.edge-prev2', '.edge-site', '.edge-site2', 'edge-prev2'];

/** dist/ 下的文档与代码：只扫「像真实凭据」的串 */
function checkText(dir = DIST, depth = 0) {
  if (depth > 8) return;
  // 内置的第三方QQ 桥接是别人的二进制/压缩代码，里面全是随机串和版本号，
  // 扫它只会产生噪音；它自己的 config/data 已在打包时排除，另行由 checkEngine 检查。
  if (path.resolve(dir).toLowerCase().startsWith(path.join(DIST, 'engine').toLowerCase())) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { checkText(p, depth + 1); continue; }
    if (/\.(exe|dll|pdb|node|mp4|wav|png|jpg|jpeg|gif|zip|ico|woff2?|md)$/i.test(e.name)) continue;
    let t;
    try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const rel = path.relative(DIST, p);
    // 长随机串（典型令牌形态：>=32 位字母数字混排）
    const mTok = t.match(/\b[A-Za-z0-9_-]{32,}\b/g);
    for (const c of (mTok || [])) {
      if (!(/\d/.test(c) && /[a-z]/i.test(c) && !/^[0-9]+$/.test(c))) continue;
      // 爱发电主页链接里的 32 位用户 ID 是公开地址，不是凭据
      const idx = t.indexOf(c);
      const near = t.slice(Math.max(0, idx - 40), idx + c.length + 4);
      if (/(?:ifdian\.net|afdian\.com)\/u\//i.test(near)) continue;
      problems.push(`${rel}  ::  疑似凭据串 ${c.slice(0, 20)}…`);
    }
    const m11 = t.match(/\b1[3-9]\d{9}\b/g);
    for (const c of new Set(m11 || [])) {
      // 允许出现在「联系邮箱」里（邮箱地址见 README）
      const idx = t.indexOf(c);
      const near = t.slice(Math.max(0, idx - 12), idx + 20);
      if (!/@qq\.com/.test(near)) problems.push(`${rel}  ::  疑似真实 QQ 号 ${c}`);
    }
  }
}

/** 浏览器登录态类文件绝不能出现在 dist/ */
const PROFILE_ARTS = ['Login Data', 'Cookies', 'Local State', 'Web Data', 'History', 'Preferences'];
/** 登录态所在的目录名（任意层级出现即拦截） */
const PROFILE_DIRS = ['deepseek_profile', 'User Data', 'Default'];
function checkProfileFiles(dir = DIST, depth = 0, trail = '') {
  if (depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (PROFILE_DIRS.includes(e.name) || PROFILE_DIR_NAMES.includes(e.name)) {
        problems.push(`${path.relative(DIST, p)}  ::  浏览器配置/登录态目录「${e.name}」—— 会让人自动登录你的账号`);
      }
      checkProfileFiles(p, depth + 1, trail + '/' + e.name);
      continue;
    }
    if (PROFILE_ARTS.includes(e.name)) {
      problems.push(`${path.relative(DIST, p)}  ::  浏览器登录态文件「${e.name}」（含 Cookies / 登录令牌）`);
    }
  }
}

/* data/ 必须为空（登录态由用户自己扫出来，不随包分发） */
const dataDir = path.join(DIST, 'data');
if (fs.existsSync(dataDir)) {
  const n = [];
  (function cnt(d, k = 0) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) cnt(path.join(d, e.name), k + 1); else n.push(path.join(d, e.name));
    }
  })(dataDir);
  if (n.length) problems.push(`dist/data/ 含 ${n.length} 个文件（应为空）：${n.slice(0, 3).map(f => path.relative(DIST, f)).join(', ')}…`);
}

/* 内置QQ 桥接（dist/engine）里绝不能带打包机的运行数据。
 * 这些文件是 NapCat 跑起来后自己生成的：webui.json 有 WebUI token，
 * onebot*.json 有 accessToken 和已填的 QQ 号，cache/qrcode.png 是登录二维码
 * （扫一下就能登进别人的号），logs/ 有聊天记录。
 * 注意它们在 napcat/napcat/config/ 这种**嵌套**位置，只查顶层会漏（v1.4.9 踩过）。 */
const ENGINE_SKIP_DIRS = new Set(['data', 'logs', 'cache', 'plugins', 'session', 'temp']);
const ENGINE_SECRET_FILES = [
  { re: /^webui\.json$/i, why: 'WebUI 令牌 / 密码哈希' },
  { re: /^onebot.*\.json$/i, why: 'OneBot 配置（含 accessToken、真实 QQ 号）' },
  { re: /^consent\.json$/i, why: 'EULA 同意记录' },
  { re: /^qrcode.*\.(png|jpe?g|webp)$/i, why: '登录二维码（可扫入他人账号）' },
  { re: /\.log$/i, why: '运行日志' },
];
function checkEngine(dir = path.join(DIST, 'engine'), depth = 0) {
  if (depth > 10) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    const rel = path.relative(DIST, p);
    if (e.isDirectory()) {
      if (ENGINE_SKIP_DIRS.has(e.name.toLowerCase())) {
        const files = [];
        (function walk(d, k = 0) {
          if (k > 6) return;
          for (const x of fs.readdirSync(d, { withFileTypes: true })) {
            if (x.isDirectory()) walk(path.join(d, x.name), k + 1); else files.push(path.join(d, x.name));
          }
        })(p);
        problems.push(`${rel}  ::  内置QQ 桥接的运行目录「${e.name}」不该进包${files.length ? `（含 ${files.length} 个文件）` : ''}`);
      }
      checkEngine(p, depth + 1);
      continue;
    }
    for (const s of ENGINE_SECRET_FILES) {
      if (s.re.test(e.name)) { problems.push(`${rel}  ::  内置QQ 桥接带了${s.why}`); break; }
    }
  }
}
checkEngine();

/* 内容级扫描：上面所有规则都按「文件名」拦。万一 store.json 被改名（比如塞进 assets/x.json），
 * 文件名规则全部失效。这里按**内容结构**兜底：会话存储的 messages 表、以及对话轮次的
 * role/content 成对出现——正常代码里不会有这种 JSON 密度。
 * 2026-11-02 加：用户要求确认安装包不含聊天记录，逐项验证后把这道防线前置到构建时。 */
const CHAT_CONTENT_SIGNS = [
  { re: /"messages"\s*:\s*\{/, why: '会话存储结构（messages 表）' },
  { re: /"role"\s*:\s*"user"[\s\S]{0,200}"content"/, why: '对话轮次数据（role/content）' },
  { re: /"chatKey"\s*:\s*"(group|private):/, why: '会话键（含群号/openid）' }
];
function checkChatLeak(dir = DIST, depth = 0) {
  if (depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { checkChatLeak(p, depth + 1); continue; }
    // 只扫文本类，二进制跳过（exe/dll/png 里的字节偶然匹配会误报）
    if (!/\.(json|js|txt|md|html|log|csv)$/i.test(e.name)) continue;
    let txt;
    try {
      const st = fs.statSync(p);
      if (st.size > 8 * 1024 * 1024) continue;
      txt = fs.readFileSync(p, 'utf8');
    } catch { continue; }
    for (const s of CHAT_CONTENT_SIGNS) {
      if (s.re.test(txt)) {
        problems.push(`${path.relative(DIST, p)} :: 疑似聊天数据 —— ${s.why}`);
        break;
      }
    }
  }
}
checkChatLeak();

/* ---------------- 执行全部检查 ---------------- */
if (!fs.existsSync(DIST)) { console.error('✗ 没有 dist/ 目录'); process.exit(1); }

checkJsonConfig('config.json');
checkProfileFiles();   // 登录态文件 / 配置目录（任意层级）
checkText();           // 疑似凭据串 / 裸 QQ 号

if (problems.length) {
  console.error('\n✗ 打包闸门未通过 —— dist/ 混入真实隐私，已中止：');
  problems.forEach((p) => console.error('  · ' + p));
  console.error('\n修复：dist/config.json 换成干净默认值 + 清空 dist/data/');
  process.exit(1);
}
console.log('✓ 打包闸门通过：dist/ 无真实隐私，可安全打包');