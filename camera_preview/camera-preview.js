/* camera-preview.js — 查看器 UI
 * 解码逻辑全在 decoders.js,文件预处理全在 preprocess.js
 * (两者各有 selftest.js / pretest.js 做回归),这里只管:
 * 读文件 / 收集参数 / 画到 canvas / 缩放平移 / 取色 / 直方图 / 导出。
 */
'use strict';
const D = window.CamDec;
const P = window.CamPre;

const $ = id => document.getElementById(id);
const el = {
  stage: $('stage'), cv: $('cv'), hud: $('hud'), loupe: $('loupe'),
  file: $('file'), pick: $('pick'), fileInfo: $('fileInfo'), fileList: $('fileList'),
  profile: $('profile'), profileHint: $('profileHint'), preAdv: $('preAdv'),
  preMore: $('preMore'), preReset: $('preReset'), preInfo: $('preInfo'),
  parser: $('parser'), parserHint: $('parserHint'),
  customRe: $('customRe'), rowCustomRe: $('rowCustomRe'),
  transform: $('transform'), transformHint: $('transformHint'),
  transformPhase: $('transformPhase'), rowPhase: $('rowPhase'),
  stripPrefix: $('stripPrefix'), keepRe: $('keepRe'), dropRe: $('dropRe'),
  slipBtn: $('slipBtn'), swapBtn: $('swapBtn'), resyncBtn: $('resyncBtn'),
  hdrBox: $('hdrBox'), hdrTable: $('hdrTable'), hdrExtra: $('hdrExtra'),
  frameMode: $('frameMode'), frameSize: $('frameSize'), frameFromFmt: $('frameFromFmt'),
  frameStart: $('frameStart'), frameEnd: $('frameEnd'),
  rowFrameSize: $('rowFrameSize'), rowFrameStart: $('rowFrameStart'), rowFrameEnd: $('rowFrameEnd'),
  fmt: $('fmt'), fmtHint: $('fmtHint'),
  preset: $('preset'), w: $('w'), h: $('h'), stride: $('stride'),
  alignBtn: $('alignBtn'), guessBtn: $('guessBtn'), swapWH: $('swapWH'),
  guesses: $('guesses'), sizeInfo: $('sizeInfo'),
  range: $('range'), matrix: $('matrix'),
  cfa: $('cfa'), blackLevel: $('blackLevel'), whiteLevel: $('whiteLevel'),
  autoLevel: $('autoLevel'), gamma: $('gamma'), gammaV: $('gammaV'),
  gainR: $('gainR'), gainG: $('gainG'), gainB: $('gainB'),
  gainRV: $('gainRV'), gainGV: $('gainGV'), gainBV: $('gainBV'),
  awb: $('awb'), resetRaw: $('resetRaw'),
  endian: $('endian'), msb: $('msb'), rowEndian: $('rowEndian'), rowMsb: $('rowMsb'),
  knobYUV: $('knobYUV'), knobRAW: $('knobRAW'), knobByte: $('knobByte'),
  offset: $('offset'), histo: $('histo'), statInfo: $('statInfo'),
  savePng: $('savePng'), copyImg: $('copyImg'), exportHint: $('exportHint'),
};

const ctx = el.cv.getContext('2d', { willReadFrequently: true });
const loupeCtx = el.loupe.firstElementChild.getContext('2d');

/* ------------------------------ 状态 ------------------------------ */
const S = {
  files: [],          // { name, raw, bytes, frames, pre } —— raw 是文件原始字节,bytes 是预处理后的
  cur: -1,
  frame: 0,           // 预处理切出多帧时的当前帧
  img: null,          // 当前解码出的 ImageData
  zoom: 1, panX: 0, panY: 0, fitted: true,
  channel: 'all',     // all | r | g | b | y
  flipH: false, flipV: false,
  grid: false, loupeOn: false,
  lastStats: null,
  slip: false, wordSwap: false,
  /* 重同步是三态:null = 交给预处理自己判断(容器声明的字节数对不上就开),
   * true/false = 用户在按钮上明确表过态,此后不再自动改。
   * 不这么分的话,UI 每次都会传一个显式 false 过去,自动开启的逻辑永远不触发。*/
  resync: null,
  profileFromName: false,   // 当前数据类型是否由文件名自动套上(决定要不要自动撤回)
};

/* ------------------------ 下拉框初始化 ------------------------ */

// 格式:按 group 分组
{
  const groups = {};
  for (const f of D.FORMATS) (groups[f.group] = groups[f.group] || []).push(f);
  for (const [g, list] of Object.entries(groups)) {
    const og = document.createElement('optgroup');
    og.label = g;
    for (const f of list) {
      const o = document.createElement('option');
      o.value = f.id; o.textContent = f.label;
      og.appendChild(o);
    }
    el.fmt.appendChild(og);
  }
  el.fmt.value = 'rgb565';
}

// 尺寸预设
{
  const o0 = document.createElement('option');
  o0.value = ''; o0.textContent = '— 自定义 —';
  el.preset.appendChild(o0);
  for (const [w, h] of D.COMMON_SIZES) {
    const o = document.createElement('option');
    o.value = w + 'x' + h;
    const r = w / h;
    // 标注常见叫法,方便按分辨率名找
    const name = { '640x480': 'VGA', '320x240': 'QVGA', '176x144': 'QCIF', '352x288': 'CIF',
                   '800x600': 'SVGA', '1024x768': 'XGA', '1280x720': '720p', '1920x1080': '1080p',
                   '2560x1440': '1440p', '3840x2160': '4K UHD', '4096x2160': '4K DCI',
                   '1280x960': '1.2MP', '2592x1944': '5MP', '3264x2448': '8MP',
                   '4032x3024': '12MP', '4208x3120': '13MP', '8000x6000': '48MP' }[w + 'x' + h];
    o.textContent = `${w} × ${h}` + (name ? `  (${name})` : '') +
                    `  ${r === 1 ? '1:1' : Math.abs(r - 16 / 9) < .01 ? '16:9' :
                        Math.abs(r - 4 / 3) < .01 ? '4:3' : Math.abs(r - 3 / 2) < .01 ? '3:2' : ''}`;
    el.preset.appendChild(o);
  }
}

// 预处理:数据类型 / 文本解析器 / 位变换
{
  const fill = (sel, list, extra) => {
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      sel.appendChild(o);
    }
    if (extra) {
      const o = document.createElement('option');
      o.value = extra.id; o.textContent = extra.label;
      sel.insertBefore(o, sel.firstChild);
    }
  };
  fill(el.profile, P.PROFILES);
  // 「不解析」在解析器列表里没有对应条目(它是 parser:'none'),单独补一个
  fill(el.parser, P.PARSERS, { id: 'none', label: '不解析(当裸二进制)' });
  {
    const o = document.createElement('option');
    o.value = 'auto'; o.textContent = '自动识别';
    el.parser.insertBefore(o, el.parser.firstChild);
  }
  fill(el.transform, P.TRANSFORMS);   // HTML 里已有 auto 项,这里追加在后面
  el.profile.value = 'auto';
  el.parser.value = 'auto';
  el.transform.value = 'auto';
}

// 转换矩阵
for (const [k, m] of Object.entries(D.MATRICES)) {
  const o = document.createElement('option');
  o.value = k; o.textContent = m.label;
  el.matrix.appendChild(o);
}

// CFA
for (const [k, label] of Object.entries({
  rggb: 'RGGB', bggr: 'BGGR', grbg: 'GRBG', gbrg: 'GBRG', mono: 'mono(不去马赛克)',
})) {
  const o = document.createElement('option');
  o.value = k; o.textContent = label;
  el.cfa.appendChild(o);
}

/* ------------------------ 预处理 ------------------------ */

