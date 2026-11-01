
const fs = require('fs');
const p = 'C:/Users/14132/Documents/默认项目/open-source/DeepPupil/app/public/app.js';
let s = fs.readFileSync(p, 'utf8');
const before = s.length;

// 1) 删 refreshMemoryPanel / showMemoryList / MEM_KIND_LABEL / fillForgetSelect 相关函数块（592 行起到 showMemoryList 结束）
function cutFn(name) {
  const idx = s.indexOf('function ' + name);
  if (idx < 0) { console.log('skip', name); return; }
  // 找到函数开始前的注释块起点（往上找连续的 // 行）
  let start = idx;
  // 函数体：从 idx 的 { 开始配平大括号
  let i = s.indexOf('{', idx), depth = 0, end = -1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { console.log('unbalanced', name); return; }
  s = s.slice(0, start) + s.slice(end);
  console.log('cut', name, end - start, 'bytes');
}
['refreshMemoryPanel', 'showMemoryList', 'fillForgetSelect'].forEach(cutFn);
fs.writeFileSync(p, s, 'utf8');
console.log('len', before, '->', s.length);
