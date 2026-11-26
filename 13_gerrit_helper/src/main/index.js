'use strict';

// 主进程入口：装配 store / gerrit 客户端 / 轮询 / 三块 surface / 托盘 / 设置窗。

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const {
  app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, globalShortcut,
  ipcMain, nativeImage, powerMonitor, powerSaveBlocker, screen, session, shell
} = require('electron');

const { createLogger } = require('./log');
const store = require('./store');
const { collect, toConfigPatch } = require('./discovery');
const { readCookieHeader } = require('./credentials');
const { createClient } = require('./gerrit/client');
const { createSshClient, sshAvailable } = require('./gerrit/ssh');
const { createJenkinsClient } = require('./jenkins/client');
const { createBackdrop } = require('./backdrop');
const { createDock } = require('./dock');
const { roundedRectCommands, toSvgPath } = require('./surfaces');
const { createPoller } = require('./poller');
const { createNotifier } = require('./notify');
const { diffCells, sortCells } = require('../shared/diff');
const { muteKey, mutedKeySet, toHomeItem } = require('../shared/home-list');
const { toCell } = require('../shared/model');
const { withRecency } = require('../shared/recency');
const { buildMessageText, shouldSendWeChat } = require('../shared/build-message');
const { send: sendWeChat } = require('../wechat');
const { sanitizeImport, summarize, toExportable } = require('../shared/config-io');
const demo = require('./demo');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const DOCK_PRELOAD = path.join(__dirname, 'preload-dock.js');
const SETTINGS_PRELOAD = path.join(__dirname, 'preload-settings.js');
const HOME_PRELOAD = path.join(__dirname, 'preload-home.js');
const DEMO = process.argv.includes('--demo');

let dock = null;
let poller = null;
let notifier = null;
let client = null;
let jenkinsClient = null;
let tray = null;
let settingsWindow = null;
let homeWindow = null;
// 主界面用：最近一轮**未过滤**的 cells（含已取消订阅的），以及历史 change 的缓存
let lastAllCells = [];
let lastPollAt = 0;
let lastPollOk = true;
let pastCache = { at: 0, cells: [] };
// 悬浮气泡：窗口 + 当前贴着的那一行的屏幕矩形 + 渲染层量出来的高度
let hoverWindow = null;
let hoverAnchor = null;
let hoverHeight = 0;
let demoTimer = null;
// 启动时刻：设置窗标题栏显示它，用来区分"新实例"和"还在跑的旧实例"
const STARTED_AT = new Date();
// 自检触发前的等待时间，可用环境变量调，方便脚本在"触发前/后"各截一张
const SMOKE_DELAY_MS = Number(process.env.SMOKE_DELAY_MS) || 15000;
let lastCells = null;
let logger = null;
let lastDiscovery = null;
let backdrop = null;

// ---- 装配 ----------------------------------------------------------------

// 传输通道：SSH（复用 ~/.ssh 密钥，不碰口令）优先，回落 REST。
// 两个客户端对外暴露同一组方法（self / version / query / change），
// 上层轮询不用关心是哪一条。
function createTransport(config) {
  if (!config.server) return null;
  const usableSsh = sshAvailable();
  const wanted = config.transport === 'ssh'
    || (config.transport !== 'rest' && usableSsh);
  if (wanted && usableSsh) {
    let host = '';
    try { host = new URL(config.server).hostname; } catch (_) { host = config.server; }
    return createSshClient({
      host,
      port: config.sshPort || '29418',
      user: config.sshUser || config.username,
      keyFile: config.sshKey || ''
    });
  }
  // gitcookies 模式下不传用户名密码，让客户端每次请求去读 ~/.gitcookies
  const cookies = config.authMode === 'gitcookies';
  return createClient({
    baseUrl: config.server,
    username: cookies ? '' : config.username,
    password: cookies ? '' : config.password,
    cookieProvider: cookies ? () => readCookieHeader(config.server) : null
  });
}

function buildClient() {
  const config = store.get();
  client = DEMO || config.demo ? null : createTransport(config);
  // Jenkins 是可选的一路：没配就不建客户端，轮询里自然跳过
  const jenkins = config.jenkins || {};
  jenkinsClient = DEMO || config.demo || !jenkins.url || !(jenkins.jobs || []).length
    ? null
    : createJenkinsClient({
      baseUrl: jenkins.url,
      username: jenkins.username,
      token: config.jenkinsToken
    });
  return client;
}

// 启动时先看本机有没有现成的 Gerrit 配置，有就直接套上并把设置窗推出来
// 让用户确认认证方式 —— 服务器和用户名能自动探测，凭据不能也不该。
function bootstrapFromMachine() {
  const config = store.get();
  if (config.server) return;
  lastDiscovery = collect({ cwd: process.cwd(), scanRoots: config.scanRoots, logger });
  const patch = toConfigPatch(lastDiscovery);
  if (!patch) { openSettings(); return; }
  store.save(patch);
  logger.info(`[bootstrap] 套用本机配置 ${patch.server} / ${patch.username || '(未识别用户名)'}`);
  restartPipeline();
  openSettings();
}

// 打开请求的计数，自检用（--open-smoke 靠它判断"按钮有没有真发出来"）
let openedCount = 0;

function openUrl(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  openedCount += 1;
  // openExternal 返回 Promise：系统没有默认浏览器 / 协议被占用时会 reject，
  // 不接住的话就是"点了没反应"，连日志都没有
  shell.openExternal(url).catch((error) => logger.warn(`[open] 打开失败 ${url}：${error.message}`));
}

// 自检用：把光标挪到某个**物理**像素点（不点），测完再挪回去。
// 坐标是物理像素：多显示器 + 缩放时 DIP 和物理像素不是一回事，用 screen.dipToScreenPoint 换。
function moveCursor(x, y) {
  return new Promise((resolve) => {
    const script = 'Add-Type -AssemblyName System.Windows.Forms;'
      + 'Add-Type -AssemblyName System.Drawing;'
      + `[System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new(${Math.round(x)},${Math.round(y)})`;
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true },
      (error) => resolve(error ? error.message : ''));
  });
}

// 自检用：在**当前光标位置**真点一下（左键按下+抬起）。这是操作系统级点击，
// 会走和用户手点完全一样的那条路（窗口穿透、命中测试全算上）。
function clickHere() {
  return new Promise((resolve) => {
    const script = 'Add-Type -MemberDefinition '
      + '\'[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, int e);\' '
      + '-Name Click -Namespace Probe;'
      + '[Probe.Click]::mouse_event(0x0002,0,0,0,0);'
      + 'Start-Sleep -Milliseconds 40;'
      + '[Probe.Click]::mouse_event(0x0004,0,0,0,0)';
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true },
      (error) => resolve(error ? error.message : ''));
  });
}

// 自检用：真拖一次（按下 → 分几步挪 → 松开），全程用操作系统级鼠标事件。
// 主进程拖拽读的是**真实光标位置**，所以合成 DOM 事件测不出来，只能真动鼠标。
function dragBy(dx, dy, steps = 6) {
  return new Promise((resolve) => {
    const script = 'Add-Type -AssemblyName System.Windows.Forms;'
      + 'Add-Type -AssemblyName System.Drawing;'
      + 'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, int e);\' -Name Click -Namespace Probe;'
      + '$p = [System.Windows.Forms.Cursor]::Position;'
      + '[Probe.Click]::mouse_event(0x0002,0,0,0,0);'
      + 'Start-Sleep -Milliseconds 120;'
      + `for ($i = 1; $i -le ${steps}; $i++) {`
      + `  $nx = $p.X + [int](${dx} * $i / ${steps});`
      + `  $ny = $p.Y + [int](${dy} * $i / ${steps});`
      + '  [System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new($nx, $ny);'
      + '  Start-Sleep -Milliseconds 90;'
      + '}'
      + 'Start-Sleep -Milliseconds 150;'
      + '[Probe.Click]::mouse_event(0x0004,0,0,0,0);';
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true },
      (error) => resolve(error ? error.message : ''));
  });
}

// ---- 控制台日志下载 ------------------------------------------------------
// 两个入口共用这一套：卡片上的「下载日志」按钮，和 --download-console=<job>/<构建号>
// 命令行（自检用，跑完就退）。地址一律由配置里的 Jenkins 地址拼出来，
// 调用方只能给 job 名和构建号 —— 不给任意 URL 开门。

// 目录：设置里填了就用它（相对路径按程序目录解析），没填就程序目录下的 build_log
function resolveLogDir() {
  const configured = String(store.get().jenkins?.logDir || '').trim();
  const programDir = path.dirname(store.dataDir());
  return configured ? path.resolve(programDir, configured) : path.join(programDir, 'build_log');
}

