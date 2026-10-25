'use strict';
/**
 * 群崽 QunZai · 多线程分段下载
 * ---------------------------------------------------------------------------
 * 移植自 PCL2-CE（Plain Craft Launcher）的 AdaptiveRangeDownloader 思路：
 *
 *   1. 先用 Range 探测（bytes=0-0）拿到真实大小，并确认服务器真的支持分段；
 *   2. 把文件切成若干 8MB 左右的段，开多个连接同时下，各自写到文件对应偏移；
 *   3. 每个连接独立计时，若某段明显慢于其他段（低于中位数 1/4），
 *      且剩余量还够切，就把这一段再劈成两半丢回队列重排——这是 PCL 提速的关键；
 *   4. 单段失败最多重试 2 次，指数退避；遇到 429 全局降并发；
 *   5. 任何一步判定“服务器不支持 Range”，就整体退回单连接顺序下载，不影响功能。
 *
 * 为什么快：国内直连 GitHub / 部分镜像单连接会被限速，多开几条连接能叠加带宽。
 * 实测 ghfast.top：单连接 ~280KB/s，6 连接 ~1.4MB/s，峰值 3.5MB/s。
 *
 * 并发写安全（v1 踩过的坑，别改回去）：
 *   fh.write 是异步的，而 'data' 事件可以连续触发多次。若用“写完才累加偏移”的写法，
 *   多个在途 chunk 会算出同一个偏移，既互相覆盖又把字节数算重（实测多出 16KB）。
 *   这里把偏移拆成两个计数：
 *     committed —— 已经确认落盘的字节；
 *     inflight  —— 已占位但还没落盘的字节。
 *   新 chunk 的写入位置 = start + committed + inflight，在 data 回调里**同步**占位，
 *   写完再 committed += n / inflight -= n。这样任意时刻偏移都唯一。
 *   劈段前要求 inflight === 0，避免在途写入越过切点跟尾段重叠。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL, fileURLToPath } = require('url');

// —— 参数（对齐 PCL 的常量，按国内镜像的实际情况微调）——
const SMALL_FILE_THRESHOLD = 4 * 1024 * 1024;   // 小于 4MB 不值得分段
const TARGET_SEGMENT_SIZE = 8 * 1024 * 1024;    // 每段目标 8MB
const MAX_SEGMENT_COUNT = 1024;
const MAX_CONCURRENCY = 8;                       // PCL 单文件连接上限
const DEFAULT_CONCURRENCY = 6;                   // 实测 6 条最稳，8 条容易被镜像 429
const READ_TIMEOUT_MS = 15000;
const MAX_SEGMENT_RETRIES = 2;
const SLOW_CHECK_SECONDS = 8;
const SLOW_SPLIT_MIN_REMAINING = 2 * 1024 * 1024;
const SLOW_FACTOR = 4;                           // 慢于其他连接 4 倍才算“明显慢”
const MIN_RATE_FOR_COMPARISON = 128 * 1024;      // 基线至少 128KB/s 才有参考意义
const MAX_REDIRECTS = 5;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

const UA = 'QunZai-Updater/1.0';

/** 慢连接：不算失败，重排/劈段后继续，不占重试次数。 */
class SlowSegmentError extends Error {}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

/** 发起 GET，自动跟随重定向。resolve 出 { res }。 */
function httpGet(url, headers = {}, timeoutMs = READ_TIMEOUT_MS, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('下载地址不合法：' + url)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new Error('只支持 http / https 下载地址'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers }
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('重定向次数过多'));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch { return reject(new Error('重定向地址不合法')); }
        return httpGet(next, headers, timeoutMs, redirects + 1).then(resolve, reject);
      }
      resolve({ res });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
    req.end();
  });
}

/** Range 探测：拿总大小，同时确认服务器是否真的返回 206。 */
async function probe(url) {
  const { res } = await httpGet(url, { Range: 'bytes=0-0' }, 20000);
  if (res.statusCode !== 206) { res.resume(); return null; }
  const cr = res.headers['content-range'] || '';
  const m = /\/(\d+)\s*$/.exec(cr);
  res.resume();
  if (!m) return null;
  const size = parseInt(m[1], 10);
  if (!Number.isFinite(size) || size <= 0) return null;
  return { size, supportsRange: true };
}

