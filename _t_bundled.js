
const path = require('path');
const { QQEngine, normDir } = require('C:/Users/14132/Documents/默认项目/open-source/DeepPupil/app/server/engine.js');
const ROOT = 'D:\\群崽';
const mk = (source, dir) => new QQEngine({
  root: ROOT,
  getConfig: () => ({ qq: { engine: { source, dir, account: '', apiPort: 3000 } } }),
  saveConfig: () => {}
});
let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
};

// 1) bundled 模式：即使配置里残留 SnowLuma 目录，候选里也不能有它
{
  const e = mk('bundled', 'D:\\SnowLuma-v1.14.22-win-x64');
  const dirs = e._candidateDirs('');
  // 注意：候选里本来就有「内置槽位」engine\snowluma，要排除的是**外部的**那个目录
  const hasExternal = dirs.some(d => /snowluma-v1\.14/i.test(d));
  t('bundled 模式排除残留的外部 SnowLuma 目录', !hasExternal, JSON.stringify(dirs));
  t('bundled 模式包含内置 engine\\napcat', dirs.some(d => /engine[\\/]napcat$/i.test(d)), JSON.stringify(dirs));
}

// 2) custom 模式：只认用户填的目录（不含内置）
{
  const e = mk('custom', 'D:\\SnowLuma-v1.14.22-win-x64');
  const dirs = e._candidateDirs('');
  t('custom 模式包含用户目录', dirs.some(d => /snowluma/i.test(d)), JSON.stringify(dirs));
  t('custom 模式不含内置 napcat', !dirs.some(d => /engine[\\/]napcat$/i.test(d)), JSON.stringify(dirs));
}

// 3) auto 模式：内置优先，也包含用户目录
{
  const e = mk('auto', 'D:\\SnowLuma-v1.14.22-win-x64');
  const dirs = e._candidateDirs('');
  const iNap = dirs.findIndex(d => /engine[\\/]napcat$/i.test(d));
  const iSnow = dirs.findIndex(d => /snowluma/i.test(d));
  t('auto 模式两者都在', iNap >= 0 && iSnow >= 0, JSON.stringify(dirs));
  t('auto 模式内置排在前', iNap < iSnow, 'nap=' + iNap + ' snow=' + iSnow);
}

// 4) bundledDir 字段存在且指向 <root>\\engine
{
  const e = mk('bundled', '');
  t('bundledDir = root\\engine', normDir(e.bundledRoot) === normDir(ROOT + '\\engine'), e.bundledRoot);
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
