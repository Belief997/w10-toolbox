'use strict';

// 悬浮层渲染。三块 surface 共用一个页面，靠 ?surface= 区分。
// 这里只负责画：命中测试、位置、形状裁剪全在主进程。

(function main() {
  const api = window.gerritDock;
  const roll = window.GerritRoll;
  const surface = new URLSearchParams(location.search).get('surface') || 'rail';
  const content = document.getElementById('content');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const RING_R = 18;
  const RING_C = 2 * Math.PI * RING_R;

  document.body.dataset.surface = surface;
  if (!api) return;

  // ---- 形状 --------------------------------------------------------------

  function applyShape(payload) {
    // 用主进程给的宽高，不用 window.innerWidth —— setBounds 之后
    // 渲染层的内尺寸更新晚于这条消息
    const width = payload.width || window.innerWidth;
    const height = payload.height || window.innerHeight;
    const svg = document.getElementById('shape');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    document.getElementById('shapeFill').setAttribute('d', payload.d || '');
    document.getElementById('shapeLine').setAttribute('d', payload.outline || '');
  }

  // ---- 竖条 --------------------------------------------------------------

  let cells = [];
  let focused = -1;
  let nodes = [];
  let railHeight = 0;
  let slots = [];
  let edge = 'right';
  let loading = true;
  // 玻璃体从哪开始（贴边时两端是凹肩）—— 加载块和空态文案要居中在玻璃体里
  let bodyInset = 0;
  let moreUp = null;
  let moreDown = null;

  function ringNode(cell) {
    const ring = document.createElement('div');
    ring.className = 'ring';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 42 42');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('class', 'ring-track');
    const fill = document.createElementNS(SVG_NS, 'circle');
    fill.setAttribute('class', 'ring-fill');
    for (const circle of [track, fill]) {
      circle.setAttribute('cx', '21');
      circle.setAttribute('cy', '21');
      circle.setAttribute('r', String(RING_R));
    }
    fill.setAttribute('stroke-dasharray', String(RING_C));
    svg.append(track, fill);
    const mark = document.createElement('span');
    mark.className = 'ring-mark';
    ring.append(svg, mark);
    return { ring, fill, mark };
  }

  // 等第一轮数据时的占位：转圈 + 一行小字。静态文字看不出来"它在动"。
  function loadingBlock() {
    const wrap = document.createElement('div');
    wrap.className = 'loading';
    const ring = document.createElement('div');
    ring.className = 'loading-ring';
    const text = document.createElement('span');
    text.className = 'loading-text';
    text.textContent = '读取中';
    wrap.append(ring, text);
    return wrap;
  }

  function buildRail(payload) {
    railHeight = payload.railHeight || window.innerHeight;
    if (payload.slots?.length) slots = payload.slots;
    if (payload.side) edge = payload.side;
    if (typeof payload.loading === 'boolean') loading = payload.loading;
    if (typeof payload.bodyInset === 'number') {
      bodyInset = payload.bodyInset;
      document.body.style.setProperty('--body-inset', `${bodyInset}px`);
    }
    document.body.dataset.edge = edge;
    content.replaceChildren();
    const rail = document.createElement('div');
    rail.className = 'rail';

    if (!cells.length) {
      // 还没拉到过数据时不能说"没有跟踪项" —— 那看起来像项目丢了，而且得有个动的东西
      if (loading) {
        content.append(loadingBlock());
      } else {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML = '还没有跟踪的<br>change<br><br>托盘 → 设置';
        content.append(empty);
      }
      nodes = [];
      moreUp = null;
      moreDown = null;
      return;
    }

    nodes = cells.map((cell, index) => {
      const node = document.createElement('div');
      node.className = 'cell';
      node.dataset.status = cell.status;
      node.style.setProperty('--ring-color', cell.color);
      const { ring, fill, mark } = ringNode(cell);
      const label = document.createElement('span');
      label.className = 'cell-label';
      node.append(ring, label);
      node.addEventListener('click', () => {
        // 刚拖过就别当点击，否则松手会误开浏览器
        if (draggedRecently) return;
        api.click(index);
      });
      rail.append(node);
      return { node, fill, mark, label };
    });

    // 竖条两端本来就是空的凹肩，正好放"上面/下面还有"的箭头
    // 竖排用上下箭头，横排用左右箭头
    const horizontal = edge === 'top';
    moreUp = document.createElement('div');
    moreUp.className = 'rail-more';
    moreUp.dataset.dir = 'up';
    moreUp.textContent = horizontal ? '◀' : '▲';
    moreDown = document.createElement('div');
    moreDown.className = 'rail-more';
    moreDown.dataset.dir = 'down';
    moreDown.textContent = horizontal ? '▶' : '▼';
    rail.append(moreUp, moreDown);

    content.append(rail);
    updateRail();
  }

  // 格子坐标和形状必须一起换。贴边↔悬空时两端留白 28↔10，
  // 只换形状不换坐标，第一个环就会冒出玻璃上沿（或者上下不对称）。
  function applySlots() {
    nodes.forEach((entry, index) => {
      const slot = slots[index];
      if (!entry || !slot) return;
      const { node } = entry;
      node.style.left = `${slot.left}px`;
      node.style.top = `${slot.top}px`;
      node.style.width = `${slot.width}px`;
      node.style.height = `${slot.height}px`;
    });
  }

  function updateRail() {
    applySlots();
    cells.forEach((cell, index) => {
      const entry = nodes[index];
      if (!entry) return;
      entry.node.style.setProperty('--ring-color', cell.color);
      entry.node.dataset.status = cell.status;
      entry.fill.style.strokeDashoffset = String(RING_C * (1 - Math.max(0, Math.min(100, cell.progress)) / 100));
      entry.mark.textContent = cell.mark;
      entry.label.textContent = cell.label;
      entry.label.style.color = '';
      entry.node.classList.toggle('is-focused', index === focused);
    });
  }

  function updateMore() {
    if (moreUp) moreUp.classList.toggle('is-on', Boolean(moreUp.dataset.on === '1'));
    if (moreDown) moreDown.classList.toggle('is-on', Boolean(moreDown.dataset.on === '1'));
  }

  function onCells(payload) {
    if (surface !== 'rail') return;
    const next = Array.isArray(payload?.cells) ? payload.cells : [];
    const before = cells.map((cell) => cell.id).join(',');
    cells = next;
    focused = Number.isInteger(payload?.focused) ? payload.focused : -1;
    // 横竖切换、格子数量变化都要重建；其余情况也把新坐标收下来，
    // updateRail 会照着套 —— 贴边/悬空切换就是"数量没变但坐标变了"
    // 拉取结束（loading 变 false）但没有跟踪项时，得重建才能把"正在读取"换成"还没有跟踪"
    const changedLayout = (payload?.side || edge) !== edge
      || (payload?.slots?.length ?? slots.length) !== slots.length
      || (payload?.loading === true) !== loading;
    if (Array.isArray(payload?.slots)) slots = payload.slots;
    if (typeof payload?.loading === 'boolean') loading = payload.loading;
    if (payload?.side) {
      edge = payload.side;
      document.body.dataset.edge = edge;
    }
    if (changedLayout || before !== cells.map((cell) => cell.id).join(',')
      || cells.length !== nodes.length) {
      buildRail(payload);
    } else {
      updateRail();
    }
    if (moreUp) moreUp.dataset.on = payload?.hasLess ? '1' : '0';
    if (moreDown) moreDown.dataset.on = payload?.hasMore ? '1' : '0';
    updateMore();
  }

  // ---- 构建卡片 -----------------------------------------------------------

  const BUILD_LABEL = {
    IN_PROGRESS: '构建中',
    SUCCESS: '成功',
    FAILURE: '失败',
    UNSTABLE: '不稳定',
    ABORTED: '已中止',
    PAUSED_PENDING_INPUT: '等待确认'
  };
  const STAGE_TONE = {
    SUCCESS: 'ok', IN_PROGRESS: 'run', FAILED: 'bad', UNSTABLE: 'warn',
    PAUSED_PENDING_INPUT: 'warn', ABORTED: 'bad', NOT_EXECUTED: 'idle', SKIPPED: 'idle'
  };

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function renderBuildCard(cell, flash) {
    content.replaceChildren();
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const project = document.createElement('div');
    project.className = 'card-project';
    project.textContent = cell.projectShort || cell.job;
    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.dataset.tone = cell.color === '#f29a8c' ? 'bad'
      : cell.color === '#e8c27a' ? 'pending'
        : cell.color === '#b7ead4' ? 'ready' : 'merged';
    badge.textContent = BUILD_LABEL[cell.state] || cell.state;
    head.append(project, badge);

    const subject = document.createElement('div');
    subject.className = 'card-subject';
    subject.textContent = cell.subject;

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const percent = Math.round(cell.progress);
    meta.innerHTML = [
      `<span>#${cell.number}</span>`,
      `<span>${cell.state === 'IN_PROGRESS' ? `${percent}%` : '—'}</span>`,
      `<span>${cell.estimated ? `预计 ${formatDuration(cell.estimated)}` : ''}</span>`
    ].join('');

    const stages = cell.stages || [];
    const currentIndex = stages.findIndex((stage) => stage.status === 'IN_PROGRESS');
    const pendingIndex = stages.findIndex((stage) => stage.pending);
    const doneCount = stages.filter((stage) => STAGE_TONE[stage.status] === 'ok').length;
    // 整体还在跑、但没有任何 stage 在 IN_PROGRESS —— 说明卡在两步之间，
    // 这时点亮"下一步"，否则整排节点没有一个在动，看不出走到哪了
    const focusIndex = currentIndex >= 0 ? currentIndex
      : (cell.building ? pendingIndex : -1);

    // 横向节点：一眼看到"走到第几步、还剩几步"
    const track = document.createElement('div');
    track.className = 'build-track';
    for (const [index, stage] of stages.entries()) {
      const tone = STAGE_TONE[stage.status] || 'idle';
      const node = document.createElement('span');
      node.className = 'build-node';
      node.dataset.tone = tone;
      if (tone === 'ok') node.dataset.done = '1';
      if (index === focusIndex) node.classList.add('is-current');
      node.title = stage.name;
      const dot = document.createElement('span');
      dot.className = 'build-dot';
      node.append(dot);
      track.append(node);
    }
    const trackFoot = document.createElement('div');
    trackFoot.className = 'build-track-foot';
    const step = document.createElement('span');
    step.textContent = currentIndex >= 0
      ? `第 ${currentIndex + 1}/${stages.length} 步 · ${stages[currentIndex].name}`
      : (cell.building && pendingIndex >= 0)
        ? `已完成 ${doneCount}/${stages.length} 步 · 接下来 ${stages[pendingIndex].name}`
        : `${stages.length} 步 · ${BUILD_LABEL[cell.state] || cell.state}`;
    const tally = document.createElement('span');
    tally.textContent = cell.building
      ? `剩 ${Math.max(0, stages.length - doneCount)} 步`
      : `${doneCount} 步已完成`;
    trackFoot.append(step, tally);

    const timeline = document.createElement('div');
    timeline.className = 'card-timeline';
    const list = document.createElement('div');
    list.className = 'card-timeline-body';
    // 列表只列真正跑过的阶段；还没轮到的在横向节点上已经能看到了，
    // 再列一遍只是把卡片撑高。排序和 change 的时间线一致：最新的在最上面。
    const listed = stages
      .filter((stage) => !stage.pending)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    for (const stage of listed) {
      const row = document.createElement('div');
      row.className = 'event';
      row.dataset.tone = STAGE_TONE[stage.status] === 'bad' ? 'bad'
        : STAGE_TONE[stage.status] === 'warn' ? 'warn' : 'ok';
      const dot = document.createElement('span');
      dot.className = 'event-dot';
      const name = document.createElement('span');
      name.className = 'event-text';
      name.textContent = stage.name;
      const time = document.createElement('span');
      time.className = 'event-time';
      // 三种耗时：真实值 / 正在跑（实时计时）/ 从内部步骤还原的估算值
      time.textContent = stage.live ? `已跑 ${formatDuration(stage.durationMs)}`
        : stage.estimated ? `≈ ${formatDuration(stage.durationMs)}`
          : stage.durationMs ? formatDuration(stage.durationMs)
            : stage.clockSkew ? '时钟不同步' : '—';
      row.append(dot, name, time);
      list.append(row);
    }
    if (list.children.length) {
      timeline.append(list);
    }

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const open = document.createElement('button');
    open.textContent = '在 Jenkins 打开';
    open.addEventListener('click', () => api.openUrl(cell.url));
    const refresh = document.createElement('button');
    refresh.textContent = '刷新';
    refresh.addEventListener('click', () => api.refresh());
    foot.append(open, refresh);

    if (flash?.length) card.append(flashStrip(flash));
    card.append(head, subject, meta);
    if (stages.length) card.append(track, trackFoot);
    if (timeline.children.length) card.append(timeline);
    card.append(foot);
    content.append(card);

    requestAnimationFrame(() => {
      api.reportCardSize(Math.ceil(card.getBoundingClientRect().height) + 2);
    });
  }

  // ---- 卡片 --------------------------------------------------------------

  function toneOfEvent(text) {
    if (/fail|failed|失败|错误|reject|abandon/i.test(text)) return 'bad';
    if (/request|added you|需要|-\d/.test(text)) return 'warn';
    return 'ok';
  }

  function relativeTime(ts) {
    if (!ts) return '';
    const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.round(hours / 24)} 天前`;
  }

  const STATUS_LABEL = { NEW: '进行中', MERGED: '已提交', ABANDONED: '已放弃' };

  // 状态变化后主动弹出时，卡片顶部加一条高亮说明
  function flashStrip(texts) {
    const strip = document.createElement('div');
    strip.className = 'card-flash';
    const dot = document.createElement('span');
    dot.className = 'card-flash-dot';
    const body = document.createElement('div');
    body.className = 'card-flash-text';
    body.textContent = texts.slice(0, 2).join(' · ');
    if (texts.length > 2) body.textContent += ` 等 ${texts.length} 项`;
    strip.append(dot, body);
    return strip;
  }

  function renderCard(cell, flash) {
    if (cell.kind === 'build') { renderBuildCard(cell, flash); return; }
    const snapshot = roll.capture(content);
    content.replaceChildren();

    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const project = document.createElement('div');
    project.className = 'card-project';
    project.textContent = cell.projectShort;
    // 发起人：这条 change 是谁开的。名字长了让项目名先省略
    const idBox = document.createElement('div');
    idBox.className = 'card-id';
    idBox.append(project);
    if (cell.owner) {
      const owner = document.createElement('span');
      owner.className = 'card-owner';
      owner.textContent = `发起人 ${cell.owner}`;
      idBox.append(owner);
    }
    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.dataset.tone = cell.tone;
    badge.textContent = STATUS_LABEL[cell.status] || cell.status;
    head.append(idBox, badge);

    const subject = document.createElement('div');
    subject.className = 'card-subject';
    subject.textContent = cell.subject;

    const ciFailed = cell.votes.verifiedMin !== null && cell.votes.verifiedMin < 0;
    const ciText = ciFailed ? '失败' : (cell.votes.verified === null ? '—' : '通过');
    const crValue = cell.votes.cr === null ? '—' : (cell.votes.cr > 0 ? `+${cell.votes.cr}` : String(cell.votes.cr));
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.innerHTML = [
      `<span>PS <b data-roll-key="patchset">${cell.patchset ?? '—'}</b></span>`,
      `<span>CR <b data-roll-key="cr">${crValue}</b></span>`,
      `<span>CI <b data-roll-key="ci"${ciFailed ? ' class="is-bad"' : ''}>${ciText}</b></span>`,
      `<span>${relativeTime(cell.updated)}</span>`
    ].join('');

    // 时间线全量渲染，超出高度自己滚 —— 卡片窗口的高度跟着内容走，
    // 但列表本身有 max-height，所以卡片不会被几十条评论撑到屏幕外。
    const timeline = document.createElement('div');
    timeline.className = 'card-timeline';
    const list = document.createElement('div');
    list.className = 'card-timeline-body';
    const events = cell.events || [];
    for (const event of events) {
      const row = document.createElement('div');
      row.className = 'event';
      row.dataset.tone = toneOfEvent(event.text);
      const dot = document.createElement('span');
      dot.className = 'event-dot';
      const text = document.createElement('span');
      text.className = 'event-text';
      // 时间线每行带上发起人：谁传的这一版、谁打的这个分，一眼能看到
      if (event.author) {
        const who = document.createElement('b');
        who.className = 'event-author';
        who.textContent = event.author;
        text.append(who);
      }
      text.append(event.text.slice(0, 120));
      const time = document.createElement('span');
      time.className = 'event-time';
      time.textContent = relativeTime(event.ts);
      row.append(dot, text, time);
      list.append(row);
    }
    if (events.length) {
      timeline.append(list);
    }

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const open = document.createElement('button');
    open.textContent = '在 Gerrit 打开';
    open.addEventListener('click', () => api.openUrl(cell.url));
    const refresh = document.createElement('button');
    refresh.textContent = '刷新';
    refresh.addEventListener('click', () => api.refresh());
    foot.append(open, refresh);

    if (flash?.length) card.append(flashStrip(flash));
    card.append(head, subject, meta);
    if (timeline.children.length) card.append(timeline);
    card.append(foot);
    content.append(card);

    // 数值变了才滚：PS 4 → 5、CR +1 → +2
    for (const node of content.querySelectorAll('[data-roll-key]')) {
      const raw = node.textContent.trim();
      const value = Number(raw.replace(/[^\d+-]/g, ''));
      roll.mark(node, node.dataset.rollKey, Number.isFinite(value) ? value : NaN);
    }
    roll.play(content, snapshot);

    // 量完高度报给主进程，由它 setBounds —— 卡片永远按内容长高
    requestAnimationFrame(() => {
      const height = Math.ceil(card.getBoundingClientRect().height) + 2;
      api.reportCardSize(height);
    });
  }

  // ---- 接线 --------------------------------------------------------------

  // 有真亚克力时底色可以薄一点（后面是真模糊）；没有就得厚，否则读不清
  api.onMaterial((payload) => {
    document.documentElement.dataset.material = payload?.native ? 'native' : 'tint';
  });

  // 背景不透明度：一个滑杆控制全部 surface，竖条和卡片用同一个值。
  // 值通过 CSS 变量下发，--glass 要在同一个作用域里重新算（自定义属性在声明处求值）。
  api.onAppearance((payload) => {
    const percent = Math.max(0, Math.min(100, Number(payload?.glassAlpha) || 0));
    const alpha = percent / 100;   // 100 = 完全不透明
    document.documentElement.style.setProperty('--glass-opacity', alpha.toFixed(3));
  });

  api.onShape(applyShape);
  api.onCells(onCells);
  api.onFocus((payload) => {
    focused = Number.isInteger(payload?.focused) ? payload.focused : -1;
    if (surface === 'rail') updateRail();
  });
  api.onCard((payload) => {
    if (surface !== 'card' || !payload?.cell) return;
    document.body.dataset.side = payload.side || 'right';
    // 顶边吸附时卡片挂在竖条下面，尾巴在上边 —— 内容要跟着往下让出尾巴
    document.body.dataset.edge = payload.side || 'right';
    renderCard(payload.cell, payload.flash);
  });

  // 拖动：按下后移动超过 4px 才算拖拽，免得和点击打架
  let press = null;
  let draggedRecently = false;
  window.addEventListener('mousedown', (event) => {
    if (surface !== 'rail' || event.button !== 0) return;
    press = { x: event.screenX, y: event.screenY, moved: false };
  });
  window.addEventListener('mousemove', (event) => {
    if (!press) return;
    const distance = Math.hypot(event.screenX - press.x, event.screenY - press.y);
    if (!press.moved && distance < 4) return;
    if (!press.moved) {
      press.moved = true;
      draggedRecently = true;
      api.dragStart();
    }
  });
  window.addEventListener('mouseup', () => {
    if (press?.moved) {
      api.dragEnd();
      // 松手后一小段时间内不响应点击
      setTimeout(() => { draggedRecently = false; }, 200);
    }
    press = null;
  });
  window.addEventListener('blur', () => {
    if (press?.moved) api.dragEnd();
    press = null;
  });

  // 滚轮翻页：一次滚动一格，节流 80ms —— 触控板会一口气发十几个事件
  let lastScrollAt = 0;
  window.addEventListener('wheel', (event) => {
    if (surface !== 'rail') return;
    if (Math.abs(event.deltaY) < 1) return;
    const now = performance.now();
    if (now - lastScrollAt < 80) return;
    lastScrollAt = now;
    api.scroll(event.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  // 窗口尺寸由主进程改，这里跟着重算一次形状和格子位置
  window.addEventListener('resize', () => {
    if (surface !== 'rail') return;
    buildRail({ slots, side: edge, loading, bodyInset, railHeight: window.innerHeight });
  });
})();
