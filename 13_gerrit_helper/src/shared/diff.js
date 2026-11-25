'use strict';

// 两轮快照的差异 → 事件流。纯函数：给两个 cells 数组，返回该提醒的变更。
//
// 第一条规则：previous 为 null 时只建基线，不产生任何事件。
// 否则"打开工具的一瞬间"会把所有在途 change 全弹一遍。

const EVENT_TEXT = {
  cr: (cell, from, to) => {
    if (to === null) return `${cell.projectShort} #${cell.number} Code-Review 撤销`;
    return `${cell.projectShort} #${cell.number} Code-Review ${from === null ? '' : `${from} → `}${to > 0 ? `+${to}` : to}`;
  },
  ci: (cell, from, to) => (to < 0
    ? `${cell.projectShort} #${cell.number} CI 失败`
    : `${cell.projectShort} #${cell.number} CI 恢复`),
  status: (cell, from, to) => ({
    MERGED: `${cell.projectShort} #${cell.number} 已提交`,
    ABANDONED: `${cell.projectShort} #${cell.number} 已放弃`
  }[to] || `${cell.projectShort} #${cell.number} ${from} → ${to}`),
  patchset: (cell, from, to) => `${cell.projectShort} #${cell.number} 上传 patch set ${to}`
};

function diffCells(previous, next) {
  if (!previous) return [];
  const events = [];
  const before = new Map(previous.map((cell) => [cell.id, cell]));

  for (const cell of next) {
    const prev = before.get(cell.id);
    if (!prev) {
      // 新加进来的跟踪项：首轮不给通知，加进来的动作是用户自己做的
      continue;
    }
    const push = (type, from, to, key, text) => {
      events.push({
        id: `${cell.id}:${type}:${key}`,
        cellId: cell.id,
        type,
        from,
        to,
        ts: Date.now(),
        text: text || EVENT_TEXT[type](cell, from, to),
        url: cell.url,
        // 上传 patch set 和普通评论不进聚合通知的正文，太吵
        urgent: type !== 'patchset' && type !== 'comment'
      });
    };

    // 构建格只看状态迁移，没有 patchset / 投票这些字段
    if (cell.kind === 'build') {
      if (prev.state !== cell.state) {
        const name = `${cell.projectShort} #${cell.number}`;
        const text = cell.state === 'PAUSED_PENDING_INPUT' ? `${name} 卡在等待人工确认`
          : cell.state === 'FAILURE' ? `${name} 构建失败`
            : cell.state === 'SUCCESS' ? `${name} 构建成功`
              : cell.state === 'IN_PROGRESS' ? `${name} 开始构建`
                : `${name} ${cell.state}`;
        push('status', prev.state, cell.state, cell.state, text);
      }
      continue;
    }

    if (prev.status !== cell.status) push('status', prev.status, cell.status, cell.status);
    if (prev.patchset !== cell.patchset && cell.patchset !== null) {
      push('patchset', prev.patchset, cell.patchset, cell.patchset);
    }
    if (prev.votes.cr !== cell.votes.cr) push('cr', prev.votes.cr, cell.votes.cr, cell.votes.cr);
    // 新的 reviewer 参与：有人投票了，即使最高分没变也算"有动态"。
    // 例子：两个人各给 +1，cr.max 一直是 1，但确实多了一个人在看。
    const votersBefore = prev.crVoters || [];
    const addedVoters = (cell.crVoters || []).filter((name) => !votersBefore.includes(name));
    if (addedVoters.length) {
      push('review', votersBefore.length, (cell.crVoters || []).length, addedVoters.join(','),
        `${cell.projectShort} #${cell.number} · ${addedVoters.join('、')} 参与了评审`);
    }

    // 新评论。--comments 只给当前 patch set，换 patch set 后计数会回落，
    // 所以这里只认"变多"，不认"变少"。
    if ((cell.commentCount || 0) > (prev.commentCount || 0)) {
      const who = cell.lastComment?.author ? `${cell.lastComment.author}：` : '';
      const snippet = cell.lastComment?.text ? `「${cell.lastComment.text}」` : '';
      push('comment', prev.commentCount || 0, cell.commentCount, cell.commentCount,
        `${cell.projectShort} #${cell.number} · 新评论 ${who}${snippet}`);
    }

    // CI 只在"翻负"和"从负恢复"时提醒，±1 之间的抖动不值得弹窗
    const wasBad = prev.votes.verifiedMin !== null && prev.votes.verifiedMin < 0;
    const isBad = cell.votes.verifiedMin !== null && cell.votes.verifiedMin < 0;
    if (wasBad !== isBad) push('ci', wasBad ? -1 : 1, isBad ? -1 : 1, isBad ? 'bad' : 'ok');
  }

  // 被取消跟踪的项静默消失，不发事件
  return events;
}

// 竖条的排序：越需要人动手的越靠上。
// 6 档，同档按更新时间倒序。
const PRIORITY = Object.freeze({ ciFailed: 0, needsReview: 1, readyToSubmit: 2, mine: 3, waiting: 4, dropped: 5 });

function rank(cell) {
  // 构建格：等人工确认和失败最急，跑着的中等，跑完的沉底
  if (cell.kind === 'build') {
    if (cell.state === 'PAUSED_PENDING_INPUT') return PRIORITY.ciFailed;
    if (cell.state === 'FAILURE' || cell.state === 'UNSTABLE') return PRIORITY.ciFailed;
    if (cell.state === 'IN_PROGRESS') return PRIORITY.mine;
    return PRIORITY.dropped;
  }
  if (cell.status === 'ABANDONED') return PRIORITY.dropped;
  if (cell.votes.verifiedMin !== null && cell.votes.verifiedMin < 0) return PRIORITY.ciFailed;
  if (cell.needsReview) return PRIORITY.needsReview;
  if (cell.isMine && cell.votes.cr === 2) return PRIORITY.readyToSubmit;
  if (cell.isMine) return PRIORITY.mine;
  return PRIORITY.waiting;
}

// urgency：越需要人动手的越靠上（默认）
// recent ：纯粹按最后更新时间倒序 —— 想看"我刚推的那条"就用这个
const SORT_MODES = Object.freeze(['urgency', 'recent']);

function sortCells(cells, mode = 'urgency') {
  const list = [...cells];
  if (mode === 'recent') return list.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return list.sort((a, b) => {
    const delta = rank(a) - rank(b);
    if (delta !== 0) return delta;
    return (b.updated || 0) - (a.updated || 0);
  });
}

module.exports = { PRIORITY, SORT_MODES, diffCells, rank, sortCells };
