/* 群崽 QunZai 官网后台 · 本地控制台服务
 * 零依赖：只用 Node 内建模块。
 * 职责：读写 site/assets/data.js、替换 site/assets 下图片、一键 git 提交并推送触发 Pages 部署。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const ASSETS = path.join(SITE, "assets");
const DATA = path.join(ASSETS, "data.js");
const UI = path.join(__dirname, "ui");
const BACKUP = path.join(__dirname, ".backup");
const ARGV = process.argv.slice(2);
const NOOPEN = ARGV.indexOf("--no-open") >= 0;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2"
};
const EXT_OK = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".mp4", ".exe"];

function mime(p) { return MIME[path.extname(p).toLowerCase()] || "application/octet-stream"; }
function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(buf);
}
function sendJson(res, code, obj) { send(res, code, JSON.stringify(obj), "application/json; charset=utf-8"); }

/* ---------- data.js 读写（保持原文件字节结构） ---------- */

function readRaw() { return fs.readFileSync(DATA, "utf8"); }

function parse(raw) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(raw, sandbox, { filename: "data.js" });
  if (!sandbox.window || !sandbox.window.QZ) throw new Error("data.js 里没有 window.QZ");
  return sandbox.window.QZ;
}

// 扫描每个顶层键前面紧跟的 /* ... */ 注释块，序列化时原样放回去
function commentMap(raw) {
  const map = {};
  const lines = raw.split("\n");
  let buf = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (buf === null && /^\s*\/\*/.test(t)) {
      buf = [t];
      if (/\/\*[\s\S]*\*\//.test(t)) { buf = null; }
      continue;
    }
    if (buf !== null) {
      buf.push(t);
      if (/\*\//.test(t)) {
        const block = buf.join("\n");
        buf = null;
        for (let j = i + 1; j < lines.length; j++) {
          const m = lines[j].match(/^\s*"([^"]+)"\s*:/);
          if (m) { map[m[1]] = block; break; }
          if (lines[j].trim() !== "") break;
        }
      }
    }
  }
  return map;
}

function serialize(raw, QZ) {
  const headerEnd = raw.indexOf("window.QZ = {");
  if (headerEnd < 0) throw new Error("data.js 结构无法识别：缺少 window.QZ = {");
  const header = raw.slice(0, headerEnd);
  const cm = commentMap(raw);
  const keys = Object.keys(QZ);
  const body = keys.map(function (k) {
    const pre = cm[k] ? cm[k] + "\n" : "";
    const json = JSON.stringify(QZ[k], null, 2).split("\n").join("\n  ");
    return pre + "  " + JSON.stringify(k) + ": " + json;
  }).join(",\n");
  return header + "window.QZ = {\n" + body + "\n};\n";
}

function backup() {
  try {
    fs.mkdirSync(BACKUP, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(BACKUP, "data-" + stamp + ".js"), readRaw());
    const files = fs.readdirSync(BACKUP).filter(function (f) { return /^data-.*\.js$/.test(f); }).sort();
    while (files.length > 20) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP, old)); } catch (e) {}
    }
  } catch (e) { /* 备份失败不阻塞保存 */ }
}

function writeData(QZ) {
  const raw = readRaw();
  const next = serialize(raw, QZ);
  const check = parse(next); // 回读校验：不能有数据丢失
  const a = JSON.stringify(check), b = JSON.stringify(QZ);
  if (a !== b) throw new Error("序列化回读不一致，已中止写入");
  backup();
  const tmp = DATA + ".tmp";
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, DATA);
  return { bytes: Buffer.byteLength(next, "utf8"), identical: next === raw };
}

/* ---------- git ---------- */

