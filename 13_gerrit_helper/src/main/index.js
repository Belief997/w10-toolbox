'use strict';

// 主进程入口：装配 store / gerrit 客户端 / 轮询 / 三块 surface / 托盘 / 设置窗。

const path = require('node:path');
const fs = require('node:fs');
const {
  app, BrowserWindow, Menu, Notification, Tray, desktopCapturer, dialog, globalShortcut,
  ipcMain, nativeImage, screen, session, shell
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
const { createPoller } = require('./poller');
const { createNotifier } = require('./notify');
const { diffCells } = require('../shared/diff');
const { sanitizeImport, summarize, toExportable } = require('../shared/config-io');
const demo = require('./demo');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const DOCK_PRELOAD = path.join(__dirname, 'preload-dock.js');
const SETTINGS_PRELOAD = path.join(__dirname, 'preload-settings.js');
const DEMO = process.argv.includes('--demo');

let dock = null;
let poller = null;
let notifier = null;
let client = null;
let jenkinsClient = null;
let tray = null;
let settingsWindow = null;
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

function openUrl(url) {
  if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url);
}

function handleCells(cells, result = {}) {
  const events = diffCells(lastCells, cells);
  lastCells = cells;
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
    onManualRefresh: () => poller?.pollNow(),
    onOpenSettings: openSettings,
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
    backdrop = createBackdrop({ app, screen, logger });
    logger.info(`start demo=${DEMO} pid=${process.pid} log=${logger.file}`);
    registerSettingsIpc();
    notifier = createNotifier({
      getConfig: store.get,
      onClick: (event) => openUrl(event?.url)
    });
    buildDock();
    restartPipeline();
    buildTray();
    globalShortcut.register('Control+Alt+D', () => diagnose());

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
        // 贴边 → 悬空 → 跨屏 → 顶边（横排）→ 回右侧
        for (const spot of [
          { x: 1190, y: 320 }, { x: 1032, y: 300 }, { x: 1600, y: 200 },
          { x: 520, y: 6 }, { x: 1190, y: 320 }
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
