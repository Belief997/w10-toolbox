/* preprocess.js — 串口 / 日志抓取文件的预处理
 *
 * 场景:dump 不是 `fwrite` 直出的裸二进制,而是从串口工具、adb logcat、
 * minicom 日志里捞出来的 —— 内容被转成了文本(hexdump / 0x 数组 / base64),
 * 行首还挂着时间戳,帧与帧之间可能有分隔符。这一层负责把它还原成裸字节,
 * 之后交给 decoders.js 按格式解像素。
 *
 * 纯计算,不碰 DOM;浏览器 / Node 都能跑(selftest.js 里有回归)。
 * 管线固定为四步,每步都能单独关掉:
 *     行清洗(丢行/留行/剥前缀) -> 文本解析(hex/base64/...) -> 字节修正(SLIP/字节交换) -> 帧切分
 *
 * 格式没列全是预期之中的:
 *   - `register()` 可以在不改本文件的情况下加解析器;
 *   - 内置 `custom` 解析器接受用户给的正则(捕获组 1 = 一个十六进制字节),
 *     遇到没见过的串口工具格式先用它顶上。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamPre = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ============================ 文本 / 二进制判定 ============================ */

/** 可打印 ASCII + tab/换行;其余算「二进制字节」 */
function isPrintable(c) {
  return c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126);
}

/* 判定是否文本:抽样前 64KB(整文件扫一遍对 100MB dump 太慢)。
 * 判据两条,缺一不可:
 *   1) 可打印率 >= 0.90 —— 裸 RGB565 的可打印率通常在 0.5 上下,拉得开;
 *   2) 不含 NUL —— 文本格式不会出现 0x00,而裸 dump 几乎必有。
 * 返回的 ratio 给 UI 显示,方便用户判断自动识别靠不靠谱。 */
function looksText(bytes) {
  const n = Math.min(bytes.length, 65536);
  if (!n) return { text: false, ratio: 0, nul: false };
  let ok = 0, nul = false;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) { nul = true; break; }
    if (isPrintable(c)) ok++;
  }
  const ratio = ok / n;
  return { text: !nul && ratio >= 0.90, ratio, nul };
}

/* 解码成字符串用 latin1 而不是 utf-8:日志里混进来的非法 UTF-8 序列会被
 * 替换成 U+FFFD,一个坏字节吃掉后面两个,hex 文本就对不上了。
 * latin1 是字节到码点的恒等映射,怎么坏都不串位。 */
const DEC = (() => {
  try { return new TextDecoder('latin1'); } catch { return null; }
})();

function toText(bytes) {
  let s;
  if (DEC) s = DEC.decode(bytes);
  else {
    const CH = 32768, parts = [];
    for (let i = 0; i < bytes.length; i += CH)
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CH)));
    s = parts.join('');
  }
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;   // 去 BOM
}

/* ============================ 第一步:行清洗 ============================ */

/* 串口工具 / 内核日志的行首前缀。按「最长最具体优先」排,每条都锚定行首:
 *   [   12.345678]            dmesg
 *   2024-05-01 10:00:00.123   通用日志 / sscom 时间戳
 *   10:00:00.123              短时间戳
 *   [2024-05-01 10:00:00]     方括号包起来的时间戳(友善串口助手等)
 * 时间戳后面常跟一截 `TAG:` / `RX>` / `V/Camera(123):`,一并吃掉。
 *
 * 注意不能把 hexdump 的地址列也当前缀吃掉 —— 地址交给 hexdump 解析器处理,
 * 这里的时间戳模式都要求出现 `.`/`-`/`[`,不会误伤 `00000010:` 这种纯 hex 地址。*/
const PREFIX_RE = new RegExp(
  '^[ \\t]*(?:' +
    '\\[[ \\t]*\\d+\\.\\d+[ \\t]*\\]' +                                  // [   12.345678]
    '|\\[?\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?\\]?' + // 2024-05-01 10:00:00.123
    '|\\[?\\d{2}:\\d{2}:\\d{2}[.,]\\d+\\]?' +                            // 10:00:00.123
    '|\\[(?:RX|TX|R|T)\\]' +                                             // [RX] / [TX]
  ')' +
  '[ \\t]*(?:[A-Za-z]{1,2}/)?(?:[A-Za-z_][\\w.\\-]{0,31}(?:\\(\\d+\\))?[ \\t]*[:>|][ \\t]*)?',
  '');

function reOf(src, notes, what) {
  if (!src) return null;
  try { return new RegExp(src); }
  catch (e) { notes.push({ level: 'err', msg: `${what}正则无效:${e.message}` }); return null; }
}

/** 行清洗:按需丢行 / 只留匹配行 / 剥掉行首前缀 */
function cleanLines(text, o, notes) {
  const drop = reOf(o.dropRe, notes, '丢弃行');
  const keep = reOf(o.keepRe, notes, '保留行');
  /* 默认就剥(auto):串口/日志抓来的文件带前缀是常态,不剥会让时间戳里的
   * 数字混进字节流 —— 那种错很隐蔽(画面只是偏移/错行),不如默认开。 */
  const strip = (o.stripPrefix == null || o.stripPrefix === 'auto') ? PREFIX_RE
              : o.stripPrefix === 'off' ? null
              : reOf(o.stripPrefix, notes, '剥离前缀');
  if (!drop && !keep && !strip) return text;

  const lines = text.split(/\r?\n/);
  const out = [];
  let dropped = 0, stripped = 0;
  for (const line of lines) {
    if (keep && !keep.test(line)) { dropped++; continue; }
    if (drop && drop.test(line)) { dropped++; continue; }
    if (!strip) { out.push(line); continue; }
    const s = line.replace(strip, '');
    if (s.length !== line.length) stripped++;
    out.push(s);
  }
  if (dropped) notes.push({ level: 'info', msg: `行清洗:丢弃 ${dropped} 行` });
  if (stripped) notes.push({ level: 'info', msg: `行清洗:${stripped} 行剥掉了行首前缀` });
  return out.join('\n');
}

/* ============================ 第二步:文本解析器 ============================ */

/* 每个解析器:
 *   detect(text, prep) -> 0..1 的可信度(0 = 肯定不是),自动识别取最高分
 *   parse(text, o, notes) -> Uint8Array
 * prep 是一次性预统计(见 precount),避免每个 detect 都重扫一遍大文本。
 */

const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX[48 + i] = i;
for (let i = 0; i < 6; i++) { HEX[97 + i] = 10 + i; HEX[65 + i] = 10 + i; }

function precount(text) {
  const n = Math.min(text.length, 1 << 20);     // 1MB 抽样足够判型
  let hex = 0, nonSpace = 0, b64 = 0, digit = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    nonSpace++;
    if (HEX[c] >= 0) hex++;
    if (c >= 48 && c <= 57) digit++;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 43 || c === 47 || c === 61) b64++;
  }
  return { n, nonSpace, hexRatio: hex / (nonSpace || 1), b64Ratio: b64 / (nonSpace || 1),
           digitRatio: digit / (nonSpace || 1), sample: text.slice(0, n) };
}

/** 收集可增长的字节缓冲(文件可能几十 MB,别用 Array.push 再转) */
function ByteSink(cap) {
  this.a = new Uint8Array(Math.max(1024, cap | 0));
  this.n = 0;
}
ByteSink.prototype.push = function (v) {
  if (this.n === this.a.length) {
    const b = new Uint8Array(this.a.length * 2);
    b.set(this.a); this.a = b;
  }
  this.a[this.n++] = v;
};
ByteSink.prototype.done = function () { return this.a.subarray(0, this.n); };

