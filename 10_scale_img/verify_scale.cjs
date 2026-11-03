#!/usr/bin/env node
/* scale-core.js 的正确性自检。页面里那段 selfTest 只覆盖了 4×1 的玩具用例,
   这里用真实图片 + 若干性质断言做交叉验证,顺便给出 0.63 倍下两种算法的
   实际差距,以及和面积平均(参照)的 PSNR。

   node verify_scale.cjs
*/
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const S = require('./scale-core.js');

const HERE = __dirname;
let fails = 0;
function ok(cond, msg, extra) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
}

/* ---------- 最小 PNG 解码(只支持 8bit RGB/RGBA、非隔行)---------- */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) {
    throw new Error(`unsupported png: depth=${depth} ctype=${ctype} interlace=${interlace}`);
  }
  const ch = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8ClampedArray(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const si = x * ch, di = (y * w + x) * 4;
      out[di] = line[si]; out[di + 1] = line[si + 1]; out[di + 2] = line[si + 2];
      out[di + 3] = ch === 4 ? line[si + 3] : 255;
    }
    prev = line;
  }
  return { data: out, width: w, height: h };
}

/* ---------- 合成图(可控、不依赖外部文件)---------- */
function makeChecker(w, h, cell) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const on = ((x / cell | 0) + (y / cell | 0)) & 1;
    const v = on ? 255 : 0, i = (y * w + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  return { data: d, width: w, height: h };
}

function makeRamp(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    d[i] = Math.round(255 * x / (w - 1));
    d[i + 1] = Math.round(255 * y / (h - 1));
    d[i + 2] = 128; d[i + 3] = 255;
  }
  return { data: d, width: w, height: h };
}

function makeAlphaBars(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    d[i] = 255; d[i + 1] = 0; d[i + 2] = 0;
    d[i + 3] = x < w / 2 ? 0 : 255;   // 左半全透明
  }
  return { data: d, width: w, height: h };
}

function px(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
function eq(a, b) { return a.every((v, i) => Math.abs(v - b[i]) <= 1); }

/* ---------- 开跑 ---------- */
console.log('scale-core 自检\n');

console.log('[1] 最近邻 = 取中心最近的源像素,不做任何混合');
{
  const src = makeRamp(8, 1);
  const r = S.nearest(src, 4, 1);
  // 约定:srcIdx = clamp(floor((x+0.5)*sw/dw))。8→4 时取到的是 1,3,5,7。
  const expectIdx = [1, 3, 5, 7];
  const got = [];
  for (let x = 0; x < 4; x++) {
    const v = r.data[x * 4];
    const idx = expectIdx[x];
    ok(v === px(src, idx, 0)[0], `dst${x} ← src${idx} (${v})`);
    got.push(idx);
  }
  // 更强的性质:输出每个像素都必须原封不动来自某个源像素(无插值)
  const srcSet = new Set();
  for (let x = 0; x < src.width; x++) srcSet.add(px(src, x, 0)[0]);
  let mixed = 0;
  for (let x = 0; x < 4; x++) if (!srcSet.has(r.data[x * 4])) mixed++;
  ok(mixed === 0, '所有输出值都是源图的原始值(无混合)');
  ok(got.every((v, i) => v === expectIdx[i]), '索引符合 floor((x+0.5)·sw/dw)');
}

console.log('\n[2] 双线性 = 4 邻居加权');
{
  const b = S.bilinear(makeRamp(8, 1), 4, 1);
  // sx = (x+0.5)*2 - 0.5 → dst0 在 0.5 处,src0/src1 各一半
  const expect = (px(makeRamp(8, 1), 0, 0)[0] + px(makeRamp(8, 1), 1, 0)[0]) / 2;
  ok(Math.abs(b.data[0] - expect) <= 1, `dst0 = (src0+src1)/2 (${b.data[0]} ≈ ${expect})`);
  const expect1 = (px(makeRamp(8, 1), 2, 0)[0] + px(makeRamp(8, 1), 3, 0)[0]) / 2;
  ok(Math.abs(b.data[4] - expect1) <= 1, `dst1 = (src2+src3)/2 (${b.data[4]} ≈ ${expect1})`);
  // 双线性必然产生**不在源图色域里**的中间值(这正是它平滑、也是它糊的原因)
  const ramp = makeRamp(8, 1);
  const mid = S.bilinear(ramp, 16, 1);
  const srcSet = new Set();
  for (let x = 0; x < 8; x++) srcSet.add(px(ramp, x, 0)[0]);
  let mixed = 0;
  for (let x = 0; x < 16; x++) if (!srcSet.has(mid.data[x * 4])) mixed++;
  ok(mixed > 0, `放大时产生 ${mixed} 个插值出的新颜色`);
}

console.log('\n[3] 恒等缩放 (1:1) 三种算法必须逐位还原');
{
  const src = makeRamp(37, 23);
  for (const name of ['nearest', 'bilinear', 'areaAverage']) {
    const r = S[name](src, 37, 23);
    let bad = 0;
    for (let i = 0; i < src.data.length; i++) if (Math.abs(r.data[i] - src.data[i]) > 1) bad++;
    ok(bad === 0, `${name} 1:1 无损 (差异字节 ${bad})`);
  }
}

console.log('\n[4] 纯色图缩放后仍是同一颜色');
{
  const w = 64, h = 64;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = 17; d[i + 1] = 200; d[i + 2] = 99; d[i + 3] = 255; }
  const src = { data: d, width: w, height: h };
  for (const name of ['nearest', 'bilinear', 'areaAverage']) {
    const r = S[name](src, 40, 40);
    let bad = 0;
    for (let i = 0; i < r.data.length; i += 4) {
      if (r.data[i] !== 17 || r.data[i + 1] !== 200 || r.data[i + 2] !== 99) bad++;
    }
    ok(bad === 0, `${name} 纯色保持`);
  }
}

