'use strict';

// 数字滚动：数据刷新导致 DOM 重建时，动画不重头再来。
//
// 常规做法（CSS transition）在这里一定会翻车：轮询每 30s 推一次数据，
// 渲染层把列表整体重建，新节点上没有"旧值"，transition 无从谈起，
// 观感就是数字每 30s 闪一下。
//
// 这里的做法是"快照 + 重放"：
//   渲染前  capture(container)  把旧 DOM 里每个字形的 位置/透明度/模糊 存下来
//   渲染后  play(container, snap) 按 key 匹配每一位，用 WAAPI 从旧位置滚到新位置
//
// 匹配的 key 是按字符位编的（digit:0 / symbol:3:, / unit:0:M），
// 所以 1,234 → 12,340 这种千位重排也能正确滚动，而不是整串替换。
(function exposeRoll(root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./spring')
    : root && root.GerritSpring);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GerritRoll = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRoll(spring) {
  const SELECTOR = '[data-roll-key]';
  const DIGIT = /[0-9]/;
  const active = new WeakMap();

  // 把读数拆成逐字 + 不可拆的尾部单位。
  // "191.8M" 的 M、"43%" 的 % 从末尾数起编 key，这样它们不参与滚动，
  // 只跟着前面的数字平移 —— 一个滚动的单位符号会读成乱码。
  function parts(text) {
    const chars = Array.from(String(text));
    let unit = chars.length;
    while (unit > 0 && !DIGIT.test(chars[unit - 1])) unit -= 1;
    if (unit === 0) unit = chars.length;
    return chars.map((char, index) => {
      const numeric = DIGIT.test(char);
      if (index >= unit) return { char, numeric, key: `unit:${chars.length - index}:${char}` };
      return { char, numeric, key: numeric ? `digit:${index}` : `symbol:${index}:${char}` };
    });
  }

  // 标注一个读数字符串。渲染时调用，记下它当前的文本和数值。
  function mark(node, key, value) {
    node.dataset.rollKey = key;
    node.dataset.rollText = node.textContent;
    if (Number.isFinite(value)) node.dataset.rollValue = String(value);
    return node;
  }

  // 没有快照时（首次渲染）现场铺一层字形来量位置
  function layoutSpan(doc, el, text) {
    const list = parts(text);
    const span = doc.createElement('span');
    span.className = 'gn-glyphs';
    span.setAttribute('aria-hidden', 'true');
    const nodes = list.map((part) => {
      const glyph = doc.createElement('span');
      glyph.className = 'gn-glyph';
      glyph.textContent = part.char;
      span.append(glyph);
      return glyph;
    });
    el.replaceChildren(span);
    const fontSize = parseFloat(doc.defaultView.getComputedStyle(el).fontSize) || 16;
    return list.map((part, index) => ({
      ...part,
      fontSize,
      rect: nodes[index].getBoundingClientRect(),
      opacity: 1,
      filter: 'blur(0px)'
    }));
  }

  // 读出一个读数的所有可见字形（正在淡出的也算，它还在屏幕上）
  function readGlyphs(el) {
    const motion = active.get(el);
    if (!motion) return null;
    const view = el.ownerDocument.defaultView;
    return motion.glyphs.map(({ glyph, key, char, numeric }) => {
      const style = view.getComputedStyle(glyph);
      const rect = glyph.getBoundingClientRect();
      const lineHeight = parseFloat(style.lineHeight) || glyph.offsetHeight || rect.height;
      return {
        key, char, numeric, rect,
        fontSize: (parseFloat(style.fontSize) || 16) * rect.height / lineHeight,
        opacity: Number(style.opacity),
        filter: style.filter
      };
    }).filter((glyph) => glyph.rect.width > 0 && glyph.opacity > 0.001);
  }

  // ---- 渲染前：快照 ---------------------------------------------------------
  // 读完之后立刻 settle：旧节点马上要被替换掉，留着它的动画只会让合成层
  // 挂在离屏位置。注意顺序 —— 必须先量完位置再 settle，settle 会还原文本、
  // 销毁字形节点。
  function capture(container) {
    const snapshot = new Map();
    for (const node of container?.querySelectorAll(SELECTOR) || []) {
      const key = node.dataset.rollKey;
      const entry = snapshot.has(key) ? null : {
        text: node.dataset.rollText,
        value: Number(node.dataset.rollValue),
        glyphs: readGlyphs(node)
      };
      snapshot.set(key, entry);
      active.get(node)?.settle();
    }
    return snapshot;
  }

  // ---- 渲染后：重放 ---------------------------------------------------------
  // 每一个读数，文字变了且两边都含数字才滚；'—' / '--' 这类是替换不是滚动。
  function play(container, snapshot, options = {}) {
    const { skip = () => false } = options;
    if (!snapshot?.size) return [];
    const pending = [];
    for (const node of container?.querySelectorAll(SELECTOR) || []) {
      const previous = snapshot.get(node.dataset.rollKey);
      const text = node.dataset.rollText;
      if (!previous || previous.text === text || skip(node)) continue;
      if (!DIGIT.test(previous.text) || !DIGIT.test(text)) continue;
      const value = Number(node.dataset.rollValue);
      // 数值变大 = 新数字从下方进来；没有数值时按"什么都没变"处理，向上滚
      const increasing = !(Number.isFinite(value) && Number.isFinite(previous.value)) || value > previous.value;
      pending.push(beginRoll(node, previous.text, text, increasing, previous.glyphs));
    }
    return pending;
  }

  function beginRoll(el, fromText, toText, increasing, snapshot) {
    const doc = el.ownerDocument;
    active.get(el)?.settle();

    const previous = snapshot?.length ? snapshot : layoutSpan(doc, el, fromText);
    const before = parts(fromText);
    const after = parts(toText);
    // 只有未变的前缀保留身份：它跟着布局平移，其余全部重滚。
    // 这样 1,234 → 12,340 的逗号会跟着走，而不是把等的数字也甩一遍。
    let prefix = 0;
    while (prefix < Math.min(before.length, after.length) && before[prefix].char === after[prefix].char) prefix += 1;

    const wrapper = doc.createElement('span');
    wrapper.className = 'gn-glyphs';
    wrapper.setAttribute('aria-hidden', 'true');
    const places = after.map((part) => {
      const place = doc.createElement('span');
      place.className = 'gn-place';
      const glyph = doc.createElement('span');
      glyph.className = 'gn-glyph';
      glyph.textContent = part.char;
      place.append(glyph);
      wrapper.append(place);
      return { ...part, place, glyph };
    });
    // 真正撑布局和给读屏用的那层，永远是最终文本
    const reading = doc.createElement('span');
    reading.className = 'gn-reading';
    reading.textContent = toText;
    el.setAttribute('data-gn-roll', 'roll');
    el.replaceChildren(reading, wrapper);

    // 只做两次布局读取：整个 wrapper 和目标每一位。之后全程不读布局。
    const box = wrapper.getBoundingClientRect();
    const rects = places.map(({ place }) => place.getBoundingClientRect());
    // 离场字会停在原位、可能超出盒子。用 padding 撑开遮罩而不影响排版。
    const lefts = previous.map((g) => g.rect.left);
    const rights = previous.map((g) => g.rect.left + g.rect.width);
    const overhangLeft = Math.max(0, box.left - Math.min(...lefts));
    const overhangRight = Math.max(0, Math.max(...rights) - box.left - box.width);
    if (overhangLeft) wrapper.style.setProperty('--gn-overhang-left', `${overhangLeft}px`);
    if (overhangRight) wrapper.style.setProperty('--gn-overhang-right', `${overhangRight}px`);

    const origin = { left: box.left - overhangLeft, top: box.top };
    const ink = spring.inkRatio(el);
    const direction = increasing ? 1 : -1;
    const startTime = doc.timeline?.currentTime ?? null;
    const animations = [];
    const glyphs = [];

    const center = (rect) => rect.left + rect.width / 2;
    const indexOf = (key) => { const value = Number(key.split(':')[1]); return Number.isFinite(value) ? value : 0; };
    const isUnit = (key) => key.startsWith('unit:');
    const changing = (index) => index >= prefix;

    // 波纹是空间上的：按 x 排序算延迟，所以离场字和盖在它上面的进场字一起变，
    // 即使千位重排把它们的序号拉远了。
    const centers = [
      ...previous.filter((g) => !isUnit(g.key) && changing(indexOf(g.key))).map((g) => center(g.rect)),
      ...rects.filter((_, index) => !isUnit(places[index].key) && changing(index)).map(center)
    ];
    const waveStart = centers.length ? Math.min(...centers) : 0;
    const waveSpan = centers.length ? Math.max(...centers) - waveStart : 0;
    const delayAt = (rect) => (waveSpan > 0 ? spring.WAVE_MS * Math.min(1, Math.max(0, center(rect) - waveStart) / waveSpan) : 0);

    function animate(node, frames, delay, duration, easing) {
      const animation = spring.animate(node, frames, { duration, delay, easing, startTime });
      animations.push(animation);
      return animation;
    }

    // 离场字：绝对定位留在它原来的位置，然后原地化开
    function appendOutgoing(old) {
      const glyph = doc.createElement('span');
      glyph.className = 'gn-glyph gn-previous';
      glyph.textContent = old.char;
      Object.assign(glyph.style, {
        left: `${old.rect.left - origin.left}px`,
        top: `${old.rect.top - origin.top}px`,
        width: `${old.rect.width}px`,
        height: `${old.rect.height}px`,
        fontSize: `${old.fontSize}px`
      });
      wrapper.append(glyph);
      animate(glyph, spring.glyphFrames({
        outgoing: true, numeric: old.numeric, direction, ink,
        opacity: old.opacity, filter: old.filter
      }), 0, spring.GLYPH_MS, 'linear');
      glyphs.push({ glyph, key: old.key, char: old.char, numeric: old.numeric });
    }

    places.forEach(({ key, char, numeric, place, glyph }, index) => {
      const rect = rects[index];
      const candidates = previous.filter((item) => item.key === key);
      // 未变前缀里同字符的旧字形直接接管这一位：平移而不是滚动
      const matching = (index < prefix || isUnit(key))
        ? candidates.filter((item) => item.char === char).sort((a, b) => b.opacity - a.opacity)[0]
        : null;

      if (matching) {
        const scale = rect.height > 0 ? matching.rect.height / rect.height : 1;
        const dx = matching.rect.left - rect.left;
        const dy = matching.rect.top - rect.top;
        if (dx || dy || scale !== 1) {
          animate(place, [
            { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
            { transform: 'translate(0px, 0px) scale(1)' }
          ], 0, spring.LAYOUT_MS, 'cubic-bezier(0, 0, 0.58, 1)');
        }
      }
      animate(glyph, spring.glyphFrames({
        numeric, direction, ink,
        matching: Boolean(matching),
        opacity: matching?.opacity ?? 0,
        filter: matching?.filter ?? 'blur(0px)'
      }), matching ? 0 : delayAt(rect), spring.GLYPH_MS, 'linear');

      glyphs.push({ glyph, key, char, numeric });
      for (const old of candidates) if (old !== matching) appendOutgoing(old);
    });

    // 少了几位（999 → 12）：多出来的旧字形从它原来的位置退场
    const keys = new Set(places.map((part) => part.key));
    for (const old of previous) if (!keys.has(old.key)) appendOutgoing(old);

    // 稳定后把干净的文本换回去，不留一堆已结束的动画节点。
    // 定时器是必须的：没有它，元素会一直挂着"读屏文本 + 全部字形"两套内容，
    // textContent / 复制 / 读屏都会读出重复数字（自测里 final=77128 就是这个坑）。
    let settled = false;
    let timer = 0;
    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const animation of animations) animation.cancel();
      if (active.get(el)?.settle !== settle) return;
      active.delete(el);
      el.textContent = toText;
      el.removeAttribute('data-gn-roll');
    }
    active.set(el, { glyphs, settle });
    // 最后一帧落位 + 一点余量，再还原文本
    timer = setTimeout(settle, spring.WAVE_MS + spring.GLYPH_MS + 32);
    return settle;
  }

  return { beginRoll, capture, mark, parts, play };
});
