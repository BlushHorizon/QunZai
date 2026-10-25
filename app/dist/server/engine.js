'use strict';
/**
 * 群崽 QQ 内核 · OneBot 运行时（监视器）集成层
 * ---------------------------------------------------------------------------
 * 所谓「监视器」，就是真正负责登录 QQ、监听消息、把消息转成 OneBot 11 的那个
 * 第三方运行时（NapCat / SnowLuma / 其他兼容实现）。群崽自己不登录 QQ。
 *
 * 这一层做四件事：
 *   1. 找到运行时：随包内置的 engine/ 优先，其次用户自己指定的目录，最后扫常见目录；
 *   2. 认出它是哪一家，按它自己的入口启动（必要时先把它的 OneBot 配置写好）；
 *   3. 读它自己的配置，把 WS 端口和 Token 同步给群崽；
 *   4. 顺便找出它的 WebUI 面板地址，让用户能点开管理。
 *
 * 两家配置格式不一样，这里都认：
 *   NapCat   config/onebot11_<QQ>.json  → network.websocketServers[] / httpServers[]，字段 token
 *            config/onebot11.json        → 未登录时的公共模板
 *   SnowLuma config/onebot_<QQ>.json    → networks.wsServers[] / httpServers[]，字段 accessToken
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { writeFileAtomic } = require('./atomic');
const { IS_WIN, findNodeExe } = require('./platform');

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function isPortOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function httpJson(port, pathname, token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch { reject(new Error('返回不是 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

function waitPort(port, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      if (await isPortOpen(port)) return resolve(true);
      if (Date.now() >= until) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

/* OneBot 默认端口：NapCat 正向 WS 3001；HTTP 3000 */
const DEFAULT_WS_PORT = 3001;
const DEFAULT_API_PORT = 3000;
const DEFAULT_WEBUI_PORT = 6099;

class QQEngine {
  constructor(opts = {}) {
    this.root = opts.root;
    this.getConfig = opts.getConfig || (() => ({}));
    this.saveConfig = opts.saveConfig || (() => {});
    this.startedProcess = null;
    this.lastError = '';
    this.lastInfo = null;
    this.lastStartedAt = 0;
    this.autoPromise = null;
    /** 后台等扫码登录的 Promise（同一时间只跑一个） */
    this.pending = null;
    /** 登录完成后的回调，由 server.js 注入（用来重连适配器、推 SSE） */
    this.onReady = null;
  }

  /** 随包内置的运行时常量目录：<安装目录>/engine */
  get bundledRoot() {
    return path.join(this.root, 'engine');
  }

  /**
   * 给监视器主进程注入「禁止弹控制台」的预加载脚本。
   * ------------------------------------------------------------------
   * NapCat 这类运行时会在内部 fork worker 子进程，且 fork 时不设 windowsHide。
   * 由于群崽自己是 GUI 程序（没有控制台），worker 带 inherit 的 stdio 就会
   * 新开一个控制台窗口——也就是用户看到的那黑框。
   *
   * 这里通过 NODE_OPTIONS=--require <no-console.cjs>，让监视器主进程一启动就
   * 把 child_process 的 spawn/fork/execFile/exec 补上 windowsHide: true，
   * 从进程内部解决问题，不用改第三方源码、也不会因为换版本失效。
   *
   * 只对内置/本机 node 入口生效（.bat 入口走 cmd.exe，本来就带窗口，
   * 但那种情况会走 launcher 分支，另外处理）。
   */
  _consoleEnv() {
    try {
      const shim = path.join(__dirname, 'no-console.cjs');
      if (!exists(shim)) return {};
      const flag = '--require "' + shim.replace(/\\/g, '/') + '"';
      const prev = String(process.env.NODE_OPTIONS || '').trim();
      // 已经带过就不重复加（避免重复预加载）
      if (prev.includes('no-console.cjs')) return {};
      return { NODE_OPTIONS: prev ? prev + ' ' + flag : flag };
    } catch {
      return {};
    }
  }

  /** 判断某个目录是不是「随包内置」的那一份（注意：必须带分隔符，
   *  否则 app\engine-src 也会被误判成 app\engine 里的东西） */
  _isBundled(dir) {
    const root = this.bundledRoot.toLowerCase() + path.sep;
    const abs = path.resolve(dir).toLowerCase() + path.sep;
    return abs.startsWith(root);
  }

