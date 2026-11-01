'use strict';
/**
 * 打包前的唯一准备入口。
 *
 * 以前 dist/ 是手工拷的，一天里因此踩了两次坑（改了源码忘了同步 → 用户装到旧代码；
 * 手滑把带真实凭证的 config.json 拷进 dist → 隐私跟着安装包发出去）。
 * 现在所有「进 dist 的东西」只经过这里：
 *
 *   node build-package.js             只同步 + 过闸门
 *   node build-package.js --installer 同步 + 过闸门 + makensis 出安装包
 *
 * 关键约束：
 *   · dist/config.json 永远由 server/config.js 里的 DEFAULT_CONFIG 现生成，
 *     绝不从任何「正在使用的」config.json 拷——那种文件里一定有 accessToken。
 *   · 同步是「先清空再拷」，避免上一次的残留文件继续躺在包里（setup.nsi 就这么漏进去过）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const pkg = require('./package.json');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const VERSION = pkg.version;
const RELEASES = path.resolve(ROOT, '..', 'releases');

/* 目录级同步 */
const DIRS = ['server', 'public', 'assets'];
/* 单文件同步（从源根目录） */
const FILES = ['launcher.ps1'];
/* 旧版独立的开启/关闭入口已合并进桌面宿主；这些文件不再进安装包 */
const LEGACY_ENTRY_FILES = ['开启.bat', '关闭.bat'];

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
/** 开发期文件不进安装包：验收脚本（smoke-*.js）、临时诊断脚本（_diag/_d*.js）。
 *  它们会跑真实模块、打印内部状态，进了用户机器毫无用处，还等于把内部实现摊开给人看。 */
const DEV_FILE_RE = /^(smoke-.*\.js|_diag.*\.js|_d\d+\.js)$/i;
function isDevFile(name) { return DEV_FILE_RE.test(name); }
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isFile() && filter && !filter(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}
/** 同 copyDir，但跳过**任意层级**的运行数据。
 *  必须逐层递归排除：NapCat 的运行数据在 napcat/napcat/config/ 这种嵌套位置，
 *  只排除顶层会把别人的 WebUI token 和二维码带进安装包（v1.4.9 踩过）。
 *  config 目录不能整个删——里面有官方默认的 napcat.json；所以按文件名精确排除运行产物。 */
const ENGINE_SKIP_DIRS = new Set(['data', 'logs', 'cache', 'plugins', 'session', 'temp']);
const ENGINE_SKIP_FILES = [
  /^webui\.json$/i,          // NapCat WebUI token / 密码哈希
  /^onebot.*\.json$/i,       // NapCat / SnowLuma 的 OneBot 配置（含 accessToken、真实 QQ 号）
  /^consent\.json$/i,        // SnowLuma 的 EULA 同意记录
  /^qrcode.*\.(png|jpe?g|webp)$/i, // 扫码登录二维码 = 能直接登进别人的号
  /\.log$/i,
];
function copyEngineDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory() && ENGINE_SKIP_DIRS.has(e.name.toLowerCase())) continue;
    if (e.isFile() && ENGINE_SKIP_FILES.some((re) => re.test(e.name))) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyEngineDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log('=== 1. 同步源码 → dist/ ===');
