"use strict";
/*
 * headless Chrome 端到端验证(开发期用,不属于工具本身)
 *
 *   node _e2e.js
 *
 * 用 CDP 把 rotate-crop.js 在真实浏览器里跑一遍:造一张四环棋盘图,
 * 走同一条 renderSprite 管线,再把每个环带的像素统计出来 ——
 * Node 里的假 canvas 验的是「取景矩形算得对」,这里验的是「浏览器真画出来是什么」。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = path.join(__dirname, '_e2e');
const PORT = 9333 + (process.pid % 500);   // 别撞上上一次没退干净的实例
fs.mkdirSync(OUT, { recursive: true });

// profile 放系统临时目录:留在仓库里会被 git 看见,而且关不干净时删不掉
const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rotatecrop-e2e-'));
const chrome = cp.spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', 'about:blank'
], { stdio: 'ignore' });

const node = path.join(__dirname, 'rotate-crop.js');

const PAGE_JS = `(() => {
  const NS = window.__RC;
  const REF = NS.REF, ODD = NS.SPRITE.odd, EVEN = NS.SPRITE.even;

  // 1) 造图:455×455 短边,四环各自一个色相,环外留一圈另色,
  //    这样按颜色就能反推「这个像素来自哪个环」
  function makeSource(iw, ih) {
    const c = document.createElement('canvas');
    c.width = iw; c.height = ih;
    const x = c.getContext('2d');
    const s = Math.min(iw, ih), cx = iw / 2, cy = ih / 2;
    // 长短边不等时,短边之外补一个显眼的洋红,用来验证「先按短边居中裁方」
    x.fillStyle = '#ff00ff'; x.fillRect(0, 0, iw, ih);
    const rings = [
      [1.0, '#ff0000'],   // 环外角落(圆外)
      [0.5,  '#00ff00'],  // 外环
      [0.375,'#0000ff'],  // 2 环
      [0.25, '#ffff00'],  // 3 环
      [0.125,'#00ffff']   // 内圆
    ];
    rings.forEach(([r, col], i) => {
      x.beginPath();
      // r 是半径占画布边长的比例:0.5 → 半径 = 半个边长(文档 rotate 表的口径)
      x.arc(cx, cy, r * s, 0, Math.PI * 2);
      x.fillStyle = col; x.fill();
    });
    return c;
  }

  // 2) 按颜色分类统计输出图
  const NAME = { '0,255,0': '外环', '0,0,255': '2环', '255,255,0': '3环',
                 '0,255,255': '内圆', '255,0,0': '环外', '255,0,255': '短边外' };
  function classify(ctx, size, spec) {
    const d = ctx.getImageData(0, 0, size, size).data;
    const stat = {}; let opaque = 0, partial = 0, clear = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const a = d[i + 3];
        if (a === 0) clear++; else if (a === 255) opaque++; else partial++;
        // spec.bands 已归一化到「贴图边长」,而 d/size 也归一化到贴图边长,直接比
        const rr = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / size;
        const bi = spec.bands.findIndex(([a0, a1]) => rr >= a0 && rr <= a1);
        if (bi < 0) continue;
        const key = 'band' + bi + ':' + (a === 0 ? '透明' : (NAME[d[i] + ',' + d[i + 1] + ',' + d[i + 2]] || ('其他')));
        stat[key] = (stat[key] || 0) + 1;
      }
    }
    return { stat, opaque, partial, clear };
  }

  const out = {};

  // --- 正方形源 ---
  {
    const src = makeSource(455, 455);
    const res = NS.renderSprite((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }, src, ODD, {});
    out.square = { size: res.size, rect: res.rect, ...classify(res.canvas.getContext('2d'), res.size, ODD) };
    out.squarePNG = res.canvas.toDataURL('image/png');
  }

  // --- 非正方形源:洋红只该在取景框外 ---
  {
    const src = makeSource(800, 455);
    const res = NS.renderSprite((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }, src, ODD, {});
    out.wide = { size: res.size, rect: res.rect, ...classify(res.canvas.getContext('2d'), res.size, ODD) };
  }

  // --- 外环组:切分必须与 2 环组互补 ---
  {
    const src = makeSource(455, 455);
    const res = NS.renderSprite((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }, src, EVEN, {});
    out.even = { size: res.size, ...classify(res.canvas.getContext('2d'), res.size, EVEN) };
    out.evenPNG = res.canvas.toDataURL('image/png');
  }

  // --- 旋转后的样子:角度 45° 时圆形遮罩仍然内切方图 ---
  {
    const src = makeSource(455, 455);
    const res = NS.renderSprite((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }, src, ODD, {});
    const size = res.size;
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const x = c.getContext('2d');
    x.translate(size / 2, size / 2);
    x.rotate(NS.angleAt(ODD, 0.5));
    x.drawImage(res.canvas, -size / 2, -size / 2);
    out.rotatedPNG = c.toDataURL('image/png');
    out.rotated = classify(x, size, ODD);
  }
  // --- 非对称标记:验证旋转方向 / 角度 / 半径不变 ---
  // 同心环对旋转天然对称,测不出方向,所以另放两个偏心亮点。
  {
    const S = 455, cx = S / 2, cy = S / 2;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, S, S);
    x.fillStyle = '#ff0000';                                   // 2 环中段,0°(右方)
    x.beginPath(); x.arc(cx + 0.3125 * S, cy, 22, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#00ff00';                                   // 内圆,-90°(正上方)
    x.beginPath(); x.arc(cx, cy - 0.0625 * S, 12, 0, Math.PI * 2); x.fill();

    const measure = (canvas, size, col) => {
      const d = canvas.getContext('2d').getImageData(0, 0, size, size).data;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < size; y++) for (let xx = 0; xx < size; xx++) {
        const i = (y * size + xx) * 4;
        if (d[i + 3] > 128 && Math.abs(d[i] - col[0]) < 60 &&
            Math.abs(d[i + 1] - col[1]) < 60 && Math.abs(d[i + 2] - col[2]) < 60) { sx += xx; sy += y; n++; }
      }
      if (!n) return null;
      const dx = sx / n - size / 2, dy = sy / n - size / 2;
      return { deg: Math.atan2(dy, dx) * 180 / Math.PI, r: Math.hypot(dx, dy) / size, n };
    };

    const res = NS.renderSprite((w, h) => { const cc = document.createElement('canvas'); cc.width = w; cc.height = h; return cc; }, c, ODD, {});
    const size = res.size;
    const rc = document.createElement('canvas'); rc.width = rc.height = size;
    const rx = rc.getContext('2d');
    rx.translate(size / 2, size / 2);
    rx.rotate(NS.angleAt(ODD, 0.5));   // 0.5s → +45°
    rx.drawImage(res.canvas, -size / 2, -size / 2);

    out.marker = {
      size: size,
      base:  { red: measure(res.canvas, size, [255, 0, 0]), green: measure(res.canvas, size, [0, 255, 0]) },
      rot45: { red: measure(rc, size, [255, 0, 0]),         green: measure(rc, size, [0, 255, 0]) }
    };
    out.markerPNG = rc.toDataURL('image/png');
  }

  return out;
})()`;

(async () => {
  // 等 CDP 起来
  let list = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      list = await r.json();
      if (list.length) break;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!list) throw new Error('Chrome 没起来');

  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const nsrc = fs.readFileSync(node, 'utf8');
  const r1 = await send('Runtime.evaluate', { expression: nsrc + '\n;window.__RC = RotateCrop; "ok"', returnByValue: true });
  if (r1.result && r1.result.exceptionDetails) throw new Error(JSON.stringify(r1.result.exceptionDetails));

  const r2 = await send('Runtime.evaluate', { expression: PAGE_JS, returnByValue: true, awaitPromise: false });
  if (r2.result.exceptionDetails) {
    console.error('页面异常:', JSON.stringify(r2.result.exceptionDetails, null, 2));
    process.exit(1);
  }
  const out = r2.result.result.value;

  const rep = (name, o) => {
    console.log(`\n[${name}] size=${o.size} rect=${JSON.stringify(o.rect || null)}`);
    console.log(`  不透明 ${o.opaque} · 半透明 ${o.partial} · 全透明 ${o.clear}`);
    Object.entries(o.stat).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  };
  rep('正方形 455 → 内圆+2环', out.square);
  rep('800×455 → 内圆+2环', out.wide);
  rep('正方形 455 → 外环+3环', out.even);
  rep('45° 旋转后的 2 环组', out.rotated);

  console.log('\n[标记] 两组标记都在,且旋转 +45° 后各转 45°、半径不变');
  const m = out.marker;
  const fmt = (o) => o ? `${o.deg.toFixed(1)}° r=${o.r.toFixed(4)} n=${o.n}` : '未见';
  console.log('  正位   红(2环) ' + fmt(m.base.red) + '   绿(内圆) ' + fmt(m.base.green));
  console.log('  +45°   红(2环) ' + fmt(m.rot45.red) + '   绿(内圆) ' + fmt(m.rot45.green));

  for (const k of ['squarePNG', 'evenPNG', 'rotatedPNG', 'markerPNG']) {
    const b64 = out[k].split(',')[1];
    fs.writeFileSync(path.join(OUT, k.replace('PNG', '') + '.png'), Buffer.from(b64, 'base64'));
  }
  console.log('\n图已写入', OUT);

  // ---------- 页面本身:加载 + 模拟拖图,抓运行时异常 ----------
  {
    const errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description
          || m.params.exceptionDetails.text);
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
      }
    });
    const pageUrl = 'file:///' + path.join(__dirname, 'rotate-crop.html').replace(/\\/g, '/');
    await send('Page.navigate', { url: pageUrl });
    await new Promise((r) => setTimeout(r, 1200));

    const drive = `(() => {
      const c = document.createElement('canvas');
      c.width = c.height = 400;
      const x = c.getContext('2d');
      x.fillStyle = '#111111'; x.fillRect(0, 0, 400, 400);
      const disc = (r, col) => { x.fillStyle = col; x.beginPath(); x.arc(200, 200, r, 0, Math.PI * 2); x.fill(); };
      disc(0.375 * 400, '#00ff00');
      disc(0.25 * 400,  '#ff0000');
      disc(0.125 * 400, '#00ffff');
      return new Promise((resolve) => {
        c.toBlob((blob) => {
          const dt = new DataTransfer();
          dt.items.add(new File([blob], 'probe.png', { type: 'image/png' }));
          document.getElementById('stage').dispatchEvent(
            new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
          setTimeout(() => {
            const cv = document.getElementById('cropCv');
            const g = cv.getContext('2d');
            const mid = g.getImageData(Math.round(cv.width * 0.4), Math.round(cv.height / 2), 1, 1).data;
            resolve({
              cardsHidden: document.getElementById('cards').hidden,
              emptyHidden: document.getElementById('empty').hidden,
              cropSize: cv.width,
              srcSize: document.getElementById('srcCv').width,
              evenSize: document.getElementById('evenCv').width,
              imgName: document.getElementById('imgName').textContent,
              cropChip: document.getElementById('cropChip').textContent,
              evenChip: document.getElementById('evenChip').textContent,
              geo: document.getElementById('geo').textContent,
              saveEnabled: !document.getElementById('saveBtn').disabled,
              ringNote: document.getElementById('ringNote').textContent,
              center: Array.from(g.getImageData(cv.width / 2, cv.height / 2, 1, 1).data),
              ring2: Array.from(mid),
              corner: Array.from(g.getImageData(1, 1, 1, 1).data)
            });
          }, 500);
        }, 'image/png');
      });
    })()`;
    const r3 = await send('Runtime.evaluate', { expression: drive, awaitPromise: true, returnByValue: true });
    if (r3.result.exceptionDetails) errors.push(JSON.stringify(r3.result.exceptionDetails));
    const v = r3.result.result && r3.result.result.value;
    console.log('\n[页面] 模拟拖入 400×400 四环图');
    if (v) {
      console.log('  cards 显示 ' + !v.cardsHidden + ' · empty 隐藏 ' + v.emptyHidden);
      console.log('  ' + v.imgName + ' · ' + v.cropChip + ' · ' + v.evenChip + ' · 导出可用 ' + v.saveEnabled);
      console.log('  画布 crop ' + v.cropSize + ' · src ' + v.srcSize + ' · even ' + v.evenSize);
      console.log('  圆心像素(内圆)' + JSON.stringify(v.center) + ' · 2环 ' + JSON.stringify(v.ring2) + ' · 角落 ' + JSON.stringify(v.corner));
      console.log('  geo: ' + v.geo.replace(/\s+/g, ' '));
      console.log('  ringNote: ' + v.ringNote);
    } else {
      console.log('  !! 没有返回值');
    }
    if (errors.length) { console.log('  !! 运行时错误:'); errors.forEach((e) => console.log('     ' + e)); }
    else console.log('  运行时无异常 ✓');
  }

  // 先 Browser.close 走正常退出(profile 才会被释放),再兜底 kill
  const ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json().catch(() => null);
  if (ver) {
    const bws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r) => bws.addEventListener('open', r));
    bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise((r) => setTimeout(r, 700));
  }
  ws.close();
  try { chrome.kill(); } catch (_) {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error(e); try { chrome.kill(); } catch (_) {} process.exit(1); });
