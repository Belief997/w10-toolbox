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
// 会真的清像素 / 真的填像素的假 canvas —— 只有 clearRect 是空实现的话,
// 「画布留边透明」这条根本测不出来(缓冲区一开始就是不透明的底色)。
function fakeCanvas(w, h) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = 200; buf[i * 4 + 1] = 100; buf[i * 4 + 2] = 50; buf[i * 4 + 3] = 255; }
  const px = (x, y, i, r, g, b, a) => {
    const o = (y * w + x) * 4;
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
  };
  const ctx = {
    _drawn: null, _fill: null, _smoothing: '', _put: null,
    clearRect(x, y, cw, ch) {
      for (let yy = y; yy < y + ch; yy++) for (let xx = x; xx < x + cw; xx++) {
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) px(xx, yy, 0, 0, 0, 0, 0);
      }
    },
    drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) {
      this._drawn = { sx, sy, sw, sh, dx, dy, dw, dh };
      // 源图是一张纯色占位图,画到哪儿就把哪儿填成不透明
      for (let yy = dy; yy < dy + dh; yy++) for (let xx = dx; xx < dx + dw; xx++) {
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) px(xx, yy, 0, 200, 100, 50, 255);
      }
    },
    createImageData(w2, h2) {
      return { data: new Uint8ClampedArray(w2 * h2 * 4), width: w2, height: h2 };
    },
    getImageData(x, y, w2, h2) {
      return { data: new Uint8ClampedArray(buf.subarray((y * w + x) * 4, (y * w + x) * 4 + w2 * h2 * 4)), width: w2, height: h2 };
    },
    putImageData(d, x, y) {
      this._put = { x: x || 0, y: y || 0 };
      for (let yy = 0; yy < d.height; yy++) {
        const dst = ((y || 0) + yy) * w + (x || 0);
        buf.set(d.data.subarray(yy * d.width * 4, (yy + 1) * d.width * 4), dst * 4);
      }
    },
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

// ---------- 6) 与源图同尺寸(画布 > 贴图,贴图居中留透明) ----------
console.log('\n[同尺寸] 画布 = 源图像素,贴图仍按 0.75 居中');
{
  // 360 方图:贴图 270,画布 360,四周各留 45
  const made = [];
  const out = RC.renderSprite((w, h) => { const c = fakeCanvas(w, h); made.push(c); return c; },
    { naturalWidth: 360, naturalHeight: 360 }, ODD, { canvas: { w: 360, h: 360 } });
  ok('画布 = 360×360', out.w === 360 && out.h === 360 && made[0].width === 360, out.w + '×' + out.h);
  ok('贴图边长仍是 0.75 × 短边 = 270', out.size === 270, out.size);
  ok('贴图居中偏移 45,45', out.ox === 45 && out.oy === 45, out.ox + ',' + out.oy);
  const d = made[0]._ctx._drawn;
  ok('drawImage 落到 45,45 且尺寸 270',
    d.dx === 45 && d.dy === 45 && d.dw === 270 && d.dh === 270, JSON.stringify(d));
  ok('取景矩形不变(仍是从源图切 270 方)',
    d.sx === 45 && d.sy === 45 && d.sw === 270, `${d.sx},${d.sy},${d.sw}`);
  ok('遮罩只写回贴图那一块', made[0]._ctx._put && made[0]._ctx._put.x === 45 && made[0]._ctx._put.y === 45,
    JSON.stringify(made[0]._ctx._put));
  ok('偏移读数是整数像素', Number.isInteger(out.ox) && Number.isInteger(out.oy));

  // 留边必须透明:画布(0,0)在贴图之外,alpha 得是 0
  const b = made[0]._buf;
  const at = (x, y) => Array.from(b.subarray((y * 360 + x) * 4, (y * 360 + x) * 4 + 4));
  ok('留边 (0,0) 与 (359,359) 全透明', at(0, 0)[3] === 0 && at(359, 359)[3] === 0, at(0, 0) + ' / ' + at(359, 359));
  ok('贴图内 (180,180) 是圆心,不透明', at(180, 180)[3] === 255, at(180, 180));
  // 贴图自身的角落(46,46)离圆心 189.5 > 135,应被清空
  ok('贴图角落被遮罩清空', at(46, 46).every((v) => v === 0), at(46, 46));

  // 非方源图:画布 iw×ih,贴图仍是 0.75×短边
  const o2 = RC.renderSprite((w, h) => fakeCanvas(w, h), { naturalWidth: 1080, naturalHeight: 720 }, ODD,
    { canvas: { w: 1080, h: 720 } });
  ok('非方图:画布 1080×720', o2.w === 1080 && o2.h === 720, o2.w + '×' + o2.h);
  ok('非方图:贴图 540(= 0.75 × 720)', o2.size === 540, o2.size);
  ok('非方图:左右留 270、上下留 90', o2.ox === 270 && o2.oy === 90, o2.ox + ',' + o2.oy);

  // 画布小于贴图时不许裁图
  const o3 = RC.renderSprite((w, h) => fakeCanvas(w, h), { naturalWidth: 400, naturalHeight: 400 }, ODD,
    { canvas: { w: 100, h: 100 } });
  ok('画布小于贴图时兜底成贴图尺寸', o3.w === 300 && o3.h === 300, o3.w + '×' + o3.h);
}

