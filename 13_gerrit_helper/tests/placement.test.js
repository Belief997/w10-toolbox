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

test('底边也能吸，吸上之后横排贴在屏幕底部', () => {
  // 工作区高 720、面板高 300：y=412 时离底边 8px
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 500, y: 412 }),
    { x: 500, y: 420, edge: 'bottom' }, '差 8 → 吸住底边');
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 500, y: 360 }),
    { x: 500, y: 360, edge: null }, '差 60 → 保持');
});

test('竖条拖到底边：吸附后按"横过来之后的厚度"落位，不是按竖着时的高度', () => {
  // 工作区 1280×720，竖条 64×300 被夹在 y=420（正好贴着底边）
  const snapped = snapOnRelease({ ...SIZE, x: 500, y: 420, thickness: 64 });
  assert.strictEqual(snapped.edge, 'bottom');
  assert.strictEqual(snapped.y, 720 - 64, '横过来之后高度是 64，底边应该落在 656');
  // 不传厚度（老调用）时按传进来的 height 算，行为不变
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 500, y: 420 }).y, 420);
});

test('底边两个吸附位：压进任务栏贴屏幕底，停在上沿附近贴任务栏上沿', () => {
  // 1280×720 的屏幕，底部 48px 是任务栏 → 工作区只有 672 高
  const workArea = { x: 0, y: 0, width: 1280, height: 672 };
  const bounds = { x: 0, y: 0, width: 1280, height: 720 };
  // 竖条 64×300，drop 是松手时面板的下沿
  const at = (drop) => snapOnRelease({
    x: 500, y: drop - 300, width: 64, height: 300, workArea, bounds, thickness: 64
  });

  const onScreen = at(720);
  assert.strictEqual(onScreen.edge, 'bottom');
  assert.strictEqual(onScreen.y, 720 - 64, '下沿到屏幕底 → 贴屏幕底');

  const insideTaskbar = at(690);
  assert.strictEqual(insideTaskbar.edge, 'bottom');
  assert.strictEqual(insideTaskbar.y, 720 - 64, '在任务栏之间 → 贴屏幕底');

  const nearTaskbar = at(660);
  assert.strictEqual(nearTaskbar.edge, 'bottom');
  assert.strictEqual(nearTaskbar.y, 672 - 64, '停在上沿磁吸范围 → 压在上沿之上');

  const tooHigh = at(620);
  assert.strictEqual(tooHigh.edge, null, '离两条边都超过 28 → 不吸');
});

test('角上不抢：两条边一样近时按侧边处理', () => {
  // 右上角两条边都是 0 距离：保持竖排，否则竖条会莫名横过来
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 1216, y: 0 }).edge, 'right');
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 0, y: 0 }).edge, 'left');
  // 右下角同理：底边不抢
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 1216, y: 420 }).edge, 'right');
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 0, y: 420 }).edge, 'left');
  // 顶边更近时才选顶边
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 1200, y: 0 }).edge, 'top');
  // 底边更近时才选底边
  assert.strictEqual(snapOnRelease({ ...SIZE, x: 1200, y: 420 }).edge, 'bottom');
});

test('磁吸阈值可以调', () => {
  const far = snapOnRelease({ ...SIZE, x: 1150, y: 100, distance: 100 });
  assert.strictEqual(far.x, 1216, '阈值放到 100 后就能吸住');
});

test('吸附时也会把坐标夹回工作区', () => {
  // 已经掉到底边外面：按"贴着底边"算（比右边那 16px 更近），x/y 都夹回来
  assert.deepStrictEqual(snapOnRelease({ ...SIZE, x: 1200, y: 9999 }),
    { x: 1200, y: 420, edge: 'bottom' }, '底边外 → 夹回来');
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