/* ---- hexdump:xxd / hexdump -C / od -t x1 / 各家串口工具的「十六进制显示」 ----
 *
 * 一行的三段结构:[地址] [十六进制数据] [ASCII 栏]。ASCII 栏最难办 ——
 * 它可能没有 `|` 包围(xxd 用两个空格隔开,而 xxd 自己又用两个空格分组),
 * 单看空格数分不清。这里用两遍扫:
 *   第一遍 按 token 取 hex,遇到第一个非 hex token 就停(`R.R.` 带 `.`,会停住);
 *   第二遍 用每行字节数的众数截断 —— ASCII 栏正好全是 hex 字符(如 `abcdabcd`)
 *          时第一遍拦不住,但它一定让该行超出众数,这里能兜住。
 * 两遍一起,实测对 xxd / xxd -g1 / hexdump -C / od -t x1 都干净。 */
function parseHexdump(text, o, notes) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let star = 0, wordish = 0, tokens = 0;

  for (let raw of lines) {
    if (/^[ \t]*\*[ \t]*$/.test(raw)) { star++; continue; }   // od/hexdump 的重复省略行
    if (!/[0-9a-f]/i.test(raw)) continue;

    let s = raw.replace(/\|[^|\n]*\|?[ \t]*$/, ' ');          // 去 |ASCII| 栏
    /* 去地址列。两种写法互斥,必须只套一次:
     * 带冒号的(`00000000: `)剥完剩下 ` 0b30557a 9fc4...`,再套 od 的无冒号模式
     * 会把第一个数据组当成地址吃掉 —— xxd -g4 正好踩这个坑。 */
    const noColon = s.replace(/^[ \t]*(?:0x)?[0-9a-f]{4,16}[ \t]*[:|][ \t]*/i, ' ');
    s = noColon !== s ? noColon
      : s.replace(/^[ \t]*(?:0x)?[0-9a-f]{6,16}[ \t]+/i, ' ');

    const row = [];
    for (const t of s.trim().split(/[ \t]+/)) {
      if (!t || t.length > 8 || t.length % 2 || !/^[0-9a-f]+$/i.test(t)) break;
      for (let i = 0; i < t.length; i += 2) row.push((HEX[t.charCodeAt(i)] << 4) | HEX[t.charCodeAt(i + 1)]);
      tokens++;
      if (t.length === 4) wordish++;
    }
    if (row.length) rows.push(row);
  }
  if (!rows.length) return new Uint8Array(0);

  // 众数行长
  const freq = new Map();
  for (const r of rows) freq.set(r.length, (freq.get(r.length) || 0) + 1);
  let modal = 0, best = -1;
  for (const [len, c] of freq) if (c > best || (c === best && len > modal)) { best = c; modal = len; }

  let over = 0, short = 0;
  const sink = new ByteSink(rows.length * modal);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.length > modal) { over++; r.length = modal; }
    else if (r.length < modal && i < rows.length - 1) short++;
    for (const v of r) sink.push(v);
  }

  if (star) notes.push({ level: 'warn',
    msg: `有 ${star} 行是 od/hexdump 的 "*" 省略标记,重复数据已丢失 —— 请用 hexdump -v / od -v 重新导出` });
  if (over) notes.push({ level: 'info', msg: `${over} 行超出每行 ${modal} 字节,多出部分按 ASCII 栏丢弃` });
  if (short) notes.push({ level: 'warn', msg: `${short} 行不足 ${modal} 字节(非末行),数据可能有缺口` });
  if (tokens && wordish / tokens > 0.9) notes.push({ level: 'warn',
    msg: '每组 4 位十六进制,疑似 od -x 的 16bit 字格式;若颜色错乱请打开「16bit 字节交换」' });
  return sink.done();
}

function detectHexdump(text, prep) {
  const lines = prep.sample.split(/\r?\n/).filter(l => /[0-9a-f]{2}/i.test(l));
  if (lines.length < 2) return 0;
  // 取样 40 行看「地址列 + 成组 hex」的比例
  let hit = 0, check = 0;
  for (const l of lines.slice(0, 40)) {
    check++;
    if (/^[ \t]*(?:0x)?[0-9a-f]{4,16}[ \t]*[:|][ \t]+(?:[0-9a-f]{2,8}[ \t]+){3,}/i.test(l) ||
        /^[ \t]*(?:0x)?[0-9a-f]{6,16}[ \t]+(?:[0-9a-f]{2,8}[ \t]+){3,}/i.test(l) ||
        /^[ \t]*(?:[0-9a-f]{2}[ \t]+){7,}/i.test(l)) hit++;
  }
  return hit / check >= 0.6 ? 0.9 * (hit / check) : 0;
}

/* ---- C 数组 / 0x 列表:`0x12, 0x34,` —— 代码里贴出来的 dump ---- */
function parse0x(text, o, notes) {
  const sink = new ByteSink(text.length >> 2);
  const re = /0x([0-9a-f]{1,2})\b/gi;
  let m;
  while ((m = re.exec(text))) sink.push(parseInt(m[1], 16));
  return sink.done();
}

function detect0x(text, prep) {
  const m = prep.sample.match(/0x[0-9a-f]{1,2}\b/gi);
  if (!m || m.length < 8) return 0;
  // 匹配到的字符占非空白字符的比例(`0x12, ` -> 算 6 个字符里 4 个)
  return Math.min(1, (m.join('').length * 1.4) / (prep.nonSpace || 1)) * 0.95;
}

/* ---- 转义串:`\x12\x34` 或 `\12\34`(python repr / printf 输出)---- */
function parseEscaped(text, o, notes) {
  const sink = new ByteSink(text.length >> 2);
  const re = /\\x([0-9a-f]{2})/gi;
  let m;
  while ((m = re.exec(text))) sink.push(parseInt(m[1], 16));
  return sink.done();
}

function detectEscaped(text, prep) {
  const m = prep.sample.match(/\\x[0-9a-f]{2}/gi);
  if (!m || m.length < 8) return 0;
  return Math.min(1, (m.length * 4) / (prep.nonSpace || 1)) * 0.95;
}

/* ---- 松散 hex 流:去掉所有非 hex 字符再两两成字节 ----
 * 最宽松,也最容易把日志里的单词(`cafe`、`dead`)当数据吃进来,
 * 所以 detect 要求 hex 字符占比极高,自动识别里排在最后。*/
function parseLooseHex(text, o, notes) {
  const sink = new ByteSink(text.length >> 1);
  let hi = -1, odd = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // `0x` 前缀里的 x 会断开配对,跳过它和前面那个 0
    if ((c === 120 || c === 88) && hi === 0) { hi = -1; continue; }
    const v = HEX[c];
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else { sink.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) odd = 1;
  if (odd) notes.push({ level: 'warn', msg: '十六进制字符总数为奇数,末尾半个字节已丢弃' });
  return sink.done();
}

function detectLooseHex(text, prep) {
  if (prep.nonSpace < 16) return 0;
  if (prep.hexRatio < 0.95) return 0;
  return 0.55 * prep.hexRatio;
}

/* ---- base64 ---- */
const B64 = (() => {
  const t = new Int8Array(256).fill(-1);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < A.length; i++) t[A.charCodeAt(i)] = i;
  t[45] = 62; t[95] = 63;       // URL-safe 的 - 和 _
  return t;
})();

function parseBase64(text, o, notes) {
  const sink = new ByteSink((text.length * 3) >> 2);
  let acc = 0, bits = 0;
  for (let i = 0; i < text.length; i++) {
    const v = B64[text.charCodeAt(i)];
    if (v < 0) continue;                        // 空白 / `=` / 噪声一律跳过
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; sink.push((acc >> bits) & 255); }
  }
  return sink.done();
}

function detectBase64(text, prep) {
  if (prep.nonSpace < 32) return 0;
  if (prep.b64Ratio < 0.99) return 0;
  // 纯 hex 文本同样满足 b64 字符集,但 hex 只用 16 个字母 —— 用字符种类数区分
  const seen = new Set();
  for (let i = 0; i < Math.min(prep.sample.length, 4096); i++) seen.add(prep.sample[i]);
  return seen.size > 24 ? 0.8 : 0;
}

