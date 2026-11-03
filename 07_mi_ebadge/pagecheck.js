"use strict";
/*
 * cheer-preview.html 静态体检(Node,无需浏览器)
 *
 * 页面是「双击即开」的单文件工具,没有构建步骤,所以最容易踩的两类错是:
 *   1) JS 里 getElementById 的 id 和 HTML 里的对不上 —— 运行时才炸
 *   2) 内联脚本语法错 —— 整个 IIFE 不执行,页面全白
 * 这里把两者都在 CI 里拦掉。
 *
 *   node pagecheck.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'cheer-preview.html'), 'utf8');
let fail = 0, pass = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '   -> ' + got); }
};

// ---------- 取出内联脚本 ----------
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
ok('页面有 1 段内联脚本', scripts.length === 1, scripts.length);
const js = scripts.join('\n');

// ---------- 语法 ----------
try { new vm.Script(js, { filename: 'inline' }); ok('内联脚本语法通过', true); }
catch (e) { ok('内联脚本语法通过', false, e.message); }
['cheer-preview.js', 'preset-image.js'].forEach((f) => {
  try {
    new vm.Script(fs.readFileSync(path.join(__dirname, f), 'utf8'), { filename: f });
    ok(f + ' 语法通过', true);
  } catch (e) { ok(f + ' 语法通过', false, e.message); }
});

// ---------- id 对账 ----------
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set();
// $('x') 与 getElementById('x')
[...js.matchAll(/\$\('([^']+)'\)/g)].forEach((m) => used.add(m[1]));
[...js.matchAll(/getElementById\('([^']+)'\)/g)].forEach((m) => used.add(m[1]));
// bindRange / bindColor / buildSeg 把 id 当字符串参数传进去 —— 这些不会以 $('x')
// 的形式出现,漏掉的话里面的 id 拼错要到运行时才炸,正是最该拦的一类
[...js.matchAll(/\bbindRange\('([^']+)',\s*'([^']+)'/g)].forEach((m) => { used.add(m[1]); used.add(m[2]); });
[...js.matchAll(/\bbindColor\('([^']+)',\s*'([^']+)'/g)].forEach((m) => { used.add(m[1]); used.add(m[2]); });
const missing = [...used].filter((id) => !htmlIds.has(id));
ok('JS 引用的 id 全部存在于 HTML(' + used.size + ' 个)', missing.length === 0, missing.join(','));

// 反向:HTML 里声明了却没人用的 id(只提示,不算失败)
const unused = [...htmlIds].filter((id) => !used.has(id));
if (unused.length) console.log('       (未被 JS 引用,可能是纯 CSS 钩子) ' + unused.join(', '));

// ---------- 外链资源存在 ----------
[...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].forEach((m) => {
  ok('外链脚本存在 ' + m[1], fs.existsSync(path.join(__dirname, m[1])), m[1]);
});

// ---------- 引擎暴露的 API 与页面用到的一致 ----------
const CP = require('./cheer-preview.js');
const apiUsed = new Set([...js.matchAll(/\bCP\.(\w+)/g)].map((m) => m[1]));
const apiMissing = [...apiUsed].filter((k) => CP[k] === undefined);
ok('页面用到的 CP.* 全部导出(' + apiUsed.size + ' 个)', apiMissing.length === 0, apiMissing.join(','));

// 页面调用的引擎方法
const proto = CP.Engine.prototype;
['resize', 'set', 'reset', 'step', 'start', 'stop', 'running', 'render']
  .forEach((m) => ok('Engine.' + m + ' 存在', typeof proto[m] === 'function', typeof proto[m]));
// 页面读的内部字段(onframe 里用到)
const e = new CP.Engine({ getContext: () => null, style: {} });
['_textPhase', '_scrollOffset', '_lightPhase']
  .forEach((k) => ok('Engine 暴露 ' + k, typeof e[k] === 'number', typeof e[k]));
ok('Engine._inkColor 存在', typeof e._inkColor === 'function', typeof e._inkColor);

// ---------- 面板里的枚举与引擎枚举一一对应 ----------
// 面板必须由引擎导出的枚举表生成,不手写第二份 —— 否则加一个效果要改两处
// bgFx 走 BG_FX_SEG(把 period 映射成 note 的中间变量),其余直接用 CP.*
[['textFx', 'CP.TEXT_FX'], ['bgFx', 'BG_FX_SEG'], ['textLayout', 'CP.TEXT_LAYOUT'],
 ['screen', 'CP.SCREENS']].forEach(([id, src]) => {
  const re = new RegExp('buildSeg\\(\\$\\(\'' + id + '\'\\),\\s*' + src.replace('.', '\\.'));
  ok(id + ' 面板由 ' + src + ' 生成', re.test(js), re.source);
});
ok('TEXT_FX 覆盖 5 个枚举',
   CP.TEXT_FX.map((x) => x.value).join(',') === 'static,scroll,multiline,blink,rainbow',
   CP.TEXT_FX.map((x) => x.value).join(','));
ok('BG_FX 覆盖 6 个枚举',
   CP.BG_FX.map((x) => x.value).join(',') === 'none,breathe,pulse,open,blur,rotate',
   CP.BG_FX.map((x) => x.value).join(','));
ok('BG_ALIAS 三条改写齐全',
   CP.BG_ALIAS.step === 'open' && CP.BG_ALIAS.shrink === 'blur' && CP.BG_ALIAS.zoom === 'rotate',
   JSON.stringify(CP.BG_ALIAS));
ok('TEXT_LAYOUT = multi / single',
   CP.TEXT_LAYOUT.map((x) => x.value).join(',') === 'multi,single',
   CP.TEXT_LAYOUT.map((x) => x.value).join(','));
ok('SCREENS = 466 / 360 两档圆屏',
   CP.SCREENS.map((x) => x.value).join(',') === '466,360',
   CP.SCREENS.map((x) => x.value).join(','));

// ---------- 默认图 ----------
const presetPath = path.join(__dirname, 'preset-image.js');
ok('preset-image.js 存在', fs.existsSync(presetPath), presetPath);
const presetSrc = fs.readFileSync(presetPath, 'utf8');
ok('默认图挂在 window.CHEER_PRESET_IMAGE', /window\.CHEER_PRESET_IMAGE\s*=/.test(presetSrc), false);
ok('默认图是内联 base64(不依赖相对路径 / 不跨目录)',
   /src:\s*'data:image\/png;base64,/.test(presetSrc), false);
ok('默认图来源注明是 color_trans/img',
   /color_trans\/img\/badge-preset-image-9\.png/.test(presetSrc), false);
// base64 解回来必须是合法 PNG(头 8 字节固定),否则页面上就是一张空图
{
  const b64 = /base64,([A-Za-z0-9+/=]+)'/.exec(presetSrc);
  ok('默认图 base64 可提取', !!b64, false);
  if (b64) {
    const buf = Buffer.from(b64[1], 'base64');
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    ok('默认图解码后是合法 PNG(签名正确)',
       sig.every((v, i) => buf[i] === v), buf.slice(0, 8).toString('hex'));
    // IHDR 里的宽高:偏移 16..24
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    ok('默认图 ' + w + '×' + h + ' 是正方形(短边裁切后无损)', w === h, w + 'x' + h);
    // 文件头声明的 size 要与 PNG 实际宽高对得上,否则注释会骗人
    const declared = /size:\s*(\d+)/.exec(presetSrc);
    ok('默认图声明的 size 与 PNG 实际宽高一致',
       !!declared && +declared[1] === w, (declared ? declared[1] : '?') + ' vs ' + w);
    ok('默认图是 360²(正好对上 360 圆屏那一档)', w === 360, w);
  }
}
ok('页面在启动时装载默认图', /usePreset\(\);/.test(js), false);
ok('默认图与文件选择 / 拖放共用一条加载路径(useFile)',
   /function useFile\(/.test(js) && /useFile\(e\.dataTransfer\.files/.test(js), false);

// ---------- 圆屏 ----------
ok('引擎 data 默认 round = true', new CP.Engine({ getContext: () => null, style: {} }).data.round === true,
   new CP.Engine({ getContext: () => null, style: {} }).data.round);
ok('页面有圆形裁切开关(可切方屏对照)', htmlIds.has('round'), false);
ok('机身与画布都是圆形(border-radius: 50%)',
   (html.match(/border-radius:\s*50%/g) || []).length >= 2,
   (html.match(/border-radius:\s*50%/g) || []).length);
ok('引擎导出 layoutLines', typeof CP.layoutLines === 'function', typeof CP.layoutLines);

// ---------- 溢出提示 ----------
ok('读数区会报文字溢出(_clip)', /_clip/.test(js), false);
ok('溢出提示有高亮样式 .warn', /#meta \.warn/.test(html), false);
ok('溢出量按 466 基准折算(与字号同一把尺子)',
   /CP\.REF \/ en\.canvas\.width/.test(js), false);

console.log('\n' + (fail ? fail + ' FAILED / ' + pass + ' passed' : pass + '/' + pass + ' 全部通过'));
process.exit(fail ? 1 : 0);
