"use strict";
/*
 * cheer-preview.js 回归自测(Node,不碰 DOM)
 *
 * 用 stub 的 2D context 记录绘制调用,把文档里给出的数值当 ground truth 核对:
 * 速度、周期、相位、行距、色相、枚举回退、别名改写、缩放不变性。
 *
 *   node selftest.js
 *
 * 注意:stub 的 _log 会跨帧累加,读取前一律先 frame() 清空再重绘 ——
 * render() 对状态是纯函数,所以「清空 + 重绘」等价于只看最后一帧。
 */
const CP = require('./cheer-preview.js');

let fail = 0, pass = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '   -> ' + got); }
};
const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps);

// ---------- stub context ----------
// save/restore 必须真的存取状态:否则背景的 globalAlpha / filter 会漏到后面的
// 文字读数上,把「文字不参与背景变换」这条测成假阳性。
const STATE_KEYS = ['filter', 'font', 'textBaseline', 'fillStyle', 'globalAlpha'];
function stubCtx() {
  const log = [];
  return {
    _log: log, _stack: [],
    filter: 'none', font: '', textBaseline: '',
    fillStyle: '', globalAlpha: 1,
    save() {
      log.push('save');
      const s = {}; STATE_KEYS.forEach((k) => { s[k] = this[k]; });
      this._stack.push(s);
    },
    restore() {
      log.push('restore');
      const s = this._stack.pop();
      if (s) STATE_KEYS.forEach((k) => { this[k] = s[k]; });
    },
    fillRect(x, y, w, h) {
      log.push('fillRect ' + [x, y, w, h].map(Math.round).join(',') +
               ' a=' + this.globalAlpha.toFixed(3) + ' c=' + this.fillStyle +
               ' f=' + this.filter);
    },
    clearRect(x, y, w, h) { log.push('clearRect ' + [x, y, w, h].map(Math.round).join(',')); },
    fillText(t, x, y) {
      // 坐标留 6 位小数:0.1px 的精度不足以验证缩放不变性。
      // 连 font 一起记:圆屏裁切的 restore() 会把 ctx.font 复位成绘制前的值
      // (真实 canvas 行为),所以不能在绘制后读 ctx.font 当读数。
      this._baselineAtDraw = this.textBaseline;
      log.push('fillText "' + t + '" ' + x.toFixed(6) + ',' + y.toFixed(6) +
               ' a=' + this.globalAlpha.toFixed(3) + ' c=' + this.fillStyle +
               ' font=' + this.font);
    },
    // 每字宽 = 1 em(按 CJK 全角),随 font 的 px 缩放 —— 必须跟着缩放,
    // 否则 span = 文字宽 + 画布宽 不随尺寸等比变化,缩放不变性就测不出来
    measureText(t) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
      return { width: t.length * (m ? parseFloat(m[1]) : 0) };
    },
    translate() {}, scale() {}, rotate() {},
    beginPath() {},
    // 记录 arc + clip:圆屏裁切要能被断言「确实加了、且半径是内切圆」
    arc(cx, cy, r) { log.push('arc ' + cx + ',' + cy + ',' + r); },
    clip() { log.push('clip'); },
    drawImage() { log.push('drawImage f=' + this.filter); }
  };
}
// size = 预览像素;css = size/dpr,模拟 resize 之后的状态
function engine(size, dpr) {
  const e = new CP.Engine({ getContext: () => null, style: {} });
  e.ctx = stubCtx();
  e.canvas = { width: size, height: size, style: {} };
  e._dpr = dpr || 1;
  e._css = size / (dpr || 1);
  return e;
}
// 只保留最后一帧的绘制调用
const frame = (e) => { e.ctx._log.length = 0; e.render(); return e; };
const run = (patch, frames, size, dpr) => {
  const e = engine(size || 466, dpr);
  e.set(patch);
  for (let i = 0; i < (frames || 0); i++) e.step();
  return frame(e);
};
const texts = (e) => e.ctx._log.filter((s) => s.indexOf('fillText') === 0);
const rects = (e) => e.ctx._log.filter((s) => s.indexOf('fillRect') === 0);
const xOf = (s) => parseFloat(s.match(/ (-?[\d.]+),/)[1]);
const yOf = (s) => parseFloat(s.match(/,(-?[\d.]+) a=/)[1]);
const aOf = (s) => parseFloat(s.match(/a=([\d.]+)/)[1]);
const fOf = (s) => s.match(/f=(.*)$/)[1];
// 每行只取主体那一次(wrap 补画的副本在后面)
const mainPerLine = (e) => {
  const seen = new Map();
  texts(e).forEach((s) => { const y = yOf(s); if (!seen.has(y)) seen.set(y, s); });
  return [...seen.values()];
};

