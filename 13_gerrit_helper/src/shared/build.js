'use strict';

// Jenkins 构建 → 竖条上的一格。和 Gerrit change 共用同一套渲染，
// 靠 cell.kind 区分（'build' vs 默认的 change）。

const BUILD_TONE = Object.freeze({
  PAUSED_PENDING_INPUT: { color: '#e8c27a', mark: '⏸' },
  IN_PROGRESS: { color: '#8fb8f0', mark: null },
  SUCCESS: { color: '#b7ead4', mark: '✓' },
  FAILURE: { color: '#f29a8c', mark: '✕' },
  UNSTABLE: { color: '#e8c27a', mark: '!' },
  ABORTED: { color: '#6b7280', mark: '–' }
});

// 当前 stage 的首字母当角标：Build → B，Checkout Code → C
function stageMark(stage) {
  if (!stage?.name) return '·';
  const letters = String(stage.name).replace(/[^A-Za-z一-龥]/g, '');
  return letters.slice(0, 1).toUpperCase() || '·';
}

function toBuildCell(build, context = {}) {
  if (!build) return null;
  const tone = BUILD_TONE[build.state] || BUILD_TONE.IN_PROGRESS;
  const running = build.state === 'IN_PROGRESS' || build.state === 'PAUSED_PENDING_INPUT';
  // 环：在跑就是整体进度，跑完就是满
  const progress = running ? Math.round(build.progress * 100) : 100;
  return {
    kind: 'build',
    id: `build|${build.job}`,
    job: build.job,
    // 卡片和通知都靠它
    url: build.url,
    number: build.number,
    state: build.state,
    building: build.building,
    status: build.state,
    projectShort: String(build.job || '').split('~').pop(),
    subject: build.current
      ? `${build.current.name} · ${build.current.status}`
      : (build.state === 'IN_PROGRESS' ? '排队中' : build.state),
    // 和 Gerrit cell 对齐的公共字段，渲染层不用分支
    updated: build.startedAt || Date.now(),
    progress: Math.max(8, Math.min(100, progress)),
    tone: build.state === 'SUCCESS' ? 'ready'
      : build.state === 'PAUSED_PENDING_INPUT' ? 'pending'
        : build.state === 'IN_PROGRESS' ? 'normal'
          : build.state === 'SUCCESS' ? 'ready' : 'bad',
    color: tone.color,
    mark: tone.mark || stageMark(build.current),
    label: `#${build.number}`,
    stages: build.stages,
    estimated: build.estimated,
    server: context.base || ''
  };
}

module.exports = { BUILD_TONE, stageMark, toBuildCell };
