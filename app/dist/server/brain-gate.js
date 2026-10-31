'use strict';
/**
 * 大脑占用协调
 * ---------------------------------------------------------------------------
 * 现有的网页版驱动是**单飞**的：deepseek-web.js:374 里
 *     if (this._busy) throw new Error('正在生成上一条回复')
 * 也就是说同一时刻只能有一个请求在跑。
 *
 * 危险场景：用户正在群里 @ 机器人问问题，主动发言恰好也在生成，
 * 结果真人那条 reply 抛错变成 ai_error——用户体感是「越问它越不理我」。
 *
 * 这个文件只做一件事：给请求分优先级 + 排队。
 *   优先级：reply（真人 @ / 回复）3 > interject（兴趣插话）2 > initiate（主动开口）1
 * 高优先级可以直接超车；同优先级 FIFO。
 *
 * 为什么不是简单的 try/catch 重试：
 *   重试会在「强意图」时疯狂打满驱动，而抢不到的重试只是把错误延后。
 *   排队能让主动发言在真人有空档时才跑，逻辑上更干净。
 *   重试仍然保留在 ai.js 里做最后兜底（驱动自己也会因为别的原因抛这个错）。
 */

const PRI = { reply: 3, interject: 2, initiate: 1 };

class BrainGate {
  constructor({ timeoutMs = 60000, log } = {}) {
    this.timeoutMs = timeoutMs;
    this.log = typeof log === 'function' ? log : () => {};
    this._chain = Promise.resolve();
    this._waiting = [];
    this._active = null;
  }

  /**
   * 排队执行一个需要大脑的任务。
   * @param {string} kind 'reply'|'interject'|'initiate'
   * @param {()=>Promise<any>} task
   * @returns {Promise<any>}
   */
  run(kind, task) {
    const pri = PRI[kind] || 1;
    return new Promise((resolve, reject) => {
      const job = { pri, task, resolve, reject, kind, at: Date.now() };
      // 高优先级插到前面（同优先级保持 FIFO）
      const idx = this._waiting.findIndex((j) => j.pri < pri);
      if (idx < 0) this._waiting.push(job);
      else this._waiting.splice(idx, 0, job);
      this._pump();
    });
  }

  /**
   * 只在「大脑现在确实空闲」时才跑，抢不到就立刻放弃。
   * 主动发言用这个：它宁可这轮不说，也不要排队占着位置。
   * @returns {Promise<{ok:boolean, reason?:string, value?:any}>}
   */
  async tryRun(kind, task) {
    if (this._active || this._waiting.length) return { ok: false, reason: '大脑正忙' };
    try {
      const value = await this.run(kind, task);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  get busy() {
    return !!this._active || this._waiting.length > 0;
  }

  queueDepth() {
    return this._waiting.length;
  }

  _pump() {
    if (this._active || !this._waiting.length) return;
    const job = this._waiting.shift();
    this._active = job;
    // 不 await：链式推进靠 _pump 自己在 finally 里再调一次
    Promise.resolve()
      .then(() => job.task())
      .then(
        (v) => job.resolve(v),
        (e) => job.reject(e)
      )
      .finally(() => {
        this._active = null;
        this._pump();
      });
  }

  state() {
    return {
      busy: this.busy,
      active: this._active ? { kind: this._active.kind, ms: Date.now() - this._active.at } : null,
      waiting: this._waiting.map((j) => ({ kind: j.kind, ms: Date.now() - j.at }))
    };
  }
}

module.exports = { BrainGate, PRI };