fs.mkdirSync(DIST, { recursive: true });
let n = 0;
for (const f of LEGACY_ENTRY_FILES) {
  const p = path.join(DIST, f);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { force: true });
    console.log('  已移除旧入口 dist/' + f);
  }
}
for (const dir of DIRS) {
  const src = path.join(ROOT, dir);
  if (!fs.existsSync(src)) { console.log('  跳过(不存在) ' + dir); continue; }
  rmrf(path.join(DIST, dir));            // 先清空：残留文件会一直躺在包里
  copyDir(src, path.join(DIST, dir), dir === 'server' ? (name) => !isDevFile(name) : null);
  const cnt = (function c(d) { let k = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) k += e.isDirectory() ? c(path.join(d, e.name)) : 1; return k; })(path.join(DIST, dir));
  n += cnt;
  console.log(`  ${dir}/  (${cnt} 个文件)`);
}
/* 桌面宿主：先编译，避免把旧 exe 打进安装包 */
const desktopDir = path.join(ROOT, 'desktop');
const desktopBin = path.join(desktopDir, 'bin');
if (fs.existsSync(path.join(desktopDir, 'build.ps1'))) {
  console.log('  编译桌面宿主 QunZaiHost.exe');
  const b = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(desktopDir, 'build.ps1'), '-Force'],
    { cwd: ROOT, encoding: 'utf8' });
  if (b.status !== 0) {
    console.error((b.stdout || '') + (b.stderr || ''));
    console.error('✗ 桌面宿主编译失败，拒绝打包');
    process.exit(1);
  }
}
if (fs.existsSync(desktopBin)) {
  rmrf(path.join(DIST, 'desktop'));
  copyDir(desktopBin, path.join(DIST, 'desktop'));
  for (const junk of ['desktop-host.log', 'QunZaiHost.pdb']) {
    rmrf(path.join(DIST, 'desktop', junk));
  }
  const cnt = fs.readdirSync(path.join(DIST, 'desktop')).length;
  n += cnt;
  console.log(`  desktop/  (${cnt} 个文件，含 WebView2 宿主)`);
} else {
  console.error('✗ 缺少 desktop/bin/QunZaiHost.exe，拒绝打包');
  process.exit(1);
}

for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { console.log('  跳过(不存在) ' + f); continue; }
  fs.copyFileSync(src, path.join(DIST, f));
  n++;
  console.log('  ' + f);
}

/* 内置 QQ 监视器（可选）：把 engine-src/napcat 之类拷进 dist/engine/<name>。
   只拷程序本体，绝不拷 config/ data/ logs/ —— 那里面有别人的 token 和登录态。
   用 --with-engine 或默认「存在就带」；用 --no-engine 可以出瘦包。 */
const ENGINE_SRC = path.join(ROOT, 'engine-src');
const wantEngine = !process.argv.includes('--no-engine');
if (wantEngine && fs.existsSync(ENGINE_SRC)) {
  console.log('\n=== 1b. 内置 QQ 监视器 ===');
  rmrf(path.join(DIST, 'engine'));
  const engines = fs.readdirSync(ENGINE_SRC, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const e of engines) {
    const src = path.join(ENGINE_SRC, e.name);
    const dst = path.join(DIST, 'engine', e.name);
    // 排除运行数据：这些是打包机自己的，进包就是泄漏（规则见 copyEngineDir）
    copyEngineDir(src, dst);
    const bytes = (function w(d) {
      let k = 0;
      for (const x of fs.readdirSync(d, { withFileTypes: true })) {
        k += x.isDirectory() ? w(path.join(d, x.name)) : fs.statSync(path.join(d, x.name)).size;
      }
      return k;
    })(dst);
    console.log(`  engine/${e.name}  (${(bytes / 1024 / 1024).toFixed(1)} MB，已排除 config/data/logs)`);
    // 许可证必须随包附带
    for (const lic of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      const p = path.join(src, lic);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dst, lic));
    }
  }
} else if (!wantEngine) {
  console.log('\n=== 1b. 跳过内置监视器（--no-engine，出瘦包）===');
  rmrf(path.join(DIST, 'engine'));
} else {
  console.log('\n=== 1b. 没有 engine-src/，出瘦包（不含内置监视器）===');
  rmrf(path.join(DIST, 'engine'));
}
console.log('\n=== 2. 现生成 dist/config.json（唯一来源：DEFAULT_CONFIG + 出厂覆盖）===');
const configLib = require(path.join(ROOT, 'server', 'config.js'));
/* 出厂默认与「代码默认」故意不同，别把它们混为一谈：
 *   DEFAULT_CONFIG 是「什么都没有时的兜底」，最保守（演示模式、AI 关）；
 *   安装包装给用户的必须是「按教程走一遍就能用」的状态——
 *   教程视频里的步骤是「面板里填 WS 地址 → 保存 → 自动重连」，全程没让人切过接入方式，
 *   所以这里必须是 onebot（地址已预填）且 AI 已启用，否则照着教程做完全程静默不响应。
 * 两者都绝不含任何真实凭证——这个对象是硬编码的，不来自任何运行中的配置。 */
