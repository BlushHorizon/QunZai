'use strict';
/**
 * 群崽 QunZai · 监控台前端
 * ---------------------------------------------------------------------------
 * 深色监控面板：状态卡 + 会话概览 + 实时动态（SSE）。
 * 不再提供聊天窗口/输入框——收发全部由 AI 自动完成，这里负责"看得见"。
 */

const $ = (id) => document.getElementById(id);
const THEME_KEY = 'qunzai.theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** 让桌面宿主切到内嵌 DeepSeek 页；普通浏览器打开时忽略 */
function showDeepSeekTab() {
  try {
    if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
      window.chrome.webview.postMessage({ type: 'deepseek' });
    }
  } catch (e) { /* 非桌面宿主忽略 */ }
}

/* ---------------- DeepSeek 内嵌到实时动态右半边 ---------------- */
const IN_DESKTOP_HOST = !!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage);
if (IN_DESKTOP_HOST) document.documentElement.classList.add('qz-host');

let dsSlotSyncPending = false;

/* 打开设置时缓存的服务端配置：有些值面板上没有控件（阈值、候选类型、忽略窗口），
   保存时得沿用现值，不能凭空填。 */
let settingsCache = {};
/** 配置页是常驻的，只在第一次进入时从服务端拉一次，之后用户自己点保存 */
let settingsLoaded = false;
/** 用户动过配置页里的控件但还没保存。为 true 时不能被后台刷新覆盖掉正在编辑的内容。 */
let settingsDirty = false;

function dsSlotBlocked() {
  const qd = $('qzDialog');
  return !!(qd && !qd.classList.contains('hidden'));
}

/** 把 DeepSeek 占位区的实际位置发给桌面宿主，由宿主把内嵌 WebView2 盖上去 */
function syncDeepSeekSlot() {
  if (!IN_DESKTOP_HOST) return;
  const slot = $('dsSlot');
  if (!slot) return;
  dsSlotSyncPending = false;
  const r = slot.getBoundingClientRect();
  const visible = !dsSlotBlocked() &&
    r.bottom > 0 && r.top < window.innerHeight &&
    r.right > 0 && r.left < window.innerWidth;
  try {
    window.chrome.webview.postMessage({
      type: 'deepseek-bounds',
      // 留 6px 内边距，让卡片边框和圆角露出来
      x: Math.round(r.left) + 6,
      y: Math.round(r.top) + 6,
      width: Math.max(1, Math.round(r.width) - 12),
      height: Math.max(1, Math.round(r.height) - 12),
      visible
    });
  } catch (e) { /* 非桌面宿主忽略 */ }
}

function scheduleDeepSeekSlotSync() {
  if (!IN_DESKTOP_HOST || dsSlotSyncPending) return;
  dsSlotSyncPending = true;
  if (window.requestAnimationFrame) requestAnimationFrame(syncDeepSeekSlot);
  else setTimeout(syncDeepSeekSlot, 16);
}
window.qzSyncDeepSeek = syncDeepSeekSlot;

function initDeepSeekSlot() {
  const slot = $('dsSlot');
  if (!slot) return;
  window.addEventListener('resize', scheduleDeepSeekSlotSync, { passive: true });
  window.addEventListener('scroll', scheduleDeepSeekSlotSync, { passive: true });
  document.addEventListener('scroll', scheduleDeepSeekSlotSync, true);
  if (window.ResizeObserver) {
    try { new ResizeObserver(scheduleDeepSeekSlotSync).observe(slot); } catch (e) { /* 忽略 */ }
  }
  const mo = new MutationObserver(scheduleDeepSeekSlotSync);
  ['qzDialog'].forEach((id) => {
    const el = $(id);
    if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  scheduleDeepSeekSlotSync();
}

/* ---------------- 页面内提示框（替代原生 alert/confirm） ---------------- */
let qzDialogActive = null;
const qzDialogQueue = [];

function uiAlert(message, opts = {}) {
  return showQzDialog({ ...opts, message, showCancel: false });
}

function uiConfirm(message, opts = {}) {
  return showQzDialog({ ...opts, message, showCancel: true });
}

function showQzDialog(opts = {}) {
  return new Promise((resolve) => {
    qzDialogQueue.push({ opts, resolve });
    if (!qzDialogActive) drainQzDialog();
  });
}

function drainQzDialog() {
  if (qzDialogActive || !qzDialogQueue.length) return;
  const item = qzDialogQueue.shift();
  qzDialogActive = item;
  const opts = item.opts;
  const type = opts.type || 'info';
  const icon = { info: 'i', ok: '✓', warn: '!', err: '×' }[type] || 'i';
  const iconEl = $('qzDialogIcon');
  iconEl.textContent = icon;
  iconEl.className = 'qz-dialog-icon ' + type;
  $('qzDialogTitle').textContent = opts.title || '提示';
  $('qzDialogBody').textContent = String(opts.message || '');
  $('qzDialogOk').textContent = opts.okText || '确定';
  $('qzDialogCancel').textContent = opts.cancelText || '取消';
  $('qzDialogCancel').classList.toggle('hidden', !opts.showCancel);
  $('qzDialog').classList.remove('hidden');
  // 如果窗口已最小化到托盘，让宿主先把窗口拉回来
  try {
    if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
      window.chrome.webview.postMessage({ type: 'modal' });
    }
  } catch (e) { /* 非桌面宿主忽略 */ }
  setTimeout(() => { try { $('qzDialogOk').focus(); } catch (e) { /* 忽略 */ } }, 30);
}

function finishQzDialog(result) {
  if (!qzDialogActive) return;
  const item = qzDialogActive;
  qzDialogActive = null;
  $('qzDialog').classList.add('hidden');
  item.resolve(!!result);
  setTimeout(drainQzDialog, 0);
}

function initQzDialog() {
  $('qzDialogOk').addEventListener('click', () => finishQzDialog(true));
  $('qzDialogCancel').addEventListener('click', () => finishQzDialog(false));
  $('qzDialogX').addEventListener('click', () => {
    finishQzDialog(!(qzDialogActive && qzDialogActive.opts.showCancel));
  });
  $('qzDialog').addEventListener('click', (e) => {
    if (e.target !== $('qzDialog')) return;
    finishQzDialog(!(qzDialogActive && qzDialogActive.opts.showCancel));
  });
  document.addEventListener('keydown', (e) => {
    if (!qzDialogActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      finishQzDialog(false);
    } else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      finishQzDialog(true);
    }
  });
}

function applyTheme(theme, persist) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  const btn = $('btnTheme');
  if (btn) {
    btn.textContent = next === 'light' ? '☀' : '☾';
    btn.title = next === 'light' ? '切换深色主题' : '切换浅色主题';
  }
  if (persist) {
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 隐私模式忽略 */ }
  }
  try {
    if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
      window.chrome.webview.postMessage({ type: 'theme', theme: next });
    }
  } catch (e) { /* 非桌面宿主忽略 */ }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 忽略 */ }
  applyTheme(saved === 'light' ? 'light' : 'dark', false);
  const btn = $('btnTheme');
  if (btn) {
    btn.addEventListener('click', () => {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
    });
  }
}

const state = {
  status: { qq: {}, ai: {} },
  version: '',
  chats: [],
  feed: [],
  self: null,
  platform: null,
  stats: { inMsgs: 0, aiReplies: 0, skips: 0 },
  /** 随包内置那份运行时的真实目录，由 /api/engine/status 的 bundledDir 带回来 */
  bundledEngineDir: ''
};
/** 用户自己填过的 QQ 桥接目录，切到「内置」再切回来时还原 */
let lastCustomEngineDir = '';

/* ---------------- 工具 ---------------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function initial(name) {
  return String(name || '?').trim().charAt(0) || '?';
}

async function api(path, options) {
  const resp = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  try { data = await resp.json(); } catch { /* 非 JSON 错误页 */ }
  if (!resp.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

function chatLabel(chatId) {
  const c = state.chats.find((x) => x.id === chatId);
  return c ? c.name : chatId;
}

/* ---------------- 状态卡 ---------------- */
function renderStatus() {
  if (state.version) {
    const label = 'v' + state.version;
    if ($('appVersion')) $('appVersion').textContent = label;
    if ($('aboutVersion')) $('aboutVersion').textContent = label;
    if ($('appVersionSide')) $('appVersionSide').textContent = label;
  }
  const qq = state.status.qq || {};
  const pill = $('qqStatusPill');
  pill.classList.toggle('on', !!qq.connected);
  pill.classList.toggle('off', !qq.connected);
  $('qqStatusText').textContent = qq.message || (qq.connected ? '已连接' : '未连接');

  const self = state.self || {};
  // 「连上 OneBot 服务」和「QQ 真的登录了」是两件事：NapCat 没扫码时 WS 也是通的。
  // needLogin 由后端在「ws 通了但 get_login_info 拿不到账号」时置位，这里必须单独显示，
  // 否则会顶着绿灯说「已连接 OneBot」，用户发消息却石沉大海。
  $('cardQqMain').textContent = qq.connected ? '已连接' : (qq.needLogin ? 'QQ 未登录' : '未连接');
  $('cardQqMain').className = 'card-main ' + (qq.connected ? 'ok' : (qq.needLogin ? 'dim' : 'bad'));
  $('cardQqSub').textContent = self.nickname
    ? `账号 ${self.nickname} (${self.userId})`
    : (qq.connected ? '已连接 OneBot' : (qq.needLogin ? '服务通了，等你扫码登录 QQ' : '等待接入…'));

  const ai = state.status.ai || {};
  $('aiToggle').checked = !!ai.enabled;
  const label = document.querySelector('.ai-label');
  if (label) label.textContent = ai.enabled ? 'AI 自动回复' : 'AI 自动回复（关）';

  $('cardAiMain').textContent = ai.enabled ? '运行中' : '已停用';
  $('cardAiMain').className = 'card-main ' + (ai.enabled ? 'ok' : 'dim');
  const scopeText = ai.replyMode === 'target'
    ? (Array.isArray(ai.targetChatKeys) && ai.targetChatKeys.length
        ? (ai.targetChatKeys.length > 1 ? `只回 ${ai.targetChatKeys.length} 个会话` : `只回 ${ai.targetChatKeys[0]}`)
        : '只回 （未选会话）')
    : (ai.scope === 'private' ? '仅私聊' : '私聊+群聊');
  const chanceNote = Number.isFinite(Number(ai.groupReplyChance)) && Number(ai.groupReplyChance) < 100
    ? ` · 群回${ai.groupReplyChance}%` : '';
  const quietNote = ai.quietNow ? ' · 免打扰中' : '';
  $('cardAiSub').textContent = `${ai.providerLabel || ai.provider || '—'} · ${scopeText}${chanceNote}${quietNote}`;

  const ds = ai.deepseek || {};
  if (ai.provider === 'deepseek-web') {
    if ($('cardDsTitle')) $('cardDsTitle').textContent = 'DeepSeek 网页版';
    const map = {
      'need-login': ['bad', '待登录'],
      'ready': ['ok', '就绪'],
      'thinking': ['warn', '思考中'],
      'launching': ['warn', '启动中'],
      'error': ['bad', '异常']
    };
    const [cls, text] = map[ds.state] || ['dim', ds.state || '未连接'];
    $('cardDsMain').textContent = text;
    $('cardDsMain').className = 'card-main ' + cls;
    const rounds = typeof ds.roundCount === 'number' ? `轮次 ${ds.roundCount}/${ds.maxRounds}` : '';
    const prompt = `提示词${ds.promptSet ? (ds.promptSent ? '已发送' : '待发送') : '未设置'}`;
    $('cardDsSub').textContent = [rounds, prompt].filter(Boolean).join(' · ') || '—';
  } else {
    if ($('cardDsTitle')) $('cardDsTitle').textContent = ai.model && ai.model !== '内置规则引擎' ? 'DeepSeek API' : '内置规则引擎';
    $('cardDsMain').textContent = '运行中';
    $('cardDsMain').className = 'card-main ok';
    $('cardDsSub').textContent = 'API 模式' + (ai.model && ai.model !== '内置规则引擎' ? `（${ai.model}）` : '');
  }
  // 卡片按钮组随大脑切换：网页版 → 登录/新建对话；API → 测速/可用性/余额
  if ($('dsWebBtns')) $('dsWebBtns').hidden = ai.provider !== 'deepseek-web';
  if ($('dsApiBtns')) $('dsApiBtns').hidden = ai.provider === 'deepseek-web';

  renderStats();
  // 新外壳：欢迎页三步状态 + 卡片开关状态都跟着每次状态刷新走
  renderWelcome();
  renderShellToggles();
}

function renderStats() {
  $('cardStatMain').textContent = `${state.stats.inMsgs} 收 / ${state.stats.aiReplies} 回`;
  $('cardStatSub').textContent = `会话 ${state.chats.length} · 跳过 ${state.stats.skips}`;
}


/* ---------------- 主视图切换（左侧分类导航） ---------------- */
/** 切到某个主视图：welcome / bots / models / chats / activity */
function switchView(key) {
  const views = document.querySelectorAll('.views .view');
  const target = document.querySelector('.view[data-view="' + key + '"]');
  // 视图不存在，或被平台隐藏了（安卓没有 QQ 桥接/自动更新）：
  // 切过去只会看到一片空白，原地不动。
  if (!target || target.hidden) return;
  views.forEach((v) => {
    v.classList.toggle('active', v.dataset.view === key);
  });
  document.querySelectorAll('.sidebar .nav-item[data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === key);
  });
  const box = $('views');
  if (box) box.scrollTop = 0;
  // 进入配置页时刷一次服务端配置：卡片开关、顶栏开关都会改库，
  // 常驻表单不刷新的话，用户下次在配置页点「保存」会把刚改的值覆盖回旧值。
  // 有未保存的编辑时不动，免得把用户正在填的内容冲掉。
  if (!key.startsWith('cfg-')) {
    // 离开全部配置页 = 放弃未保存的编辑。不重置的话脏标记会永久粘住，
    // 之后配置页再也不会从服务端刷新，覆盖回滚的 bug 就回来了。
    settingsDirty = false;
  } else if (settingsLoaded && !settingsDirty) {
    loadSettings().catch(() => {});
  }
  // 表情包素材/在线图库是两块重活（各一次网络 + 几十张图重渲染），
  // 只在真的进这一页时刷，不跟着每次配置页刷新一起跑。
  if (key === 'cfg-stickers') {
    refreshStickers().catch(() => {});
    refreshGallery().catch(() => {});
  }
  // 切视图会改变 #dsSlot 的位置/可见性，必须让宿主重新盖一次内嵌窗口
  scheduleDeepSeekSlotSync();
}