/** 收集预处理选项。数据类型给默认值,「高级」里显式改过的项优先。 */
function preOpts() {
  const o = {
    parser: el.parser.value,
    transformPhase: el.transformPhase.value,
    stripPrefix: el.stripPrefix.value,
    keepRe: el.keepRe.value.trim(),
    dropRe: el.dropRe.value.trim(),
    customRe: el.customRe.value.trim(),
    slip: S.slip,
    wordSwap: S.wordSwap,
    frames: {
      mode: el.frameMode.value,
      size: +el.frameSize.value || 0,
      start: el.frameStart.value.trim(),
      end: el.frameEnd.value.trim(),
    },
  };
  if (S.resync != null) o.resync = S.resync;      // 只在用户表过态时才显式传
  /* 位变换同理:'auto' 表示「我没选,听容器头 / 数据类型的」。
   * 必须整个字段不传 —— 传 undefined 也会被预处理当成「显式给了」。*/
  if (el.transform.value !== 'auto') o.transform = el.transform.value;
  return o;
}

/** 选了数据类型 -> 把它的 pre 字段铺到「高级」控件上,保持两边显示一致 */
function applyProfile(id) {
  const prof = P.PROFILE[id];
  if (!prof) return;
  const p = prof.pre || {};
  el.parser.value = p.parser || 'auto';
  // 数据类型没指定变换时留在 auto,让容器头的 MAP= 有机会生效
  el.transform.value = p.transform || 'auto';
  el.transformPhase.value = p.transformPhase != null ? String(p.transformPhase) : 'auto';
  S.resync = p.resync != null ? !!p.resync : null;
  el.profileHint.textContent = prof.hint || '';
  syncPreKnobs();
}

/** 当前实际生效的位变换(下拉框选 auto 时取上一轮预处理的结果) */
function effectiveTransform() {
  if (el.transform.value !== 'auto') return P.TRANSFORM[el.transform.value];
  const f = S.files[S.cur];
  return P.TRANSFORM[(f && f.pre && f.pre.transform) || 'none'];
}

/** 按当前选择显示/隐藏预处理的从属控件 */
function syncPreKnobs() {
  el.rowCustomRe.classList.toggle('off', el.parser.value !== 'custom');
  const tf = effectiveTransform();
  el.rowPhase.classList.toggle('off', !tf || !tf.prepare);
  el.parserHint.textContent = (P.PARSER[el.parser.value] || {}).hint || '';
  el.transformHint.textContent = el.transform.value === 'auto' && tf && tf.id !== 'none'
    ? `当前生效:${tf.label} · ${tf.hint || ''}`
    : (tf || {}).hint || '';
  const m = el.frameMode.value;
  el.rowFrameSize.classList.toggle('off', m !== 'size');
  el.rowFrameStart.classList.toggle('off', m !== 'magic');
  el.rowFrameEnd.classList.toggle('off', m !== 'magic');
  el.slipBtn.classList.toggle('on', S.slip);
  el.swapBtn.classList.toggle('on', S.wordSwap);
  /* 重同步按钮显示的是「实际生效状态」:用户没表态时(null)看预处理
   * 这一轮到底开没开(容器缺字节会自动开),否则看用户的选择。*/
  el.resyncBtn.classList.toggle('on', effectiveResync());
  // 重同步只对「带填充位的成对布局」有意义,其他变换下按钮没用
  el.resyncBtn.disabled = !tf || !tf.prepare;
}

/** 重同步当前是否真的在生效(用于按钮高亮和点击时的取反基准) */
function effectiveResync() {
  if (S.resync != null) return S.resync;
  const f = S.files[S.cur];
  return !!(f && f.pre && f.pre.notes.some(n => /重同步:检出并修补|自动开启丢字节重同步/.test(n.msg)));
}

const NOTE_CLS = { ok: 'ok', warn: 'warn', err: 'err', info: '' };

const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* 文件头字段的显示顺序与中文说明。顺序写死而不是照 Object.keys ——
 * 固定顺序才方便每次拖新文件时在同一位置扫一眼对比。
 * 不在表里的字段会追加到末尾(固件以后加字段也不会被吞掉)。*/
const HDR_FIELDS = [
  ['FRAME', '帧号'], ['WIDTH', '宽'], ['HEIGHT', '高'],
  ['BYTES', '数据字节'], ['BPP', '每像素字节'], ['BITS', '位深'],
  ['ENDIAN', '字节序'], ['MAP', '位映射'], ['BAYER', 'CFA'],
  ['CHECKSUM', '校验和'],
];

/** 把容器头显示成字段表;没有头部就整块隐藏 */
function showHeaderInfo(f) {
  const c = f && f.pre && f.pre.container;
  if (!c) { el.hdrBox.classList.add('hide'); el.hdrTable.innerHTML = ''; el.hdrExtra.textContent = ''; return; }
  el.hdrBox.classList.remove('hide');

  const kv = c.kv;
  const seen = new Set(HDR_FIELDS.map(([k]) => k));
  const rows = [];
  const add = (k, label, v, tag) => {
    rows.push(`<tr><td class="k">${esc(label)}</td><td class="v">${esc(v)}${tag || ''}</td></tr>`);
  };

  for (const [k, label] of HDR_FIELDS) {
    if (kv[k] == null) continue;
    let tag = '';
    // 给几个关键字段补一句「这意味着什么」,省得对着 ROR2 猜
    if (k === 'MAP') {
      const t = P.TRANSFORM[f.pre.transform];
      tag = f.pre.transform && f.pre.transform !== 'none'
        ? `<span class="tag ok">→ ${esc(t ? t.label : f.pre.transform)}</span>`
        : '<span class="tag warn">未套用位变换</span>';
    } else if (k === 'CHECKSUM' && c.checksum) {
      tag = c.checksum.ok
        ? '<span class="tag ok">✓ 吻合</span>'
        : `<span class="tag err">✗ 实算 ${c.checksum.got.toLocaleString()}` +
          `(差 ${(c.checksum.want - c.checksum.got).toLocaleString()})</span>`;
    } else if (k === 'BYTES' && c.declared != null && c.actual !== c.declared) {
      const d = c.declared - c.actual;
      tag = `<span class="tag err">✗ 实得 ${c.actual.toLocaleString()}` +
            `(${d > 0 ? '少' : '多'} ${Math.abs(d).toLocaleString()})</span>`;
    } else if (k === 'BYTES') {
      tag = '<span class="tag ok">✓ 完整</span>';
    }
    add(k, label, kv[k], tag);
  }
  // 头部里出现的其他字段照样列出来
  for (const k of Object.keys(kv)) if (!seen.has(k)) add(k, k, kv[k]);
  el.hdrTable.innerHTML = rows.join('');

  const bad = (c.checksum && !c.checksum.ok) || c.actual !== c.declared;
  el.hdrExtra.innerHTML = bad
    ? '<span class="err">数据不完整,画面仅供参考;可在预处理「高级」里开关重同步对比</span>'
    : '<span class="ok">头部与数据一致</span>';
}

/** 把预处理结果的诊断信息显示出来(连带文件头信息表) */
function showPreInfo(f) {
  showHeaderInfo(f);
  const r = f && f.pre;
  if (!r) { el.preInfo.innerHTML = ''; return; }
  const parts = [];
  if (r.inSize !== r.outSize || r.parser !== 'none' || r.transform !== 'none')
    parts.push(`<span class="note">${r.inSize.toLocaleString()} B ` +
               `→ <b style="color:#7fd1ff">${r.outSize.toLocaleString()} B</b>` +
               (r.frames.length > 1 ? ` · ${r.frames.length} 帧` : '') + '</span>');
  /* 容器头的字段与校验结论已经在「文件头信息」表里逐项列出了,
   * 这里就不再重复那几条 note,免得同一件事说两遍把真正的告警挤下去。
   * 只有「没找到尾标记」这类结构性问题留在诊断区 —— 它不对应某个字段。*/
  for (const n of r.notes) {
    if (r.container && /^容器:(识别到|头部声明|校验和)/.test(n.msg)) continue;
    parts.push(`<span class="note ${NOTE_CLS[n.level] || ''}">${n.msg}</span>`);
  }
  const cur = f.frames[S.frame];
  if (cur && cur.bytes.length)
    parts.push(`<span class="note hex">${P.hexPreview(cur.bytes, 24)}</span>`);
  el.preInfo.innerHTML = parts.join('');
}

