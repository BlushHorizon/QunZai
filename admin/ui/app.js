(function () {
  "use strict";

  var S = { data: null, keys: [], assets: [], dirty: false, view: "home", textOpen: {} };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtBytes(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function toast(msg, bad) {
    var el = $("#toast");
    el.textContent = msg;
    el.className = "toast is-on" + (bad ? " bad" : "");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = "toast"; }, 2600);
  }
  function markDirty(on) {
    S.dirty = !!on;
    $("#dirty-dot").className = "dot" + (S.dirty ? " is-dirty" : "");
    $("#dirty-txt").textContent = S.dirty ? "有未保存的改动" : "没有未保存的改动";
    $("#btn-save").disabled = !S.dirty;
  }

  function api(path, opt) {
    return fetch(path, opt).then(function (r) { return r.json().then(function (j) { return { code: r.status, body: j }; }); })
      .then(function (x) {
        if (x.code >= 400 || (x.body && x.body.ok === false && x.body.error)) throw new Error((x.body && (x.body.error || x.body.step + " 失败")) || ("HTTP " + x.code));
        return x.body;
      });
  }

  /* ---------------- 载入 ---------------- */

  function load() {
    return api("/api/state").then(function (b) {
      S.data = b.data; S.keys = b.keys;
      $("#pill-sp").textContent = (S.data.sponsors || []).length;
      renderHome(b.bytes, b.mtime);
      renderSponsors();
      renderText();
      refreshAssets();
      refreshGit();
      refreshDeploy();
    }).catch(function (e) { toast("载入失败：" + e.message, true); });
  }

  /* ---------------- 概览 ---------------- */

  function renderHome(bytes, mtime) {
    var d = S.data;
    var cards = [
      { k: "官网版本", v: d.config.version || "—", s: "安卓 " + (d.config.apkVersion || "—") },
      { k: "鸣谢名单", v: (d.sponsors || []).length + " 人", s: (d.sponsors || []).length ? "已在官网展示" : "空状态：还没有人上榜" },
      { k: "更新日志", v: (d.changelog || []).length + " 条", s: (d.changelog || [0] && d.changelog[0] ? d.changelog[0].tag + " · " + d.changelog[0].date : "") },
      { k: "data.js", v: fmtBytes(bytes), s: new Date(mtime).toLocaleString("zh-CN") }
    ];
    $("#home-cards").innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="k">' + esc(c.k) + '</div><div class="v">' + esc(c.v) + '</div><div class="s">' + esc(c.s) + "</div></div>";
    }).join("");
  }

  function refreshGit() {
    return api("/api/git").then(function (b) {
      var rows = (b.recent || []).map(function (r) {
        return '<div class="logrow"><span class="h">' + esc(r.hash) + '</span><span class="t">' + esc(r.subject) + '</span><span class="d">' + esc(r.date) + "</span></div>";
      }).join("") || '<div class="logrow"><span class="t">还没有提交记录</span></div>';
      $("#home-log").innerHTML = rows;

      var ch = (b.changed || []).filter(function (l) { return l.trim(); });
      $("#pub-changes").innerHTML = ch.length
        ? ch.map(function (l) {
            var code = l.slice(0, 2).trim(), file = l.slice(3);
            return '<div class="logrow"><span class="h">' + esc(code) + '</span><span class="t">' + esc(file) + "</span></div>";
          }).join("")
        : '<div class="logrow"><span class="t">site/ 下没有待发布的改动</span></div>';
      $("#btn-pub").disabled = ch.length === 0;
      $("#btn-pub-top").disabled = ch.length === 0;
      $("#btn-pub-top").title = ch.length ? "" : "site/ 下没有改动";
    }).catch(function () {});
  }

  function refreshDeploy() {
    api("/api/deploy").then(function (b) {
      var r = b.run;
      if (!r) { $("#home-deploy").innerHTML = '<span class="panel-note">还没有部署记录</span>'; return; }
      var cls = r.status === "completed" ? (r.conclusion === "success" ? "ok" : "bad") : "run";
      var txt = r.status === "completed" ? (r.conclusion === "success" ? "部署成功" : "部署失败：" + r.conclusion) : "部署中…";
      $("#home-deploy").innerHTML = '<span class="badge ' + cls + '">' + esc(txt) + "</span>" +
        '<span class="panel-note">' + esc(new Date(r.createdAt).toLocaleString("zh-CN")) + "</span>" +
        (r.url ? '<a class="link" href="' + esc(r.url) + '" target="_blank" rel="noopener">查看运行 ↗</a>' : "");
    }).catch(function () { $("#home-deploy").innerHTML = '<span class="panel-note">拿不到部署状态（gh 未登录或离线）</span>'; });
  }

  /* ---------------- 赞助者 ---------------- */

  function renderSponsors() {
    var list = S.data.sponsors || [];
    $("#sp-count").textContent = "共 " + list.length + " 人";
    $("#pill-sp").textContent = list.length;
    if (!list.length) {
      $("#sp-list").innerHTML = '<div class="sp-empty">还没有人上榜。点上面「＋ 添加一位赞助者」开始记录。</div>';
      return;
    }
    $("#sp-list").innerHTML = list.map(function (sp, i) {
      var ch = String(sp.name || "?").trim().charAt(0) || "?";
      return '<div class="sp-card" data-i="' + i + '">' +
        '<div class="sp-top"><div class="sp-av">' + esc(ch) + '</div><div class="f">' +
        '<label>名字（必填）</label><input class="input" data-f="name" value="' + esc(sp.name) + '" placeholder="小明的群友">' +
        "</div></div>" +
        '<div class="f"><label>档位 / 日期（选填）</label><input class="input" data-f="tier" value="' + esc(sp.tier) + '" placeholder="¥50 · 2026-11"></div>' +
        '<div class="f"><label>备注（选填）</label><input class="input" data-f="note" value="' + esc(sp.note) + '" placeholder="谢谢支持"></div>' +
        '<div class="f"><label>主页链接 / 联系方式（选填）</label><input class="input" data-f="url" value="' + esc(sp.url) + '" placeholder="https://… 才是链接；QQ号等纯文本只展示"></div>' +
        '<div class="row-r" style="margin-top:2px"><button class="sp-del">移除</button></div>' +
        "</div>";
    }).join("");
  }

  function bindSponsors() {
    $("#sp-list").addEventListener("input", function (e) {
      var el = e.target.closest("[data-f]"); if (!el) return;
      var card = el.closest(".sp-card"); if (!card) return;
      var i = Number(card.getAttribute("data-i"));
      var key = el.getAttribute("data-f");
      var sp = S.data.sponsors[i];
      if (!sp) return;
      if (el.value.trim()) sp[key] = el.value.trim(); else delete sp[key];
      if (key === "name") card.querySelector(".sp-av").textContent = el.value.trim().charAt(0) || "?";
      markDirty(true);
    });
    $("#sp-list").addEventListener("click", function (e) {
      if (!e.target.classList.contains("sp-del")) return;
      var card = e.target.closest(".sp-card");
      var i = Number(card.getAttribute("data-i"));
      S.data.sponsors.splice(i, 1);
      renderSponsors(); markDirty(true);
    });
    $("#sp-add").addEventListener("click", function () {
      S.data.sponsors = S.data.sponsors || [];
      S.data.sponsors.push({ name: "" });
      renderSponsors(); markDirty(true);
      var cards = $$(".sp-card");
      if (cards.length) cards[cards.length - 1].querySelector("input").focus();
    });
    $("#sp-bulk-add").addEventListener("click", function () {
      var v = $("#sp-bulk").value.trim();
      if (!v) return toast("先贴几行进来", true);
      var added = 0;
      v.split("\n").forEach(function (line) {
        line = line.trim();
        if (!line) return;
        var p = line.split("|").map(function (s) { return s.trim(); });
        if (!p[0]) return;
        S.data.sponsors = S.data.sponsors || [];
        S.data.sponsors.push({ name: p[0], tier: p[1] || undefined, note: p[2] || undefined, url: p[3] || undefined });
        added++;
      });
      $("#sp-bulk").value = "";
      renderSponsors(); markDirty(true);
      toast("导入 " + added + " 位");
    });
  }

  /* ---------------- 图片 ---------------- */

  function refreshAssets() {
    return api("/api/assets").then(function (b) {
      S.assets = b.files || [];
      $("#pill-img").textContent = S.assets.length;
      renderImages();
      var sel = $("#img-target");
      var cur = sel.value;
      sel.innerHTML = S.assets.map(function (f) { return '<option value="' + esc(f.name) + '">' + esc(f.name) + "</option>"; }).join("");
      if (cur) sel.value = cur;
    }).catch(function (e) { toast("读取图片列表失败：" + e.message, true); });
  }

  function renderImages() {
    $("#img-grid").innerHTML = S.assets.map(function (f) {
      var isImg = f.kind === "image";
      var thumb = isImg
        ? '<img src="/api/assets/raw?name=' + encodeURIComponent(f.name) + '&t=' + Math.round(f.mtime) + '" alt="' + esc(f.name) + '" loading="lazy">'
        : '<div class="exe">' + (f.kind === "exe" ? "安装包" : "视频") + "<br>" + esc(f.name) + "</div>";
      return '<div class="img-card" data-name="' + esc(f.name) + '">' +
        '<div class="img-thumb" data-zoom="' + (isImg ? "1" : "0") + '">' + thumb + "</div>" +
        '<div class="img-meta"><span class="n" title="' + esc(f.name) + '">' + esc(f.name) + '</span><span class="z">' + fmtBytes(f.bytes) + "</span>" +
        '<button class="rep" data-replace="' + esc(f.name) + '">替换</button></div></div>';
    }).join("") || '<div class="sp-empty">assets 目录里没有可管理的文件</div>';
  }

  function bindImages() {
    $("#img-grid").addEventListener("click", function (e) {
      var rep = e.target.closest("[data-replace]");
      if (rep) { pickFileFor(rep.getAttribute("data-replace")); return; }
      var th = e.target.closest(".img-thumb");
      if (th && th.getAttribute("data-zoom") === "1") {
        var card = th.closest(".img-card");
        var name = card.getAttribute("data-name");
        openModal(name, '<img src="/api/assets/raw?name=' + encodeURIComponent(name) + '&t=' + Date.now() + '" style="max-width:100%;max-height:72vh">');
      }
    });
    $("#img-file").addEventListener("change", function () {
      var file = this.files && this.files[0];
      this.value = "";
      if (!file) return;
      var target = $("#img-target").value;
      if (!target) return toast("先选一个要覆盖的文件名", true);
      if (!confirm("用「" + file.name + "」覆盖 assets/" + target + "？\n官网引用的是文件名，覆盖后立即生效（发布才上线）。")) return;
      uploadTo(target, file);
    });
    $("#img-target").addEventListener("change", function () {
      $("#img-note").textContent = this.value ? "新图会覆盖 " + this.value : "";
    });
  }

  function pickFileFor(name) {
    var inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*,video/*";
    inp.addEventListener("change", function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (!confirm("用「" + f.name + "」覆盖 assets/" + name + "？")) return;
      uploadTo(name, f);
    });
    inp.click();
  }

  function uploadTo(name, file) {
    toast("上传中…");
    fetch("/api/assets/upload?name=" + encodeURIComponent(name), { method: "POST", body: file })
      .then(function (r) { return r.json(); })
      .then(function (b) {
        if (!b.ok) throw new Error(b.error || "上传失败");
        toast("已替换 " + name + "（" + fmtBytes(b.bytes) + "），记得去发布");
        return refreshAssets().then(refreshGit);
      })
      .catch(function (e) { toast("上传失败：" + e.message, true); });
  }

  /* ---------------- 文字 ---------------- */

  var GROUPS = [
    { id: "config", title: "站点基本设置", desc: "版本号、名字、标语、群号", render: renderConfigFields },
    { id: "links", title: "跳转链接", desc: "下载、GitHub、爱发电等", render: renderLinkFields },
    { id: "facts", title: "关于页事实表", desc: "", render: renderFactFields },
    { id: "stats", title: "首页数字", desc: "", render: renderStatFields },
    { id: "chips", title: "首页标签", desc: "一行一个", render: renderChips },
    { id: "features", title: "功能卡片", desc: "", render: renderFeatures },
    { id: "steps", title: "上手步骤", desc: "", render: renderSteps },
    { id: "faq", title: "常见问题", desc: "", render: renderFaq },
    { id: "gallery", title: "群友画廊", desc: "", render: renderGallery },
    { id: "changelog", title: "更新日志", desc: "", render: renderChangelog }
  ];

  function field(label, val, attrs) {
    return '<div class="field"><label>' + esc(label) + "</label><input class=\"input\" " + (attrs || "") +
      ' value="' + esc(val) + '"></div>';
  }
  function area(label, val, attrs) {
    return '<div class="field"><label>' + esc(label) + "</label><textarea " + (attrs || "") + ">" + esc(val) + "</textarea></div>";
  }

  function renderConfigFields() {
    var c = S.data.config;
    return '<div class="field"><label>站点名字</label><input class="input" data-path="config.name" value="' + esc(c.name) + '"></div>' +
      '<div class="field"><label>标语</label><input class="input" data-path="config.tagline" value="' + esc(c.tagline) + '"></div>' +
      '<div class="field"><label>官网版本号（桌面版）</label><input class="input" data-path="config.version" value="' + esc(c.version) + '"></div>' +
      '<div class="field"><label>安卓版本号</label><input class="input" data-path="config.apkVersion" value="' + esc(c.apkVersion) + '"></div>' +
      '<div class="field"><label>QQ 群号</label><input class="input" data-path="config.qqGroup" value="' + esc(c.qqGroup) + '"></div>' +
      '<div class="field"><label>起始年份</label><input class="input" data-path="config.since" value="' + esc(c.since) + '"></div>' +
      '<div class="field"><label>开源协议</label><input class="input" data-path="config.license" value="' + esc(c.license) + '"></div>';
  }
  function renderLinkFields() {
    return Object.keys(S.data.links).map(function (k) {
      return '<div class="field"><label>' + esc(k) + '</label><input class="input" data-path="links.' + k + '" value="' + esc(S.data.links[k]) + '"></div>';
    }).join("");
  }
  function renderFactFields() {
    return Object.keys(S.data.facts).map(function (k) {
      return '<div class="field"><label>' + esc(k) + '</label><input class="input" data-path="facts.' + k + '" value="' + esc(S.data.facts[k]) + '"></div>';
    }).join("");
  }
  function renderStatFields() {
    return (S.data.stats || []).map(function (s, i) {
      return '<div class="field"><label>第 ' + (i + 1) + " 项</label><div style=\"display:grid;grid-template-columns:1fr 1fr;gap:10px\">" +
        '<input class="input" data-path="stats.' + i + '.b" value="' + esc(s.b) + '" placeholder="数字">' +
        '<input class="input" data-path="stats.' + i + '.s" value="' + esc(s.s) + '" placeholder="说明"></div></div>';
    }).join("");
  }
  function renderChips() {
    return area("标签（一行一个）", (S.data.chips || []).join("\n"), 'data-list="chips"');
  }
  function renderFeatures() {
    return (S.data.features || []).map(function (f, i) {
      return '<div class="field"><label>功能 ' + (i + 1) + "</label>" +
        '<input class="input" data-path="features.' + i + '.title" value="' + esc(f.title) + '" placeholder="标题" style="margin-bottom:8px">' +
        '<input class="input" data-path="features.' + i + '.summary" value="' + esc(f.summary) + '" placeholder="一句话说明" style="margin-bottom:8px">' +
        '<textarea data-path="features.' + i + '.points" data-list="1" placeholder="每行一条">' + esc((f.points || []).join("\n")) + "</textarea></div>";
    }).join("");
  }
  function renderSteps() {
    return (S.data.steps || []).map(function (s, i) {
      return '<div class="field"><label>步骤 ' + (i + 1) + "</label>" +
        '<input class="input" data-path="steps.' + i + '.title" value="' + esc(s.title) + '" style="margin-bottom:8px">' +
        '<textarea data-path="steps.' + i + '.body">' + esc(s.body) + "</textarea></div>";
    }).join("");
  }
  function renderFaq() {
    return (S.data.faq || []).map(function (f, i) {
      return '<div class="field"><label>问题 ' + (i + 1) + "</label>" +
        '<input class="input" data-path="faq.' + i + '.q" value="' + esc(f.q) + '" style="margin-bottom:8px">' +
        '<textarea data-path="faq.' + i + '.a" placeholder="可含简单 HTML">' + esc(f.a) + "</textarea></div>";
    }).join("");
  }
  function renderGallery() {
    return (S.data.gallery || []).map(function (g, i) {
      return '<div class="field"><label>作品 ' + (i + 1) + "</label>" +
        '<input class="input" data-path="gallery.' + i + '.title" value="' + esc(g.title) + '" placeholder="标题" style="margin-bottom:8px">' +
        '<input class="input" data-path="gallery.' + i + '.author" value="' + esc(g.author) + '" placeholder="作者" style="margin-bottom:8px">' +
        '<input class="input" data-path="gallery.' + i + '.img" value="' + esc(g.img) + '" placeholder="assets/xxx.png" style="margin-bottom:8px">' +
        '<textarea data-path="gallery.' + i + '.body">' + esc(g.body) + "</textarea></div>";
    }).join("");
  }
  function renderChangelog() {
    return (S.data.changelog || []).map(function (c, i) {
      return '<div class="field"><label>第 ' + (i + 1) + " 条</label>" +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px">' +
        '<input class="input" data-path="changelog.' + i + '.tag" value="' + esc(c.tag) + '" placeholder="v1.4.17">' +
        '<input class="input" data-path="changelog.' + i + '.date" value="' + esc(c.date) + '" placeholder="2026-11-0x"></div>' +
        '<input class="input" data-path="changelog.' + i + '.name" value="' + esc(c.name) + '" placeholder="版本名" style="margin-bottom:8px">' +
        '<textarea data-path="changelog.' + i + '.points" data-list="1" placeholder="每行一条">' + esc((c.points || []).join("\n")) + "</textarea></div>";
    }).join("");
  }

  function renderText() {
    $("#text-root").innerHTML = GROUPS.map(function (g) {
      var open = S.textOpen[g.id];
      return '<div class="tgroup' + (open ? " is-open" : "") + '" data-g="' + g.id + '">' +
        '<div class="tgroup-h"><h3>' + esc(g.title) + '</h3><span class="c">' + esc(g.desc || "") + "</span></div>" +
        '<div class="tgroup-b">' + g.render() + "</div></div>";
    }).join("");
  }

  function setPath(path, val) {
    var parts = path.split(".");
    var cur = S.data;
    for (var i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = val;
  }

  function bindText() {
    $("#text-root").addEventListener("click", function (e) {
      var h = e.target.closest(".tgroup-h");
      if (!h) return;
      var g = h.closest(".tgroup");
      g.classList.toggle("is-open");
      S.textOpen[g.getAttribute("data-g")] = g.classList.contains("is-open");
    });
    $("#text-root").addEventListener("input", function (e) {
      var el = e.target;
      var path = el.getAttribute("data-path");
      if (!path) return;
      var val;
      if (el.hasAttribute("data-list")) {
        val = el.value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
      } else val = el.value;
      setPath(path, val);
      markDirty(true);
    });
  }

  /* ---------------- 保存 / 发布 ---------------- */

  function save() {
    if (!S.dirty) return Promise.resolve();
    $("#btn-save").disabled = true;
    return api("/api/data", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: S.data }) })
      .then(function (b) {
        markDirty(false);
        toast("已保存到本地（" + fmtBytes(b.bytes) + "）");
        refreshGit();
        return refreshAssets();
      })
      .catch(function (e) { markDirty(true); toast("保存失败：" + e.message, true); throw e; });
  }

  function publish() {
    var msg = $("#pub-msg").value.trim();
    var go = function () {
      $("#pub-out").textContent = "开始上传…";
      $("#btn-pub").disabled = true; $("#btn-pub-top").disabled = true;
      api("/api/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg }) })
        .then(function (b) {
          $("#pub-out").textContent = (b.log || []).join("\n") || JSON.stringify(b);
          if (b.ok) {
            toast("已推送，GitHub Pages 正在构建");
            setTimeout(function () { refreshDeploy(); }, 4000);
            setTimeout(function () { refreshDeploy(); }, 40000);
          } else toast("发布中断在 " + b.step, true);
          refreshGit();
        })
        .catch(function (e) { $("#pub-out").textContent += "\n" + e.message; toast("发布失败：" + e.message, true); })
        .then(function () { refreshGit(); });
    };
    save().then(go).catch(function () {});
  }

  /* ---------------- 导航 ---------------- */

  var TITLES = { home: "概览", sponsors: "鸣谢名单", images: "图片素材", text: "文字内容", publish: "上传发布" };
  var SUBS = {
    home: "本机运行的后台控制台，改完内容点右上角保存与发布",
    sponsors: "爱发电赞助者的鸣谢名单，直接决定官网「赞助者鸣谢」那一栏",
    images: "官网 assets 目录下的图片与视频，可整张替换",
    text: "站点首页、玩法、教程、关于页上的所有文案",
    publish: "把改动提交到 GitHub，触发 Pages 自动部署"
  };

  function go(view) {
    S.view = view;
    $$(".nav-item").forEach(function (b) { b.classList.toggle("is-on", b.getAttribute("data-go") === view); });
    $$(".view").forEach(function (v) { v.hidden = v.getAttribute("data-view") !== view; });
    $("#page-title").textContent = TITLES[view] || view;
    $("#page-sub").textContent = SUBS[view] || "";
    if (view === "publish") refreshGit();
    if (view === "images") refreshAssets();
    if (view === "home") { refreshGit(); refreshDeploy(); }
  }

  function openModal(title, html) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal").hidden = false;
  }
  function closeModal() { $("#modal").hidden = true; $("#modal-body").innerHTML = ""; }

  /* ---------------- 启动 ---------------- */

  function boot() {
    $("#nav").addEventListener("click", function (e) {
      var b = e.target.closest(".nav-item");
      if (b) go(b.getAttribute("data-go"));
    });
    $("#btn-save").addEventListener("click", function () { save().catch(function () {}); });
    $("#btn-pub").addEventListener("click", publish);
    $("#btn-pub-top").addEventListener("click", function () { go("publish"); });
    $("#btn-refresh").addEventListener("click", function () { refreshGit(); refreshDeploy(); });
    $("#modal-x").addEventListener("click", closeModal);
    $("#modal").addEventListener("click", function (e) { if (e.target.id === "modal") closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save().catch(function () {}); }
    });
    window.addEventListener("beforeunload", function (e) {
      if (S.dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    bindSponsors();
    bindImages();
    bindText();
    load();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