function consoleDestFile(job, number) {
  const safe = String(job).replace(/[\\/:*?"<>|]/g, '_').replace(/~/g, '_');
  return path.join(resolveLogDir(), `${safe}-${number}-console.txt`);
}

// 同一个构建点两次只下一次（按钮是可靠点击，但没有进度条，容易被连点）
const logDownloads = new Set();

async function downloadBuildLog(cell) {
  if (!cell?.job || !cell?.number) return { ok: false, error: '这个构建还没有构建号' };
  const key = `${cell.job}#${cell.number}`;
  // busy 让卡片知道"已经在下了"，别显示成失败
  if (logDownloads.has(key)) return { ok: false, busy: true, error: '正在下载' };
  if (!jenkinsClient) return { ok: false, error: '还没配置 Jenkins' };
  logDownloads.add(key);
  try {
    const destFile = consoleDestFile(cell.job, cell.number);
    logger.info(`[console] 下载 ${key} → ${destFile}`);
    const result = await jenkinsClient.downloadConsole({
      job: cell.job, number: cell.number, destFile
    });
    logger.info(`[console] 完成 ${key} ${result.bytes} 字节 / ${result.ms}ms`);
    notifyLogSaved(result);
    return { ok: true, ...result };
  } catch (error) {
    logger.warn(`[console] 失败 ${key}：${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    logDownloads.delete(key);
  }
}

// 下完不弹资源管理器（会打断手头的事），用/不点它都不碍事的那种提示
function notifyLogSaved(result) {
  if (!Notification.isSupported()) return;
  const name = path.basename(result.file);
  const kb = `${Math.round(result.bytes / 1024)}KB`;
  const notification = new Notification({
    title: '构建日志已保存',
    body: `${name}（${kb}）· 点击打开所在文件夹`
  });
  notification.on('click', () => shell.showItemInFolder(result.file));
  notification.show();
}

// 命令行入口：只下日志，跑完就退
async function runConsoleDownload(job, number) {
  const config = store.get();
  const jenkins = config.jenkins || {};
  if (!jenkins.url) return { ok: false, error: '还没填 Jenkins 地址' };
  if (!job || !/^\d+$/.test(number)) return { ok: false, error: '用法：--download-console=<job>/<构建号>' };
  const oneOffClient = createJenkinsClient({
    baseUrl: jenkins.url,
    username: jenkins.username,
    token: config.jenkinsToken
  });
  const destFile = consoleDestFile(job, number);
  const result = await oneOffClient.downloadConsole({ job, number, destFile });
  console.log(`[console] ${result.url} → ${result.file}（${result.bytes} 字节，${result.ms}ms）`);
  return { ok: true, ...result };
}

// ---- 手动刷新 ------------------------------------------------------------
// 卡片上的「刷新」按钮：拉一轮，并把"刷到哪一步"推回卡片做动画。
// 完成信号来自 handleCells（不管成功还是失败都会调），另有 15s 兜底，
// 免得某次拉取卡住时按钮一直转。
let manualRefresh = null;

function startManualRefresh() {
  if (manualRefresh) return;
  if (!poller) {
    // demo / 没配服务器：没有可刷的东西，立刻收掉动画
    dock?.pushRefreshState({ state: 'done', ok: false, ms: 0, reason: '没有可刷新的数据源' });
    return;
  }
  manualRefresh = {
    startedAt: Date.now(),
    timer: setTimeout(() => finishManualRefresh({ ok: false, timeout: true }), 15000)
  };
  dock?.pushRefreshState({ state: 'running' });
  poller.pollNow();
}

function finishManualRefresh(result) {
  if (!manualRefresh) return;
  clearTimeout(manualRefresh.timer);
  const ms = Date.now() - manualRefresh.startedAt;
  manualRefresh = null;
  dock?.pushRefreshState({ state: 'done', ok: result?.ok !== false, ms, timeout: result?.timeout === true });
}

// ---- 构建失败自动下日志 --------------------------------------------------
// 失败的那一轮往往要立刻看控制台，等你去点卡片就晚了，所以默认开着。
// 复用卡片按钮那条路：同一构建在下载中不会重复下，下完一样弹"已保存"通知。
function watchBuildForAutoLog(cells, events) {
  const config = store.get();
  if (DEMO || config.demo) return;
  if (config.jenkins?.autoDownloadLog === false) return;
  for (const event of events) {
    if (event.type !== 'status' || !String(event.cellId).startsWith('build|')) continue;
    if (event.to !== 'FAILURE') continue;
    const cell = cells.find((item) => item.id === event.cellId);
    if (!cell) continue;
    logger.info(`[console] ${cell.job}#${cell.number} 构建失败，自动下载日志`);
    downloadBuildLog(cell);
  }
}

// ---- 构建结束发微信 ------------------------------------------------------
// 回放 14_wechat 的流程，把一段文案发到微信。三条约束：
//   1. **一次只发一条** —— 回放会把微信拽到前台再模拟点击，两条并行会互相点飞
//   2. 同一个 (job, 构建号, 状态) 只发一次 —— 一分钟一轮轮询，同一次迁移会被反复命中
//   3. 只发"跑完了/卡住了"的状态，IN_PROGRESS 不发
// 代价：发送期间微信会抢焦点 1~2 秒（14 的 play() 第一步就是 ps.focus()）。

const WECHAT_QUEUE_LIMIT = 3;
// 发送失败（多数是抢不到前台）时重试：3 次、间隔 8s / 16s。
// 实测自动触发比手点更容易失败 —— Windows 的前台锁只允许"用户正在操作的进程"抢焦点，
// 定时器触发时我们不是那个进程，只能等用户切回微信的那一下。
const WECHAT_ATTEMPTS = 3;
const WECHAT_RETRY_MS = 8000;
// 锁屏中：进程照常跑（轮询、下日志都不断），微信那套直接丢
let sessionLocked = false;
// 每次锁屏 +1：锁屏前挂着的重试链一律作废，免得解锁后补发
let wechatEpoch = 0;

// ---- 阻止休眠 / 息屏 / 自动锁屏 -------------------------------------------
// 两件事分开做，因为 Windows 的两个机制不是一回事：
//   1. 电源请求 prevent-display-sleep（= Win32 的 SetThreadExecutionState + ES_DISPLAY_REQUIRED，
//      视频播放器和浏览器用的**就是这一个**）→ 屏幕不自动关、系统不自动睡、屏保不启动。
//      所谓"放视频不会锁屏"就是这么来的。
//   2. 闲置锁屏（安全策略的 Interactive logon: Machine inactivity limit，也就是注册表里的
//      InactivityTimeoutSecs）—— 电源请求对它无效，它只认"有没有用户输入"。
//      这种才需要人不在的时候每 20 秒动一下鼠标（1px，立刻移回来）。
// 挡不住的仍然有：Win+L 手动锁屏。
const KEEPALIVE_IDLE_SEC = 40;     // 人不在超过这么久才动鼠标
const KEEPALIVE_TICK_MS = 20000;

let keepAwakeId = null;
let keepAliveTimer = null;
let nudging = false;
// 有没有"闲置 N 秒就锁屏"这条安全策略。null = 还没查。
// 没有这条策略时**不动用户的鼠标** —— 光靠电源请求就够了。
let inactivityLockSec = null;

function readInactivityLock() {
  return new Promise((resolve) => {
    execFile('reg.exe', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
      '/v', 'InactivityTimeoutSecs'
    ], { windowsHide: true }, (error, stdout) => {
      if (error) { resolve(0); return; }
      const match = /InactivityTimeoutSecs\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout || ''));
      resolve(match ? parseInt(match[1], 16) : 0);
    });
  });
}

async function inactivityPolicy() {
  if (inactivityLockSec === null) {
    inactivityLockSec = await readInactivityLock();
    logger.info(inactivityLockSec > 0
      ? `[power] 检测到闲置锁屏策略：${inactivityLockSec}s 无输入就锁屏（需要动鼠标）`
      : '[power] 没有闲置锁屏策略：只靠电源请求，不动鼠标');
  }
  return inactivityLockSec;
}

// 动 1px 再移回来：任何输入都会重置 Windows 的闲置计时
function nudgeMouse() {
  if (nudging) return;
  nudging = true;
  const script = 'Add-Type -MemberDefinition '
    + '\'[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, int e);\' '
    + '-Name M -Namespace N;'
    + '[N.M]::mouse_event(0x0001,1,0,0,0);'
    + 'Start-Sleep -Milliseconds 40;'
    + '[N.M]::mouse_event(0x0001,-1,0,0,0)';
  execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (error) => {
    nudging = false;
    if (error) logger.warn(`[power] 防锁屏动鼠标失败：${error.message}`);
  });
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  const threshold = Number(process.env.KEEPALIVE_TEST) || KEEPALIVE_IDLE_SEC;
  keepAliveTimer = setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime();
    if (idle < threshold) return;   // 人在用，别去碰鼠标
    logger.info(`[power] 闲置 ${idle}s，动一下鼠标防止锁屏`);
    nudgeMouse();
  }, Number(process.env.KEEPALIVE_TEST) ? 2000 : KEEPALIVE_TICK_MS);
  logger.info(`[power] 防锁屏保活已启动（闲置 ≥ ${threshold}s 才动鼠标）`);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  logger.info('[power] 防锁屏保活已停止');
}

