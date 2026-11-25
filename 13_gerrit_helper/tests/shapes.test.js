'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { METRICS, railCommands, toPolygons } = require('../src/main/surfaces');

const BASE = { shoulder: METRICS.shoulder, radius: METRICS.railRadius };

function area(commands) {
  const [poly] = toPolygons(commands);
  let sum = 0;
  for (let index = 0; index < poly.length; index += 1) {
    const [x1, y1] = poly[index];
    const [x2, y2] = poly[(index + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

// 形变靠"两套轮廓逐点插值"，前提是骨架完全一致：命令顺序、每条命令的点数都一样。
// 这条约束是隐式的，谁改了形状忘了另一边，这条测试会先炸。
test('贴边和悬空两套轮廓骨架一致，可以直接插值', () => {
  const attached = railCommands({ ...BASE, width: 64, height: 206, side: 'right', attached: true });
  const floating = railCommands({ ...BASE, width: 64, height: 170, side: 'right', attached: false });
  assert.deepStrictEqual(
    attached.map(([op]) => op), floating.map(([op]) => op), '命令顺序'
  );
  assert.deepStrictEqual(
    attached.map((command) => command.length), floating.map((command) => command.length), '每条命令的点数'
  );
});

test('镜像和转置都不改变骨架', () => {
  const right = railCommands({ ...BASE, width: 64, height: 206, side: 'right', attached: true });
  const left = railCommands({ ...BASE, width: 64, height: 206, side: 'left', attached: true });
  const top = railCommands({ ...BASE, width: 206, height: 64, side: 'top', attached: true });
  for (const variant of [left, top]) {
    assert.deepStrictEqual(variant.map(([op]) => op), right.map(([op]) => op));
    assert.deepStrictEqual(
      variant.map((command) => command.length), right.map((command) => command.length)
    );
  }
});

test('形状面积符合预期：贴边比悬空多出两端凹肩的那一块', () => {
  const attached = area(railCommands({ ...BASE, width: 64, height: 206, side: 'right', attached: true }));
  const floating = area(railCommands({ ...BASE, width: 64, height: 170, side: 'right', attached: false }));
  // 贴边：64×206 减去两个凹肩缺口和内圆角；悬空：62×168 的圆角矩形
  assert.ok(attached > 9000 && attached < 10500, `贴边面积 ${Math.round(attached)}`);
  assert.ok(floating > 9500 && floating < 10200, `悬空面积 ${Math.round(floating)}`);
});

test('悬空形态四角同半径，贴边形态右边是直的', () => {
  const floating = railCommands({ ...BASE, width: 64, height: 170, side: 'right', attached: false });
  const [poly] = toPolygons(floating);
  const xs = poly.map(([x]) => x);
  // 内缩 1px：悬空的左右边界都不到 0 / 64
  assert.ok(Math.min(...xs) >= 0.9 && Math.max(...xs) <= 63.1, '悬空整体内缩');

  const attached = railCommands({ ...BASE, width: 64, height: 206, side: 'right', attached: true });
  const [apoly] = toPolygons(attached);
  // 贴边形态的右边（屏幕边缘）是一条直线：只有 (64,0) 和 (64,206) 两个端点，
  // 中间没有采样点 —— toPolygons 只细分曲线，直线不细分
  const onEdge = apoly.filter(([x]) => x > 63.95);
  assert.deepStrictEqual(onEdge.map(([, y]) => Math.round(y)).sort((a, b) => a - b), [0, 206], '右边是直的');
});
