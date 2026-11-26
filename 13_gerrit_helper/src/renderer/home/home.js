'use strict';

// 主界面：一条一行 —— 一个 Gerrit change 或一个 Jenkins 构建，**不按仓库聚合**。
// 分成「订阅中 / 未订阅」两区；取消订阅的条目不再进竖条，但仍然列在下面那区，随时放回来。
// 历史的 change（已提交 / 已放弃）也会列出来（主进程单独查一轮），压暗显示。

(function main() {
  const api = window.gerritHome;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  const scroll = $('scroll');
  const meta = $('meta');
  const status = $('status');

  let items = [];
  let state = { server: '', transport: '', updated: 0, ok: true };

  $('close').addEventListener('click', () => api.close());
  $('refresh').addEventListener('click', () => api.refresh());

  // 各分区内部一律按更新时间倒序：越近的越靠前
  function sortEntries(list) {
    return list.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  function itemNode(item) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = item.id;
    li.dataset.updated = String(item.updated || 0);
    // 气泡在**窗口外**：只把这一行的屏幕位置报上去，主进程开一个复用竖条卡片渲染的小窗
    li.addEventListener('mouseenter', () => {
      const rect = li.getBoundingClientRect();
      api.hover(item.id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    });
    li.addEventListener('mouseleave', () => api.unhover());
    li.dataset.tracked = item.tracked ? 'true' : 'false';
    li.dataset.past = item.past ? 'true' : 'false';

    const dot = document.createElement('span');
    dot.className = 'item-dot';
    dot.style.setProperty('--dot-color', item.color || 'var(--muted)');

    const main = document.createElement('div');
    main.className = 'item-main';
    const title = document.createElement('div');
    title.className = 'item-title';
    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = item.title;
    name.title = item.title;
    title.append(name);
    if (item.mark) {
      const mark = document.createElement('span');
      mark.className = 'item-mark';
      mark.textContent = item.mark;
      title.append(mark);
    }
    main.append(title);
    if (item.subject) {
      const subject = document.createElement('div');
      subject.className = 'item-subject';
      subject.textContent = item.subject;
      main.append(subject);
    }
    if (item.meta) {
      const metaLine = document.createElement('div');
      metaLine.className = 'item-meta';
      metaLine.textContent = item.meta;
      if (/FAILURE|ABORTED|失败|中止/.test(item.meta)) metaLine.classList.add('bad');
      else if (/PAUSED|UNSTABLE|等待确认|不稳定/.test(item.meta)) metaLine.classList.add('warn');
      main.append(metaLine);
    }

    // 历史条目（已提交/已放弃）不在轮询里，订阅不订阅都没有意义 —— 不给按钮
    if (item.past) {
      li.append(dot, main);
      return li;
    }

    // 按钮写的是**动作**（订阅 / 取消订阅）；状态靠分区和明暗表达
    const action = document.createElement('button');
    action.className = 'item-action';
    action.type = 'button';
    action.dataset.on = item.tracked ? '0' : '1';
    action.textContent = item.tracked ? '取消订阅' : '订阅';
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        const result = await api.toggle(item.id, !item.tracked);
        if (result?.ok) {
          item.tracked = !item.tracked;
          render();   // 挪到另一区
        }
      } finally {
        action.disabled = false;
      }
    });

    li.append(dot, main, action);
    return li;
  }

  function group(title, hint, entries, emptyText) {
    const section = document.createElement('section');
    section.className = 'group';
    const head = document.createElement('div');
    head.className = 'group-head';
    const name = document.createElement('span');
    name.className = 'group-title';
    name.textContent = title;
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = String(entries.length);
    head.append(name, count);
    if (hint) {
      const label = document.createElement('span');
      label.className = 'group-hint';
      label.textContent = hint;
      head.append(label);
    }
    section.append(head);

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = emptyText;
      section.append(empty);
      return section;
    }
    const list = document.createElement('ul');
    list.className = 'items';
    for (const entry of entries) list.append(itemNode(entry));
    section.append(list);
    return section;
  }

  function render() {
    api.unhover();
    const current = items.filter((item) => !item.past);
    const tracked = sortEntries(current.filter((item) => item.tracked));
    const muted = sortEntries(current.filter((item) => !item.tracked));
    const past = sortEntries(items.filter((item) => item.past));

    scroll.replaceChildren(
      group('订阅中', '显示在竖条里', tracked, '还没有订阅的条目。'),
      group('未订阅', '不进竖条、不弹通知', muted, '没有取消订阅的条目。'),
      group('历史', '最近已提交 / 已放弃', past, '最近没有已完结的 change。')
    );

    const parts = [`<b>${tracked.length}</b> 条订阅`];
    if (muted.length) parts.push(`${muted.length} 条未订阅`);
    if (past.length) parts.push(`${past.length} 条历史`);
    if (state.transport) parts.push(state.transport === 'ssh' ? 'SSH' : 'HTTP');
    if (state.updated) {
      const at = new Date(state.updated);
      parts.push(`${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')} 更新`);
    }
    meta.innerHTML = parts.join(' · ');
    status.textContent = state.ok === false ? '拉取失败' : '订阅';
  }

  function apply(payload) {
    if (!payload) return;
    if (Array.isArray(payload.items)) items = payload.items;
    const { items: _ignored, ...rest } = payload;
    state = { ...state, ...rest };
    render();
  }

  api.onState(apply);
  api.load().then(apply).catch((error) => { meta.textContent = `加载失败：${error.message}`; });
})();
