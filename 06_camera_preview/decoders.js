/* decoders.js — camera dump 解码核心
 *
 * 纯计算,不碰 DOM,浏览器 / Node 都能跑(Node 下由 selftest.js 做回归校验)。
 * 像素解码统一签名:
 *     decodeRaw(bytes, fmtId, w, h, opt) -> Uint8ClampedArray(w*h*4)
 * JPEG 不在此处解(交给浏览器 createImageBitmap)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamDec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ============================ 通用小工具 ============================ */

const clamp8 = v => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** 行跨距:未填 / 小于紧凑跨距 => 用紧凑跨距 */
function rowStride(userStride, minStride) {
  const s = Math.floor(userStride || 0);
  return s >= minStride ? s : minStride;
}

/** 按 align 向上取整(UI 的「行按 N 字节对齐」用) */
function alignUp(v, align) {
  return align > 1 ? Math.ceil(v / align) * align : v;
}

function newRGBA(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;   // alpha 预置,解码器只写 RGB
  return d;
}

/* ============================ 格式登记表 ============================ */
/* bpp  : 每像素平均 bit(用于尺寸推断与「期望字节数」提示)
 * pack : 宽度必须是它的倍数(行内打包粒度 / 色度抽样)
 * knobs: 该格式在 UI 上要暴露的参数
 */
const FORMATS = [
  // ---- RGB ----
  { id:'rgb565',   group:'RGB', label:'RGB565',         bpp:16, pack:1, knobs:['endian','stride'] },
  { id:'bgr565',   group:'RGB', label:'BGR565',         bpp:16, pack:1, knobs:['endian','stride'] },
  { id:'rgb888',   group:'RGB', label:'RGB888 (24bpp)', bpp:24, pack:1, knobs:['stride'] },
  { id:'bgr888',   group:'RGB', label:'BGR888 (24bpp)', bpp:24, pack:1, knobs:['stride'] },
  { id:'rgba8888', group:'RGB', label:'RGBA8888',       bpp:32, pack:1, knobs:['stride'] },
  { id:'bgra8888', group:'RGB', label:'BGRA8888',       bpp:32, pack:1, knobs:['stride'] },

  // ---- YUV 4:2:2 packed ----
  { id:'yuyv', group:'YUV422', label:'YUV422 packed · YUYV (YUY2)', bpp:16, pack:2, knobs:['range','matrix','stride'] },
  { id:'yvyu', group:'YUV422', label:'YUV422 packed · YVYU',        bpp:16, pack:2, knobs:['range','matrix','stride'] },
  { id:'uyvy', group:'YUV422', label:'YUV422 packed · UYVY (Y422)', bpp:16, pack:2, knobs:['range','matrix','stride'] },
  { id:'vyuy', group:'YUV422', label:'YUV422 packed · VYUY',        bpp:16, pack:2, knobs:['range','matrix','stride'] },
  // ---- YUV 4:2:2 semi-planar / planar ----
  { id:'nv16', group:'YUV422', label:'YUV422 semi-planar · NV16 (Y+UV)',  bpp:16, pack:2, knobs:['range','matrix','stride'] },
  { id:'nv61', group:'YUV422', label:'YUV422 semi-planar · NV61 (Y+VU)',  bpp:16, pack:2, knobs:['range','matrix','stride'] },
  { id:'i422', group:'YUV422', label:'YUV422 planar · I422/YU16 (Y+U+V)', bpp:16, pack:2, knobs:['range','matrix','stride'] },
  { id:'yv16', group:'YUV422', label:'YUV422 planar · YV16 (Y+V+U)',      bpp:16, pack:2, knobs:['range','matrix','stride'] },
  // ---- YUV 4:2:0(dump 同样高频,附带支持)----
  { id:'nv12', group:'YUV420', label:'YUV420 semi-planar · NV12 (Y+UV)', bpp:12, pack:2, knobs:['range','matrix','stride'] },
  { id:'nv21', group:'YUV420', label:'YUV420 semi-planar · NV21 (Y+VU)', bpp:12, pack:2, knobs:['range','matrix','stride'] },
  { id:'i420', group:'YUV420', label:'YUV420 planar · I420/YU12',        bpp:12, pack:2, knobs:['range','matrix','stride'] },
  { id:'yv12', group:'YUV420', label:'YUV420 planar · YV12',             bpp:12, pack:2, knobs:['range','matrix','stride'] },
  // ---- 单通道 ----
  { id:'gray8', group:'GRAY', label:'GRAY8 (Y only)', bpp:8, pack:1, knobs:['range','stride'] },

  // ---- Bayer RAW ----
  { id:'raw8',   group:'RAW', label:'RAW8 (Bayer 8bit)',            bpp:8,  pack:2, knobs:['cfa','raw','stride'] },
  { id:'raw10p', group:'RAW', label:'RAW10 · MIPI packed (5B/4px)', bpp:10, pack:4, knobs:['cfa','raw','stride'] },
  { id:'raw10u', group:'RAW', label:'RAW10 · unpacked 16bit',       bpp:16, pack:2, knobs:['cfa','raw','endian','msb','stride'] },
  { id:'raw12p', group:'RAW', label:'RAW12 · MIPI packed (3B/2px)', bpp:12, pack:2, knobs:['cfa','raw','stride'] },
  { id:'raw12u', group:'RAW', label:'RAW12 · unpacked 16bit',       bpp:16, pack:2, knobs:['cfa','raw','endian','msb','stride'] },
  { id:'raw16',  group:'RAW', label:'RAW16 · unpacked 16bit',       bpp:16, pack:2, knobs:['cfa','raw','endian','stride'] },

  // ---- 压缩流(浏览器解)----
  { id:'jpeg', group:'JPEG', label:'JPEG / MJPEG frame', bpp:0, pack:1, knobs:[] },
];