// ---------- 7) 留边比例 = 设备侧的比例 ----------
// 设备 paintCover 把整张图按短边居中裁方再拉伸填满 466。贴图占画布 0.75,
// 拉伸后 2 环外缘正好在 349.5 / 2 = 0.375 × 466 —— 这就是「留边是对的」的证明。
console.log('\n[同尺寸] 拉伸回 466 后 2 环仍落在 0.375');
{
  const canvasSide = 360, spriteSide = 270;
  const stretch = REF / canvasSide;                  // 设备把 360 拉到 466
  const ring2Radius = (spriteSide / 2) * stretch;    // 贴图半径 × 拉伸
  ok('2 环外缘 = 349.5 / 2 = 174.75', near(ring2Radius, REF * 0.375, 1e-9), ring2Radius);
  ok('2 环外缘 / 466 = 0.375 不变', near(ring2Radius / REF, 0.375, 1e-9), ring2Radius / REF);
  ok('贴图边长占画布 0.75', near(spriteSide / canvasSide, 0.75, 1e-9), spriteSide / canvasSide);
  // 反例:把贴图拉满画布,2 环会跑到 0.5
  ok('反例:贴图拉满 360 会让 2 环变成 0.5', near((canvasSide / 2) / canvasSide, 0.5, 1e-9));
}