/* ---- 十进制字节:`82, 133, 82, ...`(Arduino / Python list 常见)---- */
function parseDecimal(text, o, notes) {
  const sink = new ByteSink(text.length >> 2);
  const re = /\d{1,3}/g;
  let m, bad = 0;
  while ((m = re.exec(text))) {
    const v = +m[0];
    if (v > 255) { bad++; continue; }
    sink.push(v);
  }
  if (bad) notes.push({ level: 'warn', msg: `${bad} 个数值 > 255,已跳过(不是十进制字节?)` });
  return sink.done();
}

function detectDecimal(text, prep) {
  if (prep.digitRatio < 0.8) return 0;
  const m = prep.sample.match(/\d{1,3}/g);
  if (!m || m.length < 16) return 0;
  let big = 0;
  for (const t of m) if (+t > 255) big++;
  if (big / m.length > 0.02) return 0;
  // 和 hex 流难分:只有出现 2/3 位里带 8/9 且无 a-f 时才敢判十进制
  return prep.hexRatio > 0.98 ? 0.3 : 0.5;
}

/* ---- 自定义正则:格式未知时的兜底 ----
 * 用户给一条带捕获组的正则,组 1 当一个十六进制字节(radix 由 customRadix 定)。
 * 例:`([0-9A-F]{2})\s` / `data=0x([0-9a-f]{2})` */
function parseCustom(text, o, notes) {
  const re = reOf(o.customRe, notes, '自定义抽取');
  if (!re) return new Uint8Array(0);
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const radix = o.customRadix === 10 ? 10 : 16;
  const sink = new ByteSink(text.length >> 2);
  let m, guard = 0;
  while ((m = g.exec(text))) {
    if (m[0] === '') { g.lastIndex++; if (++guard > 1e6) break; continue; }  // 防零宽匹配死循环
    const v = parseInt(m[1] != null ? m[1] : m[0], radix);
    if (Number.isFinite(v) && v >= 0 && v <= 255) sink.push(v);
  }
  if (!sink.n) notes.push({ level: 'warn', msg: '自定义正则没抽到任何字节' });
  return sink.done();
}

const PARSERS = [
  { id: 'hexdump', label: 'hexdump(xxd / hexdump -C / od)', hint: '地址列 + 十六进制 + ASCII 栏,自动剥掉地址和 ASCII',
    parse: parseHexdump, detect: detectHexdump },
  { id: 'hex0x',   label: 'C 数组 / 0x 列表', hint: '抽取所有 0x12 形式的字节',
    parse: parse0x, detect: detect0x },
  { id: 'escaped', label: '转义串 \\x12', hint: 'python repr / printf %02x 风格',
    parse: parseEscaped, detect: detectEscaped },
  { id: 'base64',  label: 'Base64', hint: '整文件按 base64 解码,忽略换行与噪声',
    parse: parseBase64, detect: detectBase64 },
  { id: 'hex',     label: '松散十六进制流', hint: '去掉所有非十六进制字符后两两成字节(最宽松)',
    parse: parseLooseHex, detect: detectLooseHex },
  { id: 'dec',     label: '十进制字节列表', hint: '82, 133, ... 每个数一个字节',
    parse: parseDecimal, detect: detectDecimal },
  { id: 'custom',  label: '自定义正则…', hint: '捕获组 1 当一个十六进制字节,如 ([0-9A-F]{2})',
    parse: parseCustom, detect: () => 0 },
];

const PARSER = {};
for (const p of PARSERS) PARSER[p.id] = p;

/** 注册新解析器(格式待定时的扩展点),同 id 覆盖 */
function register(p) {
  if (!p || !p.id || typeof p.parse !== 'function') throw new Error('解析器需要 { id, parse }');
  p.detect = p.detect || (() => 0);
  const i = PARSERS.findIndex(x => x.id === p.id);
  if (i < 0) PARSERS.splice(PARSERS.length - 1, 0, p);   // custom 保持在最后
  else PARSERS[i] = p;
  PARSER[p.id] = p;
  return p;
}

/** 自动识别:返回按可信度降序的候选 [{id, score}] */
function detect(text, prep) {
  prep = prep || precount(text);
  const out = [];
  for (const p of PARSERS) {
    let s = 0;
    try { s = p.detect(text, prep) || 0; } catch { s = 0; }
    if (s > 0) out.push({ id: p.id, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* ============================ 第三步:字节修正 ============================ */

/* SLIP(RFC 1055)解帧:串口上传二进制最常见的成帧法。
 * 0xC0 分隔帧,0xDB 0xDC = 0xC0,0xDB 0xDD = 0xDB。
 * 返回所有帧拼接的结果 + 帧边界(交给帧切分用)。*/
function slipUnframe(bytes, notes) {
  const sink = new ByteSink(bytes.length);
  const marks = [];
  let started = false, esc = false, bad = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0xC0) {
      if (started && sink.n > (marks.length ? marks[marks.length - 1] : 0)) marks.push(sink.n);
      started = true; esc = false;
      continue;
    }
    if (!started) continue;             // 第一个 0xC0 之前的都是噪声
    if (esc) {
      esc = false;
      if (c === 0xDC) sink.push(0xC0);
      else if (c === 0xDD) sink.push(0xDB);
      else { bad++; sink.push(c); }
    } else if (c === 0xDB) esc = true;
    else sink.push(c);
  }
  if (started && sink.n > (marks.length ? marks[marks.length - 1] : 0)) marks.push(sink.n);
  if (!started) notes.push({ level: 'warn', msg: 'SLIP:没找到 0xC0 分隔符,原样放行' });
  else notes.push({ level: 'info', msg: `SLIP:解出 ${marks.length} 个帧` });
  if (bad) notes.push({ level: 'warn', msg: `SLIP:${bad} 处非法转义(0xDB 后既不是 DC 也不是 DD)` });
  return { bytes: started ? sink.done() : bytes, marks: started ? marks : [] };
}

/** 16bit 字节交换:od -x / 某些 DMA 抓取会把每个字的两个字节换位 */
function wordSwap(bytes, notes) {
  const n = bytes.length & ~1;
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < n; i += 2) { out[i] = bytes[i + 1]; out[i + 1] = bytes[i]; }
  if (bytes.length & 1) out[n] = bytes[n];
  if (bytes.length & 1) notes.push({ level: 'warn', msg: '字节交换:总长为奇数,末字节原样保留' });
  return out;
}

/* ====================== 第三步半:自描述容器头 ====================== */

/* $RAW10BEGIN 容器:ASCII 文本头 + 定长二进制数据区 + ASCII 尾。
 *
 *     $RAW10BEGIN            \r\n
 *     WIDTH=400              \r\n
 *     HEIGHT=300             \r\n
 *     BYTES=240000           \r\n   ← 数据区长度,权威
 *     BPP=2                  \r\n
 *     ENDIAN=LE              \r\n
 *     BITS=10                \r\n
 *     MAP=ROR2               \r\n   ← 数据是真值循环右移 2 位
 *     BAYER=BGGR             \r\n
 *     CHECKSUM=123456789     \r\n   ← 数据区字节累加和
 *     FRAME=7                \r\n
 *     DATA                   \r\n   ← 分隔行,之后是纯二进制
 *     <恰好 BYTES 个字节>
 *                            \r\n   ← 把二进制和尾部隔开
 *     $RAW10END              \r\n
 *
 * 认出来的好处很实在:宽高/CFA/位摆放全都不用猜,CHECKSUM 还能直接判断
 * 这一帧在串口上有没有丢字节 —— 丢字节的画面会从某一行开始整体斜掉,
 * 不验校验和很容易误以为是格式选错了。2M 波特率下这个检查有实际价值。
 *
 * 【定长读取,不按行】数据区是纯二进制,里面必然会出现 0D 0A 字节对,也必然
 * 会出现 `$RAW10END` 这种字节序列的概率性巧合。所以边界一律由 BYTES= 决定:
 * 从 DATA\r\n 之后数 BYTES 个字节,到此为止。早先的实现是「找 $RAW10END 再
 * 往前剥换行」,两个错都犯了 —— 数据区里出现相同字节就会被提前截断,而末尾
 * 恰好是 0D/0A 的合法像素会被当成分隔符吃掉。
 *
 * 这一步跑在「文本解析 -> 字节」之后:dump 可能被串口工具整体转成 hex 文本
 * (data/01.dat 就是),解出来的字节里才是这个结构。所以它吃 Uint8Array,
 * 不是原始文件文本 —— 两种载体因此共用同一套解析。 */

const CONTAINER_MAGIC = '$RAW10BEGIN';
const CONTAINER_END = '$RAW10END';

/* MAP= 字段到位变换 id 的映射。
 *
 * MAP=ROR2 的意思是「存的是真值在 10 位内循环右移 2 位的结果」:
 *     stored = ((true >> 2) | ((true & 3) << 8)) & 0x3FF
 * 于是 stored 的低 8 位 = 真值的高 8 位,stored 的高 2 位 = 真值的低 2 位。
 * 这个 16bit 值落到字节上就看 ENDIAN:
 *     LE → [高8, 低2] = raw10_hi8lo2
 *     BE → [低2, 高8] = raw10_lo2hi8
 * 所以同一个 MAP 在两种字节序下对应不同的变换,查表要带上 endian。
 *
 * 等价性已验证:对合法数据(高字节 ∈ 0..3),参考实现的
 * `((cap << 2) | (cap >> 8)) & 0x3FF` 与本工具的 `(b0 << 2) | (b1 & 3)`
 * 在全 10bit range 上逐值相同;后者多一层 &3,填充位带垃圾时更稳。*/
const MAP_TO_TRANSFORM = {
  ROR2: { le: 'raw10_hi8lo2', be: 'raw10_lo2hi8' },
  ROL2: { le: 'raw10_lo2hi8', be: 'raw10_hi8lo2' },
  NONE: { le: 'none', be: 'none' },
};

/** 在字节流里找 ASCII 子串 */
function findAscii(bytes, str, from) {
  const pat = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) pat[i] = str.charCodeAt(i);
  return indexOfPat(bytes, pat, from || 0);
}

