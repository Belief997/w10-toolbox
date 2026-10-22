/* pretest.js — preprocess.js 的回归测试
 *
 *     node pretest.js
 *
 * 思路:拿一段已知字节,编码成各种「串口工具可能吐出来的文本」,
 * 过一遍 preprocess 看能不能逐字节还原。自动识别也一起测 ——
 * 识别错了比解析错更难排查,所以每个用例都断言 parser 选对了。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./preprocess.js');
const D = require('./decoders.js');

let pass = 0, fail = 0;

function eq(a, b) {
  if (a.length !== b.length) return `长度 ${a.length} != ${b.length}`;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) return `第 ${i} 字节 ${a[i]} != ${b[i]}`;
  return null;
}

/** got/want 都给就逐字节比;want 为 null 则只看 extra 这条附加断言 */
function check(name, got, want, extra) {
  let bad = extra || null;
  if (!bad && want != null) bad = typeof got === 'string' ? got : eq(got, want);
  console.log(`  ${bad ? 'FAIL' : 'PASS'} ${name.padEnd(34)} ${bad || ''}`);
  bad ? fail++ : pass++;
}

/** 断言某条文本断言为真 */
function ok(name, cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name.padEnd(34)} ${cond ? '' : msg || ''}`);
  cond ? pass++ : fail++;
}

/* 测试数据:故意含 0x00 / 0xC0 / 0xDB(SLIP 的转义字符)和 0xFF */
const DATA = new Uint8Array(256);
for (let i = 0; i < 256; i++) DATA[i] = (i * 37 + 11) & 255;
const hx = b => Array.from(b, v => v.toString(16).padStart(2, '0'));

/* ---------------- 文本编码器(模拟各家工具的输出) ---------------- */

function asXxd(b, group = 2, perLine = 16) {       // xxd 默认 2 字节一组
  const out = [];
  for (let p = 0; p < b.length; p += perLine) {
    const row = b.subarray(p, p + perLine), h = hx(row);
    const groups = [];
    for (let i = 0; i < h.length; i += group) groups.push(h.slice(i, i + group).join(''));
    let ascii = '';
    for (const v of row) ascii += v >= 32 && v <= 126 ? String.fromCharCode(v) : '.';
    out.push(p.toString(16).padStart(8, '0') + ': ' +
             groups.join(' ').padEnd(perLine * 2 + perLine / group, ' ') + '  ' + ascii);
  }
  return out.join('\n') + '\n';
}

function asHexdumpC(b) {                            // hexdump -C:|ascii| 带竖线
  const out = [];
  for (let p = 0; p < b.length; p += 16) {
    const row = b.subarray(p, p + 16), h = hx(row);
    let ascii = '';
    for (const v of row) ascii += v >= 32 && v <= 126 ? String.fromCharCode(v) : '.';
    out.push(p.toString(16).padStart(8, '0') + '  ' +
             h.slice(0, 8).join(' ').padEnd(23) + '  ' + h.slice(8).join(' ').padEnd(23) +
             '  |' + ascii + '|');
  }
  return out.join('\n') + '\n';
}

function asOd(b) {                                  // od -A x -t x1 -v:地址无冒号
  const out = [];
  for (let p = 0; p < b.length; p += 16)
    out.push(p.toString(16).padStart(6, '0') + ' ' + hx(b.subarray(p, p + 16)).join(' '));
  return out.join('\n') + '\n';
}

function asTimestamped(b) {                         // 串口助手:时间戳 + TAG + hex
  const out = [];
  for (let p = 0; p < b.length; p += 16) {
    const t = `[   ${(12.3 + p / 160).toFixed(6)}] camera_dump: `;
    out.push(t + hx(b.subarray(p, p + 16)).join(' '));
  }
  return out.join('\n') + '\n';
}

function asLogcat(b) {                              // adb logcat:V/Tag(123):
  const out = [];
  for (let p = 0; p < b.length; p += 16)
    out.push(`2024-05-01 10:00:0${(p / 16) % 10}.123 V/CamDump(1234): ` +
             hx(b.subarray(p, p + 16)).join(' '));
  return out.join('\n') + '\n';
}

function asCArray(b) {
  const parts = Array.from(b, v => '0x' + v.toString(16).padStart(2, '0'));
  const lines = [];
  for (let i = 0; i < parts.length; i += 12) lines.push('    ' + parts.slice(i, i + 12).join(', ') + ',');
  return 'static const uint8_t frame[] = {\n' + lines.join('\n') + '\n};\n';
}

function asEscaped(b) {
  return "b'" + Array.from(b, v => '\\x' + v.toString(16).padStart(2, '0')).join('') + "'\n";
}

function asLoose(b) {
  const h = hx(b).join('');
  const lines = [];
  for (let i = 0; i < h.length; i += 64) lines.push(h.slice(i, i + 64));
  return lines.join('\n') + '\n';
}

function asB64(b) {
  const s = Buffer.from(b).toString('base64');
  const lines = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join('\n') + '\n';
}

function asDecimal(b) {
  const lines = [];
  const parts = Array.from(b, v => String(v));
  for (let i = 0; i < parts.length; i += 16) lines.push(parts.slice(i, i + 16).join(', '));
  return lines.join('\n') + '\n';
}

const enc = s => new Uint8Array(Buffer.from(s, 'latin1'));

/** 读 samples/ 下的文件;缺文件返回 null(样例是 make_samples.py 生成的,不进仓库) */
const sampleOf = n => {
  const p = path.join(__dirname, 'samples', n);
  return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
};

/* ---------------- 往返测试:编码 -> preprocess -> 应等于 DATA ---------------- */

console.log('往返还原(auto 识别 + 解析):');
for (const [name, text, wantParser] of [
  ['xxd(2 字节一组)',   asXxd(DATA, 2),  'hexdump'],
  ['xxd -g1',            asXxd(DATA, 1),  'hexdump'],
  ['xxd -g4',            asXxd(DATA, 4),  'hexdump'],
  ['hexdump -C',         asHexdumpC(DATA),'hexdump'],
  ['od -A x -t x1 -v',   asOd(DATA),      'hexdump'],
  ['dmesg 时间戳 + hex', asTimestamped(DATA), 'hexdump'],
  ['logcat 时间戳 + hex',asLogcat(DATA),  'hexdump'],
  ['C 数组 0x..',        asCArray(DATA),  'hex0x'],
  ['转义串 \\x..',       asEscaped(DATA), 'escaped'],
  ['松散 hex 流',        asLoose(DATA),   'hex'],
  ['base64',             asB64(DATA),     'base64'],
]) {
  const r = P.preprocess(enc(text), { parser: 'auto' });
  const bad = r.parser !== wantParser ? `识别成 ${r.parser},期望 ${wantParser}` : null;
  check(name, r.frames[0].bytes, DATA, bad);
}

// 十进制:和 hex 流天然歧义,只测显式指定时能还原
{
  const r = P.preprocess(enc(asDecimal(DATA)), { parser: 'dec' });
  check('十进制列表(显式指定)', r.frames[0].bytes, DATA);
}

/* ---------------- 二进制直通 ---------------- */
console.log('\n二进制直通:');
{
  const r = P.preprocess(DATA, { parser: 'auto' });
  check('含 NUL 的裸数据不被当文本', r.frames[0].bytes, DATA,
        r.parser !== 'none' ? `识别成 ${r.parser}` : null);
}
{
  // 真实样例:rgb565 dump 必须原样直通,一个字节都不能动
  const p = path.join(__dirname, 'samples', 'rgb565_640x480.raw');
  if (fs.existsSync(p)) {
    const raw = new Uint8Array(fs.readFileSync(p));
    const r = P.preprocess(raw, { parser: 'auto' });
    check('rgb565 样例直通', r.frames[0].bytes, raw, r.parser !== 'none' ? `识别成 ${r.parser}` : null);
  } else console.log('  SKIP rgb565 样例(缺文件)');
}

/* ---------------- 行清洗 ---------------- */
console.log('\n行清洗:');
{
  // 日志里混着无关行,keepRe 只留带 DUMP 标记的
  const noise = '启动完成\nI/Other: 无关日志 deadbeef\n';
  const lines = asTimestamped(DATA).trim().split('\n').map(l => l.replace('camera_dump', 'DUMP'));
  const mixed = noise + lines.join('\n' + noise) + '\n' + noise;
  const r = P.preprocess(enc(mixed), { parser: 'hexdump', keepRe: 'DUMP' });
  check('keepRe 过滤无关行', r.frames[0].bytes, DATA);
}
{
  const withBanner = '=== dump start ===\n' + asOd(DATA) + '=== dump end ===\n';
  const r = P.preprocess(enc(withBanner), { parser: 'hexdump', dropRe: '^===' });
  check('dropRe 丢掉横幅行', r.frames[0].bytes, DATA);
}
{
  // stripPrefix=off 时 dmesg 时间戳里的数字会污染松散 hex 解析 —— 反向验证前缀剥离确实在起作用
  const off = P.preprocess(enc(asTimestamped(DATA)), { parser: 'hex', stripPrefix: 'off' });
  const on  = P.preprocess(enc(asTimestamped(DATA)), { parser: 'hex' });
  ok('stripPrefix 默认剥 / off 不剥',
     eq(off.frames[0].bytes, DATA) !== null && eq(on.frames[0].bytes, DATA) === null,
     'off 应被时间戳污染,默认应还原成功');
}

/* ---------------- 字节修正 ---------------- */
console.log('\n字节修正:');
{
  const sw = new Uint8Array(DATA.length);
  for (let i = 0; i < DATA.length; i += 2) { sw[i] = DATA[i + 1]; sw[i + 1] = DATA[i]; }
  const r = P.preprocess(sw, { parser: 'none', wordSwap: true });
  check('16bit 字节交换可逆', r.frames[0].bytes, DATA);
}
{
  // 手工 SLIP 编帧:两帧,内容都是 DATA
  const esc = [];
  esc.push(0xC0);
  for (let f = 0; f < 2; f++) {
    for (const v of DATA) {
      if (v === 0xC0) esc.push(0xDB, 0xDC);
      else if (v === 0xDB) esc.push(0xDB, 0xDD);
      else esc.push(v);
    }
    esc.push(0xC0);
  }
  const r = P.preprocess(new Uint8Array(esc), { parser: 'none', slip: true, frames: { mode: 'slip' } });
  ok('SLIP 解帧 · 帧数 = 2', r.frames.length === 2, `切出 ${r.frames.length} 帧`);
  check('SLIP 解帧 · 帧 0', r.frames[0].bytes, DATA);
  check('SLIP 解帧 · 帧 1', r.frames[1].bytes, DATA);
}

/* ---------------- 帧切分 ---------------- */
console.log('\n帧切分:');
{
  const three = new Uint8Array(DATA.length * 3);
  for (let i = 0; i < 3; i++) three.set(DATA, i * DATA.length);
  const r = P.preprocess(three, { parser: 'none', frames: { mode: 'size', size: DATA.length } });
  check('按固定大小切 3 帧', r.frames[2].bytes, DATA,
        r.frames.length !== 3 ? `切出 ${r.frames.length} 帧` : null);
}
{
  // 魔数切分:两段 JPEG,中间夹噪声
  const j = new Uint8Array([0xFF, 0xD8, 0xFF, 1, 2, 3, 0xFF, 0xD9]);
  const buf = new Uint8Array([9, 9, ...j, 7, 7, 7, ...j, 5]);
  const r = P.preprocess(buf, { parser: 'none', frames: { mode: 'jpeg' } });
  check('JPEG 魔数切 2 帧', r.frames[1].bytes, j,
        r.frames.length !== 2 ? `切出 ${r.frames.length} 帧` : null);
  ok('JPEG 帧 0 偏移 = 2', r.frames[0].from === 2, `from=${r.frames[0].from}`);
}
{
  // 自定义起始魔数、无结束魔数:下一个起始即为上一帧结尾
  const buf = new Uint8Array([0xAA, 0x55, 1, 2, 0xAA, 0x55, 3, 4, 5]);
  const r = P.preprocess(buf, { parser: 'none', frames: { mode: 'magic', start: 'AA 55' } });
  check('自定义魔数切 2 帧', r.frames[1].bytes, new Uint8Array([0xAA, 0x55, 3, 4, 5]),
        r.frames.length !== 2 ? `切出 ${r.frames.length} 帧` : null);
}

/* ---------------- 自定义正则 ---------------- */
console.log('\n自定义正则:');
{
  const text = Array.from(DATA, v => `data=0x${v.toString(16).padStart(2, '0')};`).join('\n');
  const r = P.preprocess(enc(text), { parser: 'custom', customRe: 'data=0x([0-9a-f]{2})' });
  check('捕获组抽字节', r.frames[0].bytes, DATA);
}
{
  const r = P.preprocess(enc('abc'), { parser: 'custom', customRe: '([' });
  const hasErr = r.notes.some(n => n.level === 'err');
  check('非法正则给出错误提示', hasErr ? DATA : '没报错', DATA);
}
{
  // 零宽匹配不能死循环(能跑到这行就算过)
  const r = P.preprocess(enc('aaaa'), { parser: 'custom', customRe: 'x*' });
  ok('零宽匹配不卡死', r != null);
}

/* ---------------- 位变换:OV2640 RAW10(2 字节/像素) ---------------- */
console.log('\n位变换 · OV2640 RAW10:');

/** 把 10bit 值按「b0 = 高 8 位,b1 低 2 位 = 低 2 位」编码成 hex 文本 */
function ov2640Text(vals, { pad = 0, phase = 0, upper = true } = {}) {
  const bytes = [];
  for (let i = 0; i < phase; i++) bytes.push(0);
  for (const v of vals) {
    bytes.push((v >> 2) & 255);
    bytes.push((v & 3) | (pad << 2));          // 高 6 位是填充,必须被忽略
  }
  const h = bytes.map(b => b.toString(16).padStart(2, '0'));
  const s = (upper ? h.map(x => x.toUpperCase()) : h).join(' ');
  return s + '\n';
}

{
  // 用户给的那串:02 84 02 7E 02 7B 02 75 02 ...
  const r = P.preprocess(enc('02 84 02 7E 02 7B 02 75\n'),
                         { profile: 'ov2640_raw10_bggr', transformPhase: 0 });
  const b = r.frames[0].bytes;
  // (0x02<<2)|(0x84&3) = 8|0 = 8;(0x02<<2)|(0x7E&3) = 8|2 = 10
  const want = [8, 10, 11, 9];
  const got = [];
  for (let i = 0; i < b.length; i += 2) got.push(b[i] | (b[i + 1] << 8));
  ok('样例串位拼接正确', JSON.stringify(got) === JSON.stringify(want),
     `得到 ${JSON.stringify(got)},期望 ${JSON.stringify(want)}`);
  ok('输出长度 = 2 B/像素', b.length === 8, `${b.length} != 8`);
  ok('建议按 raw10u + BGGR 解',
     r.dec && r.dec.fmt === 'raw10u' && r.dec.cfa === 'bggr' && r.dec.msb === 'lsb',
     JSON.stringify(r.dec));
}
{
  // 覆盖整个 10bit range,且第二字节高 6 位塞满垃圾 —— 必须被忽略
  const vals = [];
  for (let i = 0; i < 1024; i++) vals.push(i);
  for (const pad of [0, 0x3F, 0x15]) {
    const r = P.preprocess(enc(ov2640Text(vals, { pad })),
                           { profile: 'ov2640_raw10_bggr', transformPhase: 0 });
    const b = r.frames[0].bytes;
    let bad = -1;
    for (let i = 0; i < 1024; i++) {
      const v = b[i * 2] | (b[i * 2 + 1] << 8);
      if (v !== i) { bad = i; break; }
    }
    ok(`全 10bit range 往返(填充 0x${pad.toString(16)})`, bad < 0,
       bad >= 0 ? `第 ${bad} 个像素错` : '');
  }
}
{
  // decoders.js 必须能把变换结果当 raw10u 解出原值(端到端验证布局约定)
  const W = 8, H = 4;
  const vals = [];
  for (let i = 0; i < W * H; i++) vals.push((i * 61) & 1023);
  const r = P.preprocess(enc(ov2640Text(vals)), { profile: 'ov2640_raw10_bggr', transformPhase: 0 });
  const plane = D.unpackBayer(r.frames[0].bytes, 'raw10u', W, H,
                              { stride: 0, bigEndian: false, msbAligned: false });
  let bad = -1;
  for (let i = 0; i < W * H; i++) if (plane[i] !== vals[i]) { bad = i; break; }
  ok('decoders 按 raw10u 解回原值', bad < 0, bad >= 0 ? `第 ${bad} 个:${plane[bad]} != ${vals[bad]}` : '');
}
{
  // 自动定相位:前面多一个字节时应判出 phase=1 并还原
  const vals = [];
  for (let i = 0; i < 2048; i++) vals.push((i * 137) & 1023);   // 伪随机,离散度足够
  const r = P.preprocess(enc(ov2640Text(vals, { phase: 1 })), { profile: 'ov2640_raw10_bggr' });
  const b = r.frames[0].bytes;
  let bad = -1;
  for (let i = 0; i < vals.length; i++) {
    const v = b[i * 2] | (b[i * 2 + 1] << 8);
    if (v !== vals[i]) { bad = i; break; }
  }
  ok('自动定相位(首字节多余)', bad < 0,
     bad >= 0 ? `第 ${bad} 个像素错,相位判定失败` : '');
}
{
  // 反字节序变体:低位字节在前
  const vals = [100, 1000, 511, 3];
  const bytes = [];
  for (const v of vals) { bytes.push(v & 3); bytes.push((v >> 2) & 255); }
  const txt = bytes.map(b => b.toString(16).padStart(2, '0')).join(' ') + '\n';
  const r = P.preprocess(enc(txt), { parser: 'hex', transform: 'raw10_lo2hi8', transformPhase: 0 });
  const b = r.frames[0].bytes;
  const got = [];
  for (let i = 0; i < b.length; i += 2) got.push(b[i] | (b[i + 1] << 8));
  ok('raw10_lo2hi8 变体', JSON.stringify(got) === JSON.stringify(vals), JSON.stringify(got));
}
{
  // 带时间戳 + 逗号分隔的真实感日志
  const vals = [];
  for (let i = 0; i < 64; i++) vals.push((i * 97) & 1023);
  const hexBytes = [];
  for (const v of vals) { hexBytes.push((v >> 2) & 255); hexBytes.push(v & 3); }
  const lines = [];
  for (let i = 0; i < hexBytes.length; i += 16)
    lines.push(`[   1.${String(i).padStart(6, '0')}] cam: ` +
               hexBytes.slice(i, i + 16).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' '));
  const r = P.preprocess(enc(lines.join('\n') + '\n'),
                         { profile: 'ov2640_raw10_bggr', transformPhase: 0 });
  const b = r.frames[0].bytes;
  let bad = -1;
  for (let i = 0; i < vals.length; i++) {
    const v = b[i * 2] | (b[i * 2 + 1] << 8);
    if (v !== vals[i]) { bad = i; break; }
  }
  ok('带时间戳日志 + OV2640 变换', bad < 0, bad >= 0 ? `第 ${bad} 个像素错` : '');
}
{
  // 奇数字节:末尾半个像素应被丢弃并给出提示,不能崩
  const r = P.preprocess(enc('02 84 02\n'), { profile: 'ov2640_raw10_bggr', transformPhase: 0 });
  ok('奇数字节不崩 + 有提示',
     r.frames[0].bytes.length === 2 && r.notes.some(n => /不成对/.test(n.msg)),
     `${r.frames[0].bytes.length} B`);
}
{
  // 数据类型里的选项只是默认值,显式选项要能盖掉
  const r = P.preprocess(enc('02 84 02 7E\n'),
                         { profile: 'ov2640_raw10_bggr', transform: 'none' });
  ok('显式选项覆盖数据类型', r.transform === 'none', `transform=${r.transform}`);
}
{
  const r = P.preprocess(enc('02 84\n'), { profile: '不存在的类型' });
  ok('未知数据类型报错', r.notes.some(n => n.level === 'err'));
}

/* ---------------- 自描述容器 $RAW10BEGIN ---------------- */
console.log('\n自描述容器 $RAW10BEGIN:');

/* 造一个容器:ASCII 头 + 定长二进制 + ASCII 尾。
 * raw() 给纯二进制(规范里串口直出的样子),默认再整体转 hex 文本
 * (串口工具「十六进制显示」抓下来的样子,data/01.dat 就是这种)。
 * 两种载体必须解出同一结果,所以多数用例两边都跑。 */
function buildContainer(vals, { w, h, map = 'ROR2', bayer = 'BGGR', bits = 10, bpp = 2,
                                endian = 'LE', dropAt = [], badChecksum = false,
                                noEnd = false, bytesOverride = null, banner = true } = {}) {
  const data = [];
  for (const v of vals) {
    // 按 MAP=ROR2 存:真值循环右移 2 位,再按 endian 落到两个字节
    const stored = ((v >> 2) | ((v & 3) << 8)) & 0x3FF;
    const hi8 = stored & 0xFF, lo2 = stored >> 8;
    if (endian === 'BE') data.push(lo2, hi8); else data.push(hi8, lo2);
  }
  // 模拟串口丢字节:从后往前删,避免下标漂移
  for (const i of [...dropAt].sort((a, b) => b - a)) data.splice(i, 1);
  let sum = 0;
  for (const v of data) sum += v;
  if (badChecksum) sum += 7;
  const declared = bytesOverride != null ? bytesOverride : vals.length * 2;
  const hdr = (banner ? '[RAW] dumping frame #1 ...\r\n' : '') +
              `$RAW10BEGIN\r\nWIDTH=${w}\r\nHEIGHT=${h}\r\n` +
              `BYTES=${declared}\r\nBPP=${bpp}\r\nENDIAN=${endian}\r\nBITS=${bits}\r\nMAP=${map}\r\n` +
              `BAYER=${bayer}\r\nCHECKSUM=${sum}\r\nFRAME=1\r\nDATA\r\n`;
  const all = [...Buffer.from(hdr, 'latin1'), ...data];
  if (!noEnd) all.push(...Buffer.from('\r\n$RAW10END\r\n[RAW] dump done\r\n', 'latin1'));
  return new Uint8Array(all);
}

/** 把字节流转成串口工具那种 "35 02 1E 02" 的十六进制文本 */
const hexify = b =>
  enc(Array.from(b, v => v.toString(16).padStart(2, '0').toUpperCase()).join(' ') + '\n');

/** 默认用 hex 文本载体(与原有用例保持一致) */
const makeContainer = (vals, o) => hexify(buildContainer(vals, o));

/** 容器字节流里数据区的起始下标(DATA\r\n 之后) */
function findDataStart(b) {
  const s = Buffer.from(b).toString('latin1');
  const i = s.indexOf('DATA\r\n');
  if (i < 0) throw new Error('测试辅助:没找到 DATA 行');
  return i + 6;
}

/** 改写头部的 CHECKSUM= 为给定值,长度不变时原地改,变了就重拼 */
function patchChecksum(b, sum) {
  const s = Buffer.from(b).toString('latin1');
  const m = s.match(/CHECKSUM=(\d+)\r\n/);
  if (!m) throw new Error('测试辅助:没找到 CHECKSUM 行');
  const head = s.slice(0, m.index);
  const tail = s.slice(m.index + m[0].length);
  return new Uint8Array(Buffer.from(head + `CHECKSUM=${sum}\r\n` + tail, 'latin1'));
}

/** 从预处理结果里取回 16bit LE 的像素序列 */
function pixelsOf(r, n) {
  const b = r.frames[0].bytes, out = [];
  const lim = n != null ? Math.min(n, b.length >> 1) : b.length >> 1;
  for (let i = 0; i < lim; i++) out.push(b[i * 2] | (b[i * 2 + 1] << 8));
  return out;
}

{
  const W = 16, H = 8, vals = [];
  for (let i = 0; i < W * H; i++) vals.push((i * 13) & 1023);
  const r = P.preprocess(makeContainer(vals, { w: W, h: H }), { profile: 'auto' });
  ok('认出容器头', r.container != null && r.container.kv.MAP === 'ROR2',
     JSON.stringify(r.container));
  ok('容器结果带校验结论', r.container.checksum != null && r.container.checksum.ok === true,
     JSON.stringify(r.container.checksum));
  ok('宽高从头部读出', r.dec.width === W && r.dec.height === H, JSON.stringify(r.dec));
  ok('CFA 从 BAYER= 读出', r.dec.cfa === 'bggr', r.dec.cfa);
  ok('MAP=ROR2 自动选上位变换', r.transform === 'raw10_hi8lo2', r.transform);
  ok('BITS=10 映射到 raw10u', r.dec.fmt === 'raw10u', r.dec.fmt);
  ok('校验和吻合', r.notes.some(n => n.level === 'ok' && /校验和吻合/.test(n.msg)),
     r.notes.map(n => n.msg).join(' | '));
  // 像素值应逐个还原
  const b = r.frames[0].bytes;
  let bad = -1;
  for (let i = 0; i < vals.length; i++) {
    const v = b[i * 2] | (b[i * 2 + 1] << 8);
    if (v !== vals[i]) { bad = i; break; }
  }
  ok('容器内像素逐个还原', bad < 0, bad >= 0 ? `第 ${bad} 个错` : '');
}
{
  const vals = [];
  for (let i = 0; i < 128; i++) vals.push((i * 13) & 1023);
  const r = P.preprocess(makeContainer(vals, { w: 16, h: 8, badChecksum: true }), { profile: 'auto' });
  ok('校验和不符时报错', r.notes.some(n => n.level === 'err' && /校验和不符/.test(n.msg)));
}
{
  const vals = [];
  for (let i = 0; i < 128; i++) vals.push((i * 13) & 1023);
  const r = P.preprocess(makeContainer(vals, { w: 16, h: 8, noEnd: true }), { profile: 'auto' });
  ok('缺 $RAW10END 时按 BYTES 截取并提示',
     r.outSize === 256 && r.notes.some(n => /没找到 \$RAW10END/.test(n.msg)),
     `out=${r.outSize}`);
}
{
  // MAP=NONE:不该套位变换
  const vals = [];
  for (let i = 0; i < 128; i++) vals.push((i * 13) & 1023);
  const r = P.preprocess(makeContainer(vals, { w: 16, h: 8, map: 'NONE' }), { profile: 'auto' });
  ok('MAP=NONE 不做位变换', r.transform === 'none', r.transform);
}
{
  // 用户显式选的位变换不该被容器头盖掉
  const vals = [];
  for (let i = 0; i < 128; i++) vals.push((i * 13) & 1023);
  const r = P.preprocess(makeContainer(vals, { w: 16, h: 8 }),
                         { profile: 'auto', transform: 'none' });
  ok('显式 transform 不被容器覆盖', r.transform === 'none', r.transform);
}
{
  // container:'off' 关掉容器识别
  const vals = [];
  for (let i = 0; i < 128; i++) vals.push((i * 13) & 1023);
  const r = P.preprocess(makeContainer(vals, { w: 16, h: 8 }),
                         { profile: 'auto', container: 'off' });
  ok('container=off 不识别容器', r.container == null && r.dec == null,
     `container=${!!r.container} dec=${JSON.stringify(r.dec)}`);
}
{
  /* auto / hextext 数据类型不能写死 transform:'none'。
   * 写死的话容器头里的 MAP= 会被当成「用户已显式选 none」而挡掉,
   * 结果自动档认得比手动档少 —— 这个坑踩过一次,钉在这里。*/
  for (const id of ['auto', 'hextext']) {
    ok(`数据类型 ${id} 不写死 transform`, P.PROFILE[id].pre.transform == null,
       `pre.transform=${P.PROFILE[id].pre.transform}`);
  }
  const vals = [];
  for (let i = 0; i < 128; i++) vals.push((i * 13) & 1023);
  const c = makeContainer(vals, { w: 16, h: 8 });
  for (const id of ['auto', 'hextext', 'raw10_container']) {
    const r = P.preprocess(c, { profile: id });
    ok(`${id} 档下容器 MAP= 能生效`, r.transform === 'raw10_hi8lo2', r.transform);
  }
}

/* ---- 规范用例:纯二进制载体 + 定长读取 ---- */
console.log('\n容器 · 纯二进制载体与定长读取:');
{
  const W = 40, H = 30, N = W * H;
  const truth = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    truth.push((512 + Math.round(400 * Math.sin(x / 6)) + y * 3) & 1023);

  // 同一帧的两种载体必须解出完全相同的结果
  const bin = buildContainer(truth, { w: W, h: H });
  const rb = P.preprocess(bin, { profile: 'auto' });
  const rh = P.preprocess(hexify(bin), { profile: 'auto' });
  ok('纯二进制载体:parser 走直通', rb.parser === 'none', rb.parser);
  ok('hex 文本载体:parser 走 hex', rh.parser === 'hex', rh.parser);
  ok('两种载体字节完全一致', eq(rb.frames[0].bytes, rh.frames[0].bytes) === null,
     eq(rb.frames[0].bytes, rh.frames[0].bytes));
  ok('ROR2 还原出真值', JSON.stringify(pixelsOf(rb, N)) === JSON.stringify(truth),
     '首个不符处: ' + pixelsOf(rb, N).findIndex((v, i) => v !== truth[i]));
  ok('校验和吻合', rb.notes.some(n => n.level === 'ok' && /校验和吻合/.test(n.msg)));
  ok('WIDTH×HEIGHT×BPP 与 BYTES 一致(无告警)',
     !rb.notes.some(n => /不一致/.test(n.msg)));

  /* 定长读取的关键:数据区里出现 0D 0A 不能被当成行边界。
   * 这里把数据区最后两个字节强制改成 0D 0A,再看是否仍取满 BYTES。*/
  {
    const b = buildContainer(truth, { w: W, h: H });
    const di = findDataStart(b);
    b[di + N * 2 - 2] = 0x0D; b[di + N * 2 - 1] = 0x0A;
    // 校验和要跟着改
    let sum = 0;
    for (let i = di; i < di + N * 2; i++) sum += b[i];
    const fixed = patchChecksum(b, sum);
    const r = P.preprocess(fixed, { profile: 'auto' });
    ok('数据区末尾是 0D 0A 时仍取满 BYTES', r.outSize === N * 2, `${r.outSize} != ${N * 2}`);
    ok('  且校验和吻合', r.notes.some(n => /校验和吻合/.test(n.msg)),
       r.notes.filter(n => /校验和/.test(n.msg)).map(n => n.msg).join(''));
  }

  /* 数据区里出现 "$RAW10END" 字节序列也不能提前截断 ——
   * 前后文约束(必须被 \r\n 夹住)就是为这个加的。*/
  {
    const b = buildContainer(truth, { w: W, h: H });
    const di = findDataStart(b);
    const fake = Buffer.from('$RAW10END', 'ascii');
    b.set(fake, di + 200);                       // 塞在数据区中间,前后不是 \r\n
    let sum = 0;
    for (let i = di; i < di + N * 2; i++) sum += b[i];
    const r = P.preprocess(patchChecksum(b, sum), { profile: 'auto' });
    ok('数据区内含 $RAW10END 不被提前截断', r.outSize === N * 2, `${r.outSize} != ${N * 2}`);
  }

  // ENDIAN=BE:同一 MAP 应选到反向的字节配对
  {
    const r = P.preprocess(buildContainer(truth, { w: W, h: H, endian: 'BE' }), { profile: 'auto' });
    ok('ENDIAN=BE 选到 lo2hi8 变换', r.transform === 'raw10_lo2hi8', r.transform);
    ok('  BE 下同样还原真值', JSON.stringify(pixelsOf(r, N)) === JSON.stringify(truth),
       '首个不符: ' + pixelsOf(r, N).findIndex((v, i) => v !== truth[i]));
  }

  // BPP 不是 2 时不硬套位变换
  {
    const r = P.preprocess(buildContainer(truth, { w: W, h: H, bpp: 1, bytesOverride: N * 2 }),
                           { profile: 'auto' });
    ok('BPP≠2 时跳过位变换并告警',
       r.transform === 'none' && r.notes.some(n => /需要 BPP=2/.test(n.msg)), r.transform);
  }

  // 截断:尾标记落在声明长度之前 -> 按标记定界,并报出少了多少
  {
    const r = P.preprocess(buildContainer(truth, { w: W, h: H, dropAt: [100, 300, 500] }),
                           { profile: 'auto' });
    ok('丢字节时按尾标记修正长度', r.outSize === N * 2 - 3 || r.outSize === N * 2 - 4,
       `out=${r.outSize}, 期望 ${N * 2 - 3}`);
    ok('  报出少了 3 字节', r.notes.some(n => /少 3 B/.test(n.msg)),
       r.notes.filter(n => /声明/.test(n.msg)).map(n => n.msg).join(''));
    ok('  修正后校验和吻合(证明边界取对了)',
       r.notes.some(n => /校验和吻合/.test(n.msg)),
       r.notes.filter(n => /校验和/.test(n.msg)).map(n => n.msg).join(''));
  }
}

/* ---------------- 丢字节重同步 ---------------- */
console.log('\n丢字节重同步:');
{
  const W = 32, H = 16, N = W * H;
  /* 造一幅行间平滑的图:重同步对/错,用「相邻行差」能量一眼区分。
   * 低 2 位固定为 2 —— 实测文件(data/01.dat)的第二字节恒为 0x02,
   * 即这条链路上低 2 位并不承载有效数据。重同步正是靠这个恒定值当同步标志,
   * 所以测试数据必须复现这个特征,否则测的就不是真实场景。*/
  const vals = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    vals.push((((512 + Math.round(200 * Math.sin(x / 5)) + y * 10) & 1023) & ~3) | 2);

  const rowDiff = plane => {
    let s = 0, n = 0;
    for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) {
      s += Math.abs(plane[y * W + x] - plane[(y - 1) * W + x]); n++;
    }
    return s / n;
  };
  const planeOf = r => {
    let b = r.frames[0].bytes;
    const need = N * 2;
    if (b.length < need) { const p = new Uint8Array(need); p.set(b); b = p; }
    return D.unpackBayer(b, 'raw10u', W, H, { stride: 0, bigEndian: false, msbAligned: false });
  };

  // 完好文件:重同步不该改变任何东西
  const clean = makeContainer(vals, { w: W, h: H });
  const a = P.preprocess(clean, { profile: 'auto', resync: false });
  const bb = P.preprocess(clean, { profile: 'auto', resync: true });
  ok('完好文件:开重同步结果不变', eq(a.frames[0].bytes, bb.frames[0].bytes) === null,
     eq(a.frames[0].bytes, bb.frames[0].bytes));
  ok('完好文件:报告未发现丢字节', bb.notes.some(n => /未发现丢字节/.test(n.msg)));

  // 丢 3 个字节:不修则后面全错位,修了应恢复
  const broken = makeContainer(vals, { w: W, h: H, dropAt: [100, 400, 700] });
  const off = P.preprocess(broken, { profile: 'auto', resync: false });
  const on = P.preprocess(broken, { profile: 'auto', resync: true });
  const dOff = rowDiff(planeOf(off)), dOn = rowDiff(planeOf(on));
  ok(`重同步显著改善行连续性 (${dOff.toFixed(1)} -> ${dOn.toFixed(1)})`, dOn < dOff / 2,
     '改善不足 2 倍');
  ok('重同步报告修补处数', on.notes.some(n => /修补 3 处/.test(n.msg)),
     on.notes.filter(n => /重同步/.test(n.msg)).map(n => n.msg).join(' | '));
  ok('字节数不足时自动开重同步',
     P.preprocess(broken, { profile: 'auto' }).notes.some(n => /自动开启丢字节重同步/.test(n.msg)));

  // 填充位不是常数时应放弃重同步(避免把好数据改坏)
  const noisy = [];
  for (let i = 0; i < N; i++) noisy.push(i & 1023);     // 低 2 位在变 -> 填充字节无众数
  const rn = P.preprocess(makeContainer(noisy, { w: W, h: H }), { profile: 'auto', resync: true });
  const didFix = rn.notes.some(n => /修补 \d+ 处/.test(n.msg));
  ok('填充位不是常数时放弃重同步', !didFix,
     rn.notes.filter(n => /重同步/.test(n.msg)).map(n => n.msg).join(' | '));

  /* 自检必须拦住「越修越糟」。
   * 低 2 位真的在变(0..3 均匀)+ 丢字节,是最危险的组合:
   * 众数只有 ~37%,若放进去硬修会凭空造出上百处假修补。
   * 这一条是实测回归 —— 门槛从 0.3 放到 0.45 之前,PSNR 从 13.8 掉到 5.1。*/
  const noisyBroken = makeContainer(noisy, { w: W, h: H, dropAt: [200, 500, 800] });
  const rb2 = P.preprocess(noisyBroken, { profile: 'auto', resync: true });
  const fixCount = (rb2.notes.map(n => n.msg).join(' ').match(/修补 (\d+) 处/) || [])[1];
  ok('低 2 位承载数据 + 丢字节:拒绝修补而非乱修', fixCount == null,
     `声称修补了 ${fixCount} 处`);
  ok('  并说明放弃原因', rb2.notes.some(n => /按原样配对/.test(n.msg)),
     rb2.notes.filter(n => /重同步/.test(n.msg)).map(n => n.msg).join(' | '));

  /* 修补处数要与容器头声明的缺失字节数对账。
   * 人为把 BYTES 说大(声明少了 50 字节,实际只丢 3 个)时,
   * 数不上就该放弃 —— 否则等于拿一个没验证过的猜测去改像素。*/
  {
    const good = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
      good.push((((512 + Math.round(200 * Math.sin(x / 5)) + y * 10) & 1023) & ~3) | 2);
    const r2 = P.preprocess(
      makeContainer(good, { w: W, h: H, dropAt: [300, 600, 900], bytesOverride: N * 2 + 47 }),
      { profile: 'auto', resync: true });
    ok('修补数与声明缺失数对不上时放弃',
       !/修补 \d+ 处/.test(r2.notes.map(n => n.msg).join(' ')),
       r2.notes.filter(n => /重同步/.test(n.msg)).map(n => n.msg).join(' | '));
  }
  // 对得上时要明确说出来(让用户知道这次修补是有据可依的)
  {
    const good = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
      good.push((((512 + Math.round(200 * Math.sin(x / 5)) + y * 10) & 1023) & ~3) | 2);
    const r3 = P.preprocess(makeContainer(good, { w: W, h: H, dropAt: [300, 600, 900] }),
                            { profile: 'auto', resync: true });
    ok('修补数与声明吻合时予以说明',
       /与文件头声明的 3 字节吻合/.test(r3.notes.map(n => n.msg).join(' ')),
       r3.notes.filter(n => /重同步/.test(n.msg)).map(n => n.msg).join(' | '));
  }
}

/* ---- make_samples.py 的容器样例:有 ground truth,能量化重同步到底有没有帮倒忙 ---- */
console.log('\n容器样例端到端(对比 reference.rgb):');
{
  const W2 = 640, H2 = 480;
  const ref = sampleOf('reference.rgb');
  const psnrOf = bytes => {
    let b = bytes;
    const need = W2 * H2 * 2;
    if (b.length < need) { const p = new Uint8Array(need); p.set(b); b = p; }
    const d = D.decodeFrame(b, 'raw10u', W2, H2,
      { cfa: 'bggr', blackLevel: 0, whiteLevel: 1023, gamma: 1, autoLevel: false }).data;
    let se = 0, n = 0;
    for (let y = 2; y < 390; y++) for (let x = 2; x < W2 - 2; x++) {
      const i = (y * W2 + x) * 3, q = (y * W2 + x) * 4;
      for (let k = 0; k < 3; k++) { const e = d[q + k] - ref[i + k]; se += e * e; n++; }
    }
    return 10 * Math.log10(255 * 255 / (se / n));
  };

  const clean = sampleOf('raw10c_bggr_640x480.bin');
  const cleanHex = sampleOf('raw10c_bggr_hex_640x480.txt');
  const lost = sampleOf('raw10c_bggr_lost12_640x480.bin');
  if (!ref || !clean || !cleanHex || !lost) {
    console.log('  SKIP 容器样例(先跑 make_samples.py)');
  } else {
    const a = P.preprocess(clean, { profile: 'auto' });
    const b = P.preprocess(cleanHex, { profile: 'auto' });
    ok('纯二进制与 hex 文本载体逐位相同',
       eq(a.frames[0].bytes, b.frames[0].bytes) === null,
       eq(a.frames[0].bytes, b.frames[0].bytes));
    const pc = psnrOf(a.frames[0].bytes);
    ok(`完好样例 PSNR ${pc.toFixed(2)} 达到 RAW 基线`, pc >= 28, '低于 28');
    ok('完好样例校验和吻合', a.container.checksum.ok);

    // 丢字节样例:重同步不许让画面更差(这正是自检要防的事)
    const pOff = psnrOf(P.preprocess(lost, { profile: 'auto', resync: false }).frames[0].bytes);
    const pOn = psnrOf(P.preprocess(lost, { profile: 'auto', resync: true }).frames[0].bytes);
    ok(`丢字节样例:重同步未帮倒忙 (off ${pOff.toFixed(2)} / on ${pOn.toFixed(2)})`,
       pOn >= pOff - 0.01, `开了反而掉 ${(pOff - pOn).toFixed(2)} dB`);
    ok('丢字节样例被校验和抓到',
       P.preprocess(lost, { profile: 'auto' }).container.checksum.ok === false);
  }
}

/* ---------------- 真实样例端到端:文本化 -> 预处理 -> 解码 ---------------- */
console.log('\n端到端(hexdump 化的样例应与原样例解码一致):');
const sample = sampleOf;      // 同一个读样例助手,保留旧名字免得下面全改

{
  const raw = sample('rgb565_640x480.raw');
  if (raw) {
    const r = P.preprocess(enc(asXxd(raw, 2)), { parser: 'auto' });
    const e = eq(r.frames[0].bytes, raw);
    if (e) check('xxd 化后字节还原', e, raw);
    else {
      const a = D.decodeFrame(raw, 'rgb565', 640, 480, {}).data;
      const b = D.decodeFrame(r.frames[0].bytes, 'rgb565', 640, 480, {}).data;
      check('xxd 化后解码逐位相同', b, a);
    }
  } else console.log('  SKIP(缺 rgb565 样例)');
}
{
  // make_samples.py 生成的 xxd 文本样例(真·外部产物,不是本文件自己造的)
  const raw = sample('rgb565_640x480.raw'), txt = sample('rgb565_xxd_640x480.txt');
  if (raw && txt) check('rgb565_xxd 样例还原', P.preprocess(txt, { parser: 'auto' }).frames[0].bytes, raw);
  else console.log('  SKIP rgb565_xxd 样例(缺文件 —— 先跑 make_samples.py)');
}

/* OV2640 三种载体(裸二进制 / hex 文本 / 带时间戳日志)必须解出同一幅图,
 * 并且与 reference.rgb 的差距落在 RAW 去马赛克的理论容差内
 * (阈值与 selftest.js 的 RAW 用例同源:平坦区 maxErr<=180、PSNR>=28)。*/
console.log('\n端到端 · OV2640 RAW10 三种载体:');
{
  const W = 640, H = 480;
  const ref = sample('reference.rgb');
  const files = ['ov2640_raw10_bggr_640x480.bin',
                 'ov2640_raw10_bggr_640x480.hex.txt',
                 'ov2640_raw10_bggr_log_640x480.txt'];
  const got = files.map(sample);
  if (!ref || got.some(x => !x)) {
    console.log('  SKIP OV2640 样例(缺文件 —— 先跑 make_samples.py)');
  } else {
    const decoded = [];
    got.forEach((raw, i) => {
      const r = P.preprocess(raw, { profile: 'ov2640_raw10_bggr' });
      const need = D.expectedBytes('raw10u', W, H, 0);
      if (r.outSize !== need) {
        check(files[i], `预处理出 ${r.outSize} B,期望 ${need} B`, new Uint8Array(0));
        return;
      }
      const d = D.decodeFrame(r.frames[0].bytes, 'raw10u', W, H,
        { cfa: 'bggr', blackLevel: 0, whiteLevel: 1023, gamma: 1, autoLevel: false }).data;
      decoded.push(d);
      // 与参考图比(跳过最外 2 圈和底部细纹区,同 selftest.js 的 RAW 口径)
      let se = 0, n = 0, mx = 0;
      for (let y = 2; y < 390; y++) for (let x = 2; x < W - 2; x++) {
        const q = (y * W + x) * 4, p = (y * W + x) * 3;
        for (let k = 0; k < 3; k++) {
          const e = d[q + k] - ref[p + k];
          se += e * e; n++;
          if (Math.abs(e) > mx) mx = Math.abs(e);
        }
      }
      const psnr = 10 * Math.log10(255 * 255 / (se / n));
      ok(`${files[i].replace('ov2640_raw10_bggr', '')} PSNR ${psnr.toFixed(2)}/maxErr ${mx}`,
         mx <= 180 && psnr >= 28, `超出 RAW 容差(maxErr<=180, PSNR>=28)`);
    });
    if (decoded.length === 3) {
      ok('hex 文本 与 裸二进制 逐位相同', eq(decoded[0], decoded[1]) === null, eq(decoded[0], decoded[1]));
      ok('带时间戳日志 与 裸二进制 逐位相同', eq(decoded[0], decoded[2]) === null, eq(decoded[0], decoded[2]));
    }
  }
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