  _candidateDirs(overrideDir) {
    const cfg = this.getConfig();
    const dirs = [];
    const add = (p) => {
      if (!p) return;
      const abs = path.resolve(String(p));
      if (!dirs.some((x) => x.toLowerCase() === abs.toLowerCase())) dirs.push(abs);
    };

    // 用户显式指定的目录永远排最前
    add(overrideDir);

    const source = cfg.qq?.engine?.source || 'auto';

    // 随包内置的那一份：<安装目录>\engine\（engine\napcat、engine\snowluma 之类）
    const bundled = this.bundledRoot;
    // 注意顺序：先列 engine\<名字>，再列 engine 本身。
    // engine\ 根目录下没有启动入口，先试它只会白白浪费一次探测。
    const addBundled = () => {
      for (const name of ['napcat', 'napcatqq', 'snowluma', 'llonebot']) {
        add(path.join(bundled, name));
      }
      add(bundled);
    };

    // 「监视器来源」决定还要不要继续往下找：
    //   bundled = 只认随包内置的；custom = 只认用户填的目录；
    //   auto（默认）= 内置优先，找不到再看用户填的和常见目录。
    if (source === 'bundled' || source === 'auto') addBundled();
    if (source === 'custom' || source === 'auto') {
      add(cfg.qq?.engine?.dir);
      add(process.env.QUNZAI_ENGINE_DIR);
      add(path.join(os.homedir(), 'QunZaiEngine'));
      if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'QunZai', 'engine'));