/* 找尾标记 $RAW10END,但要求上下文也对得上:
 * 前面紧跟 \r\n(规范里数据区与尾部之间固定隔一个),后面是 \r\n 或文件尾。
 * 光搜 9 个字节的话,二进制数据里撞上同样序列就会被误当成结尾;
 * 加上前后文一共 13 个字节的约束,误判概率低到可以忽略。
 * 返回标记本身的下标(不含前导 \r\n),没找到返回 -1。*/
function findTail(bytes, from) {
  let p = from || 0;
  for (;;) {
    const at = findAscii(bytes, CONTAINER_END, p);
    if (at < 0) return -1;
    const preOK = at >= 2 && bytes[at - 2] === 13 && bytes[at - 1] === 10;
    const after = at + CONTAINER_END.length;
    const postOK = after >= bytes.length ||
                   (bytes[after] === 13 || bytes[after] === 10);
    if (preOK && postOK) return at;
    p = at + 1;
  }
}

/* 解析容器。返回 null = 不是这种容器(调用方照常走通用流程)。
 * 解析失败(头在但内容不对)会 push 提示并尽量给出能用的部分 ——
 * dump 被串口截断是常事,有一半数据也该让用户看到一半画面。*/
function parseContainer(bytes, notes) {
  const magic = findAscii(bytes, CONTAINER_MAGIC, 0);
  if (magic < 0) return null;

  // 头部是纯 ASCII,到 DATA 行为止;限长 4KB 防止在坏数据里扫很久
  const dataAt = findAscii(bytes, 'DATA\r\n', magic);
  const dataAt2 = dataAt < 0 ? findAscii(bytes, 'DATA\n', magic) : dataAt;
  if (dataAt2 < 0 || dataAt2 - magic > 4096) {
    notes.push({ level: 'warn', msg: `容器:找到 ${CONTAINER_MAGIC} 但没找到 DATA 标记,按普通数据处理` });
    return null;
  }
  const sep = dataAt >= 0 ? 6 : 5;          // 'DATA\r\n' 或 'DATA\n'
  const hdrText = toText(bytes.subarray(magic, dataAt2));
  const kv = {};
  for (const m of hdrText.matchAll(/^[ \t]*([A-Za-z0-9_]+)[ \t]*=[ \t]*(.*?)[ \t]*$/gm))
    kv[m[1].toUpperCase()] = m[2];

  const start = dataAt2 + sep;
  const declared = parseInt(kv.BYTES, 10);

  /* 数据区边界:以 BYTES= 为准。二进制里会出现 0D 0A,也可能出现与
   * $RAW10END 相同的字节序列,所以搜标记来定界本身不可靠(见本节顶部注释)。
   *
   * 唯一例外是「尾标记出现在声明长度之前」:那是丢字节的硬证据 ——
   * 数据区真的没那么长,照 BYTES 硬取会把尾部文本当成像素读进来
   * (末尾几个像素变成 0D 0A 24…,校验和也跟着被污染)。这种情况按标记
   * 反推出的真实长度截断,并把差额如实报出来。
   *
   * 为防「二进制里恰好撞上这 9 个字节」而误伤,认定尾标记时要求它
   * 前面紧跟 \r\n、后面也是 \r\n 或文件尾 —— 凑巧撞上 13 个字节的概率可忽略。*/
  const endMark = findTail(bytes, start);
  let end;
  if (Number.isFinite(declared) && declared > 0) {
    end = Math.min(start + declared, bytes.length);
    if (endMark >= 0 && endMark - 2 < end) end = endMark - 2;   // 减掉中间的 \r\n
  } else {
    end = endMark >= 0 ? endMark - 2 : bytes.length;
    notes.push({ level: 'warn',
      msg: '容器:头部没有可用的 BYTES=,改用 $RAW10END 定界;' +
           '若数据区内恰好含该字节序列会被提前截断' });
  }
  const data = bytes.subarray(start, Math.max(start, end));

  /* checksum: { want, got, ok } —— UI 要把完整性结论单独显示出来,
   * 光塞在 notes 里不够显眼(校验失败意味着画面不可信,值得占一行)。*/
  const info = { kv, bytes: data, dec: {}, pre: {}, shortBy: 0,
                 declared: Number.isFinite(declared) ? declared : null,
                 checksum: null };
  const num = k => { const v = parseInt(kv[k], 10); return Number.isFinite(v) ? v : null; };
  const W = num('WIDTH'), H = num('HEIGHT');

  notes.push({ level: 'ok',
    msg: `容器:识别到 ${CONTAINER_MAGIC} 头` +
         (kv.FRAME ? ` · 帧 #${kv.FRAME}` : '') +
         (W && H ? ` · ${W}×${H}` : '') +
         (kv.BITS ? ` · ${kv.BITS}bit` : '') +
         (kv.BAYER ? ` · ${kv.BAYER}` : '') +
         (kv.MAP ? ` · MAP=${kv.MAP}` : '') });

  /* ---- 完整性核对 ----
   * 声明长度 vs 实际取到的长度。两者不等只有两种来由:文件/传输被截断,
   * 或者尾标记把数据区提前收住了(= 真的少了字节)。两种都如实报出来,
   * 并记进 shortBy —— 上层据此自动开启丢字节重同步。*/
  if (Number.isFinite(declared) && declared !== data.length) {
    const d = declared - data.length;
    info.shortBy = d > 0 ? d : 0;
    notes.push({ level: d > 0 ? 'err' : 'warn',
      msg: `容器:头部声明 ${declared.toLocaleString()} B,实际只有 ${data.length.toLocaleString()} B` +
           (d > 0 ? ` —— 少 ${d} B,串口丢字节或文件被截断` : ` —— 多 ${-d} B`) });
  }
  if (endMark < 0) {
    notes.push({ level: 'warn',
      msg: `容器:没找到 ${CONTAINER_END} 尾标记,dump 可能不完整(已按 BYTES= 截取)` });
  }
  if (W && H) {
    const bpp = num('BPP') || 2;
    const want = W * H * bpp;
    if (Number.isFinite(declared) && want !== declared)
      notes.push({ level: 'warn',
        msg: `容器:WIDTH×HEIGHT×BPP = ${want.toLocaleString()} 与 BYTES=${declared.toLocaleString()} 不一致` });
  }

  // ---- 校验和(数据区字节累加和)----
  if (kv.CHECKSUM != null) {
    const want = parseInt(kv.CHECKSUM, 10);
    if (Number.isFinite(want)) {
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      info.checksum = { want, got: sum, ok: sum === want };
      if (sum === want) notes.push({ level: 'ok', msg: `容器:校验和吻合(${sum.toLocaleString()})` });
      else notes.push({ level: 'err',
        msg: `容器:校验和不符 —— 实算 ${sum.toLocaleString()},头部声明 ${want.toLocaleString()}` +
             `(差 ${(want - sum).toLocaleString()});这一帧数据不完整,下面的画面仅供参考` });
    }
  }

  // ---- 解码侧建议 ----
  if (W) info.dec.width = W;
  if (H) info.dec.height = H;
  if (kv.BAYER && /^(rggb|bggr|grbg|gbrg)$/i.test(kv.BAYER)) info.dec.cfa = kv.BAYER.toLowerCase();
  const endian = kv.ENDIAN && /be|big/i.test(kv.ENDIAN) ? 'be' : 'le';
  if (kv.ENDIAN) info.dec.endian = endian;

  const bits = num('BITS');
  const map = (kv.MAP || '').toUpperCase();
  if (map && MAP_TO_TRANSFORM[map]) {
    const bpp = num('BPP');
    /* 这些位变换都假定「2 字节存 1 像素」。BPP 明确不是 2 时别硬套 ——
     * 按 2 字节配对会把像素数算错一半,画面直接撕开,还不如如实报错。*/
    if (bpp != null && bpp !== 2) {
      notes.push({ level: 'warn',
        msg: `容器:MAP=${kv.MAP} 需要 BPP=2,但头部声明 BPP=${bpp},已跳过位变换` });
    } else {
      info.pre.transform = MAP_TO_TRANSFORM[map][endian];
      /* 容器自己给了数据区起点,不存在「从中间截一段」的相位歧义,
       * 固定 0 相位;否则自动判相位偶尔会在平坦画面上判反。*/
      info.pre.transformPhase = 0;
    }
  } else if (map) {
    notes.push({ level: 'warn', msg: `容器:不认识 MAP=${kv.MAP},位变换按当前设置` });
  }
  // 变换后统一是 16bit LE / LSB 对齐的 unpacked RAW
  if (bits === 10) info.dec.fmt = 'raw10u';
  else if (bits === 12) info.dec.fmt = 'raw12u';
  else if (bits === 16) info.dec.fmt = 'raw16';
  else if (bits === 8) info.dec.fmt = 'raw8';
  else if (bits != null) notes.push({ level: 'warn', msg: `容器:不支持 BITS=${bits}` });
  /* 位变换的输出一律是 16bit 小端、低位对齐 —— 这是变换自己定的布局,
   * 与源数据的 ENDIAN 无关(源字节序已经在变换里消化掉了)。*/
  if (info.pre.transform && info.pre.transform !== 'none') {
    info.dec.endian = 'le';
    info.dec.msb = 'lsb';
  }
  return info;
}

