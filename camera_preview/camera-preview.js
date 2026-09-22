/* camera-preview.js — 查看器 UI
 * 解码逻辑全在 decoders.js(有 selftest.js 做回归),这里只管:
 * 读文件 / 收集参数 / 画到 canvas / 缩放平移 / 取色 / 直方图 / 导出。
 */
'use strict';
const D = window.CamDec;

const $ = id => document.getElementById(id);
const el = {
  stage: $('stage'), cv: $('cv'), hud: $('hud'), loupe: $('loupe'),
  file: $('file'), pick: $('pick'), fileInfo: $('fileInfo'), fileList: $('fileList'),
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
  files: [],          // { name, size, bytes }
  cur: -1,
  img: null,          // 当前解码出的 ImageData
  zoom: 1, panX: 0, panY: 0, fitted: true,
  channel: 'all',     // all | r | g | b | y
  flipH: false, flipV: false,
  grid: false, loupeOn: false,
  lastStats: null,
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

/* ------------------------ 参数收集 ------------------------ */

function curFmt() { return el.fmt.value; }

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
  const f = S.files[S.cur];
  return f ? f.bytes.length - (+el.offset.value || 0) : 0;
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

function renderFileList() {
  el.fileList.innerHTML = '';
  if (S.files.length < 2) return;
  S.files.forEach((f, i) => {
    const d = document.createElement('div');
    d.textContent = `${f.name}  (${(f.bytes.length / 1024).toFixed(0)} KB)`;
    if (i === S.cur) d.className = 'cur';
    d.onclick = () => selectFile(i);
    el.fileList.appendChild(d);
  });
}

/* 每次切文件都重新按文件名推导格式/尺寸/stride。
 * 早先这里有个 keepSettings 开关,想让 [ ] 翻帧时保住手调的参数,
 * 结果是从 yuyv 翻到 nv12 仍按 yuyv 解 —— 画面错了却毫无提示,
 * 比丢掉几个手调参数糟得多。dump 文件名本来就是格式的权威来源,
 * 统一以它为准;真正无 hint 的帧序列(frame_001.yuv)也不会被动到。*/
function selectFile(i) {
  if (i < 0 || i >= S.files.length) return;
  S.cur = i;
  const f = S.files[i];
  applyNameHints(f.name);
  el.fileInfo.innerHTML = `<b>${f.name}</b> · ${f.bytes.length.toLocaleString()} B` +
                          ` (${(f.bytes.length / 1048576).toFixed(2)} MB)`;
  renderFileList();
  syncKnobs();
  showGuesses();
  /* 当前尺寸与文件大小对不上时才自动套用推断结果。
   * 注意要带上 stride 一起算 —— 文件名已给出 640x480 + stride1344 时,
   * 紧凑尺寸自然对不上,不能因此把用户/文件名给的尺寸改掉。*/
  if (curFmt() !== 'jpeg') {
    const { w, h } = curSize();
    const stride = +el.stride.value || 0;
    if (D.expectedBytes(curFmt(), w, h, stride) !== f.bytes.length) {
      const g = D.guessSizes(f.bytes.length, curFmt(), 1)[0];
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
    arr.push({ name: file.name, bytes: new Uint8Array(buf) });
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

  // 数据不够就补零,让用户至少看到已有的部分(排查截断的 dump 很有用)
  let bytes = f.bytes.subarray(Math.min(off, f.bytes.length));
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
    const blob = new Blob([f.bytes.subarray(off)], { type: 'image/jpeg' });
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
  else if (k === '[') selectFile(S.cur - 1);
  else if (k === ']') selectFile(S.cur + 1);
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
syncKnobs();
syncSizeInfo();