console.log('\n— 纯函数 —');
ok('phase 1 单位 = 1.5 秒', CP.effectSeconds(1, 1) === 1.5, CP.effectSeconds(1, 1));
ok('speed 下限 0.25', CP.effectSeconds(1, 0.1) === 0.375, CP.effectSeconds(1, 0.1));
ok('cheerLines: trim + 去空行 + 最多 6 行',
   JSON.stringify(CP.cheerLines(' a \n\n b \nc\nd\ne\nf\ng')) === '["a","b","c","d","e","f"]',
   JSON.stringify(CP.cheerLines(' a \n\n b \nc\nd\ne\nf\ng')));
ok('wrap 负数取正', CP.wrap(-0.3, 2) === 1.7, CP.wrap(-0.3, 2));
ok('lerp', CP.lerp(1.5, 1.1, 0.5) === 1.3, CP.lerp(1.5, 1.1, 0.5));

console.log('\n— 全组合冒烟 —');
let combos = 0, empty = [];
for (const t of CP.TEXT_FX) for (const b of CP.BG_FX) {
  const e = run({ scrollMode: t.value, bgLightEffect: b.value, text: '一起\n为你\n发光' }, 60);
  if (texts(e).length === 0) empty.push(t.value + '/' + b.value);
  combos++;
}
ok('5 textFx × 6 bgFx = 30 组合各跑 60 帧不抛', combos === 30, combos);
// blink 在 0.5s 整点 alpha=0 仍会调 fillText(alpha 0),所以任何组合都不该是空的
ok('30 组合第 60 帧都有文字绘制', empty.length === 0, empty.join(','));

console.log('\n— 速度(466 画布,1 秒 = 24 帧) —');
ok('scroll 单行 1 秒 = 466/4 = 116.5 px',
   near(run({ scrollMode: 'scroll', text: 'A' }, 24)._scrollOffset, 116.5),
   run({ scrollMode: 'scroll', text: 'A' }, 24)._scrollOffset);
ok('rainbow 1 秒 = 295 px',
   near(run({ scrollMode: 'rainbow' }, 24)._scrollOffset, 295),
   run({ scrollMode: 'rainbow' }, 24)._scrollOffset);
ok('multiline 1 秒 = 215 px',
   near(run({ scrollMode: 'multiline' }, 24)._scrollOffset, 215),
   run({ scrollMode: 'multiline' }, 24)._scrollOffset);
ok('static 不推进 scrollOffset', run({ scrollMode: 'static' }, 24)._scrollOffset === 0,
   run({ scrollMode: 'static' }, 24)._scrollOffset);
ok('blink 不推进 scrollOffset', run({ scrollMode: 'blink' }, 24)._scrollOffset === 0,
   run({ scrollMode: 'blink' }, 24)._scrollOffset);

console.log('\n— 背景相位 —');
ok('每帧 +1/36', near(run({ bgLightEffect: 'breathe' }, 1)._lightPhase, 1 / 36, 1e-12),
   run({ bgLightEffect: 'breathe' }, 1)._lightPhase);
ok('1 秒 phase = 2/3 → effectSeconds = 1 秒',
   near(CP.effectSeconds(run({ bgLightEffect: 'breathe' }, 24)._lightPhase, 1), 1),
   CP.effectSeconds(run({ bgLightEffect: 'breathe' }, 24)._lightPhase, 1));
ok('bgFx=none 时 phase 不动', run({ bgLightEffect: 'none' }, 24)._lightPhase === 0,
   run({ bgLightEffect: 'none' }, 24)._lightPhase);

console.log('\n— 彩虹色相(每秒 +36°,10 秒一圈) —');
{
  const e = engine(466); e.set({ scrollMode: 'rainbow' });
  ok('0 s = 0° 红 #ff0000', e._inkColor() === '#ff0000', e._inkColor());
  for (let i = 0; i < 24 * 2.5; i++) e.step();
  ok('2.5 s = 90° 黄绿 #80ff00', e._inkColor() === '#80ff00', e._inkColor());
  for (let i = 0; i < 24 * 2.5; i++) e.step();
  ok('5 s = 180° 青 #00ffff', e._inkColor() === '#00ffff', e._inkColor());
  for (let i = 0; i < 24 * 5; i++) e.step();
  ok('10 s 转回红', e._inkColor() === '#ff0000', e._inkColor());
}
{
  const e = run({ scrollMode: 'static', fontColor: '#abcdef' }, 10);
  ok('非彩虹模式 ink = fontColor', e._inkColor() === '#abcdef', e._inkColor());
  ok('非彩虹绘制时用 fontColor', texts(e).every((s) => s.indexOf('c=#abcdef') >= 0), texts(e)[0]);
}
{
  // 彩虹忽略 textColor
  const e = run({ scrollMode: 'rainbow', fontColor: '#abcdef', text: 'A' }, 0);
  ok('彩虹不使用 textColor', texts(e)[0].indexOf('c=#ff0000') >= 0, texts(e)[0]);
}

