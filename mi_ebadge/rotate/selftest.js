"use strict";
/*
 * rotate-crop.js 回归自测(Node,不碰 DOM)
 *
 *   node selftest.js
 *
 * 把文档里 rotate 那张表(半径 0.5 / 0.375 / 0.25 / 0.125)直接当 ground truth,
 * 核对三件容易写错的事:
 *   1) 贴图取景 —— 0.75 × 短边的正方形,居中
 *   2) 环带归属 —— 内圆、2 环留下,3 环与外圈必须干净
 *   3) 旋转不变 —— 圆怎么转都内切同一个正方形,所以遮罩不能依赖角度
 */
const RC = require('./rotate-crop.js');

let fail = 0, pass = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '   -> ' + got); }
};
const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps);

const REF = RC.REF;              // 466
const ODD  = RC.SPRITE.odd;      // 内圆 + 2 环,90°→0°
const EVEN = RC.SPRITE.even;     // 外环 + 3 环,-90°→0°

// 把「466 基准上的半径 + 角度」换算成输出图上的像素索引再采样,
// 这样验的是「转起来之后的样子」而不是静态正位。
function sampleAtRadius(spec, size, r466, deg) {
  const c = size / 2;
  const rPx = r466 / REF * size / spec.side;   // 贴图只覆盖 spec.side 那一块
  const a = deg * Math.PI / 180;
  const x = Math.floor(c + rPx * Math.cos(a));
  const y = Math.floor(c + rPx * Math.sin(a));
  return { x, y, cov: RC.coverage(x, y, size, spec.bands) };
}

// ---------- 1) 取景 ----------
console.log('\n[取景] 2 环的外接正方形 = 0.75 × 短边');
ok('360×360 → 270', RC.outputSide(360, 360, ODD.side) === 270, RC.outputSide(360, 360, ODD.side));
ok('466×466 → 350(349.5 四舍五入)', RC.outputSide(466, 466, ODD.side) === 350, RC.outputSide(466, 466, ODD.side));
ok('不对齐 1080×720 按短边 720 → 540', RC.outputSide(1080, 720, ODD.side) === 540, RC.outputSide(1080, 720, ODD.side));
ok('外环组边长 = 短边', RC.outputSide(500, 500, EVEN.side) === 500, RC.outputSide(500, 500, EVEN.side));
ok('边长恒为正方形', ODD.side === EVEN.side * 0.75, ODD.side + ' vs ' + EVEN.side);

{
  const r = RC.sourceRect(1080, 720, ODD.side);
  ok('短边居中:x 居中', near(r.x, (1080 - 540) / 2), r.x);
  ok('短边居中:y 居中', near(r.y, (720 - 540) / 2), r.y);
  ok('取景是正方形', near(r.w, r.h) && near(r.w, 540), r.w + '×' + r.h);
  const r1 = RC.sourceRect(720, 1080, ODD.side);
  ok('竖图同样居中', near(r1.x, 90) && near(r1.y, 270), r1.x + ',' + r1.y);
  const r2 = RC.sourceRect(720, 1080, EVEN.side);
  ok('外环组取满短边', near(r2.w, 720) && near(r2.y, 180), r2.w);
}

// ---------- 2) 环带归属(旋转下的采样) ----------
console.log('\n[环带] 内圆与 2 环留下,3 环与外圈干净');
const R_MID_INNER = (0 + 0.125) / 2 * REF;              //   29.1
const R_MID_RING2 = (0.25 + 0.375) / 2 * REF;           //  145.6
const R_MID_RING3 = (0.125 + 0.25) / 2 * REF;           //   87.4
const R_MID_OUTER = (0.375 + 0.5) / 2 * REF;            //  204.0

