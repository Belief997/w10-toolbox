'use strict';

// Gerrit REST 对象 → 悬浮条上的一格。纯函数，不碰网络也不碰 DOM。

// Gerrit 的时间是 "2026-01-15 10:22:31.000000000"，不是 ISO —— 直接 new Date()
// 在部分引擎里会解析成 NaN。
function parseGerritTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value * 1000;
  const text = String(value).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const time = Date.parse(text.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(time) ? time : 0;
}

function shortProject(project) {
  const parts = String(project || '').split('/');
  return parts[parts.length - 1] || project || '?';
}

// 某个 label 的分数汇总：最高分、最低分、以及"我自己"给的分
function labelScore(change, name, selfId) {
  const all = change?.labels?.[name]?.all || [];
  let max = null;
  let min = null;
  let mine = null;
  for (const vote of all) {
    if (typeof vote.value !== 'number') continue;
    if (max === null || vote.value > max) max = vote.value;
    if (min === null || vote.value < min) min = vote.value;
    if (selfId !== null && selfId !== undefined && vote._account_id === selfId) mine = vote.value;
  }
  return { max, min, mine };
}

// 某个 label 上的投票人名单。用来判断"有新的 reviewer 参与"，
// 和"最高分变没变"是两件事：两个人各给 +1，最高分一直是 1，但确实有人来了。
function labelVoters(change, name) {
  return (change?.labels?.[name]?.all || [])
    .map((vote) => vote.name || vote._account_id || '')
    .filter(Boolean)
    .sort();
}

// 最新一条评论，给通知文案用
function latestComment(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  let newest = null;
  for (const message of messages) {
    const ts = parseGerritTime(message.date);
    if (!newest || ts > newest.ts) {
      newest = {
        ts,
        author: message.author?.name || message.author?.username || '',
        text: String(message.message || '').trim().replace(/\s+/g, ' ').slice(0, 60)
      };
    }
  }
  return newest;
}

// 环的进度：用 Code-Review 的评审阶梯当"离 +2 还有多远"。
// 不是 Gerrit 的真实字段 —— 但竖条里需要一个"进展"的视觉，CR 是最贴切的。
// 底部留 8%：环是这一格的身份色，完全没有弧就只剩灰色轨道，颜色语义就丢了。
const MIN_ARC = 8;

function reviewProgress(change, cr) {
  if (change.status === 'MERGED' || change.status === 'ABANDONED') return 100;
  switch (cr.max) {
    case 2: return 100;
    case 1: return 70;
    case 0: return 35;
    case -1: return 20;
    case -2: return 10;
    default: return MIN_ARC;
  }
}

const TONE = Object.freeze({
  merged: '#8fb8f0',
  abandoned: '#6b7280',
  bad: '#f29a8c',
  pending: '#e8c27a',
  ready: '#b7ead4',
  normal: '#b7ead4'
});

function toneFor(change, cr, verified, needsReview) {
  if (change.status === 'MERGED') return 'merged';
  if (change.status === 'ABANDONED') return 'abandoned';
  if (verified.min !== null && verified.min < 0) return 'bad';
  if (cr.max === 2) return 'ready';
  if (needsReview) return 'pending';
  return 'normal';
}

function markFor(change, cr, verified) {
  if (change.status === 'MERGED') return '✓';
  if (change.status === 'ABANDONED') return '✕';
  if (verified.min !== null && verified.min < 0) return 'CI';
  if (cr.max === 2) return '+2';
  if (cr.max === 1) return '+1';
  if (cr.min !== null && cr.min <= -1) return '-1';
  return '···';
}

// 一轮拉取的完整产出：既给渲染层（cells），也给 diff 引擎（原始快照）
// role 是从"这条 change 由哪条查询返回的"推出来的（owner:self / reviewer:self）。
// SSH 通道拿不到自己的 account id，靠查询来源判断身份反而更准。
function toCell(change, context = {}) {
  const selfId = context.selfId ?? null;
  const cr = labelScore(change, 'Code-Review', selfId);
  const verified = labelScore(change, 'Verified', selfId);
  const owner = change.owner || {};
  const role = context.role || null;
  const isMine = role ? role === 'owner' : (selfId !== null && owner._account_id === selfId);
  const needsReview = role === 'reviewer'
    ? (change.status === 'NEW' && cr.max !== 2)
    : (!isMine && change.status === 'NEW'
      && (cr.mine === null || cr.mine > -1) && (cr.mine === null || cr.mine < 2));
  const revision = change.revisions?.[change.current_revision];
  const tone = toneFor(change, cr, verified, needsReview);
  const number = change._number;
  const base = context.server || '';
  return {
    id: `${base}|${number}`,
    number,
    changeId: change.change_id || change.id,
    server: base,
    project: change.project || '',
    projectShort: shortProject(change.project),
    branch: change.branch || '',
    subject: change.subject || '',
    owner: owner.name || owner.email || owner.username || '',
    isMine,
    needsReview,
    role,
    status: change.status || 'NEW',
    updated: parseGerritTime(change.updated),
    created: parseGerritTime(change.created),
    patchset: revision?._number ?? null,
    votes: { cr: cr.max, crMin: cr.min, crMine: cr.mine, verified: verified.max, verifiedMin: verified.min },
    crVoters: labelVoters(change, 'Code-Review'),
    commentCount: Array.isArray(change.messages) ? change.messages.length : 0,
    lastComment: latestComment(change.messages),
    progress: reviewProgress(change, cr),
    tone,
    color: TONE[tone],
    mark: markFor(change, cr, verified),
    label: `#${number}`,
    url: base ? `${base}/c/${encodeURIComponent(change.project || '')}/+/${number}` : '',
    events: []
  };
}

// 时间线：Gerrit 的 messages 是骨架，每一处"打分"和"上传"都在里面。
// 只取最近若干条，卡片放得下的量。
function toEvents(change, limit = 6) {
  const messages = Array.isArray(change?.messages) ? change.messages : [];
  const events = messages.map((message) => {
    const text = String(message.message || '').trim().replace(/\s+/g, ' ');
    return {
      ts: parseGerritTime(message.date),
      revision: message._revision_number ?? null,
      author: message.author?.name || '',
      text
    };
  });
  return events.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

module.exports = { MIN_ARC, TONE, labelScore, labelVoters, latestComment, markFor, parseGerritTime, reviewProgress, shortProject, toCell, toEvents };