/* ============================ 第四步:位变换 ============================ */

/* 解析出裸字节后,有些传感器 / 抓取链路的位摆放和任何标准格式都不一样,
 * 需要再做一次按位重排才能交给 decoders.js。
 *
 * 约定:变换的输出必须是 decoders.js 已支持的某种布局(见各变换的 dec 建议),
 * 这样黑电平 / gamma / 白平衡 / 直方图 / 统计全都能直接复用,
 * 不用为每种怪布局在解码器里再开一个分支。
 *
 * 每个变换:
 *   prepare(whole, o, notes) -> state   可选,整条流只做一次(比如定相位)
 *   fn(bytes, o, notes, state) -> Uint8Array
 */

/** 抽样算标准差 —— 用来判断「这一档拆出来的像素值像不像图像」 */
function pairStd(bytes, phase, hiFirst) {
  const n = (bytes.length - phase) >> 1;
  if (n < 2) return 0;
  const step = Math.max(1, Math.floor(n / 100000));
  let cnt = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < n; i += step) {
    const q = phase + i * 2, a = bytes[q], b = bytes[q + 1];
    const v = hiFirst ? ((a << 2) | (b & 3)) : ((b << 2) | (a & 3));
    sum += v; sum2 += v * v; cnt++;
  }
  const mean = sum / cnt;
  return Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
}

/* 相位:字节对是从第 0 还是第 1 个字节开始配。
 * 串口日志从中间截一段、或前面多/少一个字节,整条流就会错半个像素 ——
 * 错相位时「高 8 位」实际取到的是填充字节(常是常数),整幅图会塌成一片死灰。
 * 所以 auto 比两档的标准差:谁更像图像就用谁,差距不够大就按声明的 0 相位走。*/
function resolvePhase(bytes, o, notes, hiFirst) {
  const want = o.transformPhase;
  if (want === 0 || want === 1) return want;
  if (want === '0') return 0;
  if (want === '1') return 1;
  const s0 = pairStd(bytes, 0, hiFirst), s1 = pairStd(bytes, 1, hiFirst);
  if (s1 > s0 * 1.5) {
    notes.push({ level: 'ok', msg: `位变换:自动定相位 = 1(跳过首字节);两档离散度 ${s0.toFixed(1)} vs ${s1.toFixed(1)}` });
    return 1;
  }
  if (s0 > s1 * 1.5) {
    notes.push({ level: 'ok', msg: `位变换:自动定相位 = 0;两档离散度 ${s0.toFixed(1)} vs ${s1.toFixed(1)}` });
    return 0;
  }
  notes.push({ level: 'warn',
    msg: `位变换:两个相位难分(${s0.toFixed(1)} vs ${s1.toFixed(1)}),按相位 0;画面发灰/错行就手动切相位` });
  return 0;
}

/* OV2640 这类 8bit DVP 口抓 10bit 数据的存法:每像素占两个字节 ——
 *   第 1 字节        = RAW10 的高 8 位
 *   第 2 字节的低 2 位 = RAW10 的低 2 位(其余 6 位是填充,丢弃)
 * 即 raw10 = (b0 << 2) | (b1 & 3)。
 * 输出重排成 decoders.js 的 raw10u:16bit 小端、LSB 对齐,值落在低 10 位。
 * hiFirst=false 则是两字节反着放(低位字节在前)的同族变体。*/
function makeRaw10Pair(hiFirst) {
  return {
    prepare(whole, o, notes) { return { phase: resolvePhase(whole, o, notes, hiFirst) }; },
    fn(bytes, o, notes, state) {
      const phase = state ? state.phase : 0;
      return o.resync
        ? raw10PairResync(bytes, phase, hiFirst, notes, o)
        : raw10PairPlain(bytes, phase, hiFirst, notes);
    },
  };
}

function raw10PairPlain(bytes, phase, hiFirst, notes) {
  const n = Math.max(0, (bytes.length - phase) >> 1);
  const out = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const q = phase + i * 2, a = bytes[q], b = bytes[q + 1];
    const v = hiFirst ? ((a << 2) | (b & 3)) : ((b << 2) | (a & 3));
    out[i * 2] = v & 255;            // 16bit 小端:低字节在前
    out[i * 2 + 1] = v >> 8;
  }
  const left = bytes.length - phase - n * 2;
  if (left) notes.push({ level: 'warn', msg: `位变换:末尾剩 ${left} 字节不成对,已丢弃` });
  if (!n) notes.push({ level: 'err', msg: '位变换:没有成对的字节可变换' });
  return out;
}