const FMT = {};
for (const f of FORMATS) FMT[f.id] = f;

/** 紧凑打包时每行字节数;planar/semi-planar 指亮度面行宽 */
function minLumaStride(fmtId, w) {
  switch (fmtId) {
    case 'rgb565': case 'bgr565': return w * 2;
    case 'rgb888': case 'bgr888': return w * 3;
    case 'rgba8888': case 'bgra8888': return w * 4;
    case 'yuyv': case 'yvyu': case 'uyvy': case 'vyuy': return w * 2;
    case 'raw10p': return Math.ceil(w / 4) * 5;
    case 'raw12p': return Math.ceil(w / 2) * 3;
    case 'raw10u': case 'raw12u': case 'raw16': return w * 2;
    default: return w;   // gray8 / raw8 / 各 planar 的 Y 面
  }
}

/** 给定格式与宽高,所需总字节数(含 stride 填充) */
function expectedBytes(fmtId, w, h, stride) {
  if (fmtId === 'jpeg') return 0;
  const ls = rowStride(stride, minLumaStride(fmtId, w));
  switch (fmtId) {
    case 'nv16': case 'nv61': case 'i422': case 'yv16':
      return ls * h * 2;                       // Y 面 h 行 + 色度合计 h 行
    case 'nv12': case 'nv21': case 'i420': case 'yv12':
      return ls * h + ls * (h >> 1);
    default:
      return ls * h;
  }
}

/* ============================== RGB 系 ============================== */

/* RGB565 的 5/6/5 -> 8bit 用「高位复制到低位」补齐(v<<3 | v>>2),
 * 而不是简单左移 —— 否则最大值 31 只能到 248,白色会发灰。 */
const EXP5 = new Uint8Array(32), EXP6 = new Uint8Array(64);
for (let i = 0; i < 32; i++) EXP5[i] = (i << 3) | (i >> 2);
for (let i = 0; i < 64; i++) EXP6[i] = (i << 2) | (i >> 4);

