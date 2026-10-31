/* ============================================================
   群崽 QunZai — 官网 v2 · 整屏滚动交互
   ============================================================ */
(function () {
  'use strict';

  var deck = document.getElementById('deck');
  var panes = Array.prototype.slice.call(document.querySelectorAll('.pane'));
  var dotsBox = document.getElementById('dots');
  var prog = document.getElementById('prog');
  var cur = 0;

  /* ---------- 生成右侧导航点 ---------- */
  panes.forEach(function (p, i) {
    var a = document.createElement('a');
    a.href = '#' + p.id;
    a.setAttribute('aria-label', p.dataset.label || ('第 ' + (i + 1) + ' 屏'));
    var s = document.createElement('span');
    s.textContent = p.dataset.label || ('第 ' + (i + 1) + ' 屏');
    a.appendChild(s);
    a.addEventListener('click', function (e) {
      e.preventDefault();
      go(i);
    });
    dotsBox.appendChild(a);
  });
  var dotEls = Array.prototype.slice.call(dotsBox.children);

  /* ---------- 滚动到第 i 屏 ---------- */
  function go(i) {
    i = Math.max(0, Math.min(panes.length - 1, i));
    panes[i].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- 入场 / 出场 ---------- */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting && en.intersectionRatio > 0.45) {
        en.target.classList.add('on');
      } else if (en.intersectionRatio < 0.2) {
        en.target.classList.remove('on');
      }
    });
  }, { root: deck, threshold: [0, 0.2, 0.45, 0.75] });
  panes.forEach(function (p) { io.observe(p); });

  /* ---------- 当前屏高亮 + 进度条 ---------- */
  function updateUI() {
    var scrollTop = deck.scrollTop;
    var total = deck.scrollHeight - deck.clientHeight;
    var pct = total > 0 ? (scrollTop / total) * 100 : 0;
    if (prog) prog.style.width = pct.toFixed(2) + '%';

    var best = 0, bestDist = Infinity;
    panes.forEach(function (p, i) {
      var d = Math.abs(p.offsetTop - scrollTop);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (best !== cur) {
      cur = best;
      dotEls.forEach(function (el, i) { el.classList.toggle('on', i === best); });
    }
  }
  deck.addEventListener('scroll', function () {
    if (!updateUI._raf) {
      updateUI._raf = requestAnimationFrame(function () {
        updateUI._raf = null;
        updateUI();
      });
    }
  }, { passive: true });

  /* ---------- 键盘翻屏 ---------- */
  var lock = false;
  function step(dir) {
    if (lock) return;
    lock = true;
    go(cur + dir);
    setTimeout(function () { lock = false; }, 620);
  }
  window.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    switch (e.key) {
      case 'ArrowDown': case 'PageDown': case ' ':
        e.preventDefault(); step(1); break;
      case 'ArrowUp': case 'PageUp':
        e.preventDefault(); step(-1); break;
      case 'Home':
        e.preventDefault(); go(0); break;
      case 'End':
        e.preventDefault(); go(panes.length - 1); break;
    }
  }, { passive: false });

  /* ---------- 触控板 / 鼠标滚轮整屏吸附 ---------- */
  var wheelAcc = 0, wheelTimer = null, wheelLock = false;
  deck.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaY) < 4) return;
    if (e.ctrlKey) return;               // 让浏览器缩放正常工作
    // 屏内可滚动内容（极少数）时放行
    var pane = panes[cur];
    if (pane && pane.scrollHeight > pane.clientHeight + 8) {
      var inner = e.target.closest('.pane');
      if (inner && inner.scrollHeight > inner.clientHeight + 8) return;
    }
    e.preventDefault();
    if (wheelLock) return;

    wheelAcc += e.deltaY;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(function () { wheelAcc = 0; }, 180);

    if (Math.abs(wheelAcc) > 60) {
      var dir = wheelAcc > 0 ? 1 : -1;
      wheelAcc = 0;
      wheelLock = true;
      go(cur + dir);
      setTimeout(function () { wheelLock = false; }, 680);
    }
  }, { passive: false });

  /* ---------- 移动端触摸滑动 ---------- */
  var tY = 0, tLock = false;
  deck.addEventListener('touchstart', function (e) {
    tY = e.touches[0].clientY;
  }, { passive: true });
  deck.addEventListener('touchend', function (e) {
    if (tLock) return;
    var d = tY - e.changedTouches[0].clientY;
    if (Math.abs(d) > 55) {
      tLock = true;
      go(cur + (d > 0 ? 1 : -1));
      setTimeout(function () { tLock = false; }, 700);
    }
  }, { passive: true });

  /* ---------- 初始化 ---------- */
  // 首屏直接点亮（避免 IntersectionObserver 延迟导致首屏空白）
  panes[0].classList.add('on');
  dotEls[0].classList.add('on');
  updateUI();

  // 支持带 hash 直接进入
  if (location.hash) {
    var t = document.querySelector(location.hash);
    if (t) setTimeout(function () { t.scrollIntoView({ block: 'start' }); }, 60);
  }

  // 视频帧图片加载失败时降级（不阻塞布局）
  document.querySelectorAll('img').forEach(function (img) {
    img.addEventListener('error', function () {
      img.style.visibility = 'hidden';
    });
  });
})();
