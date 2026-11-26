'use strict';

// 微信这条链路上"能纯函数测的部分"：流程 → 回放序列的正文替换、文案格式化、
// 以及搬过来的内核有没有和 14_wechat 走散。真的点微信不在这里做。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { planFromFlow, readFlow } = require('../src/wechat');
const { blameStage, buildMessageText, shouldSendWeChat } = require('../src/shared/build-message');

// 14 的流程库里「文件传输助手」那套的骨架：点搜索栏 → 粘贴关键词 → 点结果 → 粘贴正文 → 回车
const FLOW_STEPS = [
  { type: 'click', name: '', rel: { x: 180, y: 88 }, recorded: true },
  { type: 'paste', text: '文件传输助手' },
  { type: 'click', name: '', rel: { x: 174, y: 198 }, recorded: true },
  { type: 'paste', text: 'hello world' },
  { type: 'key', key: 'enter' }
];

test('流程里只有最后一处粘贴被换成正文，导航用的那次粘贴不动', () => {
  const plan = planFromFlow(FLOW_STEPS, '构建失败 #266');
  assert.strictEqual(plan.length, FLOW_STEPS.length);
  assert.strictEqual(plan[1].text, '文件传输助手', '搜索关键词是流程的一部分，不能被覆盖');
  assert.strictEqual(plan[3].text, '构建失败 #266');
  assert.deepStrictEqual(plan[0].rel, { x: 180, y: 88 }, '坐标原样带过去');
  assert.strictEqual(plan[4].key, 'enter');
});

test('流程里没有粘贴就报错，不发空消息', () => {
  assert.throws(() => planFromFlow([{ type: 'click', rel: { x: 1, y: 2 } }], 'x'), /没有「粘贴」/);
  assert.throws(() => planFromFlow([], 'x'), /流程是空的/);
});

test('流程文件裸数组和 {steps} 都认', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'wechat-flow-'));
  const bare = path.join(dir, 'a.json');
  const wrapped = path.join(dir, 'b.json');
  fs.writeFileSync(bare, JSON.stringify(FLOW_STEPS));
  fs.writeFileSync(wrapped, JSON.stringify({ steps: FLOW_STEPS }));
  assert.strictEqual(readFlow(bare).length, 5);
  assert.strictEqual(readFlow(wrapped).length, 5);
  assert.throws(() => {
    const empty = path.join(dir, 'c.json');
    fs.writeFileSync(empty, JSON.stringify({ steps: [] }));
    readFlow(empty);
  }, /没有 steps/);
});

const BUILD_CELL = {
  kind: 'build',
  id: 'build|ReleaseBuild~Demo~boardX~Arbitrary',
  job: 'ReleaseBuild~Demo~boardX~Arbitrary',
  number: 266,
  url: 'https://jks.example.com/job/ReleaseBuild~Demo~boardX~Arbitrary/266/',
  stages: [
    { name: 'Release Patch', status: 'SUCCESS' },
    { name: 'Checkout Code', status: 'SUCCESS' },
    { name: 'Keil Build', status: 'FAILED' }
  ]
};

test('只有跑完/卡住的状态才发，跑着的不发', () => {
  for (const state of ['SUCCESS', 'FAILURE', 'UNSTABLE', 'ABORTED', 'PAUSED_PENDING_INPUT']) {
    assert.strictEqual(shouldSendWeChat(state), true, state);
  }
  for (const state of ['IN_PROGRESS', 'QUEUED', '']) {
    assert.strictEqual(shouldSendWeChat(state), false, state);
  }
});

test('文案带上构建号、job 全名、出事的步骤和链接', () => {
  const text = buildMessageText(BUILD_CELL, 'FAILURE');
  const lines = text.split('\n');
  assert.strictEqual(lines[0], '【构建失败】boardX~Arbitrary #266');
  assert.strictEqual(lines[1], 'ReleaseBuild~Demo~boardX~Arbitrary');
  assert.strictEqual(lines[2], '出事的步骤：Keil Build', '别只写"构建失败"，还得让人知道挂在哪一步');
  assert.strictEqual(lines[3], BUILD_CELL.url);
});

test('成功时不说"出事的步骤"', () => {
  const ok = buildMessageText({ ...BUILD_CELL, stages: [{ name: 'Keil Build', status: 'SUCCESS' }] }, 'SUCCESS');
  assert.match(ok, /^【构建成功】boardX~Arbitrary #266/);
  assert.doesNotMatch(ok, /出事的步骤/);
});

test('没有失败步骤时退回最后一步，也拿不到就留空', () => {
  assert.strictEqual(blameStage({ stages: [{ name: 'A', status: 'SUCCESS' }, { name: 'B', status: 'SUCCESS' }] }), 'B');
  assert.strictEqual(blameStage({ stages: [] }), '');
  assert.strictEqual(blameStage({}), '');
});

test('搬过来的内核和 14_wechat/src 逐字节相同（改那边再拷过来，别在这边改）', () => {
  const source = path.join(__dirname, '..', '..', '14_wechat', 'src');
  // 13 单独拷出去用时没有 14，这条检查跳过
  if (!fs.existsSync(source)) return;
  for (const name of ['player.js', 'steps.js', 'ps.js', 'win.ps1']) {
    const mine = fs.readFileSync(path.join(__dirname, '..', 'src', 'wechat', name));
    const theirs = fs.readFileSync(path.join(source, name));
    assert.ok(mine.equals(theirs), `${name} 和 14_wechat/src/${name} 不一致`);
  }
  // win.ps1 必须是 UTF-8 with BOM，否则 Windows PowerShell 5.1 按 GBK 解析中文注释直接报语法错
  const bom = fs.readFileSync(path.join(__dirname, '..', 'src', 'wechat', 'win.ps1')).subarray(0, 3);
  assert.deepStrictEqual([...bom], [0xef, 0xbb, 0xbf]);
});
