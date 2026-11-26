'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { METRICS, cardCommands, peekCommands, railCommands, toPolygons } = require('../src/main/surfaces');

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
  const bottom = railCommands({ ...BASE, width: 206, height: 64, side: 'bottom', attached: true });
  for (const variant of [left, top, bottom]) {
    assert.deepStrictEqual(variant.map(([op]) => op), right.map(([op]) => op));
    assert.deepStrictEqual(
      variant.map((command) => command.length), right.map((command) => command.length)
    );
  }
});

test('底边吸附是顶边上下翻过来（鼓包朝下、凹肩朝上）', () => {
  const H = 64;
  const top = railCommands({ ...BASE, width: 206, height: H, side: 'top', attached: true });
  const bottom = railCommands({ ...BASE, width: 206, height: H, side: 'bottom', attached: true });
  for (let index = 0; index < top.length; index += 1) {
    assert.strictEqual(bottom[index][0], top[index][0], `第 ${index} 条命令的算子`);
    for (let point = 1; point < top[index].length; point += 2) {
      // x 不变，y 关于窗口中线对称
      assert.ok(Math.abs(bottom[index][point] - top[index][point]) < 1e-9, 'x 不变');
      assert.ok(Math.abs(bottom[index][point + 1] - (H - top[index][point + 1])) < 1e-9,
        `第 ${index} 条命令的 y 要翻过来`);
    }
  }
  // 顶边那条"贴在屏幕上"的直边在 y=0，底边就应该在 y=H
  const topYs = toPolygons(top)[0].map(([, y]) => y);
  const bottomYs = toPolygons(bottom)[0].map(([, y]) => y);
  assert.ok(Math.min(...topYs) <= 0.01 && Math.max(...topYs) >= H - 0.01);
  assert.ok(Math.min(...bottomYs) <= 0.01 && Math.max(...bottomYs) >= H - 0.01);
});

test('底部吸附的卡片和把手：尾巴朝下、把手贴在底边那一侧', () => {
  const H = 64;
  const options = { tail: 12, tailY: 100, neck: 18, radius: 18 };
  const CARD_H = 206;
  const topCard = cardCommands({ ...options, width: 280, height: CARD_H, side: 'top' });
  const bottomCard = cardCommands({ ...options, width: 280, height: CARD_H, side: 'bottom' });
  // 和竖条一样：底边是顶边上下翻过来的
  for (let index = 0; index < topCard.length; index += 1) {
    for (let point = 1; point < topCard[index].length; point += 2) {
      assert.ok(Math.abs(bottomCard[index][point] - topCard[index][point]) < 1e-9, 'x 不变');
      assert.ok(Math.abs(bottomCard[index][point + 1] - (CARD_H - topCard[index][point + 1])) < 1e-9,
        `第 ${index} 条命令的 y 要翻过来`);
    }
  }
  // 尾巴那一段：顶边吸附时最靠上（y 最小），底边吸附时最靠下（y 最大）
  const topCardYs = toPolygons(topCard)[0].map(([, y]) => y);
  const bottomCardYs = toPolygons(bottomCard)[0].map(([, y]) => y);
  // 尖端刻意留在窗口内 1px（否则抗锯齿边会被切掉一半），所以是"贴到 1px"而不是 0
  assert.ok(Math.min(...topCardYs) <= 1.5, '顶边：尾巴在上沿（竖条在下）');
  assert.ok(Math.max(...bottomCardYs) >= CARD_H - 1.5, '底边：尾巴在下沿（竖条在上）');

  const topPeek = peekCommands({ width: 88, height: 10, side: 'top', handleWidth: 6, handleLength: 72 });
  const bottomPeek = peekCommands({ width: 88, height: 10, side: 'bottom', handleWidth: 6, handleLength: 72 });
  const topYs = toPolygons(topPeek)[0].map(([, y]) => y);
  const bottomYs = toPolygons(bottomPeek)[0].map(([, y]) => y);
  // 把手是"从屏幕边缘伸出来的那一小截"：顶边贴 y=0，底边贴 y=窗口高(10)
  assert.ok(Math.min(...topYs) <= 0.1, '顶边把手一直伸到 y=0');
  assert.ok(Math.max(...bottomYs) >= 9.9, '底边把手一直伸到 y=10');
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
