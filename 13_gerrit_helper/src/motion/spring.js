'use strict';

// 二阶阻尼弹簧 → WAAPI 关键帧。
// 移植自 token-monitor 的 tokenNumberAnimation.js：只保留纯数学，去掉业务耦合。
//
// 核心问题：WAAPI 不支持弹簧缓动，只支持 cubic-bezier / linear / steps。
// 解法：把弹簧的阶跃响应用自适应细分采成关键帧，再让 WAAPI 在帧间线性插值。
// 采样在 0.65s 内通常只剩十几帧，误差 ≤ 0.002 —— 肉眼看不出是分段线性的。
//
// 为什么不直接用 cubic-bezier：贝塞尔只能描述一段单调或单次过冲的曲线，
// 而弹簧有多阶回弹；而且同一段时间里，"位置"要过冲、"透明度"不能过冲，
// 贝塞尔做不到分通道给不同刚度。
(function exposeSpring(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GerritSpring = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSpring() {
  // 单位阶跃响应：t=0 时为 0，t→∞ 时趋近 1。
  //   damping < 1  欠阻尼，会过冲后回落 —— "甩一下"的手感
  //   damping = 1  临界阻尼，单调不回头 —— 数值类变化用这个，避免数字"跳"
  //   damping > 1  过阻尼，慢慢爬
  // period 决定完成一次振荡的秒数，越小越快。
  function response(seconds, damping, period) {
    const w = 2 * Math.PI / period;
    if (damping === 1) return 1 - (1 + w * seconds) * Math.exp(-w * seconds);
    const wd = w * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * w * seconds)
      * (Math.cos(wd * seconds) + damping * w / wd * Math.sin(wd * seconds));
  }

  // 四条通道，参数取自 iOS numericText 的实测（不是随手调的）：
  //   position 纵向位移 —— 欠阻尼，落位时轻轻过冲，滚动才有"重量"
  //   body     不透明度/缩放 —— 临界阻尼，数字不能回弹闪烁
  //   blur     锐化 —— 略欠阻尼，进场时先糊后清，比直接淡入更像镜头对焦
  //   smear    离场模糊 —— 临界且最快，离场的字要"化开"而不是"飘走"
  const CHANNEL = Object.freeze({
    position: { damping: 0.55, period: 0.353 },
    body: { damping: 1.00, period: 0.278 },
    blur: { damping: 0.91, period: 0.398 },
    smear: { damping: 1.00, period: 0.220 }
  });
  const CHANNELS = Object.freeze(Object.keys(CHANNEL));

  const GLYPH_MS = 650;       // 单字动画总时长
  const LAYOUT_MS = 250;      // 未被替换的字跟随布局移动的时长
  const WAVE_MS = 150;        // 左→右波纹扫过整个读数的时间
  const SEGMENTS = 48;        // 采样段数（49 个关键帧）
  const TOLERANCE = 0.002;    // 自适应细分的最大线性误差

  function at(seconds, channel) {
    return response(seconds, CHANNEL[channel].damping, CHANNEL[channel].period);
  }

  function sample(age, index) {
    const seconds = age + (index / SEGMENTS) * Math.max(0, 0.65 - age);
    const end = index === SEGMENTS;
    const row = {};
    for (const channel of CHANNELS) row[channel] = end ? 1 : at(seconds, channel);
    return row;
  }

  // 自适应细分：从两端出发，凡是线性插值误差超过 TOLERANCE 的区段就劈开。
  // 弹簧在起跳附近曲率大、尾段近乎平坦，均匀采样会把一半关键帧浪费在尾段。
  let cachedOffsets = null;
  function offsets(age = 0) {
    if (age === 0 && cachedOffsets) return cachedOffsets;
    const rows = Array.from({ length: SEGMENTS + 1 }, (_, index) => sample(age, index));
    const kept = new Set([0, SEGMENTS]);
    const stack = [[0, SEGMENTS]];
    while (stack.length) {
      const [first, last] = stack.pop();
      let worst = 0;
      let split = 0;
      for (let index = first + 1; index < last; index += 1) {
        const t = (index - first) / (last - first);
        for (const channel of CHANNELS) {
          const linear = rows[first][channel] + (rows[last][channel] - rows[first][channel]) * t;
          const distance = Math.abs(rows[index][channel] - linear);
          if (distance > worst) { worst = distance; split = index; }
        }
      }
      if (worst > TOLERANCE && split) {
        kept.add(split);
        stack.push([first, split], [split, last]);
      }
    }
    const result = [...kept].sort((a, b) => a - b);
    if (age === 0) cachedOffsets = result;
    return result;
  }

  // 数字的"墨迹高度"占行高的比例。行程按墨迹算而不是 CSS line-height：
  // 同一个滚动距离，在不同字体/行高下视觉速度才一致。
  function inkRatio(el) {
    try {
      const view = el.ownerDocument.defaultView;
      const style = view.getComputedStyle(el);
      const context = el.ownerDocument.createElement('canvas').getContext('2d');
      if (!context) return 0.72;
      context.font = `${style.fontWeight || 'normal'} 100px ${style.fontFamily || 'sans-serif'}`;
      const metrics = context.measureText('0');
      const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
      return height > 0 ? height / 100 : 0.72;
    } catch (_) { return 0.72; }
  }

  function blurRadius(filter) {
    const matches = String(filter || '').matchAll(/blur\(([\d.]+)px\)/g);
    let sum = 0;
    for (const match of matches) sum += Number(match[1]) ** 2;
    return Math.sqrt(sum);
  }

  // 一个字形从 from 滚到 to 的全部关键帧。
  //   outgoing  离场字：反向走、淡出、迅速化开
  //   matching  这一位的字符没变，只是位置变了 —— 不滚动，跟随布局平移
  //   age       被中途打断时已经过掉的秒数，从这里接着跑而不是重头来
  function glyphFrames(options = {}) {
    const {
      outgoing = false, numeric = false, direction = 1, ink = 0.72,
      opacity = 1, filter = 'blur(0px)', matching = false, age = 0
    } = options;
    const initialBlur = blurRadius(filter);
    const initialBody = at(age, 'body');
    const initialPosition = at(age, 'position');
    const initialSmear = Math.min(0.999999, at(age, 'smear'));
    const blurEm = 0.16 * ink;
    const safe = (ratio) => (ratio >= 1 ? 1 : ratio);

    return offsets(age).map((index) => {
      const offset = index / SEGMENTS;
      const seconds = age + (index / SEGMENTS) * Math.max(0, 0.65 - age);
      const end = index === SEGMENTS;
      const position = end ? 1 : at(seconds, 'position');
      const body = end ? 1 : at(seconds, 'body');
      const blur = end ? 1 : Math.min(1, at(seconds, 'blur'));
      const smear = end ? 1 : Math.min(1, at(seconds, 'smear'));
      const blurProgress = safe(Math.max(0, Math.min(1, (smear - initialSmear) / (1 - initialSmear))));
      // 行程用 em，比例 0.59375 ≈ 数字墨迹高度的 60%，是实测出来的"刚好换位"距离
      const travel = matching ? 0 : direction * 0.59375 * ink;
      const scale = numeric && !matching
        ? (outgoing
          ? (1 - 0.6015625 * body) / (1 - 0.6015625 * initialBody)
          : 0.3984375 + 0.6015625 * body)
        : 1;
      const y = outgoing ? -travel * (position - initialPosition) : travel * (1 - position);
      return {
        offset,
        transform: `translateY(${y.toFixed(4)}em) scale(${scale.toFixed(4)})`,
        opacity: outgoing
          ? safe((opacity * (1 - body)) / (1 - initialBody))
          : matching ? opacity + (1 - opacity) * body : body,
        // 离场：先保留原来的糊度，再叠一层快速模糊
        // 进场：从糊到清。标点也一起糊 —— 一个清晰的逗号会像脏点
        filter: outgoing
          ? (index === 0 ? filter
            : `blur(${(initialBlur * (1 - blurProgress)).toFixed(3)}px) blur(${(blurEm * blurProgress).toFixed(3)}em)`)
          : (matching ? `blur(${(initialBlur * (1 - blur)).toFixed(3)}px)`
            : `blur(${(blurEm * (1 - blur)).toFixed(3)}em)`)
      };
    });
  }

  // 把一串帧交给元素。startTime 让多个字形共用同一条时间线（波纹的前提）。
  function animate(node, frames, options = {}) {
    const { duration = GLYPH_MS, delay = 0, easing = 'linear', startTime = null } = options;
    const animation = node.animate(frames, { duration, delay, easing, fill: 'both' });
    if (startTime !== null && startTime !== undefined) animation.startTime = startTime;
    return animation;
  }

  // 给曲线面板用：某条通道在 t 秒处的值
  function curve(channel, seconds) {
    return at(seconds, channel);
  }

  return {
    CHANNEL, CHANNELS, GLYPH_MS, LAYOUT_MS, WAVE_MS, SEGMENTS,
    animate, curve, glyphFrames, inkRatio, offsets, response
  };
});
