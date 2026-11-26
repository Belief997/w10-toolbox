'use strict';

// 14_wechat 的回放内核搬过来之后的适配层。
//
// player.js / steps.js / ps.js / win.ps1 是和 14_wechat/src 下的同名文件**逐字节相同**的拷贝
// （tests/wechat.test.js 里有一条一致性检查）。要改回放逻辑请改 14 那边，再拷过来 ——
// 这里只加"Gerrit Helper 需要的那个薄壳"：把一段文案塞进流程、按顺序打出去。
//
// 这里**不做**的事：录制、断点、编辑器。那些留在 14_wechat。

const fs = require('node:fs');
const player = require('./player');
const { toPlan } = require('./steps');

// 流程里**最后一处粘贴**就是要发的正文。前面那些粘贴是"文件传输助手"这种固定导航
// （14 的流程库就是这么排的：点搜索栏 → 粘贴关键词 → 点结果 → 粘贴正文 → 回车）。
// 找不到粘贴就报错，不能把空消息发出去。
function planFromFlow(steps, text) {
  const plan = toPlan(steps);
  if (!plan.length) throw new Error('流程是空的');
  let target = -1;
  for (let index = plan.length - 1; index >= 0; index -= 1) {
    if (plan[index].type === 'paste') { target = index; break; }
  }
  if (target < 0) throw new Error('流程里没有「粘贴」这一步，不知道把正文写到哪里');
  return plan.map((step, index) => (index === target ? { ...step, text: String(text) } : step));
}

// 流程文件：`{ steps: [...] }` 或者裸数组都认（和 14 的导入规则一致）
function readFlow(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const steps = Array.isArray(parsed) ? parsed : parsed?.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error(`流程文件里没有 steps：${file}`);
  return steps;
}

// 真发。会抢焦点 —— 14 的 play() 第一步就是 ps.focus()，这是它的既有行为。
async function send(text, { flow, log = () => {}, logger = null, dryRun = false } = {}) {
  if (!flow) throw new Error('没配置微信流程文件');
  const steps = readFlow(flow);
  const plan = planFromFlow(steps, text);
  return player.play(plan, { dryRun, log, logger });
}

module.exports = { planFromFlow, readFlow, send };
