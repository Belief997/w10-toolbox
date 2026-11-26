'use strict';

// 主界面的一条 = 一个 change 或一个构建（不是"仓库"）。
// 纯函数，好测：cell → 主界面要的那几个字段，再按"订阅 / 未订阅"分区。

const STATUS_LABEL = {
  NEW: '进行中',
  MERGED: '已提交',
  ABANDONED: '已放弃',
  IN_PROGRESS: '构建中',
  SUCCESS: '成功',
  FAILURE: '失败',
  UNSTABLE: '不稳定',
  ABORTED: '已中止',
  PAUSED_PENDING_INPUT: '等待确认'
};

// 一条 change 的副标题：项目 + 编号（构建则是 job）
function titleOf(cell) {
  if (cell.kind === 'build') {
    return `${cell.job || '?'} ${cell.label || ''}`.trim();
  }
  const project = cell.projectShort || cell.project || '?';
  return `${project} ${cell.label || ''}`.trim();
}

function metaOf(cell) {
  if (cell.kind === 'build') {
    const state = String(cell.state || cell.status || '');
    return STATUS_LABEL[state] || state;
  }
  const parts = [];
  if (cell.patchset) parts.push(`PS ${cell.patchset}`);
  if (cell.votes?.cr !== null && cell.votes?.cr !== undefined) {
    parts.push(`CR ${cell.votes.cr > 0 ? `+${cell.votes.cr}` : cell.votes.cr}`);
  }
  const status = STATUS_LABEL[cell.status] || cell.status || '';
  if (status) parts.push(status);
  return parts.join(' · ');
}

// cell id 是 `<服务器>|<编号>` 或 `build|<job>`。服务器地址一变（比如从
// https://host 改成 https://host/gerrit），前缀就跟着变 —— 订阅名单不能因此失效，
// 所以比对时只看 "|" 后面那段（change 号 / job 名，在本机都是唯一的）。
function muteKey(id) {
  const text = String(id || '');
  const cut = text.lastIndexOf('|');
  return cut >= 0 ? text.slice(cut + 1) : text;
}

// 订阅名单（存的是完整 id）→ 用于比对的 key 集合
function mutedKeySet(mutedIds) {
  return new Set((mutedIds || []).map(muteKey));
}

function toHomeItem(cell, mutedSet) {
  const muted = mutedSet instanceof Set ? mutedSet : new Set(mutedSet || []);
  return {
    id: cell.id,
    kind: cell.kind === 'build' ? 'build' : 'change',
    tracked: !muted.has(muteKey(cell.id)),
    // 主体文字：change 是"项目 #号" + 标题，构建是"job #号" + 当前 stage
    title: titleOf(cell),
    subject: String(cell.subject || ''),
    meta: metaOf(cell),
    tone: cell.tone || 'normal',
    color: cell.color || '',
    mark: cell.mark || '',
    // 已提交 / 已放弃的历史 change 在主界面里压暗
    past: Boolean(cell.past),
    updated: Number(cell.updated) || 0,
    // 悬浮气泡用：和竖条里那张卡片同一份数据（时间线取最近几条）
    owner: String(cell.owner || ''),
    project: String(cell.project || ''),
    url: String(cell.url || ''),
    status: String(cell.status || cell.state || ''),
    events: (Array.isArray(cell.events) ? cell.events : []).slice(0, 5).map((event) => ({
      ts: Number(event.ts) || 0,
      author: String(event.author || ''),
      text: String(event.text || '').slice(0, 120)
    }))
  };
}

// 分区：订阅中的排前面（按更新时间倒序），未订阅的沉底
function splitItems(items, now = Date.now()) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean).slice();
  const tracked = [];
  const muted = [];
  for (const item of list) (item.tracked ? tracked : muted).push(item);
  for (const group of [tracked, muted]) {
    group.sort((a, b) => (b.past === a.past ? 0 : a.past ? 1 : -1)
      || ((b.updated || 0) - (a.updated || 0)));
  }
  return { tracked, muted, at: now };
}

module.exports = { STATUS_LABEL, metaOf, muteKey, mutedKeySet, splitItems, titleOf, toHomeItem };
