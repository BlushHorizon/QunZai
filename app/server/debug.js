'use strict';
/**
 * 群崽 · 调试日志开关
 * ---------------------------------------------------------------------------
 * 为什么需要它
 *   `server.js:63` 把 console.log 换成了「控制台实时显示 + 追加写 data\app.log」。
 *   追加、不截断 —— 也就是说**任何按条消息触发的 console.log 都会让日志文件
 *   无限增长**。记忆抽取在每 digestEvery(40) 条消息就 flush 一次并打一行，
 *   一个稍微活跃的群一天下来就是几千行，用户翻日志时真正重要的几行被埋掉。
 *
 * 怎么用
 *   高频、只在排查时有用的日志走 dbg()：默认不输出，设 QUNZAI_DEBUG=1 才打。
 *   低频、用户看得懂也需要的（发送成功、静音、人工标记）继续直接 console.log ——
 *   那些一天最多几十条，是产品行为的一部分，不是噪音。
 */
const DEBUG = process.env.QUNZAI_DEBUG === '1';

function dbg(...args) {
  if (!DEBUG) return;
  try { console.log(...args); } catch { /* noop */ }
}

module.exports = { DEBUG, dbg };
