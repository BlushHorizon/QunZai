'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { QqBotBindManager, decryptSecret } = require('./app/server/qqbot-bind');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + e.message); } }
function ta(name, fn) { return fn().then(() => { pass++; console.log('  ✓ ' + name); }, (e) => { fail++; console.log('  ✗ ' + name + ' — ' + e.message); }); }

async function main() {
  console.log('== AES-GCM 解密 ==');
  t('加解密往返（iv12+ct+tag16 布局）', () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const secret = 'sk-test-abc123-机器人密钥';
    const d = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([d.update(secret, 'utf8'), d.final()]);
    const payload = Buffer.concat([iv, ct, d.getAuthTag()]).toString('base64');
    assert.strictEqual(decryptSecret(payload, key.toString('base64')), secret);
  });
  t('密文被截断 → 明确报错', () => {
    assert.throws(() => decryptSecret(Buffer.from('aGVsbG8=', 'base64').toString('base64'), Buffer.from('x'.repeat(32)).toString('base64')));
  });
  t('key 错 → GCM auth 失败', () => {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const d = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([d.update('hello'), d.final()]);
    const payload = Buffer.concat([iv, ct, d.getAuthTag()]).toString('base64');
    assert.throws(() => decryptSecret(payload, crypto.randomBytes(32).toString('base64')));
  });

  console.log('== 状态机 ==');
  t('初始 idle', () => {
    const m = new QqBotBindManager({});
    assert.strictEqual(m.statusSnapshot().status, 'idle');
  });
  t('cancel 后回 idle 且无凭据', () => {
    const m = new QqBotBindManager({});
    m.status = 'pending'; m.taskId = 'x'; m.key = 'y'; m.connectUrl = 'https://q';
    m.cancel();
    const s = m.statusSnapshot();
    assert.strictEqual(s.status, 'idle');
    assert.strictEqual(s.connectUrl, null);
    assert.strictEqual(s.credentials, null);
  });
  t('confirmTaken 取走凭据并复位', () => {
    const m = new QqBotBindManager({});
    m.status = 'done'; m.result = { appId: 'A', appSecret: 'S', userOpenid: 'U' };
    const cred = m.confirmTaken();
    assert.strictEqual(cred.appId, 'A');
    assert.strictEqual(m.statusSnapshot().status, 'idle');
  });

  console.log('== 真实 create_bind_task（腾讯官方接口连通性）==');
  await ta('start() 建任务并拿到官方连接页', async () => {
    const m = new QqBotBindManager({ log: () => {} });
    const url = await m.start();
    assert.ok(url.startsWith('https://q.qq.com/qqbot/openclaw/connect.html?task_id='), url);
    assert.strictEqual(m.status, 'pending');
    assert.ok(m.taskId);
    m.cancel();
  });

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main();