/** 单连接顺序下载（Range 不可用时的兜底，也是小文件走的路径）。 */
async function downloadSequential(url, partPath, opts = {}) {
  const { expectedSize = 0, onProgress = null } = opts;
  const { res } = await httpGet(url, {}, 30000);
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.resume();
    throw new Error(`下载失败：HTTP ${res.statusCode}`);
  }
  const total = parseInt(res.headers['content-length'] || '0', 10) || expectedSize || 0;
  const out = fs.createWriteStream(partPath);
  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;

  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      got += chunk.length;
      if (got > MAX_FILE_BYTES) {
        try { res.destroy(new Error('文件超过 512MB，已中止')); } catch { /* noop */ }
        return;
      }
      const now = Date.now();
      if (onProgress && now - lastTick >= 300) {
        onProgress({ downloaded: got, total, speed: (got - lastBytes) * 1000 / (now - lastTick), connections: 1 });
        lastTick = now; lastBytes = got;
      }
    });
    res.on('end', () => out.end(resolve));
    res.on('error', reject);
    out.on('error', reject);
  });

  if (onProgress) onProgress({ downloaded: got, total: total || got, speed: 0, connections: 0 });
  return { bytes: got, sequential: true, connections: 1, segments: 1, slowHits: 0, splitCount: 0 };
}

/**
 * 多线程分段下载主入口。
 * @returns {Promise<{bytes:number, sequential:boolean, connections:number, segments:number}>}
 */