console.log('\n— blink(1 秒周期,余弦) —');
{
  const alphaAt = (n) => aOf(texts(run({ scrollMode: 'blink', bgLightEffect: 'none', text: 'A' }, n))[0]);
  ok('0 帧(0.00s)alpha = 1',    near(alphaAt(0), 1),   alphaAt(0));
  ok('6 帧(0.25s)alpha = 0.5',  near(alphaAt(6), 0.5), alphaAt(6));
  ok('12 帧(0.50s)alpha = 0',   near(alphaAt(12), 0),  alphaAt(12));
  ok('18 帧(0.75s)alpha = 0.5', near(alphaAt(18), 0.5),alphaAt(18));
  ok('24 帧(1.00s)alpha = 1',   near(alphaAt(24), 1),  alphaAt(24));
}

console.log('\n— 版式 —');
{
  const e = run({ scrollMode: 'static', text: 'A\nB', fontSize: 100, bgLightEffect: 'none' }, 0);
  const ys = texts(e).map(yOf);
  ok('行距 = 1.35 × 字号 = 135', near(ys[1] - ys[0], 135), ys[1] - ys[0]);
  ok('两行整块垂直居中于 233', near((ys[0] + ys[1]) / 2, 233), (ys[0] + ys[1]) / 2);
}
{
  // 默认字号 96 → stub 下单字宽 96
  const e = run({ scrollMode: 'static', text: 'A', bgLightEffect: 'none' }, 0);
  ok('单行在画布垂直中心 233', yOf(texts(e)[0]) === 233, yOf(texts(e)[0]));
  ok('单行水平居中 (466-96)/2 = 185', near(xOf(texts(e)[0]), 185), xOf(texts(e)[0]));
}
{
  // 从绘制日志里读,而不是绘制后读 ctx.font —— restore() 已把它复位
  const e = run({ scrollMode: 'static', text: 'A', fontSize: 96, bgLightEffect: 'none' }, 0);
  ok('font = bold + sans-serif',
     texts(e)[0].indexOf('font=bold 96px sans-serif') >= 0, texts(e)[0]);
  ok('textBaseline = middle 在绘制时已设', e.ctx._baselineAtDraw === 'middle', e.ctx._baselineAtDraw);
}
{
  const e = run({ scrollMode: 'static', text: 'a\nb\nc\nd\ne\nf\ng\nh', bgLightEffect: 'none' }, 0);
  ok('最多画 6 行', texts(e).length === 6, texts(e).length);
}

console.log('\n— scroll 多行倍率 1 + i×0.4 —');
{
  const e = run({ scrollMode: 'scroll', text: 'AA\nBB\nCC', fontSize: 50, bgLightEffect: 'none' }, 24);
  const got = mainPerLine(e).map(xOf);
  const span = 100 + 466;                       // 文字宽(2 字 ×50) + 画布宽
  const exp = [0, 1, 2].map((i) => 466 - ((116.5 * (1 + 0.4 * i)) % span));
  ok('三行 x 对应倍率 1 / 1.4 / 1.8',
     exp.every((v, i) => near(v, got[i], 1e-9)), JSON.stringify({ exp, got }));
  ok('靠后的行跑得更快(x 更小)', got[0] > got[1] && got[1] > got[2], JSON.stringify(got));
}
{
  // 循环间距 = 文字宽 + 画布宽
  const e = engine(466);
  e.set({ scrollMode: 'scroll', text: 'A', fontSize: 50, bgLightEffect: 'none' });
  const x0 = xOf(texts(frame(e))[0]);
  e._scrollOffset = 50 + 466;                   // 直接推一整圈
  ok('scroll 走满「文字宽+画布宽」回到原位', near(xOf(texts(frame(e))[0]), x0),
     xOf(texts(frame(e))[0]));
}
{
  // 单行 scroll 走在画布垂直中心(不用 stackStart)
  const e = run({ scrollMode: 'scroll', text: 'A', bgLightEffect: 'none' }, 5);
  ok('单行 scroll y = size/2 = 233', yOf(texts(e)[0]) === 233, yOf(texts(e)[0]));
}

