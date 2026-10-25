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

function dsSlotBlocked() {
  const sm = $('settingsModal');
  const qd = $('qzDialog');
  return !!((sm && !sm.classList.contains('hidden')) || (qd && !qd.classList.contains('hidden')));
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
  ['settingsModal', 'qzDialog'].forEach((id) => {
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
  stats: { inMsgs: 0, aiReplies: 0, skips: 0 }
};

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
  }
  const qq = state.status.qq || {};
  const pill = $('qqStatusPill');
  pill.classList.toggle('on', !!qq.connected);
  pill.classList.toggle('off', !qq.connected);
  $('qqStatusText').textContent = qq.message || (qq.connected ? '已连接' : '未连接');

  const self = state.self || {};
  $('cardQqMain').textContent = qq.connected ? '已连接' : '未连接';
  $('cardQqMain').className = 'card-main ' + (qq.connected ? 'ok' : 'bad');
  $('cardQqSub').textContent = self.nickname
    ? `账号 ${self.nickname} (${self.userId})`
    : (qq.connected ? '已连接 OneBot' : '等待接入…');

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
    $('cardDsMain').textContent = '未使用';
    $('cardDsMain').className = 'card-main dim';
    $('cardDsSub').textContent = '当前大脑：' + (ai.providerLabel || '—');
  }

  renderStats();
}

function renderStats() {
  $('cardStatMain').textContent = `${state.stats.inMsgs} 收 / ${state.stats.aiReplies} 回`;
  $('cardStatSub').textContent = `会话 ${state.chats.length} · 跳过 ${state.stats.skips}`;
}

/* ---------------- 会话概览 ---------------- */
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
}

async function refreshStatus() {
  const data = await api('/api/status');
  state.status = { qq: data.qq, ai: data.ai };
  state.version = data.version || state.version;
  state.self = data.self;
  renderStatus();
}

/* ---------------- 设置 ---------------- */
async function openSettings() {
  const data = await api('/api/settings');
  const ai = data.ai || {};
  $('setProvider').value = ai.provider || 'deepseek-web';
  $('setEnabled').checked = !!ai.enabled;
  $('setBaseUrl').value = ai.baseUrl || '';
  $('setApiKey').value = ai.apiKey || '';
  $('setApiKey').placeholder = ai.hasKey ? '已配置（留空保持不变）' : '留空则不可用';
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
  $('setMode').value = data.qq?.mode || 'mock';
  $('setWsUrl').value = data.qq?.onebot?.wsUrl || 'ws://127.0.0.1:3001';
  $('setToken').value = data.qq?.onebot?.accessToken || '';
  // Token 只回后 4 位；留空保存 = 清除
  $('setToken').placeholder = data.qq?.onebot?.hasToken ? '留空 = 清除（当前已配置）' : '与 OneBot 运行时里填的一致，没有就留空';
  const eng = data.qq?.engine || {};
  $('setEngineSource').value = eng.source || 'auto';
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
  refreshStickers();
  refreshGallery();
  $('settingsModal').classList.remove('hidden');
}

function toggleTargetView() {
  $('targetWrap').classList.toggle('hidden', $('setReplyMode').value !== 'target');
}

function toggleProviderView() {
  const p = $('setProvider').value;
  $('webOnly').classList.toggle('hidden', p !== 'deepseek-web');
  $('apiOnly').classList.toggle('hidden', p === 'deepseek-web');
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

function toggleEngineDir() {
  const src = $('setEngineSource').value;
  const wrap = $('setEngineDir').closest('label');
  if (wrap) wrap.style.opacity = src === 'bundled' ? '.45' : '1';
  $('setEngineDir').disabled = src === 'bundled';
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
  const who = e.account ? `账号 ${e.account}` : '未指定账号';
  const from = e.kind ? `${e.kind === 'napcat' ? 'NapCat' : e.kind}` : '未知运行时';
  const src = e.source === 'bundled' ? '内置' : (e.source === 'custom' ? '自定义' : '自动');
  const where = e.dir ? e.dir : '未找到目录';
  const state = e.running ? '运行中' : (e.needLogin ? '等你扫码登录' : '未运行');
  el.textContent = `状态：${state} ｜ ${src}·${from} ｜ ${who} ｜ WS ${e.wsPort || '-'} ｜ ${where}` +
    (e.lastError ? ` ｜ ${e.lastError}` : '');
  el.className = 'ds-status ' + (e.running ? 'ok' : (e.lastError ? 'err' : 'warn'));
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
        dir: $('setEngineDir').value.trim(),
        account: $('setEngineAccount').value.trim()
      })
    });
    if (r.ok) {
      $('setEngineDir').value = r.engine.dir;
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
        dir: $('setEngineDir').value.trim(),
        account: $('setEngineAccount').value.trim()
      })
    });
    if (r.ok) {
      $('setEngineDir').value = r.info.dir;
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

    if (el) { el.textContent = `状态：正在下载 v${r.latest}…`; el.className = 'ds-status warn'; }
    const d = await api('/api/update/download', { method: 'POST', body: '{}' });
    if (!d.ok) throw new Error(d.error || '下载失败');
    if (el) {
      el.textContent = `状态：v${r.latest} 已下载，SHA256 校验通过（${Math.round((d.bytes || 0) / 1024)} KB）`;
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

// 设置面板打开期间，每 3 秒刷新一次 DeepSeek / QQ 内核状态
setInterval(() => {
  const modal = document.getElementById('settingsModal');
  if (modal && !modal.classList.contains('hidden')) {
    refreshDsStatus();
    refreshEngineStatus();
  }
}, 3000);

async function saveSettings() {
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
      engine: {
        source: $('setEngineSource').value,
        dir: $('setEngineDir').value.trim(),
        account: $('setEngineAccount').value.trim(),
        autoStart: $('setEngineAuto').checked
      }
    },
    update: {
      manifestUrl: $('setUpdateManifest').value.trim(),
      autoCheck: $('setUpdateAuto').checked
    }
  };
  const resp = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }).catch((e) => {
    uiAlert('保存失败：' + e.message);
    return null;
  });
  if (!resp) return;
  $('settingsModal').classList.add('hidden');
  await refreshStatus();
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
    }
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}

/* ---------------- 初始化 ---------------- */
function init() {
  initQzDialog();
  initDeepSeekSlot();
  initTheme();
  $('btnSettings').addEventListener('click', () => {
    openSettings().catch((e) => uiAlert('读取设置失败：' + e.message));
  });
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
  $('btnSaveSettings').addEventListener('click', saveSettings);
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

  // 表情包
  $('btnStickerTest').addEventListener('click', testSticker);
  $('btnStickerClear').addEventListener('click', clearStickers);
  if ($('btnGalleryRefresh')) $('btnGalleryRefresh').addEventListener('click', refreshGalleryForce);
  $('btnWebOpen').addEventListener('click', openWebSite);

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








