"use strict";
/*
 * rotate-crop.html 静态体检(Node,无需浏览器)—— 跟同级 mi_ebadge/pagecheck.js 同一套路
 *
 *   node pagecheck.js
 *
 * 页面是「双击即开」的单文件工具,没有构建步骤,最容易踩的两类错:
 *   1) JS 里 $('x') / bindRange('x', …) 的 id 在 HTML 里不存在 —— 运行时才炸
 *   2) 内联脚本语法错 —— 整个 IIFE 不执行,页面全白
 * 另外把「面板枚举与引擎导出的表一致」也核一遍,免得手写第二份尺寸表。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'rotate-crop.html'), 'utf8');
const RC = require('./rotate-crop.js');

let fail = 0, pass = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '   -> ' + got); }
};

// ---------- 1) 内联脚本语法 ----------
console.log('\n[语法] 内联脚本');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok('找到内联脚本', scripts.length > 0, scripts.length);
scripts.forEach((src, i) => {
  let err = null;
  try { new vm.Script(src, { filename: 'inline#' + i }); } catch (e) { err = e.message; }
  ok('inline#' + i + ' 语法通过(' + src.split('\n').length + ' 行)', !err, err);
});

// ---------- 2) id 对账 ----------
console.log('\n[id] 引用与定义');
const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const js = scripts.join('\n');
const refs = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  // 以字符串参数传 id 的绑定函数($('x') 的正则扫不到,只能在运行时炸)
  ...[...js.matchAll(/bind(?:Range|Color|Text)\('([^']+)'/g)].map((m) => m[1]),
  ...[...js.matchAll(/bind(?:Range|Color|Text)\('[^']+',\s*'([^']+)'/g)].map((m) => m[1])
]);
ok('有 id 引用', refs.size > 0, refs.size);
[...refs].sort().forEach((id) => ok('#' + id + ' 存在', defined.has(id), 'HTML 里没有'));

// ---------- 3) 外部脚本 ----------
console.log('\n[资源] 外部脚本');
const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
ok('引用了 rotate-crop.js', srcs.includes('rotate-crop.js'), srcs.join(','));
srcs.forEach((s) => {
  ok(s + ' 文件存在', fs.existsSync(path.join(ROOT, s)), '缺失');
  ok(s + ' 是相对路径(file:// 下才会工作)', !/^([a-z]+:)?\/\//i.test(s), s);
});
ok('没有外部 http(s) 依赖(离线可用)', !/https?:\/\//.test(srcs.join(',')), srcs.join(','));

// ---------- 4) 引擎常量与文档一致 ----------
console.log('\n[常量] 与 自制应援效果.md 的 rotate 表一致');
ok('基准画布 466', RC.REF === 466, RC.REF);
ok('四环半径 0.5 / 0.375 / 0.25 / 0.125',
  RC.RING.outer === 0.5 && RC.RING.ring2 === 0.375 && RC.RING.ring3 === 0.25 && RC.RING.inner === 0.125,
  JSON.stringify(RC.RING));
ok('2 环组边长 0.75', RC.SPRITE.odd.side === 0.75, RC.SPRITE.odd.side);
ok('2 环组 = 内圆 + 2 环,90°→0°',
  RC.SPRITE.odd.bands.length === 2 && RC.SPRITE.odd.from === 90 && RC.SPRITE.odd.to === 0,
  JSON.stringify(RC.SPRITE.odd));
ok('外环组与原实现反向(-90°→0°)',
  RC.SPRITE.even.from === -90 && RC.SPRITE.even.to === 0, JSON.stringify(RC.SPRITE.even));

// ---------- 5) 页面里引用的尺寸枚举由引擎给出 ----------
console.log('\n[枚举] 面板不手写第二份');
ok('页面用了 RC.SPRITE 而不是硬编码 0.375/0.75',
  /RC\.SPRITE/.test(js) && !/0\.375/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')));

// ---------- 汇总 ----------
console.log('\n' + (fail ? `✗ ${fail} 项失败 / ${pass + fail} 项` : `✓ ${pass}/${pass} 全绿`));
process.exit(fail ? 1 : 0);
