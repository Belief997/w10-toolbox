'use strict';

// 专门盯"加载态面板装不装得下转圈"这条 —— 已经错过三次：
//   1) 0 个格子按"只有内边距"算长度（悬空 12px 高）
//   2) 贴边时忘了两端凹肩，玻璃体只剩中间一截
//   3) 把加载态的轮廓换成圆角，形状和配置不一致
// 现在的规矩：**形状完全按配置**（贴边就是凹肩形态），
// 长度按"加载块 + 两个肩位"算，加载块居中在玻璃体里。
const test = require('node:test');
const assert = require('node:assert');
const { LOADING_BLOCK, LOADING_MIN, loadingLength, railLength } = require('../src/shared/rail-size');
const { METRICS, railCommands, toPolygons } = require('../src/main/surfaces');

const SHOULDER = METRICS.shoulder;
const RING = 26; // .loading-ring 的宽高
const BASE = {
  padding: METRICS.padding,
  cellGap: METRICS.cellGap,
  cellSize: METRICS.cellHeight,
  minSize: 60,
  available: 704
};

// 某个 y 上，轮廓在横向占多宽（扫描线求交点）
function widthAt(polygon, y) {
  const xs = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
      xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
  }
  xs.sort((a, b) => a - b);
  return xs.length >= 2 ? xs[xs.length - 1] - xs[0] : 0;
}

test('加载态长度 = 加载块 + 两个肩位', () => {
  assert.strictEqual(loadingLength(SHOULDER), LOADING_BLOCK + SHOULDER * 2);
  // 悬空肩位只有 2，兜底到最小长度
  assert.strictEqual(loadingLength(2), LOADING_MIN);
  assert.ok(loadingLength(2) >= LOADING_BLOCK);
});

test('加载态不按"0 个格子"算长度', () => {
  const attached = railLength({ ...BASE, count: 0, topPad: SHOULDER, loading: true });
  const emptyAttached = railLength({ ...BASE, count: 0, topPad: SHOULDER, loading: false });
  assert.strictEqual(attached.along, LOADING_BLOCK + SHOULDER * 2);
  assert.ok(attached.along > emptyAttached.along);
});

// 这条直接复现"环被切"：贴边形态（凹肩）+ 加载长度，
// 在设计放环的那段高度里逐 2px 量宽度，必须容得下 26px 的环
test('真实轮廓：贴边形态下，环所在区间宽度装得下环', () => {
  const length = loadingLength(SHOULDER);
  const width = METRICS.railWidth;
  const commands = railCommands({
    width, height: length, side: 'right',
    shoulder: SHOULDER, radius: METRICS.railRadius, attached: true
  });
  const [poly] = toPolygons(commands);

  // 加载块居中在玻璃体里（两端各让出肩位），环在块的最上面那 26px
  const bodyTop = SHOULDER;
  const blockTop = bodyTop + (length - SHOULDER * 2 - (RING + 7 + 12)) / 2;
  for (let y = blockTop + 4; y <= blockTop + RING; y += 2) {
    const span = widthAt(poly, y);
    assert.ok(span >= RING + 4, `y=${Math.round(y)} 处只有 ${Math.round(span)}px 宽`);
  }
});

test('加载态轮廓不搞特殊：贴边就是凹肩形态', () => {
  const width = METRICS.railWidth;
  const length = loadingLength(SHOULDER);
  const attached = toPolygons(railCommands({
    width, height: length, side: 'right', shoulder: SHOULDER, radius: METRICS.railRadius, attached: true
  }))[0];
  // 凹肩形态的特征：y=2 处被收窄（远小于整宽）
  assert.ok(widthAt(attached, 2) < width / 2, '贴边形态两端应该是收窄的');
});

test('有格子的长度不变（回归）', () => {
  assert.strictEqual(railLength({ ...BASE, count: 2, topPad: SHOULDER }).along, 206);
  assert.strictEqual(railLength({ ...BASE, count: 2, topPad: 2 }).along, 154);
});

test('装不下时压缩格子，且不超过可用长度', () => {
  const many = railLength({ ...BASE, count: 20, topPad: SHOULDER, available: 500 });
  assert.ok(many.cellSize < METRICS.cellHeight, '应该压缩过');
  assert.ok(many.cellSize >= 60, '不低于最小格高');
  assert.ok(many.along <= 500, '不能超出可用长度');

  const absurd = railLength({ ...BASE, count: 60, topPad: SHOULDER, available: 300 });
  assert.strictEqual(absurd.cellSize, 60, '压到底就不再压');
  assert.strictEqual(absurd.along, 300, '截断到可用长度');
});
