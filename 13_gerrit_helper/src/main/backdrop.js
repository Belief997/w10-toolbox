'use strict';

// 亚克力底层 helper 的 Node 侧。一个子进程服务所有 surface。
//
// 每次窗口移动/改形状都要把同一条命令推过去：helper 会自己去读内容窗口的
// GetWindowRect 定位，所以 DPI 缩放下不会和网页差一两个像素。
//
// 任何一步失败都只是降级回半透明底色 —— 材质是观感，不该拖垮工具。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function helperPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'windows-dock', 'GerritHelper.Backdrop.exe')
    : path.resolve(__dirname, '..', '..', 'build', 'windows-dock', 'GerritHelper.Backdrop.exe');
}

// Win11 21H2 起才有 HostBackdropBrush 这套合成器接口
function supported() {
  if (process.platform !== 'win32') return false;
  const build = Number(String(os.release()).split('.')[2]);
  return Number.isFinite(build) && build >= 22000;
}

function createBackdrop({ app, screen, logger = console }) {
  const file = helperPath(app);
  const surfaces = new Map();
  let child = null;
  let ready = false;
  let failed = false;
  let nextId = 0;
  let startupTimer = null;
  let flushScheduled = false;
  let blocked = false;
  const pending = new Map();

  function fail(error) {
    if (failed) return;
    failed = true;
    ready = false;
    clearTimeout(startupTimer);
    pending.clear();
    const previous = child;
    child = null;
    try { previous?.stdin.destroy(); } catch (_) { /* 已经关了 */ }
    try { previous?.kill(); } catch (_) { /* 已经退了 */ }
    logger.warn?.(`[backdrop] 亚克力不可用：${error.message}；回落到半透明底色`);
    for (const surface of surfaces.values()) surface.onMaterial(false);
  }

  function flush() {
    flushScheduled = false;
    if (!ready || !child || blocked) return;
    for (const [id, message] of pending) {
      pending.delete(id);
      try {
        if (!child.stdin.write(`${JSON.stringify(message)}\n`)) { blocked = true; break; }
      } catch (error) { fail(error); break; }
    }
  }

  function enqueue(id, message) {
    if (failed) return;
    pending.set(id, message);
    if (!flushScheduled) { flushScheduled = true; queueMicrotask(flush); }
  }

  function start() {
    if (child || failed) return;
    if (!supported()) { fail(new Error('需要 Windows 11（build 22000+）')); return; }
    if (!fs.existsSync(file)) { fail(new Error('helper 还没编译（跑 npm run build:backdrop）')); return; }
    try {
      child = spawn(file, [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { fail(error); return; }

    const current = child;
    let buffer = '';
    let stderr = '';
    current.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2048); });
    current.stdin.on('error', (error) => { if (child === current) fail(error); });
    current.stdin.on('drain', () => { if (child === current) { blocked = false; flush(); } });
    current.on('error', (error) => { if (child === current) fail(error); });
    current.on('exit', (code) => {
      if (child === current) fail(new Error(`helper 退出（${code}）${stderr ? `: ${stderr}` : ''}`));
    });
    current.stdout.on('data', (chunk) => {
      if (child !== current) return;
      buffer += chunk;
      if (buffer.length > 65536) { fail(new Error('helper 返回异常')); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch (_) { continue; }
        if (message.type === 'ready') {
          clearTimeout(startupTimer);
          ready = true;
          flush();
        } else if (message.type === 'attached') {
          const surface = surfaces.get(message.id);
          if (surface && !surface.win.isDestroyed()) surface.onMaterial(true);
        } else if (message.type === 'error') {
          fail(new Error(message.message));
          return;
        }
      }
    });
    startupTimer = setTimeout(() => fail(new Error('helper 启动超时')), 5000);
    startupTimer.unref?.();
  }

  function stop() {
    clearTimeout(startupTimer);
    const previous = child;
    child = null;
    ready = false;
    blocked = false;
    failed = false;
    pending.clear();
    if (previous) {
      try { previous.stdin.end(); } catch (_) { /* 已经关了 */ }
      const timer = setTimeout(() => { try { previous.kill(); } catch (_) {} }, 1000);
      timer.unref?.();
      previous.once('exit', () => clearTimeout(timer));
    }
  }

  return {
    available: () => supported() && fs.existsSync(file),

    attach(win, onMaterial = () => {}) {
      const id = String(++nextId);
      let shape = null;
      let opacity = 0;
      let disposed = false;
      let lastState = '';
      const surface = { win, onMaterial };
      surfaces.set(id, surface);
      start();

      const send = (force = false) => {
        if (disposed || failed || !shape || win.isDestroyed()) return;
        try {
          const bounds = win.getBounds();
          const pixels = screen.dipToScreenRect(null, bounds);
          // 几何裁剪必须用物理像素：命令列表是 DIP，底层 visual 的尺寸是物理像素。
          // 不换算的话轮廓会比画布小一圈（150% 缩放时小三分之一），
          // 圆角外面的四个角就会漏出没被裁掉的亚克力 —— 看起来像两块面板叠在一起。
          const scale = screen.getDisplayMatching(bounds)?.scaleFactor
            || (bounds.width ? pixels.width / bounds.width : 1)
            || 1;
          const commands = scale === 1 ? shape.commands : shape.commands.map(
            ([op, ...values]) => [op, ...values.map((value) => value * scale)]
          );
          const message = {
            op: 'update',
            id,
            hwnd: nativeHandle(win),
            x: pixels.x, y: pixels.y, width: pixels.width, height: pixels.height,
            shapeKey: `${shape.key}@${scale}`,
            commands,
            opacity: win.isVisible() ? opacity : 0
          };
          const serialized = JSON.stringify(message);
          if (!force && serialized === lastState) return;
          lastState = serialized;
          enqueue(id, message);
        } catch (error) { fail(error); }
      };

      const windowChanged = () => send(true);
      for (const event of ['show', 'hide', 'move', 'resize']) win.on(event, windowChanged);

      const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const event of ['show', 'hide', 'move', 'resize']) win.removeListener(event, windowChanged);
        surfaces.delete(id);
        enqueue(id, { op: 'dispose', id });
        if (!surfaces.size) stop();
      };
      win.once('closed', dispose);

      return {
        update(value) { shape = value; send(); },
        setOpacity(value) { opacity = value; send(); },
        dispose
      };
    },

    stop
  };
}

// HWND 以小端 8 字节传过去；32 位句柄在高位补零
function nativeHandle(win) {
  const handle = win.getNativeWindowHandle();
  const value = handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  return value.toString();
}

module.exports = { createBackdrop, helperPath, nativeHandle, supported };