function decode565(b, w, h, o, swapRB) {
  const out = newRGBA(w, h), ls = rowStride(o.stride, w * 2), be = !!o.bigEndian;
  for (let y = 0; y < h; y++) {
    let p = y * ls, q = y * w * 4;
    for (let x = 0; x < w; x++, p += 2, q += 4) {
      const lo = b[p] | 0, hi = b[p + 1] | 0;
      const v = be ? (lo << 8) | hi : (hi << 8) | lo;
      const c0 = EXP5[(v >> 11) & 31], g = EXP6[(v >> 5) & 63], c1 = EXP5[v & 31];
      out[q]     = swapRB ? c1 : c0;
      out[q + 1] = g;
      out[q + 2] = swapRB ? c0 : c1;
    }
  }
  return out;
}

function decode888(b, w, h, o, swapRB) {
  const out = newRGBA(w, h), ls = rowStride(o.stride, w * 3);
  for (let y = 0; y < h; y++) {
    let p = y * ls, q = y * w * 4;
    for (let x = 0; x < w; x++, p += 3, q += 4) {
      const c0 = b[p] | 0, c1 = b[p + 2] | 0;
      out[q]     = swapRB ? c1 : c0;
      out[q + 1] = b[p + 1] | 0;
      out[q + 2] = swapRB ? c0 : c1;
    }
  }
  return out;
}

/* dump 的 alpha 常常是 0 或垃圾值,一律忽略按不透明显示 */
function decode8888(b, w, h, o, swapRB) {
  const out = newRGBA(w, h), ls = rowStride(o.stride, w * 4);
  for (let y = 0; y < h; y++) {
    let p = y * ls, q = y * w * 4;
    for (let x = 0; x < w; x++, p += 4, q += 4) {
      const c0 = b[p] | 0, c1 = b[p + 2] | 0;
      out[q]     = swapRB ? c1 : c0;
      out[q + 1] = b[p + 1] | 0;
      out[q + 2] = swapRB ? c0 : c1;
    }
  }
  return out;
}

/* ============================== YUV 系 ============================== */

/* 矩阵系数 Kr/Kb(BT.601 标清 / BT.709 高清 / BT.2020)。
 * 反变换:R = Y + 2(1-Kr)·V,B = Y + 2(1-Kb)·U,
 *         G = Y - (2Kr(1-Kr)/Kg)·V - (2Kb(1-Kb)/Kg)·U,Kg = 1-Kr-Kb */
const MATRICES = {
  bt601: { label:'BT.601 (SD, 默认)', kr:0.299,  kb:0.114  },
  bt709: { label:'BT.709 (HD)',       kr:0.2126, kb:0.0722 },
  bt2020:{ label:'BT.2020',           kr:0.2627, kb:0.0593 },
};

/* 预生成查表:Y 走一条 256 项的线性拉伸表,UV 走四条系数表。
 * 每帧只查表不做浮点乘,1080p 全图也是毫秒级。 */
function yuvTables(matrixId, full) {
  const m = MATRICES[matrixId] || MATRICES.bt601;
  const kg = 1 - m.kr - m.kb;
  const rv =  2 * (1 - m.kr);
  const bu =  2 * (1 - m.kb);
  const gv = -2 * m.kr * (1 - m.kr) / kg;
  const gu = -2 * m.kb * (1 - m.kb) / kg;

  // limited range: Y 16..235 -> 0..255,C 16..240 中心 128
  const yScale = full ? 1 : 255 / 219, cScale = full ? 1 : 255 / 224;
  const yOff   = full ? 0 : 16;

  const tY = new Int32Array(256);
  const tRV = new Int32Array(256), tGV = new Int32Array(256),
        tGU = new Int32Array(256), tBU = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    tY[i] = Math.round((i - yOff) * yScale);
    const c = (i - 128) * cScale;
    tRV[i] = Math.round(c * rv);
    tGV[i] = Math.round(c * gv);
    tGU[i] = Math.round(c * gu);
    tBU[i] = Math.round(c * bu);
  }
  return { tY, tRV, tGV, tGU, tBU };
}

