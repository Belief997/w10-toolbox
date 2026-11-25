'use strict';

// 桌面通知。三条规则：
//   1. 按事件类型过滤（设置里能关）
//   2. 去重（同一事件跨轮不重复弹），重启后清空 —— 事件 id 里带 patchset/分值，
//      重启再弹一次反而是对的
//   3. 聚合：一次刷新出 3 条以上就合成一条，点开看详情，别刷屏

const { Notification } = require('electron');

const SEEN_LIMIT = 500;

function createNotifier({ getConfig, onClick }) {
  const seen = new Set();
  const queue = [];

  function allowed(type) {
    const notify = getConfig().notify || {};
    return notify[type] !== false;
  }

  function remember(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) {
      // Set 是有序的，从头删最旧的
      for (const key of seen) { seen.delete(key); if (seen.size <= SEEN_LIMIT) break; }
    }
    return true;
  }

  function show(title, body, events) {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => onClick?.(events?.[0] || null));
    notification.show();
  }

  function notify(events) {
    const fresh = events.filter((event) => allowed(event.type) && remember(event.id));
    if (!fresh.length) return;

    if (fresh.length === 1) {
      show('Gerrit', fresh[0].text, fresh);
      return;
    }
    const urgent = fresh.filter((event) => event.urgent).length;
    show(
      `Gerrit · ${fresh.length} 条更新`,
      urgent ? fresh.slice(0, 3).map((event) => event.text).join('\n') : fresh[0].text,
      fresh
    );
  }

  return { notify };
}

module.exports = { createNotifier };
