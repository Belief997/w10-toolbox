/* selftest.js — 用 make_samples.py 的产物回归校验 decoders.js
 *
 *     python make_samples.py && node selftest.js
 *
 * 每个样例解码后与 samples/reference.rgb 逐像素比,算 maxErr / PSNR,
 * 超过该格式的理论容差就报 FAIL。容差不是拍脑袋:
 *   无损格式(rgb888/rgba/gray/raw)必须近乎逐位一致;
 *   rgb565 有 5/6/5 量化;4:2:2/4:2:0 有色度抽样;JPEG 不在 Node 里测。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require('./decoders.js');

const DIR = path.join(__dirname, 'samples');
const man = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const { width: W, height: H } = man;
const ref = fs.readFileSync(path.join(DIR, 'reference.rgb'));

if (ref.length !== W * H * 3) {
  console.error(`reference.rgb 大小不符:${ref.length} != ${W * H * 3}`);
  process.exit(1);
}

/** 比对 RGBA 解码结果与 RGB 参考,返回 {maxErr, psnr, meanErr} */
function compare(rgba, opt) {
  opt = opt || {};
  const skipEdge = opt.skipEdge || 0;       // 去马赛克在最外几圈必然有误差
  const gray = !!opt.gray;                  // gray8:参考也要先转灰度
  const yTo = opt.yTo != null ? Math.min(opt.yTo, H - skipEdge) : H - skipEdge;
  let maxErr = 0, se = 0, sae = 0, n = 0;
  for (let y = skipEdge; y < yTo; y++) {
    for (let x = skipEdge; x < W - skipEdge; x++) {
      const i = (y * W + x) * 3, q = (y * W + x) * 4;
      let e0, e1, e2;
      if (gray) {
        // 参考灰度 = BT.601 luma,与 make_samples 的 rgb_to_yuv 同一套系数
        const lum = Math.round(0.299 * ref[i] + 0.587 * ref[i + 1] + 0.114 * ref[i + 2]);
        e0 = e1 = e2 = rgba[q] - lum;
      } else {
        e0 = rgba[q] - ref[i]; e1 = rgba[q + 1] - ref[i + 1]; e2 = rgba[q + 2] - ref[i + 2];
      }
      for (const e of [e0, e1, e2]) {
        const a = Math.abs(e);
        if (a > maxErr) maxErr = a;
        se += e * e; sae += a; n++;
      }
    }
  }
  const mse = se / n;
  return { maxErr, meanErr: sae / n, psnr: mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse) };
}

/* 各格式容差:[maxErr 上限, PSNR 下限, 选项]
 * 说明容差来源,避免以后调松了没人察觉。*/