function applyKeepAwake(reason = '') {
  const want = store.get().keepAwake !== false;
  const started = keepAwakeId !== null && powerSaveBlocker.isStarted(keepAwakeId);
  if (want) {
    if (!started) {
      try {
        keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
        logger.info(`[power] 已阻止显示器休眠${reason ? `（${reason}）` : ''} id=${keepAwakeId}`);
      } catch (error) {
        keepAwakeId = null;
        logger.warn(`[power] 阻止显示器休眠失败：${error.message}`);
      }
    }
    // 只有在真有"闲置锁屏"策略时才去动鼠标；KEEPALIVE_TEST 是自检用的强制开关
    inactivityPolicy().then((sec) => {
      if (store.get().keepAwake === false) return;
      if (sec > 0 || process.env.KEEPALIVE_TEST) startKeepAlive();
      else stopKeepAlive();
    });
    return;
  }
  if (started) {
    try { powerSaveBlocker.stop(keepAwakeId); } catch (_) { /* 已经停了 */ }
    logger.info('[power] 已恢复系统默认的熄屏/睡眠策略');
  }
  keepAwakeId = null;
  stopKeepAlive();
}

function watchPowerEvents() {
  try {
    powerMonitor.on('lock-screen', () => {
      sessionLocked = true;
      // **不补发**：锁屏时微信那条链根本发不出去，攒着也没意义 —— 解锁后补发一条
      // 半小时前的"构建失败"只会让人误解成刚失败。锁屏即丢，日志里留个记号。
      wechatEpoch += 1;
      const dropped = wechatQueue.length;
      wechatQueue.length = 0;
      logger.info(`[power] 已锁屏：继续轮询和下载日志，微信消息不补发${dropped ? `（丢掉 ${dropped} 条待发）` : ''}`);
    });
    powerMonitor.on('unlock-screen', () => {
      sessionLocked = false;
      logger.info('[power] 已解锁');
    });
    // 休眠不是锁屏：定时器会一起停。醒来后所有 setTimeout 集中触发，
    // 那一次 poll 会把睡眠期间的变化一次性报出来 —— 这是对的，不用特殊处理
    powerMonitor.on('suspend', () => logger.info('[power] 系统休眠'));
    powerMonitor.on('resume', () => logger.info('[power] 系统唤醒'));
  } catch (error) {
    logger.warn(`[power] 订阅电源事件失败：${error.message}`);
  }
}
const wechatQueue = [];
const wechatSent = new Set();
let wechatBusy = false;

// 流程文件：设置里填了就用它（相对路径按程序目录解析），
// 留空就找同级目录的 14_wechat —— 开发时的布局
// 传 override 时用传进来的值（设置页"发一条测试消息"用的是表单里还没保存的那份）
function resolveWechatFlow(override) {
  const programDir = path.dirname(store.dataDir());
  const configured = String(override ?? store.get().wechat?.flow ?? '').trim();
  if (configured) return path.resolve(programDir, configured);
  return path.join(programDir, '..', '14_wechat', 'build', 'recorded.json');
}

function watchBuildForWeChat(cells, events) {
  const config = store.get();
  if (DEMO || config.demo || config.wechat?.enabled !== true) return;
  for (const event of events) {
    if (event.type !== 'status' || !String(event.cellId).startsWith('build|')) continue;
    if (!shouldSendWeChat(event.to)) continue;
    const cell = cells.find((item) => item.id === event.cellId);
    if (!cell) continue;
    const key = `${cell.id}#${cell.number}#${event.to}`;
    if (wechatSent.has(key)) continue;
    wechatSent.add(key);
    if (wechatQueue.length >= WECHAT_QUEUE_LIMIT) {
      logger.warn(`[wechat] 队列满了，丢掉 ${key}`);
      continue;
    }
    wechatQueue.push({ cell, state: event.to });
  }
  pumpWeChat();
}

async function pumpWeChat() {
  if (wechatBusy || !wechatQueue.length) return;
  // 锁屏是另一个桌面：窗口抢不到前台、模拟点击也落空，这时候发只是白费三次重试。
  // 直接丢掉（锁屏那一刻已经清过队列，这里兜住"锁屏期间又有新事件进来"的情况）。
  if (sessionLocked) {
    const dropped = wechatQueue.length;
    wechatQueue.length = 0;
    logger.info(`[wechat] 锁屏中，丢掉 ${dropped} 条（不补发）`);
    return;
  }
  wechatBusy = true;
  const job = wechatQueue.shift();
  const { cell, state } = job;
  const key = `${cell.id}#${cell.number}#${state}`;
  const attempt = (job.attempt || 0) + 1;
  try {
    const flow = resolveWechatFlow();
    logger.info(`[wechat] 发送 ${key}（第 ${attempt}/${WECHAT_ATTEMPTS} 次）flow=${flow}`);
    await sendWeChat(buildMessageText(cell, state), {
      flow,
      log: (message) => logger.info(`[wechat] ${message}`),
      logger
    });
    logger.info(`[wechat] 已发送 ${key}`);
  } catch (error) {
    // 失败大多是"微信不在前台"（Windows 的前台锁让后台进程抢不到焦点）或者
    // 坐标上盖着别的窗口。等一会儿再试 —— 用户这时候往往正好切回微信。
    logger.warn(`[wechat] 第 ${attempt} 次发送失败 ${key}：${error.message}`);
    if (attempt < WECHAT_ATTEMPTS) {
      const delay = attempt * WECHAT_RETRY_MS;
      const epoch = wechatEpoch;
      logger.info(`[wechat] ${Math.round(delay / 1000)}s 后重试`);
      setTimeout(() => {
        // 中间锁过屏：这条重试链作废，不补发
        if (epoch !== wechatEpoch) {
          logger.info(`[wechat] 期间锁过屏，放弃重试 ${key}`);
          return;
        }
        if (wechatQueue.length >= WECHAT_QUEUE_LIMIT) {
          logger.warn(`[wechat] 队列满了，放弃重试 ${key}`);
          notifyWeChatFailed(`${key}：${error.message}`);
          return;
        }
        wechatQueue.push({ cell, state, attempt });
        pumpWeChat();
      }, delay);
      return;
    }
    notifyWeChatFailed(error.message);
  } finally {
    wechatBusy = false;
    setImmediate(() => { pumpWeChat(); });
  }
}

function notifyWeChatFailed(reason) {
  if (!Notification.isSupported()) return;
  new Notification({ title: '微信没发出去', body: reason }).show();
}

function handleCells(incoming, result = {}) {
  // **永远用当前的订阅名单过滤一遍**：轮询是异步的，回来时订阅状态可能已经改了。
  // 不在这一层兜住的话，刚取消订阅的条目会被上一轮（旧配置）的结果又塞回竖条 ——
  // 表现就是"主界面和竖条条目数对不上"，而且要等下一轮轮询（最长一分钟）才自己好。
  const muted = mutedKeySet(store.get().mutedItems);
  const cells = (Array.isArray(incoming) ? incoming : []).filter((cell) => !muted.has(muteKey(cell.id)));
  const events = diffCells(lastCells, cells);
  lastCells = cells;
  // 主界面用的列表（含已取消订阅的）；拉取失败（stale）时保留上一轮的
  if (Array.isArray(result.allCells)) {
    lastAllCells = result.allCells;
    lastPollAt = Date.now();
    lastPollOk = result.ok !== false;
  }
  pushHomeState();
  // ok=false：这轮没拉到，面板别把"正在读取"换成"还没有跟踪"
  dock?.setCells(cells, { ok: result.ok !== false });
  // 状态有变化的格子主动弹一次气泡（和通知共用同一套开关）
  if (events.length) {
    const notify = store.get().notify || {};
    const byCell = new Map();
    for (const event of events) {
      if (notify[event.type] === false) continue;
      if (!byCell.has(event.cellId)) byCell.set(event.cellId, []);
      byCell.get(event.cellId).push(event.text);
    }
    if (byCell.size) {
      dock?.flashCells?.([...byCell].map(([cellId, texts]) => ({ cellId, texts })));
    }
  }
  // 竖条一屏只放得下十来条，总数在托盘提示里给全
  tray?.setToolTip(`Gerrit Helper · ${cells.length} 条在途${result?.transport === 'ssh' ? '（SSH）' : ''}`);
  if (events.length) notifier?.notify(events);
  // Jenkins 那边"跑完了 / 卡住了"→ 发微信（和桌面通知各走各的开关）
  if (events.length && result.ok !== false) {
    watchBuildForWeChat(cells, events);
    watchBuildForAutoLog(cells, events);
  }
  // 手动刷新那一次的轮询回来了：把按钮上的转圈收掉
  if (result?.stale !== true) finishManualRefresh({ ok: result?.ok !== false });
  if (result?.errors?.length) console.warn('[gerrit]', result.errors.join(' | '));
}

function startDemoLoop() {
  clearInterval(demoTimer);
  const tick = () => handleCells(demo.build());
  tick();
  const demoMs = Number(process.env.DEMO_INTERVAL_MS) || Math.max(20, store.get().intervalSec) * 1000;
  demoTimer = setInterval(tick, demoMs);
}

function restartPipeline() {
  buildClient();
  if (DEMO || store.get().demo) {
    poller?.stop();
    poller = null;
    startDemoLoop();
    return;
  }
  clearInterval(demoTimer);
  demoTimer = null;
  if (client || jenkinsClient) {
    if (!poller) {
      poller = createPoller({
        getConfig: store.get,
        getClient: () => client,
        getJenkins: () => jenkinsClient,
        onCells: handleCells,
        logger
      });
    }
    poller.restart();
  } else {
    poller?.stop();
    poller = null;
    handleCells([]);
  }
}