/** 跑一遍预处理,结果缓存在文件对象上(改参数才重跑,翻帧/改格式不重跑) */
function runPreprocess(f) {
  let r;
  try {
    r = P.preprocess(f.raw, preOpts());
  } catch (err) {
    r = { frames: [{ bytes: f.raw, from: 0 }], bytes: f.raw, parser: 'none',
          transform: 'none', dec: null, inSize: f.raw.length, outSize: f.raw.length,
          notes: [{ level: 'err', msg: '预处理异常:' + err.message }], candidates: [] };
  }
  f.pre = r;
  f.frames = r.frames;
  f.bytes = r.bytes;
  if (S.frame >= f.frames.length) S.frame = 0;
  return r;
}

/** 预处理给出的解码侧建议(格式 / 宽高 / CFA / 字节序)套到右侧控件上。
 *  返回是否给出了宽高 —— 给了就不用再按字节数去猜尺寸了。 */
function applyDecHints(dec) {
  if (!dec) return false;
  if (dec.fmt && D.FMT[dec.fmt]) el.fmt.value = dec.fmt;
  if (dec.cfa) el.cfa.value = dec.cfa;
  if (dec.endian) el.endian.value = dec.endian;
  if (dec.msb) el.msb.value = dec.msb;
  // 容器头自带宽高时直接采用:比按字节数反推可靠得多
  if (dec.width > 0 && dec.height > 0) {
    el.w.value = dec.width;
    el.h.value = dec.height;
    el.stride.value = 0;
    const k = dec.width + 'x' + dec.height;
    el.preset.value = D.COMMON_SIZES.some(([a, b]) => a + 'x' + b === k) ? k : '';
    return true;
  }
  return false;
}

/* ------------------------ 参数收集 ------------------------ */

function curFmt() { return el.fmt.value; }

/** 当前要解码的字节(预处理后的当前帧) */
function curBytes() {
  const f = S.files[S.cur];
  if (!f) return null;
  const fr = f.frames && f.frames[S.frame];
  return fr ? fr.bytes : f.bytes;
}

function opts() {
  return {
    stride: +el.stride.value || 0,
    bigEndian: el.endian.value === 'be',
    msbAligned: el.msb.value === 'msb',
    range: el.range.value,
    matrix: el.matrix.value,
    cfa: el.cfa.value,
    blackLevel: +el.blackLevel.value || 0,
    whiteLevel: +el.whiteLevel.value || 0,
    autoLevel: el.autoLevel.checked,
    gamma: +el.gamma.value,
    gainR: +el.gainR.value, gainG: +el.gainG.value, gainB: +el.gainB.value,
  };
}

/** 按当前格式声明的 knobs 显示/隐藏参数区 */
function syncKnobs() {
  const f = D.FMT[curFmt()];
  const has = k => f.knobs.includes(k);
  el.knobYUV.classList.toggle('hide', !(has('range') || has('matrix')));
  el.knobRAW.classList.toggle('hide', !has('raw'));
  el.knobByte.classList.toggle('hide', !(has('endian') || has('msb')));
  el.rowEndian.style.display = has('endian') ? '' : 'none';
  el.rowMsb.style.display = has('msb') ? '' : 'none';

  const isJpeg = f.id === 'jpeg';
  for (const n of [el.w, el.h, el.stride, el.preset, el.guessBtn, el.swapWH, el.alignBtn])
    n.disabled = isJpeg;
  el.fmtHint.innerHTML = isJpeg
    ? 'JPEG 由浏览器解码,宽高来自文件头,无需设置。'
    : `平均 ${f.bpp} bpp · 宽度需为 ${f.pack} 的倍数` +
      (f.group === 'YUV420' ? ' · 高度需为偶数' : '');
}

/* ------------------------ 尺寸辅助 ------------------------ */

function curSize() {
  return { w: Math.max(1, +el.w.value | 0), h: Math.max(1, +el.h.value | 0) };
}

function curFileSize() {
  const b = curBytes();
  return b ? b.length - (+el.offset.value || 0) : 0;
}

/** 更新「期望 vs 实际字节数」提示 */
function syncSizeInfo() {
  const fmt = curFmt();
  if (fmt === 'jpeg') { el.sizeInfo.textContent = ''; return; }
  const { w, h } = curSize();
  const avail = curFileSize();
  const need = D.expectedBytes(fmt, w, h, +el.stride.value || 0);
  const minLs = D.minLumaStride(fmt, w);
  const ls = D.rowStride(+el.stride.value || 0, minLs);
  let msg = `需要 ${need.toLocaleString()} B · 行跨距 ${ls} B`;
  if (ls !== minLs) msg += ` (紧凑 ${minLs} + 填充 ${ls - minLs})`;
  if (avail) {
    const d = avail - need;
    const cls = d === 0 ? 'ok' : d > 0 ? 'warn' : 'err';
    const tip = d === 0 ? '与文件完全吻合'
      : d > 0 ? `文件多 ${d.toLocaleString()} B(多帧?有头部?)`
              : `文件少 ${(-d).toLocaleString()} B,底部会是空白`;
    msg += `\n可用 ${avail.toLocaleString()} B · <span class="${cls}">${tip}</span>`;
  }
  el.sizeInfo.innerHTML = msg;

  const f = D.FMT[fmt];
  const bad = [];
  if (w % f.pack) bad.push(`宽度应为 ${f.pack} 的倍数`);
  if (f.group === 'YUV420' && h % 2) bad.push('高度应为偶数');
  if (bad.length) el.sizeInfo.innerHTML += `\n<span class="warn">${bad.join(' · ')}</span>`;
}

/** 列出尺寸候选按钮 */
function showGuesses() {
  el.guesses.innerHTML = '';
  const avail = curFileSize();
  if (!avail || curFmt() === 'jpeg') return;
  const list = D.guessSizes(avail, curFmt(), 10, +el.stride.value || 0);
  if (!list.length) {
    el.guesses.innerHTML = '<span class="hint warn">按当前格式' +
      (+el.stride.value ? '和行跨距' : '') + '无法整除成合理宽高:' +
      '试试改格式 / 清空行跨距 / 设数据偏移跳过文件头</span>';
    return;
  }
  for (const g of list) {
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = `${g.w}×${g.h}`;
    b.title = g.tag;
    if (g.tag.startsWith('常见') || g.tag === '跨距无填充') b.classList.add('on');
    b.onclick = () => { el.w.value = g.w; el.h.value = g.h; el.preset.value = ''; render(); };
    el.guesses.appendChild(b);
  }
}

/* ------------------------ 文件读取 ------------------------ */

/* 文件名里带格式关键字时自动选格式,省得每次手动挑。
 *
 * 不能用 \b 做边界:`_` 在正则里算单词字符,所以 /\bnv12\b/ 匹配不上
 * `nv12_640x480.yuv` —— dump 文件名恰恰最爱用下划线分段。这里显式把边界
 * 定义成「非字母数字或首尾」。*/
const SEP = '(?:^|[^a-z0-9])', SEP_END = '(?=[^a-z0-9]|$)';
const tok = (...alts) => new RegExp(SEP + '(?:' + alts.join('|') + ')' + SEP_END, 'i');