/* 丢字节重同步。
 *
 * 串口抓 dump 偶尔会丢掉个别字节(流控没跟上)。一旦丢一个,后面所有像素的
 * 两字节配对就整体错开半个像素 —— 画面从那一行起斜着撕开,而且越往后越错,
 * 看起来像「格式选错了」,实际格式是对的。
 *
 * 这类布局恰好能自愈:第二字节只有低 2 位有效,高 6 位在实测文件里恒为 0
 * (data/01.dat 的 19188 个像素,第二字节全是 0x02)。于是「第二字节的高 6 位
 * 是否等于基准值」就是一个免费的同步标志:对不上就说明这里错位了,跳 1 字节重试。
 *
 * 基准值不写死 0x02 —— 不同固件的填充位可能是别的常数,所以先扫一遍取众数。
 * 众数占比不够高(说明高 6 位本来就在变,这个标志不可靠)就放弃重同步,
 * 老老实实按原样配对,免得把好数据越修越乱。*/
function raw10PairResync(bytes, phase, hiFirst, notes, o) {
  const markAt = hiFirst ? 1 : 0;        // 哪一个字节带填充位

  /* 1) 定基准值:统计全部字节的众数,而不是只统计「按当前相位该是填充位」的那些。
   *
   * 这里有个反直觉的坑:丢一个字节会让它之后的所有配对整体错开,于是按固定相位
   * 采样时,错位区段取到的全是数据字节。多丢几处,相位采样里的填充位占比就会被
   * 稀释 —— 恰好是「最该修」的文件最容易被判成「没法修」。
   *
   * 改成全局直方图就绕开了这件事:填充位每个像素出现一次,无论错位与否都占
   * 全部字节的约一半。实测 data/01.dat:0x02 占 50.0%,次高的 0xcb 只占 0.4%。*/
  const freq = new Uint32Array(256);
  for (let i = phase; i < bytes.length; i++) freq[bytes[i]]++;
  const total = Math.max(1, bytes.length - phase);
  let base = 0, bestN = 0;
  for (let v = 0; v < 256; v++) if (freq[v] > bestN) { bestN = freq[v]; base = v; }
  const share = bestN / total;
  const hex2 = v => '0x' + v.toString(16).padStart(2, '0');

  const giveUp = why => {
    notes.push({ level: 'warn', msg: `重同步:${why},已按原样配对(未做修补)` });
    return raw10PairPlain(bytes, phase, hiFirst, notes);
  };

  /* 这套自愈完全依赖「填充位是个常数」。它不是常数时(低 2 位真的在承载数据),
   * 众数占比会明显低于理想的 0.5 —— 0.45 这条线是实测定的:
   *   data/01.dat(填充恒为 0x02)        → 0.50,通过
   *   合成样例(低 2 位 0..3 均匀分布)   → 0.37,拒绝
   * 早先设成 0.3 太松,让后者也进来硬修,结果 PSNR 从 13.8 掉到 5.1 —— 修反了。*/
  if (share < 0.45) return giveUp(`填充字节不是常数(众数 ${hex2(base)} 仅占 ${(share * 100).toFixed(0)}%)`);

  // 2) 扫一遍,错位就跳 1 字节;为保持行对齐,跳过处补一个占位像素
  const cap = (bytes.length - phase) >> 1;
  const out = new Uint8Array(cap * 2);
  let i = phase, p = 0, fixes = 0, lost = 0, prev = 0;
  while (i + 1 < bytes.length && p < cap) {
    if (bytes[i + markAt] === base) {
      const a = bytes[i], b = bytes[i + 1];
      const v = hiFirst ? ((a << 2) | (b & 3)) : ((b << 2) | (a & 3));
      out[p * 2] = v & 255; out[p * 2 + 1] = v >> 8;
      prev = v; p++; i += 2;
    } else if (i + 1 + markAt < bytes.length && bytes[i + 1 + markAt] === base) {
      /* 这里丢了一个字节:跳 1 字节后,下一对的标志位(i+1+markAt)就对上了。
       * 注意是 i+1+markAt 而不是 i+2+markAt —— 重新对齐后新的一对从 i+1 开始,
       * 它的标志位相对 i 只前进 1。写成 +2 会漏判,且因为保持了错误的奇偶性,
       * 后面每个像素都继续错位。
       * 补一个像素占位(取左邻值,比补 0 的黑点自然),让后面的像素仍落在正确行列。*/
      out[p * 2] = prev & 255; out[p * 2 + 1] = prev >> 8;
      p++; fixes++; i += 1;
    } else {
      // 连续两处都对不上:标志位本身不可信了,按原配对往前走
      const a = bytes[i], b = bytes[i + 1];
      const v = hiFirst ? ((a << 2) | (b & 3)) : ((b << 2) | (a & 3));
      out[p * 2] = v & 255; out[p * 2 + 1] = v >> 8;
      prev = v; p++; i += 2; lost++;
    }
  }

  /* 3) 自检。走完一遍再回头看结果合不合理 —— 这一步比事前的门槛更要紧,
   * 因为它用的是实际修补结果,而不是对数据分布的猜测。
   *
   *  · lost 多:标志位在大量位置都对不上,说明「填充位是常数」这个前提不成立;
   *  · fixes 多:串口丢几个字节是偶发事件,动辄上百处只能是误判;
   *  · 已知丢了几个字节(容器头的 BYTES 与实际之差)时直接对数 —— 这是最硬的证据。
   * 任何一条不过就整体放弃,宁可让用户看到「斜掉但未经篡改」的画面。*/
  const pixels = Math.max(1, p);
  if (lost / pixels > 0.001)
    return giveUp(`${lost} 处标志位对不上(占 ${(100 * lost / pixels).toFixed(1)}%),填充位不可信`);
  if (fixes / pixels > 0.01)
    return giveUp(`检出 ${fixes} 处疑似丢字节(占 ${(100 * fixes / pixels).toFixed(1)}%),多半是误判`);
  const expect = o && o.expectDrops;
  if (expect > 0 && fixes !== expect)
    return giveUp(`检出 ${fixes} 处,但文件头显示只丢了 ${expect} 字节,数不上 —— 不敢修`);

  if (fixes) notes.push({ level: 'ok',
    msg: `重同步:检出并修补 ${fixes} 处丢字节(填充基准 ${hex2(base)})` +
         (expect > 0 ? `,与文件头声明的 ${expect} 字节吻合` : '') +
         ';修补点各插入 1 个占位像素以保持行对齐' });
  else notes.push({ level: 'info',
    msg: `重同步:未发现丢字节(填充基准 ${hex2(base)},占比 ${(share * 100).toFixed(1)}%)` });
  return out.subarray(0, p * 2);
}

const TRANSFORMS = [
  { id: 'none', label: '不变换', hint: '解析出的字节直接交给解码器', fn: b => b },
  { id: 'raw10_hi8lo2', label: 'RAW10 · 2 字节(高8 + 次字节低2)',
    hint: 'raw = (b0 << 2) | (b1 & 3) —— OV2640 等 8bit DVP 抓 10bit 的存法;输出 RAW10 unpacked 16bit LE',
    dec: { fmt: 'raw10u', endian: 'le', msb: 'lsb' },
    ...makeRaw10Pair(true) },
  { id: 'raw10_lo2hi8', label: 'RAW10 · 2 字节(低2 + 次字节高8)',
    hint: 'raw = (b1 << 2) | (b0 & 3) —— 上一档的字节序反过来(等价于它偏移一个字节)',
    dec: { fmt: 'raw10u', endian: 'le', msb: 'lsb' },
    ...makeRaw10Pair(false) },
];

const TRANSFORM = {};
for (const t of TRANSFORMS) TRANSFORM[t.id] = t;

