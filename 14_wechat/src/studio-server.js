'use strict';

// 本地小服务：给流程图编辑器当后端。
// 用 http + 静态页而不是 Electron —— 这个工具只需要"点几下、跑一次"，
// 为一个编辑器再拉 100MB 运行时不合算。

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ps = require('./ps');
const { createLogger } = require('./log');
const player = require('./player');
const { readRecording } = require('./record-file');
const { buildPlan, createAction, describe, normalizeActions, toPlan } = require('./steps');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'assets', 'studio.html');
const STORE = path.join(ROOT, 'build', 'recorded.json');
// 存过的流程：一个名字一个文件。recorded.json 始终是"当前正在编辑的这一份"
const FLOWS = path.join(ROOT, 'build', 'flows');
const logger = createLogger(path.join(ROOT, 'build', 'studio.log'));

// 默认流程只是"起手式"：三个点都还没录，贴的内容是占位符。
// 录完之后它就是一份普通的动作列表，可以随便加、删、改。
const DEFAULT_STEPS = () => normalizeActions(buildPlan({
  anchors: { search: { x: 0, y: 0 }, result: { x: 0, y: 0 }, input: { x: 0, y: 0 } },
  query: '文件传输助手',
  body: '（要发送的内容）'
}));

function loadSteps() {
  if (!fs.existsSync(STORE)) return DEFAULT_STEPS();
  try {
    const data = readRecording(STORE);
    recordedWindow = data.window || null;
    const steps = normalizeActions(data.steps);
    return steps.length ? steps : DEFAULT_STEPS();
  } catch (_) {
    return DEFAULT_STEPS();
  }
}

let recordedWindow = null;

function saveSteps(steps) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify({
    savedAt: new Date().toISOString(),
    window: recordedWindow,
    steps
  }, null, 2), 'utf8');
}

// 流程名直接当文件名，所以先把路径分隔符和控制字符挡掉
function flowFile(name) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('流程名不能为空');
  if (clean.length > 60) throw new Error('流程名太长（60 字以内）');
  if (/[\\/:*?"<>|\u0000-\u001f�]/.test(clean)) {
    throw new Error('流程名里不能有 \\ / : * ? " < > | 这些字符');
  }
  if (clean.startsWith('.') || /[. ]$/.test(clean)) {
    throw new Error('流程名不能以 . 开头，也不能以 . 或空格结尾（Windows 文件名不允许）');
  }
  return path.join(FLOWS, `${clean}.json`);
}

function listFlows() {
  if (!fs.existsSync(FLOWS)) return [];
  const flows = [];
  for (const file of fs.readdirSync(FLOWS)) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -5);
    try {
      const data = readRecording(path.join(FLOWS, file));
      flows.push({ name, savedAt: data.savedAt || null, count: Array.isArray(data.steps) ? data.steps.length : 0, window: data.window || null });
    } catch (_) {
      flows.push({ name, savedAt: null, count: 0, invalid: true });
    }
  }
  return flows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
}

let steps = loadSteps();
let recording = null;      // 正在重录的步骤下标；'session' 表示整段录制中
let lastRun = null;
// 正在跑的那一次：日志实时可见，暂停时等 /api/resume 放行
let run = null;