/* 顺序有意义:长/具体的写法必须排在短/宽泛的前面,
 * 否则 raw10p 会先被 raw10 吃掉、rgb565 会先被 rgb 吃掉。*/
const FMT_BY_NAME_HINT = [
  [tok('raw10[_-]?p', 'mipi[_-]?10', 'raw10[_-]?mipi', 'pack(ed)?10'), 'raw10p'],
  [tok('raw12[_-]?p', 'mipi[_-]?12', 'raw12[_-]?mipi', 'pack(ed)?12'), 'raw12p'],
  // raw10u / raw10_unpack 等后缀写法也要认,所以额外允许 u/unpack 尾巴
  [tok('raw10u?', 'raw10[_-]?unpack(ed)?', 'bayer10'), 'raw10u'],
  [tok('raw12u?', 'raw12[_-]?unpack(ed)?', 'bayer12'), 'raw12u'],
  [tok('raw16u?', 'bayer16'), 'raw16'],
  [tok('raw8', 'bayer8', 'bayer'), 'raw8'],
  [tok('nv12'), 'nv12'], [tok('nv21'), 'nv21'],
  [tok('nv16'), 'nv16'], [tok('nv61'), 'nv61'],
  [tok('i420', 'yu12'), 'i420'], [tok('yv12'), 'yv12'],
  [tok('i422', 'yu16'), 'i422'], [tok('yv16'), 'yv16'],
  [tok('yuyv', 'yuy2', 'v422'), 'yuyv'], [tok('yvyu'), 'yvyu'],
  [tok('uyvy', 'y422', 'hdyc'), 'uyvy'], [tok('vyuy'), 'vyuy'],
  [tok('bgra', 'bgra8888', 'bgrx'), 'bgra8888'],
  [tok('rgba', 'argb', 'rgba8888', 'rgbx'), 'rgba8888'],
  [tok('bgr565'), 'bgr565'], [tok('rgb565', 'rgb16'), 'rgb565'],
  [tok('bgr888', 'bgr24'), 'bgr888'], [tok('rgb888', 'rgb24'), 'rgb888'],
  [tok('gray8?', 'grey8?', 'y8', 'luma'), 'gray8'],
];

/** 从文件名猜格式 / 尺寸 / CFA / 各类开关;猜不到就不动现有设置 */
function applyNameHints(name) {
  /* 文件名点名了传感器型号就直接套对应数据类型 —— 这类 dump 的位摆放
   * 光看内容是猜不出来的(两字节一像素的流,当 raw16 解也「字节数对得上」)。
   *
   * 认不出来时要显式回到 auto:否则上一个文件选中的数据类型会粘住,
   * 接着拖一个 jpeg 进来仍按 RAW10 变换,画面全错且看不出原因。
   * 只在「当前选择是由文件名自动套上的」时候才回退,用户手选的不动。*/
  const BY_NAME = [
    [n => tok('ov2640').test(n) && tok('raw10').test(n), 'ov2640_raw10_bggr'],
  ];
  const hit = BY_NAME.find(([re]) => re(name));
  if (hit) {
    el.profile.value = hit[1];
    applyProfile(hit[1]);
    S.profileFromName = true;
  } else if (S.profileFromName) {
    el.profile.value = 'auto';
    applyProfile('auto');
    S.profileFromName = false;
  }
  if (/\.(jpe?g|mjpe?g|jfif)$/i.test(name)) { el.fmt.value = 'jpeg'; return; }
  for (const [re, id] of FMT_BY_NAME_HINT) {
    if (re.test(name)) { el.fmt.value = id; break; }
  }

  /* 尺寸:优先认 `640x480` 这种带显式分隔符的写法。
   * 不能一上来就把 `_` 当分隔符 —— `stride1344_640x480` 会被读成 1344×640。
   * 所以先扫 x/×/*,没有再退回 `_`/`-`,且取最后一处匹配(尺寸通常在末尾)。
   * 退回分支还要求两个数字各自独立成段(前后都是分隔符),否则
   * `nv12_4032_3024` 会把格式名尾巴上的 12 当成宽度读成 12×4032。*/
  let m = [...name.matchAll(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/gi)].pop();
  if (!m) m = [...name.matchAll(/(?:^|[^0-9a-z])(\d{2,5})[_-](\d{2,5})(?=[^0-9]|$)/gi)].pop();
  let gotSize = false;
  if (m) {
    const w = +m[1], h = +m[2];
    if (w >= 8 && h >= 8 && w <= 16384 && h <= 16384) {
      el.w.value = w; el.h.value = h;
      gotSize = true;
      const k = w + 'x' + h;
      el.preset.value = D.COMMON_SIZES.some(([a, b]) => a + 'x' + b === k) ? k : '';
    }
  }

  const c = name.match(new RegExp(SEP + '(rggb|bggr|grbg|gbrg)' + SEP_END, 'i'));
  if (c) el.cfa.value = c[1].toLowerCase();
  if (tok('bt709', '709').test(name)) el.matrix.value = 'bt709';
  else if (tok('bt2020', '2020').test(name)) el.matrix.value = 'bt2020';
  if (tok('full', 'full[_-]?range', 'jfif').test(name)) el.range.value = 'full';
  if (tok('msb').test(name)) el.msb.value = 'msb';
  if (tok('be', 'big[_-]?endian').test(name)) el.endian.value = 'be';

  // 文件名里带 stride/pitch/linesize 就直接采用,省去手填
  const st = name.match(new RegExp('(?:stride|pitch|linesize|ls)[_-]?(\\d{2,6})', 'i'));
  /* 文件名没提 stride 时才清零,而且只在它同时给出了尺寸的情况下 ——
   * 翻 frame_001.yuv / frame_002.yuv 这种无 hint 的序列时,
   * 手调好的 stride 不该被每次切换悄悄抹掉。*/
  if (st) el.stride.value = +st[1];
  else if (gotSize) el.stride.value = 0;
}

/* 文件列表:多文件时每个文件一行;单文件但预处理切出多帧时改为列帧。
 * 两者共用 [ ] 快捷键 —— 用户关心的是「上一个/下一个画面」,不在乎它来自
 * 另一个文件还是同一文件的另一帧。*/
function renderFileList() {
  el.fileList.innerHTML = '';
  const f = S.files[S.cur];
  const multiFrame = S.files.length === 1 && f && f.frames && f.frames.length > 1;
  if (S.files.length < 2 && !multiFrame) return;

  if (multiFrame) {
    f.frames.forEach((fr, i) => {
      const d = document.createElement('div');
      d.textContent = `帧 ${i + 1}/${f.frames.length}  @${fr.from.toLocaleString()}  ` +
                      `(${(fr.bytes.length / 1024).toFixed(1)} KB)`;
      if (i === S.frame) d.className = 'cur';
      d.onclick = () => selectFrame(i);
      el.fileList.appendChild(d);
    });
    return;
  }
  S.files.forEach((x, i) => {
    const d = document.createElement('div');
    const n = x.frames ? x.frames.length : 1;
    d.textContent = `${x.name}  (${(x.raw.length / 1024).toFixed(0)} KB` +
                    (n > 1 ? `, ${n} 帧` : '') + ')';
    if (i === S.cur) d.className = 'cur';
    d.onclick = () => selectFile(i);
    el.fileList.appendChild(d);
  });
}

function selectFrame(i) {
  const f = S.files[S.cur];
  if (!f || !f.frames || i < 0 || i >= f.frames.length) return;
  S.frame = i;
  renderFileList();
  showGuesses();
  showPreInfo(f);
  render();
}

