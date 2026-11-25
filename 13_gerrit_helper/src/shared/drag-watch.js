'use strict';

// 拖拽的"还在拖吗"判断。抽成纯函数是因为这里出过一个很难看的 bug：
//
// 松手时如果窗口不在光标下面（拖动中面板会变形、会被夹到屏幕边缘），
// 渲染层收不到 mouseup，主进程就一直以为还在拖 —— hover、收放、再拖全废。
// 原本靠"1.2 秒没动就算松手"兜底，但 followDrag 每一拍都在刷新时间戳，
// 等于把看门狗泡在温水里：只要光标还有一丁点动静就永远不触发。

// 光标位置变了才算"动过"。用容差是因为某些设备/远程桌面会有 1px 抖动，
// 那种抖动不该让拖拽永远不死。
function nextDragClock({ lastPoint, lastMove }, point, now, tolerance = 2) {
  const moved = Math.abs(point.x - lastPoint.x) > tolerance
    || Math.abs(point.y - lastPoint.y) > tolerance;
  if (!moved) return { lastPoint, lastMove };
  return { lastPoint: { x: point.x, y: point.y }, lastMove: now };
}

// 多久没动就认定松手了（mouseup 丢了）。
// 2 秒：比拖到一半停下来想一下长，又不会让卡住的拖拽赖太久
const DRAG_IDLE_MS = 2000;

function dragExpired(drag, now) {
  return Boolean(drag) && now - drag.lastMove > DRAG_IDLE_MS;
}

module.exports = { DRAG_IDLE_MS, dragExpired, nextDragClock };