/** 切到某个配置页。设置已经摊成页面，不再有弹窗这一层。 */
async function openSettingsAt(panel) {
  if (!settingsLoaded) {
    try {
      await loadSettings();
    } catch (e) {
      uiAlert('读取设置失败：' + e.message);
      return;
    }
  }
  switchView('cfg-' + panel);
}

/* ---------------- 机器人 / 模型提供商：开关式切换 ---------------- */
/** 切换 QQ 接入方式。只提交 qq.mode 一个字段，后端是深合并，不会清掉其他配置。 */
async function switchBotMode(mode) {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ qq: { mode } }) });
    await refreshStatus();
    // 配置页是常驻表单、只在首次进入时拉一次数据，所以这里必须手动把
    // 卡片上刚切换的值同步过去，否则在配置页点「保存」会把它覆盖回旧值。
    if ($('setMode')) {
      $('setMode').value = mode;
      toggleQqMode();
    }
    renderWelcome();
  } catch (e) {
    uiAlert('切换接入方式失败：' + e.message);
    refreshStatus().catch(() => {});
  }
}

/** 切换大脑来源。同理只提交 ai.provider。 */
async function switchProvider(provider) {
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ ai: { provider } }) });
    await refreshStatus();
    // 同上：卡片切换后同步配置页的下拉与两个子面板
    if ($('setProvider')) {
      $('setProvider').value = provider;
      toggleProviderView();
    }
    renderWelcome();
  } catch (e) {
    uiAlert('切换模型提供商失败：' + e.message);
    refreshStatus().catch(() => {});
  }
}

/* ---------------- 欢迎页：三步上手状态 ---------------- */
function setStepState(stepId, cls, text) {
  const step = $(stepId);
  if (step) step.classList.toggle('done', cls === 'ok');
  const badge = $(stepId + 'State');
  if (badge) {
    badge.className = 'step-state ' + cls;
    badge.textContent = text;
  }
}

function setStepNote(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'step-note' + (cls ? ' ' + cls : '');
}

/** 按当前状态给三步打勾：连上 QQ / 有大脑 / 开了自动回复 */
function renderWelcome() {
  const qq = (state.status && state.status.qq) || {};
  const ai = (state.status && state.status.ai) || {};
  const self = state.self || {};

  /* 第 1 步：连上 QQ */
  if (qq.connected) {
    setStepState('stepQq', 'ok', '已完成');
    setStepNote('stepQqNote', self.nickname
      ? `已连上：${self.nickname}（${self.userId}）`
      : '已连上 OneBot 服务。');
  } else if (qq.needLogin) {
    setStepState('stepQq', 'warn', '待扫码');
    setStepNote('stepQqNote', 'QQ 桥接已经起来了，但 QQ 号还没登录。点左边按钮扫码，扫完这里会自动变成已完成。', 'warn');
  } else {
    setStepState('stepQq', 'bad', '未完成');
    setStepNote('stepQqNote', '还没有连上。点左边按钮会启动内置的 QQ 桥接，第一次需要扫码登录。', 'bad');
  }

  /* 第 2 步：给它一个大脑 */
  const ds = ai.deepseek || {};
  if (ai.provider === 'deepseek-web') {
    if (ds.state === 'ready' || ds.state === 'thinking') {
      setStepState('stepAi', 'ok', '已完成');
      setStepNote('stepAiNote', `网页版已就绪（${ds.siteName || 'DeepSeek'}）。`);
    } else if (ds.state === 'need-login') {
      setStepState('stepAi', 'warn', '待登录');
      setStepNote('stepAiNote', '浏览器已经拉起来了，但还没登录 DeepSeek。在弹出的窗口里登录一次即可。', 'warn');
    } else {
      setStepState('stepAi', 'warn', '未启动');
      setStepNote('stepAiNote', '网页版还没启动。点左边按钮会拉起浏览器窗口，登录一次之后长期复用。', 'warn');
    }
  } else if (ai.provider === 'openai-compatible') {
    setStepState('stepAi', 'ok', '已完成');
    setStepNote('stepAiNote', `正在用 API 接口（${ai.model || '未填模型'}）。`);
  } else {
    setStepState('stepAi', 'warn', '内置引擎');
    setStepNote('stepAiNote', '当前是内置规则引擎，只会关键词匹配。想让它真的会聊，换成网页版或 API。', 'warn');
  }

  /* 第 3 步：打开自动回复 */
  if (ai.enabled) {
    setStepState('stepReply', 'ok', '已完成');
    setStepNote('stepReplyNote', '自动回复已开启，别人发消息它就会回。');
  } else {
    setStepState('stepReply', 'bad', '未完成');
    setStepNote('stepReplyNote', '自动回复是关的，现在收到消息不会回。点左边按钮开启。', 'bad');
  }

  const allDone = qq.connected && ai.enabled &&
    (ai.provider !== 'deepseek-web' || ds.state === 'ready' || ds.state === 'thinking');
  const done = $('welcomeDone');
  if (done) done.hidden = !allDone;
}