const PACKAGE_OVERRIDES = {
  qq: { mode: 'onebot', onebot: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' } },
  ai: { enabled: true },
  update: { manifestUrl: 'https://blushhorizon.github.io/QunZai/update.json' }
};
const packaged = JSON.parse(JSON.stringify(configLib.DEFAULT_CONFIG));
packaged.qq.mode = PACKAGE_OVERRIDES.qq.mode;
packaged.qq.onebot = { ...PACKAGE_OVERRIDES.qq.onebot };
packaged.ai.enabled = PACKAGE_OVERRIDES.ai.enabled;
packaged.update = { ...packaged.update, ...PACKAGE_OVERRIDES.update };
fs.writeFileSync(path.join(DIST, 'config.json'), JSON.stringify(packaged, null, 2), 'utf8');
n++;
{
  const c = packaged;
  console.log('  qq.mode               = ' + JSON.stringify(c.qq.mode) + '   ← 教程依赖此默认值');
  console.log('  ai.enabled            = ' + JSON.stringify(c.ai.enabled));
  console.log('  qq.onebot.accessToken = ' + JSON.stringify(c.qq.onebot.accessToken) + (c.qq.onebot.accessToken ? '  ⚠ 非空！' : '  ✓'));
  console.log('  ai.apiKey             = ' + JSON.stringify(c.ai.apiKey) + (c.ai.apiKey ? '  ⚠ 非空！' : '  ✓'));
  console.log('  ai.commandSenders     = ' + JSON.stringify(c.ai.commandSenders) + '  ✓');
  console.log('  ai.targetChatKey(s)   = ' + JSON.stringify(c.ai.targetChatKey) + ' / ' + JSON.stringify(c.ai.targetChatKeys) + '  ✓');
  console.log('  update.manifestUrl    = ' + JSON.stringify(c.update.manifestUrl) + '  ✓');
}

console.log('\n=== 3. 清掉不该进包的文件 ===');
for (const junk of ['setup.nsi', 'data', 'precheck-package.js', 'server/atomic.js.tmp', 'README.md']) {
  const p = path.join(DIST, junk);
  if (fs.existsSync(p)) {
    if (junk === 'data') {
      // 允许存在但必须是空目录
      const inside = fs.readdirSync(p);
      if (inside.length) { rmrf(p); console.log('  已删除 dist/data（非空，说明混进了运行数据）: ' + inside.join(', ')); }
      else console.log('  dist/data 是空目录，保留');
    } else {
      rmrf(p);
      console.log('  已删除 dist/' + junk);
    }
  }
}

/* ---------------------------------------------------------------------------
 * 版本号注入：package.json 是唯一来源，改这一处，全项目跟着走。
 *
 * 为什么必须在这里做：版本号原先有 4 个手写副本（package.json、server/version.js、
 * public/index.html 的顶栏和关于栏、setup.nsi），打包只读 package.json 命名 exe，
 * 其余三个原样拷贝 —— 每次升版 HTML 里的版本号必然停在旧值。页面之所以还能显示对，
 * 全靠 app.js 运行时用服务端 state.version 覆盖 DOM；一旦页面在服务端响应前渲染
 * （首帧闪烁），或有人直接打开 dist/public/index.html 看，看到的就是错的版本号。
 * 收敛成「打包时注入」而不是「靠前端覆盖」，才是这一处真正修好。
 * ------------------------------------------------------------------------- */
const VERSION_TARGETS = [
  {
    file: path.join(DIST, 'server', 'version.js'),
    re: /(version:\s*')([^']*)(')/,
    why: '服务端 /api/status 的 version 字段'
  },
  {
    file: path.join(DIST, 'public', 'index.html'),
    re: /(<span[^>]*id="appVersion"[^>]*>v)([^<]*)(<)/,
    why: '监控台顶栏'
  },
  {
    file: path.join(DIST, 'public', 'index.html'),
    re: /(<span[^>]*id="aboutVersion"[^>]*>v)([^<]*)(<)/,
    why: '关于栏'
  }
];
let versionInjected = 0;
let versionAlready = 0;
const versionMissed = [];
for (const t of VERSION_TARGETS) {
  if (!fs.existsSync(t.file)) { versionMissed.push(t.why + '（文件不存在）'); continue; }
  const before = fs.readFileSync(t.file, 'utf8');
  const m = before.match(t.re);
  if (!m) { versionMissed.push(t.why + '（找不到注入点，模板可能改过）'); continue; }
  if (m[2] === VERSION) { versionAlready++; continue; }
  fs.writeFileSync(t.file, before.replace(t.re, (s, a, old, b) => a + VERSION + b));
  versionInjected++;
  console.log('  ✓ ' + t.why + '：' + m[2] + ' → ' + VERSION);
}
/* 漏了就得吼出来：版本号对不上是发版事故，不能让安装包带着旧版本号出厂 */
if (versionMissed.length) {
  console.error('\n✗ 版本号注入失败（应为 ' + VERSION + '）：');
  for (const m of versionMissed) console.error('    · ' + m);
  console.error('  修好模板里的 id="appVersion" / id="aboutVersion" / version.js 再打包。');
  process.exit(1);
}
console.log('  ✓ 版本号统一为 v' + VERSION + '（' + versionInjected + ' 处更正，' + versionAlready + ' 处本就正确）');

console.log('\n=== 4. 隐私闸门 ===');const pre = spawnSync(process.execPath, [path.join(ROOT, 'precheck-package.js')], { encoding: 'utf8' });
process.stdout.write((pre.stdout || '') + (pre.stderr || ''));
if (pre.status !== 0) {
  console.error('\n✗ 闸门没过，拒绝打包。先处理上面列出的问题。');
  process.exit(1);
}
console.log('\n✓ 同步完成，dist/ 共 ' + n + ' 个文件，可安全打包。');

if (process.argv.includes('--installer')) {
  console.log('\n=== 5. 编译安装包（v' + VERSION + '） ===');
  fs.mkdirSync(RELEASES, { recursive: true });
  const makensis = ['C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe']
    .find((p) => fs.existsSync(p));
  if (!makensis) { console.error('✗ 找不到 makensis.exe'); process.exit(1); }
  const r = spawnSync(makensis, ['/DVERSION=' + VERSION, 'setup.nsi'], { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write((r.stdout || '') + (r.stderr || ''));
  if (r.status !== 0) { console.error('✗ makensis 失败'); process.exit(1); }
  const out = path.join(RELEASES, `群崽QunZai安装包-v${VERSION}.exe`);
  if (!fs.existsSync(out)) { console.error('✗ 安装包没有生成：' + out); process.exit(1); }

  const buf = fs.readFileSync(out);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const md5 = crypto.createHash('md5').update(buf).digest('hex').toUpperCase();
  const history = path.join(RELEASES, 'history', 'v' + VERSION);
  fs.mkdirSync(history, { recursive: true });
  fs.copyFileSync(out, path.join(history, path.basename(out)));
  fs.writeFileSync(path.join(history, 'SHA256.txt'),
    `${sha256}  ${path.basename(out)}\nMD5 ${md5}\nSize ${buf.length} bytes\n`, 'utf8');
  fs.writeFileSync(path.join(history, 'release.json'), JSON.stringify({
    name: '群崽 QunZai',
    version: VERSION,
    builtAt: new Date().toISOString(),
    file: path.basename(out),
    bytes: buf.length,
    md5,
    sha256,
    note: '本地历史归档；发布状态见官网 / GitHub Releases'
  }, null, 2), 'utf8');
  console.log('  ✓ ' + out + '  ' + (buf.length / 1024).toFixed(1) + ' KB');
  console.log('  MD5=' + md5 + '  SHA256=' + sha256.slice(0, 16) + '…');
  console.log('  ✓ 本地历史归档：' + history);
}