console.log('\n— multiline 整块自下而上 —');
{
  const e = engine(466);
  e.set({ scrollMode: 'multiline', text: 'A\nB\nC', fontSize: 100, bgLightEffect: 'none' });
  const y0 = texts(frame(e)).map(yOf);
  ok('offset=0 时首行在画布下沿外 466 + 135/2', near(y0[0], 466 + 67.5), y0[0]);
  ok('三行水平居中 (466-100)/2 = 183',
     texts(frame(e)).every((s) => near(xOf(s), 183)), texts(frame(e))[0]);
  e._scrollOffset = 3 * 135 + 466;              // 整块高 + 画布高
  ok('走满「整块高+画布高」回到原位', near(texts(frame(e)).map(yOf)[0], y0[0]),
     texts(frame(e)).map(yOf)[0]);
}
{
  // 自下而上:帧数越大 y 越小
  const yAt = (n) => yOf(texts(run({ scrollMode: 'multiline', text: 'A\nB', bgLightEffect: 'none' }, n))[0]);
  ok('multiline 向上走(y 递减)', yAt(0) > yAt(6) && yAt(6) > yAt(12), [yAt(0), yAt(6), yAt(12)].join(','));
}

console.log('\n— bgFx 周期(sec = phase × 1.5,每帧 1/24 秒) —');
{
  const bgN = (fx, n) => rects(run({ scrollMode: 'static', bgLightEffect: fx,
                                     bgColor: '#ff2d55', text: '' }, n))
                           .filter((s) => s.indexOf('c=#ff2d55') >= 0).length;
  ok('pulse 第 1 帧(0.042s < 0.2)画底色', bgN('pulse', 1) === 1, bgN('pulse', 1));
  ok('pulse 第 6 帧(0.25s > 0.2)只剩黑底', bgN('pulse', 6) === 0, bgN('pulse', 6));
  ok('pulse 第 11 帧(0.458s → wrap 0.058)又亮', bgN('pulse', 11) === 1, bgN('pulse', 11));

  const bgA = (fx, n) => {
    const r = rects(run({ scrollMode: 'static', bgLightEffect: fx, bgColor: '#ff2d55', text: '' }, n))
                .filter((s) => s.indexOf('c=#ff2d55') >= 0);
    return r.length ? aOf(r[0]) : 0;
  };
  ok('breathe 0.0s alpha = 1',   near(bgA('breathe', 0), 1),    bgA('breathe', 0));
  ok('breathe 0.5s alpha = 0.5', near(bgA('breathe', 12), 0.5), bgA('breathe', 12));
  ok('breathe 1.0s alpha = 0',   near(bgA('breathe', 24), 0),   bgA('breathe', 24));
  ok('breathe 1.5s alpha = 0.5', near(bgA('breathe', 36), 0.5), bgA('breathe', 36));
  ok('breathe 2.0s wrap 回 1',   near(bgA('breathe', 48), 1),   bgA('breathe', 48));
}
{
  const blackN = (n) => rects(run({ scrollMode: 'static', bgLightEffect: 'open',
                                    bgColor: '#ff2d55', text: '' }, n))
                          .filter((s) => s.indexOf('c=#000000') >= 0).length;
  ok('open 首帧 = 黑底 + 左右两片幕布(3 次黑 fillRect)', blackN(1) === 3, blackN(1));
  ok('open 2s 后 shift=0.5 幕布全开(只剩黑底)', blackN(48) === 1, blackN(48));
}
{
  const e = run({ scrollMode: 'static', bgLightEffect: 'rotate', bgColor: '#ff2d55', text: '' }, 1);
  ok('rotate 画 4 个同心环',
     rects(e).filter((s) => s.indexOf('c=#ff2d55') >= 0).length === 4,
     rects(e).filter((s) => s.indexOf('c=#ff2d55') >= 0).length);
}
{
  // blur:0–0.5s 模糊 10→0(466 画布像素,再乘 size/466)
  const blurOf = (n, size) => {
    const r = rects(run({ scrollMode: 'static', bgLightEffect: 'blur', bgColor: '#ff2d55', text: '' },
                        n, size)).filter((s) => s.indexOf('c=#ff2d55') >= 0);
    return r.length ? fOf(r[0]) : '(none)';
  };
  ok('blur 0.0s 在 466 画布 = blur(10px)', blurOf(0, 466) === 'blur(10px)', blurOf(0, 466));
  ok('blur 0.0s 在 233 画布 = blur(5px)(按 size/466 换算)',
     blurOf(0, 233) === 'blur(5px)', blurOf(0, 233));
  ok('blur 0.25s = blur(5px)(10→0 线性)', blurOf(6, 466) === 'blur(5px)', blurOf(6, 466));
  ok('blur 0.5s 后清晰(filter 复位 none)', blurOf(12, 466) === 'none', blurOf(12, 466));
}