/* ---------------- 会话概览 ---------------- */
/** 填充「清空哪个会话的记忆」下拉：全部会话 + 每个已知会话 */
function renderApiNewTargets() {
  const sel = $('setApiNewTarget');
  if (!sel) return;
  const cur = sel.value;
  const opts = [{ value: '', label: '全部会话（所有会话的记忆都清掉）' }];
  for (const c of state.chats) {
    opts.push({ value: c.id, label: `${c.type === 'group' ? '群' : '私'} · ${c.name}` });
  }
  sel.innerHTML = opts.map((o) =>
    `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  if (cur && opts.some((o) => o.value === cur)) sel.value = cur;
}

function renderOverview() {
  const ul = $('overviewList');
  const list = [...state.chats].sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  $('ovHint').textContent = list.length ? `${list.length} 个` : '';
  ul.innerHTML = list.length ? list.map((c) => `
    <li class="ov-item">
      <div class="avatar ${c.type === 'group' ? 'group' : ''}">${escapeHtml(initial(c.name))}</div>
      <div class="info">
        <div class="row">
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="type ${c.type}">${c.type === 'group' ? '群' : '私'}</span>
          <span class="time">${c.lastTime ? fmtTime(c.lastTime) : ''}</span>
        </div>
        <div class="row">
          <span class="last">${escapeHtml(c.lastText || '暂无消息')}</span>
          ${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
        </div>
      </div>
    </li>
  `).join('') : '<li class="ov-empty">暂无会话</li>';
}

/* ---------------- 实时动态 ---------------- */
const KIND_LABEL = {
  in: '收到', out: '发出', ai: 'AI 回复', skip: '跳过', err: '错误'
};

function pushFeed(item) {
  state.feed.unshift(item);
  if (state.feed.length > 120) state.feed.length = 120;
  renderFeed();
}

function renderFeed() {
  const ul = $('feedList');
  if (!state.feed.length) {
    ul.innerHTML = '<li class="feed-empty">等待消息中…</li>';
    return;
  }
  ul.innerHTML = state.feed.map((f) => `
    <li class="feed-item kind-${f.kind}">
      <span class="feed-time">${fmtTime(f.at)}</span>
      <span class="feed-tag">${KIND_LABEL[f.kind] || f.kind}</span>
      <span class="feed-chat">${escapeHtml(f.chatName || '')}</span>
      <span class="feed-text">${escapeHtml(f.text || f.reason || '')}</span>
    </li>
  `).join('');
}

/* ---------------- 数据刷新 ---------------- */
async function refreshChats() {
  const data = await api('/api/chats');
  state.chats = data.chats || [];
  renderOverview();
  renderStats();
  renderApiNewTargets();
}

async function refreshStatus() {
  const data = await api('/api/status');
  state.status = { qq: data.qq, ai: data.ai };
  state.version = data.version || state.version;
  state.self = data.self;
  if (data.platform) state.platform = data.platform;
  applyPlatform();
  renderStatus();
}

/**
 * 按当前平台隐藏不适用的入口：
 *  - 安卓：网页版模式不可用（系统里没有带 CDP 的浏览器），只留 API 模式；
 *  - 安卓/苹果：自更新走应用商店，隐藏「自动更新」区块。
 */
function applyPlatform() {
  const p = state.platform;
  if (!p) return;
  const webOpt = document.querySelector('#setProvider option[value="deepseek-web"]');
  if (webOpt && p.webSupported === false) {
    webOpt.disabled = true;
    webOpt.textContent = '网页版 DeepSeek（本平台不支持）';
    if ($('setProvider').value === 'deepseek-web') {
      $('setProvider').value = 'openai-compatible';
      toggleProviderView();
    }
  }
  /* 配置页现在是独立视图，要隐藏的就不只是里面那块内容，
     侧栏入口和整个视图都得收起来，否则点进去是一片空白。 */
  const hideView = (key, hide) => {
    const nav = document.querySelector('.sidebar .nav-item[data-view="' + key + '"]');
    if (nav) nav.hidden = hide;
    const view = document.querySelector('.view[data-view="' + key + '"]');
    if (view) view.hidden = hide;
    // 正停在这个视图上却被收起来了 → 页面会变成一片空白，退回欢迎页
    if (hide && view && view.classList.contains('active')) switchView('welcome');
  };
  // 两个方向都写死：applyPlatform 会随 refreshStatus 反复调用，
  // 只写 true 不写 false 的话，标志一旦变回来视图就永远回不来了。
  hideView('cfg-update', p.selfUpdate === false);
  hideView('cfg-engine', p.engineSupported === false);
  if (p.webSupported === false) {
    const webOnly = $('webOnly');
    if (webOnly) webOnly.classList.add('hidden');
  }
  // 安卓版不内置 Windows 版 QQ 运行时，隐藏「QQ 桥接」，换成手机端说明
  const tip = $('qqTipMobile');
  if (tip) {
    const show = p.engineSupported === false;
    tip.classList.toggle('hidden', !show);
    tip.hidden = !show;
  }
}

/* ---------------- 设置 ---------------- */
/** 并发防护：多个入口会同时调 loadSettings，只让最后一次请求的结果落地 */
let loadSeq = 0;
async function loadSettings() {
  const seq = ++loadSeq;
  const data = await api('/api/settings');
  // 有更新的请求在路上 → 这次的结果已经过期
  if (seq !== loadSeq) return;
  // 请求飞行途中用户开始编辑了 → 不能拿服务端值盖掉他正在填的内容
  if (settingsDirty) return;
  settingsCache = data;
  const ai = data.ai || {};
  $('setProvider').value = ai.provider || 'deepseek-web';
  $('setEnabled').checked = !!ai.enabled;
  $('setBaseUrl').value = ai.baseUrl || '';
  $('setApiKey').value = '';
  $('setApiKey').placeholder = ai.hasKey ? '已配置（留空保持不变）' : '留空则不可用';
  if ($('btnApiKeyClear')) $('btnApiKeyClear').hidden = !ai.hasKey;
  $('setModel').value = ai.model || '';
  $('setScope').value = ai.scope || 'private';
  $('setMention').checked = !!ai.requireMentionInGroup;
  $('setGroupChance').value = ai.groupReplyChance ?? 100;
  $('setKeywords').value = ai.groupKeywords || '';
  $('setImageReply').checked = ai.imageReply !== false;
  $('setGroupAt').checked = ai.groupAtSender !== false;
  $('setGroupQuote').checked = ai.groupQuote !== false;
  $('setQuietEnabled').checked = !!ai.quietEnabled;
  $('setQuietFrom').value = ai.quietFrom || '23:00';
  $('setQuietTo').value = ai.quietTo || '08:00';
  $('setCmdSenders').value = ai.commandSenders || '';
  const cooldownMs = ai.minIntervalMs ?? 2500;
  $('setCooldownEnabled').checked = cooldownMs > 0;
  $('setCooldownSec').value = cooldownMs > 0 ? cooldownMs / 1000 : 3;
  $('setCooldownSec').disabled = cooldownMs <= 0;
  $('setPrompt').value = ai.systemPrompt || '';
  $('setCdpPort').value = ai.cdpPort ?? 9222;
  $('setBrowserPath').value = ai.browserPath || '';
  $('setWebPrompt').value = ai.webPrompt || '';
  $('setWebMaxRounds').value = ai.webMaxRounds ?? 50;

  /* ---- 兴趣 / 主动发言（长期记忆已移除） ---- */
  const itr = data.interest || {};
  const itrReply = data.interestReply || {};
  const pro = data.proactive || {};
  $('setInterestReply').checked = !!itrReply.enabled;
  $('setProactiveEnabled').checked = !!pro.enabled;
  $('setProactiveShadow').checked = pro.shadow !== false;
  $('setProactiveTargets').value = Array.isArray(pro.targetChatKeys) ? pro.targetChatKeys.join(',') : '';
  $('setProIdleMin').value = pro.idleMin ?? 25;
  $('setProMaxHour').value = pro.maxPerHour ?? 2;
  $('setProMaxDay').value = pro.maxPerDay ?? 8;
  $('setProGapMin').value = Math.round((pro.minGapMs ?? 1200000) / 60000);
  $('setProNightFrom').value = pro.nightFrom || '00:00';
  $('setProNightTo').value = pro.nightTo || '09:00';
  $('setInterestCaps').value = Array.isArray(itr.capabilities) ? itr.capabilities.join(',') : '';
  /* ---- 群管（六件套）---- */
  const mod = data.moderation || {};
  $('setModEnabled').checked = !!mod.enabled;
  $('setModShadow').checked = !!mod.shadow;
  $('setModAutoPunish').checked = !!mod.autoPunish;
  $('setModWhitelist').value = [mod.whitelistUsers || '', (mod.whitelistChats || '').split(',').filter(Boolean).map((s) => 'group:' + s).join(',')].filter(Boolean).join(',');
  $('setModSpamWin').value = mod.spam?.windowSec ?? 10;
  $('setModSpamMax').value = mod.spam?.maxMsgs ?? 6;
  $('setModSpamMute').value = mod.spam?.muteMin ?? 5;
  $('setModDupWin').value = mod.duplicate?.windowSec ?? 60;
  $('setModDupTimes').value = mod.duplicate?.times ?? 3;
  $('setModDupDel').checked = mod.duplicate?.deleteMsg !== false;
  $('setModDupNotice').checked = mod.duplicate?.notice !== false;
  $('setModBanned').value = mod.banned?.words || '';
  $('setModBannedNotify').checked = mod.banned?.notifyAdmin !== false;
  $('setModAdDelete').checked = mod.ad?.deleteMsg !== false;
  $('setModAdLinks').checked = !!mod.ad?.blockLinks;
  $('setModWelcome').value = mod.welcome?.text || '';
  $('setModCurfewFrom').value = mod.curfew?.from || '00:00';
  $('setModCurfewTo').value = mod.curfew?.to || '06:00';
  $('setModCurfewText').value = mod.curfew?.text || '';
  refreshProactiveLog();
  $('setMode').value = data.qq?.mode || 'onebot';
  $('setWsUrl').value = data.qq?.onebot?.wsUrl || 'ws://127.0.0.1:3001';
  $('setToken').value = data.qq?.onebot?.accessToken || '';
  // Token 只回后 4 位；留空保存 = 清除
  $('setToken').placeholder = data.qq?.onebot?.hasToken ? '留空 = 清除（当前已配置）' : '与 OneBot 运行时里填的一致，没有就留空';
  /* ---- QQ 官方机器人（mode=qqbot）---- */
  const off = data.qq?.official || {};
  $('setQqbotAppId').value = off.appId || '';
  $('setQqbotSecret').value = '';
  $('setQqbotSecret').placeholder = off.hasSecret ? '已配置（留空保持不变）' : '在 q.qq.com 机器人管理页复制';
  $('setQqbotSandbox').checked = !!off.sandbox;
  toggleQqMode();
  const eng = data.qq?.engine || {};
  // 下拉框只剩「内置/自定义」两项；老配置里的 'auto'（已移除的第三项）按内置处理，
  // 否则 value 赋不进去，下拉框会显示成空白。
  $('setEngineSource').value = (eng.source === 'custom') ? 'custom' : 'bundled';
  // 配置里的 dir 是「自定义目录」；选内置时界面要显示内置路径而不是它。
  // 先把它记成 lastCustomEngineDir，toggleEngineDir 才有东西可以还原。
  lastCustomEngineDir = eng.dir || '';
  $('setEngineDir').value = eng.dir || '';
  $('setEngineAccount').value = eng.account || '';
  $('setEngineAuto').checked = eng.autoStart !== false;
  toggleEngineDir();
  refreshEngineStatus();
  const upd = data.update || {};
  $('setUpdateManifest').value = upd.manifestUrl || '';
  $('setUpdateAuto').checked = upd.autoCheck !== false;
  $('updateStatus').textContent = `状态：当前 v${state.version || '1.4.9'}，未检查`;
  $('updateStatus').className = 'ds-status';

  // 回复对象：会话多选下拉（来自概览列表）
  $('setReplyMode').value = ai.replyMode === 'target' ? 'target' : 'all';
  const sel = $('setTargetChat');
  sel.innerHTML = '';
  const selected = new Set(Array.isArray(ai.targetChatKeys)
    ? ai.targetChatKeys
    : (ai.targetChatKey ? [ai.targetChatKey] : []));
  const opts = state.chats.map((c) => ({ value: c.id, label: `${c.type === 'group' ? '群' : '私'} · ${c.name}` }));
  for (const k of selected) {
    if (!opts.some((o) => o.value === k)) opts.push({ value: k, label: k });
  }
  sel.innerHTML = opts.map((o) =>
    `<option value="${escapeHtml(o.value)}"${selected.has(o.value) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  toggleTargetView();

  renderApiNewTargets();

  toggleProviderView();
  refreshDsStatus();

  // 网页版模型下拉（切换模型）：列表来自后端站点档案
  try {
    const sr = await api('/api/web/sites');
    const wsel = $('setWebSite');
    wsel.innerHTML = sr.sites.map((s) =>
      `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    wsel.value = ai.webProvider || sr.current || 'deepseek';
    const hint = sr.sites.find((s) => s.id === wsel.value);
    $('webSiteHint').textContent = hint ? (hint.hint || '') : '';
    wsel.onchange = () => {
      const h = sr.sites.find((s) => s.id === wsel.value);
      $('webSiteHint').textContent = h ? (h.hint || '') : '';
    };
  } catch { /* 忽略 */ }
  settingsLoaded = true;
  settingsDirty = false;
}

function toggleTargetView() {  $('targetWrap').classList.toggle('hidden', $('setReplyMode').value !== 'target');
}

function toggleProviderView() {
  const p = $('setProvider').value;
  $('webOnly').classList.toggle('hidden', p !== 'deepseek-web');
  $('apiOnly').classList.toggle('hidden', p === 'deepseek-web');
}

/* ---------------- 主动发言面板 ---------------- */

/* ---- 群管：拦截记录 ---- */
const MOD_FEATURE_LABEL = {
  spam: '刷屏', ad: '广告', banned: '违禁词',
  duplicate: '重复', welcome: '欢迎', curfew: '宵禁'
};

function modFeatureLabel(f) {
  return MOD_FEATURE_LABEL[f] || f || '其他';
}

async function refreshModStats() {
  const box = $('modStatsBox');
  if (!box) return;
  try {
    const r = await api('/api/moderation');
    const st = r.moderation || {};
    if (st.enabled === false) {
      box.textContent = '群管没开。打开总开关并保存后，这里才会有记录。';
      box.className = 'ds-status warn';
      return;
    }
    const counts = st.counts || {};
    const line1 = '计数：' + Object.keys(MOD_FEATURE_LABEL)
      .map((k) => modFeatureLabel(k) + ' ' + (counts[k] || 0)).join(' · ');
    const items = (st.decisions || []).slice(0, 20);
    const line2 = items.length
      ? items.map((d) => '[' + new Date(d.at).toLocaleTimeString() + '] '
        + modFeatureLabel(d.feature) + ' · ' + (d.action || '') + ' · '
        + (d.chatName || d.chatId || '') + (d.userName ? ' · ' + d.userName : '')
        + (d.detail ? ' · ' + d.detail : '')).join('\n')
      : '最近还没有拦截/处理记录（演示模式或刚开）。';
    box.textContent = line1 + '\n' + line2;
    box.className = 'ds-status';
  } catch (e) {
    box.textContent = '读取失败：' + e.message;
    box.className = 'ds-status err';
  }
}

async function toggleModStats() {
  const box = $('modStatsBox');
  if (!box) return;
  if (box.style.display && !box.style.display.includes('none')) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  await refreshModStats();
}

async function refreshProactiveLog() {
  const box = $('proactiveLog');
  if (!box) return;
  try {
    const r = await api('/api/proactive/decisions?limit=30');
    const items = r.items || [];
    if (!items.length) {
      box.textContent = '还没有决策记录。开了「冷场时主动开口」之后，它每次想说话都会在这里留一条——说了什么、或者被哪道闸拦下。';
      return;
    }
    box.innerHTML = items.slice(0, 30).map((d) => {
      const t = new Date(d.at || Date.now());
      const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      const tag = d.ok
        ? (d.sent ? '✅ 发了' : (d.shadow ? '👀 演练' : '⏸ 待发'))
        : '🚫 ' + escapeHtml(d.reason || '未通过');
      const body = d.text || d.preview || '';
      return `<div style="margin:4px 0;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)">
        <small>${hh} · ${escapeHtml(d.chatKey || '')} · ${tag} · 相关度 ${(d.score || 0).toFixed(2)}</small>
        ${body ? `<div>${escapeHtml(String(body).slice(0, 80))}</div>` : ''}
      </div>`;
    }).join('');
  } catch (e) {
    box.textContent = '决策记录加载失败：' + e.message;
  }
}

async function killProactive() {
  if (!(await uiConfirm('立刻关闭主动发言和兴趣插话？\n\n正常 @ 回复不受影响。这个操作会写进配置，重启后也不会自己打开。',
    { title: '一键闭嘴', okText: '闭嘴', cancelText: '算了', type: 'warn' }))) return;
  try {
    const r = await api('/api/proactive/kill', { method: 'POST', body: '{}' });
    $('setProactiveEnabled').checked = false;
    $('setInterestReply').checked = false;
    uiAlert(r.message || '已关闭');
    refreshProactiveLog();
  } catch (e) {
    uiAlert('操作失败：' + e.message);
  }
}

/* ---------------- 表情包 ---------------- */
async function refreshStickers() {
  const statsEl = $('stickerStats');
  const listEl = $('stickerList');
  try {
    const r = await api('/api/stickers');
    statsEl.textContent = `素材：${r.count} 个（商城表情 ${r.mface} / 图片 ${r.image}）` + (r.items.length < r.count ? ` · 仅显示最近 ${r.items.length} 条` : '');
    listEl.innerHTML = r.items.length
      ? r.items.map((x) => `
        <div class="sticker-row">
          ${x.kind === 'image' && x.local
            ? `<img class="sticker-thumb" src="/api/stickers/img?key=${encodeURIComponent(x.key)}" onerror="this.style.display='none'" alt="">`
            : `<span class="sticker-emoji">${x.kind === 'mface' ? '🎭' : '🖼'}</span>`}
          <span>${x.kind === 'mface' ? '商城表情 ' + escapeHtml(x.text) : '图片 …' + escapeHtml(x.text)}</span>
          <small>×${x.count}</small>
          <button class="mini-btn danger-btn sticker-del">删除</button>
        </div>`).join('')
      : '<div class="tip">素材库是空的：私聊给机器人发几个表情包、或在群里发，它会自动收藏。之后 AI 就能自己发表情包了，这个按钮也能立刻发。</div>';
    listEl.querySelectorAll('.sticker-del').forEach((btn, i) => {
      btn.addEventListener('click', () => delSticker(r.items[i].key));
    });
  } catch (e) {
    statsEl.textContent = '表情包状态加载失败：' + e.message;
  }
}

async function delSticker(key) {
  if (!(await uiConfirm('删除这个表情包素材？', { title: '删除表情包', okText: '删除', cancelText: '取消', type: 'warn' }))) return;
  api('/api/stickers', { method: 'DELETE', body: JSON.stringify({ key }) })
    .then(() => refreshStickers())
    .catch((e) => uiAlert('删除失败：' + e.message, { title: '操作失败', type: 'err' }));
}

async function clearStickers() {
  if (!(await uiConfirm('清空全部表情包素材？机器人之后收到表情包会自动重新收藏。', { title: '清空表情包', okText: '清空', cancelText: '取消', type: 'warn' }))) return;
  api('/api/stickers/clear', { method: 'POST', body: '{}' })
    .then((r) => {
      uiAlert(`已清空 ${r.removed} 个素材`, { title: '清空完成', type: 'ok' });
      refreshStickers();
    })
    .catch((e) => uiAlert('清空失败：' + e.message, { title: '操作失败', type: 'err' }));
}

function testSticker() {
  const btn = $('btnStickerTest');
  btn.disabled = true;
  btn.textContent = '发送中…';
  api('/api/stickers/test', { method: 'POST', body: '{}' })
    .then((r) => {
      btn.disabled = false;
      btn.textContent = '发一个到我 QQ 看看';
      uiAlert(`✅ 已发到 ${r.to}（${r.sent.kind === 'mface' ? '商城表情' : '图片'}「${r.sent.text}」）——去 QQ 看看`);
    })
    .catch((e) => {
      btn.disabled = false;
      btn.textContent = '发一个到我 QQ 看看';
      uiAlert('❌ ' + e.message);
    });
}

/* ---------------- 在线表情图库 ---------------- */
async function refreshGallery() {
  const statsEl = $('galleryStats');
  const listEl = $('galleryList');
  if (!statsEl || !listEl) return;
  try {
    const r = await api('/api/gallery');
    const age = r.ageDays === null ? '尚未拉取' : (r.ageDays === 0 ? '今天更新' : `${r.ageDays} 天前更新`);
    statsEl.textContent = `在线图库：${r.count} 张（${r.source} · ${age}）` + (r.refreshing ? ' · 刷新中…' : '');
    listEl.innerHTML = r.items.length
      ? r.items.map((x) => `
        <div class="sticker-row">
          <img class="sticker-thumb" loading="lazy" src="/api/gallery/img?id=${encodeURIComponent(x.id)}" onerror="this.style.display='none'" alt="">
          <span>${escapeHtml(x.title)}</span>
          <small>${x.local ? '已缓存' : ''}</small>
        </div>`).join('')
      : '<div class="tip">图库目录是空的：点「刷新图库」拉一次；如果一直失败，可能是网络连不上梗鲸站点（不影响 AI 用群友素材发表情包）。</div>';
  } catch (e) {
    statsEl.textContent = '在线图库加载失败：' + e.message;
  }
}

function refreshGalleryForce() {
  const btn = $('btnGalleryRefresh');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  api('/api/gallery/refresh', { method: 'POST', body: '{}' })
    .then((r) => {
      btn.disabled = false;
      btn.textContent = '刷新图库';
      if (!r.ok) return uiAlert('拉取失败：' + (r.error || '未知原因'), { title: '在线图库', type: 'err' });
      uiAlert(`✅ 图库已更新，共 ${r.count} 张`, { title: '在线图库', type: 'ok' });
      refreshGallery();
    })
    .catch((e) => {
      btn.disabled = false;
      btn.textContent = '刷新图库';
      uiAlert('拉取失败：' + e.message, { title: '在线图库', type: 'err' });
    });
}

function openWebSite() {
  const btn = $('btnWebOpen');
  const site = $('setWebSite') ? $('setWebSite').value : 'deepseek';
  btn.disabled = true;
  btn.textContent = '正在打开…';
  api('/api/web/open', { method: 'POST', body: JSON.stringify({ site }) })
    .then((r) => {
      btn.disabled = false;
      btn.textContent = '① 打开该网站（首次需登录）';
      uiAlert(`已打开「${r.siteName}」：${r.url}\n\n首次使用请在弹出的浏览器窗口里登录一次，登录态会长期记住。\n之后切到「保存」，机器人就用这个模型回复了。`);
    })
    .catch((e) => {
      btn.disabled = false;
      btn.textContent = '① 打开该网站（首次需登录）';
      uiAlert('❌ ' + e.message);
    });
}

/** QQ 接入模式切换：onebot 显示 WS/Token，qqbot 显示 AppID/Secret，mock 两者都藏 */
function toggleQqMode() {
  const mode = $('setMode').value;
  const onebotBox = $('onebotOnly');
  const qqbotBox = $('qqbotOnly');
  if (onebotBox) onebotBox.classList.toggle('hidden', mode !== 'onebot');
  if (qqbotBox) qqbotBox.classList.toggle('hidden', mode !== 'qqbot');
}


/* ---- QQ 官方机器人：内嵌官方扫码绑定页 ----
   官方 connect.html 自带二维码和扫码指引；群崽只负责开任务、轮询结果、落盘凭据。 */
let qqbotBindTimer = null;

function qqbotBindSetStatus(text, cls) {
  const el = $('qqbotBindStatus');
  if (el) {
    el.textContent = text;
    el.className = 'ds-status ' + (cls || '');
  }
}

function stopQqbotBindPolling() {
  if (qqbotBindTimer) { clearInterval(qqbotBindTimer); qqbotBindTimer = null; }
}

async function qqbotBindConfirm() {
  stopQqbotBindPolling();
  try {
    const r = await api('/api/qqbot/bind/confirm', { method: 'POST', body: '{}' });
    if (!r.ok) throw new Error(r.error || '确认失败');
    qqbotBindSetStatus('绑定成功！已自动填入凭据并切到官方机器人模式。', 'ok');
    // 几秒后自动收起绑定层（iframe 留着给用户看官方成功页）
    setTimeout(() => { const box = $('qqbotBindBox'); if (box) box.classList.add('hidden'); }, 2500);
    // 回读设置回填面板，保证界面与后端一致
    try {
      const st = await api('/api/settings');
      const off = st.qq?.official || {};
      $('setQqbotAppId').value = off.appId || '';
      $('setQqbotSecret').value = '';
      $('setQqbotSecret').placeholder = off.hasSecret ? '已配置（留空保持不变）' : '在 q.qq.com 机器人管理页复制';
      $('setQqbotSandbox').checked = !!off.sandbox;
      $('setMode').value = st.qq?.mode || 'qqbot';
      toggleQqMode();
    } catch { /* 回读失败不影响绑定结果 */ }
    refreshEngineStatus();
  } catch (e) {
    qqbotBindSetStatus('绑定成功但保存失败：' + e.message + '。可手动填写 AppID/Secret 保存。', 'err');
  }
}

function qqbotBindPoll() {
  stopQqbotBindPolling();
  qqbotBindTimer = setInterval(async () => {
    try {
      const r = await api('/api/qqbot/bind/status');
      const b = r.bind || {};
      if (b.status === 'done' && b.credentials) {
        qqbotBindSetStatus('扫码成功，正在保存凭据…', 'warn');
        await qqbotBindConfirm();
        return;
      }
      if (b.status === 'pending') qqbotBindSetStatus('等待扫码…用手机 QQ 扫描上方页面里的二维码。', '');
      if (b.status === 'failed') {
        qqbotBindSetStatus('绑定失败：' + (b.error || '未知错误'), 'err');
        stopQqbotBindPolling();
      }
    } catch { /* 网络抖动下一轮再试 */ }
  }, 2000);
}

function initQqbotBind() {
  const btn = $('btnQqbotBind');
  if (btn) btn.addEventListener('click', async () => {
    const box = $('qqbotBindBox');
    if (!box) return;
    btn.disabled = true;
    btn.textContent = '正在获取二维码…';
    qqbotBindSetStatus('正在向腾讯官方申请绑定任务…', '');
    try {
      const r = await api('/api/qqbot/bind/start', { method: 'POST', body: '{}' });
      if (!r.ok || !r.connectUrl) throw new Error(r.error || '创建绑定任务失败');
      box.classList.remove('hidden');
      $('qqbotBindFrame').src = r.connectUrl;
      qqbotBindPoll();
    } catch (e) {
      qqbotBindSetStatus('启动绑定失败：' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '用手机 QQ 扫码绑定（免填 AppID/Secret）';
    }
  });
  const cancelBtn = $('btnQqbotBindCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    stopQqbotBindPolling();
    try { await api('/api/qqbot/bind/cancel', { method: 'POST', body: '{}' }); } catch { /* noop */ }
    const box = $('qqbotBindBox');
    if (box) box.classList.add('hidden');
    const frame = $('qqbotBindFrame');
    if (frame) frame.src = 'about:blank';
  });
}


function toggleEngineDir() {
  const src = $('setEngineSource').value;
  const input = $('setEngineDir');
  const wrap = input.closest('label');
  const bundled = src === 'bundled';
  if (wrap) wrap.style.opacity = bundled ? '.45' : '1';
  input.disabled = bundled;
  // ★ 切到「内置」时必须把目录栏恢复成内置那份的真实路径。
  //   老逻辑只是把输入框置灰，里面还留着用户上次填的 D:\SnowLuma-...；
  //   一保存，服务端就把这个旧目录当成「显式覆盖」，内置选项形同虚设
  //   （用户选了内置，跑的还是 SnowLuma，停止也停不掉）。
  if (bundled) {
    if (input.value.trim() && input.value.trim() !== state.bundledEngineDir) {
      lastCustomEngineDir = input.value.trim();   // 记住用户自己的路径，切回来还给他
    }
    input.value = state.bundledEngineDir || '';
    input.placeholder = '内置：随群崽安装的那一份';
  } else if (input.value === state.bundledEngineDir) {
    input.value = lastCustomEngineDir;
    input.placeholder = '例如 D:\你的OneBot运行时';
  }
}

async function refreshEngineStatus() {
  const el = $('engineStatus');
  if (!el) return;
  try {
    const r = await api('/api/engine/status');
    applyEngineStatus(r.engine || {});
  } catch (e) {
    el.textContent = '状态：读取失败 — ' + e.message;
    el.className = 'ds-status err';
  }
}

function applyEngineStatus(e) {
  const el = $('engineStatus');
  if (!el) return;
  if (e.bundledDir && e.bundledDir !== state.bundledEngineDir) {
    state.bundledEngineDir = e.bundledDir;
    // loadSettings 执行时还不知道内置目录（status 是异步拿的），这里补一次
    toggleEngineDir();
  }
  const who = e.account ? `账号 ${e.account}` : '未指定账号';
  const from = e.kind ? `${e.kind === 'napcat' ? 'NapCat' : e.kind}` : '未知运行时';
  // 下拉框只剩「内置/自定义」，老配置里的 'auto' 按内置显示，免得面板写着「内置」状态栏却写「自动」
  const isBundledSrc = e.source !== 'custom';
  const src = isBundledSrc ? '内置' : '自定义';
  // 选「内置」时显示内置那份的路径，而不是配置里残留的自定义目录——
  // 否则面板写着「内置」，路径却是 D:\SnowLuma-...，自相矛盾
  const where = (isBundledSrc && e.bundledDir)
    ? e.bundledDir + (e.bundledAvailable ? '' : '（内置那份没找到）')
    : (e.dir ? e.dir : '未找到目录');
  // 端口被别的程序占着（例如用户自己另开了一份运行时），群崽管不了它，别说成「运行中」
  // 注意：这里不能叫 state —— 会遮蔽上面的模块级 state，函数开头读 state.bundledEngineDir 直接 TDZ 报错
  const runState = e.running ? '运行中'
    : (e.portTakenByOther ? '端口被别的程序占着'
      : (e.needLogin ? '等你扫码登录' : '未运行'));
  el.textContent = `状态：${runState} ｜ ${src}·${from} ｜ ${who} ｜ WS ${e.wsPort || '-'} ｜ ${where}` +
    (e.portTakenByOther ? ' ｜ 这端口不是群崽启动的，点停止也停不掉它；要接管请先关掉那个程序' : '') +
    (e.lastError ? ` ｜ ${e.lastError}` : '');
  el.className = 'ds-status ' + (e.running ? 'ok' : ((e.lastError || e.portTakenByOther) ? 'err' : 'warn'));
  $('btnEngineWebui').style.display = e.webuiUrl ? '' : 'none';
  // 没登录时才显示二维码；登录成功自动收起
  if (e.needLogin) showEngineQr();
  else hideEngineQr();
}

function showEngineQr() {
  const box = $('engineQrBox');
  if (!box) return;
  const img = $('engineQrImg');
  if (img) img.src = '/api/engine/qr?t=' + Date.now();
  box.hidden = false;
}

function hideEngineQr() {
  const box = $('engineQrBox');
  if (box) box.hidden = true;
}

async function detectEngine() {
  const btn = $('btnEngineDetect');
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const r = await api('/api/engine/scan', {
      method: 'POST',
      body: JSON.stringify({
        dir: $('setEngineSource').value === 'bundled' ? '' : $('setEngineDir').value.trim(),
        account: $('setEngineAccount').value.trim()
      })
    });
    if (r.ok) {
      if ($('setEngineSource').value !== 'bundled') $('setEngineDir').value = r.engine.dir;
      $('setEngineAccount').value = r.engine.account || $('setEngineAccount').value;
      $('engineStatus').textContent = `已找到：${r.engine.configFile} ｜ 账号 ${r.engine.account || '未命名'} ｜ WS ${r.engine.wsPort} ｜ API ${r.engine.apiPort}`;
      $('engineStatus').className = 'ds-status ok';
    } else {
      $('engineStatus').textContent = '未找到：' + r.error;
      $('engineStatus').className = 'ds-status err';
    }
  } catch (e) {
    $('engineStatus').textContent = '检测失败：' + e.message;
    $('engineStatus').className = 'ds-status err';
  } finally {
    btn.disabled = false;
    btn.textContent = '自动检测';
    refreshEngineStatus();
  }
}

async function startEngine() {
  const btn = $('btnEngineStart');
  btn.disabled = true;
  btn.textContent = '启动中…';
  try {
    const r = await api('/api/engine/start', {
      method: 'POST',
      body: JSON.stringify({
        dir: $('setEngineSource').value === 'bundled' ? '' : $('setEngineDir').value.trim(),
        account: $('setEngineAccount').value.trim()
      })
    });
    if (r.ok) {
      if ($('setEngineSource').value !== 'bundled') $('setEngineDir').value = r.info.dir;
      $('setEngineAccount').value = r.info.account || $('setEngineAccount').value;
      if (r.needLogin) {
        $('engineStatus').textContent = r.hint || '第一次登录要扫码：用手机 QQ 扫下面的码，登录后会自动接上';
        $('engineStatus').className = 'ds-status warn';
        showEngineQr();
      } else {
        $('engineStatus').textContent = `已同步：${r.started ? '本次已启动' : '复用已运行实例'} ｜ 账号 ${r.login || r.info.account || '未验证'} ｜ WS ${r.info.wsPort}`;
        $('engineStatus').className = 'ds-status ok';
        hideEngineQr();
        await refreshStatus();
      }
    } else {
      $('engineStatus').textContent = '启动失败：' + r.error;
      $('engineStatus').className = 'ds-status err';
    }
  } catch (e) {
    $('engineStatus').textContent = '启动失败：' + e.message;
    $('engineStatus').className = 'ds-status err';
  } finally {
    btn.disabled = false;
    btn.textContent = '启动并同步';
    refreshEngineStatus();
  }
}

async function stopEngine() {
  const btn = $('btnEngineStop');
  btn.disabled = true;
  btn.textContent = '停止中…';
  try {
    const r = await api('/api/engine/stop', { method: 'POST', body: '{}' });
    uiAlert(r.ok ? `已停止本次启动的运行时（PID ${r.pid}）` : r.error);
  } catch (e) {
    uiAlert('停止失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '停止本次启动';
    refreshEngineStatus();
  }
}

let enginePanelUrl = '';

/** 把内置运行时的管理面板直接嵌进群崽，不用再跳浏览器 */
async function openEngineWebui() {
  const panel = $('enginePanel');
  if (!panel) return;
  let url = '';
  try {
    const r = await api('/api/engine/status');
    url = r.engine?.webuiUrl || '';
  } catch (e) {
    return uiAlert('读取内核状态失败：' + e.message);
  }
  if (!url) {
    return uiAlert('没有找到它的管理面板地址。确认它已经启动过一次（首次启动会生成配置）。');
  }
  enginePanelUrl = url;
  const frame = $('enginePanelFrame');
  const loading = $('enginePanelLoading');
  const dot = $('enginePanelDot');
  const sub = $('enginePanelSub');
  if (sub) sub.textContent = url.replace(/\?token=[^&]*/, '');
  if (dot) dot.classList.add('on');
  if (loading) {
    loading.classList.remove('hidden');
    loading.textContent = '正在加载面板…';
  }
  panel.classList.remove('hidden');
  if (frame) frame.src = url;
  // 面板是本地服务，正常 1 秒内就出来；超过 12 秒还没 onload 就给个可读提示
  clearTimeout(openEngineWebui._t);
  openEngineWebui._t = setTimeout(() => {
    if (loading && !loading.classList.contains('hidden')) {
      loading.innerHTML = '面板还没加载出来。<br>可能是内核正在启动，或者端口被占用。<br>点右上角「刷新」再试一次。';
    }
  }, 12000);
}

function closeEnginePanel() {
  const panel = $('enginePanel');
  const frame = $('enginePanelFrame');
  if (frame) frame.src = 'about:blank';
  if (panel) panel.classList.add('hidden');
  enginePanelUrl = '';
}

function reloadEnginePanel() {
  const frame = $('enginePanelFrame');
  const loading = $('enginePanelLoading');
  if (!enginePanelUrl) return openEngineWebui();
  if (loading) {
    loading.classList.remove('hidden');
    loading.textContent = '正在加载面板…';
  }
  if (frame) frame.src = enginePanelUrl + (enginePanelUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
}

function enginePanelExternal() {
  if (!enginePanelUrl) return uiAlert('面板地址还没拿到，先点「刷新」。');
  window.open(enginePanelUrl, '_blank', 'noopener');
}

async function checkUpdate(manual = true) {
  const btn = $('btnUpdateCheck');
  const el = $('updateStatus');
  if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
  if (el) { el.textContent = '状态：正在检查更新…'; el.className = 'ds-status'; }
  try {
    const r = await api('/api/update/check', { method: 'POST', body: '{}' });
    if (!r.ok) {
      const msg = r.configured
        ? `检查失败：${r.error || '未知错误'}`
        : `未配置更新地址：${r.error || ''}`;
      if (el) { el.textContent = msg; el.className = 'ds-status ' + (r.configured ? 'err' : 'warn'); }
      if (manual) uiAlert(msg, { title: '检查更新失败', type: 'err' });
      return false;
    }
    if (!r.updateAvailable) {
      if (el) { el.textContent = `状态：已是最新版本 v${r.current}`; el.className = 'ds-status ok'; }
      if (manual) uiAlert(`当前已经是最新版本 v${r.current}。`, { title: '检查更新', type: 'ok' });
      return false;
    }

    if (el) { el.textContent = `状态：发现新版本 v${r.latest}（当前 v${r.current}）`; el.className = 'ds-status warn'; }
    const notes = r.notes ? `\n\n更新说明：\n${String(r.notes).slice(0, 800)}` : '';
    if (!(await uiConfirm(`发现新版本 v${r.latest}，当前 v${r.current}。${notes}\n\n是否下载更新？`, { title: '发现新版本', okText: '下载更新', cancelText: '暂不更新', type: 'warn' }))) {
      if (el) el.textContent += ' ｜ 已选择不更新';
      return false;
    }

    if (el) { el.textContent = `状态：正在下载 v${r.latest}…（优先镜像，失败自动回退官方源）`; el.className = 'ds-status warn'; }

    // 下载期间轮询进度：多线程下载能跑几 MB/s，让用户看得见
    let pollTimer = null;
    const stopPoll = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
    if (el) {
      pollTimer = setInterval(async () => {
        try {
          const p = await api('/api/update/progress');
          if (!p || !p.downloading) return;
          const mb = (n) => (n / 1024 / 1024).toFixed(1);
          const speed = p.speed > 1024 * 1024 ? `${(p.speed / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(p.speed / 1024)} KB/s`;
          el.textContent = `状态：正在下载 v${r.latest}… ${p.percent}% ｜ ${mb(p.downloaded)}/${mb(p.total)} MB ｜ ${speed} ｜ ${p.connections} 线程`;
        } catch { /* 进度接口失败不影响下载本身 */ }
      }, 500);
    }

    let d;
    try {
      d = await api('/api/update/download', { method: 'POST', body: '{}' });
    } finally {
      stopPoll();
    }
    if (!d.ok) throw new Error(d.error || '下载失败');
    if (el) {
      const via = d.via === 'mirror' ? '镜像加速' : '官方源';
      const thr = d.sequential ? '单线程' : `${d.connections} 线程`;
      el.textContent = `状态：v${r.latest} 已下载（${via}，${thr}），SHA256 校验通过（${(d.bytes / 1024 / 1024).toFixed(1)} MB）`;
      el.className = 'ds-status ok';
    }
    if (await uiConfirm(`v${r.latest} 已下载完成，是否立即安装？\n\n安装程序会打开，按提示完成即可；安装器会先结束旧版本，并在完成后启动新版本。`, { title: '安装更新', okText: '立即安装', cancelText: '稍后安装', type: 'warn' })) {
      const inst = await api('/api/update/install', { method: 'POST', body: '{}' });
      if (!inst.ok) throw new Error(inst.error || '安装失败');
      if (el) el.textContent = '状态：安装程序正在打开，请按提示完成安装…';
      setTimeout(() => { try { window.close(); } catch { /* 忽略 */ } }, 2500);
    } else if (el) {
      el.textContent += ' ｜ 已选择稍后安装';
    }
    return true;
  } catch (e) {
    if (el) { el.textContent = '更新失败：' + e.message; el.className = 'ds-status err'; }
    if (manual) uiAlert('更新失败：' + e.message, { title: '更新失败', type: 'err' });
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '检查更新'; }
  }
}

async function refreshDsStatus() {
  if ($('setProvider').value !== 'deepseek-web') return;
  try {
    const st = await api('/api/ai/deepseek/status');
    const el = $('dsStatus');
    const rounds = typeof st.roundCount === 'number'
      ? ` ｜ 轮次 ${st.roundCount}/${st.maxRounds}` + (st.roundCount >= st.maxRounds ? '（下次自动新对话）' : '')
      : '';
    const prompt = ` ｜ 提示词：${st.promptSet ? (st.promptSent ? '已发送' : '待发送') : '未设置'}`;
    const site = st.siteName ? ` ｜ 模型：${st.siteName}` : '';
    el.textContent = `状态：${st.state} — ${st.message || ''}${site}${rounds}${prompt}`;
    el.className = 'ds-status ' + (
      st.state === 'ready' ? 'ok'
        : st.state === 'need-login' ? 'warn'
          : st.state === 'error' ? 'err' : '');
  } catch { /* 忽略 */ }
}

// 停在「模型提供商」或「QQ 桥接」页时，每 3 秒刷新一次 DeepSeek / QQ 内核状态
setInterval(() => {
  const view = document.querySelector('.view.active');
  if (!view) return;
  const key = view.dataset.view;
  if (key === 'models' || key === 'cfg-ai') refreshDsStatus();
  if (key === 'cfg-engine') refreshEngineStatus();
}, 3000);

async function saveSettings() {
  /* saveSettings 里有些值（阈值、候选类型等）面板上没控件，要沿用服务端现值。
     打开设置时缓存一份，避免这里再发一次 GET。 */
  const interest = settingsCache.interest || {};
  const interestReply = settingsCache.interestReply || {};
  const proactive = settingsCache.proactive || {};
  const payload = {
    ai: {
      enabled: $('setEnabled').checked,
      provider: $('setProvider').value,
      webProvider: $('setWebSite') ? $('setWebSite').value : 'deepseek',
      cdpPort: Number($('setCdpPort').value) || 9222,
      browserPath: $('setBrowserPath').value.trim(),
      webPrompt: $('setWebPrompt').value,
      webMaxRounds: Number($('setWebMaxRounds').value) || 50,
      baseUrl: $('setBaseUrl').value.trim(),
      apiKey: $('setApiKey').value,
      model: $('setModel').value.trim(),
      scope: $('setScope').value,
      replyMode: $('setReplyMode').value,
      targetChatKeys: $('setReplyMode').value === 'target'
        ? Array.from($('setTargetChat').selectedOptions).map((o) => o.value).filter(Boolean)
        : [],
      requireMentionInGroup: $('setMention').checked,
      groupReplyChance: (() => { const v = Number($('setGroupChance').value); return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 100; })(),
      groupKeywords: $('setKeywords').value,
      imageReply: $('setImageReply').checked,
      groupAtSender: $('setGroupAt').checked,
      groupQuote: $('setGroupQuote').checked,
      quietEnabled: $('setQuietEnabled').checked,
      quietFrom: $('setQuietFrom').value || '23:00',
      quietTo: $('setQuietTo').value || '08:00',
      commandSenders: $('setCmdSenders').value,
      minIntervalMs: $('setCooldownEnabled').checked
        ? Math.max(0, Math.round((Number($('setCooldownSec').value) || 0) * 1000))
        : 0,
      systemPrompt: $('setPrompt').value
    },
    qq: {
      mode: $('setMode').value,
      onebot: {
        wsUrl: $('setWsUrl').value.trim() || 'ws://127.0.0.1:3001',
        accessToken: $('setToken').value
      },
      official: {
        appId: $('setQqbotAppId').value.trim(),
        clientSecret: $('setQqbotSecret').value,
        sandbox: $('setQqbotSandbox').checked
      },
      engine: {
        source: $('setEngineSource').value,
        // 选「内置」时界面里显示的是内置路径，不能把它存成「自定义目录」；
        // 但也不能存空 —— 那会把用户以前填的路径抹掉，切回「自定义」就没了。
        // 存 lastCustomEngineDir，后端在 bundled 模式下本来就不看这个字段。
        dir: $('setEngineSource').value === 'bundled'
          ? (lastCustomEngineDir || '')
          : $('setEngineDir').value.trim(),
        account: $('setEngineAccount').value.trim(),
        autoStart: $('setEngineAuto').checked
      }
    },
    update: {
      manifestUrl: $('setUpdateManifest').value.trim(),
      autoCheck: $('setUpdateAuto').checked
    },
    /* 这三段必须每次都带上：服务端 configLib.save 是 deepMerge 覆盖写，
       不传就等于没改；而传了不夹取，前端一个负数就能把闸门锁死。
       （长期记忆已移除，不再提交 memory 段——服务端也会忽略它） */
    interest: {
      enabled: true,
      capabilities: $('setInterestCaps').value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
      interjectThreshold: interest.interjectThreshold ?? 0.55,
      initiateThreshold: interest.initiateThreshold ?? 0.65,
      profileDecayPerDay: interest.profileDecayPerDay ?? 0.02
    },
    interestReply: {
      enabled: $('setInterestReply').checked,
      shadow: false,
      threshold: interestReply.threshold ?? 0.55
    },
    proactive: {
      enabled: $('setProactiveEnabled').checked,
      shadow: $('setProactiveShadow').checked,
      idleMin: Number($('setProIdleMin').value) || 25,
      minGroupMsgsToday: proactive.minGroupMsgsToday ?? 20,
      nightFrom: $('setProNightFrom').value || '00:00',
      nightTo: $('setProNightTo').value || '09:00',
      maxPerHour: Number($('setProMaxHour').value) || 0,
      maxPerDay: Number($('setProMaxDay').value) || 0,
      minGapMs: Math.max(0, (Number($('setProGapMin').value) || 0) * 60000),
      ignoreWindowSec: proactive.ignoreWindowSec ?? 600,
      settleMs: proactive.settleMs ?? 3000,
      targetChatKeys: $('setProactiveTargets').value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
      candidateKinds: proactive.candidateKinds || ['event', 'meme', 'fact']
    },
    moderation: {
      enabled: $('setModEnabled').checked,
      shadow: $('setModShadow').checked,
      autoPunish: $('setModAutoPunish').checked,
      /* 界面统一填 group:群号；服务端 whitelistChats 只收纯群号，这里剥前缀 */
      whitelistUsers: $('setModWhitelist').value.split(/[,，;；\s]+/).map((s) => s.trim()).filter((s) => s && !s.startsWith('group:')).join(','),
      whitelistChats: $('setModWhitelist').value.split(/[,，;；\s]+/).map((s) => s.trim()).filter((s) => s.startsWith('group:')).map((s) => s.slice(6)).join(','),
      spam: {
        windowSec: Math.min(120, Math.max(3, Number($('setModSpamWin').value) || 10)),
        maxMsgs: Math.min(60, Math.max(3, Number($('setModSpamMax').value) || 6)),
        muteMin: Math.min(43200, Math.max(1, Number($('setModSpamMute').value) || 5))
      },
      ad: {
        deleteMsg: $('setModAdDelete').checked,
        blockLinks: $('setModAdLinks').checked
      },
      banned: {
        words: $('setModBanned').value.trim(),
        notifyAdmin: $('setModBannedNotify').checked
      },
      duplicate: {
        windowSec: Math.min(600, Math.max(10, Number($('setModDupWin').value) || 60)),
        times: Math.min(10, Math.max(2, Number($('setModDupTimes').value) || 3)),
        notice: $('setModDupNotice').checked,
        deleteMsg: $('setModDupDel').checked
      },
      welcome: {
        text: $('setModWelcome').value
      },
      curfew: {
        from: $('setModCurfewFrom').value || '00:00',
        to: $('setModCurfewTo').value || '06:00',
        text: $('setModCurfewText').value
      }
    }
  };
  const resp = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }).catch((e) => {
    uiAlert('保存失败：' + e.message);
    return null;
  });
  if (!resp) return;
  settingsDirty = false;
  await refreshStatus();
  // 回读一次：服务端会夹取数值、把 Key 掩码掉，界面要跟真实存的一致
  await loadSettings().catch(() => {});
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  document.querySelectorAll('[data-save-settings]').forEach((b) => {
    b.textContent = '已保存 ' + stamp;
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.textContent = '保存'; }, 2200);
  });
  /* QQ 接入参数变了 → 服务端已自动重建适配器重连，明确告知，免得以为改了没生效 */
  if (resp && resp.qqReconnected) uiAlert('设置已保存。\n\n正在按新地址重连 QQ：\n' + payload.qq.onebot.wsUrl + '\n\n看顶部 QQ 状态，等它变成「已连接」即可。');
}

/* ---------------- SSE ---------------- */
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let evt;
    try { evt = JSON.parse(ev.data); } catch { return; }

    switch (evt.type) {
      case 'hello':
        state.status.qq = evt.qq;
        state.status.ai = evt.ai;
        renderStatus();
        break;
      case 'qq_status':
        state.status.qq = evt.status;
        if (evt.status?.self) state.self = evt.status.self;
        state.status.ai = evt.ai || state.status.ai;
        renderStatus();
        break;
      case 'deepseek_status':
        if (state.status.ai) state.status.ai.deepseek = evt.status;
        renderStatus();
        break;
      case 'settings_changed':
        state.status.ai = evt.ai;
        renderStatus();
        // 别处改了配置（卡片开关、另一个窗口、命令行）：配置页没在编辑就跟上。
        // 常驻表单里的旧值，会在下一次点「保存」时把新值整段覆盖回去。
        if (settingsLoaded && !settingsDirty) loadSettings().catch(() => {});
        break;
      case 'contacts_seeded':
        if (Array.isArray(evt.chats)) { state.chats = evt.chats; renderOverview(); }
        break;
      case 'message': {
        const m = evt.message;
        const name = m.chatName || chatLabel(`${m.chatType}:${m.chatId}`);
        state.stats.inMsgs++;
        pushFeed({
          kind: m.self ? 'out' : 'in',
          chatName: name,
          text: m.text,
          at: m.time || Date.now()
        });
        if (evt.chat) {
          const idx = state.chats.findIndex((c) => c.id === evt.chat.id);
          if (idx >= 0) state.chats[idx] = evt.chat;
          else state.chats.unshift(evt.chat);
          const c = state.chats.find((x) => x.id === evt.chat.id);
          if (c && !m.self) c.unread = (c.unread || 0) + 1;
          renderOverview();
          renderStats();
        }
        break;
      }
      case 'ai_replied':
        state.stats.aiReplies++;
        pushFeed({
          kind: 'ai',
          chatName: chatLabel(evt.chatId),
          text: evt.text,
          at: evt.at || Date.now()
        });
        renderStats();
        break;
      case 'ai_skip':
        state.stats.skips++;
        pushFeed({
          kind: 'skip',
          chatName: chatLabel(evt.chatId),
          reason: evt.reason,
          at: evt.at || Date.now()
        });
        renderStats();
        break;
      /* ---- 长期记忆 / 主动发言 ----
         这几种事件不刷首页 feed：它们频率低、信息是给「诊断」用的，
         塞进消息流只会干扰看聊天。只在设置面板里体现。 */
      case 'speak_decision':
      case 'proactive_decision':
        if (!$('proactiveLog')) break;
        refreshProactiveLog();
        break;
      case 'proactive_sent':
        pushFeed({
          kind: 'ai',
          chatName: chatLabel((evt.chatKey || '').split(':')[1]),
          text: evt.text || '（主动开口）',
          at: evt.at || Date.now()
        });
        refreshProactiveLog();
        break;
      case 'proactive_skipped':
        if ($('proactiveLog')) refreshProactiveLog();
        break;
      case 'moderation':
        /* 群管事件：拦截/欢迎/宵禁提醒。开关没开时不会有这种事件。 */
        if ($('modStatsBox') && !$('modStatsBox').style.display.includes('none')) refreshModStats();
        break;
      case 'ai_error':
        pushFeed({
          kind: 'err',
          chatName: chatLabel(evt.chatId),
          text: evt.message,
          at: evt.at || Date.now()
        });
        break;
      case 'engine_status':
        // 扫码登录完成 / 内核退出，状态灯和二维码跟着变，用户不用手动刷新
        if (evt.engine) applyEngineStatus(evt.engine);
        break;
      case 'ai_context_reset':
        pushFeed({
          kind: 'skip',
          chatName: evt.chatId ? chatLabel(evt.chatId) : '全部会话',
          reason: '已新建对话（AI 记忆已清空）',
          at: evt.at || Date.now()
        });
        break;
    }
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}

/* ---------------- 初始化 ---------------- */

/* ---------------- 主视图外壳：导航与卡片开关的接线 ---------------- */
/** 把卡片开关的状态同步到当前配置（每次状态刷新都调一次） */
function renderShellToggles() {
  const qq = (state.status && state.status.qq) || {};
  const ai = (state.status && state.status.ai) || {};
  const mode = qq.mode || 'onebot';
  const setChk = (id, on) => { const el = $(id); if (el) el.checked = !!on; };
  setChk('botOnebotToggle', mode === 'onebot');
  setChk('botQqbotToggle', mode === 'qqbot');
  setChk('botMockToggle', mode === 'mock');
  setChk('botDsToggle', ai.provider === 'deepseek-web');
  setChk('botApiToggle', ai.provider === 'openai-compatible');
  setChk('botBuiltinToggle', ai.provider === 'builtin');

  const card = (bot) => document.querySelector('.bot-card[data-bot="' + bot + '"]');
  ['onebot', 'qqbot', 'mock'].forEach((b) => {
    const el = card(b);
    if (el) el.classList.toggle('on', mode === b);
  });
  const mcard = (m) => document.querySelector('.bot-card[data-model="' + m + '"]');
  ['deepseek-web', 'openai-compatible', 'builtin'].forEach((m) => {
    const el = mcard(m);
    if (el) el.classList.toggle('on', ai.provider === m);
  });

  const qqbotState = $('botQqbotState');
  if (qqbotState) {
    const on = mode === 'qqbot';
    qqbotState.textContent = on ? (qq.connected ? '已连接' : (qq.message || '连接中…')) : '未启用';
    qqbotState.className = 'bot-status ' + (on ? (qq.connected ? 'ok' : 'warn') : 'dim');
  }
  const mockState = $('botMockState');
  if (mockState) {
    const on = mode === 'mock';
    mockState.textContent = on ? '演示运行中' : '未启用';
    mockState.className = 'bot-status ' + (on ? 'ok' : 'dim');
  }
  const apiState = $('botApiState');
  if (apiState) {
    const on = ai.provider === 'openai-compatible';
    apiState.textContent = on ? (ai.model ? '使用中：' + ai.model : '使用中（未填模型）') : '未启用';
    apiState.className = 'bot-status ' + (on ? 'ok' : 'dim');
  }
  const builtinState = $('botBuiltinState');
  if (builtinState) {
    const on = ai.provider === 'builtin';
    builtinState.textContent = on ? '使用中' : '未启用';
    builtinState.className = 'bot-status ' + (on ? 'ok' : 'dim');
  }
  const badge = $('navChatCount');
  if (badge) badge.textContent = state.chats && state.chats.length ? String(state.chats.length) : '';
}

/** 卡片上的「启动桥接」：不依赖设置面板里的输入框，直接用已保存的配置 */
async function startBridgeFromCard(btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '启动中…';
  try {
    const r = await api('/api/engine/start', { method: 'POST', body: '{}' });
    if (r.ok) {
      await refreshStatus();
      if (r.needLogin) {
        uiAlert('QQ 桥接已经起来了，第一次登录要扫码。\n\n已经帮你打开「QQ 桥接」设置页，二维码在那里。', { title: '需要扫码登录', type: 'warn' });
        await openSettingsAt('engine');
      } else {
        uiAlert('QQ 桥接已就绪' + (r.login ? '：' + r.login : ''), { title: '已启动', type: 'ok' });
      }
    } else {
      uiAlert('启动失败：' + (r.error || '未知错误'), { title: '启动失败', type: 'err' });
    }
  } catch (e) {
    uiAlert('启动失败：' + e.message, { title: '启动失败', type: 'err' });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/** 接线：左侧导航、卡片开关、欢迎页按钮 */
function initShellNav() {
  // 一个入口：凡是带 data-view 的可点元素（侧栏项、卡片上的「编辑」「填 Key」「桥接设置」等）
  // 都跳到对应视图。section.view 本身也带 data-view，所以只挑 button/a。
  document.querySelectorAll('button[data-view], a[data-view]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(b.dataset.view);
    });
  });

  // 机器人接入方式开关：打开一个就关掉其他（后端只认一个 mode）
  const botToggle = (id, mode) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (!el.checked) { renderShellToggles(); return; }   // 不允许通过关掉来「断开」，只能切到另一个
      switchBotMode(mode);
    });
  };
  botToggle('botOnebotToggle', 'onebot');
  botToggle('botQqbotToggle', 'qqbot');
  botToggle('botMockToggle', 'mock');

  const provToggle = (id, provider) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', () => {
      if (!el.checked) { renderShellToggles(); return; }
      switchProvider(provider);
    });
  };
  provToggle('botDsToggle', 'deepseek-web');
  provToggle('botApiToggle', 'openai-compatible');
  provToggle('botBuiltinToggle', 'builtin');

  const startBtn = $('btnBotOnebotStart');
  if (startBtn) startBtn.addEventListener('click', () => startBridgeFromCard(startBtn));

  // 欢迎页三步按钮
  const wq = $('btnWelcomeQq');
  if (wq) wq.addEventListener('click', () => openSettingsAt('engine'));
  const wd = $('btnWelcomeDs');
  if (wd) wd.addEventListener('click', async () => {
    wd.disabled = true;
    const old = wd.textContent;
    wd.textContent = '启动中…';
    try {
      await api('/api/ai/deepseek/open', { method: 'POST' });
      showDeepSeekTab();
      setTimeout(() => refreshStatus().catch(() => {}), 2500);
    } catch (e) {
      uiAlert('打开失败：' + e.message, { title: '打开失败', type: 'err' });
    } finally {
      wd.disabled = false;
      wd.textContent = old;
    }
  });
  const wr = $('btnWelcomeReply');
  if (wr) wr.addEventListener('click', async () => {
    const ai = (state.status && state.status.ai) || {};
    wr.disabled = true;
    try {
      const next = !ai.enabled;
      await api('/api/ai/toggle', { method: 'POST', body: JSON.stringify({ enabled: next }) });
      await refreshStatus();
      // 配置页里的同名开关跟着变，否则它下次保存会把这里改的覆盖回去
      if ($('setEnabled')) $('setEnabled').checked = next;
    } catch (e) {
      uiAlert('切换失败：' + e.message, { title: '切换失败', type: 'err' });
    } finally {
      wr.disabled = false;
    }
  });
}

function init() {
  initShellNav();
  initQzDialog();
  initDeepSeekSlot();
  initTheme();
  $('btnServiceStop').addEventListener('click', async () => {
    if (!IN_DESKTOP_HOST) return;
    const ok = await uiConfirm(
      '停止服务后 QQ 机器人会下线；桌面窗口仍会保留，可以随时重新启动。\n\n确定停止服务吗？',
      { title: '停止服务', okText: '停止服务', cancelText: '取消', type: 'warn' }
    );
    if (!ok) return;
    const btn = $('btnServiceStop');
    btn.disabled = true;
    btn.innerHTML = '<span class="service-dot"></span>停止中…';
    try {
      window.chrome.webview.postMessage({ type: 'service-stop' });
      // 正常情况下服务会停掉、页面被宿主盖住；如果宿主没响应，6 秒后恢复按钮
      setTimeout(() => {
        try {
          btn.disabled = false;
          btn.innerHTML = '<span class="service-dot"></span>停止服务';
        } catch (e) { /* 忽略 */ }
      }, 6000);
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = '<span class="service-dot"></span>停止服务';
      uiAlert('停止失败：' + err.message, { title: '停止失败', type: 'err' });
    }
  });
  // 每个配置页都有自己的「保存」按钮，共用同一套取值逻辑
  document.querySelectorAll('[data-save-settings]').forEach((btn) => {
    btn.addEventListener('click', saveSettings);
  });
  const modeSel = $('setMode');
  if (modeSel) modeSel.addEventListener('change', toggleQqMode);
  $('setCooldownEnabled').addEventListener('change', () => {
    $('setCooldownSec').disabled = !$('setCooldownEnabled').checked;
  });
  $('setProvider').addEventListener('change', () => { toggleProviderView(); refreshDsStatus(); });
  $('setReplyMode').addEventListener('change', toggleTargetView);
  $('btnEngineDetect').addEventListener('click', detectEngine);
  $('btnEngineStart').addEventListener('click', startEngine);
  $('btnEngineStop').addEventListener('click', stopEngine);
  $('btnEngineWebui').addEventListener('click', openEngineWebui);
  const panelFrame = $('enginePanelFrame');
  if (panelFrame) {
    panelFrame.addEventListener('load', () => {
      const src = panelFrame.getAttribute('src') || '';
      if (!src || src === 'about:blank') return;
      const loading = $('enginePanelLoading');
      if (loading) loading.classList.add('hidden');
      clearTimeout(openEngineWebui._t);
    });
  }
  if ($('btnEnginePanelClose')) $('btnEnginePanelClose').addEventListener('click', closeEnginePanel);
  if ($('btnEnginePanelReload')) $('btnEnginePanelReload').addEventListener('click', reloadEnginePanel);
  if ($('btnEnginePanelExternal')) $('btnEnginePanelExternal').addEventListener('click', enginePanelExternal);
  if ($('enginePanel')) {
    $('enginePanel').addEventListener('click', (e) => {
      if (e.target === $('enginePanel')) closeEnginePanel();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('enginePanel') && !$('enginePanel').classList.contains('hidden')) {
      closeEnginePanel();
    }
  });
  $('setEngineSource').addEventListener('change', toggleEngineDir);
  $('btnUpdateCheck').addEventListener('click', () => checkUpdate(true));
  const modStatsBtn = $('btnModStats');
  if (modStatsBtn) modStatsBtn.addEventListener('click', toggleModStats);
  initQqbotBind();
  $('btnDsExpand').addEventListener('click', showDeepSeekTab);
  $('btnDsOpen').addEventListener('click', async (e) => {
    e.target.textContent = '启动中…';
    try {
      await api('/api/ai/deepseek/open', { method: 'POST' });
      setTimeout(refreshDsStatus, 2500);
    } catch (err) {
      uiAlert('打开失败：' + err.message);
    } finally {
      // 内嵌模式直接切到桌面宿主里的 DeepSeek 标签页，
      // 不再让服务端去 /json/new 开新窗口。
      showDeepSeekTab();
      e.target.textContent = '① 打开 DeepSeek 登录';
    }
  });
  $('btnDsNew').addEventListener('click', async (e) => {
    e.target.textContent = '处理中…';
    try {
      const r = await api('/api/ai/deepseek/new', { method: 'POST' });
      if (!r || !r.ok) throw new Error('DeepSeek 页面未就绪，稍后再试');
      e.target.textContent = '② 已新建对话';
      setTimeout(() => { e.target.textContent = '② 新建对话'; }, 1500);
    } catch (err) {
      e.target.textContent = '② 新建对话';
      showDeepSeekTab();
      uiAlert('新建对话失败：' + err.message);
    }
    refreshDsStatus();
  });
  $('btnDsTest').addEventListener('click', async (e) => {
    e.target.textContent = '等待 DeepSeek…';
    $('dsStatus').textContent = '状态：thinking — 已发送测试消息，正在等待回复…';
    const r = await api('/api/ai/deepseek/test', { method: 'POST', body: JSON.stringify({ text: '用一句话跟朋友说你晚上有空吃饭。' }) }).catch((err) => ({ ok: false, error: err.message }));
    e.target.textContent = '③ 测试回复';
    if (r.ok) {
      $('dsStatus').textContent = `✅ 测试成功（${r.ms}ms）：${r.reply}`;
      $('dsStatus').className = 'ds-status ok';
    } else {
      $('dsStatus').textContent = `❌ 失败：${r.error}`;
      $('dsStatus').className = 'ds-status err';
    }
  });
  $('aiToggle').addEventListener('change', async (e) => {
    try {
      await api('/api/ai/toggle', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) });
      await refreshStatus();
      // 配置页里那个同名开关必须跟着变，否则下次在配置页点「保存」
      // 会把这里刚改的值原样写回去（表单是整段覆盖，不是补丁）。
      if ($('setEnabled')) $('setEnabled').checked = e.target.checked;
    } catch (err) {
      e.target.checked = !e.target.checked;
      uiAlert('切换失败：' + err.message);
    }
  });
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => $(b.dataset.close).classList.add('hidden'));
  });
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  });

  // API Key 的语义是「留空 = 保持不变」，所以要删掉这把 Key 必须有独立入口
  if ($('btnApiKeyClear')) $('btnApiKeyClear').addEventListener('click', async () => {
    if (!(await uiConfirm('清除已保存的 API Key？\n\n清掉后 API 模式将不可用，需要重新填一把才能继续用。', { title: '清除 API Key', okText: '清除', cancelText: '取消', type: 'warn' }))) return;
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ ai: { clearApiKey: true } })
      });
      $('setApiKey').value = '';
      $('setApiKey').placeholder = '留空则不可用';
      $('btnApiKeyClear').hidden = true;
      uiAlert('已清除。要重新使用 API 模式，请填一把新的 Key。', { title: '已清除', type: 'ok' });
    } catch (e) {
      uiAlert('清除失败：' + e.message, { title: '操作失败', type: 'err' });
    }
  });

  // 表情包
  async function runApiTest() {
    const st = $('apiStatus');
    if (st) {
      st.textContent = '状态：正在连接接口并测速（deepseek 官方接口会顺带查余额）…';
      st.className = 'ds-status';
    }
    const r = await api('/api/ai/api/test', {
      method: 'POST',
      body: JSON.stringify({
        baseUrl: $('setBaseUrl') ? $('setBaseUrl').value : '',
        apiKey: $('setApiKey') ? $('setApiKey').value : '',
        model: $('setModel') ? $('setModel').value : ''
      })
    }).catch((err) => ({ ok: false, error: err.message }));
    let line;
    if (r.ok) {
      line = `✅ 可用（延迟 ${r.latencyMs}ms，模型 ${r.model}）`;
      line += (typeof r.balance === 'number') ? ` ｜ 余额 ${r.balance}` : ` ｜ ${r.balanceNote}`;
    } else {
      line = `❌ 失败（${r.latencyMs ? r.latencyMs + 'ms，' : ''}${r.error}）`;
    }
    if (st) {
      st.textContent = line;
      st.className = 'ds-status ' + (r.ok ? 'ok' : 'err');
    }
    return r;
  }
  $('btnApiTest').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '测试中…';
    try { await runApiTest(); } finally {
      e.target.disabled = false;
      e.target.textContent = '测试连接 / 测速 / 余额';
    }
  });

  /* API 模式「新建对话」= 清空喂给模型的上下文记忆 */
  async function runApiNew(btn) {
    const sel = $('setApiNewTarget');
    const chatId = sel && sel.value ? sel.value : '';
    const label = sel && sel.selectedOptions.length ? sel.selectedOptions[0].textContent : '全部会话';
    if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
    try {
      const r = await api('/api/ai/api/new', {
        method: 'POST',
        body: JSON.stringify({ chatId })
      });
      if (!r || !r.ok) throw new Error((r && r.error) || '重置失败');
      const st = $('apiStatus');
      if (st) {
        st.textContent = `✅ 已新建对话：${label} 的 AI 记忆已清空（聊天记录仍保留）`;
        st.className = 'ds-status ok';
      }
      const cardSub = $('cardDsSub');
      if (cardSub) cardSub.textContent = '已新建对话（记忆已清空）';
      return r;
    } catch (err) {
      const st = $('apiStatus');
      if (st) { st.textContent = `❌ 新建对话失败：${err.message}`; st.className = 'ds-status err'; }
      return null;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.id === 'btnCardApiNew' ? '新建对话' : '新建对话（清空 AI 记忆）'; }
    }
  }
  if ($('btnApiNew')) $('btnApiNew').addEventListener('click', (e) => runApiNew(e.target));
  if ($('btnCardApiNew')) $('btnCardApiNew').addEventListener('click', (e) => runApiNew(e.target));
  if ($('btnCardApiTest')) {
    $('btnCardApiTest').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = '测试中…';
      const cardSub = $('cardDsSub');
      const keep = cardSub ? cardSub.textContent : '';
      if (cardSub) cardSub.textContent = '正在连接接口并测速…';
      try {
        const r = await runApiTest();
        if (cardSub) {
          if (r.ok) {
            cardSub.textContent = `✅ ${r.latencyMs}ms` + ((typeof r.balance === 'number') ? ` ｜ 余额 ${r.balance}` : '');
          } else {
            cardSub.textContent = `❌ ${r.error}`;
          }
        }
      } finally {
        e.target.disabled = false;
        e.target.textContent = '测速 / 检查可用 / 余额';
        if (cardSub && !cardSub.textContent.trim()) cardSub.textContent = keep;
      }
    });
  }
  $('btnStickerTest').addEventListener('click', testSticker);
  $('btnStickerClear').addEventListener('click', clearStickers);
  if ($('btnGalleryRefresh')) $('btnGalleryRefresh').addEventListener('click', refreshGalleryForce);
  if ($('btnProactiveLog')) $('btnProactiveLog').addEventListener('click', refreshProactiveLog);
  if ($('btnProactiveKill')) $('btnProactiveKill').addEventListener('click', killProactive);
  $('btnWebOpen').addEventListener('click', openWebSite);

  // 配置页任何控件被改动就置脏，避免后台回读把正在填的内容冲掉
  document.querySelectorAll('.views .view[data-view^="cfg-"]').forEach((v) => {
    const mark = () => { settingsDirty = true; };
    v.addEventListener('input', mark);
    v.addEventListener('change', mark);
  });

  switchView('welcome');
  renderFeed();
  loadSettings().catch(() => {});
  refreshStatus().catch(() => {});
  refreshChats().catch(() => {});
  connectEvents();
  setInterval(() => refreshStatus().catch(() => {}), 15000);
  setInterval(() => refreshChats().catch(() => {}), 30000);

  // 启动后自动检查：只检查版本，发现新版本也必须用户确认后才下载。
  setTimeout(async () => {
    try {
      const cfg = await api('/api/settings');
      if (cfg.update?.autoCheck !== false) checkUpdate(false);
    } catch { /* 忽略 */ }
  }, 9000);
}

init();








