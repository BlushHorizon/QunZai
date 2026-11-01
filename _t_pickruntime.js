'use strict';
/* 用真实路径形状测（单个反斜杠），不用双反斜杠造的假数据 */
const { pickRuntime, normDir } = require('./app/server/engine.js');
const B = String.fromCharCode(92);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); } };

const NAPCAT = 'D:' + B + 'qz' + B + 'engine' + B + 'napcat';
const SNOW   = 'D:' + B + 'SnowLuma-v1.14.22-win-x64';
const cands  = [{ dir: NAPCAT, wsPort: 3001 }, { dir: SNOW, wsPort: 3001 }];

ok('1 running wins over list order', pickRuntime(cands, [SNOW]).dir.includes('SnowLuma'));
ok('2 falls back to first when none live', pickRuntime(cands, []).dir.includes('napcat'));
ok('3 forward-slash live dir matches backslash candidate',
  pickRuntime(cands, ['D:/SnowLuma-v1.14.22-win-x64']).dir.includes('SnowLuma'));
ok('4 case-insensitive', pickRuntime(cands, ['d:' + B + 'snowluma-v1.14.22-WIN-x64']).dir.includes('SnowLuma'));
ok('5 trailing separator ignored', pickRuntime(cands, ['D:/SnowLuma-v1.14.22-win-x64/']).dir.includes('SnowLuma'));
ok('6 empty safe', pickRuntime([], []) === null);
ok('7 null safe', pickRuntime(null, null) === null);
ok('8 normDir strips trailing sep', normDir('D:' + B + 'x' + B) === 'd:/x', JSON.stringify(normDir('D:' + B + 'x' + B)));
ok('9 live dir not in candidates -> first', pickRuntime(cands, ['E:/other']).dir.includes('napcat'));
/* 10. 真实场景回归：内置 NapCat 排第一但从没登录，SnowLuma 在跑 */
const realCands = [
  { dir: 'D:' + B + 'qz' + B + 'engine' + B + 'napcat', wsPort: 3001 },
  { dir: 'D:' + B + 'SnowLuma-v1.14.22-win-x64', wsPort: 3001 }
];
const picked = pickRuntime(realCands, ['D:' + B + 'SnowLuma-v1.14.22-win-x64']);
ok('10 real-world: picks running SnowLuma not bundled NapCat', picked.dir.includes('SnowLuma'), picked.dir);

console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