function buildDock(previewPatch = null) {
  if (dock) return;
  const material = previewPatch?.material ?? store.get().material;
  dock = createDock({
    BrowserWindow,
    ipcMain,
    screen,
    rendererDir: RENDERER_DIR,
    preloadPath: DOCK_PRELOAD,
    getConfig: store.get,
    onOpenUrl: openUrl,
    onManualRefresh: () => startManualRefresh(),
    onOpenSettings: openSettings,
    // 卡片上的「下载日志」：下完把结果推回卡片（按钮要从"下载中"变回可点）
    onDownloadLog: async (cellId) => {
      const cell = lastCells.find((item) => item.id === cellId);
      if (!cell || cell.kind !== 'build') return;
      const result = await downloadBuildLog(cell);
      dock?.pushLogState({
        cellId, ok: result.ok, busy: result.busy === true,
        file: result.file || '', error: result.error || ''
      });
    },
    onPlacementChange: ({ position }) => {
      if (!position) return;
      store.save({ position });
      logger.info(`[dock] 位置已保存 ${position.x},${position.y}`);
    },
    backdrop: material === 'tint' ? null : backdrop,
    logger
  });
  if (previewPatch) dock.setPreview(previewPatch);
  dock.start();
  // 重建出来的 dock 立刻回填现有数据，否则要等下一轮轮询（最多一分钟），
  // 这段时间它就是个"展开后没有项目"的空壳。
  if (lastCells?.length) dock.setCells(lastCells, { seed: true });
}

// ---- 主界面 --------------------------------------------------------------
// 托盘右键 →「主界面」。一条一行（一个 change / 一个构建），分「订阅中 / 未订阅」两区。
// 历史 change（已提交 / 已放弃）不在轮询结果里，窗口打开时单独查一轮并缓存 2 分钟。

function homeItems() {
  const config = store.get();
  const muted = mutedKeySet(config.mutedItems);
  const seen = new Set();
  const items = [];
  for (const cell of [...lastAllCells, ...pastCache.cells]) {
    if (!cell || seen.has(cell.id)) continue;
    seen.add(cell.id);
    items.push(toHomeItem(cell, muted));
  }
  return items;
}

function homeState() {
  const config = store.get();
  return {
    items: homeItems(),
    server: config.server || '',
    transport: client?.kind || '',
    updated: lastPollAt,
    ok: lastPollOk
  };
}

function pushHomeState() {
  if (!homeWindow || homeWindow.isDestroyed()) return;
  homeWindow.webContents.send('home:state', homeState());
}

// 历史 change：只在主界面开着时才查，结果缓存 2 分钟
async function loadPastChanges(force = false) {
  if (!client) return;
  if (!force && Date.now() - pastCache.at < 120000) return;
  const config = store.get();
  const known = new Set(lastAllCells.map((cell) => cell.id));
  const cells = [];
  for (const base of ['owner:self status:merged', 'owner:self status:abandoned']) {
    const query = withRecency(base, config.recentDays);
    try {
      const list = await client.query(query);
      for (const change of list || []) {
        const cell = toCell(change, { server: config.server || client.base, selfId: null, role: 'owner' });
        if (known.has(cell.id)) continue;
        cell.past = true;
        cell.events = [];
        cells.push(cell);
      }
      logger.info(`[home] 历史 change：${query} → ${(list || []).length} 条`);
    } catch (error) {
      logger.warn(`[home] 查历史 change 失败（${base}）：${error.message}`);
    }
  }
  // 只留最近的 40 条，别把窗口塞满
  cells.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  pastCache = { at: Date.now(), cells: cells.slice(0, 40) };
  pushHomeState();
}

// ---- 主界面的悬浮气泡 ----------------------------------------------------
// 复用竖条那张卡片的渲染（同一份 dock/index.html?surface=card + dock.css）：
// 独立的小窗口、置顶、不抢焦点、鼠标穿透，窗口位置贴着主界面那一行的外侧。
// 形状自己给一个圆角矩形（卡片渲染层靠 dock:shape 画玻璃，没有形状就没有背景）。
const HOVER_GAP = 8;

