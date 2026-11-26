'use strict';

// 竖条的位置计算。纯函数，可直接 node --test。

// 松手时的磁吸：离边缘 ≤ distance 才贴上去，否则保持原位。
// 这是"吸附"和"钉死在边上"的区别 —— 用户要的是前者。
//
// 顶边和底边也算吸附边：贴上去之后竖条会横过来（见 dock.js 的 edge()）。
// 四条边里挑最近的一条，避免在角上"两边同时满足"时随机选一个。
//
// 底边有**两个**吸附位：
//   任务栏上沿（横条压在任务栏之上，不挡任务栏）
//   屏幕底（横条压在任务栏上，看起来是从屏幕边上长出来的）
// 选哪个看松手时面板的**下沿**落在哪儿：已经压进任务栏那一条（> 上沿 2px）就贴屏幕底，
// 停在上沿的磁吸范围里就贴上沿。都不挨着就不吸。
function snapOnRelease({
  x, y, width, height, workArea, bounds = workArea, distance = 28, thickness = 0
}) {
  const taskbarTop = workArea.y + workArea.height;
  const screenBottom = bounds.y + bounds.height;
  const drop = y + height;   // 面板下沿（松手时的真实下沿，不是横过来之后的厚度）

  // 已经跑出边界时距离算 0（"贴在外面"就是贴着），否则"越远越近"会选错边
  const leftGap = Math.max(0, x - workArea.x);
  const rightGap = Math.max(0, workArea.x + workArea.width - (x + width));
  const topGap = Math.max(0, y - workArea.y);

  // 底边的两个候选：谁在手边用谁
  let bottomGap = Infinity;
  let bottomY = y;
  const snappedHeight = thickness > 0 ? thickness : height;
  if (drop > taskbarTop + 2) {
    // 压进任务栏那一条了：贴屏幕底
    bottomGap = 0;
    bottomY = screenBottom - snappedHeight;
  } else if (drop > taskbarTop - distance) {
    // 停在上沿附近：贴任务栏上沿，横条正好压在任务栏上面
    bottomGap = taskbarTop - drop;
    bottomY = taskbarTop - snappedHeight;
  }

  let edge = null;
  let best = distance + 1;
  if (leftGap <= distance && leftGap < best) { edge = 'left'; best = leftGap; }
  if (rightGap <= distance && rightGap < best) { edge = 'right'; best = rightGap; }
  // 角上时侧边优先：竖条贴着左边/右边才是默认形态，横排是后加的。
  // 判据和拖动中翻轴用的一致（两边都离边 >2px 才考虑横排）。
  if (topGap <= distance && topGap < best && leftGap > 2 && rightGap > 2) {
    edge = 'top'; best = topGap;
  }
  if (bottomGap <= distance && bottomGap < best && leftGap > 2 && rightGap > 2) {
    edge = 'bottom'; best = bottomGap;
  }

  const nextX = edge === 'left' ? workArea.x
    : edge === 'right' ? workArea.x + workArea.width - width
      : x;
  // 贴上顶边/底边之后竖条会横过来，高度变成**厚度**（64），不再是竖着时的几百像素。
  // 拿竖着时的 height 算，横条会停在离边老远的地方 —— 而且因为离边远，
  // 下一帧又被判成"没贴边"，形状退化成圆角矩形（没有凹肩）。两个症状同一个原因。
  const nextY = edge === 'top' ? workArea.y
    : edge === 'bottom' ? bottomY
      : y;
  // 夹取也要按"贴边之后的尺寸"来，否则刚算好的位置会被按竖着时的尺寸夹回去。
  // 下沿放到屏幕底：底边形态本来就可能压在任务栏上。
  const clampMaxY = Math.max(workArea.y, screenBottom - snappedHeight);
  return {
    x: Math.round(Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, nextX))),
    y: Math.round(Math.max(workArea.y, Math.min(clampMaxY, nextY))),
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