/* 每次切文件都重新按文件名推导格式/尺寸/stride。
 * 早先这里有个 keepSettings 开关,想让 [ ] 翻帧时保住手调的参数,
 * 结果是从 yuyv 翻到 nv12 仍按 yuyv 解 —— 画面错了却毫无提示,
 * 比丢掉几个手调参数糟得多。dump 文件名本来就是格式的权威来源,
 * 统一以它为准;真正无 hint 的帧序列(frame_001.yuv)也不会被动到。*/
function selectFile(i) {
  if (i < 0 || i >= S.files.length) return;
  S.cur = i;
  S.frame = 0;
  const f = S.files[i];
  applyNameHints(f.name);
  /* 预处理要在尺寸推断之前跑:推断依据的是「解码器真正拿到的字节数」,
   * 对文本化的 dump 来说那和文件大小差着好几倍。 */
  const pre = runPreprocess(f);
  const gotSize = applyDecHints(pre.dec);
  syncPreKnobs();        // 同上:auto 档的生效变换要等预处理跑完才知道

  const n = curBytes().length;
  el.fileInfo.innerHTML = `<b>${f.name}</b> · ${f.raw.length.toLocaleString()} B` +
                          ` (${(f.raw.length / 1048576).toFixed(2)} MB)` +
                          (n !== f.raw.length ? ` → 数据 ${n.toLocaleString()} B` : '');
  renderFileList();
  syncKnobs();
  showGuesses();
  showPreInfo(f);
  /* 当前尺寸与数据大小对不上时才自动套用推断结果。
   * 注意要带上 stride 一起算 —— 文件名已给出 640x480 + stride1344 时,
   * 紧凑尺寸自然对不上,不能因此把用户/文件名给的尺寸改掉。
   * 容器头已经给了权威宽高(gotSize)时跳过:那种 dump 往往刚好丢了几个字节,
   * 按字节数反推只会猜出一个「整除但错」的尺寸,把对的覆盖掉。*/
  if (!gotSize && curFmt() !== 'jpeg') {
    const { w, h } = curSize();
    const stride = +el.stride.value || 0;
    if (D.expectedBytes(curFmt(), w, h, stride) !== n) {
      const g = D.guessSizes(n, curFmt(), 1)[0];
      if (g) { el.w.value = g.w; el.h.value = g.h; el.stride.value = 0; }
    }
  }
  S.fitted = true;
  render();
}

async function loadFiles(list) {
  const arr = [];
  for (const file of list) {
    const buf = await file.arrayBuffer();
    const raw = new Uint8Array(buf);
    arr.push({ name: file.name, raw, bytes: raw, frames: [{ bytes: raw, from: 0 }], pre: null });
  }
  if (!arr.length) return;
  S.files = arr;
  el.stage.classList.remove('empty');
  selectFile(0);
}

el.pick.onclick = () => el.file.click();
el.file.onchange = e => loadFiles(e.target.files);

