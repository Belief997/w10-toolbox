'use strict';

// 竖条/把手/卡片的轮廓，以及把轮廓变成 Windows 窗口 region 的光栅化。
//
// 一份命令列表三处消费：
//   toSvgPath()    → 渲染层画填充和描边（形状是"画"出来的，不是 clip 出来的）
//   toPolygons()   → 扫描线填充成 alpha 位图
//   shapeRects…()  → setShape() 用的矩形列表（真正的非矩形窗口，连输入一起裁）
//
// 左边贴边时整条镜像，所以只按右边写一遍。

const ARC = 0.448; // 三次贝塞尔逼近 1/4 圆的控制点系数

const METRICS = Object.freeze({
  railWidth: 64,
  shoulder: 28,       // 两端凹肩：让竖条看起来是从屏幕边缘长出来的
  railRadius: 26,
  padding: 4,
  cellHeight: 70,
  cellWidth: 70,
  cellGap: 2,
  peekWidth: 10,
  peekLength: 88,
  handleWidth: 6,
  handleLength: 72,
  cardWidth: 280,
  cardTail: 12,
  cardNeck: 18,
  cardRadius: 18,
  cardGap: 4,
  screenMargin: 8
});

function mirrorX(commands, width) {
  return commands.map(([op, ...points]) => {
    const next = [op];
    for (let index = 0; index < points.length; index += 2) {
      next.push(width - points[index], points[index + 1]);
    }
    return next;
  });
}

// 四角圆角的矩形：竖条脱离屏幕边缘后用这个轮廓，
// 不再有贴边时的凹肩（那形状是"从边缘长出来"的意思，悬空时就说不通了）
function roundedRectCommands({ width: w, height: h, radius, open = false, inset = 0 }) {
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  const commands = [
    ['M', x0 + r, y0],
    ['L', x1 - r, y0],
    ['C', x1 - r * ARC, y0, x1, y0 + r * ARC, x1, y0 + r],
    ['L', x1, y1 - r],
    ['C', x1, y1 - r * ARC, x1 - r * ARC, y1, x1 - r, y1],
    ['L', x0 + r, y1],
    ['C', x0 + r * ARC, y1, x0, y1 - r * ARC, x0, y1 - r],
    ['L', x0, y0 + r],
    ['C', x0, y0 + r * ARC, x0 + r * ARC, y0, x0 + r, y0]
  ];
  if (!open) commands.push(['Z']);
  return commands;
}

// open: true 时去掉闭合段 —— 描边只画三边，绝不在屏幕边缘上画一条线
//
// 右边贴边的形状只写一遍，左边镜像、顶边转置都用它：
// 竖条"长"的那一维永远叫 width（转置前），横过来之后变成 height。
//
// **两套轮廓必须共用一套骨架**：M L C L C L C L C Z（10 条命令，点数一致），
// 顺序固定为 上边(左→右) → 右上角 → 右边(上→下) → 右下角 → 下边(右→左) →
// 左下角 → 左边(下→上) → 左上角 → 闭合。这样贴边形态和悬空形态可以**逐点插值**
// 做形变，不用重采样，也不会在中途打结（拖动时"凹肩收起来"靠的就是它）。
function attachedRail({ width: w, height: h, shoulder, radius }) {
  const s = Math.max(0, Math.min(shoulder, h / 2));
  const spread = Math.min(w * 0.53, w - radius);
  const r = Math.max(0, Math.min(radius, (h - 2 * s) / 2, w - spread));
  const bulge = w - w * 0.25;
  return [
    ['M', r, s],
    ['L', w - spread, s],
    ['C', bulge, s, w, s * 0.76, w, 0],
    ['L', w, h],
    ['C', w, h - s * 0.76, bulge, h - s, w - spread, h - s],
    ['L', r, h - s],
    ['C', r * ARC, h - s, 0, h - s - r * ARC, 0, h - s - r],
    ['L', 0, s + r],
    ['C', 0, s + r * ARC, r * ARC, s, r, s],
    ['Z']
  ];
}