// ---------- 8) Mask ----------
console.log('\n[Mask] 480² 白色 = 显示区,其余透明');
{
  ok('MASK_SIZE = 480', RC.MASK_SIZE === 480, RC.MASK_SIZE);

  const made = [];
  const m = RC.renderMask((w, h) => { const c = fakeCanvas(w, h); made.push(c); return c; }, ODD, {});
  ok('默认输出 480×480', m.size === 480 && made[0].width === 480 && made[0].height === 480, m.size);

  // mask 画布 = 整张外接正方形,而 bands 是相对「贴图边长」的,
  // 乘回 side 后必须落回 466 基准的比例 —— 这是最容易搞错的一步。
  const bands = RC.bandsOnCanvas(ODD);
  ok('内圆半径乘回 side 后 = 0.125', near(bands[0][1], 0.125, 1e-9), bands[0][1]);
  ok('2 环内外界 = 0.25…0.375', near(bands[1][0], 0.25, 1e-9) && near(bands[1][1], 0.375, 1e-9),
    bands[1][0] + '…' + bands[1][1]);
  ok('2 环外缘 = 画布内切圆 0.5', near(bands[1][1] / ODD.side, 0.5, 1e-9), bands[1][1] / ODD.side);

  const b = made[0]._buf;
  const at = (x, y) => Array.from(b.subarray((y * 480 + x) * 4, (y * 480 + x) * 4 + 4));
  const atR = (rNorm, deg) => {
    const r = rNorm * 480, a = deg * Math.PI / 180;
    return at(Math.floor(240 + r * Math.cos(a)), Math.floor(240 + r * Math.sin(a)));
  };

  const center = at(240, 240);
  ok('圆心:白色不透明', center[0] === 255 && center[1] === 255 && center[2] === 255 && center[3] === 255,
    JSON.stringify(center));
  ok('内圆中段 r=0.0625:白色', atR(0.0625, 0)[3] === 255, atR(0.0625, 0));
  ok('2 环中段 r=0.3125:白色', atR(0.3125, 0)[3] === 255, atR(0.3125, 0));
  ok('3 环中段 r=0.1875:透明', atR(0.1875, 0)[3] === 0, atR(0.1875, 0));
  ok('外环中段 r=0.4375:透明', atR(0.4375, 0)[3] === 0, atR(0.4375, 0));
  ok('画布角落:透明', at(1, 1)[3] === 0, at(1, 1));

  // 白色像素的 RGB 必须是 255,透明像素必须 RGB=0(不留脏色)
  let badWhite = 0, badClear = 0;
  for (let i = 0; i < 480 * 480; i++) {
    const o = i * 4, a = b[o + 3];
    if (a > 0 && !(b[o] === 255 && b[o + 1] === 255 && b[o + 2] === 255)) badWhite++;
    if (a === 0 && (b[o] || b[o + 1] || b[o + 2])) badClear++;
  }
  ok('所有可见像素都是纯白', badWhite === 0, badWhite);
  ok('所有透明像素 RGB 清零', badClear === 0, badClear);

  // 半透明像素只该出现在边界 1px 内
  let stray = 0, partial = 0;
  const radiiPx = bands.map(([x, y]) => [x * 480, y * 480]);
  for (let y = 0; y < 480; y++) {
    for (let x = 0; x < 480; x++) {
      const a = b[(y * 480 + x) * 4 + 3];
      if (a > 0 && a < 255) {
        partial++;
        const d = Math.hypot(x + 0.5 - 240, y + 0.5 - 240);
        if (!radiiPx.some(([r0, r1]) => (r0 > 0 && Math.abs(d - r0) < 1.5) || Math.abs(d - r1) < 1.5)) stray++;
      }
    }
  }
  ok('过渡像素只贴着边界', stray === 0, stray);
  ok('过渡像素只占周长量级 `' + partial + '/' + (480 * 480) + '`', partial / (480 * 480) < 0.03, partial);

  // mask 与贴图必须逐像素对齐:同一覆盖率算法,不同尺寸下按归一化半径比
  {
    let worst = 0;
    for (let deg = 0; deg < 360; deg += 30) {
      for (const rNorm of [0.0625, 0.1875, 0.3125, 0.4375]) {
        const a = deg * Math.PI / 180;
        const mx = Math.floor(240 + rNorm * 480 * Math.cos(a));
        const my = Math.floor(240 + rNorm * 480 * Math.sin(a));
        const maskA = b[(my * 480 + mx) * 4 + 3];
        // 同一半径换到贴图坐标系(贴图边长 0.75 → 归一化半径要除以 0.75)
        const spriteA = RC.coverage(Math.floor(240 + rNorm / ODD.side * 480 * Math.cos(a)),
                                     Math.floor(240 + rNorm / ODD.side * 480 * Math.sin(a)),
                                     480, ODD.bands) * 255;
        worst = Math.max(worst, Math.abs(maskA - spriteA));
      }
    }
    ok('mask 与贴图覆盖率一致(24 角度 × 4 半径)', worst < 1e-6, worst);
  }

  // 外环组的 mask 与 2 环组在半径轴上精确互补(0.125 / 0.25 / 0.375 是共享边界),
  // 所以正确的关系是「两者相加 = 255」,而不是「互不重叠」——
  // 共享边界上的像素在两张图各占一半 alpha,正说明切分严丝合缝。
  //
  // 但互补只成立于内切圆**严格以内**:r = 0.5 是外环自己的外缘,
  // 那一圈只有外环有边界、2 环组是 0,所以抗锯齿带里相加不足 255。
  // 这条 1px 过渡带必须排除,否则断言会误报。
  {
    const me = RC.renderMask((w, h) => fakeCanvas(w, h), RC.SPRITE.even, {});
    const bb = me.canvas._buf;
    const R = 240;                 // 内切圆半径 = 画布边长 / 2
    let badSum = 0, outside = 0, worstSum = 0;
    for (let y = 0; y < 480; y++) {
      for (let x = 0; x < 480; x++) {
        const a1 = b[(y * 480 + x) * 4 + 3], a2 = bb[(y * 480 + x) * 4 + 3];
        const d = Math.hypot(x + 0.5 - 240, y + 0.5 - 240);
        if (d <= R - 1) {                       // 严格以内(避开 r=0.5 的抗锯齿带)
          const err = Math.abs(a1 + a2 - 255);
          worstSum = Math.max(worstSum, err);
          if (err > 1) badSum++;                // 只允许四舍五入的 ±1
        } else if (d > R + 1 && (a1 !== 0 || a2 !== 0)) {
          outside++;                            // 圆外(同样避开过渡带)必须全空
        }
      }
    }
    ok('内切圆内(r < 0.5)两组 alpha 互补,相加 = 255 ± 1', badSum === 0, worstSum);
    ok('内切圆外(r > 0.5 + 1px)两组都全透明', outside === 0, outside);
    ok('外环组 mask 也是 480²', me.size === 480, me.size);
  }
}

