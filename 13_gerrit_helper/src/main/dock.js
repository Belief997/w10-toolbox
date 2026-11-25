'use strict';

// 三块 surface：把手、竖条、卡片。每一块都是一个独立的小窗口。
//
// 为什么不是一个大窗口：卡片的宽度和高度都要溢出竖条，形状也不一样（带尾巴），
// 而且卡片要在不重排竖条的前提下随内容长高。三块各自 setBounds + setShape 最直接。
//
// 鼠标事件不靠 DOM：窗口穿透时收不到任何事件，所以命中测试全部在这里用
// screen.getCursorScreenPoint() 轮询完成，渲染层只负责画。

const path = require('node:path');
const {
  METRICS, cardCommands, peekCommands, railCommands, shapeRectsFromPolygons, toPolygons, toSvgPath
} = require('./surfaces');
const { sortCells } = require('../shared/diff');
const { clampToWorkArea, snapOnRelease } = require('../shared/placement');
const { railLength } = require('../shared/rail-size');
const { dragExpired, nextDragClock } = require('../shared/drag-watch');

const REVEAL_MS = 140;
const HIDE_MS = 320;
// 自动隐藏模式下，启动时先把竖条亮出来再收起 ——
// 不然一启动就是"只剩个小把手"，用户根本不知道它停在哪、有没有起来。
// 亮多久不按"启动了几秒"算，而是**等第一轮数据到了之后再亮 HOLD 秒** ——
// 本来就是想让人看见"有哪些格子"，数据没到的亮相没意义。
const INTRO_HOLD_MS = 2500;
// 兜底：一直拉不到数据（没网/没配置）也别永远亮着
const INTRO_MAX_MS = 15000;
// 离开交互区到收起卡片之间的宽限：跨过竖条和卡片之间的缝时不要闪
const CARD_HIDE_MS = 260;
// 状态变化后主动弹气泡的停留时间
const FLASH_MS = 6000;
const POLL_ACTIVE = 40;
const POLL_IDLE = 90;
const EDGE_TRIGGER = 24;

const rectContains = (rect, point) => Boolean(rect && point)
  && point.x >= rect.x && point.x < rect.x + rect.width
  && point.y >= rect.y && point.y < rect.y + rect.height;