function sh(cmd, args, opts) {
  return new Promise(function (resolve) {
    execFile(cmd, args, Object.assign({ cwd: ROOT, maxBuffer: 8 * 1024 * 1024, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" }) }, opts || {}), function (err, stdout, stderr) {
      resolve({ code: err ? (err.code || 1) : 0, out: (stdout || "").trim(), err: (stderr || "").trim() });
    });
  });
}

async function gitState() {
  const status = await sh("git", ["status", "--porcelain", "--", "site/"]);
  const branch = await sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const log = await sh("git", ["log", "-3", "--pretty=%h|%ad|%s", "--date=format:%m-%d %H:%M"]);
  const ahead = await sh("git", ["rev-list", "--count", "origin/main..HEAD"]);
  return {
    branch: branch.out, changed: status.out ? status.out.split("\n") : [],
    recent: log.out ? log.out.split("\n").map(function (l) { const p = l.split("|"); return { hash: p[0], date: p[1], subject: p.slice(2).join("|") }; }) : [],
    ahead: Number(ahead.out || 0)
  };
}

/* ---------- HTTP ---------- */

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = []; let size = 0;
    req.on("data", function (c) { size += c.length; if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; } chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function safeName(name) {
  const base = path.basename(String(name || ""));
  if (!base || base !== String(name).replace(/^.*[\\/]/, "")) throw new Error("文件名不合法");
  if (base.indexOf("..") >= 0) throw new Error("文件名不合法");
  const ext = path.extname(base).toLowerCase();
  if (EXT_OK.indexOf(ext) < 0) throw new Error("不支持的文件类型：" + ext);
  return base;
}

function listAssets() {
  const out = [];
  const files = fs.readdirSync(ASSETS);
  files.forEach(function (f) {
    const full = path.join(ASSETS, f);
    let st; try { st = fs.statSync(full); } catch (e) { return; }
    if (!st.isFile()) return;
    const ext = path.extname(f).toLowerCase();
    if (EXT_OK.indexOf(ext) < 0) return;
    out.push({ name: f, bytes: st.size, mtime: st.mtimeMs, kind: ext === ".mp4" ? "video" : ext === ".exe" ? "exe" : "image" });
  });
  out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  return out;
}

async function route(req, res, url) {
  const p = url.pathname;

  if (p === "/api/state") {
    const raw = readRaw();
    const QZ = parse(raw);
    const st = fs.statSync(DATA);
    return sendJson(res, 200, { ok: true, data: QZ, keys: Object.keys(QZ), bytes: raw.length, mtime: st.mtimeMs, site: SITE });
  }

  if (p === "/api/data" && req.method === "POST") {
    const buf = await readBody(req, 24 * 1024 * 1024);
    const payload = JSON.parse(buf.toString("utf8"));
    if (!payload || typeof payload.data !== "object") throw new Error("缺少 data");
    const r = writeData(payload.data);
    return sendJson(res, 200, Object.assign({ ok: true }, r));
  }

  if (p === "/api/assets") return sendJson(res, 200, { ok: true, files: listAssets() });

  if (p === "/api/assets/raw") {
    const name = safeName(url.searchParams.get("name"));
    const full = path.join(ASSETS, name);
    if (!fs.existsSync(full)) return send(res, 404, "not found");
    const st = fs.statSync(full);
    res.writeHead(200, { "Content-Type": mime(full), "Content-Length": st.size, "Cache-Control": "no-cache" });
    return fs.createReadStream(full).pipe(res);
  }

  if (p === "/api/assets/upload" && req.method === "POST") {
    const name = safeName(url.searchParams.get("name"));
    const full = path.join(ASSETS, name);
    const tmp = full + ".uploading";
    await new Promise(function (resolve, reject) {
      const ws = fs.createWriteStream(tmp);
      req.pipe(ws);
      ws.on("finish", resolve); ws.on("error", reject); req.on("error", reject);
    });
    if (fs.existsSync(full)) { try { fs.unlinkSync(full); } catch (e) {} }
    fs.renameSync(tmp, full);
    const st = fs.statSync(full);
    return sendJson(res, 200, { ok: true, name: name, bytes: st.size });
  }

  if (p === "/api/assets/import" && req.method === "POST") {
    const buf = await readBody(req, 64 * 1024);
    const body = JSON.parse(buf.toString("utf8"));
    const src = String(body.src || "");
    if (!fs.existsSync(src)) throw new Error("本机路径不存在：" + src);
    const base = safeName(body.name || path.basename(src));
    const dest = path.join(ASSETS, base);
    const tmp = dest + ".importing";
    fs.copyFileSync(src, tmp);
    if (fs.existsSync(dest)) { try { fs.unlinkSync(dest); } catch (e) {} }
    fs.renameSync(tmp, dest);
    return sendJson(res, 200, { ok: true, name: base, bytes: fs.statSync(dest).size });
  }

  if (p === "/api/git") return sendJson(res, 200, Object.assign({ ok: true }, await gitState()));

  if (p === "/api/publish" && req.method === "POST") {
    const buf = await readBody(req, 1024 * 1024);
    const body = JSON.parse(buf.toString("utf8") || "{}");
    const msg = String(body.message || "").trim() || ("site: 更新官网内容 " + new Date().toLocaleString("zh-CN"));
    const log = [];
    const status = await sh("git", ["status", "--porcelain", "--", "site/"]);
    if (!status.out) return sendJson(res, 200, { ok: false, step: "check", log: ["site/ 下没有改动，无需发布"] });
    await sh("git", ["add", "--", "site/"]);
    log.push("git add site/  ok");
    const commit = await sh("git", ["commit", "-m", msg]);
    log.push("git commit: " + (commit.out || commit.err).split("\n")[0]);
    if (commit.code !== 0 && !/nothing to commit/.test(commit.out + commit.err)) {
      return sendJson(res, 200, { ok: false, step: "commit", log: log });
    }
    const push = await sh("git", ["push", "origin", "main"], { timeout: 180000 });
    log.push("git push: " + ((push.err || push.out).split("\n").slice(-2).join(" ")));
    if (push.code !== 0) return sendJson(res, 200, { ok: false, step: "push", log: log });
    return sendJson(res, 200, { ok: true, step: "done", log: log, state: await gitState() });
  }

  if (p === "/api/deploy") {
    const r = await sh("gh", ["run", "list", "--workflow=pages.yml", "--limit", "1", "--json", "status,conclusion,createdAt,displayTitle,url"]);
    let run = null;
    try { const arr = JSON.parse(r.out || "[]"); run = arr[0] || null; } catch (e) {}
    return sendJson(res, 200, { ok: true, run: run });
  }

  if (p === "/api/open" && req.method === "POST") {
    const buf = await readBody(req, 8192);
    const body = JSON.parse(buf.toString("utf8"));
    const target = String(body.url || "");
    if (!/^https?:\/\//.test(target) && !/^file:\/\//.test(target)) throw new Error("只允许打开 http(s)");
    spawnDetached(target);
    return sendJson(res, 200, { ok: true });
  }

  // 静态：/  → 后台界面；/preview/ → 官网真实页面；/ui/ → 后台静态
  if (p === "/" || p === "/index.html") return file(res, path.join(UI, "index.html"));
  if (p.indexOf("/ui/") === 0) return file(res, path.join(UI, p.slice(4)));
  if (p.indexOf("/preview") === 0) {
    let rel = p.slice("/preview".length) || "/index.html";
    if (rel === "/") rel = "/index.html";
    return file(res, path.join(SITE, rel));
  }
  return send(res, 404, "not found");
}

function file(res, full) {
  const abs = path.resolve(full);
  if (abs.indexOf(path.resolve(UI)) !== 0 && abs.indexOf(path.resolve(SITE)) !== 0) return send(res, 403, "forbidden");
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, "not found");
  res.writeHead(200, { "Content-Type": mime(abs), "Cache-Control": "no-store" });
  fs.createReadStream(abs).pipe(res);
}

function spawnDetached(target) {
  const { spawn } = require("child_process");
  try { spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch (e) {}
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  route(req, res, url).catch(function (e) {
    try { sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }); } catch (x) {}
  });
});

function listen(port, left) {
  server.once("error", function (e) {
    if (e.code === "EADDRINUSE" && left > 0) { setTimeout(function () { listen(port + 1, left - 1); }, 60); return; }
    console.error("启动失败：" + e.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", function () {
    const addr = "http://127.0.0.1:" + port + "/";
    console.log("");
    console.log("  群崽官网后台已启动");
    console.log("  " + addr);
    console.log("  关闭这个窗口即可停止后台。");
    console.log("");
    if (!NOOPEN) spawnDetached(addr);
  });
}
listen(Number(process.env.PORT || 8899), 5);
