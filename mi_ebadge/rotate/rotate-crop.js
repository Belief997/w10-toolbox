"use strict";
/*
 * 应援牌 bgFx `rotate` 的贴图裁切 —— 几何与像素的唯一真源(不碰 DOM)
 *
 * 依据 ../自制应援效果.md 的 rotate 一节:466 基准画布上四个同心圆从外到内
 * 各自旋转,半径 0.5 / 0.375 / 0.25 / 0.125,角度交替 -90°→0° 与 90°→0°。
 *
 *   外环 -90°→0°   2 环 90°→0°   3 环 -90°→0°   内圆 90°→0°
 *
 * 相邻两环转向相反,所以能并成一张贴图「一起转」的只有转向相同的那些:
 *
 *   外环 + 3 环(都是 -90°→0°)
 *   2 环 + 内圆(都是  90°→0°)   ← 本工具要的这张
 *
 * 贴图边长取该组最外环的外接正方形:2 环直径 0.75S,外环直径就是 S。
 * 圆心固定、圆旋转时始终内切这个正方形,所以任何角度都不会越界,
 * 也不需要留额外边距 —— 边距会让贴图和 466 基准的比例对不上。
 *
 * canvas 由调用方注入(见 renderSprite 的 makeCanvas),selftest 在 Node 里用
 * 假 canvas 跑同一条管线,所以 drawImage 的取景矩形不会「只在浏览器里对」。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotateCrop = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const REF = 466;   // 文档基准画布边长

  // 四个同心圆半径,占 466 基准画布边长 S 的比例(与文档的 rotate 表一一对应)
  const RING = { outer: 0.5, ring2: 0.375, ring3: 0.25, inner: 0.125 };

  // 同向的两组。
  //   side  : 贴图边长占 S 的比例,= 该组最外环的外接正方形
  //   bands : 保留的环带,半径归一化到「贴图自身边长」的 [内, 外]
  //   from/to: 起始角 → 正位角(度),两组反相,所以贴图不能混用
  //
  // 2 环这组的换算(贴图边长 0.75S):
  //   内圆    0.125S / 0.75S = 1/6
  //   2 环    0.25S…0.375S  / 0.75S = 1/3…1/2
  // 上界 1/2 就是「2 环外缘正好内切输出方图」—— 题目要的尺寸。
  // 外环那组边长是 S,归一化后就是 0.375…0.5 与 0.125…0.25。
  const SPRITE = {
    odd: {
      key: 'odd',
      label: '内圆 + 2 环',
      from: 90, to: 0,
      side: RING.ring2 * 2,
      bands: [[0, RING.inner / (RING.ring2 * 2)],
              [RING.ring3 / (RING.ring2 * 2), RING.ring2 / (RING.ring2 * 2)]]
    },
    even: {
      key: 'even',
      label: '外环 + 3 环',
      from: -90, to: 0,
      side: RING.outer * 2,
      bands: [[RING.ring2, RING.outer],
              [RING.inner, RING.ring3]]
    }
  };

  // ---------- 取景 ----------

  // 与 cheer-preview 的 drawImageCover 同一套:先按短边居中裁成正方形,
  // 再取其中以圆心为中心、边长 ratio 的那块。两边不一致的话,贴图就和设备
  // 实际显示的画面错位了。
  function sourceRect(iw, ih, ratio) {
    const s = Math.min(iw, ih);
    const w = s * (ratio == null ? 1 : ratio);
    return { x: (iw - w) / 2, y: (ih - w) / 2, w: w, h: w, square: s };
  }

  // 贴图边长(源像素)。0.75 × 短边 = 2 环外接正方形,不重采样就是最高保真。
  function outputSide(iw, ih, ratio) {
    return Math.max(1, Math.round(Math.min(iw, ih) * (ratio == null ? 1 : ratio)));
  }

  // ---------- 遮罩 ----------

  const SUB = 4;   // 边界像素子采样 4×4,够 16 级过渡,肉眼看不出锯齿

  function insideBands(d, radii) {
    for (let i = 0; i < radii.length; i++) {
      if (d >= radii[i][0] && d <= radii[i][1]) return true;
    }
    return false;
  }

  function radiiOf(bands, side) {
    return bands.map((b) => [b[0] * side, b[1] * side]);
  }

  // px/py 是像素索引(整数),像素中心在 +0.5 处。
  // 返回 0…1 的覆盖率;离任一边界都超过 1px 时整像素同号,不必逐子采样。
  function coverageAt(px, py, side, radii) {
    const c = side / 2;
    const dx = px + 0.5 - c;
    const dy = py + 0.5 - c;
    const d = Math.sqrt(dx * dx + dy * dy);

    let near = false;
    for (let i = 0; i < radii.length; i++) {
      const r0 = radii[i][0];
      const r1 = radii[i][1];
      if ((r0 > 0 && Math.abs(d - r0) < 1) || Math.abs(d - r1) < 1) { near = true; break; }
    }
    if (!near) return insideBands(d, radii) ? 1 : 0;

    const step = 1 / SUB;
    let hits = 0;
    for (let j = 0; j < SUB; j++) {
      const yy = py + (j + 0.5) * step - c;
      for (let i = 0; i < SUB; i++) {
        const xx = px + (i + 0.5) * step - c;
        if (insideBands(Math.sqrt(xx * xx + yy * yy), radii)) hits++;
      }
    }
    return hits / (SUB * SUB);
  }

  function coverage(px, py, side, bands) {
    return coverageAt(px, py, side, radiiOf(bands, side));
  }

  // 逐像素乘 alpha。全透明像素连 RGB 一起清零:看不见的像素不该把颜色写进
  // PNG,顺便让文件小一截(deflate 对整块 0 的效率极高)。
  function applyMask(data, w, h, bands) {
    const radii = radiiOf(bands, w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = coverageAt(x, y, w, radii);
        if (a >= 1) continue;
        const i = (y * w + x) * 4;
        if (a <= 0) {
          data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
        } else {
          data[i + 3] = Math.round(data[i + 3] * a);
        }
      }
    }
  }

  // ---------- 成图 ----------

  // makeCanvas(w, h) -> 带 getContext('2d') 的对象。浏览器里就是
  // document.createElement('canvas'),Node 里是 selftest 的假 canvas。
  //
  // opt.size        输出边长,0/省略 = 0.75 × 短边(源分辨率,不重采样)
  // opt.background  底色(null = 透明;给值则用 destination-over 垫在下面,
  //                 这样抗锯齿的半透明边缘压在底色上而不是半透明白边)
  function renderSprite(makeCanvas, img, spec, opt) {
    const o = opt || {};
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) throw new Error('图片没有尺寸');

    const size = Math.max(1, Math.round(+o.size || outputSide(iw, ih, spec.side)));
    const out = makeCanvas(size, size);
    const ctx = out.getContext('2d');
    const rect = sourceRect(iw, ih, spec.side);

    ctx.clearRect(0, 0, size, size);
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, size, size);

    const data = ctx.getImageData(0, 0, size, size);
    applyMask(data.data, size, size, spec.bands);
    ctx.putImageData(data, 0, 0);

    if (o.background) {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = o.background;
      ctx.fillRect(0, 0, size, size);
      ctx.restore();
    }

    return { canvas: out, size: size, rect: rect, spec: spec };
  }

  // ---------- 角度 ----------

  // 与文档一致:2 秒一轮,第 1 秒从起始角转到正位,第 2 秒保持。
  function angleAt(spec, sec) {
    const u = ((sec % 2) + 2) % 2;
    const t = u < 1 ? u : 1;
    return (spec.from + (spec.to - spec.from) * t) * Math.PI / 180;
  }

  return {
    REF: REF,
    RING: RING,
    SPRITE: SPRITE,
    sourceRect: sourceRect,
    outputSide: outputSide,
    coverage: coverage,
    applyMask: applyMask,
    renderSprite: renderSprite,
    angleAt: angleAt
  };
});