      // 只在常见盘符顶层找“名字像 OneBot 运行时”的目录，不做全盘递归。
      if (IS_WIN) {
        for (const drive of ['D:\\', 'E:\\', 'C:\\']) {
          try {
            for (const name of fs.readdirSync(drive)) {
              if (/snowluma|onebot|napcat|qunzai[-_ ]?engine/i.test(name)) {
                add(path.join(drive, name));
              }
            }
          } catch { /* 盘符不存在或没权限 */ }
        }
      }
    } else {
      // 只认内置的，但「自定义目录」栏填了就当作显式覆盖，仍然尊重
      add(cfg.qq?.engine?.dir);
    }
    return dirs;
  }

  /* NapCat 的配置可能在 <dir>\config，也可能在 <dir>\napcat\config（Shell 包结构） */
  _configDirs(dir) {
    const out = [];
    const add = (p) => { if (exists(p) && !out.includes(p)) out.push(p); };
    add(path.join(dir, 'config'));
    add(path.join(dir, 'napcat', 'config'));
    add(dir);
    return out;
  }

  _findConfig(dir) {
    // 兼容两家命名：NapCat 用 onebot11_<QQ>.json / onebot11.json，SnowLuma 用 onebot_<QQ>.json
    const files = [];
    for (const base of this._configDirs(dir)) {
      try {
        for (const name of fs.readdirSync(base)) {
          if (!/^onebot\d*_.+\.json$/i.test(name) && !/^onebot11\.json$/i.test(name)) continue;
          if (/\.disabled$/i.test(name)) continue;
          files.push(path.join(base, name));
        }
      } catch { /* 没有这个目录 */ }
    }
    return files;
  }

  /**
   * 从配置文件里读出 OneBot 网络配置。两家字段名不同，返回统一形状。
   * NapCat  : network.websocketServers[] / network.httpServers[]，token
   * SnowLuma: networks.wsServers[]       / networks.httpServers[]，accessToken
   */
  _readNetwork(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    const netCfg = cfg.network || cfg.networks;
    if (!netCfg || typeof netCfg !== 'object') return null;

    const wsList = netCfg.websocketServers || netCfg.wsServers || netCfg.ws || [];
    const httpList = netCfg.httpServers || netCfg.http || [];
    const firstWs = (Array.isArray(wsList) ? wsList : []).find((x) => x && Number(x.port)) || null;
    const firstHttp = (Array.isArray(httpList) ? httpList : []).find((x) => x && Number(x.port)) || null;
    if (!firstWs) return null;
    // 明确被关掉的监听器不算数
    if (firstWs.enable === false) return null;

    const port = Number(firstWs.port);
    if (!port) return null;
    const token = String(firstWs.token ?? firstWs.accessToken ?? '');
    const httpPort = Number(firstHttp?.port) || 0;
    const httpToken = String(firstHttp?.token ?? firstHttp?.accessToken ?? '');

    return { wsPort: port, wsToken: token, httpPort, httpToken };
  }

  /** 找运行时的 WebUI 面板地址（NapCat 有独立 webui 配置，SnowLuma 在 runtime.json） */
  _readWebUI(dir) {
    const bases = this._configDirs(dir);
    const tryFiles = [];
    for (const b of bases) {
      tryFiles.push(
        path.join(b, 'webui.json'),
        path.join(b, 'napcat', 'webui.json'),
        path.join(b, 'runtime.json')
      );
    }
    for (const f of tryFiles) {
      const cfg = readJson(f);
      if (!cfg) continue;
      const port = Number(cfg.port || cfg.webuiPort || cfg.webUiPort);
      if (!port) continue;
      // NapCat 默认 host 写 "::"（监听所有地址），直接拼进 URL 会变成 http://:::6099
      let host = String(cfg.host || '127.0.0.1').trim();
      if (!host || host === '::' || host === '[::]' || host === '0.0.0.0') host = '127.0.0.1';
      const scheme = cfg.https || cfg.ssl ? 'https' : 'http';
      // NapCat 的 token 在 URL 里，带上才能直接进面板；SnowLuma 的是密码，不带
      const token = String(cfg.token || '');
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      return { url: `${scheme}://${host}:${port}/webui${qs}`, port };
    }
    return null;
  }

  _detectKind(dir) {
    if (exists(path.join(dir, 'napcat', 'napcat.mjs')) || exists(path.join(dir, 'napcat.mjs'))
      || exists(path.join(dir, 'NapCatWinBootMain.exe'))) return 'napcat';
    if (exists(path.join(dir, 'index.mjs'))) return 'snowluma';
    return '';
  }

  _buildEntry(dir, kind) {
    const nodeExe = findNodeExe(dir);
    // NapCat Shell 包：入口 index.js 会自己 import napcat/napcat.mjs
    if (kind === 'napcat') {
      if (exists(path.join(dir, 'index.js'))) return { cmd: nodeExe, args: ['index.js'] };
      if (exists(path.join(dir, 'napcat', 'napcat.mjs'))) return { cmd: nodeExe, args: [path.join('napcat', 'napcat.mjs')] };
      if (exists(path.join(dir, 'NapCatWinBootMain.exe'))) return { cmd: path.join(dir, 'NapCatWinBootMain.exe'), args: [] };
    }
    if (exists(path.join(dir, 'index.mjs'))) return { cmd: nodeExe, args: ['index.mjs'] };
    if (exists(path.join(dir, 'app.js'))) return { cmd: nodeExe, args: ['app.js'] };
    // .bat 入口：先试着把里面的 node 命令行抠出来直接跑（见 _fromBat），
    // 这样既不会弹出 cmd 黑框，也能保住 detached 的独立性。
    // .bat / cmd.exe 是 Windows 独有的，别的平台没有这个兜底。
    if (IS_WIN) {
      for (const bat of ['launcher.bat', 'start.bat']) {
        const p = path.join(dir, bat);
        if (!exists(p)) continue;
        const direct = this._fromBat(p, dir, nodeExe);
        if (direct) return direct;
        // 抠不出来就退回 cmd，但标记 isShell，start() 里不会给它新开控制台
        return { cmd: 'cmd.exe', args: ['/c', bat], isShell: true };
      }
    }
    return null;
  }

  /**
   * 从 .bat 里找出真正干活的 node 命令。
   * 很多运行时（SnowLuma 等）的 launcher.bat 只是「检查 Node 版本 → node xxx.mjs」的包装，
   * 直接跑 cmd 会白开一个控制台窗口；把 node 那行拎出来自己 spawn 就没这问题。
   * 只认最简单的写法（node [.\/]script），认不出就返回 null 交给调用方回退。
   */
  _fromBat(batPath, dir, nodeExe) {
    let text = '';
    try { text = fs.readFileSync(batPath, 'utf8'); } catch { return null; }
    const lines = text.split(/\r?\n/);
    let hit = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || /^(::|rem\b|@?echo\b|if\b|set\b|pause\b|title\b|cd\b|chcp\b|exit\b)/i.test(line)) continue;
      const m = /^(?:"([^"]*node[^"]*)"|([^\s"]*node(?:\.exe)?))\s+(.+)$/i.exec(line);
      if (!m) continue;
      const exe = m[1] || m[2] || '';
      // 只认 node 本体（node、node.exe、.\node.exe、<dir>\node.exe），别把 npm 之类当成 node
      if (!/(^|[\\/])node(\.exe)?$/i.test(exe.replace(/"/g, ''))) continue;
      const rest = m[3].replace(/\s*%\*.*$/, '').trim();
      if (!rest) continue;
      const args = rest.match(/"[^"]*"|\S+/g).map((s) => s.replace(/^"|"$/g, ''));
      if (!args.length) continue;
      const script = args[0].replace(/^\.?[\\/]/, '');
      if (!/\.(m?js|cjs)$/i.test(script)) continue;
      if (!exists(path.join(dir, script))) continue;
      hit = { cmd: nodeExe, args };
    }
    return hit;
  }

  /**
   * 内置 NapCat 首次启动前，先把 OneBot 11 正向 WS 写好。
   * 不写的话它默认不监听，群崽连不上，用户还得自己开 WebUI 点一遍。
   * 只补缺失项，不覆盖用户已有的配置。
   */
  _ensureNapCatConfig(dir, account) {
    const kind = this._detectKind(dir);
    if (kind !== 'napcat') return { ok: true, created: false };
    // NapCat 的数据目录由 NAPCAT_WORKDIR 决定：设了就是 <WORKDIR>\config。
    // start() 里我们固定把 WORKDIR 指到 info.dir，所以这里必须写在 <dir>\config，
    // 不能写到 <dir>\napcat\config —— 那样 NapCat 起来根本读不到。
    const configDir = path.join(dir, 'config');
    try { fs.mkdirSync(configDir, { recursive: true }); } catch { /* noop */ }

    const target = path.join(configDir, `onebot11_${account || ''}.json`);
    const generic = path.join(configDir, 'onebot11.json');
    // 未指定账号时先写公共模板，NapCat 登录后会自动派生 onebot11_<uin>.json
    const file = account ? target : generic;
    if (exists(file)) return { ok: true, created: false, file };

    const cfg = {
      network: {
        httpServers: [
          {
            name: 'http-server',
            enable: true,
            port: DEFAULT_API_PORT,
            host: '127.0.0.1',
            enableCors: true,
            enableWebsocket: false,
            messagePostFormat: 'array',
            token: '',
            debug: false
          }
        ],
        httpSseServers: [],
        httpClients: [],
        websocketServers: [
          {
            name: 'websocket-server',
            enable: true,
            host: '127.0.0.1',
            port: DEFAULT_WS_PORT,
            messagePostFormat: 'array',
            reportSelfMessage: false,
            token: '',
            enableForcePushEvent: true,
            debug: false,
            heartInterval: 30000
          }
        ],
        websocketClients: [],
        plugins: []
      },
      musicSignUrl: '',
      enableLocalFile2Url: false,
      parseMultMsg: false,
      imageDownloadProxy: '',
      timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 }
    };
    try {
      writeFileAtomic(file, JSON.stringify(cfg, null, 2));
      return { ok: true, created: true, file };
    } catch (err) {
      return { ok: false, error: '写入 NapCat 配置失败：' + err.message };
    }
  }

  _inspect(dir, wantedAccount) {
    if (!dir || !exists(dir)) return null;
    const files = this._findConfig(dir);
    if (!files.length) return null;

    let file = null;
    let account = '';
    if (wantedAccount) {
      file = files.find((f) => path.basename(f).includes(String(wantedAccount))) || null;
      if (!file) {
        // 还没登录过时只有公共模板 onebot11.json；NapCat 登录后会照着它派生
        // onebot11_<uin>.json。这一步不能让「填了机器人号」反而变成找不到配置。
        file = files.find((f) => /^onebot11\.json$/i.test(path.basename(f))) || null;
      }
      if (!file) return null;
    } else {
      // 没有指定账号时，优先选带数字账号的文件；仍然只选未禁用的配置。
      file = files.find((f) => /onebot\d*_[0-9]+\.json$/i.test(path.basename(f)))
        || files.find((f) => /onebot11\.json$/i.test(path.basename(f)))
        || files[0];
    }
    const base = path.basename(file);
    const m = base.match(/onebot\d*_([0-9]+)\.json$/i);
    account = m ? m[1] : (wantedAccount ? String(wantedAccount) : '');

    const cfg = readJson(file);
    const net = this._readNetwork(cfg);
    if (!net) return null;
    const webui = this._readWebUI(dir);
    const kind = this._detectKind(dir);
    const entry = this._buildEntry(dir, kind);

    return {
      ok: true,
      dir,
      account,
      configFile: file,
      kind: kind || 'unknown',
      wsPort: net.wsPort,
      wsToken: net.wsToken,
      apiPort: net.httpPort || Number(this.getConfig().qq?.engine?.apiPort) || DEFAULT_API_PORT,
      httpToken: net.httpToken,
      webui,
      entry,
      bundled: this._isBundled(dir),
      // 不把 token 放进 public 字段；只有 start() 内部用
      public: {
        dir,
        account,
        configFile: path.basename(file),
        kind: kind || 'unknown',
        wsPort: net.wsPort,
        apiPort: net.httpPort || 0,
        webuiUrl: webui?.url || '',
        bundled: this._isBundled(dir),
        entry: entry ? path.basename(entry.cmd) + ' ' + entry.args.join(' ') : '未找到启动入口'
      }
    };
  }

  async discover(override = {}) {
    const wanted = override.account || this.getConfig().qq?.engine?.account || '';
    const tried = [];
    for (const dir of this._candidateDirs(override.dir)) {
      tried.push(dir);
      if (!exists(dir)) continue;
      // 找到了目录但还没有配置（内置 NapCat 第一次跑）→ 先把配置补上再认
      const kind = this._detectKind(dir);
      if (kind === 'napcat' && !this._findConfig(dir).length) {
        const made = this._ensureNapCatConfig(dir, wanted);
        if (!made.ok) { this.lastError = made.error; continue; }
      }
      const info = this._inspect(dir, wanted);
      if (info) {
        this.lastInfo = info;
        return { ...info, tried };
      }
    }
    return {
      ok: false,
      error: wanted
        ? `没有找到账号 ${wanted} 的 OneBot 配置；内置的监视器需要先启动一次并扫码登录`
        : '没有找到兼容的 OneBot 运行时，请在设置里填写监视器目录',
      tried
    };
  }

  async status() {
    const cfg = this.getConfig();
    const engineCfg = cfg.qq?.engine || {};
    const info = this.lastInfo || null;
    const wsPort = info?.wsPort || null;
    const port = info?.apiPort || Number(engineCfg.apiPort) || DEFAULT_API_PORT;
    // 用户在设置里填的 WS 地址优先——他可能手动接了别的监听器
    const configuredWs = String(cfg.qq?.onebot?.wsUrl || '');
    const running = wsPort ? await isPortOpen(wsPort) : await isPortOpen(port);
    // 运行时的面板开着但 OneBot 端口没开 —— 多半是还没扫码登录
    const webuiOpen = info ? await this._webuiOpen(info) : false;
    return {
      enabled: engineCfg.enabled !== false,
      autoStart: engineCfg.autoStart !== false,
      /** bundled = 用随包内置的监视器；custom = 用用户自己找的；auto = 先内置后自定义 */
      source: engineCfg.source || 'auto',
      dir: info?.dir || engineCfg.dir || '',
      account: engineCfg.account || info?.account || '',
      kind: info?.public?.kind || '',
      bundled: !!info?.public?.bundled,
      running,
      /** 面板开着、OneBot 没开 = 在等你扫码 */
      needLogin: !running && webuiOpen,
      startedByApp: !!this.startedProcess,
      wsPort,
      apiPort: port,
      webuiUrl: info?.public?.webuiUrl || '',
      configuredWs,
      lastError: this.lastError,
      configFile: info?.public?.configFile || '',
      entry: info?.public?.entry || '',
      bundledAvailable: exists(this.bundledRoot)
    };
  }

  /** 群崽是靠 WS 连它的，所以真正要等的是 WS 端口；HTTP 端口只用来调接口。 */
  _waitPorts(info) {
    return [info.wsPort, info.apiPort].filter(Boolean);
  }

  async _anyOpen(info) {
    for (const p of this._waitPorts(info)) {
      if (await isPortOpen(p)) return p;
    }
    return 0;
  }

  /** 未登录时运行时只会开 WebUI 并落一张二维码，这里把那张图找出来 */
  qrFile(info) {
    if (!info?.dir) return null;
    const candidates = [
      path.join(info.dir, 'cache', 'qrcode.png'),
      path.join(info.dir, 'napcat', 'cache', 'qrcode.png')
    ];
    let best = null;
    for (const f of candidates) {
      try {
        const st = fs.statSync(f);
        if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs };
      } catch { /* 没有这张图 */ }
    }
    return best ? best.file : null;
  }

  /**
   * 面板端口要「现场再读一次」：全新安装时 webui.json 是 NapCat 首次启动才生成的，
   * 而 _inspect() 发生在 spawn 之前，那时 info.webui 一定是 null。
   * 只信 info.webui 就会把「已经在等你扫码」误判成「启动超时」。
   */
  _webuiPort(info) {
    // 1) 上次读到的（进程已在跑时有效）
    const cached = Number(info?.webui?.port);
    if (cached) return cached;
    // 2) 现场重读配置文件
    const fresh = info?.dir ? this._readWebUI(info.dir) : null;
    if (fresh?.port) {
      info.webui = fresh;           // 缓存回 info，后续拼接 URL 直接用
      // public 是 _inspect() 时定下的快照，此刻 webui.json 才刚生成，要一并回填，
      // 否则前端拿到的 webuiUrl 永远是空串，「打开它的管理面板」按钮不显示。
      if (info.public) info.public.webuiUrl = fresh.url || '';
      return Number(fresh.port);
    }
    // 3) NapCat 的默认面板端口，文件还没落地时先按它探
    if (info?.kind === 'napcat') return DEFAULT_WEBUI_PORT;
    return 0;
  }

  async _webuiOpen(info) {
    const port = this._webuiPort(info);
    return port ? isPortOpen(port) : false;
  }

  /**
   * 首启（还没扫码）时 NapCat 只会开 WebUI，OneBot 的 3000/3001 要等登录后才听。
   * 所以这里不能只看 OneBot 端口，否则会把「等你扫码」误判成「启动失败」。
   */
  async _awaitReady(info, timeoutMs = 45000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await this._anyOpen(info)) return { state: 'ready' };
      if (await this._webuiOpen(info)) return { state: 'needLogin', qr: this.qrFile(info) };
      await sleep(600);
    }
    if (await this._anyOpen(info)) return { state: 'ready' };
    if (await this._webuiOpen(info)) return { state: 'needLogin', qr: this.qrFile(info) };
    return { state: 'timeout' };
  }

  /** 登录完成后在后台盯着端口，一开就把配置同步过来，不用用户再点一次 */
  _awaitLogin(info, started) {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const deadline = Date.now() + 10 * 60 * 1000;
      try {
        while (Date.now() < deadline) {
          await sleep(2000);
          if (await this._anyOpen(info)) {
            const res = await this._sync(info, started);
            if (res.ok && typeof this.onReady === 'function') {
              try { this.onReady(res); } catch { /* 回调失败不影响登录 */ }
            }
            return res;
          }
          if (this.startedProcess && this.startedProcess.exitCode !== null
            && this.startedProcess.exitCode !== undefined) break;
        }
        this.lastError = '等待扫码登录超时（10 分钟），请重新点「启动并同步」';
        return { ok: false, error: this.lastError, needLogin: true };
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /** 目录里最新的那个日志文件的最后一行，用来把「启动超时」说得具体点 */
  _tailLog(info) {
    try {
      const dirs = [path.join(info.dir, 'logs'), path.join(info.dir, 'napcat', 'logs')];
      const files = [];
      for (const d of dirs) {
        if (!exists(d)) continue;
        for (const name of fs.readdirSync(d)) {
          const f = path.join(d, name);
          try {
            const st = fs.statSync(f);
            if (st.isFile()) files.push({ f, m: st.mtimeMs });
          } catch { /* 单个文件读不到就跳过 */ }
        }
      }
      if (!files.length) return '';
      files.sort((a, b) => b.m - a.m);
      const lines = fs.readFileSync(files[0].f, 'utf8').trim().split(/\r?\n/);
      return lines.slice(-2).join(' ⏎ ').slice(-260);
    } catch {
      return '';
    }
  }

  /** 把运行时的 WS 地址/Token 写进群崽配置 */
  async _sync(info, started) {
    let login = null;
    if (info.apiPort) {
      try {
        login = await httpJson(info.apiPort, '/get_login_info', info.httpToken, 5000);
      } catch {
        // 有些实现要等 QQ 登录完成后才允许调用；端口已起来，继续同步配置。
      }
    }
    const loginId = login?.data?.user_id != null ? String(login.data.user_id) : '';
    if (info.account && loginId && loginId !== String(info.account)) {
      this.lastError = `监视器登录的是 ${loginId}，与目标机器人号 ${info.account} 不一致，已停止同步`;
      return { ok: false, error: this.lastError, info: info.public };
    }

    const before = this.getConfig().qq || {};
    const nextOnebot = {
      wsUrl: `ws://127.0.0.1:${info.wsPort}`,
      accessToken: info.wsToken
    };
    this.saveConfig({
      qq: {
        mode: 'onebot',
        onebot: nextOnebot,
        engine: {
          ...(before.engine || {}),
          enabled: true,
          dir: info.dir,
          account: info.account,
          lastConnectedAt: new Date().toISOString()
        }
      }
    });
    this.lastError = '';
    const changed = before.mode !== 'onebot'
      || before.onebot?.wsUrl !== nextOnebot.wsUrl
      || before.onebot?.accessToken !== nextOnebot.accessToken;

    return {
      ok: true,
      started,
      alreadyRunning: !started,
      changed,
      login: loginId || null,
      info: info.public
    };
  }

  /**
   * 启动（必要时拉起运行时）。登录没完成时返回 needLogin + qrPath，
   * 前端据此显示二维码；登录一完成后台自己同步配置，不用再点一次。
   */
  async start(override = {}) {
    const found = await this.discover(override);
    if (!found.ok) {
      this.lastError = found.error;
      return { ok: false, error: found.error, tried: found.tried };
    }
    const info = found;
    this.lastInfo = info;
    this.lastError = '';

    let started = false;
    const already = await this._anyOpen(info);
    if (!already) {
      if (!info.entry) {
        this.lastError = '找到了配置，但没有找到可启动的入口（index.js / napcat.mjs / index.mjs / launcher.bat）';
        return { ok: false, error: this.lastError, info: info.public };
      }
      try {
        const child = spawn(info.entry.cmd, info.entry.args, {
          cwd: info.dir,
          // .bat 兜底入口（cmd.exe）不能 detached：Windows 上它会另开一个控制台窗口。
          // 直接跑 node 的入口（绝大多数情况）保持 detached，这样群崽异常退出也不带走监视器。
          detached: !info.entry.isShell,
          windowsHide: true,
          stdio: 'ignore',
          env: { ...process.env, ...this._consoleEnv(), NAPCAT_WORKDIR: info.dir }
        });
        child.unref();
        this.startedProcess = child;
        this.lastStartedAt = Date.now();
        started = true;
      } catch (err) {
        this.lastError = '启动监视器失败：' + err.message;
        return { ok: false, error: this.lastError, info: info.public };
      }
      const ready = await this._awaitReady(info);
      if (ready.state === 'timeout') {
        const logs = this._tailLog(info);
        this.lastError = `监视器没有在 45 秒内监听 ${this._waitPorts(info).join(' / ')} 端口。`
          + (info.kind === 'napcat'
            ? '最常见的原因是本机没装桌面版 QQ（新版 NTQQ），或者 QQ 版本太新/太旧和内置那份对不上。'
            : '')
          + (logs ? ` 它的日志最后几行：${logs}` : '');
        return { ok: false, error: this.lastError, info: info.public, started };
      }
      if (ready.state === 'needLogin') {
        this._awaitLogin(info, started);
        return {
          ok: true,
          started,
          needLogin: true,
          loginUrl: info.public.webuiUrl || '',
          qr: !!ready.qr,
          info: info.public,
          hint: '第一次登录要扫码：用小号在手机 QQ 上扫下面的码，登录后群崽会自动接上'
        };
      }
    }

    return this._sync(info, started);
  }

  async auto() {
    if (this.autoPromise) return this.autoPromise;
    this.autoPromise = (async () => {
      const cfg = this.getConfig();
      if (cfg.qq?.engine?.autoStart === false) {
        return { ok: false, skipped: true, error: '自动启动已关闭' };
      }
      return this.start({});
    })();
    try {
      return await this.autoPromise;
    } finally {
      this.autoPromise = null;
    }
  }

  stop() {
    if (!this.startedProcess) {
      return { ok: false, error: '当前没有由群崽启动的监视器；为避免误杀，未停止其他进程' };
    }
    const pid = this.startedProcess.pid;
    try {
      if (IS_WIN) {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.startedProcess.kill('SIGTERM');
      }
    } catch (err) {
      return { ok: false, error: '停止失败：' + err.message };
    }
    this.startedProcess = null;
    return { ok: true, pid };
  }
}

module.exports = { QQEngine };
