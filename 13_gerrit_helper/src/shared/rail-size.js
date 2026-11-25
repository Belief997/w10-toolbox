'use strict';

// 竖条沿轴方向的长度。抽出来是为了能单独测 ——
// 这里出过错：0 个格子时按"只有内边距"算长度，加载中的转圈被裁掉大半。
//
// 输入全是数字，输出也是数字，不碰 DOM、不碰 Electron。

// 加载块本身：环 26 + 间距 7 + 文字 12 ≈ 45，两侧再各留 8
const LOADING_BLOCK = 56;
const LOADING_MIN = 72;

// 加载态面板的长度。加载块是**居中在玻璃体里**的（两端凹肩/圆角都不算）,
// 所以长度 = 加载块 + 两个肩位。贴边时肩位 28 → 112，悬空时 2 → 60（兜底到 72）。
function loadingLength(topPad) {
  return Math.max(LOADING_MIN, LOADING_BLOCK + topPad * 2);
}

function railLength({
  count = 0,
  cellSize,
  minSize,
  topPad,
  padding,
  cellGap,
  available,
  loading = false
}) {
  const chrome = topPad * 2 + padding * 2;
  const total = (size) => chrome + count * size + Math.max(0, count - 1) * cellGap;

  let size = cellSize;
  while (count > 0 && size > minSize && total(size) > available) size -= 2;

  const natural = Math.max(loading ? loadingLength(topPad) : 0, total(size));
  return { cellSize: size, natural, along: Math.min(natural, available) };
}

module.exports = { LOADING_BLOCK, LOADING_MIN, loadingLength, railLength };