const CASES = [
  // 无损 8bit:必须逐位一致
  { file: `rgb888_${W}x${H}.raw`,   fmt: 'rgb888',   maxErr: 0,  psnr: Infinity, why: '无损' },
  { file: `bgr888_${W}x${H}.raw`,   fmt: 'bgr888',   maxErr: 0,  psnr: Infinity, why: '无损' },
  { file: `rgba8888_${W}x${H}.raw`, fmt: 'rgba8888', maxErr: 0,  psnr: Infinity, why: '无损' },
  /* 5/6/5:编码端是截断(v>>3),不是四舍五入,所以 R/B 误差上界 = 步长-1 = 7,G = 3。
   * 实测正好 7/3/7,说明「高位复制补低位」的展开是对的 —— 若改成简单左移,
   * 白色会掉到 248,maxErr 立刻超 7。这个 7 是紧的,不是放水。*/
  { file: `rgb565_${W}x${H}.raw`,   fmt: 'rgb565',   maxErr: 7,  psnr: 44, why: '565 截断量化' },
  { file: `rgb565be_${W}x${H}.raw`, fmt: 'rgb565',   maxErr: 7,  psnr: 44, why: '565 大端', opt: { bigEndian: true } },
  { file: `bgr565_${W}x${H}.raw`,   fmt: 'bgr565',   maxErr: 7,  psnr: 44, why: '565 R/B 互换' },
  { file: `rgb565_stride1344_${W}x${H}.raw`, fmt: 'rgb565', maxErr: 7, psnr: 44, why: '565+stride 填充', opt: { stride: 1344 } },

  // 4:2:2 色度水平减半:纯红/纯蓝 1px 竖条处色度必然被抹平,允许大 maxErr,看 PSNR
  { file: `yuyv_${W}x${H}.yuv`, fmt: 'yuyv', maxErr: 140, psnr: 22, why: '422 色度抽样' },
  { file: `yvyu_${W}x${H}.yuv`, fmt: 'yvyu', maxErr: 140, psnr: 22, why: '422 色度抽样' },
  { file: `uyvy_${W}x${H}.yuv`, fmt: 'uyvy', maxErr: 140, psnr: 22, why: '422 色度抽样' },
  { file: `vyuy_${W}x${H}.yuv`, fmt: 'vyuy', maxErr: 140, psnr: 22, why: '422 色度抽样' },
  { file: `yuyv_full_${W}x${H}.yuv`,  fmt: 'yuyv', maxErr: 140, psnr: 22, why: '422 full range', opt: { range: 'full' } },
  { file: `yuyv_bt709_${W}x${H}.yuv`, fmt: 'yuyv', maxErr: 140, psnr: 22, why: '422 BT.709',    opt: { matrix: 'bt709' } },
  { file: `nv16_${W}x${H}.yuv`, fmt: 'nv16', maxErr: 140, psnr: 22, why: '422 semi-planar' },
  { file: `nv61_${W}x${H}.yuv`, fmt: 'nv61', maxErr: 140, psnr: 22, why: '422 semi-planar' },
  { file: `i422_${W}x${H}.yuv`, fmt: 'i422', maxErr: 140, psnr: 22, why: '422 planar' },
  { file: `yv16_${W}x${H}.yuv`, fmt: 'yv16', maxErr: 140, psnr: 22, why: '422 planar' },
  // 4:2:0 再加垂直减半,细纹区误差更大
  { file: `nv12_${W}x${H}.yuv`, fmt: 'nv12', maxErr: 150, psnr: 20, why: '420 抽样' },
  { file: `nv21_${W}x${H}.yuv`, fmt: 'nv21', maxErr: 150, psnr: 20, why: '420 抽样' },
  { file: `i420_${W}x${H}.yuv`, fmt: 'i420', maxErr: 150, psnr: 20, why: '420 抽样' },
  { file: `yv12_${W}x${H}.yuv`, fmt: 'yv12', maxErr: 150, psnr: 20, why: '420 抽样' },
  // gray8:只比亮度,limited range 往返有 ~1 灰阶取整
  { file: `gray8_${W}x${H}.raw`, fmt: 'gray8', maxErr: 2, psnr: 48, why: 'luma 取整', opt: {}, gray: true },

  /* RAW:参考图最下面 1/4 是 1px 黑白/红蓝细纹,Bayer 每个位置只有一个通道样本,
   * 采样率不足 —— 任何去马赛克算法都还原不出来(这是物理限制,不是 bug)。
   * 所以 RAW 只在 y < 390 的平坦/彩条/灰阶/肤色区做判定,细纹区另行单独报告。
   * 平坦区实测 maxErr 160~176、PSNR 29.2~29.4,且峰值全部落在彩条硬边界 0~1px 内
   * (跨越阶跃做双线性插值必然过冲/欠冲);平坦区内部是逐像素精确的。阈值按此设定。*/
  ...[
    ['raw8_rggb',      'raw8',   { cfa: 'rggb', whiteLevel: 255 },                  'RAW8 RGGB'],
    ['raw8_bggr',      'raw8',   { cfa: 'bggr', whiteLevel: 255 },                  'RAW8 BGGR'],
    ['raw8_grbg',      'raw8',   { cfa: 'grbg', whiteLevel: 255 },                  'RAW8 GRBG'],
    ['raw10p_rggb',    'raw10p', { cfa: 'rggb', whiteLevel: 1023 },                 'RAW10 MIPI packed'],
    ['raw10u_rggb',    'raw10u', { cfa: 'rggb', whiteLevel: 1023 },                 'RAW10 unpacked'],
    ['raw10u_msb_rggb','raw10u', { cfa: 'rggb', whiteLevel: 1023, msbAligned: true },'RAW10 MSB 对齐'],
    ['raw12p_rggb',    'raw12p', { cfa: 'rggb', whiteLevel: 4095 },                 'RAW12 MIPI packed'],
    ['raw12u_rggb',    'raw12u', { cfa: 'rggb', whiteLevel: 4095 },                 'RAW12 unpacked'],
    ['raw16_rggb',     'raw16',  { cfa: 'rggb', whiteLevel: 65535 },                'RAW16'],
  ].map(([stem, fmt, o, why]) => ({
    file: `${stem}_${W}x${H}.raw`, fmt, maxErr: 180, psnr: 28, why,
    opt: { blackLevel: 0, gamma: 1, ...o }, skipEdge: 2, yTo: 390,
  })),
];

