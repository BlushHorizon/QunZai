'use strict';
/**
 * 跨平台判定与路径小工具。
 *
 * 群崽最初是纯 Windows 桌面程序（NSIS 安装包 + 内置 NapCat Windows 版 +
 * Edge/Chrome 外部浏览器 + exe 自更新）。后来要出安卓 APK，服务端得能在
 * Linux / macOS / Android(bionic) 上跑起来，所以把「跟平台有关的判断」
 * 全部收到这个文件里，其他模块只调用函数，不再各自写 process.platform。
 *
 * 注意：Android 里的 Node 运行时（Termux node）虽然跑在 Linux 上，但
 * 它是 bionic 链接的，不能当成 glibc —— 所以不要在这里假设 glibc 特性。
 */
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
// Termux 的 node 直接把 process.platform 报成 'android'（不是 'linux'），
// 所以两条路都要认；普通 Linux 上则靠 ANDROID_ROOT / ANDROID_DATA 兜底判断。
const IS_ANDROID = process.platform === 'android'
  || (IS_LINUX && !!(process.env.ANDROID_ROOT || process.env.ANDROID_DATA));

/** node 可执行文件名：Windows 要带 .exe，别的平台就是 node */
function nodeBinName() {
  return IS_WIN ? 'node.exe' : 'node';
}

/**
 * 在某个目录里找 node 可执行文件。
 * Windows 下随包内置的是 node.exe；Linux/macOS/Android 下一般是
 * 同目录的 node，或干脆用系统 PATH 里的 node。
 */
function findNodeExe(dir) {
  if (IS_WIN) {
    const p = path.join(dir, 'node.exe');
    try { if (fs_exists(p)) return p; } catch { /* noop */ }
    return 'node.exe';
  }
  const p = path.join(dir, 'node');
  try { if (fs_exists(p)) return p; } catch { /* noop */ }
  return 'node';
}

// 单独拎出来，避免顶部就 require('fs') 造成循环引用时的副作用
function fs_exists(p) {
  try { return require('fs').existsSync(p); } catch { return false; }
}

/**
 * 浏览器（Edge/Chrome/Chromium）可执行文件的候选路径。
 * 桌面版 Windows 用 Edge/Chrome；Linux 用发行版包名；macOS 用 .app 包。
 */
function browserCandidates() {
  if (IS_WIN) {
    return [
      `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.LOCALAPPDATA || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['ProgramFiles(x86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`
    ];
  }
  const list = [
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium', '/opt/google/chrome/chrome',
    '/usr/bin/microsoft-edge-beta', '/usr/bin/google-chrome-beta'
  ];
  if (IS_MAC) {
    list.unshift(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  }
  return list;
}

/** 用户可写的数据目录（配置、数据库、缓存） */
function userDataDir() {
  if (IS_WIN) {
    return process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'QunZai')
      : path.join(os.homedir(), '.qunzai');
  }
  if (IS_MAC) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'QunZai');
  }
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'qunzai')
    : path.join(os.homedir(), '.local', 'share', 'qunzai');
}

/**
 * 应用根目录：默认是代码所在目录的上一级（server/ 的父目录）。
 * 安卓上代码被打进 APK 的 assets（只读），宿主启动时会把整套东西复制到
 * 应用私有目录，再用 QUNZAI_ROOT 指过来。
 */
function resolveRoot(defaultRoot) {
  const env = String(process.env.QUNZAI_ROOT || '').trim();
  if (env) return path.resolve(env);
  return defaultRoot;
}

/** 数据目录（会话库、表情包缓存、日志） */
function resolveDataDir(root) {
  const env = String(process.env.QUNZAI_DATA_DIR || '').trim();
  if (env) return path.resolve(env);
  return path.join(root, 'data');
}

/**
 * 平台信息：给前端判断哪些入口可用。
 * - win / mac / linux：桌面端，全功能
 * - android：网页版模式不可用（没有带 CDP 的浏览器），自更新不可用
 */
function platformInfo() {
  const os = process.platform;
  if (IS_ANDROID) {
    return { os: 'android', isWindows: false, isMac: false, isLinux: true, isAndroid: true, webSupported: false, selfUpdate: false, label: 'Android' };
  }
  return {
    os,
    isWindows: IS_WIN,
    isMac: IS_MAC,
    isLinux: IS_LINUX,
    isAndroid: false,
    webSupported: true,
    selfUpdate: IS_WIN,
    label: IS_WIN ? 'Windows' : (IS_MAC ? 'macOS' : 'Linux')
  };
}

module.exports = {
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  IS_ANDROID,
  nodeBinName,
  findNodeExe,
  browserCandidates,
  userDataDir,
  resolveRoot,
  resolveDataDir,
  platformInfo
};
