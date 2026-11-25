'use strict';

// 竖条的位置计算。纯函数，可直接 node --test。

// 松手时的磁吸：离边缘 ≤ distance 才贴上去，否则保持原位。
// 这是"吸附"和"钉死在边上"的区别 —— 用户要的是前者。
//
// 顶边也算一条吸附边：贴上去之后竖条会横过来（见 dock.js 的 edge()）。
// 三条边里挑最近的一条，避免在角上"两边同时满足"时随机选一个。
function snapOnRelease({ x, y, width, height, workArea, distance = 28 }) {
  const leftGap = x - workArea.x;
  const rightGap = workArea.x + workArea.width - (x + width);
  const topGap = y - workArea.y;
  const maxY = workArea.y + Math.max(0, workArea.height - height);

  let edge = null;
  let best = distance + 1;
  if (leftGap <= distance && leftGap < best) { edge = 'left'; best = leftGap; }
  if (rightGap <= distance && rightGap < best) { edge = 'right'; best = rightGap; }
  // 角上时侧边优先：竖条在左侧/右侧才是默认形态，顶边是后加的
  if (topGap <= distance && topGap < best) { edge = 'top'; best = topGap; }

  const nextX = edge === 'left' ? workArea.x
    : edge === 'right' ? workArea.x + workArea.width - width
      : x;
  const nextY = edge === 'top' ? workArea.y : y;
  return {
    x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, nextX))),
    y: Math.round(Math.max(workArea.y, Math.min(maxY, nextY))),
    edge
  };
}

// 贴着边缘吗？决定用哪套轮廓（贴边有凹肩，悬浮是四角圆角）
function isAttached({ x, width, workArea, tolerance = 2 }) {
  const leftGap = x - workArea.x;
  const rightGap = workArea.x + workArea.width - (x + width);
  return leftGap <= tolerance || rightGap <= tolerance;
}

// 不吸附时也要完整留在工作区内
function clampToWorkArea({ x, y, width, height, workArea }) {
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(maxX, x))),
    y: Math.round(Math.max(workArea.y, Math.min(maxY, y)))
  };
}

module.exports = { clampToWorkArea, isAttached, snapOnRelease };
