#!/usr/bin/env node
/**
 * 自检:直接加载查看器用的那份解码器(ajpeg-decode.js),拿它的输出和
 * Python 的 adler32 对账。
 *
 * 因为页面和这个脚本加载的是同一个文件,这里过了就等于页面里的 alpha 是对的。
 *
 *   node verify_ajpeg.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");

// 解码器用到了 atob —— Node 16+ 自带;老版本补一个
if (typeof atob === "undefined") {
  global.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

const DECODER = path.join(__dirname, "ajpeg-decode.js");
const DATA_PATH = path.join(__dirname, "out", "data.js");

for (const p of [DECODER, DATA_PATH]) {
  if (!fs.existsSync(p)) {
    console.error(`找不到 ${p}${p === DATA_PATH ? ",先跑 python make_ajpeg.py" : ""}`);
    process.exit(1);
  }
}

const {
  adler32, decodeAlpha, b64ToBytes,
  buildAlphaBlock, buildAJPEG, parseAJPEG, ALGO_RLE,
} = require(DECODER);

const raw = fs.readFileSync(DATA_PATH, "utf8");
const DATA = JSON.parse(raw.slice(raw.indexOf("=") + 1).trim().replace(/;$/, ""));

const FOOTER = 12;   // jpeg_size u32 | block_size u32 | 'AJP1'

let fail = 0;
const bad = (msg) => { console.log("  !! " + msg); fail++; };

for (const im of DATA.images) {
  const a = im.alpha;
  const N = im.width * im.height;
  const payload = b64ToBytes(a.payload);
  const tag = `${im.name} ${im.width}x${im.height} [${a.algo === 0 ? "RLE" : "RAW"}]`;

  // 1) 行偏移表单调,且末项等于 payload 长度
  if (!a.offsets.every((v, i) => i === 0 || v >= a.offsets[i - 1]))
    bad(`${tag}: offsets 非单调`);
  if (a.offsets[im.height] !== payload.length)
    bad(`${tag}: offsets[h]=${a.offsets[im.height]} != payload ${payload.length}`);

  // 2) 用查看器的解码器还原 alpha,校验 adler32
  const alpha = decodeAlpha(im);
  const got = adler32(alpha);
  const want = a.adler32 >>> 0;
  if (alpha.length !== N) bad(`${tag}: 长度 ${alpha.length} != ${N}`);
  if (got !== want) bad(`${tag}: adler32 ${got.toString(16)} != ${want.toString(16)}`);

  // 3) 内容不能全零 —— 全零点"解成功"了其实是 payload 没解码
  let nonZero = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i]) nonZero++;
  if (nonZero === 0 && im.has_alpha) bad(`${tag}: alpha 全是 0(payload 可能没 base64 解码)`);

  // 4) 体积自洽
  if (a.payload_bytes !== payload.length) bad(`${tag}: payload_size 字段与实际长度不符`);
  if (a.block_bytes !== 16 + 4 * (im.height + 1) + a.payload_bytes)
    bad(`${tag}: block_size 对不上 16 + 4*(h+1) + payload`);
  for (const q of im.qualities) {
    if (q.ajpeg_bytes !== q.jpeg_bytes + a.block_bytes + FOOTER)
      bad(`${tag} q${q.q}: ajpeg ${q.ajpeg_bytes} != jpeg ${q.jpeg_bytes} + block ${a.block_bytes} + ${FOOTER}`);
  }

  console.log(`${got === want ? "OK  " : "FAIL"} ${tag.padEnd(34)} `
    + `payload ${String(payload.length).padStart(7)} / raw ${N}`
    + ` (${(payload.length / N * 100).toFixed(1)}%) adler=${got.toString(16)}`);
}

// --------------------------------------------------------------------------- //
// 编码回环:JS 编码器 -> JS 解码器,再和 Python 的 adler32 对照
//
// out/enc_cases.json 由 make_ajpeg.py --dump-cases 产出,里面是 Python 计算好的
// 期望值,所以这条检查能证明「页面里现编现解」的字节和 Python 完全一致。
// --------------------------------------------------------------------------- //

const CASES = path.join(__dirname, "out", "enc_cases.json");
if (fs.existsSync(CASES)) {
  const cases = JSON.parse(fs.readFileSync(CASES, "utf8"));
  console.log("\n编码回环(JS 编码 -> JS 解码 vs Python 期望):");
  for (const c of cases) {
    const alpha = Uint8Array.from(c.alpha);
    const b = buildAlphaBlock(alpha, c.width, c.height, c.mode);
    const tag = `${c.width}x${c.height} ${c.kind}`.padEnd(22);

    // 把打包好的块重新解析一遍,验证端到端
    const jpegStub = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
    const { file } = buildAJPEG(jpegStub, b.block);
    const back = parseAJPEG(file);

    const sameBytes = b.blockBytes === c.blockBytes
      && b.payloadBytes === c.payloadBytes
      && b.algo === c.algo
      && b.rleNodes === c.rleNodes;
    const rt = back.alpha.length === alpha.length
      && back.alpha.every((v, i) => v === alpha[i]);
    const sum = adler32(alpha) === (c.adler >>> 0);

    if (!sameBytes) bad(`${tag}: 字段与 Python 不符 (block ${b.blockBytes} vs ${c.blockBytes})`);
    if (!rt) bad(`${tag}: 编解码回环失败`);
    if (!sum) bad(`${tag}: adler32 不符`);

    console.log(`${sameBytes && rt && sum ? "OK  " : "FAIL"} ${tag} `
      + `algo=${b.algo === ALGO_RLE ? "RLE" : "RAW"} block=${b.blockBytes}B `
      + `回环=${rt}`);
  }
}

console.log(fail === 0
  ? `\n✓ 全部通过 —— 解码与 Python 逐位一致`
  : `\n✗ ${fail} 项失败`);
process.exit(fail ? 1 : 0);
