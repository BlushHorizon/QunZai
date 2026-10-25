'use strict';
/**
 * 群崽 · 无控制台补丁（no-console）
 * ---------------------------------------------------------------------------
 * 解决的问题
 *   内置的 QQ 监视器（NapCat 等）由群崽在后台拉起，群崽自己是 GUI 程序，
 *   本来不该出现任何命令行黑框。但这些第三方运行时的内部实现常常会再 fork
 *   一个 worker 子进程，并且 fork 时不传 windowsHide。Windows 上父进程没有
 *   控制台时，子进程带 inherit 的 stdio 就会**新开一个控制台窗口**——
 *   这就是用户看到的那个黑色命令行框（标题是 node.exe 路径）。
 *
 * 为什么在群崽这边修
 *   监视器是第三方程序，源码不能改（改了也没法跟着版本更新）。
 *   Node 的 NODE_OPTIONS 环境变量可以给监视器主进程预加载一段脚本，
 *   从进程内部把 child_process 的 spawn / fork / execFile 统一补上
 *   windowsHide: true。监视器自己是察觉不到的，行为完全不变，
 *   只是不再给子进程开窗口。
 *
 * 注意
 *   · 只加 windowsHide，不动 detached / stdio / env，避免影响监视器的进程模型；
 *   · 用 Object.assign 生成新对象，不改调用方传进来的 options；
 *   · 这个文件要随 server/ 一起打包，engine.js 用绝对路径引用它。
 */
function patchOnce() {
  let cp;
  try { cp = require('child_process'); } catch { return; }

  // 幂等：重复 require（例如监视器自己也 require 了一次）时不会套娃
  if (cp.__qunzaiNoConsole) return;
  try { Object.defineProperty(cp, '__qunzaiNoConsole', { value: true, enumerable: false }); } catch { /* noop */ }

  const hide = (opts) => {
    if (opts === null || typeof opts !== 'object') opts = {};
    // 已经是 true 就不动，保持调用方原样
    if (opts.windowsHide === true) return opts;
    const next = Object.assign({}, opts, { windowsHide: true });
    return next;
  };

  // 这些函数的签名都是 (command|modulePath, args?, options?)
  const names = ['spawn', 'fork', 'execFile', 'exec'];
  for (const name of names) {
    const orig = cp[name];
    if (typeof orig !== 'function') continue;
    cp[name] = function patched(...args) {
      if (name === 'exec') {
        // exec(command, options?, callback) —— 第二个参数可能是 options 或 callback
        if (args.length >= 2 && typeof args[1] === 'object' && args[1] !== null) {
          args[1] = hide(args[1]);
        } else if (args.length >= 2) {
          args.splice(1, 0, { windowsHide: true });
        } else {
          args.push({ windowsHide: true });
        }
      } else {
        // spawn/fork/execFile(command, args?, options?)
        if (args.length >= 3 && typeof args[2] === 'object' && args[2] !== null) {
          args[2] = hide(args[2]);
        } else if (args.length === 2 && Array.isArray(args[1])) {
          args.push({ windowsHide: true });
        } else if (args.length === 2) {
          args[1] = hide(args[1]);
        } else {
          args.push({ windowsHide: true });
        }
      }
      return orig.apply(this, args);
    };
  }

  // 让 ESM 里的 `import { fork } from 'child_process'` 也拿到打过补丁的版本
  // （NapCat 内部正是 `await import("child_process")` 之后再 fork 的）
  try {
    const mod = require('module');
    if (typeof mod.syncBuiltinESMExports === 'function') mod.syncBuiltinESMExports();
  } catch { /* 老版本 Node 没有这个 API，忽略 */ }
}

patchOnce();

module.exports = { patched: true };
