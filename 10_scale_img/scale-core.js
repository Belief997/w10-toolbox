/* 缩放算法内核 —— 浏览器(window.ScaleCore)与 Node(module.exports)共用。
   输入输出统一是 {data: Uint8ClampedArray, width, height} 的 RGBA 图像。
   三个算法都是「像素中心对齐」的采样:目标像素 (x,y) 的中心映射到源图的
   (x+0.5)*sw/dw - 0.5,也就是 GPU / 大多数库的默认约定。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScaleCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* 目标尺寸:四舍五入,至少 1px。 */
  function destSize(w, h, factor) {
    return [
      Math.max(1, Math.round(w * factor)),
      Math.max(1, Math.round(h * factor)),
    ];
  }

  function isOpaque(src) {
    const d = src.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
    return true;
  }

  /* ---------- 最近邻 ---------- */
  /* 每个目标像素取「中心最近」的那个源像素:floor((x+0.5)*sw/dw)。
     等价于 GPU 的 NEAREST 采样。0.63 倍时会整块整块地丢行丢列。 */
  function nearest(src, dw, dh) {
    const sw = src.width, sh = src.height, s = src.data;
    const out = new Uint8ClampedArray(dw * dh * 4);
    const fx = sw / dw, fy = sh / dh;
    const xm = new Int32Array(dw), ym = new Int32Array(dh);
    for (let x = 0; x < dw; x++) xm[x] = clamp(Math.floor((x + 0.5) * fx), 0, sw - 1) * 4;
    for (let y = 0; y < dh; y++) ym[y] = clamp(Math.floor((y + 0.5) * fy), 0, sh - 1) * sw * 4;
    let oo = 0;
    for (let y = 0; y < dh; y++) {
      const so = ym[y];
      for (let x = 0; x < dw; x++) {
        const si = so + xm[x];
        out[oo] = s[si];
        out[oo + 1] = s[si + 1];
        out[oo + 2] = s[si + 2];
        out[oo + 3] = s[si + 3];
        oo += 4;
      }
    }
    return { data: out, width: dw, height: dh };
  }

  /* ---------- 双线性 ---------- */
  /* 只取最近的 4 个邻居做加权。放大时它很平滑;缩小时它的采样核
     宽度始终是 2 个源像素,比目标像素覆盖的范围(1/factor)窄得多,
     所以会漏采样 → 摩尔纹、细线闪断。这正是要和最近邻对比的东西。
     非不透明图按「预乘 alpha」插值,避免透明边缘出现黑边。 */
  function bilinear(src, dw, dh) {
    const sw = src.width, sh = src.height, s = src.data;
    const out = new Uint8ClampedArray(dw * dh * 4);
    const fx = sw / dw, fy = sh / dh;
    const opaque = isOpaque(src);

    const x0 = new Int32Array(dw), x1 = new Int32Array(dw), xt = new Float32Array(dw);
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * fx - 0.5;
      const i0 = Math.floor(sx);
      xt[x] = sx - i0;
      x0[x] = clamp(i0, 0, sw - 1) * 4;
      x1[x] = clamp(i0 + 1, 0, sw - 1) * 4;
    }

    let oo = 0;
    for (let y = 0; y < dh; y++) {
      const sy = (y + 0.5) * fy - 0.5;
      const j0 = Math.floor(sy), ty = sy - j0;
      const r0 = clamp(j0, 0, sh - 1) * sw * 4;
      const r1 = clamp(j0 + 1, 0, sh - 1) * sw * 4;
      const y0 = 1 - ty, y1 = ty;
      for (let x = 0; x < dw; x++) {
        const a0 = r0 + x0[x], b0 = r0 + x1[x];
        const a1 = r1 + x0[x], b1 = r1 + x1[x];
        const tx = xt[x], tx0 = 1 - tx;
        const w00 = tx0 * y0, w10 = tx * y0, w01 = tx0 * y1, w11 = tx * y1;
        if (opaque) {
          out[oo] = s[a0] * w00 + s[b0] * w10 + s[a1] * w01 + s[b1] * w11;
          out[oo + 1] = s[a0 + 1] * w00 + s[b0 + 1] * w10 + s[a1 + 1] * w01 + s[b1 + 1] * w11;
          out[oo + 2] = s[a0 + 2] * w00 + s[b0 + 2] * w10 + s[a1 + 2] * w01 + s[b1 + 2] * w11;
          out[oo + 3] = 255;
        } else {
          const k0 = s[a0 + 3] * w00, k1 = s[b0 + 3] * w10;
          const k2 = s[a1 + 3] * w01, k3 = s[b1 + 3] * w11;
          const A = k0 + k1 + k2 + k3;
          if (A > 0) {
            out[oo] = (s[a0] * k0 + s[b0] * k1 + s[a1] * k2 + s[b1] * k3) / A;
            out[oo + 1] = (s[a0 + 1] * k0 + s[b0 + 1] * k1 + s[a1 + 1] * k2 + s[b1 + 1] * k3) / A;
            out[oo + 2] = (s[a0 + 2] * k0 + s[b0 + 2] * k1 + s[a1 + 2] * k2 + s[b1 + 2] * k3) / A;
            out[oo + 3] = A;
          }
        }
        oo += 4;
      }
    }
    return { data: out, width: dw, height: dh };
  }

  /* ---------- 面积平均(box / 参考用) ---------- */
  /* 每个目标像素按「覆盖面积」加权平均源像素 —— 也就是正经的 box 滤波。
     这里只作为参照物,不属于对比项:它告诉你缩到 0.63 倍「正确」的样子。 */
  function buildTaps(srcN, dstN) {
    const taps = new Array(dstN);
    const scale = srcN / dstN;
    for (let d = 0; d < dstN; d++) {
      const a = d * scale, b = (d + 1) * scale;
      const i0 = Math.floor(a);
      const i1 = Math.min(srcN, Math.max(i0 + 1, Math.ceil(b)));
      const w = new Float32Array(i1 - i0);
      let sum = 0;
      for (let i = i0; i < i1; i++) {
        const ww = Math.min(b, i + 1) - Math.max(a, i);
        if (ww > 0) { w[i - i0] = ww; sum += ww; }
      }
      if (sum > 0) for (let k = 0; k < w.length; k++) w[k] /= sum;
      else w[0] = 1;
      taps[d] = { i0, w };
    }
    return taps;
  }

  function areaAverage(src, dw, dh) {
    const sw = src.width, sh = src.height, s = src.data;
    const opaque = isOpaque(src);
    const xt = buildTaps(sw, dw), yt = buildTaps(sh, dh);
    const out = new Uint8ClampedArray(dw * dh * 4);
    const acc = new Float32Array(dw * 4);
    const row = new Float32Array(dw * 4);
    for (let d = 0; d < dh; d++) {
      acc.fill(0);
      const ty = yt[d];
      for (let k = 0; k < ty.w.length; k++) {
        const wy = ty.w[k];
        if (wy === 0) continue;
        const so = (ty.i0 + k) * sw * 4;
        for (let x = 0; x < dw; x++) {
          const tap = xt[x], i0 = tap.i0, wn = tap.w;
          let r = 0, g = 0, b = 0, a = 0;
          for (let m = 0; m < wn.length; m++) {
            const p = so + (i0 + m) * 4, ww = wn[m];
            if (ww === 0) continue;
            if (opaque) { r += s[p] * ww; g += s[p + 1] * ww; b += s[p + 2] * ww; }
            else {
              const k2 = s[p + 3] * ww;
              r += s[p] * k2; g += s[p + 1] * k2; b += s[p + 2] * k2; a += k2;
            }
          }
          const o = x * 4;
          row[o] = r; row[o + 1] = g; row[o + 2] = b;
          row[o + 3] = opaque ? 255 : a;
        }
        for (let i = 0; i < dw * 4; i++) acc[i] += row[i] * wy;
      }
      const oo = d * dw * 4;
      for (let x = 0; x < dw; x++) {
        const o = x * 4, q = oo + o;
        if (opaque) {
          out[q] = acc[o]; out[q + 1] = acc[o + 1]; out[q + 2] = acc[o + 2]; out[q + 3] = 255;
        } else {
          const A = acc[o + 3];
          if (A > 0.5) {
            out[q] = acc[o] / A; out[q + 1] = acc[o + 1] / A; out[q + 2] = acc[o + 2] / A;
            out[q + 3] = A;
          }
        }
      }
    }
    return { data: out, width: dw, height: dh };
  }

  /* ---------- 指标 ---------- */
  function psnr(a, b) {
    const da = a.data, db = b.data, n = da.length;
    let se = 0;
    for (let i = 0; i < n; i++) { const d = da[i] - db[i]; se += d * d; }
    const mse = se / n;
    return mse === 0 ? Infinity : 10 * Math.log10(65025 / mse);
  }

  function maxAbsDiff(a, b) {
    const da = a.data, db = b.data, n = da.length;
    let m = 0;
    for (let i = 0; i < n; i++) { const d = Math.abs(da[i] - db[i]); if (d > m) m = d; }
    return m;
  }

  /* 差异图:逐像素取通道最大差 × gain,输出灰度(亮 = 差异大)。 */
  function diffImage(a, b, gain) {
    const da = a.data, db = b.data, n = a.width * a.height;
    const out = new Uint8ClampedArray(n * 4);
    const g = gain || 1;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      let d = Math.abs(da[p] - db[p]);
      const d1 = Math.abs(da[p + 1] - db[p + 1]);
      const d2 = Math.abs(da[p + 2] - db[p + 2]);
      if (d1 > d) d = d1;
      if (d2 > d) d = d2;
      const v = Math.min(255, d * g);
      out[p] = v; out[p + 1] = v; out[p + 2] = v; out[p + 3] = 255;
    }
    return { data: out, width: a.width, height: a.height };
  }

  return {
    destSize, isOpaque, nearest, bilinear, areaAverage,
    psnr, maxAbsDiff, diffImage, buildTaps,
  };
});