function yuvOpt(o) {
  return yuvTables(o.matrix || 'bt601', (o.range || 'limited') === 'full');
}

function putYUV(out, q, Y, U, V, t) {
  const y = t.tY[Y];
  out[q]     = clamp8(y + t.tRV[V]);
  out[q + 1] = clamp8(y + t.tGU[U] + t.tGV[V]);
  out[q + 2] = clamp8(y + t.tBU[U]);
}

/* ---- 4:2:2 packed:YUYV / YVYU / UYVY / VYUY ----
 * off = [Y0, Y1, U, V] 在每 4 字节宏像素内的偏移 */
const PACKED422 = {
  yuyv: [0, 2, 1, 3],
  yvyu: [0, 2, 3, 1],
  uyvy: [1, 3, 0, 2],
  vyuy: [1, 3, 2, 0],
};

function decodePacked422(b, w, h, o, fmtId) {
  const out = newRGBA(w, h), t = yuvOpt(o), ls = rowStride(o.stride, w * 2);
  const [oy0, oy1, ou, ov] = PACKED422[fmtId];
  const wEven = w & ~1;
  for (let y = 0; y < h; y++) {
    let p = y * ls, q = y * w * 4;
    for (let x = 0; x < wEven; x += 2, p += 4, q += 8) {
      const U = b[p + ou] | 0, V = b[p + ov] | 0;
      putYUV(out, q,     b[p + oy0] | 0, U, V, t);
      putYUV(out, q + 4, b[p + oy1] | 0, U, V, t);
    }
    if (w & 1) putYUV(out, q, b[p + oy0] | 0, b[p + ou] | 0, b[p + ov] | 0, t);
  }
  return out;
}

/* ---- 4:2:2 / 4:2:0 semi-planar 与 planar ----
 * sub  : 色度垂直抽样(1 = 422,2 = 420)
 * semi : true = NV 系交织(UV/VU),false = 三平面
 * swap : true = V 在前(NV21/NV61/YV12/YV16)
 * 色度面行宽沿用亮度 stride;planar 时每个色度面行宽 = stride/2。 */
function decodePlanarYUV(b, w, h, o, sub, semi, swap) {
  const out = newRGBA(w, h), t = yuvOpt(o), ls = rowStride(o.stride, w);
  const cw = w >> 1, ch = sub === 2 ? (h + 1) >> 1 : h;
  const yPlane = 0, cBase = ls * h;
  const cls = semi ? ls : ls >> 1;              // 色度面行宽
  const p1 = cBase, p2 = cBase + cls * ch;      // planar 的两个色度面起点
  for (let y = 0; y < h; y++) {
    const cy = sub === 2 ? y >> 1 : y;
    let q = y * w * 4, yp = yPlane + y * ls;
    for (let x = 0; x < w; x++, q += 4) {
      const cx = x >> 1;
      let U, V;
      if (semi) {
        const cp = cBase + cy * cls + cx * 2;
        U = b[cp + (swap ? 1 : 0)] | 0;
        V = b[cp + (swap ? 0 : 1)] | 0;
      } else {
        const a = b[(swap ? p2 : p1) + cy * cls + cx] | 0;
        const c = b[(swap ? p1 : p2) + cy * cls + cx] | 0;
        U = a; V = c;
      }
      putYUV(out, q, b[yp + x] | 0, U, V, t);
    }
  }
  return out;
}

function decodeGray8(b, w, h, o) {
  const out = newRGBA(w, h), t = yuvOpt(o), ls = rowStride(o.stride, w);
  for (let y = 0; y < h; y++) {
    let p = y * ls, q = y * w * 4;
    for (let x = 0; x < w; x++, p++, q += 4) {
      const v = clamp8(t.tY[b[p] | 0]);
      out[q] = out[q + 1] = out[q + 2] = v;
    }
  }
  return out;
}

