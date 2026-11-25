'use strict';

// 生成托盘图标（16/32 px 的 PNG）。不引第三方库：手写 PNG 头和 zlib 压缩即可。
// 图案是一个环 —— 和竖条里每一格的圆环是同一个语言。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;      // bit depth
  header[9] = 6;      // colour type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 一个环：外径 size/2-1，线宽 size/6。每像素 4×4 采样做抗锯齿。
function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const outer = size / 2 - 1;
  const inner = outer - size / 6;
  const color = [0xb7, 0xea, 0xd4];
  const samples = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples - center;
          const py = y + (sy + 0.5) / samples - center;
          const distance = Math.hypot(px, py);
          if (distance <= outer && distance >= inner) hits += 1;
        }
      }
      const alpha = Math.round((hits / (samples * samples)) * 255);
      const offset = (y * size + x) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = alpha;
    }
  }
  return rgba;
}

function main() {
  const out = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(out, { recursive: true });
  for (const size of [16, 32]) {
    const file = path.join(out, size === 16 ? 'tray.png' : 'tray@2x.png');
    fs.writeFileSync(file, encodePng(size, draw(size)));
    console.log(`wrote ${file}`);
  }
}

if (require.main === module) main();
module.exports = { crc32, draw, encodePng };