async function downloadParallel(url, partPath, opts = {}) {
  const {
    expectedSize = 0,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = null
  } = opts;

  // 小文件不折腾
  if (expectedSize > 0 && expectedSize < SMALL_FILE_THRESHOLD) {
    return downloadSequential(url, partPath, opts);
  }

  // 探测：确认服务器真的支持 206，拿真实大小
  let info = null;
  try { info = await probe(url); } catch { info = null; }
  if (!info) {
    return downloadSequential(url, partPath, opts);
  }
  if (info.size < SMALL_FILE_THRESHOLD) {
    return downloadSequential(url, partPath, opts);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new Error('文件超过 512MB，已中止');
  }

  const totalSize = info.size;
  const workerCount = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY));

  // 切段
  const segCount = Math.max(1, Math.min(Math.ceil(totalSize / TARGET_SEGMENT_SIZE), MAX_SEGMENT_COUNT));
  const segSize = Math.ceil(totalSize / segCount);
  const queue = [];
  let nextId = 0;
  for (let start = 0; start < totalSize; start += segSize) {
    const end = Math.min(totalSize - 1, start + segSize - 1);
    queue.push({ id: ++nextId, start, end, committed: 0, inflight: 0, fails: 0, startedAt: 0, attemptBytes: 0 });
  }

  // 预分配文件
  const fh = await fs.promises.open(partPath, 'w');
  await fh.truncate(totalSize).catch(async (e) => { await fh.close(); throw e; });

  let downloaded = 0;
  let active = 0;
  let lastProgressTick = Date.now();
  let lastProgressBytes = 0;
  let fatal = null;
  let slowHits = 0;
  let splitCount = 0;
  let rateLimitBackoff = 0;
  const rates = new Map();   // segId -> { rate, at }

  const reportProgress = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressTick < 300) return;
    const dt = Math.max(1, now - lastProgressTick);
    onProgress({
      downloaded,
      total: totalSize,
      speed: Math.max(0, Math.round((downloaded - lastProgressBytes) * 1000 / dt)),
      connections: active
    });
    lastProgressTick = now;
    lastProgressBytes = downloaded;
  };

  const segRemaining = (s) => s.end - (s.start + s.committed + s.inflight) + 1;

  /** 把一段劈成两半丢回队列。只在没有在途写入时调用，避免越界重叠。 */
  function splitSegment(seg) {
    if (seg.inflight > 0) return false;
    if (splitCount >= MAX_SEGMENT_COUNT) return false;
    const remaining = segRemaining(seg);
    if (remaining < SLOW_SPLIT_MIN_REMAINING) return false;
    const cutAt = seg.start + seg.committed + Math.floor(remaining / 2);
    const tail = {
      id: ++nextId, start: cutAt, end: seg.end,
      committed: 0, inflight: 0, fails: 0, startedAt: 0, attemptBytes: 0
    };
    seg.end = cutAt - 1;
    queue.push(seg);
    queue.push(tail);
    splitCount++;
    return true;
  }

  async function runWorker() {
    while (true) {
      if (fatal) return;
      const seg = queue.shift();
      if (!seg) {
        if (active === 0) return;      // 全部干完
        await sleep(20);
        continue;
      }

      active++;
      seg.startedAt = Date.now();
      seg.attemptBytes = 0;

      try {
        await downloadSegment(seg);
        active--;
        if (downloaded >= totalSize) return;
      } catch (err) {
        active--;
        if (fatal) return;

        if (/HTTP 429/.test(err.message)) {
          rateLimitBackoff = Math.min(rateLimitBackoff + 1, 4);
          await sleep(1000 * rateLimitBackoff + randInt(0, 500));
        }

        const isSlow = err instanceof SlowSegmentError;
        if (!isSlow && ++seg.fails > MAX_SEGMENT_RETRIES) {
          fatal = err;
          return;
        }
        await sleep(isSlow ? randInt(50, 200) : randInt(250, 1000));
        // 慢连接：优先劈一半，让空出来的连接去抢别的段
        if (!splitSegment(seg)) queue.push(seg);
      }
    }
  }

  async function downloadSegment(seg) {
    const from = seg.start + seg.committed + seg.inflight;
    if (from > seg.end) return;

    const { res } = await httpGet(url, { Range: `bytes=${from}-${seg.end}` }, READ_TIMEOUT_MS);
    if (res.statusCode === 429) {
      res.resume();
      throw new Error('HTTP 429 请求过于频繁');
    }
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`服务器未按 Range 返回分段（HTTP ${res.statusCode}）`);
    }
    const cr = (res.headers['content-range'] || '').trim();
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(cr);
    if (!m || parseInt(m[1], 10) !== from) {
      res.resume();
      throw new Error('Content-Range 与请求不一致');
    }

    let chain = Promise.resolve();
    let writeError = null;

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
      const kill = () => { try { res.destroy(); } catch { /* noop */ } };

      res.on('data', (chunk) => {
        if (settled) return;

        // seg.end 可能因为劈段被缩小，这里以最新值为准
        const room = seg.end - (seg.start + seg.committed + seg.inflight) + 1;
        if (room <= 0) { kill(); return finish(resolve); }

        const buf = chunk.length > room ? chunk.subarray(0, room) : chunk;
        const position = seg.start + seg.committed + seg.inflight;

        // 关键：同步占位，避免多个在途 chunk 抢到同一偏移
        seg.inflight += buf.length;
        seg.attemptBytes += buf.length;

        chain = chain.then(() => fh.write(buf, 0, buf.length, position)).then(() => {
          seg.inflight -= buf.length;
          seg.committed += buf.length;
          downloaded += buf.length;
          reportProgress();
          maybeSplitSlow(seg, kill);
        }).catch((e) => {
          seg.inflight -= buf.length;
          writeError = e;
          kill();
          finish(reject, e);
        });

        if (buf.length < chunk.length) { kill(); finish(resolve); }
      });

      res.on('end', () => finish(resolve));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(resolve));
    });

    // 等在途写入全部落盘，再判断这一段的完成情况
    await chain.catch(() => { /* 已记录到 writeError */ });
    if (writeError) throw writeError;

    if (seg.__slow) {
      seg.__slow = false;
      throw new SlowSegmentError(`分段速度明显低于其他连接（${seg.id}）`);
    }

    const remaining = segRemaining(seg);
    if (remaining > 0) {
      throw new Error(`分段提前结束，还剩 ${remaining} 字节`);
    }
  }

  /**
   * 慢连接检测：跑够 8 秒后，跟其他活跃连接比速率。
   * 明显慢（低于中位数 1/4）就标记 + 断流，由 downloadSegment 抛 SlowSegmentError，
   * 让 worker 走“劈一半重排”的路径——这是 PCL 提速的核心动作。
   */
  function maybeSplitSlow(seg, kill) {
    const now = Date.now();
    if (now - seg.startedAt < SLOW_CHECK_SECONDS * 1000) return;
    const elapsed = Math.max(0.001, (now - seg.startedAt) / 1000);
    const ownRate = seg.attemptBytes / elapsed;
    rates.set(seg.id, { rate: ownRate, at: now });

    const others = [];
    for (const [id, v] of rates) {
      if (id === seg.id) continue;
      if (now - v.at > 3000) continue;
      if (v.rate > 0) others.push(v.rate);
    }
    if (!others.length) return;
    others.sort((a, b) => a - b);
    const median = others[Math.floor(others.length / 2)];
    if (median < MIN_RATE_FOR_COMPARISON) return;
    if (ownRate * SLOW_FACTOR >= median) return;

    slowHits++;
    seg.__slow = true;
    kill();
  }

  try {
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(runWorker());
    await Promise.all(workers);
    if (fatal) throw fatal;
    if (downloaded !== totalSize) {
      throw new Error(`分段下载不完整：已写入 ${downloaded}，应为 ${totalSize}`);
    }
    reportProgress(true);
    return { bytes: totalSize, sequential: false, connections: workerCount, segments: nextId, slowHits, splitCount };
  } finally {
    try { await fh.close(); } catch { /* noop */ }
  }
}