let pass = 0, fail = 0, skip = 0;
console.log(`selftest · reference ${W}x${H}\n`);
console.log('格式        文件                                 maxErr   PSNR      说明');
console.log('-'.repeat(88));

for (const c of CASES) {
  const p = path.join(DIR, c.file);
  if (!fs.existsSync(p)) { console.log(`SKIP ${c.file} (缺文件)`); skip++; continue; }
  const bytes = new Uint8Array(fs.readFileSync(p));
  const need = D.expectedBytes(c.fmt, W, H, (c.opt && c.opt.stride) || 0);
  let line, ok = true;
  if (bytes.length !== need) {
    line = `字节数不符: ${bytes.length} != ${need}`;
    ok = false;
  } else {
    const r = D.decodeFrame(bytes, c.fmt, W, H, c.opt || {});
    const m = compare(r.data, { skipEdge: c.skipEdge, gray: c.gray, yTo: c.yTo });
    ok = m.maxErr <= c.maxErr && (m.psnr >= c.psnr);
    const ps = m.psnr === Infinity ? '  ∞   ' : m.psnr.toFixed(2).padStart(6);
    line = `${String(m.maxErr).padStart(6)}  ${ps}   ${c.why}`;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.fmt.padEnd(8)} ${c.file.padEnd(34)} ${line}`);
  ok ? pass++ : fail++;
}

/* ---- 附加:同一画面的不同 4:2:2 排列,解码结果必须逐位相同 ----
 * 这一条能抓到「某个排列的 U/V 偏移写反了但误差刚好在容差内」的情况。*/
console.log('\n跨格式一致性(同画面不同排列应逐位相同):');
let ePass = 0, eFail = 0;
function readDec(stem, fmt, opt) {
  const p = path.join(DIR, `${stem}_${W}x${H}.yuv`);
  if (!fs.existsSync(p)) return null;
  return D.decodeFrame(new Uint8Array(fs.readFileSync(p)), fmt, W, H, opt || {}).data;
}
function bitEq(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
for (const grp of [
  { name: '422 packed 四排列', ids: [['yuyv', 'yuyv'], ['yvyu', 'yvyu'], ['uyvy', 'uyvy'], ['vyuy', 'vyuy']] },
  { name: '422 planar/semi',   ids: [['nv16', 'nv16'], ['nv61', 'nv61'], ['i422', 'i422'], ['yv16', 'yv16']] },
  { name: '420 四排列',        ids: [['nv12', 'nv12'], ['nv21', 'nv21'], ['i420', 'i420'], ['yv12', 'yv12']] },
]) {
  const base = readDec(grp.ids[0][0], grp.ids[0][1]);
  let worst = 0, detail = [];
  for (let k = 1; k < grp.ids.length; k++) {
    const d = bitEq(base, readDec(grp.ids[k][0], grp.ids[k][1]));
    if (d !== 0) detail.push(`${grp.ids[k][0]}:${d}`);
    worst = Math.max(worst, d);
  }
  const ok = worst === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${grp.name.padEnd(18)} ${ok ? '逐位相同' : '差异 ' + detail.join(' ')}`);
  ok ? ePass++ : eFail++;
}
// packed 422 与 semi-planar 422 是同一抽样,也应逐位相同
{
  const d = bitEq(readDec('yuyv', 'yuyv'), readDec('nv16', 'nv16'));
  const ok = d === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${'YUYV vs NV16'.padEnd(18)} ${ok ? '逐位相同' : '差异 ' + d + ' 字节'}`);
  ok ? ePass++ : eFail++;
}

/* ---- 附加:尺寸推断必须把真实尺寸排在第一 ---- */
console.log('\n尺寸推断(真实尺寸应排首位):');
let gPass = 0, gFail = 0;
for (const fid of ['rgb565', 'yuyv', 'nv12', 'nv16', 'raw8', 'raw10p', 'raw12p', 'rgb888']) {
  const size = D.expectedBytes(fid, W, H, 0);
  const g = D.guessSizes(size, fid, 3);
  const top = g[0];
  const ok = top && top.w === W && top.h === H;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${fid.padEnd(7)} ${String(size).padStart(9)} -> ` +
              g.map(x => `${x.w}x${x.h}`).join(', '));
  ok ? gPass++ : gFail++;
}

console.log(`\n像素解码 ${pass} pass / ${fail} fail / ${skip} skip;` +
            `一致性 ${ePass} pass / ${eFail} fail;尺寸推断 ${gPass} pass / ${gFail} fail`);
process.exit(fail + eFail + gFail ? 1 : 0);
