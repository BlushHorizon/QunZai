'use strict';
/* QQ 官方机器人「扫码绑定」——把 q.qq.com 的官方绑定页内置进群崽设置面板。
 *
 * 协议（与官方 npm 包 @tencent-connect/qqbot-connector 1.2.0 逐行核对，零依赖自实现）：
 *  1. POST https://q.qq.com/lite/create_bind_task   body {key: 随机32字节base64}
 *     → {retcode:0, data:{task_id}}；key 之后用于解密 secret，必须留到流程结束
 *  2. 官方绑定页 = https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&source=…&_wv=2
 *     群崽直接把它 iframe 进设置面板：官方页面自带二维码和扫码指引
 *  3. POST https://q.qq.com/lite/poll_bind_result    body {task_id}
 *     → {retcode:0, data:{status:0未扫/1等待确认/2完成/3过期, bot_appid, bot_encrypt_secret, user_openid}}
 *  4. bot_encrypt_secret = base64( iv[12] + 密文 + authTag[16] )，AES-256-GCM，key = 步骤1的 key
 *
 * 状态机：idle → pending（有 task）→ done（拿到凭据）/ expired（重开任务）→ idle
 */
const crypto = require('crypto');
const https = require('https');

const BIND_HOST = 'q.qq.com';
const CONNECT_URL = 'https://q.qq.com/qqbot/openclaw/connect.html';

function _postJson(path, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: BIND_HOST,
      path,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': data.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + JSON.stringify(json).slice(0, 200)));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** AES-256-GCM 解密官方回传的 bot_encrypt_secret（base64: iv12+ct+tag16） */
function decryptSecret(encryptSecretB64, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const raw = Buffer.from(encryptSecretB64, 'base64');
  if (raw.length < 12 + 16) throw new Error('密文长度异常');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

class QqBotBindManager {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.reset();
  }

  reset() {
    this.taskId = null;
    this.key = null;          // 解密 key，与 task 一起生成
    this.connectUrl = null;   // 给 iframe 用的官方绑定页
    this.status = 'idle';     // idle | pending | done | failed
    this.error = null;
    this.result = null;       // {appId, appSecret, userOpenid}
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
  }

  /** 开一个新绑定任务，返回官方绑定页 URL（前端 iframe / 新窗口都行） */
  async start() {
    this.reset();
    const key = crypto.randomBytes(32).toString('base64');
    const r = await _postJson('/lite/create_bind_task', { key });
    if (r.retcode !== 0 || !r.data?.task_id) {
      this.status = 'failed';
      this.error = r.msg || 'create_bind_task 失败';
      throw new Error(this.error);
    }
    this.taskId = r.data.task_id;
    this.key = key;
    this.connectUrl = CONNECT_URL + '?task_id=' + encodeURIComponent(this.taskId) +
      '&source=' + encodeURIComponent('qunzai') + '&_wv=2';
    this.status = 'pending';
    this._pollLoop();
    this.log('[qqbot-bind] 绑定任务已创建，等用户扫码');
    return this.connectUrl;
  }

  _pollLoop() {
    clearTimeout(this._pollTimer);
    // 已完成就不再轮询；轮询中用户关面板也无妨，下轮 status 查询照常回
    const tick = async () => {
      if (this.status !== 'pending') return;
      try {
        const r = await _postJson('/lite/poll_bind_result', { task_id: this.taskId });
        if (r.retcode !== 0) throw new Error(r.msg || 'poll_bind_result retcode=' + r.retcode);
        const d = r.data || {};
        const st = Number(d.status);
        if (st === 2) {           // COMPLETED
          const appSecret = decryptSecret(d.bot_encrypt_secret, this.key);
          this.result = {
            appId: String(d.bot_appid || ''),
            appSecret,
            userOpenid: d.user_openid || ''
          };
          this.status = 'done';
          this.log('[qqbot-bind] 扫码成功，凭据已解密（appId ' + this.result.appId.replace(/\d{3}(?=\d{4})/, '***') + '）');
          return;                 // 完成后停轮询；凭据等前端来取，取完 reset()
        }
        if (st === 3) {           // EXPIRED → 官方页会引导刷新，我们重开一个任务
          this.log('[qqbot-bind] 二维码过期，自动重开任务');
          await this.start();
          return;
        }
        // 0 未扫 / 1 已扫待确认：继续轮
      } catch (e) {
        // 网络抖动不中断流程，下一轮再试
        this.log('[qqbot-bind] 轮询失败（继续）:', e.message);
      }
      this._pollTimer = setTimeout(tick, 2000);
      this._pollTimer.unref?.();
    };
    tick();
  }

  /** 前端查询当前进度 */
  statusSnapshot() {
    return {
      status: this.status,                 // idle|pending|done|failed
      connectUrl: this.status === 'pending' ? this.connectUrl : null,
      error: this.error,
      // done 时一次性返回明文凭据；前端拿到后调 /confirm 触发落盘
      credentials: this.status === 'done' ? this.result : null
    };
  }

  /** 凭据落盘由 server.js 做（写 config + rebuildAdapter），这里只清理任务状态 */
  confirmTaken() {
    const r = this.result;
    this.reset();
    return r;
  }

  cancel() {
    this.reset();
  }
}

module.exports = { QqBotBindManager, decryptSecret };