/** 注册新位变换(扩展点),同 id 覆盖 */
function registerTransform(t) {
  if (!t || !t.id || typeof t.fn !== 'function') throw new Error('位变换需要 { id, fn }');
  const i = TRANSFORMS.findIndex(x => x.id === t.id);
  if (i < 0) TRANSFORMS.push(t); else TRANSFORMS[i] = t;
  TRANSFORM[t.id] = t;
  return t;
}

/* ============================ 数据类型预设 ============================ */

/* 把「文本怎么解 + 位怎么摆 + 该按哪种像素格式看」打成一包,
 * 用户只需在 UI 上选一个数据类型,不用逐个开关去试。
 * dec 里的字段是给查看器用的解码侧建议(对应右侧面板的控件)。 */
const PROFILES = [
  /* auto / hextext 故意不写 transform:留空表示「听容器头的 MAP= 字段」。
   * 写成 'none' 会把容器自描述的位变换挡掉 —— 自动档反而比手动档认得少。*/
  { id: 'auto', label: '自动识别', pre: { parser: 'auto' },
    hint: '按内容猜:二进制直通,文本则自动认 hexdump / 0x 数组 / base64 等;' +
          '文件自带容器头时按头部参数来' },
  { id: 'binary', label: '裸二进制(不预处理)', pre: { parser: 'none', transform: 'none' },
    hint: 'fwrite 直出的 dump,原样交给解码器' },
  { id: 'hextext', label: '十六进制文本 → 裸字节', pre: { parser: 'auto' },
    hint: '串口工具的十六进制显示 / hexdump / 0x 数组,还原成字节后按所选格式解' },
  { id: 'ov2640_raw10_bggr', label: 'OV2640 RAW10 BGGR(hex,2 字节/像素)',
    pre: { parser: 'auto', transform: 'raw10_hi8lo2', transformPhase: 'auto' },
    dec: { fmt: 'raw10u', cfa: 'bggr', endian: 'le', msb: 'lsb' },
    hint: '每像素 2 字节:第 1 字节 = RAW10 高 8 位,第 2 字节低 2 位 = RAW10 低 2 位;' +
          '变换成 RAW10 unpacked 后按 BGGR 去马赛克' },
  /* $RAW10BEGIN 容器:头部自带宽高/CFA/MAP/校验和。
   * transform 故意不写 —— 让容器头里的 MAP= 字段说话(写了反而会盖掉它)。*/
  { id: 'raw10_container', label: '$RAW10BEGIN 容器(带头部的 dump)',
    pre: { parser: 'auto', resync: true },
    hint: '文件自带 WIDTH/HEIGHT/BITS/MAP/BAYER/CHECKSUM 文本头,全部自动套用并校验完整性;' +
          '默认开启丢字节重同步' },
];

const PROFILE = {};
for (const p of PROFILES) PROFILE[p.id] = p;

/** 注册新数据类型(扩展点),同 id 覆盖 */
function registerProfile(p) {
  if (!p || !p.id || !p.pre) throw new Error('数据类型需要 { id, pre }');
  const i = PROFILES.findIndex(x => x.id === p.id);
  if (i < 0) PROFILES.push(p); else PROFILES[i] = p;
  PROFILE[p.id] = p;
  return p;
}

/* ============================ 第五步:帧切分 ============================ */

/** "FF D8 FF" / "ffd8ff" / "0xFFD8" -> Uint8Array;非法字符返回 null */
function hexPattern(s) {
  if (!s) return null;
  const t = String(s).replace(/0x/gi, '').replace(/[\s,_:-]/g, '');
  if (!t || t.length % 2 || /[^0-9a-f]/i.test(t)) return null;
  const a = new Uint8Array(t.length >> 1);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(t.substr(i * 2, 2), 16);
  return a;
}

function indexOfPat(hay, pat, from) {
  outer:
  for (let i = from; i + pat.length <= hay.length; i++) {
    for (let k = 0; k < pat.length; k++) if (hay[i + k] !== pat[k]) continue outer;
    return i;
  }
  return -1;
}

/* 帧切分:
 *   size  按固定字节数切(知道一帧多大时最省事)
 *   magic 按起始魔数切(可选结束魔数;JPEG 预设 = FFD8FF .. FFD9)
 *   marks SLIP 解帧给出的天然边界
 * 返回 [{ bytes, from }],from 是在输入里的起始偏移(方便和 hexdump 对照)。*/
function splitFrames(bytes, o, notes, marks) {
  const mode = o.mode || 'none';
  const min = Math.max(1, o.minSize | 0 || 1);

  if (mode === 'slip' || (mode === 'auto' && marks && marks.length > 1)) {
    if (!marks || !marks.length) return [{ bytes, from: 0 }];
    const out = [];
    let prev = 0;
    for (const m of marks) {
      if (m - prev >= min) out.push({ bytes: bytes.subarray(prev, m), from: prev });
      prev = m;
    }
    return out.length ? out : [{ bytes, from: 0 }];
  }

  if (mode === 'size') {
    const n = o.size | 0;
    if (n < 1) { notes.push({ level: 'err', msg: '帧切分:帧大小必须 > 0' }); return [{ bytes, from: 0 }]; }
    const out = [];
    for (let p = 0; p < bytes.length; p += n) {
      const end = Math.min(p + n, bytes.length);
      if (end - p >= min) out.push({ bytes: bytes.subarray(p, end), from: p });
    }
    if (bytes.length % n) notes.push({ level: 'warn',
      msg: `帧切分:末帧只有 ${bytes.length % n} B(不足 ${n} B),可能是截断的` });
    return out.length ? out : [{ bytes, from: 0 }];
  }

  if (mode === 'magic' || mode === 'jpeg') {
    const start = mode === 'jpeg' ? hexPattern('FFD8FF') : hexPattern(o.start);
    const end = mode === 'jpeg' ? hexPattern('FFD9') : hexPattern(o.end);
    if (!start) { notes.push({ level: 'err', msg: '帧切分:起始魔数不是合法的十六进制' }); return [{ bytes, from: 0 }]; }
    const out = [];
    let p = indexOfPat(bytes, start, 0);
    if (p < 0) { notes.push({ level: 'warn', msg: '帧切分:整个文件里没找到起始魔数' }); return [{ bytes, from: 0 }]; }
    if (p > 0) notes.push({ level: 'info', msg: `帧切分:跳过魔数之前的 ${p} B` });
    while (p >= 0) {
      let e;
      if (end) {
        const q = indexOfPat(bytes, end, p + start.length);
        e = q < 0 ? bytes.length : q + end.length;
      } else {
        const q = indexOfPat(bytes, start, p + start.length);
        e = q < 0 ? bytes.length : q;
      }
      if (e - p >= min) out.push({ bytes: bytes.subarray(p, e), from: p });
      p = indexOfPat(bytes, start, Math.max(e, p + 1));
    }
    return out.length ? out : [{ bytes, from: 0 }];
  }

  return [{ bytes, from: 0 }];
}

/* ============================ 总装 ============================ */

/**
 * 预处理入口。
 * @param {Uint8Array} input 原始文件字节
 * @param {object} o {
 *   profile: <数据类型 id>,                 // 可选;其字段作为下列选项的默认值
 *   parser: 'auto'|'none'|<解析器 id>,     // none = 当裸二进制直通
 *   dropRe, keepRe, stripPrefix,            // 行清洗
 *   customRe, customRadix,                  // parser === 'custom' 时用
 *   slip, wordSwap,                         // 字节修正
 *   container: 'off' 可关掉自描述容器头识别
 *   transform: <位变换 id>, transformPhase,  // 位重排;不传 = 听容器头 / 数据类型
 *   resync: true|false,                     // 丢字节重同步;不传 = 容器缺字节时自动开
 *   frames: { mode, size, start, end, minSize },
 * }
 *
 * 注意 transform / resync 的「不传」和「传 undefined」是一个意思,但和传
 * 'none' / false 不同:后者是用户的明确选择,会压过容器头的自描述参数。
 *
 * @returns {{ frames: Array<{bytes, from}>, bytes: Uint8Array, parser: string,
 *             transform: string, dec: object|null, container: object|null,
 *             isText: boolean, printable: number,
 *             notes: Array, candidates: Array, inSize: number, outSize: number }}
 */
