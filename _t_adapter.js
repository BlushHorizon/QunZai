'use strict';
/* 验证：token 被拒 vs 运行时没起来，必须给出不同的可执行提示 */
const { OneBotAdapter } = require('./app/server/qq-adapter.js');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (e ? ' << ' + e : '')); } };

const a = new OneBotAdapter({ wsUrl: 'ws://127.0.0.1:3001', accessToken: '' });
ok('1 no token + never opened -> mentions 运行时没在监听', /运行时没在监听/.test(a._diagnoseError()), a._diagnoseError());
ok('2 no token msg does not falsely blame 未启动', !/未启动\?/.test(a._diagnoseError()));

const b = new OneBotAdapter({ wsUrl: 'ws://127.0.0.1:3001', accessToken: 'abc' });
ok('3 has token + never opened -> says Token 对不上', /Token 对不上/.test(b._diagnoseError()), b._diagnoseError());
ok('4 has token msg tells user where to fix', /设置/.test(b._diagnoseError()));

const c = new OneBotAdapter({ wsUrl: 'ws://127.0.0.1:3001', accessToken: 'abc' });
c._everOpened = true;
ok('5 was connected before -> says 重连 not token', /重连/.test(c._diagnoseError()) && !/Token 对不上/.test(c._diagnoseError()));

ok('6 _everOpened starts false', new OneBotAdapter({})._everOpened === false);

console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