console.log('\n[5] 透明边缘不出现黑边(预乘 alpha)');
{
  const src = makeAlphaBars(64, 8);
  for (const name of ['bilinear', 'areaAverage']) {
    const r = S[name](src, 40, 8);
    let dark = 0;
    for (let i = 0; i < r.data.length; i += 4) {
      // 有 alpha 的像素里,r 不应该被透明像素的 (0,0,0) 拖暗 → 必须仍是红
      if (r.data[i + 3] > 8 && r.data[i] < 200) dark++;
    }
    ok(dark === 0, `${name} 无黑边 (${dark} 个像素被拖暗)`);
  }
}

console.log('\n[6] 面积平均是缩小的「正确答案」');
{
  // 8×1 阶梯,缩 0.5 → 每 2 个源像素平均
  const d = new Uint8ClampedArray([0,0,0,255, 100,100,100,255, 200,200,200,255, 56,56,56,255,
                                   8,8,8,255, 40,40,40,255, 240,240,240,255, 120,120,120,255]);
  const src = { data: d, width: 8, height: 1 };
  const r = S.areaAverage(src, 4, 1);
  const exp = [50, 128, 24, 180];
  const got = [r.data[0], r.data[4], r.data[8], r.data[12]];
  ok(got.every((v, i) => Math.abs(v - exp[i]) <= 1), `每 2px 平均 ${got.join(',')} ≈ ${exp.join(',')}`);
}

console.log('\n[7] destSize / 边界');
{
  ok(JSON.stringify(S.destSize(466, 466, 0.63)) === JSON.stringify([294, 294]), '466×0.63 → 294');
  ok(JSON.stringify(S.destSize(3, 3, 0.01)) === JSON.stringify([1, 1]), '极小倍数不出现 0');
  const src = makeRamp(5, 5);
  for (const name of ['nearest', 'bilinear', 'areaAverage']) {
    const r = S[name](src, 1, 1);
    ok(r.data.length === 4 && r.data[3] === 255, `${name} 缩到 1×1 不越界`);
  }
}

console.log('\n[8] 缩小 0.63 倍:最近邻 vs 双线性 vs 面积平均');
let realImg = null;
const candidate = path.join(HERE, 'wp-3.png');
if (fs.existsSync(candidate)) {
  try { realImg = decodePNG(fs.readFileSync(candidate)); }
  catch (e) { console.log('  ! 内置 PNG 解码器不支持:', e.message); }
}
{
  const src = realImg || makeRamp(256, 256);
  const label = realImg ? 'wp-3.png' : '合成 ramp';
  const [dw, dh] = S.destSize(src.width, src.height, 0.63);
  const nn = S.nearest(src, dw, dh);
  const bl = S.bilinear(src, dw, dh);
  const ar = S.areaAverage(src, dw, dh);
  console.log(`  源 ${src.width}×${src.height} (${label}) → ${dw}×${dh}`);
  console.log(`  PSNR 最近邻 vs 双线性 : ${S.psnr(nn, bl).toFixed(2)} dB`);
  console.log(`  PSNR 最近邻 vs 面积平均: ${S.psnr(nn, ar).toFixed(2)} dB`);
  console.log(`  PSNR 双线性 vs 面积平均: ${S.psnr(bl, ar).toFixed(2)} dB`);
  console.log(`  最大通道差 最近邻/双线性: ${S.maxAbsDiff(nn, bl)}`);
  ok(S.psnr(bl, ar) > S.psnr(nn, ar), '双线性比最近邻更接近面积平均(缩小时更「正确」)');
  ok(S.maxAbsDiff(nn, bl) > 0, '两种算法在真实图上有可见差异');
}

console.log('\n[9] 差异图 / 指标');
{
  const a = makeRamp(16, 16);
  const b = makeRamp(16, 16);
  ok(S.psnr(a, b) === Infinity, '同图 PSNR = ∞');
  ok(S.maxAbsDiff(a, b) === 0, '同图最大差 = 0');
  b.data[0] = (b.data[0] + 40) & 255;
  const d = S.diffImage(a, b, 6);
  ok(d.data[0] === Math.min(255, Math.abs(a.data[0] - b.data[0]) * 6), '差异图按 gain 放大');
}

console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
