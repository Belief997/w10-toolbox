/**
 * AJPEG 编解码器 —— 单一事实来源。
 *
 * 查看器(ajpeg-compare.html)和自检脚本(verify_ajpeg.cjs)都加载这个文件，
 * 所以不可能再出现「测试过了但页面是坏的」这种情况。
 *
 * 格式见 make_ajpeg.py 顶部注释。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AJPEGDecode = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAGIC = "AJP1";
  const HEADER_SIZE = 16;
  const FOOTER_SIZE = 12;
  const ALGO_RLE = 0;
  const ALGO_RAW = 1;

  // ------------------------------------------------------------------ //
  // 基础工具
  // ------------------------------------------------------------------ //

  /** base64 -> 字节。data.js 里所有二进制字段都是 base64。 */
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 与 Python 的 zlib.adler32 逐位一致。 */
  function adler32(bytes) {
    const MOD = 65521;
    let a = 1, b = 0, i = 0;
    const n = bytes.length;
    while (i < n) {
      const end = Math.min(i + 5552, n);   // 5552 字节内 b 不会溢出 2^53
      for (; i < end; i++) { a += bytes[i]; b += a; }
      a %= MOD; b %= MOD;
    }
    return ((b << 16) | a) >>> 0;
  }

  // ------------------------------------------------------------------ //
  // RLE:与 honeygui-design/tools/image-converter/compress/rle.ts 同格式
  // ------------------------------------------------------------------ //

  /**
   /**
   * 逐行解码 RLE。offsets 是 (h+1) 个 u32，相对 payload 起点。
   * 输出长度是 width*height —— 注意不是 offsets[height]，那是压缩后的长度。
   * 节点格式：[len:1][byte:1]，run 上限 255。
   */
  function rleDecode(payload, offsets, width, height) {
    const out = new Uint8Array(width * height);
    let w = 0;
    for (let y = 0; y < height; y++) {
      let p = offsets[y];
      const end = offsets[y + 1];
      while (p < end) {
        const run = payload[p], val = payload[p + 1];
        out.fill(val, w, w + run);
        w += run;
        p += 2;
      }
    }
    return { alpha: out, written: w };
  }

  /** 逐行 RLE 编码，与 rle.ts 的 compressLine 逐字节一致(run 上限 255)。 */
  function rleEncode(alpha, width, height) {
    // 第一趟:算总大小,避免用数组反复扩容
    const offsets = new Array(height + 1);
    let total = 0, nodes = 0;
    for (let y = 0; y < height; y++) {
      offsets[y] = total;
      let i = y * width;
      const end = (y + 1) * width;
      while (i < end) {
        const b = alpha[i];
        let run = 1, j = i + 1;
        while (j < end && run < 255 && alpha[j] === b) { run++; j++; }
        total += 2; nodes += 1; i = j;
      }
    }
    offsets[height] = total;

    // 第二趟:填充
    const payload = new Uint8Array(total);
    let w = 0;
    for (let y = 0; y < height; y++) {
      let i = y * width;
      const end = (y + 1) * width;
      while (i < end) {
        const b = alpha[i];
        let run = 1, j = i + 1;
        while (j < end && run < 255 && alpha[j] === b) { run++; j++; }
        payload[w++] = run;
        payload[w++] = b;
        i = j;
      }
    }
    return { payload, offsets, nodes };
  }

  function rawOffsets(width, height) {
    const out = new Array(height + 1);
    for (let y = 0; y <= height; y++) out[y] = y * width;
    return out;
  }

  // ------------------------------------------------------------------ //
  // alpha 块
  // ------------------------------------------------------------------ //

  /**
   * 生成 alpha 块。mode: 'best' 自动择优 | 'rle' 强制 RLE | 'raw' 强制裸存。
   * 返回的 block 可直接拼到 JPEG 后面。
   */
  function buildAlphaBlock(alpha, width, height, mode) {
    mode = mode || "best";
    const rle = rleEncode(alpha, width, height);
    const rawLen = width * height;

    let algo, payload, offsets;
    if (mode === "rle") {
      algo = ALGO_RLE; payload = rle.payload; offsets = rle.offsets;
    } else if (mode === "raw") {
      algo = ALGO_RAW; payload = alpha; offsets = rawOffsets(width, height);
    } else if (rle.payload.length <= rawLen) {      // 相等时选 RLE,与 Python 一致
      algo = ALGO_RLE; payload = rle.payload; offsets = rle.offsets;
    } else {
      algo = ALGO_RAW; payload = alpha; offsets = rawOffsets(width, height);
    }

    let hasAlpha = false;
    for (let i = 0; i < alpha.length; i++) if (alpha[i] !== 255) { hasAlpha = true; break; }

    const tableBytes = 4 * (height + 1);
    const block = new Uint8Array(HEADER_SIZE + tableBytes + payload.length);
    const view = new DataView(block.buffer);
    for (let i = 0; i < 4; i++) block[i] = MAGIC.charCodeAt(i);
    view.setUint16(4, width, true);
    view.setUint16(6, height, true);
    block[8] = algo;
    block[9] = 0;                       // feature_1
    block[10] = 0;                      // feature_2
    block[11] = hasAlpha ? 1 : 0;
    view.setUint32(12, payload.length, true);
    for (let i = 0; i <= height; i++) view.setUint32(HEADER_SIZE + i * 4, offsets[i], true);
    block.set(payload, HEADER_SIZE + tableBytes);

    return {
      block, algo, hasAlpha,
      payloadBytes: payload.length,
      rleBytes: rle.payload.length,
      rleNodes: rle.nodes,
      rawBytes: rawLen,
      tableBytes,
      blockBytes: block.length,
    };
  }

  // ------------------------------------------------------------------ //
  // JPEG 码流解析
  // ------------------------------------------------------------------ //

  const SOF_NAMES = {
    0xC0: "SOF0", 0xC1: "SOF1", 0xC2: "SOF2", 0xC3: "SOF3",
    0xC5: "SOF5", 0xC6: "SOF6", 0xC7: "SOF7",
    0xC9: "SOF9", 0xCA: "SOF10", 0xCB: "SOF11",
  };

  /** 返回 EOI 之后的下标(JPEG 码流真实长度)。 */
  function jpegEnd(data) {
    if (data[0] !== 0xFF || data[1] !== 0xD8) throw new Error("不是 JPEG 码流");
    const n = data.length;
    let i = 2;
    while (i < n - 1) {
      if (data[i] !== 0xFF) { i++; continue; }
      while (i < n && data[i] === 0xFF) i++;
      if (i >= n) break;
      const m = data[i]; i++;
      if (m === 0xD9) return i;                                  // EOI
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;       // 无长度字段
      if (m === 0xDA) {                                          // SOS:后面是熵数据
        i += (data[i] << 8) | data[i + 1];
        while (i < n - 1) {
          if (data[i] === 0xFF) {
            const nxt = data[i + 1];
            if (nxt === 0x00 || nxt === 0xFF || (nxt >= 0xD0 && nxt <= 0xD7)) { i += 2; continue; }
            break;
          }
          i++;
        }
        continue;
      }
      if (i + 2 > n) break;
      i += (data[i] << 8) | data[i + 1];
    }
    throw new Error("没有找到 EOI");
  }

  /** 扫 SOF,取出帧类型、各分量采样因子、量化表数。 */
  function parseJpeg(data) {
    const info = { sof: null, progressive: false, components: [], dqt: 0 };
    const n = jpegEnd(data);
    let i = 2;
    while (i < n - 1) {
      if (data[i] !== 0xFF) { i++; continue; }
      while (i < n && data[i] === 0xFF) i++;
      const m = data[i]; i++;
      if (m === 0xD9 || m === 0xDA) break;
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;
      const segLen = (data[i] << 8) | data[i + 1];
      const seg = i + 2;
      i += segLen;
      if (m === 0xDB) info.dqt++;
      if (SOF_NAMES[m]) {
        info.sof = SOF_NAMES[m];
        info.progressive = (m === 0xC2 || m === 0xC6 || m === 0xCA);
        const nf = data[seg + 5];
        for (let k = 0; k < nf; k++) {
          const hv = data[seg + 7 + k * 3];
          info.components.push({
            id: data[seg + 6 + k * 3],
            h: hv >> 4, v: hv & 0x0F,
            tq: data[seg + 8 + k * 3],
          });
        }
      }
    }
    return info;
  }

  /** 把各分量采样因子翻译成 4:2:0 / 4:2:2 / 4:4:4。 */
  function samplingLabel(info) {
    const c = info.components;
    if (!c.length) return "?";
    const y = c[0];
    if (y.h === 1 && y.v === 1) return "4:4:4";
    if (y.h === 2 && y.v === 1) return "4:2:2";
    if (y.h === 2 && y.v === 2) return "4:2:0";
    return `${y.h}x${y.v}`;
  }

  // ------------------------------------------------------------------ //
  // 组装 / 拆解
  // ------------------------------------------------------------------ //

  /** 把 JPEG 裁到 EOI,接上 alpha 块和尾部索引。 */
  function buildAJPEG(jpeg, block) {
    const jpegSize = jpegEnd(jpeg);
    const out = new Uint8Array(jpegSize + block.length + FOOTER_SIZE);
    out.set(jpeg.subarray(0, jpegSize), 0);
    out.set(block, jpegSize);
    const view = new DataView(out.buffer);
    const f = jpegSize + block.length;
    view.setUint32(f, jpegSize, true);
    view.setUint32(f + 4, block.length, true);
    for (let i = 0; i < 4; i++) out[f + 8 + i] = MAGIC.charCodeAt(i);
    return { file: out, jpegSize, jpeg: out.subarray(0, jpegSize) };
  }

  /** 从 .jpg 尾巴反解出 JPEG 段与 alpha。 */
  function parseAJPEG(blob) {
    if (blob.length < FOOTER_SIZE) throw new Error("文件太短");
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const f = blob.length - FOOTER_SIZE;
    const jpegSize = view.getUint32(f, true);
    const blockSize = view.getUint32(f + 4, true);
    let magic = "";
    for (let i = 0; i < 4; i++) magic += String.fromCharCode(blob[f + 8 + i]);
    if (magic !== MAGIC) throw new Error("尾部没有 AJP1 magic,不是 AJPEG 文件");
    if (jpegSize + blockSize + FOOTER_SIZE !== blob.length) throw new Error("尾部索引与文件长度不符");

    const block = blob.subarray(jpegSize, jpegSize + blockSize);
    const bview = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const width = bview.getUint16(4, true);
    const height = bview.getUint16(6, true);
    const algo = block[8];
    const payloadSize = bview.getUint32(12, true);
    const tableBytes = 4 * (height + 1);

    const offsets = new Array(height + 1);
    for (let i = 0; i <= height; i++) offsets[i] = bview.getUint32(HEADER_SIZE + i * 4, true);
    const payload = block.subarray(HEADER_SIZE + tableBytes, HEADER_SIZE + tableBytes + payloadSize);

    const alpha = algo === ALGO_RLE
      ? rleDecode(payload, offsets, width, height).alpha
      : payload.slice();

    return {
      jpeg: blob.subarray(0, jpegSize), alpha, width, height,
      algo, hasAlpha: !!(block[11] & 1), payload, offsets,
      payloadSize, blockSize, jpegSize,
    };
  }

  // ------------------------------------------------------------------ //
  // data.js 记录 -> alpha
  // ------------------------------------------------------------------ //

  /** 从 data.js 的单张图记录里还原 alpha(Uint8Array，长度 = w*h)。 */
  function decodeAlpha(img) {
    const a = img.alpha;
    const W = img.width, H = img.height;
    const payload = b64ToBytes(a.payload);
    if (a.algo === ALGO_RLE) {
      return rleDecode(payload, a.offsets, W, H).alpha;
    }
    return payload.slice(0, W * H);
  }

  return {
    MAGIC, HEADER_SIZE, FOOTER_SIZE, ALGO_RLE, ALGO_RAW,
    b64ToBytes, adler32,
    rleDecode, rleEncode, rawOffsets, buildAlphaBlock,
    jpegEnd, parseJpeg, samplingLabel,
    buildAJPEG, parseAJPEG, decodeAlpha,
  };
});