function createDock(options) {
  const {
    BrowserWindow, ipcMain, screen,
    rendererDir, preloadPath,
    getConfig, onOpenUrl, backdrop = null, logger = console
  } = options;
  const backdrops = new Map(); // BrowserWindow → 亚克力 surface
  const SURFACE_NAMES = ['handle', 'rail', 'card'];
  // 最近 40 条可见性相关事件。出问题时 Ctrl+Alt+D 一按，
  // 就能看到"谁在什么时候把哪块面板显示出来了"，不用再靠猜。
  const trace = [];
  function note(message) {
    trace.push(`${new Date().toISOString().slice(11, 23)} ${message}`);
    if (trace.length > 40) trace.shift();
  }
  const hiddenSince = { handle: 0, rail: 0, card: 0 };

  const wins = { handle: null, rail: null, card: null };
  const shapeKeys = { handle: '', rail: '', card: '' };
  let cells = [];
  let focused = -1;
  let revealed = false;
  // 启动亮相的截止时间（自动隐藏模式下，这段时间内先不收）
  let introUntil = 0;
  // 第一轮数据到达的时刻；0 = 还没到
  let introDataAt = 0;
  // 竖条正在淡出：这期间先别放小把手出来（两块不同时在场）
  let railFadingOut = false;
  let cardVisible = false;
  let cardHeight = 0;
  let cardPayload = null;
  let cardFlash = null;
  // 第一轮拉取回来之前面板是空的。这时候显示"正在读取"，
  // 而不是"还没有跟踪的 change" —— 后者会让人以为项目丢了
  let hasData = false;
  let running = false;
  let pollTimer = null;
  let dwellSince = null;
  let leaveSince = null;
  let cardLeaveSince = 0;
  // 主动弹出的气泡：队列 + 截止时间。用户在操作时让位，不抢悬停
  const flashQueue = [];
  let flashUntil = 0;
  let flashTimer = null;
  let ipcReady = false;
  // 竖条一屏放不下时，滚轮在格子之间翻页。0 = 从最上面一条开始
  let scrollOffset = 0;

  // 预览层：设置窗里改显示项时立刻生效，保存前不落盘。
  // 值为 null 表示跟随已保存的配置。
  let preview = null;
  function readConfig(key) {
    if (preview && preview[key] !== undefined && preview[key] !== null) return preview[key];
    return getConfig()[key];
  }

  // 拖动中的实时位置；不落盘，松手才写配置
  let livePosition = null;
  let drag = null;
  // 上一次推给渲染层的竖条几何。变了就重推格子坐标
  let lastRailKey = '';

  const side = () => railGeometry().side;

  // ---- 几何 --------------------------------------------------------------

  // 格子最小尺寸：42px 的环 + 4px 间距 + 11px 标签
  const MIN_CELL_HEIGHT = 60;
  // 横排时只受环的直径约束（42 + 左右留白）
  const MIN_CELL_WIDTH = 50;

  // 装不下就逐级压缩格子高度（10 条 change 才塞得进一屏），
  // 压到最小还装不下才截断 —— 静默丢跟踪项比挤一点更糟。
  // 竖条当前所在的显示器：拖动时跟光标，否则跟已保存的位置。
  // 用主屏的话，拖到另一块屏会被夹回主屏 —— 跨屏拖动就废了。
  function activeDisplay(anchor = null) {
    const target = anchor || livePosition || readConfig('position');
    if (!target) return screen.getPrimaryDisplay();
    try {
      return screen.getDisplayNearestPoint({ x: Math.round(target.x), y: Math.round(target.y) })
        || screen.getPrimaryDisplay();
    } catch (_) {
      return screen.getPrimaryDisplay();
    }
  }

  // ---- 形态过渡 ----------------------------------------------------------
  //
  // 贴边 ↔ 悬空不只是圆角不同：凹肩收起来、两端留白 28→10、窗口矮 36px。
  // 直接换路径会"啪"一下，所以拖离边缘（还没松手）时把两套轮廓逐点插值。
  // 两套轮廓用的是同一套骨架（见 surfaces.js 的 attachedRail），点数和顺序一致，
  // 所以不需要重采样，也不会中途打结。
  // 自检时可以用环境变量放慢，方便截到中间帧
  const MORPH_MS = Number(process.env.MORPH_MS) || 200;
  const MORPH_TICK = 24;
  let morph = null;
  let morphCount = 0; // 自检用：一共形变过几次
  let drawn = null; // { key, commands, geo } —— 上一次真正画出去的形态
  const easeOut = (t) => 1 - (1 - t) ** 3;

  function railCommandsFor(rail) {
    return railCommands({
      width: rail.width, height: rail.height, side: rail.side,
      shoulder: METRICS.shoulder, radius: METRICS.railRadius,
      // 形态完全按配置：贴边就是凹肩形态（加载态也一样），
      // 加载块靠"居中在玻璃体里"避开两端收窄的肩位
      attached: rail.attached
    });
  }

  function lerpShape(from, to, t) {
    if (!Array.isArray(from) || from.length !== to.length) return to;
    return to.map((command, index) => {
      const source = from[index];
      if (!source || source[0] !== command[0] || source.length !== command.length) return command;
      const next = [command[0]];
      for (let k = 1; k < command.length; k += 1) {
        next.push(source[k] + (command[k] - source[k]) * t);
      }
      return next;
    });
  }

  const lerpNumber = (a, b, t) => a + (b - a) * t;

  // 形变中途的几何：位置跟实时值，尺寸/留白在起止两套之间插值
  function lerpRail(from, to, t) {
    return {
      ...to,
      x: to.x,
      y: to.y,
      width: lerpNumber(from.width, to.width, t),
      height: lerpNumber(from.height, to.height, t),
      along: lerpNumber(from.along, to.along, t),
      topPad: lerpNumber(from.topPad, to.topPad, t),
      cellSize: lerpNumber(from.cellSize, to.cellSize, t)
    };
  }

  function shapeClass(rail) {
    return `${rail.side}:${rail.attached}`;
  }

  function startMorph(from, target) {
    if (morph) clearInterval(morph.timer);
    morphCount += 1;
    note(`morph ${from.key} → ${shapeClass(target)}`);
    morph = {
      from,
      toClass: shapeClass(target),
      startedAt: Date.now(),
      timer: setInterval(stepMorph, MORPH_TICK)
    };
    stepMorph();
  }

  function stepMorph() {
    if (!morph) return;
    const target = railGeometry();
    // 形变途中又拖回去了：从当前这一帧接着往回变，别跳回起点
    if (shapeClass(target) !== morph.toClass) {
      morph.from = morph.last || morph.from;
      morph.toClass = shapeClass(target);
      morph.startedAt = Date.now();
    }
    const t = Math.min(1, (Date.now() - morph.startedAt) / MORPH_MS);
    const eased = easeOut(t);
    const rail = lerpRail(morph.from.geo, target, eased);
    const commands = lerpShape(morph.from.commands, railCommandsFor(target), eased);
    place('rail', rail, commands,
      `morph:${Math.round(t * 100)}:${rail.x},${rail.y}:${Math.round(rail.width)}x${Math.round(rail.height)}`);
    sendCells(rail);
    morph.last = { commands, geo: rail };
    if (t >= 1) {
      clearInterval(morph.timer);
      morph = null;
      drawn = { key: shapeClass(target), commands: railCommandsFor(target), geo: target };
      layout();
    }
  }

  function railGeometry() {
    const m = METRICS;
    const saved = livePosition || readConfig('position') || null;
    const work = activeDisplay(saved).workArea;
    // 轴向在拖动开始时锁住（横竖来回翻转会让窗口尺寸跳动），
    // 但"贴不贴边"必须跟着实时位置走 —— 否则拖离边缘时形状不动，只能等松手。
    // 没有落盘位置时默认贴右边缘 —— 这里必须先把 x 定下来再判"贴哪边"，
    // 否则 rawX 是 0、leftGap 是 0，会被判成贴左边缘：窗口在右边、形状却镜像成左边
    const rawX = saved ? Math.round(saved.x) : work.x + work.width - m.railWidth;
    const rawY = saved ? Math.round(saved.y) : work.y;
    const leftGap = rawX - work.x;
    const rightGap = work.x + work.width - (rawX + m.railWidth);
    const topGap = rawY - work.y;
    // 轴向：贴着顶边就横排。拖动中也实时跟位置走 —— 形态切换有 200ms 形变兜着，
    // 不会再"啪"一下；这样从顶部拖下来时面板会边转边变成竖条。
    // 角上按侧边处理（和松手时的 snap 一致），不然在右上角会来回翻。
    const horizontal = drag
      ? (topGap <= 2 && leftGap > 2 && rightGap > 2)
      : saved?.edge === 'top';
    const attached = horizontal
      ? topGap <= 2
      : (leftGap <= 2 || rightGap <= 2);

    // 贴边时两端要留出凹肩的空间（28）。悬空时没有凹肩，只留 2：
    // 贴边形态的玻璃体本身就是从 y=28 开始的，第一个环落在 38.5 ——
    // 离玻璃边缘 10.5px；悬空留 2 时环落在 12.5，玻璃从 y=1 开始 → 11.5px。
    // 两种状态的"环到边缘"看起来一样，切形态时内容不会明显位移。
    const topPad = attached ? m.shoulder : 2;
    const chrome = topPad * 2 + m.padding * 2;

    const count = Math.max(0, cells.length);
    // 沿轴方向的可用长度：竖排看工作区高度，横排看宽度
    const available = Math.max(MIN_CELL_HEIGHT, (horizontal ? work.width : work.height) - m.screenMargin * 2);
    // 还没有数据时面板里放的是"转圈 + 读取中"，长度不能按 0 格算 ——
    // 悬空 chrome 只有 12px、贴边的玻璃体只有中间一截，环都会被裁
    const loadingOnly = count === 0 && !hasData;
    const { cellSize, natural, along } = railLength({
      count,
      cellSize: horizontal ? m.cellWidth : m.cellHeight,
      minSize: horizontal ? MIN_CELL_WIDTH : MIN_CELL_HEIGHT,
      topPad,
      padding: m.padding,
      cellGap: m.cellGap,
      available,
      loading: loadingOnly
    });
    // 横排时 thickness 是高度，竖排时是宽度 —— 两者都等于 railWidth
    const thickness = m.railWidth;

    const width = horizontal ? along : thickness;
    const height = horizontal ? thickness : along;

    let x;
    let y;
    if (saved) {
      x = saved.x;
      y = saved.y;
    } else if (horizontal) {
      x = work.x + Math.round((work.width - width) / 2);
      y = work.y;
    } else {
      x = work.x + work.width - thickness;
      y = work.y + m.screenMargin
        + Math.round((work.height - height - m.screenMargin * 2) * 0.5);
    }

    // 任何时候都要求完整留在工作区内（撞到边界就是极限）
    const clamped = clampToWorkArea({ x, y, width, height, workArea: work });
    const side = horizontal ? 'top'
      : (attached && leftGap <= 2) || (!attached && clamped.x + thickness / 2 < work.x + work.width / 2)
        ? 'left' : 'right';
    // edge 是"落盘/锁定"的形态，attached 是"此刻贴没贴边"。
    // 拖动中两者会不一样：形状跟 attached 走，松手时 snap 才结算 edge。
    const edge = horizontal ? 'top' : (attached ? (leftGap <= 2 ? 'left' : 'right') : null);
    return {
      x: clamped.x, y: clamped.y, width, height, natural,
      cellSize, along, side, edge, horizontal, attached, topPad, thickness
    };
  }

  // 每一格在竖条里的位置（四条边都给，渲染层直接套）。
  // 和渲染层用的是同一组数字 —— 悬停命中靠它。
  function cellSlots(rail) {
    const m = METRICS;
    const slots = [];
    const size = rail.cellSize || (rail.horizontal ? m.cellWidth : m.cellHeight);
    let cursor = (rail.topPad ?? m.shoulder) + m.padding;
    for (let index = 0; index < cells.length; index += 1) {
      if (cursor + size > rail.along) break;
      if (rail.horizontal) {
        slots.push({ left: cursor, top: m.padding, width: size, height: rail.height - m.padding * 2 });
      } else {
        slots.push({ left: m.padding, top: cursor, width: rail.width - m.padding * 2, height: size });
      }
      cursor += size + m.cellGap;
    }
    return slots;
  }

  // 放不下的格子直接不渲染 —— 否则它会落到 0 压在第一条上。
  // 喂给渲染层的数组、命中测试、点击映射必须用同一个切片。
  function capacity(rail = railGeometry()) {
    return cellSlots(rail).length;
  }

  function clampScroll(value, rail = railGeometry()) {
    const limit = Math.max(0, cells.length - capacity(rail));
    const next = Math.max(0, Math.min(limit, value));
    scrollOffset = next;
    return next;
  }

  function visibleCells(rail = railGeometry()) {
    const list = cells.slice(scrollOffset, scrollOffset + capacity(rail));
    return list;
  }

  // 竖条只画圆环和数字，用不到评论/时间线。把这两个字段剥掉再发，
  // 否则 37 条 change × 40 条评论每轮刷新都要走一遍 IPC。
  function cellSummary(cell) {
    const { events, lastComment, ...rest } = cell;
    return rest;
  }

  function handleGeometry(rail) {
    const m = METRICS;
    const work = activeDisplay().workArea;
    if (rail.side === 'top') {
      // 横排时把手也是横的，贴在工作区顶边、竖条中段
      const width = Math.min(m.peekLength, Math.max(24, rail.width));
      return {
        x: rail.x + Math.round((rail.width - width) / 2),
        y: work.y,
        width,
        height: m.peekWidth
      };
    }
    const height = Math.min(m.peekLength, Math.max(24, rail.height));
    return {
      x: rail.side === 'left' ? work.x : work.x + work.width - m.peekWidth,
      y: rail.y + Math.round((rail.height - height) / 2),
      width: m.peekWidth,
      height
    };
  }

  function cardGeometry(rail) {
    const m = METRICS;
    const work = activeDisplay().workArea;
    if (!cardHeight || focused < 0) return null;
    const slot = cellSlots(rail)[focused];
    if (!slot) return null;

    if (rail.side === 'top') {
      // 竖条在顶部：卡片挂在它下面，尾巴朝上。窗口高度要多留尾巴那一截。
      const width = m.cardWidth;
      const height = Math.min(cardHeight + m.cardTail, work.height - m.screenMargin * 2);
      const centerX = rail.x + slot.left + slot.width / 2;
      const x = Math.round(Math.max(
        work.x + m.screenMargin,
        Math.min(work.x + work.width - width - m.screenMargin, centerX - width / 2)
      ));
      const y = Math.round(Math.min(
        rail.y + rail.height + m.cardGap,
        work.y + work.height - height - m.screenMargin
      ));
      return { x, y, width, height, tailX: Math.round(centerX - x) };
    }

    const width = m.cardWidth + m.cardTail;
    const height = Math.min(cardHeight, work.height - m.screenMargin * 2);
    const centerY = rail.y + slot.top + slot.height / 2;
    const y = Math.round(Math.max(
      work.y + m.screenMargin,
      Math.min(work.y + work.height - height - m.screenMargin, centerY - height / 2)
    ));
    const x = rail.side === 'left'
      ? rail.x + rail.width + m.cardGap
      : rail.x - m.cardGap - width;
    return { x, y, width, height, tailY: Math.round(centerY - y) };
  }

  // ---- 窗口 --------------------------------------------------------------

  function createWindow(name, width, height) {
    const win = new BrowserWindow({
      width, height, show: false,
      frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, alwaysOnTop: true,
      hasShadow: false, transparent: true, backgroundColor: '#00000000',
      // WS_EX_TOOLWINDOW：不加的话 Shell 会在 showInactive 之后把窗塞回
      // 任务栏和 DWM 缩略图；thickFrame:false 去掉缩放边框。
      type: 'toolbar', thickFrame: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setIgnoreMouseEvents(true);
    // 建好就置 0：opacity 表记录的是真实值，不能靠"默认是 1"来假设
    win.setOpacity(0);
    win.setMenuBarVisibility?.(false);
    // 亚克力只跟着形状走；拿不到就保持半透明底色，不影响功能
    if (backdrop?.available()) {
      const surface = backdrop.attach(win, (on) => {
        if (wins[name] !== win) return;
        logger.info?.(`[dock] ${name} 材质 ${on ? '亚克力' : '半透明底色'}`);
        send(name, 'dock:material', { native: on });
      });
      backdrops.set(win, surface);
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    // 页面加载完成之前 send() 会被丢掉（isLoading 时直接返回），所以这里补一次
    // 全量渲染 —— 否则首轮推的 cells 会永久丢失，竖条一直停在"还没跟踪"。
    win.webContents.on('did-finish-load', () => {
      layout();
      pushAppearance();
      if (name === 'card' && cardPayload) sendCard(cardPayload);
    });
    win.loadFile(path.join(rendererDir, 'dock', 'index.html'), { query: { surface: name } });
    win.on('closed', () => {
      backdrops.delete(win);
      if (wins[name] === win) wins[name] = null;
    });
    return win;
  }

  function ensureWindows() {
    if (wins.rail && !wins.rail.isDestroyed()) return;
    wins.handle = createWindow('handle', METRICS.peekWidth, METRICS.peekLength);
    wins.rail = createWindow('rail', METRICS.railWidth, 200);
    wins.card = createWindow('card', METRICS.cardWidth + METRICS.cardTail, 160);
  }

  // 移动 + 上形状。形状和 bounds 必须同一次做完，否则会有一帧的矩形材质。
  function place(name, bounds, commands, key) {
    const win = wins[name];
    if (!win || win.isDestroyed() || !bounds) return;
    const current = win.getBounds();
    const next = {
      x: Math.round(bounds.x), y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height))
    };
    if (current.x !== next.x || current.y !== next.y
      || current.width !== next.width || current.height !== next.height) {
      win.setBounds(next);
    }
    if (shapeKeys[name] === key) return;
    // 窗口尺寸以 setBounds 之后读回来的为准：Windows 对很小的窗口有最小尺寸
    // （横排的把手只有 10px 高，会被撑到 38px）。按请求值算形状的话，
    // 形状会被抓到窗口中间，region 那 10px 里什么都看不见。
    const actual = win.getBounds();
    try {
      if (typeof win.setShape === 'function') {
        win.setShape(shapeRectsFromPolygons(toPolygons(commands), actual.width, actual.height));
      }
    } catch (error) {
      logger.warn(`[dock] ${name} setShape 失败：${error.message}`);
    }
    // 只有送达才算数：页面没加载完就先不记 key，did-finish-load 时再补一次
    // 带上宽高：渲染层的 window.innerWidth 在 setBounds 之后不保证立刻更新，
    // 用 innerWidth 当 viewBox 会让路径和窗口错位（卡片下半截没有材质）。
    if (send(name, 'dock:shape', {
      d: toSvgPath(commands),
      outline: toSvgPath(commands.filter(([op]) => op !== 'Z')),
      width: actual.width,
      height: actual.height
    })) shapeKeys[name] = key;
    // 原生材质用同一份命令做几何裁剪
    backdrops.get(win)?.update({ key, commands });
  }

  // 返回是否真的送达 —— 页面还在加载时 send 会被丢掉，
  // 调用方必须知道，否则会把"已发送"的状态记下来，之后再也不会重发。
  // 卡片数据统一从这里发：主动气泡的文案要跟着一起走，
  // 否则轮询触发的重发会把它冲掉，看起来像"气泡弹了但没有更新说明"
  function sendCard(cell) {
    send('card', 'card:cell', { cell, side: side(), flash: cardFlash || undefined });
  }

  function send(name, channel, payload) {
    const win = wins[name];
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return false;
    try { win.webContents.send(channel, payload); return true; }
    catch (_) { return false; /* 窗口正在销毁 */ }
  }

  // 背景不透明度（0-100）→ 0~1，线性。100 就是完全不透明，0 就是全透。
  // 竖条的 tint 和亚克力底层都用这个系数 —— 只改网页那层的话，
  // 后面的原生材质岿然不动，用户会觉得滑杆没反应。
  function glassFactor() {
    const percent = Math.max(0, Math.min(100, Number(readConfig('glassAlpha')) || 0));
    return percent / 100;
  }

  // 窗口透明度和亚克力透明度必须同步，否则玻璃和内容会错层
  function applyOpacity(win, value) {
    if (!win || win.isDestroyed()) return;
    win.setOpacity(value);
    backdrops.get(win)?.setOpacity(value * glassFactor());
  }

  // 只改了不透明度时，重新把当前窗口透明度套一遍到亚克力底层
  function syncBackdropOpacity() {
    for (const name of SURFACE_NAMES) {
      const win = wins[name];
      if (!win || win.isDestroyed()) continue;
      backdrops.get(win)?.setOpacity(win.getOpacity() * glassFactor());
    }
  }

  // 每个 surface 只有一个"目标不透明度"，由一个节拍器统一推进。
  //
  // 之前是每次 setVisible 各起一个 setInterval 且从不取消上一个：
  // 显示和隐藏各跑各的，最后一个写谁就停在谁那儿 —— 表现就是
  // "悬停后移开，卡片/把手留在屏幕上，看起来像多了一条侧边栏"。
  // 改成目标值 + 单一节拍后，任何时刻只可能有一个驱动者，状态天然收敛。
  const target = { handle: 0, rail: 0, card: 0 };
  // 淡出收敛后的回调（例如"竖条淡完了再把小把手放出来"）
  const afterHide = { handle: null, rail: null, card: null };
  let fadeTimer = null;

  // 以窗口自身的透明度为准，不维护影子状态 —— 影子一旦和真实值错开，
  // 节拍器会以为"已经收好了"而停下，那块 surface 就永远留在屏幕上。
  function stepFades() {
    for (const name of Object.keys(target)) {
      const win = wins[name];
      if (!win || win.isDestroyed()) continue;
      const from = win.getOpacity();
      const to = target[name];
      if (Math.abs(to - from) <= 0.02) {
        if (to === 0) settleHidden(name);
        else if (from !== to) applyOpacity(win, to);
        continue;
      }
      // 指数逼近：永远朝目标走，不可能过冲。
      // 淡入要跟手（0.34 ≈ 4 帧就到位），淡出要看得见 ——
      // 以前两边都是 0.32，收起全程不到 80ms，等于硬切，看不出是动画。
      // 卡片收得比竖条快一点：鼠标一移开就贴着走，别拖尾巴
      if (process.env.FADE_TRACE === '1') console.info('[fade] ' + name + ' ' + from.toFixed(2) + ' -> ' + to);
      const rate = to > from ? 0.34 : (name === 'card' ? 0.26 : 0.22);
      applyOpacity(win, from + (to - from) * rate);
    }
    // 注意不能用循环里那个 active 收尾：收敛回调里可能刚刚又给另一块设了新目标
    // （"竖条淡完再把把手放出来"就是），那时 active 已经过期，直接停节拍器
    // 会让把手停在 0 永远不出现。这里重新按真实透明度判一次。
    const pendingFade = SURFACE_NAMES.some((name) => {
      const win = wins[name];
      if (!win || win.isDestroyed()) return false;
      return Math.abs(target[name] - win.getOpacity()) > 0.02;
    });
    if (!pendingFade && fadeTimer) {
      if (process.env.FADE_TRACE === '1') console.info('[fade] stop  missing=' + JSON.stringify(SURFACE_NAMES.filter((n) => !wins[n])) + ' opacity=' + JSON.stringify(SURFACE_NAMES.map((n) => [n, wins[n]?.getOpacity?.(), target[n]])));
      clearInterval(fadeTimer); fadeTimer = null;
    }
  }

  function setTarget(name, value) {
    if (target[name] === value) return;
    target[name] = value;
    if (!fadeTimer) fadeTimer = setInterval(stepFades, 16);
  }

  // 规则：**可以淡出，但不许交叉**。
  //
  // 竖条和把手是"一个收起、另一个出现"，如果淡出和淡入同时进行，
  // 那 200ms 里两块都半透明地摆在屏幕上，就是当初那个"一大一小叠在一起"。
  // 所以收起走淡出、等它淡完（onHidden 回调）才让另一块淡入 —— 严格串行。
  function surfaceOf(sender) {
    return SURFACE_NAMES.find((name) => {
      const win = wins[name];
      return win && !win.isDestroyed() && win.webContents === sender;
    }) || null;
  }

  // 收干净：透明度归零 + 真正 hide() + 兑现"淡完之后要做什么"的回调。
  // 节拍器收敛和 setVisible(false) 都会走到这里 —— 只留一条路径，
  // 否则谁先到谁就把回调吃掉（每轮 tick 都会调 setVisible，很容易抢在前面）。
  function settleHidden(name) {
    const win = wins[name];
    if (win && !win.isDestroyed()) {
      target[name] = 0;
      applyOpacity(win, 0);
      if (win.isVisible()) { note(`${name} 隐藏`); win.hide(); }
    }
    const done = afterHide[name];
    afterHide[name] = null;
    if (typeof done === 'function') done();
  }

  function setVisible(name, visible, onHidden = null) {
    const win = wins[name];
    if (!win || win.isDestroyed()) return;
    if (!visible) {
      // 只在给了回调时才登记 —— 每轮 tick 都会调一次，不传回调的那次
      // 不能把"竖条淡完再放把手"给冲掉
      if (typeof onHidden === 'function') afterHide[name] = onHidden;
      if (win.getOpacity() <= 0.02) { settleHidden(name); return; }
      // 还有可见度：交给节拍器淡出，收敛到 0 时再 settleHidden
      setTarget(name, 0);
      return;
    }
    if (!win.isVisible()) {
      note(`${name} 显示 (visible=true)`);
      applyOpacity(win, 0);
      win.showInactive();
      // showInactive 之后重设一次：Electron 的浮动层级会被非置顶任务栏挤掉
      win.setAlwaysOnTop(true, 'pop-up-menu');
      win.setSkipTaskbar?.(true);
    }
    setTarget(name, 1);
  }

  // ---- 布局刷新 ----------------------------------------------------------

  // 推格子：渲染层的坐标、命中测试、点击映射都用这一份切片
  function sendCells(rail) {
    clampScroll(scrollOffset, rail);
    const slots = cellSlots(rail);
    send('rail', 'dock:cells', {
      cells: cells.slice(scrollOffset, scrollOffset + slots.length).map(cellSummary),
      total: cells.length,
      loading: !hasData,
      offset: scrollOffset,
      hasMore: scrollOffset + slots.length < cells.length,
      hasLess: scrollOffset > 0,
      side: rail.side,
      revealed: revealed || getConfig().mode === 'always',
      focused,
      slots,
      railHeight: rail.height,
      // 玻璃体从哪开始（贴边时两端是凹肩，内容要避开）：加载块/空态文案居中在它里面
      bodyInset: Math.round(rail.topPad || 0)
    });
  }

  function layout({ pushCells = true } = {}) {
    const rail = railGeometry();
    const handle = handleGeometry(rail);
    const card = cardGeometry(rail);

    // 形变中：竖条的绘制（形状 + 格子坐标）交给 stepMorph，
    // 这里只更新位置和另外两块 surface，否则两边互相覆盖。
    if (!morph) {
      const commands = railCommandsFor(rail);
      const key = shapeClass(rail);
      if (drawn && drawn.key !== key) {
        // 任何形态切换都走形变：凹肩收放、以及横排↔竖排（骨架同序，插值出来正好是旋转）
        startMorph(drawn, rail);
      } else {
        place('rail', rail, commands, `rail:${rail.width}x${rail.height}:${key}`);
        drawn = { key, commands, geo: rail };
      }
    }

    place('handle', handle, peekCommands({
      width: handle.width, height: handle.height, side: rail.side,
      handleWidth: METRICS.handleWidth, handleLength: METRICS.handleLength
    }), `handle:${handle.width}x${handle.height}:${rail.side}`);

    if (card) {
      place('card', card, cardCommands({
        width: card.width, height: card.height, side: rail.side,
        tail: METRICS.cardTail, tailY: card.tailY ?? card.tailX,
        neck: METRICS.cardNeck, radius: METRICS.cardRadius
      }), `card:${card.width}x${card.height}:${card.tailY ?? card.tailX}:${rail.side}`);
    }

    // 形状变了就必须把格子坐标一起推过去。以前只在 pushCells 时推，
    // 而 tick() 是 pushCells:false —— 贴边/悬空切换时形状先变、格子后变，
    // 渲染层就拿着上一套坐标去贴新形状：第一个环冒出玻璃上沿，或者上下不对称。
    const railKey = `${rail.width}x${rail.height}:${rail.topPad}:${rail.side}:${rail.cellSize}`;
    if (!morph && (pushCells || railKey !== lastRailKey)) {
      lastRailKey = railKey;
      sendCells(rail);
    }
    return { rail, handle, card };
  }

  // ---- 光标轮询 ----------------------------------------------------------

  function tick() {
    const { rail, handle, card } = layout({ pushCells: false });
    const point = screen.getCursorScreenPoint();
    const mode = readConfig('mode');
    const work = activeDisplay().workArea;
    const now = Date.now();

    if (drag) {
      // 看门狗：光标脱离窗口后收不到 mouseup，超过 1.2 秒没动就认定拖拽结束
      if (dragExpired(drag, now)) endDrag();
      else followDrag(point);
      toggleInteractive('rail', true);
      toggleInteractive('handle', false);
      toggleInteractive('card', false);
      return;
    }

    const inRail = revealed && rectContains(rail, point);
    const inHandle = !revealed && rectContains(handle, point);
    const inCard = cardVisible && rectContains(card, point);
    // 竖条和卡片之间有几像素的空隙，光标从圆环移到卡片必然穿过它。
    // 不把这段算进"还在交互区内"，卡片会在半路被当成"鼠标离开了"而收起 ——
    // 这就是之前点不到卡片按钮的原因。
    const inCorridor = Boolean(card) && cardVisible && rectContains(cardCorridor(rail, card), point);
    // 靠边唤醒的热区：贴哪条边就看哪条边，范围跟着竖条的长度走
    const inTrigger = !revealed && (rail.side === 'top'
      ? point.y >= work.y && point.y <= work.y + EDGE_TRIGGER
        && point.x >= rail.x && point.x <= rail.x + rail.width
      : (rail.side === 'right'
        ? point.x >= work.x + work.width - EDGE_TRIGGER && point.x <= work.x + work.width
        : point.x >= work.x && point.x <= work.x + EDGE_TRIGGER)
        && point.y >= rail.y && point.y <= rail.y + rail.height);

    // 露出 / 收起
    if (!revealed) {
      if (mode === 'always' || inTrigger || inHandle) {
        if (mode === 'always') reveal();
        else {
          if (dwellSince === null) dwellSince = now;
          if (now - dwellSince >= REVEAL_MS) reveal();
        }
      } else dwellSince = null;
    } else if (mode !== 'always' && now >= introUntil
      && !inRail && !inCard && !inCorridor && !rectContains(handle, point)) {
      if (leaveSince === null) leaveSince = now;
      if (now - leaveSince >= HIDE_MS) retract();
    } else {
      leaveSince = null;
    }

    // 命中的格子（竖排看 y，横排看 x）
    let hovered = -1;
    if (revealed && inRail) {
      const slots = cellSlots(rail);
      const local = rail.horizontal ? point.x - rail.x : point.y - rail.y;
      // 格子之间的 2px 缝算给上一格：否则光标正好落在缝里时会 focus(-1)、
      // 卡片闪一下收了再开。
      for (let index = 0; index < slots.length; index += 1) {
        const start = rail.horizontal ? slots[index].left : slots[index].top;
        const size = rail.horizontal ? slots[index].width : slots[index].height;
        if (local >= start && local < start + size + METRICS.cellGap) { hovered = index; break; }
      }
    }
    // 切格子：只有真的落到某一格上才换卡片
    if (hovered >= 0 && hovered !== focused) focus(hovered);

    // 收卡片：只认一条规则 —— 指针不在"竖条 ∪ 卡片 ∪ 走廊"里就收。
    //
    // 之前是靠 hovered !== focused 间接判断的，那意味着"收不收"取决于
    // focused 这个变量是不是跟上了；只要有一处没跟上（卡片是穿透的、
    // 窗口被别的操作打断），focused 就会一直停在旧值，卡片永久留在屏幕上。
    // 独立的一条规则不受任何其他状态影响，也不会因为某个分支漏写而失效。
    const insideDock = inRail || inCard || inCorridor;
    // 用户在气泡期间碰到了悬浮层 → 主动气泡立即让位给正常悬停
    if (flashUntil && insideDock) endFlash();
    if (cardVisible && !insideDock && !flashUntil) {
      if (!cardLeaveSince) cardLeaveSince = now;
      else if (now - cardLeaveSince >= CARD_HIDE_MS) {
        focused = -1;
        hideCard();
        send('rail', 'dock:focus', { focused: -1 });
      }
    } else if (cardVisible) {
      cardLeaveSince = 0;
    }

    // 队列里还有就接着弹
    if (!flashUntil && flashQueue.length && !insideDock && focused < 0) nextFlash();

    // 穿透：只有光标真的在上面时才吃鼠标
    // 每个 tick 重新声明一次目标可见性。这不是冗余：只要有一处状态漏了恢复
    // （定时器被打断、窗口重建、模式切换），下一次轮询就会把它拉回来。
    setVisible('rail', revealed);
    setVisible('handle', !revealed && !railFadingOut && mode !== 'always');
    // 硬闸：卡片只在"有格子被聚焦"时才允许显示。
    // cardVisible 只要有任何一个路径漏了复位，这里就不让它出来 ——
    // 显不显示不再取决于单一变量的正确性。
    setVisible('card', cardVisible && focused >= 0);

    // 兜底：该藏起来却迟迟不收敛的 surface，强制收掉并记一笔。
    // 万一还有我没找到的路径，至少不会让一块面板永久糊在桌面上。
    for (const name of SURFACE_NAMES) {
      const win = wins[name];
      if (!win || win.isDestroyed() || target[name] !== 0) { hiddenSince[name] = 0; continue; }
      const value = win.getOpacity();
      if (value <= 0.02) { hiddenSince[name] = 0; continue; }
      if (!hiddenSince[name]) hiddenSince[name] = now;
      else if (now - hiddenSince[name] > 1000) {
        logger.warn(`[dock] ${name} 该隐藏却停在 opacity=${value.toFixed(2)}，已强制收掉`);
        applyOpacity(win, 0);
        hiddenSince[name] = 0;
      }
    }

    toggleInteractive('rail', revealed && inRail);
    toggleInteractive('handle', inHandle || (revealed && rectContains(handle, point)));
    toggleInteractive('card', inCard);
  }

  // ---- 拖拽 --------------------------------------------------------------

  function beginDrag() {
    const win = wins.rail;
    if (!win || win.isDestroyed()) return;
    // 正在淡出的那一两百毫秒里 revealed 已经翻成 false，但面板还在屏幕上 ——
    // 这时候抓上去必须能拖，否则就是"看着在、拖不动"。真看不见才忽略。
    if (!revealed) {
      const opacity = win.getOpacity();
      if (!win.isVisible() || opacity < 0.2) {
        logger.info?.(`[drag] 忽略拖拽：面板不可见 (revealed=${revealed} opacity=${opacity.toFixed(2)})`);
        return;
      }
      revealed = true;
      railFadingOut = false;
      leaveSince = null;
      hideNow('handle');
    }
    const bounds = win.getBounds();
    logger.info?.(`[drag] 开始 ${bounds.x},${bounds.y}`);
    // 不再锁轴向：横竖切换有形变过渡，跟着位置实时变才自然
    const origin = screen.getCursorScreenPoint();
    drag = {
      pointer: origin, bounds,
      lastPoint: { x: origin.x, y: origin.y },
      lastMove: Date.now()
    };
    livePosition = { x: bounds.x, y: bounds.y };
    hideCard();
    focused = -1;
    send('rail', 'dock:focus', { focused: -1 });
  }

  function followDrag(point) {
    if (!drag) return;
    // 只有光标真的动了才刷新时间戳（见 shared/drag-watch.js 的说明）
    Object.assign(drag, nextDragClock(drag, point, Date.now()));
    livePosition = {
      x: Math.round(drag.bounds.x + (point.x - drag.pointer.x)),
      y: Math.round(drag.bounds.y + (point.y - drag.pointer.y))
    };
    layout();
  }

  function endDrag() {
    if (!drag) return;
    drag = null;

    // 磁吸：离边缘够近才贴上去，否则停在原地。
    // 贴到顶边之后竖条会横过来 —— 形态由 edge 决定，不由 x/y 猜。
    let geometry = railGeometry();
    let edge = geometry.edge;
    if (readConfig('snap') === true) {
      const work = activeDisplay(livePosition).workArea;
      const snapped = snapOnRelease({
        x: geometry.x, y: geometry.y,
        width: geometry.width, height: geometry.height,
        workArea: work
      });
      // 带上 edge：这次 layout 还在用 livePosition，不带的话会按 x 猜成竖排，
      // 贴到顶部时会闪一下竖条再横过来
      livePosition = { x: snapped.x, y: snapped.y, edge: snapped.edge ?? null };
      edge = snapped.edge;
      layout();
    }

    const finalPosition = { x: livePosition.x, y: livePosition.y, edge: edge ?? null };
    logger.info?.(`[drag] 结束 ${finalPosition.x},${finalPosition.y} edge=${finalPosition.edge}`);
    livePosition = null;
    try {
      options.onPlacementChange?.({ position: finalPosition });
    } catch (error) {
      logger.warn?.(`[dock] 位置保存失败：${error.message}`);
    }
    layout();
  }

  // 竖条与卡片之间的过渡带：竖排时是两者之间那道横缝，
  // 横排时是上下之间那道竖缝。只补缝隙，不把整个包围盒都算进来 ——
  // 否则光标从卡片上方绕过去时卡片也不收。
  function cardCorridor(rail, card) {
    if (!rail || !card) return null;
    if (rail.side === 'top') {
      const from = Math.min(rail.y + rail.height, card.y);
      const to = Math.max(rail.y + rail.height, card.y);
      return {
        x: Math.min(rail.x, card.x),
        y: from - 2,
        width: Math.max(rail.x + rail.width, card.x + card.width) - Math.min(rail.x, card.x),
        height: Math.max(0, to - from) + 4
      };
    }
    const left = Math.min(rail.x + rail.width, card.x + card.width);
    const right = Math.max(rail.x, card.x);
    return {
      x: left - 2,
      y: Math.min(rail.y, card.y),
      width: Math.max(0, right - left) + 4,
      height: Math.max(rail.y + rail.height, card.y + card.height) - Math.min(rail.y, card.y)
    };
  }

  function toggleInteractive(name, interactive) {
    const win = wins[name];
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!interactive);
  }

  // 瞬隐：竖条淡入的同时把手不能还在淡出，否则两块半透明叠在一起
  function hideNow(name) {
    const win = wins[name];
    if (!win || win.isDestroyed()) return;
    target[name] = 0;
    afterHide[name] = null;
    applyOpacity(win, 0);
    if (win.isVisible()) { note(`${name} 瞬隐`); win.hide(); }
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    railFadingOut = false;
    dwellSince = null;
    setVisible('rail', true);
    hideNow('handle');
    send('rail', 'dock:revealed', { revealed: true });
    layout();
  }

  function retract() {
    if (!revealed) return;
    revealed = false;
    leaveSince = null;
    hideCard();
    // 竖条先淡出，淡完再把小把手放出来 —— 串行，不会两块叠在一起
    railFadingOut = true;
    setVisible('rail', false, () => {
      railFadingOut = false;
      if (!revealed) setVisible('handle', true);
    });
    send('rail', 'dock:revealed', { revealed: false });
    toggleInteractive('rail', false);
  }

  function focus(index) {
    note(`focus ${focused} -> ${index}`);
    focused = index;
    if (index < 0) {
      hideCard();
      send('rail', 'dock:focus', { focused: -1 });
      return;
    }
    send('rail', 'dock:focus', { focused: index });
    const cell = visibleCells()[index];
    if (!cell) return;
    cardPayload = cell;
    cardHeight = 0;
    cardFlash = null;
    sendCard(cell);
  }

  // ---- 主动气泡 ----------------------------------------------------------

  // 队列里每一条：{ cellId, texts: [...] }。一次只弹一个，弹完再弹下一个。
  function flashCells(items) {
    for (const item of items || []) {
      if (item?.cellId && item.texts?.length) flashQueue.push(item);
    }
  }

  function nextFlash() {
    if (flashTimer || !flashQueue.length || !running) return;
    const item = flashQueue.shift();
    const list = visibleCells();
    const index = list.findIndex((cell) => cell.id === item.cellId);
    // 不在当前页（被滚走了或排在后面）就跳过，不为了它去滚动
    if (index < 0) { setTimeout(nextFlash, 0); return; }

    focused = index;
    cardHeight = 0;
    cardPayload = list[index];
    cardFlash = item.texts;
    flashUntil = Date.now() + FLASH_MS;
    sendCard(list[index]);
    send('rail', 'dock:focus', { focused: index });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      if (!flashUntil) return;
      endFlash();
    }, FLASH_MS);
  }

  function endFlash() {
    if (!flashUntil) return;
    flashUntil = 0;
    cardFlash = null;
    clearTimeout(flashTimer);
    flashTimer = null;
    focused = -1;
    hideCard();
    send('rail', 'dock:focus', { focused: -1 });
  }

  function showCardIfMeasured() {
    note(`showCardIfMeasured h=${cardHeight} focused=${focused} cardVisible=${cardVisible}`);
    if (cardHeight <= 0 || focused < 0) return;
    layout();
    if (!cardVisible) {
      cardVisible = true;
      setVisible('card', true);
    }
  }

  function hideCard() {
    note(`hideCard cardVisible=${cardVisible}`);
    if (!cardVisible) return;
    cardVisible = false;
    setVisible('card', false);
  }

  // ---- 对外 --------------------------------------------------------------

  function schedule() {
    if (!running) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, revealed || cardVisible ? POLL_ACTIVE : POLL_IDLE);
  }

  function poll() {
    pollTimer = null;
    if (!running) return;
    try { tick(); } catch (error) { logger.warn(`[dock] poll 失败：${error.message}`); }
    schedule();
  }

  function registerIpc() {
    if (ipcReady) return;
    ipcReady = true;

    ipcMain.on('dock:click', (event, payload) => {
      const index = Number(payload?.index);
      if (!Number.isInteger(index)) return;
      const cell = visibleCells()[index];
      if (cell?.url) onOpenUrl?.(cell.url);
    });
    // 滚轮翻页：光标在竖条上时窗口是接收鼠标的，wheel 事件能到渲染层
    ipcMain.on('dock:scroll', (event, payload) => {
      const delta = Number(payload?.delta) || 0;
      if (!delta) return;
      const before = scrollOffset;
      clampScroll(scrollOffset + delta);
      if (scrollOffset !== before) {
        focused = -1;
        hideCard();
        layout();
      }
    });
    ipcMain.on('dock:dragStart', (event) => {
      if (surfaceOf(event.sender) !== 'rail') return;
      beginDrag();
    });
    ipcMain.on('dock:dragEnd', (event) => {
      if (surfaceOf(event.sender) !== 'rail') return;
      endDrag();
    });
    ipcMain.on('dock:manualRefresh', () => options.onManualRefresh?.());
    ipcMain.on('dock:openSettings', () => options.onOpenSettings?.());
    ipcMain.on('dock:cardSize', (event, payload) => {
      const height = Math.round(Number(payload?.height));
      if (!Number.isFinite(height) || height <= 0) return;
      if (height === cardHeight) { showCardIfMeasured(); return; }
      cardHeight = height;
      showCardIfMeasured();
    });
    // 卡片上的「下载日志」：只透传 cellId，下载本身在主进程入口里做
    ipcMain.on('dock:downloadLog', (event, payload) => {
      const cellId = String(payload?.cellId || '');
      if (!cellId) return;
      options.onDownloadLog?.(cellId);
    });
    ipcMain.on('dock:openUrl', (event, payload) => {
      const url = String(payload?.url || '');
      if (/^https?:\/\//i.test(url)) onOpenUrl?.(url);
    });
  }

  // 外观不跟着格子走：改透明度不需要重建窗口，推一次就行
  function pushAppearance() {
    const payload = { glassAlpha: readConfig('glassAlpha') ?? 70 };
    for (const name of SURFACE_NAMES) send(name, 'dock:appearance', payload);
    syncBackdropOpacity();
  }

  function start() {
    if (running) return;
    running = true;
    ensureWindows();
    registerIpc();
    // 起来先把该藏的两块真正藏掉，别指望"默认是隐藏的"
    for (const name of ['card', 'handle']) {
      const win = wins[name];
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    }
    const config = getConfig();
    if (config.mode === 'always') {
      revealed = true;
      introUntil = 0;
      setVisible('rail', true);
      setVisible('handle', false);
    } else {
      // 自动隐藏：先亮着，等第一轮数据到了再亮 HOLD 秒，然后走收起的动画。
      // 这期间如果鼠标已经压在竖条上，收起会自然推迟（tick 里的进出判断接管）。
      revealed = true;
      introDataAt = 0;
      introUntil = Date.now() + INTRO_MAX_MS; // 兜底，数据到了会缩短
      setVisible('rail', true);
      setVisible('handle', false);
    }
    layout();
    pushAppearance();
    schedule();
  }

  function stop() {
    running = false;
    clearTimeout(pollTimer);
    pollTimer = null;
    for (const name of Object.keys(wins)) {
      const win = wins[name];
      if (win && !win.isDestroyed()) win.destroy();
      wins[name] = null;
      shapeKeys[name] = '';
    }
    clearInterval(fadeTimer);
    fadeTimer = null;
    clearTimeout(flashTimer);
    flashTimer = null;
    flashUntil = 0;
    cardFlash = null;
    flashQueue.length = 0;
    for (const name of Object.keys(target)) target[name] = 0;
    cells = [];
    focused = -1;
    cardVisible = false;
    cardPayload = null;
    revealed = false;
    trace.length = 0;
  }

  return {
    start,
    stop,
    // 设置窗实时预览：只需要传显示相关的键
    setPreview(patch) {
      if (!patch) { preview = null; }
      else {
        preview = { ...(preview || {}) };
        for (const key of ['mode', 'snap', 'glassAlpha', 'sort', 'material']) {
          if (patch[key] !== undefined) preview[key] = patch[key];
        }
      }
      if (!running) return;
      // 无论设置还是清除预览，都按"当前生效的排序"重排一次 ——
      // 否则预览时改过排序、关掉设置窗后格子会停在预览顺序上，要等下一轮轮询才复位。
      cells = sortCells(cells, readConfig('sort'));
      layout();
      pushAppearance();
    },

    hasPreview: () => Boolean(preview),

    flashCells,

    // 诊断用：这个窗口是不是本 dock 管的
    owns: (win) => SURFACE_NAMES.some((name) => wins[name] === win),

    // 自检用：模拟"拖到某个位置后松手"，用来单独验证磁吸，不依赖鼠标
    debugDrop: async ({ x, y }) => {
      if (!running) return null;
      livePosition = { x: Math.round(x), y: Math.round(y) };
      drag = { pointer: { x: 0, y: 0 }, bounds: { x: 0, y: 0 }, lastMove: Date.now(), edge: null };
      layout();
      endDrag();
      // 松手后会有一段形变，等它跑完再量，否则量到的是动画中间态
      await new Promise((resolve) => setTimeout(resolve, 320));
      const geometry = railGeometry();
      return {
        x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height,
        side: geometry.side, attached: geometry.attached, cells: cellSlots(geometry).length,
        total: cells.length,
        handle: handleGeometry(geometry), morphs: morphCount, snap: readConfig('snap')
      };
    },

    // 自检用：走**渲染层那条真实路径**跑一次拖拽（合成 mousedown/mousemove/mouseup），
    // 验证 渲染层 → IPC → beginDrag/followDrag/endDrag 整条链还是通的
    debugMouseDrag: async () => {
      const win = wins.rail;
      if (!win || win.isDestroyed()) return '(无竖条窗口)';
      // 不主动 reveal：要看"用户当前所处的状态"下拖拽能不能用
      const state = {
        revealed,
        railVisible: win.isVisible(),
        railOpacity: Number(win.getOpacity().toFixed(2)),
        handleVisible: Boolean(wins.handle && !wins.handle.isDestroyed() && wins.handle.isVisible()),
        fading: railFadingOut
      };
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = win.getBounds();
      const base = { x: before.x + 24, y: before.y + 24 };
      await win.webContents.executeJavaScript(`(() => {
        const fire = (type, x, y) => window.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, button: 0, buttons: 1, screenX: x, screenY: y
        }));
        fire('mousedown', ${base.x}, ${base.y});
        fire('mousemove', ${base.x + 8}, ${base.y + 8});
        fire('mousemove', ${base.x + 70}, ${base.y + 50});
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const dragging = Boolean(drag);
      const during = win.getBounds();
      await win.webContents.executeJavaScript(
        "window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))"
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        state,
        dragging,
        movedDuringDrag: during.x !== before.x || during.y !== before.y,
        stillDraggingAfterUp: Boolean(drag)
      };
    },

    // 自检用：开始一次拖拽但**不松手**（模拟 mouseup 丢失），看门狗应该把它收掉。
    // 这条曾经是坏的：followDrag 每一拍刷新 lastMove，看门狗永远不会触发，
    // dock 会一直卡在"拖动中"——之后就再也拖不动了。
    debugDragWatchdog: async (waitMs = 1600) => {
      if (!running) return null;
      reveal();
      await new Promise((resolve) => setTimeout(resolve, 260));
      beginDrag();
      const started = Boolean(drag);
      // 直接把"上次移动时间"推到过去，模拟光标静置超过阈值（真机上鼠标可能一直在动）
      if (drag) {
        const p = screen.getCursorScreenPoint();
        drag.lastPoint = { x: p.x, y: p.y };
        drag.lastMove = Date.now() - 5000;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 300)));
      const ended = !drag;
      if (drag) endDrag(); // 清干净，别把自检状态的拖拽留在那儿
      return { started, endedByWatchdog: ended };
    },

    // 自检用：把"露出 → 收起"跑一遍，按 40ms 采样三块 surface 的透明度。
    // 动画靠肉眼很难确认，这样能直接看到曲线 —— 是不是真的在淡、有没有两块同时在场。
    debugFade: async () => {
      if (!running) return null;
      const sample = () => SURFACE_NAMES.map((name) => {
        const win = wins[name];
        return win && !win.isDestroyed() ? Number(win.getOpacity().toFixed(2)) : -1;
      });
      const frames = [];
      const record = (label) => frames.push({ t: label, handle: sample()[0], rail: sample()[1], card: sample()[2] });
      reveal();
      for (let i = 0; i < 12; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        record(`in${i}`);
      }
      retract();
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        record(`out${i}`);
      }
      return frames;
    },

    // 调试用：读竖条窗口里的实际 DOM —— 环的位置和形状是否对得上，
    // 只能靠"元素真的落在哪"来判断，不能靠算出来的坐标。
    debugRail: () => {
      const win = wins.rail;
      if (!win || win.isDestroyed()) return Promise.resolve('(无竖条窗口)');
      return win.webContents.executeJavaScript(`(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { y: Math.round(r.y), x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
        };
        return {
          win: { w: innerWidth, h: innerHeight },
          edge: document.body.dataset.edge,
          empty: document.querySelector('.empty')?.textContent || '',
          // 有 spinner 且动画真的在跑，才算"loading 动画生效"
          spinner: (() => {
            const el = document.querySelector('.loading-ring');
            return el ? getComputedStyle(el).animationName : '';
          })(),
          // loading 块的几何：窗口装不下的话环会被裁掉
          loading: (() => {
            const ring = document.querySelector('.loading-ring');
            if (!ring) return null;
            const r = ring.getBoundingClientRect();
            return {
              win: [innerWidth, innerHeight],
              ring: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
            };
          })(),
          rings: [...document.querySelectorAll('.ring')].map(box),
          labels: [...document.querySelectorAll('.cell-label')].map((el) => el.textContent)
        };
      })()`).catch((error) => `(读取失败: ${error.message})`);
    },

    // 调试用：读卡片窗口里的实际 DOM。
    // 卡片只有在 hover/气泡时才可见，所以先把第一格用气泡逼出来，
    // 再看圆点这些"看得见看不见"的元素真实量到多少像素。
    // clickText：给了就顺手点一下名字等于它的那个底部按钮（自检用 ——
    // 「下载日志」这条链路必须真的从渲染层点下去，否则测不到 preload + IPC）
    debugCard: async (want = 0, clickText = '') => {
      const win = wins.card;
      if (!win || win.isDestroyed()) return '(无卡片窗口)';
      const list = visibleCells();
      if (!cardVisible && list.length) {
        // 直接摆出来，不走气泡队列 —— 队列要看光标位置，自检不能依赖它
        // want 可以是序号，也可以是 'build' 这种 kind
        const wanted = typeof want === 'string' && !/^\d+$/.test(want)
          ? list.findIndex((cell) => cell.kind === want || cell.state === want)
          : Number(want) || 0;
        const index = Math.min(Math.max(0, wanted), list.length - 1);
        focused = index;
        cardHeight = 0;
        cardPayload = list[index];
        cardFlash = ['自检'];
        flashUntil = Date.now() + 4000;
        sendCard(list[index]);
        send('rail', 'dock:focus', { focused: index });
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      if (clickText) {
        await win.webContents.executeJavaScript(`(() => {
          const button = [...document.querySelectorAll('.card-foot button')]
            .find((el) => el.textContent.trim() === ${JSON.stringify(String(clickText))});
          if (!button) return 'no-button';
          button.click();
          return 'clicked';
        })()`).catch(() => 'click-failed');
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return win.webContents.executeJavaScript(`(() => {
        const all = (sel) => [...document.querySelectorAll(sel)];
        const box = (el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { w: Math.round(r.width), h: Math.round(r.height),
                   x: Math.round(r.x), y: Math.round(r.y),
                   bg: cs.backgroundColor, op: cs.opacity, vis: cs.visibility };
        };
        const scroll = document.querySelector('.card-timeline-body');
        return {
          win: { w: innerWidth, h: innerHeight },
          // scrollbarWidth 必须是 auto，否则自定义滚动条样式不生效（两端会冒出箭头按钮）
          scrollbar: scroll ? {
            width: getComputedStyle(scroll).scrollbarWidth,
            scrollH: scroll.scrollHeight,
            clientH: scroll.clientHeight
          } : null,
          card: all('.card').map(box),
          // 底部按钮：三个并排是不是真的排得下，看宽度
          buttons: all('.card-foot button').map((el) => ({
            text: el.textContent.trim(),
            title: el.title,
            disabled: el.disabled,
            w: Math.round(el.getBoundingClientRect().width)
          })),
          events: all('.event').map(box).slice(0, 3),
          dots: all('.event-dot').map(box).slice(0, 3),
          flashDots: all('.card-flash-dot').map(box),
          text: (document.getElementById('content')?.innerText || '').slice(0, 100)
        };
      })()`).catch((error) => `(读取失败: ${error.message})`);
    },

    refreshLayout: () => { layout(); pushAppearance(); },
    refreshAppearance: () => pushAppearance(),
    // 日志下载的结果推回卡片。卡片可能已经换成别的格子了 —— 渲染层按 cellId 对，
    // 对不上就扔掉，不当成当前这张卡片的状态。
    pushLogState: (payload) => send('card', 'dock:logState', payload || {}),
    // seed = 重建时回填的旧数据；ok=false 表示这轮没拉到，
    // 两种都不算"已经拿到过数据"，面板继续显示"正在读取"
    setCells(next, { seed = false, ok = true } = {}) {
      if (!seed && ok) {
        hasData = true;
        // 第一轮数据到了：启动亮相从这一刻开始数 HOLD 秒（不超过兜底上限）
        if (introUntil && !introDataAt) {
          introDataAt = Date.now();
          introUntil = Math.min(introUntil, introDataAt + INTRO_HOLD_MS);
          logger.info?.(`[dock] 数据到了，亮相再保持 ${Math.max(0, Math.round((introUntil - introDataAt) / 100)) / 10}s`);
        }
      }
      const previous = cells.map((cell) => cell.id).join(',');
      // 按当前生效的排序（含预览值）重排，预览期间轮询推来的新数据也保持一致
      cells = sortCells(Array.isArray(next) ? next : [], readConfig('sort'));
      focused = Math.min(focused, cells.length - 1);
      if (focused < -1) focused = -1;
      if (previous !== cells.map((cell) => cell.id).join(',')) {
        cardHeight = 0;
        hideCard();
        focused = -1;
        clampScroll(scrollOffset);
        layout();
      } else {
        layout();
        if (focused >= 0 && cells[focused]) sendCard(cells[focused]);
      }
    },
    // 诊断用：每个 surface 的真实状态。出问题时靠它一眼看出谁没收起
    pointerState: () => {
      const geo = layout({ pushCells: false });
      const point = screen.getCursorScreenPoint();
      return {
        point,
        revealed,
        focused,
        cardVisible,
        inRail: revealed && rectContains(geo.rail, point),
        inCard: cardVisible && rectContains(geo.card, point),
        inCorridor: cardVisible && rectContains(cardCorridor(geo.rail, geo.card), point)
      };
    },

    trace: () => [...trace],

    surfaceStates: () => SURFACE_NAMES.map((name) => {
      const win = wins[name];
      if (!win || win.isDestroyed()) return { name, alive: false };
      return {
        name,
        alive: true,
        visible: win.isVisible(),
        opacity: Number(win.getOpacity().toFixed(3)),
        target: target[name],
        bounds: win.getBounds()
      };
    }),

    // 应用/停止由 index.js 决定，这里只报当前状态
    isRunning: () => running
  };
}

module.exports = { createDock, rectContains };