// 把"外侧边在 x=across"的形状搬到"外侧边在 y=0"：
// (x, y) → (y, across - x)。宽高随之互换，所以调用方传进来的尺寸要换过来。
function transposeTop(commands, across) {
  return commands.map(([op, ...points]) => {
    const next = [op];
    for (let index = 0; index < points.length; index += 2) {
      next.push(points[index + 1], across - points[index]);
    }
    return next;
  });
}

// attached = 贴边（带凹肩）；不贴边就是四角圆角。
// 两者骨架一致，可以直接拿来插值 —— 见 attachedRail 上面的说明。
function railCommands({ width: w, height: h, side = 'right', shoulder, radius, open = false, attached = true }) {
  // 顶边吸附：竖条横过来，凹肩落在左右两端（转置前先换宽高）
  if (side === 'top') {
    const base = attached
      ? attachedRail({ width: h, height: w, shoulder, radius })
      : roundedRectCommands({ width: h, height: w, radius, inset: 1 });
    const commands = transposeTop(base, h);
    return open ? commands.filter(([op]) => op !== 'Z') : commands;
  }
  const commands = attached
    ? attachedRail({ width: w, height: h, shoulder, radius })
    : roundedRectCommands({ width: w, height: h, radius, inset: 1 });
  const shaped = side === 'left' ? mirrorX(commands, w) : commands;
  return open ? shaped.filter(([op]) => op !== 'Z') : shaped;
}

function peekCommands(options) {
  const { width: w, height: h, side = 'right', open = false } = options;
  // 顶边：把手是横的，转置过来即可（长度在 width 上）
  if (side === 'top') {
    const base = peekCommands({ ...options, side: 'right', width: h, height: w });
    return transposeTop(base, h);
  }
  const { handleWidth = w, handleLength = h } = options;
  const x = w - Math.min(handleWidth, w);
  const top = Math.max(0, (h - handleLength) / 2);
  const bottom = h - top;
  const r = Math.min(w - x, (bottom - top) / 2, 5);
  const commands = [
    ['M', w, top],
    ['L', x + r, top],
    ['C', x + r * ARC, top, x, top + r * ARC, x, top + r],
    ['L', x, bottom - r],
    ['C', x, bottom - r * ARC, x + r * ARC, bottom, x + r, bottom],
    ['L', w, bottom]
  ];
  if (!open) commands.push(['Z']);
  return side === 'left' ? mirrorX(commands, w) : commands;
}

function cardCommands(options) {
  const { width, height: h, side = 'right', tail, tailY, neck, radius } = options;
  // 顶边吸附时卡片在竖条下面，尾巴朝上：把"尾巴在右侧"的形状转置过来。
  // 转置前宽高互换，tailY 的含义也跟着从"纵向位置"变成"横向位置"。
  if (side === 'top') {
    const base = cardCommands({ ...options, side: 'right', width: h, height: width });
    return transposeTop(base, h);
  }
  const bw = width - tail;
  const tipX = Math.max(bw, width - 1); // 尖端留在窗口内，否则抗锯齿边会被切掉一半
  const r = Math.max(0, Math.min(radius, h / 2, bw / 2));
  const n = Math.max(0, Math.min(neck, (h - 2 * r) / 2));
  const ty = Math.max(r + n, Math.min(h - r - n, Number(tailY) || h / 2));
  const commands = [
    ['M', r, 0],
    ['L', bw - r, 0],
    ['C', bw - r * ARC, 0, bw, r * ARC, bw, r],
    ['L', bw, ty - n],
    ['C', bw, ty - n * 0.4, bw + tail * 0.5, ty - 1.5, tipX, ty],
    ['C', bw + tail * 0.5, ty + 1.5, bw, ty + n * 0.4, bw, ty + n],
    ['L', bw, h - r],
    ['C', bw, h - r * ARC, bw - r * ARC, h, bw - r, h],
    ['L', r, h],
    ['C', r * ARC, h, 0, h - r * ARC, 0, h - r],
    ['L', 0, r],
    ['C', 0, r * ARC, r * ARC, 0, r, 0],
    ['Z']
  ];
  return side === 'left' ? mirrorX(commands, width) : commands;
}

