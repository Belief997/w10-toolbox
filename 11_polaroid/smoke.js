#!/usr/bin/env node
/* 无头 Chrome 冒烟测试:加载页面 → 等 WebGPU 就绪 → 抓 console 错误
   → 开舱门 → 截图。

   node smoke.js [--shots] [--out dir]
   不需要 puppeteer,直接用 DevTools 协议。
*/
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const HERE = __dirname;
const PORT = 9333 + (process.pid % 200);
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > -1 ? path.resolve(process.argv[i + 1]) : path.join(HERE, '_shots');
})();

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

async function waitForDevtools(tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { return await httpGetJSON('/json/version'); } catch { await sleep(100); }
  }
  throw new Error('DevTools 没起来');
}

/* 极简 CDP 客户端(基于原生 WebSocket,Node 22+) */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', () => reject(new Error('ws 连接失败')));
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      // 每条 CDP 调用都要有超时,否则某个调用挂住会拖死整个脚本
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`CDP ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);

      this.waiting.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

/* 静态服务器(项目根,支持 importmap 需要的 .js MIME) */
function serve(root) {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('404'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------------------------------------------------------
 * 进程清理
 *
 * 坑:proc.kill() 在 Windows 上只终止主进程,Chrome 的渲染/GPU/utility
 * 子进程会全部变成孤儿继续跑。必须用 taskkill /T 杀整棵进程树。
 * ------------------------------------------------------- */
const IS_WIN = process.platform === 'win32';

function killTree(pid) {
  if (!pid) return;
  try {
    if (IS_WIN) {
      require('child_process').execFileSync(
        'taskkill', ['/PID', String(pid), '/T', '/F'],
        { stdio: 'ignore', timeout: 10000 },
      );
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* 进程可能已经退出 */ }
}

/* 列出所有 CommandLine 匹配给定正则的 chrome 进程 */
function listChrome(patterns) {
  if (!IS_WIN) return [];
  try {
    const ps = [
      'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'"',
      '| Select-Object ProcessId,ParentProcessId,CommandLine',
      '| ConvertTo-Json -Compress',
    ].join(' ');
    const out = require('child_process').execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 20000 },
    );
    const raw = JSON.parse(out.trim() || '[]');
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter((p) => {
      const cl = p.CommandLine || '';
      return patterns.every((re) => re.test(cl));
    });
  } catch {
    return [];
  }
}

/* 一次查询拿到所有 chrome 进程,按 pred 过滤后整棵树杀掉。
 * 先杀主进程(--type= 的是子进程,taskkill /T 会连带),
 * 万一主进程已经没了,直接杀子进程兜底。单次查询,避免反复调 PowerShell。 */
function killChromeWhere(pred) {
  const procs = listChrome([]).filter(pred);
  if (!procs.length) return 0;

  const mains = procs.filter((p) => !/--type=/.test(p.CommandLine || ''));
  for (const p of (mains.length ? mains : procs)) killTree(p.ProcessId);

  return procs.length;
}

/* Chrome 在 Windows 上会 fork 出新进程后让启动器退出,
 * 所以 spawn 到的 pid 往往已经死了 —— 用 profile 路径(唯一)来定位。 */
function killByProfile(userData) {
  const esc = userData.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const re = new RegExp(esc);
  return killChromeWhere((p) => re.test(p.CommandLine || ''));
}

/* 清理之前跑挂留下的 pol-* 浏览器进程 */
function killStaleChrome() {
  return killChromeWhere((p) => /pol-/.test(p.CommandLine || ''));
}

/* 先杀进程再删目录 —— 顺序反了会制造僵尸进程 */
function cleanStale() {
  const tmp = require('os').tmpdir();
  const killed = killStaleChrome();
  // 等 Chrome 真正释放句柄,否则目录删不干净
  if (killed) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);

  let dirs = 0;
  for (const d of fs.readdirSync(tmp)) {
    if (!d.startsWith('pol-')) continue;
    try { fs.rmSync(path.join(tmp, d), { recursive: true, force: true }); dirs++; } catch {}
  }
  return { killed, dirs };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // 硬性超时兜底:任何情况下都不让脚本挂着占资源
  const HARD_TIMEOUT = 120000;
  const watchdog = setTimeout(() => {
    console.error(`\n超时 ${HARD_TIMEOUT / 1000}s,强制退出并清理进程`);
    process.exit(3);
  }, HARD_TIMEOUT);
  watchdog.unref();

  const { killed, dirs } = cleanStale();
  if (killed.length) console.log(`→ 清理残留浏览器进程: ${killed.length} 个`);
  if (dirs) console.log(`→ 清理残留 profile: ${dirs} 个`);
  const browser = findBrowser();
  const userData = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pol-'));
  const { server, port: webPort } = await serve(HERE);

  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
    '--headless=new',
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,900',
    // WebGPU 在无头环境下的开关
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer',
    '--use-angle=vulkan',
    '--use-vulkan=swiftshader',
    '--disable-vulkan-surface',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    'about:blank',
  ];

  // 捕获浏览器 stderr,DevTools 起不来时能看到原因
  const proc = spawn(browser, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: !IS_WIN,   // POSIX 上建进程组,便于整组杀
  });
  let browserErr = '';
  proc.stderr.on('data', (c) => { browserErr += c.toString(); });
  proc.on('exit', (code) => {
    if (code && !browserErr) browserErr = `chrome 退出码 ${code}`;
  });

  /* 幂等清理:正常结束、异常、Ctrl+C、超时都要走这里。
   * 按 profile 路径定位进程 —— Chrome 在 Windows 会换进程,
   * proc.pid 指向的启动器往往早就退出了。 */
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    killByProfile(userData);      // 杀干净这次运行产生的所有 chrome 进程
    try { proc.kill('SIGKILL'); } catch {}
    try { server.close(); } catch {}
    // Chrome 释放句柄需要一点时间
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
  };

  // 覆盖所有退出路径 —— 只挂 'exit' 的话 Ctrl+C / 未捕获异常都会漏掉
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  process.on('SIGHUP', () => { cleanup(); process.exit(129); });
  process.on('uncaughtException', (e) => {
    console.error('未捕获异常:', e);
    cleanup();
    process.exit(2);
  });

  try {
    await waitForDevtools();
  } catch (e) {
    console.error('DevTools 启动失败。浏览器输出:\n' + (browserErr || '(无)').slice(0, 1500));
    throw e;
  }
  const tabs = await httpGetJSON('/json/list');
  const page = tabs.find((t) => t.type === 'page');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);

  const logs = [];
  const errors = [];
  cdp.events.length = 0;
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  // 收集 console / 异常
  const pump = setInterval(() => {
    while (cdp.events.length) {
      const e = cdp.events.shift();
      if (e.method === 'Runtime.consoleAPICalled') {
        const txt = (e.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        logs.push(`[${e.params.type}] ${txt}`);
        if (e.params.type === 'error') errors.push(txt);
      } else if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        errors.push(d.exception?.description || d.text);
      } else if (e.method === 'Log.entryAdded') {
        const en = e.params.entry;
        logs.push(`[log:${en.level}] ${en.text}` +
          (en.url ? `  (${en.url.split('/').pop()})` : ''));
        // favicon 由浏览器在导航前自动请求,不属于页面问题
        if (en.level === 'error' && !/favicon\.ico/.test(en.url || '')) errors.push(en.text);
      }
    }
  }, 60);

  const url = `http://127.0.0.1:${webPort}/index.html`;
  console.log('→ 打开', url);
  await cdp.send('Page.navigate', { url });

  // 等页面跑起来
  await sleep(2500);

  // 模块加载诊断:确认 importmap 解析和入口模块执行到了哪一步
  const diag = await cdp.eval(`(async () => {
    const out = { steps: [] };
    out.steps.push('bootMsg=' + (document.getElementById('bootMsg')?.textContent || '?'));
    out.steps.push('bootClass=' + (document.getElementById('boot')?.className || ''));
    out.steps.push('hasGlobal=' + !!window.__polaroid);
    try {
      const t = await import('./lib/three.webgpu.js');
      out.threeOk = true;
      out.threeRev = t.REVISION || '?';
    } catch (e) { out.threeOk = false; out.threeErr = String(e).slice(0, 300); }
    try {
      const m = await import('./src/main.js');
      out.mainOk = true;
    } catch (e) { out.mainOk = false; out.mainErr = String(e).slice(0, 400); }
    return out;
  })()`);
  console.log('→ 诊断', JSON.stringify(diag, null, 1));

  // 1) WebGPU 能力探测
  const gpu = await cdp.eval(`(async () => {
    if (!navigator.gpu) return { ok:false, why:'navigator.gpu 不存在' };
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) return { ok:false, why:'没有可用 adapter' };
      const info = a.info || {};
      return { ok:true, vendor: info.vendor||'', arch: info.architecture||'', desc: info.description||'' };
    } catch (e) { return { ok:false, why:String(e) }; }
  })()`);

  // 2) 等页面就绪(首帧渲染完才会设 __polaroid 并隐藏 boot)
  let ready = { ok: false };
  for (let i = 0; i < 60; i++) {
    ready = await cdp.eval(`(() => {
      const p = window.__polaroid;
      const bootEl = document.getElementById('boot');
      if (!p || !bootEl?.classList.contains('done')) {
        return { ok:false, boot: document.getElementById('bootMsg')?.textContent || '' };
      }
      let n = 0; p.product.root.traverse(o => { if (o.isMesh) n++; });
      return { ok:true, meshes:n,
               backend: p.stage.renderer.backend?.constructor?.name || '?',
               bootDone: true };
    })()`);
    if (ready.ok) break;
    await sleep(200);
  }

  // 3) 开舱门,等动画
  if (ready.ok) {
    await cdp.eval(`document.getElementById('btnDoor').click(), true`);
    await sleep(1400);
  }

  // 4) 截图
  const shots = [];
  async function shot(name) {
    // WebGPU 每帧都在画,captureScreenshot 偶尔会等不到稳定帧。
    // 先让页面停一帧,再截图,并给足超时。
    try {
      await cdp.eval(`(window.__polaroid.pauseRender = true, 1)`, false);
      await sleep(220);
    } catch {}
    try {
      const r = await cdp.send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false }, 20000);
      const f = path.join(OUT, name + '.png');
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      shots.push(f);
      return f;
    } finally {
      try { await cdp.eval(`(window.__polaroid.pauseRender = false, 1)`, false); } catch {}
    }
  }

  if (ready.ok) {
    const view = (az, po, dist) => cdp.eval(
      `(() => { const p=window.__polaroid, o=p.orbit;
         o.azimuth=${az}; o.polar=${po}; o.distance=${dist};
         p.autoSpinOff && p.autoSpinOff(); return 1; })()`);

    // 门已开:稍微抬高视角,同时看到相纸画面和顶口
    await view(0.16, 0.88, 23);
    await sleep(600);
    const f1 = await shot('01-door-open');

    // 高俯视看内腔(检查顶面开口是否真被清空)
    await view(0.30, 0.30, 20);
    await sleep(500);
    await shot('01b-cavity-top');

    // 3/4 视角:门、挂耳、色带
    await view(0.72, 1.10, 25);
    await sleep(500);
    await shot('02-three-quarter');

    // 正前方(门关)
    await cdp.eval(`document.getElementById('btnDoor').click(), true`);
    await sleep(1300);
    await view(0.02, 1.46, 24);
    await sleep(500);
    await shot('02-front-closed');

    // 顶面俯视:按钮、挂耳、门缝
    await view(0.42, 0.60, 21);
    await sleep(600);
    await shot('03-top');

    // 背面
    await view(3.05, 1.28, 25);
    await sleep(600);
    await shot('04-back');

    console.log('→ 截图', f1);
  }

  clearInterval(pump);
  await sleep(200);

  // 先关掉 CDP 连接和页面,让 Chrome 有机会自己收尾
  try { cdp.close(); } catch {}
  try { await cdp.send('Browser.close'); } catch {}
  await sleep(400);

  /* ---------- 报告 ---------- */
  const line = '─'.repeat(56);
  console.log('\n' + line);
  console.log('WebGPU      :', gpu.ok ? `OK  ${gpu.vendor} ${gpu.arch}` : `不可用 — ${gpu.why}`);
  console.log('页面就绪    :', ready.ok ? `OK  后端=${ready.backend}  网格=${ready.meshes}` : `未就绪 — ${ready.boot}`);
  console.log('控制台错误  :', errors.length);

  if (logs.length) {
    console.log('\n控制台输出:');
    logs.slice(-25).forEach((l) => console.log('  ' + l));
  }
  if (errors.length) {
    console.log('\n错误:');
    errors.forEach((e) => console.log('  ✗ ' + e));
  }
  console.log(line);

  cdp.close();
  cleanup();

  const pass = gpu.ok && ready.ok && errors.length === 0;
  console.log(pass ? '结果: 通过 ✓' : '结果: 失败 ✗');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  // cleanup 已在 process 的事件里注册,这里触发 exit 让它跑
  process.exit(2);
});