{
  let worstKeep = 1, worstDrop = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    for (let size of [150, 270, 350, 700]) {
      worstKeep = Math.min(worstKeep,
        sampleAtRadius(ODD, size, 0, deg).cov,
        sampleAtRadius(ODD, size, R_MID_INNER, deg).cov,
        sampleAtRadius(ODD, size, R_MID_RING2, deg).cov);
      worstDrop = Math.max(worstDrop,
        sampleAtRadius(ODD, size, R_MID_RING3, deg).cov,
        sampleAtRadius(ODD, size, R_MID_OUTER, deg).cov,
        sampleAtRadius(ODD, size, REF * 0.49, deg).cov);
    }
  }
  ok('内圆圆心始终不透明(24 角度 × 4 尺寸)', worstKeep === 1, worstKeep);
  ok('内圆中段始终不透明', sampleAtRadius(ODD, 270, R_MID_INNER, 0).cov === 1);
  ok('2 环中段始终不透明', sampleAtRadius(ODD, 270, R_MID_RING2, 0).cov === 1);
  ok('3 环中段始终全透明', worstDrop === 0, worstDrop);
  ok('外圈中段始终全透明', sampleAtRadius(ODD, 270, R_MID_OUTER, 0).cov === 0);
  // 2 环外缘就是输出图的内切圆:往内 1px 实心,往外 1px 已经出图
  ok('2 环外缘内 1px 仍实心', sampleAtRadius(ODD, 270, REF * 0.373, 0).cov === 1,
    sampleAtRadius(ODD, 270, REF * 0.373, 0));
  ok('2 环外缘外 1px 已出图', sampleAtRadius(ODD, 270, REF * 0.377, 0).cov === 0,
    sampleAtRadius(ODD, 270, REF * 0.377, 0));
}

// 外环组的切分:半径上界 0.5 落在输出图边上,下界 0.375 是 2 环外缘
console.log('\n[外环组] 同一张图切外环 + 3 环');
ok('外环边界 = 输出图内切圆', near(EVEN.bands[0][1] * RC.SPRITE.even.side * REF, REF / 2, 1e-9));
ok('外环内界 = 2 环外缘 0.375', near(EVEN.bands[0][0] * REF, REF * 0.375, 1e-9));
ok('3 环内外界 = 0.125…0.25', near(EVEN.bands[1][0] * REF, REF * 0.125) &&
                              near(EVEN.bands[1][1] * REF, REF * 0.25));
ok('外环中段不透明', sampleAtRadius(EVEN, 466, R_MID_OUTER, 0).cov === 1);
ok('3 环中段不透明', sampleAtRadius(EVEN, 466, R_MID_RING3, 0).cov === 1);
ok('2 环中段全透明', sampleAtRadius(EVEN, 466, R_MID_RING2, 0).cov === 0);
ok('内圆中段全透明', sampleAtRadius(EVEN, 466, R_MID_INNER, 0).cov === 0);

// ---------- 3) 抗锯齿 ----------
console.log('\n[抗锯齿] 只在边界 1px 内出现过渡');
{
  const size = 270, radii = ODD.bands.map((b) => [b[0] * size, b[1] * size]);
  let partial = 0, total = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      total++;
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const c = RC.coverage(x, y, size, ODD.bands);
      if (c > 0 && c < 1) {
        partial++;
        const atBoundary = radii.some(([a, b]) =>
          (a > 0 && Math.abs(d - a) < 1.5) || Math.abs(d - b) < 1.5);
        if (!atBoundary) { ok('过渡像素必须贴着边界 d=' + d.toFixed(2), false, x + ',' + y); }
      }
    }
  }
  ok('过渡像素只占周长量级 `' + partial + '/' + total + '`', partial / total < 0.03, partial / total);
}

// ---------- 4) 角度 ----------
console.log('\n[角度] 2 秒一轮,第 1 秒转到正位,第 2 秒保持');
const degAt = (spec, s) => Math.round(RC.angleAt(spec, s) * 180 / Math.PI);
ok('内圆+2环 0s = 90°',  degAt(ODD, 0) === 90,  degAt(ODD, 0));
ok('内圆+2环 0.5s = 45°', degAt(ODD, 0.5) === 45, degAt(ODD, 0.5));
ok('内圆+2环 1s = 0°',   degAt(ODD, 1) === 0,   degAt(ODD, 1));
ok('内圆+2环 1.5s 保持 0°', degAt(ODD, 1.5) === 0, degAt(ODD, 1.5));
ok('内圆+2环 2s 重回 90°', degAt(ODD, 2) === 90, degAt(ODD, 2));
ok('外环+3环 0s = -90°', degAt(EVEN, 0) === -90, degAt(EVEN, 0));
ok('外环+3环 0.5s = -45°', degAt(EVEN, 0.5) === -45, degAt(EVEN, 0.5));
ok('外环+3环 1s 起保持 0°', degAt(EVEN, 1) === 0 && degAt(EVEN, 1.8) === 0);
ok('两组反向', Math.sign(ODD.from - ODD.to) === -Math.sign(EVEN.from - EVEN.to));

