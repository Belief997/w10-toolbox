'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { clampToWorkArea, isAttached, snapOnRelease } = require('../src/shared/placement');

const WORK = { x: 0, y: 0, width: 1280, height: 720 };
const SIZE = { width: 64, height: 300, workArea: WORK };

test('离边缘够近才吸附，远了就停在原地', () => {
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 1216, y: 100 }),
    { x: 1216, y: 100, edge: 'right' }, '已经贴着');
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 1200, y: 100 }),
    { x: 1216, y: 100, edge: 'right' }, '差 16 → 吸住');
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 1032, y: 100 }),
    { x: 1032, y: 100, edge: null }, '差 184 → 保持');
});

test('左右两边都能吸', () => {
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 12, y: 50 }), { x: 0, y: 50, edge: 'left' });
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 1190, y: 50 }), { x: 1216, y: 50, edge: 'right' });
});

test('顶边也能吸，吸上之后横排', () => {
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 500, y: 8 }),
    { x: 500, y: 0, edge: 'top' }, '差 8 → 吸住顶边');
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 500, y: 60 }),
    { x: 500, y: 60, edge: null }, '差 60 → 保持');
});

test('角上不抢：两条边一样近时按侧边处理', () => {
  // 右上角两条边都是 0 距离：保持竖排，否则竖条会莫名横过来
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 1216, y: 0 }).edge, 'right');
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 0, y: 0 }).edge, 'left');
  // 顶边更近时才选顶边
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 1200, y: 0 }).edge, 'top');
});

test('磁吸阈值可以调', () => {
  const far = snapOnRelease({ ...SIZE, x: 1150, y: 100, distance: 100 });
  assert.strictEqual(far.x, 1216, '阈值放到 100 后就能吸住');
});

test('吸附时也会把坐标夹回工作区', () => {
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 1200, y: 9999 }),
    { x: 1216, y: 420, edge: 'right' }, '底边外 → 夹回来');
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 500, y: -50 }),
    { x: 500, y: 0, edge: 'top' }, '顶边外 → 夹回来，同时吸到顶边');
});

test('贴边判断决定用哪套轮廓', () => {
  assert.strictEqual(isAttached({ ...SIZE, x: 1216 }), true, '右边');
  assert.strictEqual(isAttached({ ...SIZE, x: 0 }), true, '左边');
  assert.strictEqual(isAttached({ ...SIZE, x: 600 }), false, '悬空');
});

test('不吸附时也要完整留在工作区内', () => {
  assert.deepStrictEqual(clampToWorkArea({ ...SIZE, x: -500, y: 100 }), { x: 0, y: 100 });
  assert.deepStrictEqual(clampToWorkArea({ ...SIZE, x: 5000, y: 100 }), { x: 1216, y: 100 });
  assert.deepStrictEqual(clampToWorkArea({ ...SIZE, x: 500, y: 9000 }), { x: 500, y: 420 });
});
