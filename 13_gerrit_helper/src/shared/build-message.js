'use strict';

// 构建状态 → 微信文案。纯函数，好测。
//
// 只有"跑完了"或者"卡住了"才值得发一条：IN_PROGRESS / 排队中 不发，
// 否则每轮轮询都会命中一次状态迁移。

const SEND_STATES = Object.freeze({
  SUCCESS: '构建成功',
  FAILURE: '构建失败',
  UNSTABLE: '构建不稳定',
  ABORTED: '构建中止',
  PAUSED_PENDING_INPUT: '卡在等待人工确认'
});

function shouldSendWeChat(state) {
  return Object.prototype.hasOwnProperty.call(SEND_STATES, state);
}

// 失败/卡住时把出事的那一步写出来 —— 只写"构建失败"的话还得自己去 Jenkins 翻
function blameStage(cell) {
  const stages = Array.isArray(cell?.stages) ? cell.stages : [];
  const bad = stages.find((stage) => ['FAILED', 'UNSTABLE', 'PAUSED_PENDING_INPUT'].includes(stage.status));
  if (bad) return bad.name;
  const last = stages.filter((stage) => !stage.pending).pop();
  return last ? last.name : '';
}

function buildMessageText(cell, state) {
  const title = SEND_STATES[state] || String(state);
  const job = String(cell?.job || '');
  // job 名形如 ReleaseBuild~HoneyComb~bb2Ultra~Acut：只留最后两段当标题，
  // 全名放在第二行（竖条上那种只取最后一段的写法，在消息里看不出是哪个板子）
  const parts = job.split('~').filter(Boolean);
  const short = parts.slice(-2).join('~') || job;
  const lines = [
    `【${title}】${short} #${cell?.number ?? '?'}`,
    job
  ];
  const stage = blameStage(cell);
  if (stage && state !== 'SUCCESS') lines.push(`出事的步骤：${stage}`);
  if (cell?.url) lines.push(String(cell.url));
  return lines.filter(Boolean).join('\n');
}

module.exports = { SEND_STATES, blameStage, buildMessageText, shouldSendWeChat };