console.log('\n— 文字不参与背景变换 —');
{
  // 背景 alpha / filter 都不该漏到文字上
  const e = run({ scrollMode: 'static', text: 'A', bgLightEffect: 'breathe' }, 12);
  ok('breathe 半亮时文字仍 alpha=1', near(aOf(texts(e)[0]), 1), aOf(texts(e)[0]));
  const e2 = run({ scrollMode: 'static', text: 'A', bgLightEffect: 'blur' }, 0);
  ok('blur 期间 ctx.filter 已复位,不糊文字', e2.ctx.filter === 'none', e2.ctx.filter);
  const e3 = run({ scrollMode: 'static', text: 'A', bgLightEffect: 'pulse' }, 6);
  ok('pulse 灭灯帧文字照画', texts(e3).length === 1, texts(e3).length);
}

console.log('\n— 枚举回退与别名 —');
{
  const e = run({ scrollMode: 'nope', bgLightEffect: 'wat', text: 'A\nB', bgColor: '#ff2d55' }, 0);
  ok('未知 textFx 走 static(画 2 行)', texts(e).length === 2, texts(e).length);
  ok('未知 bgFx 按静止全亮',
     rects(e).some((s) => s.indexOf('c=#ff2d55') >= 0 && s.indexOf('a=1.000') >= 0),
     rects(e).join(' | '));
}
{
  const trace = (fx) => {
    const e = engine(466);
    e.set({ scrollMode: 'static', bgLightEffect: fx, bgColor: '#ff2d55', text: 'A' });
    for (let i = 0; i < 7; i++) e.step();
    return frame(e).ctx._log.join('|');
  };
  ok('别名 step → open',   trace('step')   === trace('open'),   '');
  ok('别名 shrink → blur', trace('shrink') === trace('blur'),   '');
  ok('别名 zoom → rotate', trace('zoom')   === trace('rotate'), '');
  ok('别名与原值不同效果', trace('open') !== trace('blur'), '');
}

console.log('\n— 缩放不变性(466 基准 × size/466) —');
{
  const e = run({ scrollMode: 'static', text: 'A', fontSize: 100, bgLightEffect: 'none' }, 0, 932, 2);
  ok('dpr=2 → 字号 100 放大到 200px',
     texts(e)[0].indexOf('font=bold 200px sans-serif') >= 0, texts(e)[0]);
}
{
  // scrollOffset 以 CSS px 累加、绘制时乘 dpr → 位移占画布比例与 dpr / 尺寸无关
  const rel = (size, dpr) => {
    const en = run({ scrollMode: 'rainbow', text: 'A', bgLightEffect: 'none' }, 24, size, dpr);
    return (size - xOf(mainPerLine(en)[0])) / size;
  };
  ok('rainbow 1 秒滚过 295/466 = 63.3%', near(rel(466, 1), 295 / 466, 1e-9), rel(466, 1));
  ok('与 dpr 无关(466@1 = 932@2)', near(rel(466, 1), rel(932, 2), 1e-9),
     rel(466, 1) + ' vs ' + rel(932, 2));
  ok('与画布尺寸无关(466 = 700)', near(rel(466, 1), rel(700, 1), 1e-9),
     rel(466, 1) + ' vs ' + rel(700, 1));
}
{
  const ph = (size) => run({ bgLightEffect: 'breathe' }, 24, size)._lightPhase;
  ok('背景 phase 与画布尺寸无关', near(ph(466), ph(233), 1e-12), ph(466) + ' vs ' + ph(233));
}

console.log('\n— speed 倍率 —');
{
  const bgA = (speed, n) => {
    const r = rects(run({ scrollMode: 'static', bgLightEffect: 'breathe',
                          bgColor: '#ff2d55', text: '', speed }, n))
                .filter((s) => s.indexOf('c=#ff2d55') >= 0);
    return r.length ? aOf(r[0]) : 0;
  };
  ok('speed=2 时 0.5s 就走到 1.0s 的相位(alpha=0)', near(bgA(2, 12), 0), bgA(2, 12));
  ok('speed=0.5 时 1.0s 只走到 0.5s 的相位(alpha=0.5)', near(bgA(0.5, 24), 0.5), bgA(0.5, 24));
  ok('speed 不影响文字速度', run({ scrollMode: 'rainbow', speed: 3 }, 24)._scrollOffset === 295,
     run({ scrollMode: 'rainbow', speed: 3 }, 24)._scrollOffset);
}

