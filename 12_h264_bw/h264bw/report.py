"""生成自包含的 HTML 报告（时间线 + 统计表 + 归因）。"""

import json

TEMPLATE = u"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>H.264 解码带宽分析 — %(title)s</title>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --fg:#e7eaf0; --dim:#8b93a5;
          --i:#e0603c; --p:#3f8fe0; --b:#3fbf8f; --grey:#4a5162; }
  * { box-sizing:border-box; }
  body { margin:0; padding:20px 24px 60px; background:var(--bg); color:var(--fg);
         font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",
         "PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; font-weight:600; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:18px; }
  .panel { background:var(--panel); border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  .row { display:flex; flex-wrap:wrap; gap:24px; }
  .kpi { min-width:150px; }
  .kpi .v { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; }
  .kpi .l { color:var(--dim); font-size:12px; }
  table { border-collapse:collapse; width:100%%; font-variant-numeric:tabular-nums; }
  th,td { text-align:right; padding:5px 10px; border-bottom:1px solid #262b36; }
  th:first-child, td:first-child { text-align:left; }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  canvas { width:100%%; height:340px; display:block; }
  .ctrl { display:flex; gap:14px; align-items:center; color:var(--dim); font-size:13px; margin-bottom:8px;}
  .ctrl label { cursor:pointer; }
  .tip { position:fixed; pointer-events:none; background:#000c; padding:6px 9px; border-radius:6px;
         font-size:12px; white-space:pre; opacity:0; transition:opacity .1s; }
  .legend { display:flex; gap:16px; font-size:12px; color:var(--dim); }
  .dot { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; }
  code { color:#9fd3ff; }
</style>
</head>
<body>
<h1>H.264 解码带宽分析</h1>
<div class="sub" id="sub"></div>

<div class="panel">
  <div class="row" id="kpis"></div>
</div>

<div class="panel">
  <div class="ctrl">
    <label><input type="radio" name="mode" value="stack" checked> 堆叠分解</label>
    <label><input type="radio" name="mode" value="ref"> 仅参考读取</label>
    <label><input type="radio" name="mode" value="total"> 总带宽</label>
    <span style="margin-left:auto" class="legend">
      <span><i class="dot" style="background:var(--i)"></i>I 帧</span>
      <span><i class="dot" style="background:var(--p)"></i>P 帧</span>
      <span><i class="dot" style="background:var(--b)"></i>B 帧</span>
      <span><i class="dot" style="background:#777"></i>P95</span>
    </span>
    <span style="margin-left:16px" class="legend">
      <span><i class="dot" style="background:#3f8fe0"></i>参考读取</span>
      <span><i class="dot" style="background:#e0603c"></i>码流读取</span>
      <span><i class="dot" style="background:#5b6273"></i>重建写回</span>
      <span><i class="dot" style="background:#3fbf8f"></i>MV 读写</span>
    </span>
  </div>
  <canvas id="chart"></canvas>
  <div style="color:#8b93a5;font-size:12px">按解码顺序（DDR 看到的就是这个顺序）。横轴 = 帧序号，纵轴 = 字节/帧。</div>
</div>

<div class="panel">
  <div style="font-weight:600;margin-bottom:8px">统计</div>
  <table id="stats"></table>
</div>

<div class="panel">
  <div style="font-weight:600;margin-bottom:8px">峰值帧归因</div>
  <div id="attrib"></div>
</div>

<div class="panel">
  <div style="font-weight:600;margin-bottom:8px">逐帧明细</div>
  <div style="max-height:420px;overflow:auto"><table id="frames"></table></div>
</div>

<div class="tip" id="tip"></div>
<script>
const DATA = %(data)s;
const F = DATA.fps, M = DATA.meta, S = DATA.summary;

function fmt(n) {
  if (n >= 1e9) return (n/1e9).toFixed(2)+'G';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'k';
  return String(Math.round(n));
}
document.title = 'H.264 解码带宽分析 — ' + M.file;
document.getElementById('sub').innerHTML =
  M.file + ' · ' + M.width + '×' + M.height + ' · ' + M.profile + '@L' + M.level +
  ' · ' + M.entropy_coding + (M.transform_8x8 ? ' · 8×8 变换' : ' · 4×4 变换') +
  ' · ' + (M.fps ? M.fps.toFixed(2) + ' fps · ' : '') + M.frames + ' 帧' +
  ' · 参考帧上限 ' + M.max_num_ref_frames;

// ---- KPI
const kpis = [
  ['平均总带宽', fmt(S.total.mean) , '字节/帧  →  ' + fmt(S.total.mean*(M.fps||0)) + ' B/s'],
  ['峰值总带宽', fmt(S.total.max), '字节/帧'],
  ['P95 / P99', fmt(S.total.p95) + ' / ' + fmt(S.total.p99), '字节/帧'],
  ['平均参考读取', fmt(S.ref.mean), '占总量 ' + (100*S.ref.mean/S.total.mean).toFixed(0) + '%%'],
  ['峰值参考读取', fmt(S.ref.max), '字节/帧'],
  ['MB 行级峰值', fmt(S.row_peak_max), '字节（单行）'],
];
if (S.window) {
  kpis.push(['1 秒窗口峰值',
             fmt(S.window.max),
             '字节/帧（窗口 ' + S.window.frames + ' 帧，把峰值摊平后）']);
}
if (M.level_ceiling) {
  let peakBs = 0;
  for (const f of F) if (f.bytes > peakBs) peakBs = f.bytes;
  kpis.push(['码流峰值 / Level 上限',
             (100 * peakBs / M.level_ceiling).toFixed(1) + '%%',
             fmt(peakBs) + ' / ' + fmt(M.level_ceiling) + ' 字节']);
}
document.getElementById('kpis').innerHTML = kpis.map(k =>
  '<div class="kpi"><div class="v">'+k[1]+'</div><div class="l">'+k[0]+'</div><div class="l">'+k[2]+'</div></div>'
).join('');

// ---- 统计表
const types = ['I','P','B'].filter(t => S.by_type[t]);
let html = '<tr><th>帧类型</th><th>帧数</th><th>平均总带宽</th><th>最大总带宽</th>' +
           '<th>平均参考读取</th><th>最大参考读取</th></tr>';
html += '<tr><td>全部</td><td>'+S.frames+'</td><td>'+fmt(S.total.mean)+'</td><td>'+fmt(S.total.max)+
        '</td><td>'+fmt(S.ref.mean)+'</td><td>'+fmt(S.ref.max)+'</td></tr>';
for (const t of types) {
  const n = F.filter(f=>f.type===t).length;
  html += '<tr><td>'+t+'</td><td>'+n+'</td><td>'+fmt(S.by_type[t].mean)+'</td><td>'+fmt(S.by_type[t].max)+
          '</td><td>'+fmt(S.by_type_ref[t].mean)+'</td><td>'+fmt(S.by_type_ref[t].max)+'</td></tr>';
}
document.getElementById('stats').innerHTML = html;

// ---- 峰值帧归因
let peak = F[0];
for (const f of F) if (f.total > peak.total) peak = f;
const parts = [
  ['码流读取', peak.bytes], ['重建写回', peak.wb_bytes],
  ['参考读取', peak.ref_bytes], ['MV 读写', peak.mv_bytes],
];
document.getElementById('attrib').innerHTML =
  '<div style="margin-bottom:10px">峰值帧：解码序号 <b>' + peak.index + '</b>（' + peak.type + ' 帧，显示序号 ' +
  peak.display_index + '），合计 <b>' + fmt(peak.total) + '</b> 字节</div>' +
  '<table><tr><th>项目</th><th>字节</th><th>占比</th></tr>' +
  parts.map(p => '<tr><td>'+p[0]+'</td><td>'+fmt(p[1])+'</td><td>'+
    (100*p[1]/peak.total).toFixed(1)+'%%</td></tr>').join('') +
  '<tr><td>归因分解：帧像素×1.5 × N_dir × K_interp</td><td colspan="2">' +
    fmt(peak.bytes) + ' 码流 + ' + fmt(M.width*M.height*1.5) + ' × ' + peak.n_dir.toFixed(2) +
    ' × ' + peak.k_interp.toFixed(3) + ' = ' + fmt(M.width*M.height*1.5*peak.n_dir*peak.k_interp) + '</td></tr>' +
  '<tr><td>N_dir（参考读取像素/帧像素）</td><td colspan="2">'+peak.n_dir.toFixed(2)+'</td></tr>' +
  '<tr><td>K_interp（实际/理想参考读取）</td><td colspan="2">'+peak.k_interp.toFixed(3)+'</td></tr>' +
  '<tr><td>面积占比：帧内 / 单向 / 双向</td><td colspan="2">'+
    (100*peak.area_intra).toFixed(0)+'%% / '+(100*peak.area_uni).toFixed(0)+'%% / '+
    (100*peak.area_bi).toFixed(0)+'%%</td></tr>' +
  '<tr><td>分区面积占比 16×16 / 16×8 / 8×16 / 8×8</td><td colspan="2">'+
    [peak.partitions['16x16'],peak.partitions['16x8'],peak.partitions['8x16'],peak.partitions['8x8']]
      .map(v=>(100*v).toFixed(0)+'%%').join(' / ')+'</td></tr>' +
  '<tr><td>分数 MV 面积：整数 / 仅水平 / 仅垂直 / 双向</td><td colspan="2">'+
    ['int','h','v','both'].map(k=>(100*peak.frac[k]).toFixed(0)+'%%').join(' / ')+'</td></tr>' +
  '<tr><td>MV 幅度均值（像素） / 相邻块离散度</td><td colspan="2">'+
    peak.mv_mag.toFixed(2)+' / '+peak.mv_disp.toFixed(2)+'</td></tr>';

// ---- 逐帧表
let fh = '<tr><th>解码序号</th><th>显示序号</th><th>类型</th><th>码流</th><th>重建</th>' +
         '<th>参考读取</th><th>MV</th><th>合计</th><th>N_dir</th><th>K_interp</th></tr>';
for (const f of F) {
  fh += '<tr><td>'+f.index+'</td><td>'+f.display_index+'</td><td>'+f.type+'</td><td>'+fmt(f.bytes)+
        '</td><td>'+fmt(f.wb_bytes)+'</td><td>'+fmt(f.ref_bytes)+'</td><td>'+fmt(f.mv_bytes)+
        '</td><td>'+fmt(f.total)+'</td><td>'+f.n_dir.toFixed(2)+'</td><td>'+f.k_interp.toFixed(3)+'</td></tr>';
}
document.getElementById('frames').innerHTML = fh;

// ---- 时间线
const cv = document.getElementById('chart');
const ctx = cv.getContext('2d');
const tip = document.getElementById('tip');
let mode = 'stack';
const TYPE_COLOR = {I:'#e0603c', P:'#3f8fe0', B:'#3fbf8f'};

function resize() {
  const r = cv.getBoundingClientRect();
  cv.width = r.width * devicePixelRatio;
  cv.height = 340 * devicePixelRatio;
  cv.style.height = '340px';
  draw();
}
window.addEventListener('resize', resize);

function series(f) {
  if (mode === 'ref') return [['ref', f.ref_bytes]];
  if (mode === 'total') return [['total', f.total]];
  return [['参考读取', f.ref_bytes], ['码流读取', f.bytes],
          ['重建写回', f.wb_bytes], ['MV 读写', f.mv_bytes]];
}
const STACK_COLORS = ['#3f8fe0','#e0603c','#5b6273','#3fbf8f'];

function draw() {
  const w = cv.width, h = cv.height, dpr = devicePixelRatio;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const W = w/dpr, H = h/dpr;
  ctx.clearRect(0,0,W,H);
  const padL = 62, padR = 12, padT = 12, padB = 26;
  const cw = W - padL - padR, ch = H - padT - padB;
  let maxV = 0;
  for (const f of F) {
    const s = series(f);
    let sum = 0; for (const x of s) sum += x[1];
    maxV = Math.max(maxV, mode === 'stack' ? sum : s[0][1]);
  }
  maxV *= 1.08;
  const n = F.length;
  const bw = Math.max(1, cw / n);
  const y = v => padT + ch - ch * v / maxV;

  // 网格
  ctx.strokeStyle = '#262b36'; ctx.fillStyle = '#8b93a5';
  ctx.font = '11px system-ui'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W-padR, yy); ctx.stroke();
    ctx.fillText(fmt(v), padL-8, yy+4);
  }

  // 柱
  for (let i = 0; i < n; i++) {
    const f = F[i], s = series(f);
    const x = padL + cw * i / n;
    let acc = 0;
    for (let k = 0; k < s.length; k++) {
      const v = s[k][1];
      if (v <= 0) continue;
      ctx.fillStyle = (mode === 'stack') ? STACK_COLORS[k] : TYPE_COLOR[f.type] || '#888';
      const y0 = y(acc + v), y1 = y(acc);
      ctx.fillRect(x, y0, Math.max(1, bw-0.6), Math.max(0.6, y1-y0));
      acc += v;
    }
    if (mode !== 'stack') {   // 顶部按帧类型点一下
      ctx.fillStyle = TYPE_COLOR[f.type] || '#888';
      ctx.fillRect(x, y(acc)-2, Math.max(1,bw-0.6), 2);
    }
  }

  // P95 线
  const p95 = (mode === 'ref') ? S.ref.p95 : S.total.p95;
  ctx.strokeStyle = '#777'; ctx.setLineDash([4,4]);
  ctx.beginPath(); ctx.moveTo(padL, y(p95)); ctx.lineTo(W-padR, y(p95)); ctx.stroke();
  ctx.setLineDash([]);


  ctx.fillStyle = '#8b93a5'; ctx.textAlign = 'left';
  ctx.fillText('解码顺序 →', padL, H-8);
  ctx.textAlign = 'right';
  ctx.fillText('字节/帧', W-padR, H-8);
}

cv.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left;
  const padL = 62, padR = 12;
  const cw = r.width - padL - padR;
  const i = Math.floor((x - padL) / cw * F.length);
  if (i < 0 || i >= F.length) { tip.style.opacity = 0; return; }
  const f = F[i];
  tip.style.opacity = 1;
  tip.style.left = (e.clientX + 12) + 'px';
  tip.style.top = (e.clientY + 12) + 'px';
  tip.textContent = ['解码 #' + f.index + ' (' + f.type + ', 显示 #' + f.display_index + ')',
    '合计 ' + fmt(f.total), '参考读取 ' + fmt(f.ref_bytes),
    '码流 ' + fmt(f.bytes),
    'N_dir ' + f.n_dir.toFixed(2) + '  K_interp ' + f.k_interp.toFixed(3)
  ].join(String.fromCharCode(10));
});
cv.addEventListener('mouseleave', () => tip.style.opacity = 0);

document.querySelectorAll('input[name=mode]').forEach(el =>
  el.addEventListener('change', e => { mode = e.target.value; draw(); }));

resize();
</script>
</body>
</html>
"""


def build_html(result):
    return TEMPLATE % {
        "title": result["meta"]["file"],
        "data": json.dumps(result, ensure_ascii=False),
    }
