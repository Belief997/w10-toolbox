'use strict';

// 拖拽看门狗：松手时 mouseup 丢了（窗口跑了/被夹到边缘），
// 必须靠"一段时间没动"把它收掉，否则 dock 永远卡在拖动中。
const test = require('node:test');
const assert = require('node:assert');
const { DRAG_IDLE_MS, dragExpired, nextDragClock } = require('../src/shared/drag-watch');

const drag = (over = {}) => ({
  lastPoint: { x: 100, y: 100 },
  lastMove: 1000,
  ...over
});

test('光标没动就不刷新时间戳（这正是以前的 bug）', () => {
  const before = drag();
  const after = nextDragClock(before, { x: 100, y: 100 }, 9999);
  assert.strictEqual(after.lastMove, 1000, '没动就不能续命');
  assert.deepStrictEqual(after.lastPoint, { x: 100, y: 100 });
});

test('1px 抖动不算动（远程桌面/高 DPI 会抖）', () => {
  const before = drag();
  const after = nextDragClock(before, { x: 101, y: 99 }, 9999);
  assert.strictEqual(after.lastMove, 1000, '容差内的抖动不该续命');
});

test('真的移动了才刷新', () => {
  const before = drag();
  const after = nextDragClock(before, { x: 140, y: 130 }, 5000);
  assert.strictEqual(after.lastMove, 5000);
  assert.deepStrictEqual(after.lastPoint, { x: 140, y: 130 });
});

test('超过空闲时间就认定松手', () => {
  assert.strictEqual(dragExpired(drag(), 1000 + DRAG_IDLE_MS + 1), true);
  assert.strictEqual(dragExpired(drag(), 1000 + DRAG_IDLE_MS - 1), false);
  assert.strictEqual(dragExpired(null, 99999), false, '没有拖拽时不算过期');
});

test('一直不动时，时间线推到底就该收掉', () => {
  let state = drag();
  state = nextDragClock(state, { x: 100, y: 100 }, 1100);
  state = nextDragClock(state, { x: 100, y: 100 }, 1200);
  assert.strictEqual(dragExpired(state, 1200), false);
  assert.strictEqual(dragExpired(state, 1100 + DRAG_IDLE_MS + 50), true);
});