console.log('\n— 圆屏裁切 —');
{
  // 裁切应该在最外层加一次:clearRect → arc(内切圆) → clip → 之后才是背景
  const e = run({ scrollMode: 'static', bgLightEffect: 'none', text: 'A', round: true }, 0);
  const L = e.ctx._log;
  // save 之后立刻 clearRect:整帧从透明开始,圆外露出页面的「机身」底色
  ok('开头 save + clearRect(圆外留透明)',
     L[0] === 'save' && L[1] === 'clearRect 0,0,466,466', L.slice(0, 2).join(' | '));
  ok('裁切半径 = 内切圆 size/2', L.indexOf('arc 233,233,233') >= 0, L.slice(0, 5).join(' | '));
  ok('arc 在 clip 之前', L.indexOf('arc 233,233,233') < L.indexOf('clip'), L.slice(0, 6).join(' | '));
  ok('裁切早于背景绘制',
     L.indexOf('clip') < L.findIndex((s) => s.indexOf('fillRect') === 0),
     L.slice(0, 6).join(' | '));
  ok('裁切早于文字绘制',
     L.indexOf('clip') < L.findIndex((s) => s.indexOf('fillText') === 0),
     L.slice(0, 8).join(' | '));
}
{
  const e = run({ scrollMode: 'static', bgLightEffect: 'none', text: 'A', round: false }, 0);
  ok('方屏模式不加 arc/clip', e.ctx._log.indexOf('clip') < 0, e.ctx._log.slice(0, 5).join(' | '));
  ok('方屏模式仍 clearRect', e.ctx._log[1] === 'clearRect 0,0,466,466', e.ctx._log[1]);
}
{
  // 圆屏是纯遮罩:不能影响任何运动量
  const mk = (round) => {
    const en = engine(466);
    en.set({ scrollMode: 'rainbow', bgLightEffect: 'breathe', text: 'A\nB', round });
    for (let i = 0; i < 30; i++) en.step();
    return en;
  };
  const a = mk(true), b = mk(false);
  ok('圆屏不影响 scrollOffset', a._scrollOffset === b._scrollOffset,
     a._scrollOffset + ' vs ' + b._scrollOffset);
  ok('圆屏不影响 phase', a._lightPhase === b._lightPhase, a._lightPhase + ' vs ' + b._lightPhase);
  // 文字坐标也必须逐位相同(裁切不改变换矩阵)
  ok('圆屏不影响文字坐标',
     texts(frame(a)).map(xOf).join(',') === texts(frame(b)).map(xOf).join(','),
     texts(frame(a)).map(xOf).join(',') + ' vs ' + texts(frame(b)).map(xOf).join(','));
}
{
  // rotate 效果自己也用 arc+clip,圆屏叠在它外面 → 共 1+4 次
  const e = run({ scrollMode: 'static', bgLightEffect: 'rotate', text: '', round: true }, 1);
  const arcs = e.ctx._log.filter((s) => s.indexOf('arc ') === 0);
  ok('圆屏 + rotate:1 次圆屏裁切 + 4 个环 = 5 次 arc', arcs.length === 5, arcs.length);
  ok('第 1 次 arc 是圆屏(半径 233),随后是四环',
     arcs[0] === 'arc 233,233,233' && arcs[1] === 'arc 233,233,233' &&
     arcs[2] === 'arc 233,233,174.75',
     arcs.join(' | '));
}

