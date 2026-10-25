'use strict';
/**
 * 端口与运行态工具。
 *
 * 目标：不再因为 8787 / 9222 被别的程序占用就启动失败。
 *   · 服务端口：从 config.server.port 开始向后找空闲端口
 *   · CDP 端口：从 config.ai.cdpPort 开始向后找空闲端口
 *   · 实际端口写进 data/runtime.json，launcher / 桌面窗口 / 前端都读它
 *
 * 这里只做本机端口探测，不扫描外网，也不碰任何用户数据。
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';

function isPortFree(port, host = HOST) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return Promise.resolve(false);
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (free) => {
      if (done) return;
      done = true;
      try { srv.close(); } catch { /* noop */ }
      resolve(free);
    };
    srv.once('error', () => finish(false));
    srv.once('listening', () => finish(true));
    try {
      srv.listen({ port: p, host, exclusive: true });
    } catch {
      finish(false);
    }
  });
}

async function findFreePort(start, { host = HOST, max = 50 } = {}) {
  const first = Number(start);
  if (!Number.isInteger(first) || first < 1 || first > 65535) {
    throw new Error('端口起点无效: ' + start);
  }
  for (let p = first; p < Math.min(65536, first + max); p++) {
    if (await isPortFree(p, host)) return p;
  }
  throw new Error(`从 ${first} 开始连续 ${max} 个端口都被占用`);
}

async function isQunZai(port, host = HOST) {
  try {
    const resp = await fetch(`http://${host}:${port}/api/status`, {
      signal: AbortSignal.timeout(900)
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!(data && data.qq && data.version);
  } catch {
    return false;
  }
}

async function isCdp(port, host = HOST) {
  try {
    const resp = await fetch(`http://${host}:${port}/json/version`, {
      signal: AbortSignal.timeout(700)
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!(data && data.Browser);
  } catch {
    return false;
  }
}

function runtimeFile(root) {
  // 数据目录可能与程序目录分开（安卓），所以优先用 QUNZAI_DATA_DIR
  const dir = String(process.env.QUNZAI_DATA_DIR || '').trim()
    ? path.resolve(process.env.QUNZAI_DATA_DIR)
    : path.join(root, 'data');
  return path.join(dir, 'runtime.json');
}

function readRuntime(root) {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(root), 'utf8'));
  } catch {
    return {};
  }
}

function writeRuntime(root, patch = {}) {
  const file = runtimeFile(root);
  const next = {
    ...readRuntime(root),
    ...patch,
    pid: process.pid,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 运行态写不进去不影响服务 */ }
  return next;
}

module.exports = {
  HOST,
  isPortFree,
  findFreePort,
  isQunZai,
  isCdp,
  runtimeFile,
  readRuntime,
  writeRuntime
};