// ---------- 9) 调试图案 ----------
// 这些图案是「在设备上量偏移 / 缩放」的标尺,所以边界必须落在**精确的像素行**上,
// 差 1px 就失去了标尺的意义 —— 这里逐个把边界位置断言出来。
console.log('\n[图案] 480² 规则几何,边界落在精确像素');
{
  const S = 480, C = 240;
  const mkPat = (k, o) => {
    const made = [];
    const r = RC.renderPattern((w, h) => { const c = fakeCanvas(w, h); made.push(c); return c; }, k, o || {});
    return { r: r, buf: made[0]._buf, size: r.size };
  };
  const A = (buf, x, y) => buf[(y * S + x) * 4 + 3];
  const isWhite = (buf, x, y) => {
    const i = (y * S + x) * 4;
    return buf[i] === 255 && buf[i + 1] === 255 && buf[i + 2] === 255 && buf[i + 3] === 255;
  };
  const isClear = (buf, x, y) => {
    const i = (y * S + x) * 4;
    return buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0;
  };

  ok('六种图案都已注册', RC.PATTERN_KEYS.length === 6 &&
    RC.PATTERN_KEYS.every((k) => typeof RC.PATTERN[k] === 'function'), RC.PATTERN_KEYS.join(','));
  ok('未知图案抛错而不是出空白图', (() => {
    try { RC.renderPattern((w, h) => fakeCanvas(w, h), 'nope', {}); return false; } catch (e) { return true; }
  })());

  // --- halves:上半白 / 下半透明,分界在第 240 行 ---
  {
    const t = mkPat('halves');
    ok('halves 尺寸 480²', t.size === 480);
    ok('halves 第 239 行全白', isWhite(t.buf, 240, 239), A(t.buf, 240, 239));
    ok('halves 第 240 行全透明', isClear(t.buf, 240, 240), A(t.buf, 240, 240));
    ok('halves 分界线上方整行一致', [0, 1, 239, 479].every((x) => isWhite(t.buf, x, 0)));
    ok('halves 分界线下方整行一致', [0, 1, 239, 479].every((x) => isClear(t.buf, x, 479)));
    // 全图只该有这两种像素,不许出现半透明(边界正好落在像素之间)
    let partial = 0;
    for (let i = 0; i < S * S; i++) { const a = t.buf[i * 4 + 3]; if (a !== 0 && a !== 255) partial++; }
    ok('halves 无半透明像素', partial === 0, partial);
  }

  // --- vhalves:左白 / 右透明,分界在第 240 列 ---
  {
    const t = mkPat('vhalves');
    ok('vhalves 第 239 列白、第 240 列透明',
      isWhite(t.buf, 239, 240) && isClear(t.buf, 240, 240),
      A(t.buf, 239, 240) + ' / ' + A(t.buf, 240, 240));
  }

  // --- quad:左上 + 右下的 2×2 棋盘 ---
  {
    const t = mkPat('quad');
    ok('quad 左上格白', isWhite(t.buf, 100, 100));
    ok('quad 右上格透明', isClear(t.buf, 380, 100));
    ok('quad 左下格透明', isClear(t.buf, 100, 380));
    ok('quad 右下格白', isWhite(t.buf, 380, 380));
    ok('quad 四格边界都精确',
      isWhite(t.buf, 239, 239) && isClear(t.buf, 240, 239) &&
      isClear(t.buf, 239, 240) && isWhite(t.buf, 240, 240));
  }

  // --- checker4:4×4 棋盘,每格 120 ---
  {
    const t = mkPat('checker4');
    let bad = 0;
    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 4; gx++) {
        const cx = gx * 120 + 60, cy = gy * 120 + 60;
        const want = (gx + gy) % 2 === 0;
        if (want !== isWhite(t.buf, cx, cy)) bad++;
      }
    }
    ok('checker4 16 格黑白交替全对', bad === 0, bad);
    ok('checker4 格宽正好 120(第 119 → 120 列换色)',
      isWhite(t.buf, 119, 60) && isClear(t.buf, 120, 60),
      A(t.buf, 119, 60) + ' / ' + A(t.buf, 120, 60));
  }

  // --- grid4:只有 1px 格线,其余透明 ---
  {
    const t = mkPat('grid4');
    ok('grid4 格线在 0/120/240/360 列', [0, 120, 240, 360].every((x) => isWhite(t.buf, x, 60)),
      [0, 120, 240, 360].map((x) => A(t.buf, x, 60)).join(','));
    ok('grid4 格线之间是透明', [60, 180, 300, 420].every((x) => isClear(t.buf, x, 60)));
    ok('grid4 行方向同样有格线', [0, 120, 240, 360].every((y) => isWhite(t.buf, 60, y)));
    // 可见像素只能占总数的 (2*4*480 - 16) 量级,绝不该铺满
    let white = 0;
    for (let i = 0; i < S * S; i++) if (t.buf[i * 4 + 3] === 255) white++;
    ok('grid4 可见像素只占少量 `' + white + '`', white < S * S * 0.02, white / (S * S));
  }

  // --- box:居中方块,边长 240,四边各留 120 ---
  {
    const t = mkPat('box');
    ok('box 中心白', isWhite(t.buf, 240, 240));
    ok('box 上边界 = 第 120 行', isClear(t.buf, 240, 119) && isWhite(t.buf, 240, 120),
      A(t.buf, 240, 119) + ' / ' + A(t.buf, 240, 120));
    ok('box 下边界 = 第 359 行', isWhite(t.buf, 240, 359) && isClear(t.buf, 240, 360),
      A(t.buf, 240, 359) + ' / ' + A(t.buf, 240, 360));
    ok('box 左边界 = 第 120 列', isClear(t.buf, 119, 240) && isWhite(t.buf, 120, 240));
    ok('box 右边界 = 第 359 列', isWhite(t.buf, 359, 240) && isClear(t.buf, 360, 240));
    // 四边留白必须相等 —— 这正是「用方块量圆心」的依据。
    // 直接把四条边的留白像素数出来,而不是拿常量自比。
    let top = 0, left = 0, bottom = 0, right = 0;
    while (top < S && isClear(t.buf, 240, top)) top++;
    while (bottom < S && isClear(t.buf, 240, S - 1 - bottom)) bottom++;
    while (left < S && isClear(t.buf, left, 240)) left++;
    while (right < S && isClear(t.buf, S - 1 - right, 240)) right++;
    ok('box 四边留白相等(各 120),即方块正好居中',
      top === 120 && bottom === 120 && left === 120 && right === 120,
      `上${top} 下${bottom} 左${left} 右${right}`);
    ok('box 边长 = 240', S - top - bottom === 240, S - top - bottom);
  }

  // 所有图案都遵守同一条画法:可见像素纯白、透明像素 RGB 归零
  {
    let dirty = 0;
    for (const k of RC.PATTERN_KEYS) {
      const t = mkPat(k);
      for (let i = 0; i < S * S; i++) {
        const o = i * 4, a = t.buf[o + 3];
        if (a > 0 && (t.buf[o] !== 255 || t.buf[o + 1] !== 255 || t.buf[o + 2] !== 255)) dirty++;
        if (a === 0 && (t.buf[o] || t.buf[o + 1] || t.buf[o + 2])) dirty++;
      }
    }
    ok('六种图案都是纯白 + 干净透明(无脏色)', dirty === 0, dirty);
  }

  // 图案尺寸可覆盖,但默认必须是 480 —— 和 mask 同一画布才能叠着用
  {
    const t = mkPat('halves', { size: 240 });
    ok('图案尺寸可覆盖', t.size === 240, t.size);
    ok('图案默认尺寸 = MASK_SIZE = 480', mkPat('halves').size === RC.MASK_SIZE, RC.MASK_SIZE);
  }
}

// ---------- 汇总 ----------
console.log('\n' + (fail ? `✗ ${fail} 项失败 / ${pass + fail} 项` : `✓ ${pass}/${pass} 全绿`));
process.exit(fail ? 1 : 0);
