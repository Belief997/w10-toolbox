'use strict';

// 回放：把动作序列打到微信窗口上。
//
// 两道闸，每次点击前都查：
//   1. 前台窗口是不是微信        —— 焦点被抢就中止
//   2. 那个坐标上最顶层是不是微信 —— 有别的窗口盖着就中止（实测被 Teams 盖过）
// 每一步都写日志，失败时能直接看出是闸门拦住，还是 powershell 报错。

const ps = require('./ps');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function play(plan, { dryRun = false, log = () => {}, strict = true, logger = null, checkpoint = null } = {}) {
  const emit = (message) => { log(message); logger?.info(message); };

  const win = await ps.focus();
  if (!win.ok) {
    const error = new Error('微信窗口没能前置（被别的窗口抢走，或客户端被锁）');
    logger?.error(error.message);
    throw error;
  }
  const origin = { left: win.rect.left, top: win.rect.top };
  emit(`窗口原点 ${origin.left},${origin.top} ${win.rect.width}x${win.rect.height} hwnd=${win.hwnd}`);

  let index = 0;
  let aborted = false;
  for (const step of plan) {
    index += 1;
    const label = `#${index} ${step.type}${step.name ? `(${step.name})` : ''}`;

    // 断点：执行这一步之前停下来等人放行（调试用，尤其坐标还没调准时）
    if (step.break && checkpoint) {
      const action = await checkpoint(index, step);
      if (action === 'abort') { aborted = true; emit(`断点中止于第 ${index} 步，后面 ${plan.length - index} 步没跑`); break; }
    }

    if (step.type === 'key' && dryRun) {
      emit(`${label} 演练跳过按键 ${step.key}`);
      continue;
    }
    if (step.type === 'wait') {
      await sleep(step.ms);
      emit(`${label} 等 ${step.ms}ms`);
      continue;
    }

    const guard = await ps.verify();
    if (!guard.ok) {
      const error = new Error(`微信不在前台（前台 hwnd=${guard.foreground}，微信 hwnd=${guard.hwnd}），中止`);
      logger?.error(`${label} ${error.message}`);
      if (strict) throw error;
      emit(error.message);
      break;
    }

    if (step.type === 'click') {
      const x = origin.left + step.rel.x;
      const y = origin.top + step.rel.y;
      const hit = await ps.hit(x, y);
      if (!hit.isWeChat) {
        const error = new Error(`${x},${y} 上盖着别的窗口（hwnd=${hit.hwnd} pid=${hit.pid}，微信 pid=${hit.wechatPid}），中止`);
        logger?.error(`${label} ${error.message}`);
        if (strict) throw error;
        emit(error.message);
        break;
      }
      emit(`${label} 点 → 屏幕 ${x},${y}（相对 ${step.rel.x},${step.rel.y}）`);
      await ps.click(x, y);
    } else if (step.type === 'paste') {
      emit(`${label} 粘贴 ${step.text.length} 字 ${JSON.stringify(step.text.slice(0, 24))}`);
      await ps.clip(step.text);
      await ps.key('^v');
    } else if (step.type === 'key') {
      emit(`${label} 按键 ${step.key}`);
      await ps.key(step.key);
    }
  }
  if (aborted) emit('已按断点中止');
  else emit(`完成${dryRun ? '（演练，没有回车发送）' : ''}`);
  return { played: true, dryRun, aborted, steps: index };
}

// 发一条消息：读录制结果 → 展开 → 回放
async function send(body, { recorded, dryRun = false, query = '文件传输助手', waits = {}, log = () => {}, logger = null } = {}) {
  const { anchorsFromRecording, buildPlan, describe } = require('./steps');
  const anchors = anchorsFromRecording(recorded);
  const plan = buildPlan({ anchors, query, body, waits });
  log(`动作序列：\n  ${describe(plan).join('\n  ')}`);
  return play(plan, { dryRun, log, logger });
}

module.exports = { play, send };