/* ============================== RAW / Bayer ============================== */

/* 第一步:把各种位打包还原成 w*h 的 Uint16 Bayer 平面。
 * MIPI CSI-2 打包:低位字节在前,零散位集中在每组最后一个字节,
 *   RAW10 = 4 像素 5 字节(4 个高 8 位 + 1 个字节放 4×2 低位)
 *   RAW12 = 2 像素 3 字节(2 个高 8 位 + 1 个字节放 2×4 低位) */
function unpackBayer(b, fmtId, w, h, o) {
  const ls = rowStride(o.stride, minLumaStride(fmtId, w));
  const out = new Uint16Array(w * h);
  const be = !!o.bigEndian, msb = !!o.msbAligned;

  for (let y = 0; y < h; y++) {
    const row = y * ls, q = y * w;
    switch (fmtId) {
      case 'raw8':
        for (let x = 0; x < w; x++) out[q + x] = b[row + x] | 0;
        break;
      case 'raw10p':
        for (let x = 0; x < w; x += 4) {
          const p = row + (x >> 2) * 5, lo = b[p + 4] | 0;
          for (let k = 0; k < 4 && x + k < w; k++)
            out[q + x + k] = ((b[p + k] | 0) << 2) | ((lo >> (k * 2)) & 3);
        }
        break;
      case 'raw12p':
        for (let x = 0; x < w; x += 2) {
          const p = row + (x >> 1) * 3, lo = b[p + 2] | 0;
          out[q + x] = ((b[p] | 0) << 4) | (lo & 15);
          if (x + 1 < w) out[q + x + 1] = ((b[p + 1] | 0) << 4) | (lo >> 4);
        }
        break;
      default: {   // raw10u / raw12u / raw16:每像素一个 16bit
        const bits = fmtId === 'raw10u' ? 10 : fmtId === 'raw12u' ? 12 : 16;
        const shift = msb ? 16 - bits : 0, mask = (1 << bits) - 1;
        for (let x = 0; x < w; x++) {
          const p = row + x * 2, l = b[p] | 0, hi = b[p + 1] | 0;
          const v = be ? (l << 8) | hi : (hi << 8) | l;
          out[q + x] = (v >> shift) & mask;
        }
      }
    }
  }
  return out;
}

/** 原始位深(决定归一化分母) */
function rawBits(fmtId) {
  switch (fmtId) {
    case 'raw8': return 8;
    case 'raw10p': case 'raw10u': return 10;
    case 'raw12p': case 'raw12u': return 12;
    default: return 16;
  }
}

/** 扫一遍求 min/max,给「自动拉伸」用;顺带回报直方图峰值信息 */
function planeStats(p) {
  let mn = 65535, mx = 0, sum = 0;
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
  }
  return { min: mn, max: mx, mean: sum / (p.length || 1) };
}

/* CFA 排列:左上 2×2 的通道索引(0=R 1=G 2=B)。
 * cfa='rggb' 时 (0,0)=R (1,0)=G (0,1)=G (1,1)=B。 */
const CFA = {
  rggb: [0, 1, 1, 2],
  bggr: [2, 1, 1, 0],
  grbg: [1, 0, 2, 1],
  gbrg: [1, 2, 0, 1],
  mono: null,                 // 不去马赛克,当灰度看
};

/** 某像素在 CFA 下属于哪个通道 */
function cfaChannel(order, x, y) {
  return order[((y & 1) << 1) | (x & 1)];
}

/* 第二步:双线性去马赛克。
 * 对每个像素,缺失通道取同通道最近邻的平均 —— 经典 bilinear,
 * 边缘细节不如 AHD/VNG,但 dump 排查看的是「颜色/CFA 对不对」,足够且快。 */