function ensureHoverWindow() {
  if (hoverWindow && !hoverWindow.isDestroyed()) return hoverWindow;
  hoverWindow = new BrowserWindow({
    width: 300, height: 180, show: false,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true,
    hasShadow: false, transparent: true, backgroundColor: '#00000000',
    type: 'toolbar', thickFrame: false,
    webPreferences: { preload: DOCK_PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  hoverWindow.setAlwaysOnTop(true, 'pop-up-menu');
  hoverWindow.setIgnoreMouseEvents(true);
  hoverWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  hoverWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  // hover=1 让渲染层把底部按钮藏掉（气泡只是提示，窗口是穿透的）
  hoverWindow.loadFile(path.join(RENDERER_DIR, 'dock', 'index.html'), { query: { surface: 'card', hover: '1' } });
  // 气泡是提示，不是操作面板：底部按钮由 body[data-hover] 的 CSS 藏掉；
  // 底色给足（悬浮层那套 0.43 叠在别人的窗口上根本读不清）
  hoverWindow.webContents.on('did-finish-load', () => {
    hoverWindow.webContents.send('dock:appearance', { glassAlpha: 92 });
  });
  hoverWindow.on('closed', () => { hoverWindow = null; });
  return hoverWindow;
}

function placeHoverWindow(height) {
  if (!hoverWindow || hoverWindow.isDestroyed() || !hoverAnchor) return;
  const width = Math.round(hoverWindow.getBounds().width);
  const box = hoverWindow.getBounds();
  const work = screen.getDisplayNearestPoint({ x: hoverAnchor.x, y: hoverAnchor.y }).workArea;
  // **优先放到主界面左侧**，左边放不下才翻到右侧
  const home = homeWindow && !homeWindow.isDestroyed() ? homeWindow.getBounds() : null;
  let x = (home ? home.x : hoverAnchor.x) - HOVER_GAP - width;
  if (x < work.x + 4) {
    x = home ? home.x + home.width + HOVER_GAP : hoverAnchor.x + hoverAnchor.width + HOVER_GAP;
  }
  x = Math.max(work.x + 4, Math.min(x, work.x + work.width - width - 4));
  let y = hoverAnchor.y;
  y = Math.max(work.y + 4, Math.min(y, work.y + work.height - height - 4));
  hoverWindow.setBounds({ x: Math.round(x), y: Math.round(y), width, height: Math.round(height) });
  // 形状：圆角矩形（卡片渲染层拿它画玻璃，也是窗口 region）
  const commands = roundedRectCommands({ width, height, radius: 12, inset: 0.5 });
  hoverWindow.webContents.send('dock:shape', {
    d: toSvgPath(commands),
    outline: toSvgPath(commands.filter(([op]) => op !== 'Z')),
    width, height
  });
}

function showHover(payload) {
  const cell = lastAllCells.find((item) => item.id === String(payload?.id || ''));
  const rect = payload?.rect;
  if (!cell || !rect || !homeWindow || homeWindow.isDestroyed()) return;
  const bounds = homeWindow.getBounds();
  hoverAnchor = {
    x: bounds.x + Math.round(rect.x),
    y: bounds.y + Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
  const win = ensureHoverWindow();
  const show = () => {
    if (!hoverAnchor || win.isDestroyed()) return;
    const height = Math.max(80, Math.min(420, hoverHeight || 160));
    placeHoverWindow(height);
    if (!win.isVisible()) win.showInactive();
    win.webContents.send('card:cell', { cell, side: 'right' });
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', show);
  else show();
}

function hideHover() {
  hoverAnchor = null;
  if (hoverWindow && !hoverWindow.isDestroyed() && hoverWindow.isVisible()) hoverWindow.hide();
}

function openHome() {
  if (homeWindow && !homeWindow.isDestroyed()) {
    homeWindow.show();
    homeWindow.focus();
    return;
  }
  homeWindow = new BrowserWindow({
    width: 520, height: 560, minWidth: 420, minHeight: 380,
    title: 'Gerrit Helper · 订阅',
    frame: false, transparent: true, hasShadow: false,
    backgroundColor: '#00000000', autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: HOME_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  homeWindow.setMenuBarVisibility(false);
  homeWindow.loadFile(path.join(RENDERER_DIR, 'home', 'index.html'));
  homeWindow.once('ready-to-show', () => homeWindow.show());
  homeWindow.on('closed', () => { homeWindow = null; });
  loadPastChanges();
}

function registerHomeIpc() {
  ipcMain.handle('home:load', () => homeState());
  // 订阅 / 取消订阅：按**条目**（cell id）记账，不是按仓库
  ipcMain.handle('home:toggle', (event, payload) => {
    const id = String(payload?.id || '').trim();
    if (!id) return { ok: false, error: '没有条目 id' };
    const muted = new Set(store.get().mutedItems || []);
    const subscribe = payload?.tracked === true;
    // 名单里存完整 id；比对时看 key（见 shared/home-list.js 的 muteKey）
    const key = muteKey(id);
    for (const existing of [...muted]) if (muteKey(existing) === key) muted.delete(existing);
    if (!subscribe) muted.add(id);
    store.save({ mutedItems: [...muted] });
    logger.info(`[home] ${subscribe ? '订阅' : '取消订阅'} ${id}`);
    // **先按新名单过滤上一轮的数据推给竖条**，不等下一次轮询 ——
    // SSH 一轮要 1~3 秒，等它回来才有反应的话，点一下要愣好几秒
    handleCells(sortCells(lastAllCells, store.get().sort), { ok: lastPollOk });
    restartPipeline();
    pushHomeState();
    return { ok: true, muted: [...muted] };
  });
  ipcMain.on('home:refresh', () => {
    poller?.pollNow();
    loadPastChanges(true);
  });
  ipcMain.on('home:close', () => { hideHover(); homeWindow?.close(); });
  ipcMain.on('home:hover', (event, payload) => showHover(payload));
  ipcMain.on('home:unhover', () => hideHover());
  // 气泡窗口的高度由渲染层量出来（和竖条卡片同一条路）
  ipcMain.on('dock:cardSize', (event, payload) => {
    if (!hoverWindow || event.sender !== hoverWindow.webContents) return;
    const height = Math.round(Number(payload?.height));
    if (!Number.isFinite(height) || height <= 0) return;
    hoverHeight = height;
    placeHoverWindow(height);
  });
}

// ---- 设置窗口 ------------------------------------------------------------

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  // 无边框 + 透明：圆角和投影都自己画，风格和悬浮层保持一致。
  // 外圈留 12px 透明边给投影用，所以窗口比可见区域大一圈。
  settingsWindow = new BrowserWindow({
    width: 784, height: 664,
    minWidth: 704, minHeight: 544,
    title: 'Gerrit Helper · 设置',
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: SETTINGS_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(RENDERER_DIR, 'settings', 'index.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.webContents.on('did-finish-load', () => {
    pushSettingsAppearance();
  });
  settingsWindow.on('closed', () => {
    // 关掉设置窗时丢弃未保存的预览，回到已保存的配置
    dock?.setPreview(null);
    dock?.refreshLayout?.();
    settingsWindow = null;
  });
}

// 把表单提交的补丁合并到已存配置上。空凭据表示"不修改"，
// 不能让它把存好的密码覆盖成空串 —— 测试连接也会走这里。
function mergeSettings(patch) {
  const incoming = { ...(patch || {}) };
  delete incoming.clearSecrets;
  if (!incoming.password) delete incoming.password;
  if (!incoming.jenkinsToken) delete incoming.jenkinsToken;
  return store.normalize({ ...store.get(), ...incoming });
}

function registerSettingsIpc() {
  ipcMain.handle('settings:load', () => {
    // 凭据**不发给渲染层**：只告诉它"有没有存过"。
    // 表单留空 = 不修改；要换就填新的；要删就用「清除凭据」。
    const { password, jenkinsToken, ...safe } = store.get();
    return {
      config: safe,
      configPath: store.configPath(),
      // 设置页拿它当"留空时日志会存到哪"的提示
      logDir: resolveLogDir(),
      wechatFlow: resolveWechatFlow(),
      hasPassword: Boolean(password),
      hasJenkinsToken: Boolean(jenkinsToken),
      demo: DEMO,
      discovery: lastDiscovery,
      version: app.getVersion(),
      startedAt: STARTED_AT.toISOString()
    };
  });

  // 「重新检测本机配置」：只读 .gitreview / git remote / ssh config / git config，
  // 不碰任何凭据文件内容。
  ipcMain.handle('settings:discover', (event, scanRoots) => {
    const roots = Array.isArray(scanRoots)
      ? scanRoots.map((dir) => String(dir).trim()).filter(Boolean)
      : store.get().scanRoots;
    lastDiscovery = collect({ cwd: process.cwd(), scanRoots: roots, logger });
    return lastDiscovery;
  });

  ipcMain.handle('settings:save', (event, patch) => {
    const before = store.get();
    const incoming = { ...(patch || {}) };
    // 显式清除凭据
    if (incoming.clearSecrets) {
      incoming.password = '';
      incoming.jenkinsToken = '';
      delete incoming.clearSecrets;
    } else {
      if (!incoming.password) delete incoming.password;
      if (!incoming.jenkinsToken) delete incoming.jenkinsToken;
    }
    const config = store.save(incoming);
    // 保存后预览层让位给真实配置
    dock?.setPreview(null);
    applySavedConfig(before, config);
    return { ok: true, config: { ...config }, configPath: store.configPath() };
  });

  ipcMain.handle('settings:testJenkins', async (event, patch) => {
    const merged = mergeSettings(patch);
    const jenkins = merged.jenkins || {};
    if (!jenkins.url) return { ok: false, error: '还没填 Jenkins 地址' };
    if (!(jenkins.jobs || []).length) return { ok: false, error: '还没填 job' };
    const probe = createJenkinsClient({
      baseUrl: jenkins.url,
      username: jenkins.username,
      token: merged.jenkinsToken
    });
    const results = [];
    for (const job of jenkins.jobs.slice(0, 5)) {
      try {
        const status = await probe.status(job);
        results.push({ job, ok: true, number: status?.number ?? null, state: status?.state ?? '未构建' });
      } catch (error) {
        results.push({ job, ok: false, error: error.message });
      }
    }
    return { ok: results.some((entry) => entry.ok), results };
  });

  ipcMain.handle('settings:test', async (event, patch) => {
    const merged = mergeSettings(patch);
    const probe = createTransport(merged);
    if (!probe) return { ok: false, error: '还没填服务器地址' };
    try {
      const [self, version] = await Promise.all([
        probe.self().catch(() => null),
        probe.version().catch(() => '')
      ]);
      // SSH 通道没有 /accounts/self，用一条 owner:self 查询验证身份
      let account = self ? { id: self._account_id, name: self.name || self.username || '' } : null;
      if (!account && probe.kind === 'ssh') {
        const mine = await probe.query('status:open owner:self', 1).catch(() => []);
        account = mine.length ? { id: null, name: mine[0].owner?.username || mine[0].owner?.name || '可查询' } : null;
      }
      return { ok: true, transport: probe.kind, server: probe.base, version, account };
    } catch (error) {
      return { ok: false, transport: probe.kind, error: error.message };
    }
  });

  // 「选择…」日志下载目录：只取路径，不建目录（第一次下载时才建）
  ipcMain.handle('settings:pickDir', async () => {
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: '选择日志下载目录',
      defaultPath: resolveLogDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  // 「发一条测试消息」：立刻回放一次，用当前表单里的流程路径（不用先保存）。
  // 这是**真的发**——会抢焦点 1~2 秒，消息进「文件传输助手」。
  ipcMain.handle('settings:testWechat', async (event, patch) => {
    if (wechatBusy) return { ok: false, error: '正在发送上一条，等它跑完' };
    const merged = mergeSettings(patch);
    const flow = resolveWechatFlow(merged.wechat?.flow || '');
    // 有真实的构建格子就发它，没有就发一条测试文案
    const cell = lastCells.find((item) => item.kind === 'build')
      || { job: '测试~GerritHelper', number: 0, url: '' };
    const text = buildMessageText(cell, 'SUCCESS');
    try {
      await sendWeChat(text, { flow, log: (message) => logger.info(`[wechat] ${message}`), logger });
      logger.info(`[wechat] 测试消息已发送 flow=${flow}`);
      return { ok: true, flow, text };
    } catch (error) {
      logger.warn(`[wechat] 测试消息失败：${error.message}`);
      return { ok: false, flow, text, error: error.message };
    }
  });

  // 「选择…」微信流程文件：只认 JSON
  ipcMain.handle('settings:pickFlow', async () => {
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: '选择微信流程文件',
      defaultPath: resolveWechatFlow(),
      properties: ['openFile'],
      filters: [{ name: '流程 JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  // 导出：凭据一律不进文件
  ipcMain.handle('settings:export', async () => {
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
    const result = await dialog.showSaveDialog(owner, {
      title: '导出配置',
      defaultPath: 'gerrit-helper-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const text = `${JSON.stringify(toExportable(store.get()), null, 2)}\n`;
      fs.writeFileSync(result.filePath, text, 'utf8');
      logger.info(`[config] 已导出到 ${result.filePath}`);
      return { ok: true, path: result.filePath };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // 导入：文件里的凭据字段一律丢掉，已存的凭据保持不变
  ipcMain.handle('settings:import', async () => {
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: '导入配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8')); }
    catch (error) { return { ok: false, error: `读不出来：${error.message}` }; }
    let clean;
    try { clean = sanitizeImport(raw); }
    catch (error) { return { ok: false, error: error.message }; }
    try {
      const before = store.get();
      const config = store.save(clean);
      applySavedConfig(before, config);
      const { password, jenkinsToken, ...safe } = config;
      logger.info(`[config] 已从 ${result.filePaths[0]} 导入`);
      return {
        ok: true,
        path: result.filePaths[0],
        summary: summarize(config),
        config: safe,
        hasPassword: Boolean(password),
        hasJenkinsToken: Boolean(jenkinsToken),
        configPath: store.configPath()
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // 实时预览：改显示项时立刻生效，不落盘
  ipcMain.on('settings:preview', (event, patch) => {
    if (!patch) { dock?.setPreview(null); return; }
    const display = {};
    for (const key of ['mode', 'snap', 'glassAlpha', 'sort', 'material']) {
      if (patch[key] !== undefined) display[key] = patch[key];
    }
    // 材质换档要重建窗口（有没有亚克力底层是两套东西）
    if (display.material && display.material !== store.get().material) {
      dock?.stop();
      dock = null;
      buildDock(display);
      return;
    }
    logger?.info?.(`[preview] ${JSON.stringify(display)} dock=${Boolean(dock)}`);
    if (patch.settingsAlpha !== undefined) pushSettingsAppearance(patch.settingsAlpha);
    dock?.setPreview(display);
  });

  ipcMain.on('settings:reveal', () => shell.showItemInFolder(store.configPath()));
  ipcMain.on('settings:openExternal', (event, url) => openUrl(url));
}

// ---- 诊断 ----------------------------------------------------------------
// 出现"多一块面板"这类说不清的现象时，按 Ctrl+Alt+D：
//   1. 把三块 surface 的真实状态（可见性/透明度/目标值/位置）写进 app.log
//   2. 截一张主屏到 data/diagnose-*.png
// 然后把这个日志和截图发出来就够了。

async function diagnose() {
  try {
    const states = dock?.surfaceStates?.() || [];
    const pointer = dock?.pointerState?.() || {};
    logger.info(`[diagnose] pointer=${JSON.stringify(pointer)}`);
    logger.info(`[diagnose] surfaces=${JSON.stringify(states)}`);
    // 进程里所有窗口：正常应该是 rail / handle / card（+ 设置窗）。
    // 多出来的就是孤儿窗口 —— 它们不受 dock 管理，会一直停在屏幕上。
    const all = BrowserWindow.getAllWindows().map((win) => ({
      alive: !win.isDestroyed(),
      visible: win.isDestroyed() ? false : win.isVisible(),
      opacity: win.isDestroyed() ? 0 : Number(win.getOpacity().toFixed(2)),
      bounds: win.isDestroyed() ? null : win.getBounds(),
      owned: Boolean(dock?.owns?.(win))
    }));
    logger.info(`[diagnose] allWindows=${JSON.stringify(all)}`);
    for (const line of dock?.trace?.() || []) logger.info(`[trace] ${line}`);
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale)
      }
    });
    const source = sources.find((entry) => String(entry.display_id) === String(display.id)) || sources[0];
    if (!source) { logger.warn('[diagnose] 抓不到屏幕'); return; }
    const file = path.join(store.dataDir(), `diagnose-${Date.now()}.png`);
    fs.writeFileSync(file, source.thumbnail.toPNG());
    logger.info(`[diagnose] 截图 ${file}`);
    if (Notification.isSupported()) {
      new Notification({ title: '诊断已保存', body: file }).show();
    }
  } catch (error) {
    logger.warn(`[diagnose] 失败：${error.message}`);
  }
}

// 保存后的统一善后：窗口结构变了就重建，其余只刷新外观和轮询
function applySavedConfig(before, config) {
  // 只有材质需要重建（亚克力底层是挂在窗口上的）。显示模式不用重建 ——
  // 重建等于把窗口全拆了重开，竖条和把手会硬闪一下；不重建的话
  // dock 每轮读一次 mode，切换走的是淡入淡出（常驻 → 自动隐藏：320ms 后 120ms 淡出，
  // 同时把手 150ms 淡入），过渡是连续的。
  const structural = before.material !== config.material;
  if (structural) {
    dock?.stop();
    dock = null;
    buildDock();
  } else if (before.glassAlpha !== config.glassAlpha) {
    dock?.refreshAppearance?.();
  }
  applyKeepAwake('设置变更');
  restartPipeline();
}

// 设置窗的不透明度和悬浮层是两个独立的值：调参数时往往希望设置窗实一点、
// 悬浮层透一点，硬把它们绑在一起反而不好用。
function pushSettingsAppearance(percent = store.get().settingsAlpha) {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  try {
    settingsWindow.webContents.send('settings:appearance', { settingsAlpha: percent });
  } catch (_) { /* 正在加载 */ }
}

// ---- 配置导入导出 --------------------------------------------------------



// ---- 托盘 ----------------------------------------------------------------

function buildTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Gerrit Helper');
  const menu = Menu.buildFromTemplate([
    { label: '主界面', click: openHome },
    { label: '立即刷新', click: () => poller?.pollNow() },
    { label: '保存诊断快照 (Ctrl+Alt+D)', click: () => diagnose() },
    { label: '设置…', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', openSettings);
}

// ---- 生命周期 ------------------------------------------------------------

// 自检用：用户实例在跑的时候也能另起一个进程跑 --drag-smoke 之类，
// 不设这个环境变量就还是正常的单实例
const LOCKED = process.env.SMOKE_NO_LOCK !== '1';
if (LOCKED && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettings());

  app.whenReady().then(() => {
    // 公司自签 CA：只有用户在设置里显式打开才放行，默认按证书报错
    const applyCertPolicy = () => {
      const allow = store.get().allowInsecureCert === true;
      session.defaultSession.setCertificateVerifyProc((request, callback) => {
        callback(allow ? 0 : -3);
      });
    };
    applyCertPolicy();
    ipcMain.on('settings:certPolicy', applyCertPolicy);

    logger = createLogger(path.join(store.dataDir(), 'app.log'));
    store.setLogger(logger);

    // 自检用：只下日志，别的东西一概不装配
    const consoleArg = process.argv.find((arg) => arg.startsWith('--download-console='));
    if (consoleArg) {
      const spec = consoleArg.slice('--download-console='.length);
      const cut = spec.lastIndexOf('/');
      const job = cut > 0 ? spec.slice(0, cut) : '';
      const number = cut > 0 ? spec.slice(cut + 1) : '';
      logger.info(`[console] 开始 ${job} #${number}`);
      runConsoleDownload(job, number)
        .then((result) => {
          if (!result.ok) logger.warn(`[console] 失败：${result.error}`);
          app.exit(result.ok ? 0 : 1);
        })
        .catch((error) => {
          logger.warn(`[console] 失败：${error.message}`);
          console.error(`[console] 失败：${error.message}`);
          app.exit(1);
        });
      return;
    }

    backdrop = createBackdrop({ app, screen, logger });
    logger.info(`start demo=${DEMO} pid=${process.pid} log=${logger.file}`);
    registerSettingsIpc();
    registerHomeIpc();
    notifier = createNotifier({
      getConfig: store.get,
      onClick: (event) => openUrl(event?.url)
    });
    buildDock();
    restartPipeline();
    buildTray();
    watchPowerEvents();
    applyKeepAwake('启动');
    globalShortcut.register('Control+Alt+D', () => diagnose());

    // 自检用：--log-smoke 把 build 那张卡片摆出来，真点「下载日志」，
    // 再把按钮上的字读回来。验证的是整条链路：渲染层 click → preload → IPC →
    // 主进程下载 → 结果推回卡片。跑完退出，不等用户操作。
    if (process.argv.includes('--log-smoke')) {
      setTimeout(async () => {
        try {
          if (!(lastCells || []).some((cell) => cell.kind === 'build')) {
            logger.warn('[log-smoke] 没有 build 格子（没配 Jenkins，或者第一轮还没拉到）');
            app.exit(1);
            return;
          }
          const before = await dock.debugCard('build');
          logger.info(`[log-smoke] 点击前 ${JSON.stringify(before.buttons)}`);
          await dock.debugCard('build', '下载日志');
          // 等结果：按钮从"下载中…"变成"已保存"/"下载失败"
          for (let i = 0; i < 60; i++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const now = await dock.debugCard('build');
            const settled = (now.buttons || []).find((button) => button.text === '已保存' || button.text === '下载失败');
            if (settled) {
              logger.info(`[log-smoke] 结果 ${JSON.stringify(now.buttons)}`);
              app.exit(0);
              return;
            }
          }
          logger.warn('[log-smoke] 30 秒内没等到结果');
          app.exit(1);
        } catch (error) {
          logger.warn(`[log-smoke] 失败：${error.message}`);
          app.exit(1);
        }
      }, 8000);
    }

    // 自检用：--home-smoke 打开主界面，dump 分区和每一行，然后点第一个"跟踪中"
    // 把它取消跟踪，确认配置真的写进去、行也挪到了「未跟踪」区。
    const homeShowOnly = process.argv.includes('--home-smoke=show');
    if (process.argv.includes('--home-smoke') || homeShowOnly) {
      setTimeout(async () => {
        try {
          openHome();
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const read = () => homeWindow.webContents.executeJavaScript(`(() => ({
            meta: document.getElementById('meta')?.textContent || '',
            groups: [...document.querySelectorAll('.group')].map((g) => ({
              title: g.querySelector('.group-title')?.textContent,
              count: g.querySelector('.group-count')?.textContent,
              rows: [...g.querySelectorAll('.item')].map((r) => ({
                name: r.querySelector('.item-name')?.textContent,
                subject: r.querySelector('.item-subject')?.textContent,
                meta: r.querySelector('.item-meta')?.textContent,
                action: r.querySelector('.item-action')?.textContent,
                past: r.dataset.past,
                updated: r.dataset.updated
              }))
            }))
          }))()`);
          const railLabels = async () => (await dock.debugRail?.())?.labels || [];
          logger.info(`[home-smoke] 打开前 ${JSON.stringify(await read())}`);
          logger.info(`[home-smoke] 竖条（改前）${JSON.stringify(await railLabels())}`);
          const before = await read();
          const target = homeShowOnly ? null : (before.groups[0]?.rows || [])[0];
          if (target) {
            // 故意制造竞争：先踢一脚轮询，趁它还在飞就点"取消订阅" ——
            // 这正是"两侧条目数对不上"的触发条件
            poller?.pollNow();
            await new Promise((resolve) => setTimeout(resolve, 60));
            await homeWindow.webContents.executeJavaScript(
              "document.querySelector('.group .item .item-action')?.click()"
            );
            // 150ms 就读竖条：一次 SSH 轮询要 1~3 秒，能在这时候就变说明是就地过滤的
            await new Promise((resolve) => setTimeout(resolve, 150));
            logger.info(`[home-smoke] 竖条（改后 150ms）${JSON.stringify(await railLabels())}`);
            await new Promise((resolve) => setTimeout(resolve, 650));
            logger.info(`[home-smoke] 取消订阅 ${target.name} → muted=${JSON.stringify(store.get().mutedItems)}`);
            logger.info(`[home-smoke] 之后 ${JSON.stringify(await read())}`);
            // 悬浮气泡：派发 mouseenter，然后看**另一个窗口**里画了什么
            await homeWindow.webContents.executeJavaScript(
              "document.querySelector('.group .item')?.dispatchEvent(new MouseEvent('mouseenter'))"
            );
            await new Promise((resolve) => setTimeout(resolve, 700));
            const pop = hoverWindow && !hoverWindow.isDestroyed()
              ? await hoverWindow.webContents.executeJavaScript(`(() => ({
                title: document.querySelector('.card-project')?.textContent || '',
                subject: document.querySelector('.card-subject')?.textContent || '',
                meta: document.querySelector('.card-meta')?.textContent || '',
                events: [...document.querySelectorAll('.event-text')].map((el) => el.textContent),
                buttons: [...document.querySelectorAll('.card-foot button')].map((el) => getComputedStyle(el).display)
              }))()`).catch((error) => `(读取失败: ${error.message})`)
              : null;
            // 等一整轮轮询跑完，确认两侧条目数一致（之前会在这里对不上）
            await new Promise((resolve) => setTimeout(resolve, 5000));
            const railAfter = await railLabels();
            const settled = await read();
            const subscribed = Number(settled.groups?.[0]?.count || 0);
            logger.info(`[home-smoke] 轮询一圈后：竖条 ${railAfter.length} 格 / 主界面订阅 ${subscribed} 条`
              + ` → ${railAfter.length === subscribed ? '一致' : '不一致'}`);
            logger.info(`[home-smoke] 气泡窗口=${JSON.stringify(hoverWindow?.getBounds?.() || null)} 内容=${JSON.stringify(pop)}`);
          }
          await diagnose();
        } catch (error) {
          logger.warn(`[home-smoke] 失败：${error.message}`);
        } finally {
          app.exit(0);
        }
      }, 9000);
    }

    // 自检用：--hover-smoke 打开主界面、悬停第一行，然后**在气泡还显示着的时候**截图
    if (process.argv.includes('--hover-smoke')) {
      setTimeout(async () => {
        try {
          openHome();
          await new Promise((resolve) => setTimeout(resolve, 2600));
          await homeWindow.webContents.executeJavaScript(
            "document.querySelector('.group .item')?.dispatchEvent(new MouseEvent('mouseenter'))"
          );
          await new Promise((resolve) => setTimeout(resolve, 900));
          logger.info(`[hover-smoke] 气泡=${JSON.stringify(hoverWindow?.getBounds?.() || null)}`
            + ` 主界面=${JSON.stringify(homeWindow?.getBounds?.() || null)}`);
          await diagnose();
        } catch (error) {
          logger.warn(`[hover-smoke] 失败：${error.message}`);
        } finally {
          app.exit(0);
        }
      }, 8000);
    }

    // 自检用：--wechat-smoke 往队列里塞一条假消息，看发送/重试那套跑得对不对。
    // 把 flow 指到一个不存在的文件就能在不碰微信的情况下跑完整条失败路径。
    if (process.argv.includes('--wechat-smoke')) {
      setTimeout(() => {
        logger.info(`[wechat] 自检：flow=${resolveWechatFlow()}`);
        wechatQueue.push({
          cell: { id: 'build|Smoke~Job', job: 'Smoke~Job', number: 0, stages: [] },
          state: 'FAILURE'
        });
        pumpWeChat();
      }, 5000);
      setTimeout(() => app.exit(0), 40000);
    }

    // 自检用：--drag-smoke=real|card 用真实鼠标把面板往下拖 120px，看它跟不跟手。
    // real 从竖条上拖，card 从卡片正文上拖（两条入口）。
    const realDragArg = process.argv.find((arg) => arg.startsWith('--drag-smoke='));
    if (realDragArg) {
      setTimeout(async () => {
        const before = screen.getCursorScreenPoint();
        try {
          const ring = dock.debugRailPoint?.(0);
          if (ring) await moveCursor(...Object.values(screen.dipToScreenPoint(ring)));
          await new Promise((resolve) => setTimeout(resolve, 600));
          if (realDragArg.endsWith('=card')) {
            const card = dock.surfaceStates?.().find((item) => item.name === 'card')?.bounds;
            if (!card) throw new Error('没有卡片窗口');
            const spot = { x: card.x + Math.round(card.width / 2), y: card.y + 40 };
            await moveCursor(...Object.values(screen.dipToScreenPoint(spot)));
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          const start = dock.surfaceStates?.().find((s) => s.name === 'rail')?.bounds;
          // 从卡片上拖时面板已经贴着底边了，往下拖会被夹住 —— 往上拖
          const error = await dragBy(0, realDragArg.endsWith('=card') ? -60 : 120);
          await new Promise((resolve) => setTimeout(resolve, 400));
          const end = dock.surfaceStates?.().find((s) => s.name === 'rail')?.bounds;
          logger.info(`[drag-smoke] 真实拖动=${error || '已发出'} 起点=${JSON.stringify(start)} 终点=${JSON.stringify(end)}`);
        } catch (error) {
          logger.warn(`[drag-smoke] 失败：${error.message}`);
        } finally {
          const physical = screen.dipToScreenPoint(before);
          await moveCursor(physical.x, physical.y);
          app.exit(0);
        }
      }, 8000);
    }

    // 自检用：--refresh-smoke 点卡片上的「刷新」，然后每 200ms 读一次按钮状态，
    // 看这条链通不通：点击 → 主进程拉一轮 → 推 running/done → 按钮转圈再回弹。
    if (process.argv.includes('--refresh-smoke')) {
      setTimeout(async () => {
        try {
          dock.debugFocus?.(0);
          await new Promise((resolve) => setTimeout(resolve, 600));
          const before = await dock.debugRefreshButton?.(true);
          logger.info(`[refresh-smoke] 点击前 ${JSON.stringify(before)}`);
          for (let i = 0; i < 40; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            const now = await dock.debugRefreshButton?.(false);
            logger.info(`[refresh-smoke] +${(i + 1) * 200}ms ${JSON.stringify(now)}`);
            if (i > 3 && now?.state === 'idle') break;
          }
        } catch (error) {
          logger.warn(`[refresh-smoke] 失败：${error.message}`);
        } finally {
          app.exit(0);
        }
      }, 9000);
    }

    // 自检用：--open-smoke 走一遍用户真实路径：光标挪到圆环（出卡片）→ 挪到卡片
    // 的「在 Gerrit 打开」→ 真点一下（操作系统级点击）。测完光标挪回原处。
    // 会真的开一次浏览器（本来就是按钮的功能），所以别在忙的时候跑。
    if (process.argv.includes('--open-smoke')) {
      setTimeout(async () => {
        const before = screen.getCursorScreenPoint();
        const wasPhysical = screen.dipToScreenPoint(before);
        try {
          // 走用户那条路：先把光标放到圆环上（tick 会 focus → 出卡片），
          // 再挪到卡片按钮上（tick 会判定 inCard → 窗口变可点）
          const move = async (dip) => {
            const physical = screen.dipToScreenPoint({ x: dip.x, y: dip.y });
            return moveCursor(physical.x, physical.y);
          };
          const ring = dock.debugRailPoint?.(0);
          if (ring) await move(ring);
          await new Promise((resolve) => setTimeout(resolve, 700));
          const hover = dock.pointerState?.() || {};
          const spot = await dock.debugCardPoint?.('Gerrit');
          let moveError = '';
          if (spot) moveError = await move(spot);
          await new Promise((resolve) => setTimeout(resolve, 350));
          const state = dock.pointerState?.() || {};
          logger.info(`[open-smoke] 悬停圆环时=${JSON.stringify(hover)} 按钮 DIP=${JSON.stringify(spot)}`
            + ` 光标=${JSON.stringify(screen.getCursorScreenPoint())} 移动=${moveError || '无'}`);
          logger.info(`[open-smoke] 主进程视角：${JSON.stringify({
            inCard: state.inCard, inCorridor: state.inCorridor, cardVisible: state.cardVisible
          })}`);
          // 真点（操作系统级鼠标事件），和用户手点同一条路
          const clickError = await clickHere();
          await new Promise((resolve) => setTimeout(resolve, 1200));
          logger.info(`[open-smoke] 真点击=${clickError || '已发出'}；收到打开请求 ${openedCount} 次`);
        } catch (error) {
          logger.warn(`[open-smoke] 失败：${error.message}`);
        } finally {
          await moveCursor(wasPhysical.x, wasPhysical.y);
          app.exit(0);
        }
      }, 8000);
    }

    // 自检用：--dock-smoke=<top|bottom|left|right> 把面板摆到指定的边，
    // 读回真实几何（窗口 bounds / side）和竖条 DOM，截一张图，然后退出。
    // 四条边共用一套骨架，靠它一眼看出哪条边没接上。测完把位置改回原来的。
    const smokeArg = process.argv.find((arg) => arg.startsWith('--dock-smoke='));
    if (smokeArg) {
      const edge = smokeArg.split('=')[1];
      setTimeout(async () => {
        const previous = store.get().position;
        try {
          const display = screen.getPrimaryDisplay();
          const work = display.workArea;
          // 底边贴的是屏幕底（面板压在任务栏上），顶边和左右贴工作区
          const screenBottom = display.bounds.y + display.bounds.height;
          const thickness = 64;
          const horizontal = edge === 'top' || edge === 'bottom';
          const position = {
            x: horizontal ? work.x + 300
              : (edge === 'left' ? work.x : work.x + work.width - thickness),
            y: horizontal
              ? (edge === 'top' ? work.y : screenBottom - thickness)
              : work.y + 200,
            edge
          };
          logger.info(`[dock-smoke] display=${JSON.stringify({ bounds: display.bounds, workArea: display.workArea })}`);
          store.save({ position });
          dock.refreshLayout();
          // 等第一轮数据到（首轮要 4~8 秒），否则量到的是"读取中"那块小面板
          for (let i = 0; i < 30 && !lastCells?.length; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          await new Promise((resolve) => setTimeout(resolve, 900));
          // 顺手把卡片摆出来：横排的卡片挂在上/下方，尾巴朝向竖条，位置最容易错
          await dock.debugCard(0);
          await new Promise((resolve) => setTimeout(resolve, 500));
          logger.info(`[dock-smoke] ${edge} surfaces=${JSON.stringify(dock.surfaceStates?.() || null)}`);
          logger.info(`[dock-smoke] ${edge} rail=${JSON.stringify(await dock.debugRail())}`);
          logger.info(`[dock-smoke] ${edge} card=${JSON.stringify(await dock.debugCard(0))}`);
          // 拖离：贴着边开始，往上每步 10px —— y 应该跟着走，不许粘在边上
          const away = await dock.debugDragAway?.({ dy: -10, steps: 6 });
          logger.info(`[dock-smoke] ${edge} 拖离 ${JSON.stringify(away)}`);
          // 拖离会退回原位，中间有一段 200ms 形变，等它跑完再截图
          await new Promise((resolve) => setTimeout(resolve, 700));
          await diagnose();
        } catch (error) {
          logger.warn(`[dock-smoke] 失败：${error.message}`);
        } finally {
          // 位置是这个自检唯一改过的东西，测完放回去
          if (previous) store.save({ position: previous });
          app.exit(0);
        }
      }, 6000);
    }

    // 自检用：--preview-smoke 会在 8 秒后把不透明度预览到 5%，用来验证
    // "预览 → 渲染层" 这条链路本身通不通（绕过设置窗的 UI）。
    // 自检用：--settings-smoke 直接在设置页里触发真实的 input 事件，
    // 验证"滑杆 → preload → 主进程 → 悬浮层"整条链路（不依赖鼠标点击）。
    // 自检：程序化拖动某个滑杆到多个值，然后 dump 全部窗口，检查有没有多出窗口
    const slideArg = process.argv.find((arg) => arg.startsWith('--slide='));
    if (slideArg) {
      const sliderId = slideArg.split('=')[1];
      setTimeout(async () => {
        try {
          if (!settingsWindow || settingsWindow.isDestroyed()) openSettings();
          await new Promise((resolve) => setTimeout(resolve, 1800));
          for (const value of ['0', '100', '50']) {
            await settingsWindow.webContents.executeJavaScript(
              '(() => { const el = document.getElementById(' + JSON.stringify(sliderId) + ');'
              + ' if (!el) return "no slider"; el.value = ' + JSON.stringify(value) + ';'
              + ' el.dispatchEvent(new Event("input", { bubbles: true })); return el.value; })()'
            );
            await new Promise((resolve) => setTimeout(resolve, 900));
            logger.info(`[slide] ${sliderId}=${value} → 窗口数 ${BrowserWindow.getAllWindows().length}`);
          }
          await diagnose();
        } catch (error) { logger.warn(`[slide] 失败：${error.message}`); }
      }, 5000);
    }

    if (process.argv.includes('--drag-smoke')) {
      setTimeout(async () => {
        // 贴边 → 悬空 → 跨屏 → 顶边（横排）→ 底边（贴上沿）→ 底边（压任务栏）→ 回右侧
        for (const spot of [
          { x: 1190, y: 320 }, { x: 1032, y: 300 }, { x: 1600, y: 200 },
          { x: 520, y: 6 }, { x: 500, y: 446 }, { x: 500, y: 700 }, { x: 1190, y: 320 }
        ]) {
          try {
            const result = await dock?.debugDrop?.(spot);
            const states = dock?.surfaceStates?.() || [];
            const rail = states.find((state) => state.name === 'rail');
            const dom = await dock?.debugRail?.();
            logger.info(`[drag] 松手 ${spot.x},${spot.y} → 落在 ${result.x},${result.y}`
              + ` edge=${result.side} attached=${result.attached}`
              + ` 窗口=${rail?.bounds?.width}x${rail?.bounds?.height} 格数=${result.cells}`
              + ` 环y=${JSON.stringify((dom?.rings || []).map((ring) => ring.y))}`
              + ` 形变=${result.morphs} 总数=${result.total} 空态=${dom?.empty || ''} 转圈=${dom?.spinner} 环=${JSON.stringify(dom?.loading)}`);
          } catch (error) { logger.warn(`[drag] ${error.message}`); }
        }
      }, Number(process.env.DRAG_DELAY_MS) || 6000);
    }

    if (process.argv.includes('--mousedrag-smoke')) {
      setTimeout(async () => {
        try {
          const r = await dock?.debugMouseDrag?.();
          logger.info(`[mousedrag] ${JSON.stringify(r)}`);
        } catch (error) { logger.warn(`[mousedrag] ${error.message}`); }
      }, 6000);
    }

    if (process.argv.includes('--watchdog-smoke')) {
      setTimeout(async () => {
        try {
          const result = await dock?.debugDragWatchdog?.();
          logger.info(`[watchdog] 开始拖拽=${result?.started} 看门狗已收起=${result?.endedByWatchdog}`);
        } catch (error) { logger.warn(`[watchdog] ${error.message}`); }
      }, 5000);
    }

    if (process.argv.includes('--fade-smoke')) {
      setTimeout(async () => {
        try {
          const frames = await dock?.debugFade?.();
          for (const frame of frames || []) {
            logger.info(`[fade] ${frame.t} handle=${frame.handle} rail=${frame.rail} card=${frame.card}`);
          }
        } catch (error) { logger.warn(`[fade] ${error.message}`); }
      }, 4000);
    }

    if (process.argv.includes('--card-smoke')) {
      setTimeout(async () => {
        try {
          const info = await dock?.debugCard?.(process.env.CARD_INDEX || 0);
          logger.info(`[smoke] 卡片 DOM：${JSON.stringify(info)}`);
          await diagnose();
        } catch (error) { logger.warn(`[smoke] ${error.message}`); }
      }, Number(process.env.SMOKE_DELAY_MS) || 14000);
    }

    if (process.argv.includes('--settings-smoke')) {
      setTimeout(async () => {
        try {
          if (!settingsWindow || settingsWindow.isDestroyed()) openSettings();
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const read = () => settingsWindow.webContents.executeJavaScript(
            "getComputedStyle(document.getElementById('shell')).backgroundColor"
          );
          const setAlpha = (value) => settingsWindow.webContents.executeJavaScript(`(() => {
            const slider = document.getElementById('settingsAlpha');
            slider.value = '${value}';
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            return new Promise((resolve) => setTimeout(() => resolve(
              document.getElementById('previewState')?.textContent || '(无状态标签)'
            ), 350));
          })()`);
          const at100 = await setAlpha(100);
          const c100 = await read();
          const at20 = await setAlpha(20);
          const c20 = await read();
          logger.info(`[smoke] 外壳底色 100%=${c100}  20%=${c20}`);
          logger.info(`[smoke] 状态行：${at100} / ${at20}`);
        } catch (error) {
          logger.warn(`[smoke] 失败：${error.message}`);
        }
      }, SMOKE_DELAY_MS);
    }

    if (process.argv.includes('--preview-smoke')) {
      setTimeout(() => {
        logger.info('[smoke] 预览 glassAlpha=5');
        dock?.setPreview({ glassAlpha: 5 });
      }, 8000);
    }

    // 第一次运行：先读本机配置，识别到了就直接用，然后弹设置窗确认认证方式
    if (!DEMO) bootstrapFromMachine();
  });

  // 竖条是常驻的：关掉设置窗不该退出应用。加一个空监听就足以吃掉默认的退出行为。
  app.on('window-all-closed', () => { /* 常驻 */ });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    poller?.stop();
    clearInterval(demoTimer);
    dock?.stop();
  });
}