function preprocess(input, o) {
  o = o || {};
  /* 数据类型只提供默认值:显式传入的同名选项优先,
   * 这样 UI 上「选了预设再手动改某一项」不会被预设覆盖回去。 */
  const prof = o.profile ? PROFILE[o.profile] : null;
  /* 容器头里的 MAP= 字段该不该盖掉当前的位变换?只有「用户自己选了变换」
   * 才不该被盖。而数据类型预设里的 transform 属于默认值,是可以被盖的 ——
   * 所以必须在合并预设之前记下哪些字段是调用方显式给的。 */
  const userSet = { transform: o.transform != null, transformPhase: o.transformPhase != null };
  if (prof) o = { ...prof.pre, ...o };
  const notes = [];
  if (o.profile && !prof) notes.push({ level: 'err', msg: '未知数据类型:' + o.profile });
  const lt = looksText(input);
  let parserId = o.parser || 'auto';

  if (parserId === 'auto') {
    if (!lt.text) {
      parserId = 'none';
      notes.push({ level: 'info',
        msg: `自动识别:二进制(可打印率 ${(lt.ratio * 100).toFixed(0)}%${lt.nul ? ',含 NUL' : ''}),直通` });
    }
  }

  let bytes = input, candidates = [];
  if (parserId !== 'none') {
    const rawText = toText(input);
    const text = cleanLines(rawText, o, notes);
    const prep = precount(text);
    candidates = detect(text, prep);

    if (parserId === 'auto') {
      if (candidates.length) {
        const top = candidates[0];
        parserId = top.id;
        notes.push({ level: 'ok',
          msg: `自动识别:${PARSER[top.id].label}(可信度 ${(top.score * 100).toFixed(0)}%)` });
        if (candidates[1] && candidates[1].score > top.score * 0.8)
          notes.push({ level: 'info', msg: `也可能是 ${PARSER[candidates[1].id].label},解错了就手动改` });
      } else {
        /* 认不出来但内容确实是文本:退回松散 hex,而不是当二进制直通。
         * 各 detect 都有最小样本量门槛(防止在正常日志里误判),
         * 几十字节的短片段过不了门槛 —— 而那正是从串口窗口里随手复制一段的常见情形。
         * 把一堆 ASCII 当像素看必然是满屏噪声;按 hex 解至少有机会是对的。*/
        parserId = 'hex';
        notes.push({ level: 'warn',
          msg: '自动识别:认不出具体编码(样本太短?),按松散十六进制解;不对就手动选解析器或用自定义正则' });
      }
    }

    if (parserId !== 'none') {
      const p = PARSER[parserId];
      if (!p) { notes.push({ level: 'err', msg: '未知解析器:' + parserId }); }
      else {
        bytes = p.parse(text, o, notes);
        if (!bytes.length) notes.push({ level: 'err', msg: `${p.label}:没解析出任何字节` });
      }
    }
  }

  let marks = [];
  if (o.slip) { const r = slipUnframe(bytes, notes); bytes = r.bytes; marks = r.marks; }
  if (o.wordSwap) bytes = wordSwap(bytes, notes);

  /* 自描述容器头:认出来就按它说的办(宽高/CFA/位变换都不用猜)。
   * container:'off' 可以关掉 —— 万一哪天有文件恰好含这个魔数但结构不同。*/
  let container = null;
  if (o.container !== 'off') {
    container = parseContainer(bytes, notes);
    if (container) {
      bytes = container.bytes;
      marks = [];
      // 容器给的位变换优先于数据类型预设,但不覆盖用户显式选的那个
      if (container.pre.transform && !userSet.transform) {
        o = { ...o, transform: container.pre.transform };
        if (!userSet.transformPhase) o.transformPhase = container.pre.transformPhase;
      }
      /* 容器声明的字节数对不上(= 传输中丢了字节)时自动开重同步。
       * 敢自动开是因为这里有校验依据:头部给了 BYTES,我们能确认真的少了;
       * 而重同步本身只在填充位有稳定众数时才动手,否则会自行退回。
       * 没丢字节的文件不会走到这里,所以也不存在「好数据被乱修」的风险。*/
      if (o.resync == null && container.shortBy > 0) {
        o = { ...o, resync: true };
        notes.push({ level: 'info', msg: '已自动开启丢字节重同步(可在高级里关掉对比)' });
      }
      /* 把「到底丢了几个字节」传给重同步当对账依据:
       * 修补处数必须正好等于这个数,否则就是在误判,宁可不修。*/
      if (container.shortBy > 0) o = { ...o, expectDrops: container.shortBy };
    }
  }

  /* 位变换放在帧切分之前:相位判定要看整条流,而且
   * 「帧大小」这类参数用户是按变换后的像素数算的(2 字节/像素变成 2 字节/像素,
   * 长度不变,但相位会吃掉开头 1 字节,先切会让每帧各错一次)。*/
  const tid = o.transform || 'none';
  const tf = TRANSFORM[tid];
  if (!tf) notes.push({ level: 'err', msg: '未知位变换:' + tid });
  else if (tid !== 'none') {
    const before = bytes.length;
    const state = tf.prepare ? tf.prepare(bytes, o, notes) : null;
    bytes = tf.fn(bytes, o, notes, state);
    marks = [];      // 变换改变了字节与偏移的对应关系,SLIP 边界不再有效
    notes.push({ level: 'info', msg: `位变换:${tf.label} · ${before} B -> ${bytes.length} B` });
  }

  const frames = splitFrames(bytes, o.frames || {}, notes, marks);
  if (frames.length > 1) notes.push({ level: 'ok', msg: `切出 ${frames.length} 帧` });

  /* 解码侧建议,按「越具体越优先」叠:
   *   数据类型(最笼统) < 位变换输出布局 < 容器头(文件自己说的,最权威) */
  const decParts = [prof && prof.dec, tf && tf.dec, container && container.dec].filter(Boolean);
  const dec = decParts.length ? Object.assign({}, ...decParts) : null;

  return { frames, bytes, parser: parserId, transform: tid, dec,
           /* container 给 UI 展示用:kv 是头部原样字段,checksum/declared 是核验结论。
            * 保留 kv 原始字符串而不是解析后的数字 —— 显示时要如实呈现文件写了什么。*/
           container: container
             ? { kv: container.kv, checksum: container.checksum,
                 declared: container.declared, actual: container.bytes.length }
             : null,
           isText: lt.text, printable: lt.ratio,
           notes, candidates, inSize: input.length, outSize: bytes.length };
}

/** 前 n 字节的 hex 预览(UI 用,顺便能肉眼核对解析对不对) */
function hexPreview(bytes, n) {
  n = Math.min(n || 32, bytes.length);
  let s = '';
  for (let i = 0; i < n; i++) s += (i ? ' ' : '') + bytes[i].toString(16).padStart(2, '0').toUpperCase();
  return s + (bytes.length > n ? ' …' : '');
}

return { looksText, toText, cleanLines, PREFIX_RE, precount, detect, register,
         PARSERS, PARSER, parseHexdump, parse0x, parseEscaped, parseBase64,
         parseLooseHex, parseDecimal, parseCustom,
         slipUnframe, wordSwap, hexPattern, indexOfPat, splitFrames,
         CONTAINER_MAGIC, MAP_TO_TRANSFORM, findAscii, parseContainer,
         TRANSFORMS, TRANSFORM, registerTransform, pairStd, resolvePhase,
         PROFILES, PROFILE, registerProfile,
         preprocess, hexPreview };
});