console.log('\n— 排版 单行 / 多行 —');
{
  ok('layoutLines 多行 = cheerLines',
     JSON.stringify(CP.layoutLines('一起\n为你\n发光', 'multi')) === '["一起","为你","发光"]',
     JSON.stringify(CP.layoutLines('一起\n为你\n发光', 'multi')));
  ok('layoutLines 单行并成一行(空格分隔)',
     JSON.stringify(CP.layoutLines('一起\n为你\n发光', 'single')) === '["一起 为你 发光"]',
     JSON.stringify(CP.layoutLines('一起\n为你\n发光', 'single')));
  ok('单行:空文本仍是空数组(不产出空串行)',
     JSON.stringify(CP.layoutLines('  \n \n', 'single')) === '[]',
     JSON.stringify(CP.layoutLines('  \n \n', 'single')));
  ok('单行:超 6 行先截断再并(与多行同源)',
     CP.layoutLines('a\nb\nc\nd\ne\nf\ng', 'single')[0] === 'a b c d e f',
     CP.layoutLines('a\nb\nc\nd\ne\nf\ng', 'single')[0]);
  ok('未传 layout 默认按多行',
     CP.layoutLines('a\nb').length === 2, CP.layoutLines('a\nb').length);
}
{
  // 单行只画一行,且落在画布垂直中心(走 lines.length <= 1 那条路径)
  const e = run({ scrollMode: 'static', text: '一起\n为你\n发光',
                  textLayout: 'single', bgLightEffect: 'none' }, 0);
  ok('单行只画 1 行', texts(e).length === 1, texts(e).length);
  ok('单行在画布垂直中心 233', yOf(texts(e)[0]) === 233, yOf(texts(e)[0]));
  const m = run({ scrollMode: 'static', text: '一起\n为你\n发光',
                  textLayout: 'multi', bgLightEffect: 'none' }, 0);
  ok('多行画 3 行', texts(m).length === 3, texts(m).length);
}
{
  // 单行走马灯:应落到「单行」分支(倍率 1、y = size/2),而不是多行倍率
  const e = run({ scrollMode: 'scroll', text: 'AA\nBB\nCC', fontSize: 50,
                  textLayout: 'single', bgLightEffect: 'none' }, 24);
  const main = mainPerLine(e);
  ok('单行走马灯只有一条基线', main.length === 1, main.length);
  ok('单行走马灯 y = size/2 = 233', yOf(main[0]) === 233, yOf(main[0]));
  // 文字 'AA BB CC' = 8 字 ×50 = 400;span = 400 + 466
  ok('单行走马灯倍率 = 1',
     near(xOf(main[0]), 466 - (116.5 % (400 + 466))), xOf(main[0]));
}
{
  // 单行滚动:整块高度退化为 1 行
  const e = run({ scrollMode: 'multiline', text: 'A\nB\nC', fontSize: 100,
                  textLayout: 'single', bgLightEffect: 'none' }, 0);
  ok('单行滚动首行同样起于画布下沿外 466 + 67.5',
     near(yOf(texts(e)[0]), 466 + 67.5), yOf(texts(e)[0]));
  ok('单行滚动只画 1 行', texts(e).length === 1, texts(e).length);
}
{
  // 排版不影响时钟
  const mk = (layout) => {
    const en = engine(466);
    en.set({ scrollMode: 'rainbow', bgLightEffect: 'breathe', text: 'A\nB', textLayout: layout });
    for (let i = 0; i < 24; i++) en.step();
    return en;
  };
  ok('排版不影响 scrollOffset / phase',
     mk('single')._scrollOffset === mk('multi')._scrollOffset &&
     mk('single')._lightPhase === mk('multi')._lightPhase, '');
}

console.log('\n— 溢出诊断(_clip) —');
{
  // stub 下单字宽 = 字号。466 画布、字号 50、文字 'AAAA' → 200px,放得下
  const fit = run({ scrollMode: 'static', text: 'AAAA', fontSize: 50,
                    bgLightEffect: 'none', round: true }, 0);
  ok('放得下时 _clip = null', fit._clip === null, JSON.stringify(fit._clip));
  // 12 字 ×50 = 600 > 466 → 溢出 134(单行在中心,弦长 = 直径 = 466)
  const over = run({ scrollMode: 'static', text: 'AAAAAAAAAAAA', fontSize: 50,
                     bgLightEffect: 'none', round: true }, 0);
  ok('溢出时报出超出量 600-466 = 134', over._clip && near(over._clip.over, 134),
     JSON.stringify(over._clip));
  ok('溢出时带上是哪一行', over._clip && over._clip.line === 'AAAAAAAAAAAA',
     over._clip && over._clip.line);
}
{
  // 圆屏的可用宽度是弦长:离中心越远越窄。
  // 字号 100 → rowH 135;3 行时首行 y = 233-135 = 98,
  // 弦长 = 2√(233² - 135²) = 2√(54289-18225) = 2√36064 ≈ 379.8 < 466
  const e = run({ scrollMode: 'static', text: 'AAAA\nA\nAAAA', fontSize: 100,
                  bgLightEffect: 'none', round: true }, 0);
  const chord = 2 * Math.sqrt(233 * 233 - 135 * 135);
  ok('圆屏按弦长判定:首行 400px vs 弦长 ' + chord.toFixed(1),
     e._clip && near(e._clip.over, 400 - chord, 1e-6), JSON.stringify(e._clip));
  // 同样内容在方屏下按直径 466 判 → 放得下
  const sq = run({ scrollMode: 'static', text: 'AAAA\nA\nAAAA', fontSize: 100,
                   bgLightEffect: 'none', round: false }, 0);
  ok('方屏按画布宽判定:400 < 466 → 不报溢出', sq._clip === null, JSON.stringify(sq._clip));
  ok('同一内容圆屏报溢出、方屏不报(弦长 < 直径)',
     e._clip !== null && sq._clip === null, '');
}
{
  // 取最严重的那一行:中间行放得下、首尾行被切,应报首尾行
  const e = run({ scrollMode: 'static', text: 'AAAAAAA\nA\nAAAAAAA', fontSize: 100,
                  bgLightEffect: 'none', round: true }, 0);
  ok('多行取超出最多的那一行', e._clip && e._clip.line === 'AAAAAAA',
     e._clip && e._clip.line);
}
{
  // 走马灯 / 滚动 / 彩虹本来就跑出画布,不该报溢出
  ['scroll', 'multiline', 'rainbow'].forEach((m) => {
    const e = run({ scrollMode: m, text: 'AAAAAAAAAAAA', fontSize: 50,
                    bgLightEffect: 'none', round: true }, 12);
    ok(m + ' 不报溢出(本来就跑出画布)', e._clip === null, JSON.stringify(e._clip));
  });
  // blink 位置与 static 相同,应照常报
  const b = run({ scrollMode: 'blink', text: 'AAAAAAAAAAAA', fontSize: 50,
                  bgLightEffect: 'none', round: true }, 0);
  ok('blink 照常报溢出(位置与 static 相同)', b._clip !== null, JSON.stringify(b._clip));
}
{
  // 溢出量与画布尺寸等比 —— 页面按 466 基准折算回去报数,这条保证折算有意义
  const o = (size) => {
    const e = run({ scrollMode: 'static', text: 'AAAAAAAAAAAA', fontSize: 50,
                    bgLightEffect: 'none', round: true }, 0, size);
    return e._clip.over * CP.REF / size;
  };
  ok('溢出量折算回 466 基准后与尺寸无关', near(o(466), o(360), 1e-9), o(466) + ' vs ' + o(360));
}