// 拖放
el.stage.addEventListener('dragover', e => {
  e.preventDefault(); el.stage.classList.add('dropping');
});
el.stage.addEventListener('dragleave', () => el.stage.classList.remove('dropping'));
el.stage.addEventListener('drop', e => {
  e.preventDefault(); el.stage.classList.remove('dropping');
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

/* ------------------------ 解码 & 绘制 ------------------------ */

let jpegBusy = false;

async function render() {
  syncKnobs();
  syncSizeInfo();
  const f = S.files[S.cur];
  if (!f) return;

  if (curFmt() === 'jpeg') { await renderJpeg(f); return; }

  const { w, h } = curSize();
  if (w * h > 80e6) {          // ~80MP 上限,防手滑输入把页面卡死
    el.statInfo.innerHTML = '<span class="err">尺寸过大(> 80MP),已拒绝渲染</span>';
    return;
  }
  const off = Math.max(0, +el.offset.value || 0);
  const need = D.expectedBytes(curFmt(), w, h, +el.stride.value || 0);
  const src = curBytes();
  if (!src) return;

  // 数据不够就补零,让用户至少看到已有的部分(排查截断的 dump 很有用)
  let bytes = src.subarray(Math.min(off, src.length));
  if (bytes.length < need) {
    const pad = new Uint8Array(need);
    pad.set(bytes);
    bytes = pad;
  }

  let res;
  try {
    res = D.decodeFrame(bytes, curFmt(), w, h, opts());
  } catch (err) {
    el.statInfo.innerHTML = `<span class="err">解码失败:${err.message}</span>`;
    return;
  }
  S.lastStats = res.stats || null;
  paint(new ImageData(res.data, w, h));
}

async function renderJpeg(f) {
  if (jpegBusy) return;
  jpegBusy = true;
  try {
    const off = Math.max(0, +el.offset.value || 0);
    const src = curBytes() || f.raw;
    const blob = new Blob([src.subarray(off)], { type: 'image/jpeg' });
    const bmp = await createImageBitmap(blob);
    el.w.value = bmp.width; el.h.value = bmp.height;
    // 先画到离屏再取 ImageData,后续通道过滤/直方图与其他格式走同一条路
    const oc = document.createElement('canvas');
    oc.width = bmp.width; oc.height = bmp.height;
    oc.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    S.lastStats = null;
    paint(oc.getContext('2d').getImageData(0, 0, oc.width, oc.height));
  } catch (err) {
    el.statInfo.innerHTML = '<span class="err">JPEG 解码失败:不是合法 JPEG,' +
                            '或需要设置数据偏移跳过前置头部</span>';
  } finally {
    jpegBusy = false;
  }
}

/** 通道过滤:在副本上做,原图留着给取色和直方图 */
function applyChannel(src) {
  if (S.channel === 'all') return src;
  const d = new Uint8ClampedArray(src.data);
  for (let i = 0; i < d.length; i += 4) {
    if (S.channel === 'y') {
      const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    } else {
      const k = S.channel === 'r' ? 0 : S.channel === 'g' ? 1 : 2;
      const v = d[i + k];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return new ImageData(d, src.width, src.height);
}

function paint(img) {
  S.img = img;
  el.cv.width = img.width; el.cv.height = img.height;
  ctx.putImageData(applyChannel(img), 0, 0);
  if (S.fitted) fit(); else layout();
  drawHisto();
  updateStatInfo();
}

/* ------------------------ 缩放 / 平移 ------------------------ */

function layout() {
  const sx = S.flipH ? -1 : 1, sy = S.flipV ? -1 : 1;
  // 翻转时 transform-origin 仍在左上,需要补一个位移把图拉回可见区
  const tx = S.panX + (S.flipH ? S.img.width * S.zoom : 0);
  const ty = S.panY + (S.flipV ? S.img.height * S.zoom : 0);
  el.cv.style.transform =
    `translate(${tx}px, ${ty}px) scale(${S.zoom * sx}, ${S.zoom * sy})`;
  // 放大到能看清单个像素时才显示网格
  el.cv.style.imageRendering = S.zoom >= 1 ? 'pixelated' : 'auto';
  drawGridOverlay();
}

function fit() {
  if (!S.img) return;
  const pad = 28;
  const aw = el.stage.clientWidth - pad * 2, ah = el.stage.clientHeight - pad * 2;
  S.zoom = Math.min(aw / S.img.width, ah / S.img.height);
  if (S.zoom > 1) S.zoom = Math.floor(S.zoom);      // 放大时取整数倍,像素边界干净
  S.zoom = Math.max(S.zoom, 0.02);
  S.panX = (el.stage.clientWidth - S.img.width * S.zoom) / 2;
  S.panY = (el.stage.clientHeight - S.img.height * S.zoom) / 2;
  S.fitted = true;
  layout();
}

function setZoom(z, cx, cy) {
  if (!S.img) return;
  z = Math.max(0.02, Math.min(64, z));
  // 以 (cx,cy) 为锚点缩放,保持锚点下的图像坐标不动
  const ix = (cx - S.panX) / S.zoom, iy = (cy - S.panY) / S.zoom;
  S.zoom = z;
  S.panX = cx - ix * z;
  S.panY = cy - iy * z;
  S.fitted = false;
  layout();
}

el.stage.addEventListener('wheel', e => {
  if (!S.img) return;
  e.preventDefault();
  const r = el.stage.getBoundingClientRect();
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  setZoom(S.zoom * f, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

{
  let drag = null;
  el.stage.addEventListener('pointerdown', e => {
    if (!S.img || e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, px: S.panX, py: S.panY };
    el.stage.classList.add('dragging');
    el.stage.setPointerCapture(e.pointerId);
  });
  el.stage.addEventListener('pointermove', e => {
    const r = el.stage.getBoundingClientRect();
    if (drag) {
      S.panX = drag.px + (e.clientX - drag.x);
      S.panY = drag.py + (e.clientY - drag.y);
      S.fitted = false;
      layout();
    }
    updateHud(e.clientX - r.left, e.clientY - r.top);
  });
  const end = e => {
    if (!drag) return;
    drag = null;
    el.stage.classList.remove('dragging');
    try { el.stage.releasePointerCapture(e.pointerId); } catch {}
  };
  el.stage.addEventListener('pointerup', end);
  el.stage.addEventListener('pointercancel', end);
  el.stage.addEventListener('pointerleave', () => {
    el.loupe.style.display = 'none';
    updateHud(-1, -1);
  });
}

/* 屏幕坐标 -> 图像像素坐标(考虑翻转) */
function toImgXY(sx, sy) {
  if (!S.img) return null;
  let ix = Math.floor((sx - S.panX) / S.zoom);
  let iy = Math.floor((sy - S.panY) / S.zoom);
  if (S.flipH) ix = S.img.width - 1 - ix;
  if (S.flipV) iy = S.img.height - 1 - iy;
  if (ix < 0 || iy < 0 || ix >= S.img.width || iy >= S.img.height) return null;
  return { x: ix, y: iy };
}

/* ------------------------ HUD / 取色 / 放大镜 ------------------------ */

function updateHud(sx, sy) {
  if (!S.img) { el.hud.textContent = ''; return; }
  const base = `${S.img.width}×${S.img.height}  ${(S.zoom * 100).toFixed(0)}%`;
  const p = sx >= 0 ? toImgXY(sx, sy) : null;
  if (!p) { el.hud.innerHTML = base; el.loupe.style.display = 'none'; return; }

  const i = (p.y * S.img.width + p.x) * 4, d = S.img.data;
  const r = d[i], g = d[i + 1], b = d[i + 2];
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  // 顺带给出该点在源文件里的字节偏移,方便和 hexdump 对照
  const off = byteOffsetOf(p.x, p.y);
  el.hud.innerHTML =
    `${base}\n(${p.x}, ${p.y})  <span class="sw" style="background:${hex}"></span>` +
    `<b>${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}</b>  ${hex}` +
    (off != null ? `\n源字节偏移 ${off.toLocaleString()} (0x${off.toString(16).toUpperCase()})` : '');

  if (S.loupeOn) drawLoupe(p, sx, sy);
}

/** 该像素对应源文件中的字节偏移(近似:给出该像素所在分量的起始字节) */
function byteOffsetOf(x, y) {
  const fmt = curFmt();
  if (fmt === 'jpeg') return null;
  const off = Math.max(0, +el.offset.value || 0);
  const ls = D.rowStride(+el.stride.value || 0, D.minLumaStride(fmt, S.img.width));
  const f = D.FMT[fmt];
  switch (fmt) {
    case 'rgb565': case 'bgr565': return off + y * ls + x * 2;
    case 'rgb888': case 'bgr888': return off + y * ls + x * 3;
    case 'rgba8888': case 'bgra8888': return off + y * ls + x * 4;
    case 'yuyv': case 'yvyu': case 'uyvy': case 'vyuy':
      return off + y * ls + (x >> 1) * 4;
    case 'raw10p': return off + y * ls + (x >> 2) * 5;
    case 'raw12p': return off + y * ls + (x >> 1) * 3;
    case 'raw10u': case 'raw12u': case 'raw16': return off + y * ls + x * 2;
    default:
      // gray8 / raw8 / 各 planar 的 Y 面
      return off + y * ls + x;
  }
}

function drawLoupe(p, sx, sy) {
  const N = 11;                     // 11×11 邻域,每像素放大 12 倍
  const c = el.loupe.firstElementChild;
  c.width = N; c.height = N;
  const src = S.img, out = loupeCtx.createImageData(N, N);
  for (let dy = 0; dy < N; dy++) {
    for (let dx = 0; dx < N; dx++) {
      const x = p.x - (N >> 1) + dx, y = p.y - (N >> 1) + dy;
      const q = (dy * N + dx) * 4;
      if (x < 0 || y < 0 || x >= src.width || y >= src.height) {
        out.data[q] = out.data[q + 1] = out.data[q + 2] = 24; out.data[q + 3] = 255;
      } else {
        const i = (y * src.width + x) * 4;
        out.data[q] = src.data[i]; out.data[q + 1] = src.data[i + 1];
        out.data[q + 2] = src.data[i + 2]; out.data[q + 3] = 255;
      }
    }
  }
  loupeCtx.putImageData(out, 0, 0);
  el.loupe.style.display = 'block';
  el.loupe.style.left = Math.min(sx + 16, el.stage.clientWidth - 140) + 'px';
  el.loupe.style.top = Math.min(sy + 16, el.stage.clientHeight - 140) + 'px';
}

/* 像素网格:放大到 >= 8x 时叠一层格线,用来数 Bayer / 宏像素 */
let gridEl = null;
function drawGridOverlay() {
  if (!S.grid || !S.img || S.zoom < 8) {
    if (gridEl) gridEl.style.display = 'none';
    return;
  }
  if (!gridEl) {
    gridEl = document.createElement('div');
    gridEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:4';
    el.stage.appendChild(gridEl);
  }
  const z = S.zoom;
  gridEl.style.display = 'block';
  // 2×2 粗线(Bayer / 色度宏像素边界),1×1 细线
  gridEl.style.backgroundImage =
    `linear-gradient(to right, rgba(90,169,255,.55) 1px, transparent 1px),
     linear-gradient(to bottom, rgba(90,169,255,.55) 1px, transparent 1px),
     linear-gradient(to right, rgba(255,255,255,.16) 1px, transparent 1px),
     linear-gradient(to bottom, rgba(255,255,255,.16) 1px, transparent 1px)`;
  gridEl.style.backgroundSize =
    `${z * 2}px ${z * 2}px, ${z * 2}px ${z * 2}px, ${z}px ${z}px, ${z}px ${z}px`;
  gridEl.style.backgroundPosition = `${S.panX}px ${S.panY}px`;
}

/* ------------------------ 直方图 / 统计 ------------------------ */

function drawHisto() {
  const c = el.histo, g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (!S.img) return;

  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
  const d = S.img.data;
  // 大图抽样统计,1080p 以上没必要逐像素
  const step = d.length > 4 * 2e6 ? 4 * 7 : 4;
  for (let i = 0; i < d.length; i += step) { hr[d[i]]++; hg[d[i + 1]]++; hb[d[i + 2]]++; }

  let mx = 0;
  for (let i = 0; i < 256; i++) mx = Math.max(mx, hr[i], hg[i], hb[i]);
  if (!mx) return;
  /* 0 和 255 的计数经常把峰值撑爆(纯黑背景 / 过曝),直接按最大值归一
   * 会把中间调压成一条线。取 98% 分位当标尺,并兜一个下限防止全图单色时除零。*/
  const sorted = Array.from(hr).concat(Array.from(hg), Array.from(hb)).sort((a, b) => a - b);
  const p98 = sorted[Math.floor(sorted.length * 0.98)] || mx;
  const scale = Math.max(p98, mx * 0.08);

  g.globalCompositeOperation = 'lighter';   // 三通道叠加,重合处自然变白
  const draw = (hist, color) => {
    g.fillStyle = color;
    for (let i = 0; i < 256; i++) {
      const bh = Math.min(1, hist[i] / scale) * (H - 2);
      if (bh > 0) g.fillRect(i * W / 256, H - bh, Math.ceil(W / 256), bh);
    }
  };
  draw(hr, 'rgba(255,70,70,.75)');
  draw(hg, 'rgba(70,235,110,.7)');
  draw(hb, 'rgba(80,140,255,.75)');
  g.globalCompositeOperation = 'source-over';
  g.strokeStyle = 'rgba(255,255,255,.14)';
  g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
}

function updateStatInfo() {
  if (!S.img) { el.statInfo.textContent = ''; return; }
  const d = S.img.data;
  let mn = 255, mx = 0, sum = 0, n = 0, clipLo = 0, clipHi = 0;
  const step = d.length > 4 * 2e6 ? 4 * 7 : 4;
  for (let i = 0; i < d.length; i += step) {
    for (let k = 0; k < 3; k++) {
      const v = d[i + k];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      if (v === 0) clipLo++;
      if (v === 255) clipHi++;
      sum += v; n++;
    }
  }
  const pct = v => (100 * v / n).toFixed(1);
  let s = `范围 ${mn}–${mx} · 均值 ${(sum / n).toFixed(1)} · ` +
          `暗部截断 ${pct(clipLo)}% · 高光截断 ${pct(clipHi)}%`;
  const st = S.lastStats;
  if (st) {
    s += `\nRAW ${st.bits}bit 原始值 ${st.min}–${st.max} · 电平 ${st.black}/${st.white}`;
    if (st.max <= st.min) s += ' <span class="warn">(整帧同值,格式/尺寸可能不对)</span>';
    else if (st.max < (1 << st.bits) * 0.25) s += ' <span class="warn">(偏暗,试试自动电平)</span>';
  }
  // 整帧同一个值也是「格式选错」的强信号,非 RAW 格式同样提示
  if (!st && mn === mx) s += ' <span class="warn">(整帧同值,格式/尺寸可能不对)</span>';
  el.statInfo.innerHTML = s;
}

/* ------------------------ 控件事件 ------------------------ */

const rerender = () => render();

/* ---- 预处理控件 ---- */

/** 改了预处理参数:重跑预处理 + 重算尺寸候选 + 重绘 */
function repreprocess(resize) {
  const f = S.files[S.cur];
  if (!f) { syncPreKnobs(); return; }
  const pre = runPreprocess(f);
  /* 预处理结果出来之后再同步控件:位变换选 auto 时,
   * 「实际生效的变换」只有跑完才知道 —— 重同步按钮的可用性依赖它。*/
  syncPreKnobs();
  renderFileList();
  showGuesses();
  showPreInfo(f);
  /* 预处理变了,数据量通常也变了,原来的宽高大概率不再吻合。
   * 但只在明确要求时才自动改尺寸(切数据类型/位变换时),
   * 否则用户正在微调正则,尺寸被反复改掉会很难用。*/
  const gotSize = pre.dec && pre.dec.width > 0 && pre.dec.height > 0;
  if (resize && !gotSize && curFmt() !== 'jpeg') {
    const n = curBytes().length;
    const { w, h } = curSize();
    if (D.expectedBytes(curFmt(), w, h, +el.stride.value || 0) !== n) {
      const g = D.guessSizes(n, curFmt(), 1, +el.stride.value || 0)[0];
      if (g) { el.w.value = g.w; el.h.value = g.h; el.preset.value = ''; }
    }
    S.fitted = true;
  }
  if (resize && gotSize) S.fitted = true;
  render();
  return pre;
}

el.profile.onchange = () => {
  S.profileFromName = false;        // 用户手选过就别再自动撤回
  applyProfile(el.profile.value);
  const pre = repreprocess(true);
  if (pre) { applyDecHints(pre.dec); render(); }
};

el.preMore.onclick = () => {
  const hidden = el.preAdv.classList.toggle('hide');
  el.preMore.classList.toggle('on', !hidden);
  el.preMore.textContent = hidden ? '高级…' : '收起高级';
};

el.preReset.onclick = () => {
  el.profile.value = 'auto';
  el.keepRe.value = el.dropRe.value = el.customRe.value = '';
  el.stripPrefix.value = 'auto';
  el.frameMode.value = 'none';
  el.frameSize.value = ''; el.frameStart.value = ''; el.frameEnd.value = '';
  S.slip = S.wordSwap = false;
  S.resync = null;
  applyProfile('auto');
  repreprocess(true);
};

// 位变换 / 解析器变了,数据布局跟着变 —— 顺便套一下它的解码侧建议
el.transform.onchange = () => {
  syncPreKnobs();
  const pre = repreprocess(true);
  if (pre) { applyDecHints(pre.dec); render(); }
};

for (const n of [el.parser, el.transformPhase, el.stripPrefix, el.frameMode]) {
  n.onchange = () => { syncPreKnobs(); repreprocess(n === el.frameMode || n === el.parser); };
}

/* 正则是边打边生效的,每次按键都重扫一遍几十 MB 文本太卡。
 * 250ms 防抖:够快到感觉是实时的,又能把一串连续按键合成一次。*/
{
  let timer = 0;
  for (const n of [el.keepRe, el.dropRe, el.customRe, el.frameStart, el.frameEnd]) {
    n.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => repreprocess(false), 250);
    };
  }
  el.frameSize.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => repreprocess(false), 250);
  };
}

el.slipBtn.onclick = () => { S.slip = !S.slip; syncPreKnobs(); repreprocess(true); };
el.swapBtn.onclick = () => { S.wordSwap = !S.wordSwap; syncPreKnobs(); repreprocess(false); };
// 从「当前实际生效的状态」取反,这样第一次点击一定与所见相反
el.resyncBtn.onclick = () => { S.resync = !effectiveResync(); syncPreKnobs(); repreprocess(false); };

el.frameFromFmt.onclick = () => {
  const { w, h } = curSize();
  el.frameSize.value = D.expectedBytes(curFmt(), w, h, +el.stride.value || 0);
  el.frameMode.value = 'size';
  syncPreKnobs();
  repreprocess(false);
};

el.fmt.onchange = () => { showGuesses(); S.fitted = true; render(); };

el.preset.onchange = () => {
  if (!el.preset.value) return;
  const [w, h] = el.preset.value.split('x').map(Number);
  el.w.value = w; el.h.value = h;
  S.fitted = true; render();
};

for (const n of [el.w, el.h, el.stride, el.offset]) {
  n.oninput = () => {
    if (n === el.w || n === el.h) {
      // 手改宽高就把预设回到「自定义」,避免下拉框显示与实际不一致
      const k = curSize().w + 'x' + curSize().h;
      el.preset.value = D.COMMON_SIZES.some(([a, b]) => a + 'x' + b === k) ? k : '';
    }
    if (n === el.offset || n === el.stride) showGuesses();
    render();
  };
}

for (const n of [el.range, el.matrix, el.cfa, el.endian, el.msb,
                 el.blackLevel, el.whiteLevel]) {
  n.onchange = rerender;
  n.oninput = rerender;
}

el.autoLevel.onchange = () => {
  // 自动模式下手填的电平值不参与计算,禁掉输入框免得误解
  el.blackLevel.disabled = el.whiteLevel.disabled = el.autoLevel.checked;
  render();
};

for (const [sl, lb] of [[el.gamma, el.gammaV], [el.gainR, el.gainRV],
                        [el.gainG, el.gainGV], [el.gainB, el.gainBV]]) {
  sl.oninput = () => { lb.textContent = (+sl.value).toFixed(2); render(); };
}

el.swapWH.onclick = () => {
  const { w, h } = curSize();
  el.w.value = h; el.h.value = w;
  el.preset.value = '';
  S.fitted = true; render();
};

el.alignBtn.onclick = () => {
  /* 在常见对齐值间循环:紧凑 → 16 → 32 → 64 → 128 → 256 → 紧凑。
   * 当前值不在列表里(比如文件名解析出的 1344)时,indexOf 返回 -1,
   * 直接 +1 会跳到 0 把用户的值抹掉 —— 这种情况从第一档重新开始。*/
  const min = D.minLumaStride(curFmt(), curSize().w);
  const cur = +el.stride.value || 0;
  const uniq = Array.from(new Set([0, 16, 32, 64, 128, 256].map(a => a ? D.alignUp(min, a) : 0)));
  const i = uniq.indexOf(cur);
  el.stride.value = i < 0 ? uniq[1] || 0 : uniq[(i + 1) % uniq.length];
  showGuesses();
  render();
};

el.guessBtn.onclick = () => {
  showGuesses();
  const g = D.guessSizes(curFileSize(), curFmt(), 1, +el.stride.value || 0)[0];
  if (g) { el.w.value = g.w; el.h.value = g.h; el.preset.value = ''; S.fitted = true; render(); }
};

/** 灰世界白平衡:假设整帧平均应为灰,按 G 均值把 R/B 拉平。
 * 在当前增益上乘修正量(而非绝对设值),所以可以连点几次收敛。*/
el.awb.onclick = () => {
  if (!S.img) return;
  const d = S.img.data;
  let sr = 0, sg = 0, sb = 0;
  const step = d.length > 4 * 2e6 ? 4 * 7 : 4;
  for (let i = 0; i < d.length; i += step) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; }
  if (!sr || !sb) return;
  const cl = v => Math.max(0.3, Math.min(3, v));
  el.gainR.value = cl(+el.gainR.value * (sg / sr));
  el.gainB.value = cl(+el.gainB.value * (sg / sb));
  el.gainRV.textContent = (+el.gainR.value).toFixed(2);
  el.gainBV.textContent = (+el.gainB.value).toFixed(2);
  render();
};

el.resetRaw.onclick = () => {
  el.gamma.value = 2.2; el.gainR.value = 1; el.gainG.value = 1; el.gainB.value = 1;
  el.blackLevel.value = 0; el.whiteLevel.value = 0; el.autoLevel.checked = true;
  el.gammaV.textContent = '2.20';
  el.gainRV.textContent = el.gainGV.textContent = el.gainBV.textContent = '1.00';
  el.autoLevel.onchange();
};

// 通道按钮:只改显示,不重解码
{
  const map = { chAll: 'all', chR: 'r', chG: 'g', chB: 'b', chY: 'y' };
  const btns = Object.keys(map).map($);
  for (const b of btns) {
    b.onclick = () => {
      S.channel = map[b.id];
      for (const x of btns) x.classList.toggle('on', x === b);
      if (S.img) ctx.putImageData(applyChannel(S.img), 0, 0);
    };
  }
  btns[0].classList.add('on');
}

$('flipH').onclick = e => { S.flipH = !S.flipH; e.currentTarget.classList.toggle('on', S.flipH); layout(); };
$('flipV').onclick = e => { S.flipV = !S.flipV; e.currentTarget.classList.toggle('on', S.flipV); layout(); };
$('gridBtn').onclick = e => {
  S.grid = !S.grid;
  e.currentTarget.classList.toggle('on', S.grid);
  e.currentTarget.title = S.grid ? '放大到 8× 以上才显示格线' : '';
  drawGridOverlay();
};
$('loupeBtn').onclick = e => {
  S.loupeOn = !S.loupeOn;
  e.currentTarget.classList.toggle('on', S.loupeOn);
  if (!S.loupeOn) el.loupe.style.display = 'none';
};

for (const b of document.querySelectorAll('#zoombar button')) {
  b.onclick = () => {
    const cx = el.stage.clientWidth / 2, cy = el.stage.clientHeight / 2;
    const z = b.dataset.z;
    if (z === 'fit') fit();
    else if (z === '1') setZoom(1, cx, cy);
    else setZoom(S.zoom * (z === 'in' ? 1.5 : 1 / 1.5), cx, cy);
  };
}

window.addEventListener('resize', () => { if (S.fitted) fit(); else layout(); });

window.addEventListener('keydown', e => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'f') fit();
  else if (k === '1') setZoom(1, el.stage.clientWidth / 2, el.stage.clientHeight / 2);
  else if (k === 'z') $('loupeBtn').click();
  else if (k === 'g') $('gridBtn').click();
  // [ ] 翻「上一个/下一个画面」:单文件多帧时翻帧,否则翻文件
  else if (k === '[' || k === ']') {
    const d = k === '[' ? -1 : 1;
    const f = S.files[S.cur];
    if (S.files.length < 2 && f && f.frames && f.frames.length > 1) selectFrame(S.frame + d);
    else selectFile(S.cur + d);
  }
  else return;
  e.preventDefault();
});