function demosaicBilinear(plane, w, h, order, gain) {
  const out = newRGBA(w, h);
  /* 越界要「镜像反射」而不是钳位:钳位会取回同一个像素,那是错的 CFA 通道,
   * 四条边会染上假色。反射 x→-x / x→2(w-1)-x 保持奇偶性,通道才对。 */
  const mx = x => (x < 0 ? -x : x >= w ? 2 * (w - 1) - x : x);
  const my = y => (y < 0 ? -y : y >= h ? 2 * (h - 1) - y : y);
  const at = (x, y) => plane[my(y) * w + mx(x)];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4, c = cfaChannel(order, x, y), v = plane[y * w + x];
      let R, G, B;
      if (c === 1) {
        // 绿点:同行 / 同列各取两邻,一边是 R 一边是B,由上一行的通道决定
        const h2 = (at(x - 1, y) + at(x + 1, y)) / 2;
        const v2 = (at(x, y - 1) + at(x, y + 1)) / 2;
        G = v;
        // 同一行水平邻居属于哪个通道
        if (cfaChannel(order, x - 1, y) === 0) { R = h2; B = v2; }
        else                                   { R = v2; B = h2; }
      } else {
        // R 或 B 点:G 取上下左右 4 邻,异色取 4 个对角
        G = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
        const d = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4;
        if (c === 0) { R = v; B = d; } else { B = v; R = d; }
      }
      out[q]     = clamp8(R * gain.r);
      out[q + 1] = clamp8(G * gain.g);
      out[q + 2] = clamp8(B * gain.b);
    }
  }
  return out;
}

/** mono:不去马赛克,Bayer 平面直接当灰度(能看出 CFA 网格和曝光) */
function bayerAsGray(plane, w, h, scale) {
  const out = newRGBA(w, h);
  for (let i = 0, q = 0; i < plane.length; i++, q += 4) {
    const v = clamp8(plane[i] * scale);
    out[q] = out[q + 1] = out[q + 2] = v;
  }
  return out;
}

/* 第三步:总装。
 * blackLevel / 位深归一化 / 白平衡增益 / gamma 都在这里合成为每通道一个标量增益,
 * gamma 则走 256 项 LUT 后处理。 */
function decodeRAW(b, fmtId, w, h, o) {
  const plane = unpackBayer(b, fmtId, w, h, o);
  const bits = rawBits(fmtId);
  const maxV = (1 << bits) - 1;
  const st = planeStats(plane);

  // 黑电平与白电平:auto 用实测 min/max,手动则用输入值
  let black = o.blackLevel | 0, white = o.whiteLevel | 0;
  if (o.autoLevel) { black = st.min; white = st.max > st.min ? st.max : st.min + 1; }
  if (!(white > black)) white = maxV;

  const span = white - black;
  const norm = 255 / span;

  // 先减黑电平再缩放:把平面就地改写成「0..span」,避免在内层循环里重复减法
  if (black !== 0) {
    for (let i = 0; i < plane.length; i++) {
      const v = plane[i] - black;
      plane[i] = v < 0 ? 0 : v;
    }
  }

  /* 注意不能写 `CFA[o.cfa] || CFA.rggb`:mono 的值就是 null(表示「不去马赛克」),
   * 那样写会让 mono 静默退回 rggb。要区分「键不存在」和「键存在但值为 null」。 */
  const order = o.cfa in CFA ? CFA[o.cfa] : CFA.rggb;
  let out;
  if (!order) {
    out = bayerAsGray(plane, w, h, norm);
  } else {
    out = demosaicBilinear(plane, w, h, order, {
      r: norm * (o.gainR || 1), g: norm * (o.gainG || 1), b: norm * (o.gainB || 1),
    });
  }

  // gamma:dump 出来的 RAW 是线性光,不做 gamma 会明显偏暗
  const gm = o.gamma || 1;
  if (Math.abs(gm - 1) > 1e-3) {
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) lut[i] = clamp8(255 * Math.pow(i / 255, 1 / gm));
    for (let i = 0; i < out.length; i += 4) {
      out[i] = lut[out[i]]; out[i + 1] = lut[out[i + 1]]; out[i + 2] = lut[out[i + 2]];
    }
  }
  return { data: out, stats: { ...st, bits, black, white } };
}