// ---------- 5) 渲染管线(假 canvas,验 drawImage 取景与 alpha) ----------
console.log('\n[管线] 假 canvas 跑同一条路径');
function fakeCanvas(w, h) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = 200; buf[i * 4 + 1] = 100; buf[i * 4 + 2] = 50; buf[i * 4 + 3] = 255; }
  const ctx = {
    _drawn: null, _fill: null, _smoothing: '',
    clearRect() {},
    drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { this._drawn = { sx, sy, sw, sh, dx, dy, dw, dh }; },
    getImageData(x, y, w2, h2) {
      return { data: new Uint8ClampedArray(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + w2 * h2 * 4)), width: w2, height: h2 };
    },
    putImageData(d) { buf.set(d.data); },
    save() {}, restore() {}, fillRect() { this._fill = true; },
    set globalCompositeOperation(v) {}, get globalCompositeOperation() { return 'source-over'; },
    set imageSmoothingQuality(v) { this._smoothing = v; },
    get imageSmoothingQuality() { return this._smoothing; }
  };
  return { width: w, height: h, getContext: () => ctx, _ctx: ctx, _buf: buf };
}
{
  const img = { naturalWidth: 360, naturalHeight: 360 };
  const made = [];
  const out = RC.renderSprite((w, h) => { const c = fakeCanvas(w, h); made.push(c); return c; }, img, ODD, {});
  ok('输出边长 270', out.size === 270 && made[0].width === 270, out.size);
  const d = made[0]._ctx._drawn;
  ok('drawImage 取景 = 居中 270 方', d.sx === 45 && d.sy === 45 && d.sw === 270 && d.sh === 270, JSON.stringify(d));
  ok('drawImage 铺满输出', d.dx === 0 && d.dw === 270);
  ok('开了高质量重采样', made[0]._ctx._smoothing === 'high');

  // 中心像素(内圆)保留、角上(圆外)被清空,且 RGB 一并清零
  const b = made[0]._buf;
  const at = (x, y) => Array.from(b.subarray((y * 270 + x) * 4, (y * 270 + x) * 4 + 4));
  ok('圆心不透明', at(135, 135)[3] === 255, at(135, 135));
  ok('角落清空且 RGB 归零', at(2, 2).every((v) => v === 0), at(2, 2));

  const out2 = RC.renderSprite((w, h) => fakeCanvas(w, h), { width: 360, height: 360 }, ODD, { size: 540, background: '#000000' });
  ok('显式 size 生效', out2.size === 540);
  ok('给定底色时垫底', out2.canvas._ctx._fill === true);
}
{
  // 非正方形输入:取景必须跟着短边走
  const made = [];
  RC.renderSprite((w, h) => { const c = fakeCanvas(w, h); made.push(c); return c; },
    { naturalWidth: 1080, naturalHeight: 720 }, ODD, { size: 108 });
  const d = made[0]._ctx._drawn;
  ok('横图先按短边居中裁方', d.sx === 270 && d.sy === 90 && d.sw === 540, `${d.sx},${d.sy},${d.sw}`);
}
{
  let threw = false;
  try { RC.renderSprite((w, h) => fakeCanvas(w, h), { naturalWidth: 0, naturalHeight: 0 }, ODD, {}); }
  catch (e) { threw = true; }
  ok('空图报错而不是静默出全透明图', threw);
}

// ---------- 汇总 ----------
console.log('\n' + (fail ? `✗ ${fail} 项失败 / ${pass + fail} 项` : `✓ ${pass}/${pass} 全绿`));
process.exit(fail ? 1 : 0);