console.log('\n— 圆屏尺寸枚举 —');
{
  ok('SCREENS = 466 / 360 两档',
     CP.SCREENS.map((s) => s.value).join(',') === '466,360',
     CP.SCREENS.map((s) => s.value).join(','));
  ok('466 标注为基准', CP.SCREENS[0].note === '基准', CP.SCREENS[0].note);
  ok('TEXT_LAYOUT = multi / single',
     CP.TEXT_LAYOUT.map((s) => s.value).join(',') === 'multi,single',
     CP.TEXT_LAYOUT.map((s) => s.value).join(','));
}
{
  // 360 上是同一套动画按 size/466 等比缩小 —— 用「占画布比例」判定
  const rel = (size) => {
    const en = run({ scrollMode: 'rainbow', text: 'A', fontSize: 96, bgLightEffect: 'none' }, 24, size);
    return (size - xOf(mainPerLine(en)[0])) / size;
  };
  ok('360 与 466 的滚动占比逐位相同', near(rel(360), rel(466), 1e-9),
     rel(360) + ' vs ' + rel(466));
  const fontOf = (size) => {
    const en = run({ scrollMode: 'static', text: 'A', fontSize: 96, bgLightEffect: 'none' }, 0, size);
    return parseFloat(/font=bold (\d+(?:\.\d+)?)px/.exec(texts(en)[0])[1]);
  };
  ok('360 上字号 = 96 × 360/466', near(fontOf(360), 96 * 360 / 466), fontOf(360));
  ok('466 上字号 = 96(基准)', fontOf(466) === 96, fontOf(466));
  const arcOf = (size) => {
    const en = run({ scrollMode: 'static', text: '', bgLightEffect: 'none', round: true }, 0, size);
    return en.ctx._log.find((s) => s.indexOf('arc ') === 0);
  };
  ok('360 圆屏裁切半径 = 180', arcOf(360) === 'arc 180,180,180', arcOf(360));
  ok('466 圆屏裁切半径 = 233', arcOf(466) === 'arc 233,233,233', arcOf(466));
}

console.log('\n— reset —');
{
  const e = engine(466);
  e.set({ scrollMode: 'rainbow', bgLightEffect: 'breathe' });
  for (let i = 0; i < 30; i++) e.step();
  e.reset();
  ok('reset 清零三个计数器',
     e._textPhase === 0 && e._scrollOffset === 0 && e._lightPhase === 0,
     [e._textPhase, e._scrollOffset, e._lightPhase].join(','));
}

console.log('\n' + (fail ? fail + ' FAILED / ' + pass + ' passed' : pass + '/' + pass + ' 全部通过'));
process.exit(fail ? 1 : 0);