const round2 = (value) => Math.round(value * 100) / 100;
const toSvgPath = (commands) => commands
  .map(([op, ...points]) => `${op}${points.map(round2).join(' ')}`)
  .join(' ');

// 展平成闭合多边形，交给扫描线填充。24 段足够，窗口宽度只有几十像素。
function toPolygons(commands, segments = 24) {
  const polygons = [];
  let current = null;
  let x = 0;
  let y = 0;
  for (const [op, ...p] of commands) {
    if (op === 'M') {
      current = [[p[0], p[1]]];
      polygons.push(current);
      x = p[0]; y = p[1];
    } else if (op === 'L') {
      current.push([p[0], p[1]]);
      x = p[0]; y = p[1];
    } else if (op === 'C') {
      for (let step = 1; step <= segments; step += 1) {
        const t = step / segments;
        const u = 1 - t;
        current.push([
          u * u * u * x + 3 * u * u * t * p[0] + 3 * u * t * t * p[2] + t * t * t * p[4],
          u * u * u * y + 3 * u * u * t * p[1] + 3 * u * t * t * p[3] + t * t * t * p[5]
        ]);
      }
      x = p[4]; y = p[5];
    }
  }
  return polygons;
}

// 扫描线填充 → 每行一个覆盖区间 → 合并成矩形。
// 每个像素在垂直方向取 4 个采样点做抗锯齿；转 region 时再向外扩 1px，
// 因为按 50% alpha 硬切会把平滑边缘切成看得见的锯齿。
function shapeRectsFromPolygons(polygons, width, height, subsamples = 4) {
  const pixelWidth = Math.max(1, Math.round(width));
  const pixelHeight = Math.max(1, Math.round(height));
  const edges = [];
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const [x1, y1] = polygon[index];
      const [x2, y2] = polygon[(index + 1) % polygon.length];
      if (y1 === y2) continue;
      edges.push(x1, y1, x2, y2);
    }
  }
  const rows = [];
  const coverage = new Float32Array(pixelWidth);
  const crossings = new Float64Array(edges.length / 2);

  for (let row = 0; row < pixelHeight; row += 1) {
    coverage.fill(0);
    let touched = false;
    for (let sample = 0; sample < subsamples; sample += 1) {
      const y = row + (sample + 0.5) / subsamples;
      let count = 0;
      for (let edge = 0; edge < edges.length; edge += 4) {
        const y1 = edges[edge + 1];
        const y2 = edges[edge + 3];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
          const x1 = edges[edge];
          const x2 = edges[edge + 2];
          crossings[count++] = x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
        }
      }
      if (!count) continue;
      const sorted = Array.from(crossings.subarray(0, count)).sort((a, b) => a - b);
      for (let index = 0; index + 1 < sorted.length; index += 2) {
        const start = Math.max(0, sorted[index]);
        const end = Math.min(pixelWidth, sorted[index + 1]);
        if (!(end > start)) continue;
        touched = true;
        for (let column = Math.floor(start); column < Math.ceil(end); column += 1) {
          const overlap = Math.min(end, column + 1) - Math.max(start, column);
          if (overlap > 0) coverage[column] += overlap / subsamples;
        }
      }
    }
    if (!touched) continue;
    let start = -1;
    let end = -1;
    for (let column = 0; column < pixelWidth; column += 1) {
      if (coverage[column] <= 0) continue;
      if (start < 0) start = column;
      end = column + 1;
    }
    if (start < 0) continue;
    rows.push({ x: Math.max(0, start - 1), y: row, width: Math.min(pixelWidth, end + 1) - Math.max(0, start - 1), height: 1 });
  }

  // 相邻且 x/宽一致的合并成一个矩形，region 小很多
  const rects = [];
  for (const row of rows) {
    const previous = rects[rects.length - 1];
    if (previous && previous.x === row.x && previous.width === row.width && previous.y + previous.height === row.y) {
      previous.height += 1;
    } else {
      rects.push(row);
    }
  }
  return rects;
}

module.exports = {
  ARC, METRICS, cardCommands, peekCommands, railCommands, roundedRectCommands,
  shapeRectsFromPolygons, toPolygons, toSvgPath
};
