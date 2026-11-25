'use strict';

// Jenkins 客户端。跑在主进程，和 Gerrit 一样用 net.fetch（吃系统代理）。
//
// 两个接口配合着用，各自都有坑：
//
//   /lastBuild/api/json  → building / result / estimatedDuration
//     坑：**构建中 duration 恒为 0**，进度不能拿它算
//
//   /lastBuild/wfapi/describe → stages[]（每个 stage 的名字/状态/起止/耗时）
//     坑：stage 的 durationMillis 可能是**负数** —— controller 和 agent 时钟不同步。
//        样例：ReleaseBuild status=SUCCESS durationMillis=-123267
//
// 进度只能用 (now − startTimeMillis) / estimatedDuration 算。
// 状态也可能自相矛盾：整体 IN_PROGRESS 但所有 stage 都是 SUCCESS，
// 说明还卡在 stage 之间的步骤里。

const fs = require('node:fs');
const path = require('node:path');
const { net } = require('electron');

function normalizeBase(input) {
  let text = String(input || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch (_) { return ''; }
}

// job 路径：folder 用 / 分隔，每一段单独编码（job 名里常有 ~ 和空格）
function jobUrl(base, job) {
  const parts = String(job || '').split('/').map((part) => part.trim()).filter(Boolean);
  return `${base}${parts.map((part) => `/job/${encodeURIComponent(part)}`).join('')}`;
}

// 控制台日志的地址。**一定要带具体构建号**：下载要几十秒，这中间起了新构建的话
// lastBuild 就换人了，下下来的会是别人的日志。
function consoleTextUrl(base, job, number) {
  return `${jobUrl(base, job)}/${encodeURIComponent(String(number))}/consoleText`;
}

const STAGE_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  IN_PROGRESS: 'IN_PROGRESS',
  FAILED: 'FAILED',
  UNSTABLE: 'UNSTABLE',
  ABORTED: 'ABORTED',
  PAUSED_PENDING_INPUT: 'PAUSED_PENDING_INPUT',
  NOT_EXECUTED: 'NOT_EXECUTED',
  SKIPPED: 'SKIPPED'
});

// 负耗时换成 0，同时把"这一步是不是真跑完了"记下来
function normalizeStages(stages) {
  return (Array.isArray(stages) ? stages : []).map((stage, index) => ({
    id: stage.id,
    name: stage.name || `stage ${index + 1}`,
    status: STAGE_STATUS[stage.status] || stage.status || 'UNKNOWN',
    startedAt: Number(stage.startTimeMillis) || 0,
    durationMs: Math.max(0, Number(stage.durationMillis) || 0),
    // 原始值是负的：说明 agent 时钟比 controller 慢，耗时不可信
    clockSkew: Number(stage.durationMillis) < 0
  }));
}

// wfapi 只返回**已经进过**的 stage，还没轮到的根本不在数组里 ——
// 于是卡片里只看得到"走了几步"，看不到"还剩几步"。
// 用参照构建（上一次跑完的）的 stage 名单把后面的补成 NOT_EXECUTED：
// 只补"当前最后一步之后"的那些，参照里前面有、本轮却没有的当作被跳过，不补。
function withPending(stages, referenceNames) {
  const list = Array.isArray(stages) ? stages : [];
  const names = Array.isArray(referenceNames) ? referenceNames : [];
  if (!list.length || !names.length) return list;
  const last = names.lastIndexOf(list[list.length - 1].name);
  if (last < 0) return list;
  const seen = new Set(list.map((stage) => stage.name));
  const pending = names.slice(last + 1).filter((name) => !seen.has(name));
  return [
    ...list,
    ...pending.map((name) => ({
      name,
      status: 'NOT_EXECUTED',
      pending: true,
      startedAt: 0,
      durationMs: 0,
      clockSkew: false
    }))
  ];
}

// 耗时的三个来源，优先级从高到低：
//   1. wfapi 的 durationMillis —— controller 记的，正常都是正数，直接用
//   2. 正在跑的那一段：now − startTimeMillis（durationMillis 在跑的时候恒为 0）
//   3. 负数（agent 时钟比 controller 慢，实测遇到过 −103948）：直接用会显示成负数，
//      所以拿这一段内部步骤（stageFlowNodes）的时间戳还原 —— 那些是 controller 侧的，
//      最后一步的"开始 + 耗时"减去本段开始，就是可信的实际耗时
// 三个都拿不到才显示"?"。
function withLiveDurations(stages, now = Date.now()) {
  return (stages || []).map((stage) => {
    if (stage.durationMs > 0) return stage;
    if (stage.status === 'IN_PROGRESS' || stage.status === 'PAUSED_PENDING_INPUT') {
      if (!stage.startedAt) return stage;
      return { ...stage, durationMs: Math.max(0, now - stage.startedAt), live: true };
    }
    return stage;
  });
}

