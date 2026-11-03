#!/usr/bin/env node
/* 用无头 Chrome 的 DevTools 协议做一次端到端冒烟:
   加载页面 → 等示例图算完 → 抓 console 报错 → 点几个交互 → 截图。

   node smoke.js [--headful] [--shot out.png]
   不需要装 puppeteer,直接说 DevTools 协议。
*/
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const HERE = __dirname;
const PAGE = 'file:///' + path.join(HERE, 'scale-compare.html').replace(/\\/g, '/');
const PORT = 9333;

const argv = process.argv.slice(2);
const HEADFUL = argv.includes('--headful');
const shotIdx = argv.indexOf('--shot');
const SHOT = shotIdx >= 0 ? argv[shotIdx + 1] : path.join(require('os').tmpdir(), 'scale-smoke.png');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function findBrowser() {
  for (const b of BROWSERS) if (fs.existsSync(b)) return b;
  throw new Error('找不到 Chrome / Edge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJSON(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForDevtools(tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { return await httpGetJSON('/json/version'); } catch { await sleep(100); }
  }
  throw new Error('DevTools 没起来');
}

/* 极简 CDP 客户端 */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        const c = new CDP(ws);
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.id && c.waiting.has(msg.id)) {
            const { res, rej } = c.waiting.get(msg.id);
            c.waiting.delete(msg.id);
            msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
          } else if (msg.method) c.events.push(msg);
        };
        resolve(c);
      };
      ws.onerror = (e) => reject(new Error('ws 连接失败'));
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr, opts) {
    const r = await this.send('Runtime.evaluate', Object.assign({
      expression: expr, returnByValue: true, awaitPromise: true,
    }, opts || {}));
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

(async () => {
  const userDir = path.join(require('os').tmpdir(), 'scale-smoke-' + process.pid);
  const args = [
    HEADFUL ? '--headless=false' : '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDir,
    '--allow-file-access-from-files',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,900',
    'about:blank',
  ];
  const proc = spawn(findBrowser(), args, { stdio: 'ignore' });

  let fails = 0;
  const ok = (cond, msg, extra) => {
    if (cond) console.log('  ✓ ' + msg);
    else { fails++; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
  };

  try {
    await waitForDevtools();
    const list = await httpGetJSON('/json/list');
    const target = list.find((t) => t.type === 'page');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    console.log('页面: ' + PAGE);
    await cdp.send('Page.navigate', { url: PAGE });
    await sleep(2500);   // 等示例图解码 + 三次缩放算完

    /* 只把真正的 error / 未捕获异常算失败;warning 单独列出来供参考(Chrome 的
       willReadFrequently 提示是本测试自己反复 getImageData 触发的,不是页面的问题)。 */
    const all = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' || e.method === 'Log.entryAdded')
      .map((e) => e.method === 'Runtime.exceptionThrown'
        ? { lvl: 'error', text: (e.params.exceptionDetails.exception || {}).description || e.params.exceptionDetails.text }
        : { lvl: e.params.entry.level, text: e.params.entry.text })
      .filter((e) => e.text && !/DevTools/.test(e.text));
    const errs = all.filter((e) => e.lvl === 'error');
    const warns = all.filter((e) => e.lvl !== 'error');
    ok(errs.length === 0, '无 console 错误', errs.map((e) => e.text).join('\n      '));
    errs.forEach((e) => console.log('      ! ' + e.text));
    warns.forEach((e) => console.log('      · 警告: ' + e.text));

    console.log('\n[载入]');
    const st0 = await cdp.eval(`(function(){
      return {
        srcInfo: document.getElementById('srcInfo').textContent.trim(),
        dstInfo: document.getElementById('dstInfo').textContent.trim(),
        metrics: document.getElementById('metricsBody').textContent.replace(/\\s+/g,' ').trim(),
        capA: document.getElementById('capAText').textContent,
        capB: document.getElementById('capBText').textContent,
        cvA: [cvA.width, cvA.height],
        cvB: [cvB.width, cvB.height],
      };
    })()`);
    console.log('  源: ' + st0.srcInfo);
    console.log('  目标: ' + st0.dstInfo);
    console.log('  指标: ' + st0.metrics);
    ok(/466 × 466/.test(st0.srcInfo), '内置示例图已载入 (466×466)');
    ok(/294×294/.test(st0.dstInfo), '0.63 倍 → 294×294');
    ok(st0.capA.includes('最近邻') && st0.capB.includes('双线性'), '默认 A=最近邻 B=双线性');
    ok(st0.cvA[0] > 0 && st0.cvB[0] > 0, '两块画布已按尺寸初始化 ' + JSON.stringify([st0.cvA, st0.cvB]));

    // 画布确实画上了东西(抽样非空)
    const painted = await cdp.eval(`(function(){
      const probe = (cv) => {
        const c = cv.getContext('2d');
        const d = c.getImageData(0,0,cv.width,cv.height).data;
        let n = 0;
        for (let i=3;i<d.length;i+=4*97) if (d[i] > 0) n++;
        return n;
      };
      return [probe(cvA), probe(cvB)];
    })()`);
    ok(painted[0] > 10 && painted[1] > 10, '两块画布都有内容 ' + JSON.stringify(painted));

    console.log('\n[改倍数 0.25]');
    await cdp.eval(`(()=>{ const r=document.getElementById('factorRange'); r.value='0.25'; r.dispatchEvent(new Event('input')); })()`);
    await sleep(400);
    const st1 = await cdp.eval(`({ dst: document.getElementById('dstInfo').textContent.trim(),
                                      val: document.getElementById('factorVal').textContent.trim() })`);
    console.log('  ' + st1.val + ' → ' + st1.dst);
    ok(/117×117/.test(st1.dst), '0.25 倍 → 117×117');
    ok(st1.val.startsWith('0.25'), '大数字同步');

    console.log('\n[切回 0.63 + 叠加模式 + 差异图]');
    await cdp.eval(`(()=>{
      const r=document.getElementById('factorRange'); r.value='0.63'; r.dispatchEvent(new Event('input'));
      document.querySelector('#viewMode button[data-v=split]').click();
    })()`);
    await sleep(500);
    const st2 = await cdp.eval(`({
      splitter: getComputedStyle(document.getElementById('splitter')).display,
      wrapB: getComputedStyle(document.getElementById('wrapB')).display,
    })`);
    ok(st2.splitter !== 'none', '叠加模式显示分割线');
    ok(st2.wrapB === 'none', '叠加模式隐藏右侧画布');

    await cdp.eval(`(()=>{
      const c=document.getElementById('diffOn'); c.checked=true; c.dispatchEvent(new Event('change'));
    })()`);
    await sleep(500);
    const diffNonEmpty = await cdp.eval(`(function(){
      const c = cvA.getContext('2d');
      const d = c.getImageData(0,0,cvA.width,cvA.height).data;
      let n=0; for (let i=0;i<d.length;i+=4) if (d[i] > 8 && d[i+1] === d[i] && d[i+2] === d[i]) n++;
      return n;
    })()`);
    ok(diffNonEmpty > 100, '差异图渲染出非零灰度差异 (' + diffNonEmpty + ' px)');

    // 基准切成「另一侧」后,叠加模式下左右必须是不同的图
    await cdp.eval(`(()=>{
      const s=document.getElementById('diffRef'); s.value='other'; s.dispatchEvent(new Event('change'));
    })()`);
    await sleep(700);
    const splitDiff = await cdp.eval(`(function(){
      const c = cvA.getContext('2d');
      const w = cvA.width, h = cvA.height;
      const L = c.getImageData(0, 0, (w*0.4)|0, h).data;
      const R = c.getImageData((w*0.6)|0, 0, (w*0.4)|0, h).data;
      let same = 0, lsum = 0, rsum = 0;
      for (let i=0;i<L.length;i+=4) { lsum += L[i]; }
      for (let i=0;i<R.length;i+=4) { rsum += R[i]; }
      return { lsum, rsum };
    })()`);
    ok(splitDiff.lsum > 0 && splitDiff.rsum > 0, '两侧差异图都非空 ' + JSON.stringify(splitDiff));
    await cdp.eval(`(()=>{
      const s=document.getElementById('diffRef'); s.value='area'; s.dispatchEvent(new Event('change'));
    })()`);

    console.log('\n[并排 + 交换左右]');
    await cdp.eval(`(()=>{
      const c=document.getElementById('diffOn'); c.checked=false; c.dispatchEvent(new Event('change'));
      document.querySelector('#viewMode button[data-v=side]').click();
    })()`);
    await sleep(400);
    await cdp.eval(`document.getElementById('btnSwap').click()`);
    await sleep(400);
    const st3 = await cdp.eval(`({ a: document.getElementById('capAText').textContent,
                                     b: document.getElementById('capBText').textContent })`);
    ok(st3.a.includes('双线性') && st3.b.includes('最近邻'), '交换后 A=双线性 B=最近邻');

    console.log('\n[缩放交互]');
    await cdp.eval(`document.querySelector('#zoomChips button[data-z="8"]').click()`);
    await sleep(300);
    const z8 = await cdp.eval(`document.getElementById('capAZoom').textContent`);
    ok(z8 === '8×', '8× 缩放生效 (' + z8 + ')');
    await cdp.eval(`document.getElementById('cvA').dispatchEvent(new WheelEvent('wheel',{deltaY:-300,clientX:600,clientY:400,bubbles:true,cancelable:true}))`);
    await sleep(300);
    const zAfter = await cdp.eval(`document.getElementById('capAZoom').textContent`);
    ok(zAfter !== '8×', '滚轮缩放生效 → ' + zAfter);
    await cdp.eval(`document.querySelector('#zoomChips button[data-z="fit"]').click()`);
    await sleep(300);

    console.log('\n[放大镜]');
    const lr = await cdp.eval(`(function(){
      const r = document.getElementById('cvA').getBoundingClientRect();
      document.getElementById('cvA').dispatchEvent(new PointerEvent('pointermove',
        {clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles: true}));
      return null;
    })()`);
    await sleep(300);
    const loupe = await cdp.eval(`({ d: getComputedStyle(document.getElementById('loupe')).display,
                                     t: document.getElementById('loupeCoord').textContent.trim() })`);
    ok(loupe.d === 'block', '放大镜出现');
    ok(/输出 \d+,\d+/.test(loupe.t), '放大镜坐标: ' + loupe.t.replace(/\s+/g, ' '));

    console.log('\n[算法下拉互斥]');
    await cdp.eval(`(()=>{ const s=document.getElementById('algoA'); s.value='bilinear'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(300);
    const mx = await cdp.eval(`({ a: document.getElementById('algoA').value, b: document.getElementById('algoB').value })`);
    ok(mx.a !== mx.b, '两边算法不会相同 (' + mx.a + ' / ' + mx.b + ')');

    console.log('\n[截图]');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  → ' + SHOT + '  (' + (fs.statSync(SHOT).size / 1024).toFixed(1) + ' KB)');
  } catch (e) {
    fails++;
    console.error('\n致命: ' + (e && e.stack || e));
  } finally {
    try { proc.kill(); } catch {}
  }

  console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 全部通过');
  process.exit(fails ? 1 : 0);
})();
