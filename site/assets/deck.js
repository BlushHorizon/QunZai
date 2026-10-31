/* ============================================================
   群崽 QunZai — 官网 v3 · 滚动驱动引擎
   整页连续滚动（不吸附、不翻页），滚动位置直接驱动每个元素的状态。
   不用 IntersectionObserver：改为每帧按 getBoundingClientRect 计算，
   这样在任何环境（含后台标签页、截图工具）都表现一致。

   每个 [data-rise]/[data-fade]/[data-wipe]/[data-zoom] 元素：
     - 进入视口下沿 88% 处开始播
     - 到视口 55% 处播完（约 300px 的滚动行程）
   [data-stagger] 的子元素按 --d 依次错峰。
   ============================================================ */
(function () {
  'use strict';

  var top = document.querySelector('.top');
  var prog = document.getElementById('progFill');

  /* ---------- 1. 逐条错峰：给 [data-stagger] 的子元素设 --d ---------- */
  document.querySelectorAll('[data-stagger]').forEach(function (box) {
    var step = parseFloat(box.getAttribute('data-step')) || 0.075;
    Array.prototype.forEach.call(box.children, function (c, i) {
      c.style.setProperty('--d', (i * step).toFixed(3) + 's');
    });
  });

  /* ---------- 2. 收集所有动画元素 ---------- */
  var anim = Array.prototype.slice.call(
    document.querySelectorAll('[data-rise],[data-fade],[data-wipe],[data-zoom],[data-stagger]')
  );

  // 预读每个元素的「延迟秒数」，转成滚动进度上的偏移
  // 1 秒延迟 ≈ 0.10 的进度偏移（滚动 ~300px 播完时，0.3s 延迟刚好错开）
  anim.forEach(function (el) {
    var d = parseFloat((el.style.getPropertyValue('--d') || '0').replace('s', '')) || 0;
    el._delay = d;
    el._shown = false;
  });

  /* ---------- 3. 每帧计算 ---------- */
  var paraEls = Array.prototype.slice.call(document.querySelectorAll('[data-para]'));
  var ticking = false;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(v) { return v * v * (3 - 2 * v); }

  function render() {
    var vh = window.innerHeight || 900;
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var max = Math.max(1, document.documentElement.scrollHeight - vh);

    // 顶部进度条
    if (prog) prog.style.width = (clamp01(y / max) * 100).toFixed(2) + '%';
    // 顶栏实心化
    if (top) top.classList.toggle('solid', y > 40);

    // 每个动画元素：按它在视口中的位置决定进度
    // start = 元素顶部到达视口 88% 高度时开始；end = 到达 55% 时结束
    for (var i = 0; i < anim.length; i++) {
      var el = anim[i];
      var r = el.getBoundingClientRect();

      var startY = vh * 0.88;
      var endY = vh * 0.55;
      var p = (startY - r.top) / (startY - endY);   // 0 = 刚进, 1 = 播完
      p = clamp01(p);

      // 应用元素自身延迟（延迟越大，需要滚得越深才播完）
      if (el._delay > 0) {
        p = clamp01((p - el._delay * 0.55) / (1 - el._delay * 0.55));
      }

      var e = smooth(p);

      // 写回 CSS 变量，让 CSS 的 transition 负责平滑
      el.style.setProperty('--p', e.toFixed(3));

      // 超过阈值就加 .in（CSS 里 .in 是终态；同时 --p 提供连续插值）
      var shouldIn = e > 0.02;
      if (shouldIn !== el._shown) {
        el._shown = shouldIn;
        el.classList.toggle('in', shouldIn);
      }
    }

    // 视差
    for (var j = 0; j < paraEls.length; j++) {
      var pe = paraEls[j];
      var pr = pe.getBoundingClientRect();
      if (pr.bottom < -300 || pr.top > vh + 300) continue;
      var t = (pr.top + pr.height / 2 - vh / 2) / vh;
      var amt = parseFloat(pe.getAttribute('data-para')) || 18;
      pe.style.transform = 'translate3d(0,' + (t * amt).toFixed(2) + 'px,0)';
    }

    ticking = false;
  }

  /* ---------- 3b. 滚动事件同步计算 ----------
     直接同步跑 render（115 个元素约 0.4ms，可忽略），
     不依赖 rAF —— 后台标签页/截图环境里 rAF 可能不触发。 */
  window.addEventListener('scroll', render, { passive: true });
  window.addEventListener('resize', render, { passive: true });
  window.addEventListener('load', render);
  window.addEventListener('DOMContentLoaded', render);
  document.addEventListener('scroll', render, { passive: true });
  window.__deckRender = render;   // 便于自动化验证/调试
  render();
  setTimeout(render, 60);
  setTimeout(render, 300);

  /* 兜底轮询：某些环境（后台标签页、自动化截图）不派发 scroll 事件。
     只在滚动位置真的变化时才重算，正常浏览时几乎零成本。 */
  var _ly = -1, _lvh = -1;
  setInterval(function () {
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var vh = window.innerHeight || 900;
    if (y !== _ly || vh !== _lvh) { _ly = y; _lvh = vh; render(); }
  }, 120);

  /* ---------- 4. 锚点平滑滚动（留顶栏高度） ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    var href = a.getAttribute('href');
    if (!href || href === '#' || href.length < 2) return;
    var target = document.getElementById(href.slice(1));
    if (!target) return;
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      var topOffset = target.getBoundingClientRect().top + window.pageYOffset - 76;
      window.scrollTo({ top: Math.round(topOffset), behavior: 'smooth' });
      history.replaceState(null, '', href);
    });
  });

  /* ---------- 5. 图片加载失败降级 ---------- */
  document.querySelectorAll('img').forEach(function (img) {
    img.addEventListener('error', function () {
      var p = img.parentElement;
      if (p) p.style.background = 'rgba(255,255,255,.04)';
      img.style.visibility = 'hidden';
    });
  });
})();