function checkpoint(index, step) {
  return new Promise((resolve) => {
    run.pausedAt = index;
    run.pausedStep = { type: step.type, name: step.name || step.key || step.text || "" };
    logger.info("断点：暂停在第 " + index + " 步");
    run.resume = (action) => {
      run.pausedAt = null;
      run.pausedStep = null;
      run.resume = null;
      logger.info("断点：" + (action === "abort" ? "中止" : "继续"));
      resolve(action);
    };
  });
}

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/' || url.pathname === '/studio.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(PAGE));
      return;
    }

    if (url.pathname.startsWith('/api/')) logger.info(`${req.method} ${url.pathname}`);

    if (url.pathname === '/api/log') { send(res, 200, { ok: true, file: logger.file, lines: logger.tail(Number(url.searchParams.get('tail')) || 200) }); return; }

    if (url.pathname === '/api/state') {
      let win = null;
      try { win = await ps.window(); } catch (error) { win = { ok: false, error: error.message }; }
      if (win && win.rect) recordedWindow = recordedWindow || win.rect;
      send(res, 200, { ok: true, window: win, steps, recording, lastRun, recordedWindow });
      return;
    }

    if (url.pathname === '/api/save') {
      const body = await readBody(req);
      if (Array.isArray(body.steps)) { steps = normalizeActions(body.steps); saveSteps(steps); }
      send(res, 200, { ok: true, steps });
      return;
    }

    if (url.pathname === '/api/reset') {
      steps = DEFAULT_STEPS();
      saveSteps(steps);
      send(res, 200, { ok: true, steps });
      return;
    }

    // ---- 流程库：存 / 读 / 删 ----
    if (url.pathname === '/api/flows') {
      send(res, 200, { ok: true, flows: listFlows() });
      return;
    }

    if (url.pathname === '/api/flows/save') {
      const body = await readBody(req);
      try {
        const file = flowFile(body.name);
        const list = Array.isArray(body.steps) ? normalizeActions(body.steps) : steps;
        const existed = fs.existsSync(file);
        fs.mkdirSync(FLOWS, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
          savedAt: new Date().toISOString(),
          window: recordedWindow,
          steps: list
        }, null, 2), 'utf8');
        logger.info(`保存流程「${String(body.name).trim()}」${list.length} 步${existed ? '（覆盖）' : ''}`);
        send(res, 200, { ok: true, name: String(body.name).trim(), count: list.length, overwrote: existed, flows: listFlows() });
      } catch (error) {
        send(res, 400, { ok: false, error: error.message, flows: listFlows() });
      }
      return;
    }

    if (url.pathname === '/api/flows/load') {
      const body = await readBody(req);
      if (recording !== null) { send(res, 409, { ok: false, error: '正在录制，先等它结束' }); return; }
      if (run && run.active) { send(res, 409, { ok: false, error: '上一次还在跑（可能停在断点上），先继续或中止' }); return; }
      try {
        const data = readRecording(flowFile(body.name));
        const list = normalizeActions(data.steps);
        if (!list.length) throw new Error('这个流程是空的');
        steps = list;
        recordedWindow = data.window || recordedWindow;
        saveSteps(steps);   // 加载即成为"当前这份"，刷新页面也不丢
        logger.info(`加载流程「${String(body.name).trim()}」${list.length} 步`);
        send(res, 200, { ok: true, name: String(body.name).trim(), steps, window: recordedWindow });
      } catch (error) {
        send(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (url.pathname === '/api/flows/delete') {
      const body = await readBody(req);
      try {
        const file = flowFile(body.name);
        if (!fs.existsSync(file)) throw new Error('没有这个流程');
        fs.unlinkSync(file);
        logger.info(`删除流程「${String(body.name).trim()}」`);
        send(res, 200, { ok: true, flows: listFlows() });
      } catch (error) {
        send(res, 400, { ok: false, error: error.message, flows: listFlows() });
      }
      return;
    }

    if (url.pathname === '/api/insert') {
      const body = await readBody(req);
      const at = Number.isInteger(body.at) ? body.at : steps.length;
      const action = createAction(String(body.type || 'click'));
      steps.splice(Math.max(0, Math.min(steps.length, at)), 0, action);
      saveSteps(steps);
      send(res, 200, { ok: true, steps, action });
      return;
    }

    // 单独重录某一步的坐标
    if (url.pathname === '/api/record') {
      const body = await readBody(req);
      const index = Number(body.index);
      if (!Number.isInteger(index) || !steps[index] || steps[index].type !== 'click') {
        send(res, 400, { ok: false, error: 'index 不对（只有点击类动作能重录坐标）' });
        return;
      }
      if (recording !== null) { send(res, 409, { ok: false, error: '正在录制，先等它结束' }); return; }
      if (run && run.active) { send(res, 409, { ok: false, error: '上一次还在跑（可能停在断点上）' }); return; }
      recording = index;
      try {
        const result = await ps.recordOnce(60);
        steps[index] = { ...steps[index], rel: result.rel, recorded: true };
        saveSteps(steps);
        send(res, 200, { ok: true, index, rel: result.rel, steps });
      } catch (error) {
        logger.error(`record 失败：${error.message}`);
        send(res, 500, { ok: false, error: error.message, steps });
      } finally {
        recording = null;
      }
      return;
    }

    // 整段录制：你在微信里随便操作，点/粘贴/回车/停顿都会按顺序记下来
    if (url.pathname === '/api/record-session') {
      if (recording !== null) { send(res, 409, { ok: false, error: '正在录制，先等它结束' }); return; }
      recording = 'session';
      try {
        const result = await ps.recordSession(STORE, 120);
        const recorded = readRecording(STORE);
        recordedWindow = recorded.window || null;
        steps = normalizeActions(recorded.steps || []);
        saveSteps(steps);
        send(res, 200, { ok: true, steps, count: steps.length, window: recorded.window });
      } catch (error) {
        logger.error(`record-session 失败：${error.message}`);
        send(res, 500, { ok: false, error: error.message, steps });
      } finally {
        recording = null;
      }
      return;
    }

    if (url.pathname === '/api/play' || url.pathname === '/api/send') {
      const dryRun = url.pathname === '/api/play';
      if (recording !== null) { send(res, 409, { ok: false, error: '正在录制，先等它结束' }); return; }
      if (run && run.active) { send(res, 409, { ok: false, error: '上一次还在跑（可能停在断点上），先继续或中止' }); return; }
      const logs = [];
      const log = (line) => { logs.push(line); };
      run = { active: true, pausedAt: null, pausedStep: null, resume: null, logs };
      try {
        const result = await player.play(toPlan(steps), { dryRun, log, logger, checkpoint });
        run.active = false;
        lastRun = { at: new Date().toISOString(), dryRun, ok: true, logs };
        send(res, 200, { ok: true, dryRun, logs, result });
      } catch (error) {
        if (run) run.active = false;
        logger.error(`play 失败：${error.message}`);
        lastRun = { at: new Date().toISOString(), dryRun, ok: false, logs, error: error.message };
        send(res, 500, { ok: false, error: error.message, logs });
      }
      return;
    }

    if (url.pathname === '/api/progress') {
      send(res, 200, {
        ok: true,
        active: Boolean(run && run.active),
        pausedAt: run ? run.pausedAt : null,
        pausedStep: run ? run.pausedStep : null,
        logs: run ? run.logs : []
      });
      return;
    }

    if (url.pathname === '/api/resume' || url.pathname === '/api/abort') {
      const action = url.pathname === '/api/abort' ? 'abort' : 'continue';
      if (!run || !run.resume) { send(res, 409, { ok: false, error: '当前没有暂停' }); return; }
      run.resume(action);
      send(res, 200, { ok: true, action });
      return;
    }

    if (url.pathname === '/api/describe') {
      send(res, 200, { ok: true, lines: describe(toPlan(steps)) });
      return;
    }

    send(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    send(res, 500, { ok: false, error: error.message });
  }
});

function start(port = 0) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ port: actual, url: `http://127.0.0.1:${actual}/`, close: () => server.close() });
    });
  });
}

if (require.main === module) {
  start(Number(process.env.PORT) || 7411).then(({ url }) => {
    logger.info(`studio 启动 ${url}`);
    console.log(`[studio] ${url}`);
    console.log(`[studio] 日志：${logger.file}`);
    console.log('[studio] 打开上面的地址；Ctrl+C 退出');
  });
}

module.exports = { start };