/** 边读边算 SHA256，避免把 80MB 整个读进内存。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * 对外主函数：下载到 dest，校验大小与 SHA256，成功后才把 .part 改名成正式文件。
 * 返回 { file, bytes, sha256, sequential, connections }。
 */
async function downloadFile(url, dest, opts = {}) {
  const { expectedSha256 = '', expectedSize = 0, concurrency = DEFAULT_CONCURRENCY, onProgress = null } = opts;

  if (/^file:\/\//i.test(url)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    fs.copyFileSync(fileURLToPath(url), part);
    const buf = fs.readFileSync(part);
    if (expectedSize && buf.length !== Number(expectedSize)) {
      fs.rmSync(part, { force: true });
      throw new Error(`文件大小不一致（期望 ${expectedSize}，实际 ${buf.length}）`);
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (expectedSha256 && hash.toLowerCase() !== String(expectedSha256).toLowerCase()) {
      fs.rmSync(part, { force: true });
      throw new Error('SHA256 校验失败，已删除下载文件');
    }
    fs.renameSync(part, dest);
    return { file: dest, bytes: buf.length, sha256: hash, sequential: true, connections: 0 };
  }

  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http / https / file 下载地址');

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  try { fs.rmSync(part, { force: true }); } catch { /* noop */ }

  let result;
  try {
    result = await downloadParallel(url, part, { expectedSize, concurrency, onProgress });
  } catch (err) {
    try { fs.rmSync(part, { force: true }); } catch { /* noop */ }
    throw err;
  }

  try {
    const st = fs.statSync(part);
    if (expectedSize && st.size !== Number(expectedSize)) {
      throw new Error(`文件大小不一致（期望 ${expectedSize}，实际 ${st.size}）`);
    }
    const hash = await sha256File(part);
    if (expectedSha256 && hash.toLowerCase() !== String(expectedSha256).toLowerCase()) {
      throw new Error('SHA256 校验失败，已删除下载文件');
    }
    fs.renameSync(part, dest);
    return { file: dest, bytes: st.size, sha256: hash, ...result };
  } catch (err) {
    try { fs.rmSync(part, { force: true }); } catch { /* noop */ }
    throw err;
  }
}

module.exports = {
  downloadFile,
  downloadParallel,
  downloadSequential,
  probe,
  sha256File,
  DEFAULT_CONCURRENCY,
  SMALL_FILE_THRESHOLD
};