/* ============================== 统一入口 ============================== */

/** 解一帧非压缩数据 -> { data: RGBA, stats? }。JPEG 请走浏览器路径。 */
function decodeFrame(bytes, fmtId, w, h, o) {
  o = o || {};
  switch (fmtId) {
    case 'rgb565':   return { data: decode565(bytes, w, h, o, false) };
    case 'bgr565':   return { data: decode565(bytes, w, h, o, true)  };
    case 'rgb888':   return { data: decode888(bytes, w, h, o, false) };
    case 'bgr888':   return { data: decode888(bytes, w, h, o, true)  };
    case 'rgba8888': return { data: decode8888(bytes, w, h, o, false) };
    case 'bgra8888': return { data: decode8888(bytes, w, h, o, true)  };

    case 'yuyv': case 'yvyu': case 'uyvy': case 'vyuy':
      return { data: decodePacked422(bytes, w, h, o, fmtId) };

    //                                       sub semi  swap(V 在前)
    case 'nv16': return { data: decodePlanarYUV(bytes, w, h, o, 1, true,  false) };
    case 'nv61': return { data: decodePlanarYUV(bytes, w, h, o, 1, true,  true)  };
    case 'i422': return { data: decodePlanarYUV(bytes, w, h, o, 1, false, false) };
    case 'yv16': return { data: decodePlanarYUV(bytes, w, h, o, 1, false, true)  };
    case 'nv12': return { data: decodePlanarYUV(bytes, w, h, o, 2, true,  false) };
    case 'nv21': return { data: decodePlanarYUV(bytes, w, h, o, 2, true,  true)  };
    case 'i420': return { data: decodePlanarYUV(bytes, w, h, o, 2, false, false) };
    case 'yv12': return { data: decodePlanarYUV(bytes, w, h, o, 2, false, true)  };

    case 'gray8': return { data: decodeGray8(bytes, w, h, o) };

    case 'raw8': case 'raw10p': case 'raw10u':
    case 'raw12p': case 'raw12u': case 'raw16':
      return decodeRAW(bytes, fmtId, w, h, o);

    default: throw new Error('不支持的格式: ' + fmtId);
  }
}

/* ---- 尺寸推断 ----
 * dump 文件常常没有元信息。给定字节数,枚举「常见宽度 + 合理宽度范围」,
 * 找出能让 w*h 正好等于文件大小的组合,按「像什么」排序给用户候选。 */
const COMMON_SIZES = [
  [160,120],[176,144],[320,240],[352,288],[352,240],[640,360],[640,480],[720,480],[720,576],
  [800,600],[960,540],[1024,768],[1280,720],[1280,960],[1280,1024],[1440,1080],[1600,1200],
  [1920,1080],[1920,1440],[2048,1536],[2560,1440],[2592,1944],[3264,2448],[3840,2160],[4032,3024],
  [4096,2160],[4208,3120],[8000,6000],
  // 方形 / 小分辨率(AI 检测、人脸抓拍常见)
  [64,64],[96,96],[112,112],[128,128],[224,224],[256,256],[300,300],[416,416],[512,512],[640,640],
];

/** 单个 (w,h) 是否与 size 字节严格匹配(stride 紧凑) */
function fitsExactly(fmtId, w, h, size) {
  const f = FMT[fmtId];
  if (!f || f.bpp === 0) return false;
  if (w % f.pack !== 0) return false;
  if ((f.group === 'YUV420') && (h % 2 !== 0)) return false;
  return expectedBytes(fmtId, w, h, 0) === size;
}

/** 给定文件大小和格式,列出可能的宽高。
 *  stride > 0 时按该行跨距反推(行有填充的 dump);否则按紧凑打包。 */
