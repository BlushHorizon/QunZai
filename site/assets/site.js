(function () {
  document.documentElement.classList.add("js");
  "use strict";
  var QZ = window.QZ || {};
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? "" : s)
      .split("&").join("&amp;").split("<").join("&lt;")
      .split(">").join("&gt;").split('"').join("&quot;");
  }
  var S = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  function mk(d) { return "<svg " + S + ">" + d + "</svg>"; }
  var ICONS = {
    message: mk('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.6-.7L3 21l1.8-5.4A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>'),
    shield: mk('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>'),
    image: mk('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
    book: mk('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
    eye: mk('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
    key: mk('<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2l-3 3-2-2-2 2-2-2-3.3 9.3"/>'),
    bolt: mk('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>'),
    download: mk('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
    server: mk('<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>'),
    chevron: mk('<path d="M6 9l6 6 6-6"/>'),
    copy: mk('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    users: mk('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
    heart: mk('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>'),
    sparkle: mk('<path d="M12 2l1.9 5.9L20 10l-6.1 2.1L12 18l-1.9-5.9L4 10l6.1-2.1L12 2z"/><path d="M19 15l.7 2.1L22 18l-2.3.9L19 21l-.7-2.1L16 18l2.3-.9L19 15z"/>'),
    check: mk('<path d="M20 6L9 17l-5-5"/>'),
    clock: mk('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    bookOpen: mk('<path d="M2 4h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h6z"/>'),
    code: mk('<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 3l-4 18"/>')
  };
  function svg(name) { return '<span class="icon">' + (ICONS[name] || ICONS.bolt) + "</span>"; }

  function renderStats() {
    var el = $("[data-render=stats]");
    if (!el || !QZ.stats) return;
    el.className = "hero-stats";
    el.innerHTML = QZ.stats.map(function (s) {
      return '<div class="hero-stat"><b>' + esc(s.b) + "</b><span>" + esc(s.s) + "</span></div>";
    }).join("");
  }
  function renderFeatures() {
    var el = $("[data-render=features]");
    if (!el || !QZ.features) return;
    el.className = "grid grid-3";
    el.innerHTML = QZ.features.map(function (f) {
      var pts = (f.points || []).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("");
      return '<article class="card feature-card reveal"><div class="icon-badge">' +
        (ICONS[f.icon] || ICONS.bolt) + "</div><h3>" + esc(f.title) +
        '</h3><p class="summary">' + esc(f.summary) +
        '</p><ul class="point-list">' + pts + "</ul></article>";
    }).join("");
  }
  function renderSteps() {
    var el = $("[data-render=steps]");
    if (!el || !QZ.steps) return;
    el.className = "steps-grid";
    el.innerHTML = QZ.steps.map(function (s, i) {
      return '<article class="step-card reveal"><div class="step-no">' +
        String(i + 1).padStart(2, "0") + "</div><h3>" + esc(s.title) +
        "</h3><p>" + esc(s.body) + "</p></article>";
    }).join("");
  }
  function renderFaq() {
    var el = $("[data-render=faq]");
    if (!el || !QZ.faq) return;
    el.className = "faq-list";
    el.innerHTML = QZ.faq.map(function (f, i) {
      return '<div class="faq-item" id="faq-' + (i + 1) + '">' +
        '<button class="faq-q" type="button" aria-expanded="false">' + esc(f.q) +
        '<span class="icon">' + ICONS.chevron + "</span></button>" +
        '<div class="faq-a"><div class="faq-a-inner">' + f.a + "</div></div></div>";
    }).join("");
    $$(".faq-q", el).forEach(function (b) {
      b.addEventListener("click", function () {
        var item = b.parentNode, a = $(".faq-a", item), open = item.classList.toggle("is-open");
        b.setAttribute("aria-expanded", open ? "true" : "false");
        a.style.maxHeight = open ? a.scrollHeight + "px" : "0px";
      });
    });
    if (location.hash.indexOf("#faq-") === 0) {
      var n = parseInt(location.hash.slice(5), 10);
      var t = document.getElementById("faq-" + n);
      if (t) { var b = $(".faq-q", t); if (b) b.click(); }
    }
  }
  function renderChangelog() {
    var el = $("[data-render=changelog]");
    if (!el || !QZ.changelog) return;
    el.className = "timeline";
    var collapsed = 4, list = QZ.changelog;
    el.innerHTML = list.map(function (c, i) {
      var lis = (c.points || []).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("");
      return '<div class="timeline-item' + (i === 0 ? " is-latest" : "") +
        (i >= collapsed ? " is-collapsed" : "") + '"><div class="timeline-head">' +
        '<span class="timeline-ver">' + esc(c.tag) + '</span><span class="timeline-date">' + esc(c.date) + "</span>" +
        (i === 0 ? '<span class="timeline-tag">最新版</span>' : "") + "</div>" +
        '<div class="timeline-card"><ul>' + lis + "</ul></div></div>";
    }).join("");
    var btn = $("[data-changelog-toggle]");
    if (btn) {
      var expanded = false;
      btn.textContent = "展开全部 " + list.length + " 个版本";
      btn.addEventListener("click", function () {
        expanded = !expanded;
        $$(".timeline-item", el).forEach(function (it, i) {
          if (i < collapsed) return;
          it.classList.add("is-animating");
          if (expanded) it.classList.remove("is-collapsed");
          else it.classList.add("is-collapsed");
        });
        btn.textContent = expanded ? "收起早期版本" : "展开全部 " + list.length + " 个版本";
      });
    }
  }
  function renderGallery() {
    var el = $("[data-render=gallery]");
    if (!el || !QZ.gallery) return;
    el.className = "gallery-grid";
    el.innerHTML = QZ.gallery.map(function (g) {
      return '<article class="gallery-card reveal"><div class="gallery-img"><img src="' +
        esc(g.img) + '" alt="' + esc(g.title) + '" loading="lazy">' +
        (g.tag ? '<span class="gallery-tag">' + esc(g.tag) + "</span>" : "") +
        '</div><div class="gallery-body"><h3>' + esc(g.title) + "</h3>" +
        (g.author ? '<p class="author">' + esc(g.author) + "</p>" : "") +
        "<p>" + esc(g.body) + "</p></div></article>";
    }).join("");
  }
  function renderSponsors() {
    var el = $("[data-render=sponsors]");
    if (!el) return;
    var list = (QZ.sponsors || []).slice();
    if (!list.length) {
      el.className = "sponsor-empty";
      el.innerHTML = '<div class="sponsor-empty-mark">' + ICONS.heart + "</div>" +
        '<p class="sponsor-empty-t">还没有人上榜</p>' +
        '<p class="sponsor-empty-s">这里是第一名的位置 —— 也许就是你的名字。</p>';
      return;
    }
    el.className = "sponsor-grid";
    el.innerHTML = list.map(function (s) {
      var name = esc(s.name || "匿名");
      var initial = esc((s.name || "匿").slice(0, 1));
      var inner = '<span class="sponsor-avatar">' + initial + "</span>" +
        '<span class="sponsor-meta"><b>' + name + "</b>" +
        (s.tier ? '<small class="sponsor-tier">' + esc(s.tier) + "</small>" : "") +
        (s.note ? '<small class="sponsor-note-line">' + esc(s.note) + "</small>" : "") +
        "</span>";
      return s.url
        ? '<a class="sponsor-card reveal" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + inner + "</a>"
        : '<div class="sponsor-card reveal">' + inner + "</div>";
    }).join("");
  }
  function renderChips() {
    var el = $("[data-render=chips]");
    if (!el || !QZ.chips) return;
    el.className = "chip-row";
    el.innerHTML = QZ.chips.map(function (c) { return '<span class="chip">' + esc(c) + "</span>"; }).join("");
  }
  function renderDownload() {
    var el = $("[data-render=download]");
    if (!el || !QZ.facts) return;
    el.className = "download-card";
    var f = QZ.facts;
    el.innerHTML = '<div><h3>' + esc(f.title) + '</h3><p class="dl-sub">' + esc(f.sub) + "</p>" +
      '<div class="dl-facts"><span>' + svg("download") + esc(f.version) + "</span>" +
      "<span>" + svg("server") + esc(f.size) + "</span><span>" + svg("shield") + "Windows 10 / 11</span></div>" +
      '<div class="dl-hash"><b>SHA-256</b> <span data-copy-sha>' + esc(f.sha) + "</span> " +
      '<button class="btn btn-sm btn-ghost" type="button" data-copy>复制</button></div></div>' +
      '<div class="hero-actions" style="margin:0"><a class="btn btn-primary" data-href="download">下载安装包</a>' +
      '<a class="btn btn-ghost" data-href="releases">查看全部版本</a></div>';
  }
  function legacy(t) {
    var ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }
  function applyConfig() {
    $$("[data-config]").forEach(function (el) {
      var v = QZ.config && QZ.config[el.getAttribute("data-config")];
      if (v != null) el.textContent = v;
    });
    $$("[data-href]").forEach(function (el) {
      var v = QZ.links && QZ.links[el.getAttribute("data-href")];
      if (v) { el.setAttribute("href", v); if (el.tagName === "A" && el.getAttribute("data-href") !== "pages") el.setAttribute("target", "_blank"), el.setAttribute("rel", "noopener"); }
    });
    $$("[data-copy]").forEach(function (el) {
      if (el._bound) return; el._bound = true;
      el.addEventListener("click", function () {
        var t = QZ.facts && QZ.facts.sha; if (!t) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t).then(function () { el.textContent = "已复制"; }, function () { legacy(t); el.textContent = "已复制"; });
        } else { legacy(t); el.textContent = "已复制"; }
        setTimeout(function () { el.textContent = "复制"; }, 1800);
      });
    });
  }
  function initCopyGroup() {
    $$("[data-copy-group]").forEach(function (el) {
      if (el._boundGroup) return; el._boundGroup = true;
      el.addEventListener("click", function () {
        var t = (QZ.config && QZ.config.qqGroup) || "1128593359";
        var ok = function () { el.textContent = "已复制"; setTimeout(function () { el.textContent = "复制"; }, 1800); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, function () { legacy(t); ok(); });
        else { legacy(t); ok(); }
      });
    });
  }
  function initNav() {
    var page = document.body.getAttribute("data-page");
    $$("[data-nav]").forEach(function (a) { if (a.getAttribute("data-nav") === page) a.classList.add("is-active"); });
    var t = $(".nav-toggle"), nav = $(".site-nav");
    if (t && nav) {
      t.addEventListener("click", function () {
        var open = nav.classList.toggle("is-open");
        t.setAttribute("aria-expanded", open ? "true" : "false");
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { nav.classList.remove("is-open"); t.setAttribute("aria-expanded", "false"); }
      });
    }
    var c = $(".notice-close");
    if (c) c.addEventListener("click", function () {
      var n = $(".site-notice");
      if (n) { n.classList.add("is-closing"); setTimeout(function () { n.style.display = "none"; }, 320); }
    });
  }
  function initReveal() {
    var els = $$(".reveal");
    if (!("IntersectionObserver" in window)) { els.forEach(function (e) { e.classList.add("is-visible"); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("is-visible"); io.unobserve(en.target); } });
    }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" });
    els.forEach(function (e, i) { e.style.setProperty("--reveal-delay", Math.min(i * 55, 220) + "ms"); io.observe(e); });
  }
  function initSwarm() {
    var k = "__swarmRebuild";
    var loading = false;
    function load(done) {
      if (window[k]) { if (done) done(); return; }
      if (loading) return;
      loading = true;
      var s = document.createElement("script");
      s.src = "assets/swarm.js?v=20261108c";
      s.onload = function () { if (done) done(); };
      s.onerror = function () { loading = false; };
      document.head.appendChild(s);
    }
    // 默认开启：页面就绪即自动注入并长出来（swarm.js 自身会调用 start()）。
    load(null);
    $$("[data-swarm]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (window[k] && window[k].app) { window[k].stop(true); return; } // 回到真实页面
        load(function () { if (window[k]) window[k].start(); });            // 再长一次
      });
    });
  }
  function safe(name, fn) {
    try { fn(); } catch (e) { if (window.console) console.error("[qunzai] " + name + " failed", e); }
  }
  function boot() {
    safe("applyConfig", applyConfig);
    safe("stats", renderStats); safe("features", renderFeatures); safe("steps", renderSteps);
    safe("faq", renderFaq); safe("changelog", renderChangelog); safe("gallery", renderGallery);
    safe("chips", renderChips); safe("download", renderDownload); safe("sponsors", renderSponsors);
    safe("applyConfig2", applyConfig);
    safe("copyGroup", initCopyGroup); safe("nav", initNav); safe("reveal", initReveal); safe("swarm", initSwarm);
    // 兜底：只救「已经进了视口却还是透明」的，避免整页空白；滚动动画照常
    function rescue() {
      var vh = window.innerHeight || 800;
      document.querySelectorAll(".reveal:not(.is-visible)").forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < vh && r.bottom > 0) el.classList.add("is-visible");
      });
    }
    setTimeout(rescue, 1200);
    setTimeout(rescue, 3000);
    window.addEventListener("load", rescue);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
