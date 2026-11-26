'use strict';

// 把"三个锚点 + 文案"展开成动作序列。纯函数，好测。
//
// 动作只有四种：
//   click  —— 点到锚点（相对窗口左上角）
//   paste  —— 剪贴板换内容 + Ctrl+V
//   wait   —— 等界面反应
//   key    —— 单键（enter / ^enter）

const DEFAULT_WAITS = {
  afterSearchClick: 500,   // 点搜索栏 → 光标进输入框
  afterQuery: 2000,        // 打出关键词 → 联想结果出来
  afterOpen: 2000,         // 点开对话 → 会话渲染完
  beforeSend: 300          // 粘贴完 → 再回车，给输入框一点时间
};

function buildPlan({ anchors, query, body, waits = {}, sendKeys = ['enter', '^enter'] } = {}) {
  if (!anchors || !anchors.search || !anchors.result || !anchors.input) {
    throw new Error('缺锚点：需要 search / result / input 三个相对坐标');
  }
  const w = { ...DEFAULT_WAITS, ...waits };
  const plan = [
    { type: 'click', rel: anchors.search, name: 'search' },
    { type: 'wait', ms: w.afterSearchClick },
    { type: 'paste', text: String(query) },
    { type: 'wait', ms: w.afterQuery },
    { type: 'click', rel: anchors.result, name: 'result' },
    { type: 'wait', ms: w.afterOpen },
    { type: 'click', rel: anchors.input, name: 'input' },
    { type: 'paste', text: String(body) },
    { type: 'wait', ms: w.beforeSend }
  ];
  for (const key of sendKeys) plan.push({ type: 'key', key });
  return plan;
}

// 录制结果里按顺序取前三个 click 当锚点：搜索栏 / 结果行 / 输入栏
function anchorsFromRecording(recorded) {
  const clicks = (recorded?.steps || []).filter((step) => step.type === 'click');
  if (clicks.length < 3) {
    throw new Error(`录到的点击只有 ${clicks.length} 次，至少需要 3 次（搜索栏 / 结果行 / 输入栏）`);
  }
  const [search, result, input] = clicks;
  return {
    search: { x: search.rel.x, y: search.rel.y },
    result: { x: result.rel.x, y: result.rel.y },
    input: { x: input.rel.x, y: input.rel.y }
  };
}

function describe(plan) {
  return plan.map((step) => {
    if (step.type === 'click') return `点 ${step.name} (${step.rel.x},${step.rel.y})`;
    if (step.type === 'paste') return `粘贴 ${JSON.stringify(step.text.length > 20 ? `${step.text.slice(0, 20)}…` : step.text)}`;
    if (step.type === 'wait') return `等 ${step.ms}ms`;
    return `按键 ${step.key}`;
  });
}


// ---- 通用动作 -----------------------------------------------------------
// 编辑器里能插入/修改任意动作，所以这些是造动作的工厂，不预设流程。

const ACTION_TYPES = ['click', 'paste', 'wait', 'key'];

function createAction(type) {
  if (type === 'click') return { type: 'click', name: '', rel: { x: 0, y: 0 }, recorded: false, break: false };
  if (type === 'paste') return { type: 'paste', text: '' };
  if (type === 'wait') return { type: 'wait', ms: 500 };
  if (type === 'key') return { type: 'key', key: 'enter' };
  throw new Error(`未知动作类型：${type}`);
}

// 把任意动作列表收敛成 player 认识的样子（丢掉脏数据，不抛错）
function normalizeActions(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((step) => step && ACTION_TYPES.includes(step.type)).map((step) => {
    if (step.type === 'click') {
      const rel = step.rel || {};
      const x = Number.isFinite(Number(rel.x)) ? Math.round(Number(rel.x)) : 0;
      const y = Number.isFinite(Number(rel.y)) ? Math.round(Number(rel.y)) : 0;
      return { type: 'click', name: String(step.name || ''), rel: { x, y }, recorded: Boolean(step.recorded), break: Boolean(step.break) };
    }
    if (step.type === 'paste') return { type: 'paste', text: String(step.text ?? ''), break: Boolean(step.break) };
    if (step.type === 'wait') return { type: 'wait', ms: Math.max(0, Math.min(60000, Math.round(Number(step.ms) || 0))), break: Boolean(step.break) };
    return { type: 'key', key: String(step.key || 'enter'), break: Boolean(step.break) };
  });
}

function toPlan(actions) {
  return normalizeActions(actions).map((step) => {
    if (step.type === 'click') return { type: 'click', rel: step.rel, name: step.name, break: step.break };
    if (step.type === 'paste') return { type: 'paste', text: step.text, break: step.break };
    if (step.type === 'wait') return { type: 'wait', ms: step.ms, break: step.break };
    return { type: 'key', key: step.key, break: step.break };
  });
}

module.exports = {
  ACTION_TYPES, DEFAULT_WAITS, anchorsFromRecording, buildPlan, createAction, describe, normalizeActions, toPlan
};