function guessSizes(size, fmtId, maxN, stride) {
  maxN = maxN || 12;
  const f = FMT[fmtId];
  if (!f || f.bpp === 0 || size <= 0) return [];
  const out = [], seen = new Set();
  const push = (w, h, tag) => {
    const k = w + 'x' + h;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ w, h, tag, ratio: w / h });
  };

  /* 指定了 stride:高度由 stride 唯一确定,只需枚举「能塞进这个 stride 的宽度」。
   * 这类 dump(行按 64/128 对齐)用紧凑假设是永远猜不中的。*/
  if (stride > 0) {
    const mul = (f.group === 'YUV422') ? 2 : (f.group === 'YUV420') ? 1.5 : 1;
    const h = size / (stride * mul);
    if (Number.isInteger(h) && h >= 2 && h <= 16384 &&
        !(f.group === 'YUV420' && h % 2)) {
      /* 排序很重要:候选宽度只要 ≤ stride 就都「合法」(差额算填充),
       * 光按数值枚举会让 160×480 这种小宽度挤掉真正的 640×480。
       * 优先级:① 恰好填满 stride ② 常见宽度里最大的(填充最少)③ 其余。*/
      for (let w = f.pack; w <= 16384; w += f.pack) {
        if (minLumaStride(fmtId, w) === stride) { push(w, h, '跨距无填充'); break; }
      }
      const commons = [];
      for (const [a, b] of COMMON_SIZES) {
        for (const w of (a === b ? [a] : [a, b]))
          if (w % f.pack === 0 && minLumaStride(fmtId, w) <= stride) commons.push(w);
      }
      // 宽度从大到小(填充越少越可能是真的),去重
      for (const w of [...new Set(commons)].sort((p, q) => q - p)) {
        if (out.length >= maxN) break;
        push(w, h, '常见宽×该跨距');
      }
    }
    return out.slice(0, maxN);
  }

  // 1) 先试常见分辨率(含转置,竖拍 dump 也常见)
  for (const [a, b] of COMMON_SIZES) {
    if (fitsExactly(fmtId, a, b, size)) push(a, b, '常见');
    if (a !== b && fitsExactly(fmtId, b, a, size)) push(b, a, '常见·竖');
  }

  // 2) 再穷举宽度,挑长宽比接近常用比例的
  const NICE = [16/9, 4/3, 3/2, 1, 5/4, 16/10, 21/9, 9/16, 3/4, 2/3];
  const cands = [];
  for (let w = f.pack; w <= 16384; w += f.pack) {
    // 由平均 bpp 反推高度(对 packed / planar 一致),再交给 fitsExactly 复核
    const h = (size * 8) / (w * f.bpp);
    if (!Number.isInteger(h) || h < 2 || h > 16384) continue;
    if (!fitsExactly(fmtId, w, h, size)) continue;
    const r = w / h;
    let best = Infinity;
    for (const n of NICE) best = Math.min(best, Math.abs(r - n) / n);
    cands.push({ w, h, dev: best });
  }
  cands.sort((p, q) => p.dev - q.dev || Math.abs(p.w - p.h * 1.5) - Math.abs(q.w - q.h * 1.5));
  for (const c of cands) {
    if (out.length >= maxN) break;
    push(c.w, c.h, c.dev < 0.02 ? '比例吻合' : '可整除');
  }
  return out.slice(0, maxN);
}

return { clamp8, rowStride, alignUp, newRGBA, FORMATS, FMT, minLumaStride, expectedBytes,
         EXP5, EXP6, decode565, decode888, decode8888,
         MATRICES, yuvTables, PACKED422, decodePacked422, decodePlanarYUV, decodeGray8,
         CFA, cfaChannel, unpackBayer, rawBits, planeStats, demosaicBilinear, decodeRAW,
         decodeFrame, COMMON_SIZES, fitsExactly, guessSizes };
});