/* ------------------------ 导出 ------------------------ */

/** 导出画布:带上通道过滤与翻转,所见即所得 */
function exportCanvas() {
  const tmp = document.createElement('canvas');
  tmp.width = S.img.width; tmp.height = S.img.height;
  tmp.getContext('2d').putImageData(applyChannel(S.img), 0, 0);
  if (!S.flipH && !S.flipV) return tmp;
  const c = document.createElement('canvas');
  c.width = S.img.width; c.height = S.img.height;
  const g = c.getContext('2d');
  g.translate(S.flipH ? c.width : 0, S.flipV ? c.height : 0);
  g.scale(S.flipH ? -1 : 1, S.flipV ? -1 : 1);
  g.drawImage(tmp, 0, 0);
  return c;
}

function exportName(ext) {
  const f = S.files[S.cur];
  const base = f ? f.name.replace(/\.[^.]*$/, '') : 'dump';
  /* 只补文件名里还没有的信息:样例名本来就叫 yuyv_640x480,
   * 无条件拼接会得到 yuyv_640x480_yuyv_640x480.png。 */
  const parts = [base];
  const fmt = curFmt(), size = `${S.img.width}x${S.img.height}`;
  if (!tok(fmt).test(base)) parts.push(fmt);
  if (!base.includes(size)) parts.push(size);
  // 多帧时带上帧号,连存几帧才不会互相覆盖
  if (f && f.frames && f.frames.length > 1) parts.push('f' + String(S.frame + 1).padStart(3, '0'));
  return parts.join('_') + '.' + ext;
}

el.savePng.onclick = () => {
  if (!S.img) return;
  exportCanvas().toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = exportName('png');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    el.exportHint.innerHTML = `<span class="ok">已保存 ${a.download}</span>`;
  }, 'image/png');
};

el.copyImg.onclick = async () => {
  if (!S.img) return;
  try {
    const blob = await new Promise(r => exportCanvas().toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    el.exportHint.innerHTML = '<span class="ok">已复制到剪贴板</span>';
  } catch (err) {
    // file:// 下剪贴板权限常被拒,给出可行替代
    el.exportHint.innerHTML = `<span class="warn">剪贴板不可用(${err.name}),请用「保存 PNG」</span>`;
  }
};

/* ------------------------ 启动 ------------------------ */
el.autoLevel.onchange();
applyProfile('auto');
syncKnobs();
syncSizeInfo();