// 当前在跑的那一步：优先找 IN_PROGRESS / 等待确认，其次找最后一个已完成的下一步
function currentStage(stages) {
  const paused = stages.find((stage) => stage.status === 'PAUSED_PENDING_INPUT');
  if (paused) return { stage: paused, state: 'paused' };
  const running = stages.find((stage) => stage.status === 'IN_PROGRESS');
  if (running) return { stage: running, state: 'running' };
  const failed = stages.find((stage) => stage.status === 'FAILED' || stage.status === 'UNSTABLE');
  if (failed) return { stage: failed, state: 'failed' };
  const last = stages[stages.length - 1];
  return last ? { stage: last, state: 'done' } : null;
}

function createJenkinsClient({ baseUrl, username, token, timeoutMs = 15000 }) {
  const base = normalizeBase(baseUrl);
  const auth = username
    ? `Basic ${Buffer.from(`${username}:${token || ''}`).toString('base64')}`
    : '';
  // 参照 stage 名单（每个 job 一份）：正常情况 10 分钟刷一次就够，
  // 每次构建跑完也会顺手更新 —— 那时拿到的是完整名单，最准
  const refStages = new Map();
  const REF_TTL = 10 * 60 * 1000;

  async function fetchJson(url) {
    if (!base) throw new Error('未配置 Jenkins 地址');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await net.fetch(url, {
        headers: { Accept: 'application/json', ...(auth ? { Authorization: auth } : {}) },
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') throw new Error(`超时（${timeoutMs}ms）`);
      throw new Error(`连不上 ${base}：${error.message}`);
    }
    clearTimeout(timer);
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error('认证失败：检查用户名与 API Token'), { status: response.status });
    }
    if (response.status === 404) {
      throw Object.assign(new Error('job 不存在'), { status: 404 });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // 参照构建：正在构建时 lastCompletedBuild 就是上一轮跑完的那次
  //
  // 参照要挑最"完整"的那次：lastCompletedBuild 可能是个中途被中止的构建
  // （实测某个 job：lastCompletedBuild 只有 2 步，lastSuccessfulBuild 有 11 步），
  // 所以两个都试，取 stage 最多的那份。
  async function referenceStageNames(job, root) {
    const cached = refStages.get(job);
    // 空结果只缓存一分钟：拉不到别急着定论，但也别每轮都问
    if (cached && Date.now() - cached.at < (cached.names.length ? REF_TTL : 60000)) {
      return cached.names;
    }
    let best = [];
    for (const ref of ['lastSuccessfulBuild', 'lastCompletedBuild']) {
      const flow = await fetchJson(`${root}/${ref}/wfapi/describe`).catch(() => null);
      const names = normalizeStages(flow?.stages).map((stage) => stage.name);
      if (names.length > best.length) best = names;
    }
    // 拿不到就短缓存一次，别每轮都去问
    refStages.set(job, { names: best, at: Date.now() });
    return best;
  }

  // 负数/缺失耗时：用这一段内部步骤的时间戳还原（见 withLiveDurations 的说明）。
  // 每个 (构建号, 节点) 只问一次，构建换号就清空。
  const stepFixes = new Map();
  let stepFixesBuild = 0;

  async function repairDurations(stages, root, buildNumber) {
    if (stepFixesBuild !== buildNumber) { stepFixes.clear(); stepFixesBuild = buildNumber; }
    const out = [];
    for (const stage of stages) {
      if (stage.durationMs > 0 || stage.live || !stage.startedAt || !stage.id) { out.push(stage); continue; }
      const key = String(stage.id);
      if (!stepFixes.has(key)) {
        const node = await fetchJson(
          `${root}/lastBuild/execution/node/${stage.id}/wfapi/describe`
        ).catch(() => null);
        let end = 0;
        for (const step of node?.stageFlowNodes || []) {
          const start = Number(step.startTimeMillis) || 0;
          const span = Math.max(0, Number(step.durationMillis) || 0);
          if (start) end = Math.max(end, start + span);
        }
        stepFixes.set(key, end > stage.startedAt ? end - stage.startedAt : 0);
      }
      const fixed = stepFixes.get(key);
      out.push(fixed > 0 ? { ...stage, durationMs: fixed, estimated: true } : stage);
    }
    return out;
  }

  return {
    base,

    // 控制台日志：纯文本，不是 JSON，所以不走 fetchJson。三个和状态接口不同的坑：
    //   1. **必须带具体构建号**（见 consoleTextUrl）
    //   2. 构建中也拿得到 —— 返回的是到目前为止的全文，末尾那行可能是半截
    //   3. 大构建几十 MB：不能整块 .text() 进内存，流式写盘；
    //      超时按"多久没收到新数据"算，不是总时长（总时长说不准）
    async downloadConsole({ job, number, destFile, idleTimeoutMs = 30000 }) {
      if (!base) throw new Error('未配置 Jenkins 地址');
      const buildNumber = Number(number);
      if (!Number.isInteger(buildNumber) || buildNumber <= 0) throw new Error('构建号无效');
      if (!destFile) throw new Error('没给目标文件');
      const url = consoleTextUrl(base, job, buildNumber);

      const controller = new AbortController();
      let timer = null;
      const armIdle = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleTimeoutMs); };
      const started = Date.now();
      let response;
      try {
        armIdle();
        response = await net.fetch(url, {
          headers: auth ? { Authorization: auth } : {},
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        if (error.name === 'AbortError') throw new Error(`超时（${idleTimeoutMs}ms 没数据）`);
        throw new Error(`连不上 ${base}：${error.message}`);
      }
      if (response.status === 401 || response.status === 403) {
        clearTimeout(timer);
        throw Object.assign(new Error('认证失败：检查用户名与 API Token'), { status: response.status });
      }
      if (response.status === 404) {
        clearTimeout(timer);
        throw Object.assign(new Error(`构建号 ${buildNumber} 不存在`), { status: 404 });
      }
      if (!response.ok) {
        clearTimeout(timer);
        throw new Error(`HTTP ${response.status}`);
      }

      // 目录可能是第一次用（默认的 build_log 就不存在），顺手建出来
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      // 先写 .part 再改名：下到一半失败不会留下看起来完整的文件
      const temp = `${destFile}.part`;
      const out = fs.createWriteStream(temp);
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          armIdle();
          bytes += chunk.length;
          if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        }
        clearTimeout(timer);
        await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
        fs.renameSync(temp, destFile);
      } catch (error) {
        clearTimeout(timer);
        out.destroy();
        try { fs.unlinkSync(temp); } catch (_) { /* 没有就算 */ }
        if (error.name === 'AbortError') throw new Error(`下载中断：${idleTimeoutMs}ms 没收到新数据`);
        throw error;
      }
      return { url, file: destFile, bytes, ms: Date.now() - started, buildNumber };
    },

    async status(job) {
      const root = jobUrl(base, job);
      // lastBuild 可能 404（从没构建过），wfapi 也可能 404（不是 Pipeline job）
      const build = await fetchJson(
        `${root}/lastBuild/api/json?tree=number,building,result,timestamp,duration,estimatedDuration,displayName`
      ).catch((error) => {
        if (error.status === 404) return null;
        throw error;
      });
      if (!build) return null;

      const flow = await fetchJson(`${root}/lastBuild/wfapi/describe`).catch(() => null);
      const reported = normalizeStages(flow?.stages);
      // **成功**跑完的构建才有完整名单，直接当参照存下来（省一次请求，也更准）。
      // 失败/中止的构建只跑到一半 —— 拿它当参照会把"还有几步"永久抹掉。
      if (build.building !== true && build.result === 'SUCCESS') {
        const done = reported.map((stage) => stage.name);
        if (done.length && done.length >= (refStages.get(job)?.names.length || 0)) {
          refStages.set(job, { names: done, at: Date.now() });
        }
      }
      const startedAt = Number(flow?.startTimeMillis) || Number(build.timestamp) || 0;
      const estimated = Number(build.estimatedDuration) || 0;
      const building = build.building === true;
      // 时长缺失/为负的先补一轮：正在跑的换算成"已跑多久"
      const timed = await repairDurations(withLiveDurations(reported), root, build.number);
      // 还没轮到的 stage 从参照构建补 —— **跑完也要补**：失败/中止的构建只跑到一半，
      // 不补的话卡片上只有那几步，看不出整条流水线一共多少步、走到了哪儿。
      // 正常跑完时参照就是它自己，补不出东西。
      const stages = withPending(timed, await referenceStageNames(job, root));

      // 进度：(now − start) / estimatedDuration。构建中 duration 恒为 0，不能用。
      let progress = 0;
      if (building && estimated > 0 && startedAt > 0) {
        progress = Math.max(0, Math.min(1, (Date.now() - startedAt) / estimated));
      } else if (!building) {
        progress = 1;
      }

      // 当前步只看真实报上来的阶段，不能让补出来的 NOT_EXECUTED 抢了
      const current = currentStage(reported);
      let state;
      if (current?.state === 'paused') state = 'PAUSED_PENDING_INPUT';
      else if (building) state = 'IN_PROGRESS';
      else state = String(build.result || flow?.status || 'UNKNOWN');

      return {
        job,
        url: root,
        number: Number(build.number) || Number(flow?.id) || 0,
        building,
        state,
        result: build.result || null,
        startedAt,
        estimated,
        progress,
        stages,
        current: current?.stage || null,
        currentState: current?.state || null
      };
    }
  };
}

module.exports = {
  STAGE_STATUS,
  consoleTextUrl,
  createJenkinsClient,
  currentStage,
  jobUrl,
  normalizeBase,
  normalizeStages,
  withLiveDurations,
  withPending
};
