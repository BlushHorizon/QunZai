'use strict';
/**
 * DeepSeek 网页版驱动（对应 EAgent 里驱动 chat.deepseek.com 的那一段）
 * ---------------------------------------------------------------------------
 * 做法与 EAgent 一致：
 *   1. 用独立用户配置目录启动 Edge（Chromium 136+ 禁止在默认配置目录开 CDP）
 *   2. 通过 http://127.0.0.1:<port>/json 找到 chat.deepseek.com 页面
 *   3. WebSocket 连上 webSocketDebuggerUrl，用 Runtime.evaluate 操作 DOM，
 *      用 Input.dispatchKeyEvent 回车发送
 *   4. 轮询 .ds-markdown--block 读取回答，等到"停止生成"消失且文本稳定即完成
 *
 * 状态：idle / launching / need-login / ready / thinking / error
 *
 * 多站点：切换模型 = 换一份站点档案（server/web-sites.js：URL + 各页面选择器），
 * 同一套 CDP 驱动照跑；DeepSeek 是默认档案，选择器与历史行为完全一致。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SITES, DEFAULT_SITE, getSite, siteList } = require('./web-sites');
const { browserCandidates, IS_ANDROID, IS_WIN } = require('./platform');

const DEFAULT_PORT = 9222;
const PAGE_URL = SITES[DEFAULT_SITE].url;   // 默认站点（DeepSeek 网页版）

/* 浏览器可执行文件候选：Windows 用 Edge/Chrome，Linux/macOS 用发行版包路径 */
const EDGE_CANDIDATES = browserCandidates();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class DeepSeekWeb {
  /**
   * @param {object} opts
   * @param {number} opts.port      CDP 端口
   * @param {string} opts.profileDir 独立配置目录（用于保存登录态）
   * @param {string} [opts.browserPath]
   * @param {string} [opts.site]    网页版站点档案 id（deepseek / qianwen / kimi / mimo），默认 deepseek
   */
  constructor(opts = {}) {
    this.port = opts.port || DEFAULT_PORT;
    this.profileDir = opts.profileDir;
    // 桌面宿主内嵌模式：CDP 由 QunZaiHost 的 WebView2 提供，绝不能再拉起外部 Edge
    this.embedded = process.env.QUNZAI_EMBEDDED === '1';
    // 安卓（APK）里没有 Edge/Chrome，用户也没法装一个带 CDP 的浏览器，
    // 所以网页版模式在安卓上不可用——由宿主（APK）提示改用 API 模式。
    this.supported = !IS_ANDROID;
    this.browserPath = opts.browserPath || EDGE_CANDIDATES.find((p) => p && fs.existsSync(p));
    this.onStatus = opts.onStatus || (() => {});
    // 当前站点档案（切换模型 = 换档案，同一套浏览器/CDP 驱动）
    this.siteId = opts.site || DEFAULT_SITE;
    this.site = getSite(this.siteId);
    // 用户在网页端填写的提示词：新建对话时自动发送一次
    this.prompt = opts.prompt || '';
    this.maxRounds = opts.maxRounds || 50;
    this.roundCount = 0;
    this._promptSent = false;
    this._promptTask = null;   // 新建对话后的提示词后台发送任务
    this.state = 'idle';
    this.message = '';
    this._ws = null;
    this._wsUrl = '';
    this._msgId = 0;
    this._pending = new Map();
    this._busy = false;
    this._thinkingSince = 0;   // 看门狗：记录进入"思考中"的时间
  }

  status() {
    return {
      state: this.state,
      message: this.message,
      site: this.siteId,
      siteName: this.site.name,
      siteShort: this.site.short || this.site.name,
      siteUrl: this.site.url,
      images: !!this.site.images,
      port: this.port,
      browser: this.browserPath || '',
      roundCount: this.roundCount,
      maxRounds: this.maxRounds,
      promptSet: !!String(this.prompt || '').trim(),
      promptSent: this._promptSent,
      // 安卓上网页版不可用，前端据此提示改用 API 模式
      supported: this.supported
    };
  }

  /** 运行时更新配置（网页设置改动即时生效，无需重启） */
  /** 提示词发送证据日志：打给 app.log，用户可直接核对内容是否完整 */
  _logPromptSent(when) {
    const t = String(this.prompt || '');
    const hasSticker = t.includes('【表情包能力】');
    console.log(`[${this.siteId}] 提示词已发送（${when}，${t.length} 字${hasSticker ? '，含【表情包能力】✓' : '，⚠ 缺表情包能力段'})`);
  }

  configure({ prompt, maxRounds, port, browserPath, site } = {}) {
    if (site && String(site) !== this.siteId && SITES[String(site)]) {
      // 切换站点：连同登录态/轮次一起重置（页面目标变了，旧 WebSocket 作废）
      this.siteId = String(site);
      this.site = getSite(this.siteId);
      this._ws?.close?.();
      this._ws = null;
      this._wsUrl = '';
      this.roundCount = 0;
      this._promptSent = false;
      this._set('idle', `已切换到「${this.site.name}」`);
    }
    if (port && Number(port) !== this.port) {
      this.port = Number(port);
      this._ws?.close?.();
      this._ws = null;
      this._wsUrl = '';
    }
    if (browserPath !== undefined && browserPath !== null && browserPath !== this.browserPath) {
      const next = String(browserPath).trim();
      this.browserPath = next || EDGE_CANDIDATES.find((p) => p && fs.existsSync(p)) || '';
    }
    const nextPrompt = String(prompt ?? this.prompt ?? '');
    if (nextPrompt !== this.prompt) {
      this.prompt = nextPrompt;
      this._promptSent = false;   // 提示词变了，下一轮对话重新发送
    }
    if (maxRounds) this.maxRounds = Number(maxRounds) || 50;
    this.onStatus(this.status());
  }

  _set(state, message) {
    this.state = state;
    this.message = message || state;
    if (state === 'thinking') this._thinkingSince = Date.now();
    this.onStatus(this.status());
  }

  /* ---------------- 浏览器 / 页面 ---------------- */

  async _httpJson(pathname) {
    const resp = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      signal: AbortSignal.timeout(3000)
    });
    return resp.json();
  }

  async isCdpAlive() {
    try {
      await this._httpJson('/json/version');
      return true;
    } catch {
      return false;
    }
  }

  /** 启动浏览器（如果 CDP 还没起来） */
  async ensureBrowser() {
    if (await this.isCdpAlive()) return true;
    if (!this.supported) {
      this._set('error', IS_ANDROID
        ? '安卓版不支持网页版 DeepSeek（系统里没有带 CDP 的浏览器），请改用 API 模式'
        : '当前系统不支持网页版模式，请改用 API 模式');
      return false;
    }
    if (this.embedded) {
      // 宿主启动 Node 服务后才创建 WebView2，存在几秒空窗期。
      // 这里必须等宿主 CDP，不能回退启动外部 Edge；否则会跳出网页版 DeepSeek，
      // 而且外部 Edge 和 WebView2 是两份登录态，内嵌页面反而会变成未登录。
      this._set('launching', '正在等待内嵌 DeepSeek 页面…');
      for (let i = 0; i < 50; i++) {
        await sleep(400);
        if (await this.isCdpAlive()) {
          this._set('idle', '内嵌页面已就绪');
          return true;
        }
      }
      this._set('error', '内嵌 DeepSeek 页面未就绪，请重新打开群崽');
      return false;
    }
    if (!this.browserPath || !fs.existsSync(this.browserPath)) {
      this._set('error', IS_WIN
        ? '未找到 Edge/Chrome 可执行文件，请在设置里指定浏览器路径'
        : '未找到 Edge/Chrome/Chromium 可执行文件，请在设置里指定浏览器路径');
      return false;
    }
    this._set('launching', '正在启动浏览器…');
    fs.mkdirSync(this.profileDir, { recursive: true });
    const child = spawn(this.browserPath, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      this.site.url
    ], { detached: true, stdio: 'ignore' });
    child.unref();

    for (let i = 0; i < 25; i++) {
      await sleep(800);
      if (await this.isCdpAlive()) {
        this._set('idle', '浏览器已启动');
        return true;
      }
    }
    this._set('error', `浏览器启动了，但 ${this.port} 端口没起来（可能被占用或被安全软件拦截）`);
    return false;
  }

  /** 找到当前站点（chat.deepseek.com / qianwen.com / kimi.com / aistudio.xiaomimimo.com）的页面目标 */
  async findPage() {
    const host = (() => { try { return new URL(this.site.url).host; } catch { return ''; } })();
    const rx = host ? new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null;
    const targets = await this._httpJson('/json');
    const pages = (targets || []).filter(
      (t) => t.type === 'page' && (rx ? rx.test(t.url || '') : true)
    );
    return pages[0] || null;
  }

  /** 建立（或复用）页面 WebSocket */
  async ensureTarget() {
    if (this._ws && this._ws.readyState === 1 && this._wsUrl) {
      const ok = await this._evaluate('1+1');
      if (ok !== null) {
        // 页面可能在内嵌窗口里从“扫码登录”切到已登录；
        // 每次都重新探一次状态，避免登录成功后还一直卡在 need-login。
        const liveState = await this._probeState();
        if (liveState === 'ready') return true;
        if (liveState === 'need-login') {
          this._set('need-login', this.embedded
            ? `请在内嵌 DeepSeek 页面扫码登录「${this.site.short}」（登录一次会记住）`
            : `请在弹出的浏览器窗口里登录「${this.site.short}」${this.site.images ? '（登录态会记住）' : ''}`);
          return false;
        }
      }
      try { this._ws.close(); } catch { /* noop */ }
      this._ws = null;
    }
    if (!(await this.ensureBrowser())) return false;

    let page = null;
    for (let i = 0; i < 15; i++) {
      try { page = await this.findPage(); } catch { page = null; }
      if (page && page.webSocketDebuggerUrl) break;
      page = null;
      // 自愈：切站点后页面没开就自己开。内嵌模式不能新开 target，
      // 否则 WebView2 会再弹一个 DeepSeek 窗口；等宿主把页面建好即可。
      if (i === 2 && !this.embedded) await this._newTab(this.site.url);
      await sleep(1000);
    }
    if (!page) {
      this._set('error', `找不到「${this.site.name}」页面（${this.site.url}），点“打开网站”自动打开`);
      return false;
    }

    await this._connect(page.webSocketDebuggerUrl);
    const state = await this._probeState();
    if (state === 'need-login') {
      this._set('need-login', this.embedded
        ? `请在内嵌 DeepSeek 页面扫码登录「${this.site.short}」（登录一次会记住）`
        : `请在弹出的浏览器窗口里登录「${this.site.short}」${this.site.images ? '（登录态会记住）' : ''}`);
      return false;
    }
    if (state !== 'ready') {
      this._set('idle', `${this.site.name} 页面正在加载，请稍后再试`);
      return false;
    }
    this._set('ready', `${this.site.name} 已就绪`);
    return true;
  }

  _connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const fail = (e) => reject(new Error('CDP WebSocket 连接失败: ' + (e?.message || 'unknown')));
      ws.addEventListener('open', () => {
        this._ws = ws;
        this._wsUrl = wsUrl;
        ws.addEventListener('message', (ev) => {
          let msg;
          try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
          catch { return; }
          if (msg.id && this._pending.has(msg.id)) {
            const { resolve: rs, reject: rj, timer } = this._pending.get(msg.id);
            clearTimeout(timer);
            this._pending.delete(msg.id);
            if (msg.error) rj(new Error(msg.error.message || 'CDP error'));
            else rs(msg.result);
          }
        });
        resolve();
      });
      ws.addEventListener('error', fail);
      ws.addEventListener('close', () => { this._ws = null; this._wsUrl = ''; });
      setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 8000);
    });
  }

  /** 调用 CDP */
  cdp(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== 1) {
        return reject(new Error('CDP 未连接'));
      }
      const id = ++this._msgId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(method + ' 超时'));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async _evaluate(expression, timeoutMs = 15000) {
    try {
      const res = await this.cdp('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      }, timeoutMs);
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || '页面脚本异常');
      }
      return res.result?.value ?? null;
    } catch (err) {
      throw err;
    }
  }

  /** 看图回复：把本地图片上传到当前对话（隐藏的 input[type=file] + CDP 原生塞文件） */
  async _uploadImages(paths) {
    if (!this.site.images) throw new Error(`${this.site.short} 暂不支持看图（只有 DeepSeek 档案支持）`);
    const doc = await this.cdp('DOM.getDocument', { depth: -1 }, 15000);
    const q = await this.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' }, 15000);
    if (!q || !q.nodeId) throw new Error('页面里找不到图片上传口');
    await this.cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files: paths }, 20000);
    // 给上传留时间（等缩略图就位）
    await sleep(1200 * paths.length + 1500);
  }

  /** 防抽风看门狗：思考状态卡死超过 4 分钟 → 强制复位，下条消息自动重试 */
  watchdog() {
    if (this.state === 'thinking' && this._thinkingSince && Date.now() - this._thinkingSince > 4 * 60 * 1000) {
      try { this._ws?.close?.(); } catch { /* noop */ }
      this._ws = null;
      this._wsUrl = '';
      this._busy = false;
      this._set('error', '长时间无响应，已自动复位（下条消息会重试）');
      return true;
    }
    return false;
  }

  /** 判断页面状态：已登录 / 需要登录 / 未知 */
  async _probeState() {
    const state = await this._evaluate(`(() => {
      const hasInput = !!document.querySelector(${JSON.stringify(this.site.input)});
      const qr = ${JSON.stringify(this.site.loginSelectors || [])}.some((s) => document.querySelector(s))
        || !!document.querySelector('iframe[src*="qrconnect"], iframe[src*="login"]');
      const loginText = new RegExp(${JSON.stringify(this.site.loginWords || '登录|扫码')}).test(document.body ? document.body.innerText.slice(0, 500) : '');
      if (hasInput) return 'ready';
      if (qr || loginText) return 'need-login';
      return 'unknown';
    })()`, 10000).catch(() => 'unknown');
    return state === 'ready' ? 'ready' : state === 'need-login' ? 'need-login' : 'unknown';
  }

  /* ---------------- 对话 ---------------- */

  /**
   * 发送一条消息给 DeepSeek 网页版并取回回答
   * - 提示词由用户在网页端填写；每个 DeepSeek 对话只在开头发一次
   * - 对话轮数达到上限（默认 50）时，自动新建对话并重新发送提示词
   */
  async ask(text, { timeoutMs = 180000, images = null } = {}) {
    if (this._busy) throw new Error(`${this.site.short} 正在生成上一条回复`);
    this._busy = true;
    try {
      if (!(await this.ensureTarget())) {
        throw new Error(this.message || `${this.site.short} 未就绪`);
      }

      // 新建对话后的提示词可能还在后台发送；等它结束，避免和用户消息抢输入框。
      if (this._promptTask) {
        try { await this._promptTask; } catch { /* 失败时下面会重试 */ }
      }

      // 轮次用尽 → 新建对话，并把提示词重新发一遍
      if (this.roundCount >= this.maxRounds) {
        this._set('thinking', `已达 ${this.maxRounds} 轮，正在新建对话…`);
        await this.newConversation();
        // newConversation 会把提示词放到后台；这里等它，避免下面再发一遍。
        if (this._promptTask) {
          try { await this._promptTask; } catch { }
        }
      }
      // 本轮对话尚未发送过提示词 → 先发提示词
      if (!this._promptSent && String(this.prompt || '').trim()) {
        this._set('thinking', '正在发送提示词…');
        await this._sendAndWait(String(this.prompt).trim(), false);
        this._promptSent = true;
        this.roundCount++;
        this._logPromptSent('ask 补发');
      }

      // 看图只有 DeepSeek 档案支持上传；其他站点先只走文字
      const useImages = this.site.images && Array.isArray(images) ? images : null;
      const reply = await this._sendAndWait(text, true, timeoutMs, useImages);
      this.roundCount++;
      return reply;
    } catch (err) {
      // 失败时把状态从"思考中"切到错误，避免界面卡在发送提示词
      this._set('error', err.message);
      throw err;
    } finally {
      this._busy = false;
    }
  }

  /**
   * 轮询等待输入框出现（页面刚加载/刷新后 React 可能还没挂载完）
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} 是否等到
   */
  async _waitForInput(timeoutMs = 12000) {
    const sel = JSON.stringify(this.site.input);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const has = await this._evaluate(`!!document.querySelector(${sel})`, 5000).catch(() => false);
      if (has) return true;
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  }

  /**
   * 填入并发送，然后等回答稳定
   * @param {string} text
   * @param {boolean} capture true=返回回答；false=只等它跑完（用于发提示词）
   */
  async _sendAndWait(text, capture, timeoutMs = 180000, images = null) {
    const before = capture ? await this._evalLastAnswer() : '';
    // 看图回复：先上传图片（CDP DOM.setFileInputFiles 直接塞本地文件），再输入文字发送
    if (Array.isArray(images) && images.length) {
      this._set('thinking', '正在上传图片…');
      await this._uploadImages(images);
    }

    // 等输入框就位：刚打开/刷新页面时 React 还没挂载完，立刻找 selector 会扑空（no-input），
    // 这里最多等 12 秒再放弃
    await this._waitForInput(12000);

    // 先清空输入框：上一次操作失败留下的残字会让下面「填进去没有」和
    // 「发出去有没有清空」两个判据同时失真（表现为偶发的“消息没能发出去”）
    await this._clearInput();

    // 填入：先聚焦+全选，再 CDP 原生输入（React 受控组件下 Input.insertText 稳定生效，
    // 旧的 value setter 方案会被重渲染吃掉）
    const IN = JSON.stringify(this.site.input);
    const VAL = this.site.editable ? 'el.textContent' : 'el.value';
    await this._evaluate(`(() => {
      const el = document.querySelector(${IN});
      if (!el) return false;
      el.focus();
      if (el.select) el.select();
      else {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
      return true;
    })()`, 8000).catch(() => false);
    await this.cdp('Input.insertText', { text: String(text) }).catch(() => null);
    let filled = await this._evaluate(`(() => {
      const el = document.querySelector(${IN});
      const v = el && (${VAL});
      return (v && String(v).trim()) ? { ok: true } : null;
    })()`, 8000).catch(() => null);
    // 兜底：万一原生输入不可用（React 受控 / contenteditable），退回 setter 或 execCommand
    if (!filled || !filled.ok) {
      filled = await this._evaluate(`(() => {
        const el = document.querySelector(${IN});
        if (!el) return { ok: false, reason: 'no-input' };
        el.focus();
        ${this.site.editable
          ? "document.execCommand('selectAll'); document.execCommand('insertText', false, " + JSON.stringify(text) + ");"
          : "const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;"
            + " if (setter) setter.call(el, " + JSON.stringify(text) + "); else el.value = " + JSON.stringify(text) + ";"
            + " el.dispatchEvent(new Event('input', { bubbles: true }));"}
        const v = (${VAL});
        return { ok: !!(v && String(v).trim()) };
      })()`);
    }

    if (!filled || !filled.ok) {
      const st = await this._probeState();
      if (st === 'need-login') this._set('need-login', this.embedded
      ? `请在内嵌 DeepSeek 页面扫码登录「${this.site.short}」`
      : `请在浏览器窗口登录「${this.site.short}」`);
      throw new Error('页面里找不到输入框' + (filled?.reason ? `（${filled.reason}）` : ''));
    }

    // 发送（点按钮 → JS 合成回车 → CDP 原生回车），以输入框是否清空为成功判据
    if (!(await this._sendMessage())) {
      // React 有时要等一两秒才把受控输入框清空，立刻判死会误报。
      // 再等一会儿复查一次——只复查，不重发：重发会造成同一条消息发两遍。
      await sleep(1500);
      if (!(await this._inputCleared())) {
        throw new Error(`消息没能发出去：输入框内容没有被清空（${this.site.short} 页面可能弹了提示或要求登录）`);
      }
    }

    const deadline = Date.now() + timeoutMs;
    let stableCount = 0;
    let lastText = '';
    const sentAt = Date.now();
    // 刚发出的原文：DeepSeek 新版会把“带图的用户消息”也用 .ds-markdown 渲染，
    // 最后一块可能就是我们自己刚发的话 —— 必须排除，否则会把原话当回答发回去（输出不一致 bug）
    const sentEcho = String(text).trim();
    while (Date.now() < deadline) {
      await sleep(1200);
      const snap = await this._answerSnapshot();
      if (!snap) continue;
      const cur = (snap.text || '').trim();
      if (cur && cur !== before && cur !== sentEcho) {
        if (cur === lastText) {
          stableCount++;
          if (!snap.generating && stableCount >= 3 && Date.now() - sentAt > 6000) {
            this._set('ready', `${this.site.name} 已就绪`);
            return capture ? cleanAnswer(cur) : '';
          }
        } else {
          stableCount = 0;
          lastText = cur;
        }
      }
    }
    this._set('ready', `${this.site.name} 已就绪`);
    if (!capture) return '';
    if (lastText) return cleanAnswer(lastText);
    throw new Error(`等待 ${this.site.short} 回复超时`);
  }

  /** 输入框是否已清空（= 消息已发出）；元素不在时返回 null（无法判断，多半是页面正在切换） */
  async _inputCleared() {
    const IN = JSON.stringify(this.site.input);
    const VAL = this.site.editable ? 'el.textContent' : 'el.value';
    const r = await this._evaluate(
      `(() => { const el = document.querySelector(${IN}); if (!el) return null; const v = ${VAL}; return !v || !String(v).trim(); })()`,
      8000
    ).catch(() => null);
    if (r === null || r === undefined) return null;
    return !!r;
  }

  /**
   * 清空输入框。
   * 上一次发送失败时，残留在输入框里的旧文字会让后续判断全部失准：
   * 填新内容时可能变成「旧文字+新文字」，发送后又因为没清空而被判失败。
   */
  async _clearInput() {
    const IN = JSON.stringify(this.site.input);
    const focused = await this._evaluate(`(() => {
      const el = document.querySelector(${IN});
      if (!el) return false;
      el.focus();
      if (el.select) el.select();
      else {
        const r = document.createRange();
        r.selectNodeContents(el);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
      return true;
    })()`, 8000).catch(() => false);
    if (!focused) return false;
    // 删掉选中内容：CDP 原生按键最稳（execCommand 在 React 受控组件上会被重渲染吃掉）
    for (const type of ['keyDown', 'keyUp']) {
      await this.cdp('Input.dispatchKeyEvent', {
        type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
      }, 8000).catch(() => {});
    }
    return true;
  }

  /** 多策略发送：点发送按钮 → JS 合成回车 → CDP 原生回车 */
  async _sendMessage() {
    // a) 点发送按钮（从输入框向上找，避免依赖会变的哈希类名；选择器来自站点档案）
    const clicked = await this._evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(this.site.input)});
      if (!el) return '';
      const sels = ${JSON.stringify(this.site.send || [])};
      let node = el;
      for (let i = 0; i < 8 && node; i++) {
        for (const s of sels) {
          const btn = node.querySelector && node.querySelector(s);
          if (btn) { btn.click(); return s + '@' + i; }
        }
        node = node.parentElement;
      }
      return '';
    })()`, 10000).catch(() => '');
    if (clicked) {
      await sleep(900);
      if (await this._inputCleared()) return true;
    }

    // b) JS 合成 Enter（React 能收到）
    await this._evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(this.site.input)});
      if (!el) return;
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    })()`, 10000).catch(() => null);
    await sleep(900);
    if (await this._inputCleared()) return true;

    // c) CDP 原生按键
    for (const type of ['keyDown', 'char', 'keyUp']) {
      await this.cdp('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: type === 'char' ? '\r' : undefined
      }, 8000).catch(() => {});
    }
    await sleep(1000);
    const cleared = await this._inputCleared();
    return cleared !== false;   // null = 输入框不在了（页面在切换），按已发出处理
  }

  async _answerSnapshot() {
    return this._evaluate(`(() => {
      // 各站点回答块类名不同：按档案里的选择器依次尝试，取第一组有命中的
      const sels = ${JSON.stringify(this.site.answer || [])};
      let blocks = [];
      for (const s of sels) {
        const got = [...document.querySelectorAll(s)];
        if (got.length) { blocks = got; break; }
      }
      const last = blocks[blocks.length - 1];
      const stop = ${JSON.stringify(this.site.generating || [])}.some((s) => document.querySelector(s));
      return { count: blocks.length, text: last ? last.innerText : '', generating: stop };
    })()`, 10000).catch(() => null);
  }

  async _evalLastAnswer() {
    const snap = await this._answerSnapshot();
    return snap ? (snap.text || '').trim() : '';
  }

  /** 等页面切到新对话：URL 变了，或停在首页（新对话页） */
  async _waitForNewChat(before, tries = 12) {
    for (let i = 0; i < tries; i++) {
      await sleep(800);
      const st = await this._evaluate(`(() => ({
        url: location.href,
        hasTa: !!document.querySelector(${JSON.stringify(this.site.input)})
      }))()`, 8000).catch(() => null);
      const mark = this.site.chatUrlMark || '';
      if (st && st.hasTa && (st.url !== before || !st.url.includes(mark))) return true;
    }
    return false;
  }

  /** 新建一个对话（清空上下文；下次发送时会重发提示词） */
  async newConversation() {
    if (!(await this.ensureTarget())) return false;
    const before = await this._evaluate('location.href').catch(() => '');
    // 优先点站点的“新建/开启新对话”：取文字最短的可见节点，避免命中包住整个侧栏的外层容器。
    // 内嵌宿主里 DeepSeek 页可能处于隐藏标签页，布局为 0，此时直接走导航兜底。
    const clicked = await this._evaluate(`(() => {
      const texts = ${JSON.stringify(this.site.newChat || [])};
      const all = [...document.querySelectorAll('span,div,button,a')];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const matches = all.filter((el) => {
        const t = (el.innerText || '').trim();
        return texts.includes(t) || texts.some((x) => x && t.startsWith(x));
      }).sort((a, b) => (a.innerText || '').trim().length - (b.innerText || '').trim().length);
      const node = matches.find(visible);
      if (!node) return false;
      const target = node.closest('div[role="button"], button, a, [tabindex="0"]') || node.parentElement || node;
      target.click();
      return true;
    })()`, 10000).catch(() => false);
    let ready = false;
    if (clicked) ready = await this._waitForNewChat(before, 6);
    // 没有按钮、按钮命中不可靠或页面在隐藏标签页里：直接回首页（首页就是新对话）
    if (!ready) {
      if (!this.site.navigateFallback) {
        this.onStatus(this.status());
        return false;
      }
      await this.cdp('Page.navigate', { url: this.site.url }, 15000).catch(() => null);
      ready = await this._waitForNewChat(before, 12);
    }
    this.roundCount = 0;
    this._promptSent = false;
    // 新建完自动发送提示词，但不在 HTTP 请求里等模型回答：
    // 提示词发送可能要十几秒，等完会让“新建对话”按钮看起来像卡死。
    const promptText = String(this.prompt || '').trim();
    if (ready && promptText) {
      this._set('ready', '新对话已就绪，提示词正在后台发送');
      this._promptTask = (async () => {
        try {
          this._set('thinking', '正在发送提示词…');
          await this._sendAndWait(promptText, false);
          this._promptSent = true;
          this.roundCount++;
          this._logPromptSent('新建对话');
          this._set('ready', '提示词已自动发送，对话就绪');
        } catch (err) {
          // 发送失败不阻塞“新建”本身；下条消息触发时 ask 会自动补发
          this._promptSent = false;
          this._set('ready', '新对话已就绪（提示词将在下条消息时自动补发）');
        } finally {
          this._promptTask = null;
          this.onStatus(this.status());
        }
      })();
    }
    this.onStatus(this.status());
    return ready;
  }

  /**
   * 打开一个新标签页并导航到站点。
   * 注意：/json/new 的 url 查询参数不能编码（Chromium 只收原样 URL，编码了会开出 about:blank），
   * 所以这里先建空白页，再直连它用 Page.navigate 导航。
   */
  async _newTab(url) {
    // 内嵌模式的新 target 会在 WebView2 里再弹一个窗口，直接禁用。
    if (this.embedded) return false;
    for (const method of ['PUT', 'GET']) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method });
        if (!resp.ok) continue;
        const target = await resp.json();
        if (!target || !target.webSocketDebuggerUrl) continue;
        await this._connect(target.webSocketDebuggerUrl);
        await this.cdp('Page.enable', {}, 8000).catch(() => null);
        await this.cdp('Page.navigate', { url: String(url) }, 20000).catch(() => null);
        this._ws = null;          // 交回调用方按 host 重新连接，避免残留
        this._wsUrl = '';
        await sleep(1200);        // 等导航起效
        return true;
      } catch { /* 换下一种方式 */ }
    }
    return false;
  }

  /** 手动打开页面（双击快捷方式后可用）：已有就复用，没有就新开标签页 */
  async openPage() {
    if (!(await this.ensureBrowser())) return false;
    for (let i = 0; i < 8; i++) {
      const page = await this.findPage().catch(() => null);
      if (page) return true;
      if (i === 0 && !this.embedded) await this._newTab(this.site.url);   // 非内嵌模式才允许自己开页
      await sleep(800);
    }
    return false;
  }

  async close() {
    try { this._ws?.close(); } catch { /* noop */ }
    this._ws = null;
    this._wsUrl = '';
  }
}

/** 清理模型输出里多余的花纹 */
function cleanAnswer(text) {
  let t = String(text).trim();
  // 去掉模型常见的开场白
  t = t.replace(/^(好的|当然|没问题)[，,：:。!\s]*/u, '');
  t = t.replace(/^(作为|作为你的)[^\n]{0,20}[，,：:]\s*/u, '');
  // 去掉包裹的引号
  if (/^["“].*["”]$/.test(t) && t.length > 2) t = t.slice(1, -1).trim();
  return t;
}

module.exports = { DeepSeekWeb, PAGE_URL, cleanAnswer, siteList, SITES };