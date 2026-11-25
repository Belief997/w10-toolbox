'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { currentStage, jobUrl, normalizeStages, withLiveDurations, withPending } = require('../src/main/jenkins/client');
const { toBuildCell } = require('../src/shared/build');
const { diffCells, rank, sortCells } = require('../src/shared/diff');

// 真实响应的形状（数值原样保留）：负耗时这个坑
const REAL_FLOW = {
  id: '260',
  name: '#260',
  status: 'IN_PROGRESS',
  startTimeMillis: 1795519531066,
  endTimeMillis: 1795521133095,
  durationMillis: 1602029,
  stages: [
    { id: '20', name: 'Release Patch', status: 'SUCCESS', startTimeMillis: 1795519531721, durationMillis: 1137936, pauseDurationMillis: 0 },
    { id: '49', name: 'Checkout Code', status: 'SUCCESS', startTimeMillis: 1795519537236, durationMillis: 117747, pauseDurationMillis: 0 },
    { id: '203', name: 'ReleaseBuild', status: 'SUCCESS', startTimeMillis: 1795519654988, durationMillis: -123267, pauseDurationMillis: -123267 }
  ]
};

test('jobUrl 把 folder 路径拼成 Jenkins 的 URL 形式', () => {
  assert.strictEqual(
    jobUrl('https://jks.example.com', 'ReleaseBuild~Demo~boardX~Arbitrary'),
    // ~ 是 URL 非保留字符，encodeURIComponent 不会转义它
    'https://jks.example.com/job/ReleaseBuild~Demo~boardX~Arbitrary'
  );
  assert.strictEqual(
    jobUrl('https://jks.example.com', 'folder/sub/job'),
    'https://jks.example.com/job/folder/job/sub/job/job'
  );
});

test('normalizeStages 把负耗时标成时钟不同步', () => {
  const stages = normalizeStages(REAL_FLOW.stages);
  assert.strictEqual(stages.length, 3);
  const release = stages[2];
  assert.strictEqual(release.name, 'ReleaseBuild');
  assert.strictEqual(release.durationMs, 0, '负耗时被夹到 0');
  assert.strictEqual(release.clockSkew, true, '并且标记出来');
  assert.strictEqual(stages[1].clockSkew, false);
});

test('currentStage 认得出等待人工确认', () => {
  const paused = currentStage(normalizeStages([
    { name: 'Build', status: 'SUCCESS', durationMillis: 10 },
    { name: 'Approve', status: 'PAUSED_PENDING_INPUT', durationMillis: 0 }
  ]));
  assert.strictEqual(paused.state, 'paused');
  assert.strictEqual(paused.stage.name, 'Approve');
});

test('currentStage 全 SUCCESS 时落到最后一个 stage', () => {
  const current = currentStage(normalizeStages(REAL_FLOW.stages));
  assert.strictEqual(current.state, 'done');
  assert.strictEqual(current.stage.name, 'ReleaseBuild');
});

test('toBuildCell 给出环、色、角标', () => {
  const cell = toBuildCell({
    job: 'ReleaseBuild~Demo~boardX~Arbitrary',
    url: 'https://jks/job/x',
    number: 260,
    state: 'IN_PROGRESS',
    building: true,
    startedAt: 1795519531066,
    estimated: 3747169,
    progress: 0.427,
    stages: normalizeStages(REAL_FLOW.stages),
    current: { name: 'ReleaseBuild', status: 'SUCCESS', durationMs: 0, clockSkew: true }
  }, { base: 'https://jks' });
  assert.strictEqual(cell.kind, 'build');
  assert.strictEqual(cell.id, 'build|ReleaseBuild~Demo~boardX~Arbitrary');
  assert.strictEqual(cell.label, '#260');
  assert.strictEqual(cell.progress, 43);
  assert.strictEqual(cell.mark, 'R', '当前 stage 首字母');
  assert.strictEqual(cell.color, '#8fb8f0', '在跑是蓝色');
  assert.strictEqual(cell.projectShort, 'Arbitrary', '取 job 路径最后一段');
});

test('构建失败排到最前，等确认更急', () => {
  const failed = toBuildCell({ job: 'a', number: 1, state: 'FAILURE', progress: 1, stages: [] });
  const paused = toBuildCell({ job: 'b', number: 2, state: 'PAUSED_PENDING_INPUT', progress: 0.5, stages: [] });
  const running = toBuildCell({ job: 'c', number: 3, state: 'IN_PROGRESS', progress: 0.3, stages: [] });
  const done = toBuildCell({ job: 'd', number: 4, state: 'SUCCESS', progress: 1, stages: [] });
  assert.ok(rank(paused) <= rank(failed));
  assert.ok(rank(failed) < rank(running));
  assert.ok(rank(running) < rank(done));
  assert.deepStrictEqual(
    sortCells([done, running, failed, paused]).map((cell) => cell.job).sort(),
    ['a', 'b', 'c', 'd']
  );
});

test('构建状态变化产生通知事件', () => {
  const base = { job: 'x', number: 260, url: 'https://jks/job/x', stages: [] };
  const before = [toBuildCell({ ...base, state: 'IN_PROGRESS', progress: 0.4 })];
  const after = [toBuildCell({ ...base, state: 'FAILURE', progress: 1 })];
  const events = diffCells(before, after);
  assert.strictEqual(events.length, 1);
  assert.match(events[0].text, /构建失败/);
  assert.ok(events[0].url);
});

test('构建格和 change 格混排不会互相干扰', () => {
  const build = toBuildCell({ job: 'x', number: 1, state: 'SUCCESS', progress: 1, stages: [] });
  const change = {
    id: 'g|1', number: 1, status: 'NEW', isMine: true, needsReview: false,
    votes: { cr: null, crMin: null, crMine: null, verified: null, verifiedMin: null },
    crVoters: [], commentCount: 0
  };
  assert.strictEqual(sortCells([change, build]).length, 2);
  assert.deepStrictEqual(diffCells([change, build], [change, build]), []);
});

// wfapi 只报已经进过的 stage。不补的话卡片上只有"走了几步"，看不到还剩几步。
test('还没轮到的 stage 从参照构建补齐', () => {
  const current = normalizeStages([
    { name: 'Release Patch', status: 'SUCCESS' },
    { name: 'ReleaseBuild', status: 'IN_PROGRESS' }
  ]);
  const merged = withPending(current, ['Release Patch', 'ReleaseBuild', 'Sign Image', 'Upload']);
  assert.deepStrictEqual(merged.map((s) => s.name),
    ['Release Patch', 'ReleaseBuild', 'Sign Image', 'Upload']);
  assert.strictEqual(merged[2].status, 'NOT_EXECUTED');
  assert.strictEqual(merged[2].pending, true);
  // 已有的阶段不能被补出来的覆盖
  assert.strictEqual(merged[1].status, 'IN_PROGRESS');
});

test('参照名单没覆盖到的部分不乱补', () => {
  const current = normalizeStages([{ name: 'A', status: 'SUCCESS' }]);
  assert.deepStrictEqual(withPending(current, ['A']).map((s) => s.name), ['A'], '已经到最后一步');
  assert.deepStrictEqual(withPending(current, ['X', 'Y']).map((s) => s.name), ['A'], '完全对不上就不补');
  assert.deepStrictEqual(withPending(current, []).map((s) => s.name), ['A'], '没有参照');
});

// 正在跑的那一段 durationMillis 恒为 0，不自己算的话卡片上只有个状态字符串
test('正在跑的 stage 用时按开始时间实时算', () => {
  const stages = normalizeStages([
    { name: 'A', status: 'SUCCESS', startTimeMillis: 1000, durationMillis: 5000 },
    { name: 'B', status: 'IN_PROGRESS', startTimeMillis: 6000, durationMillis: 0 }
  ]);
  const out = withLiveDurations(stages, 20000);
  assert.strictEqual(out[0].durationMs, 5000, '跑完的不动');
  assert.strictEqual(out[0].live, undefined);
  assert.strictEqual(out[1].durationMs, 14000, '已跑 14 秒');
  assert.strictEqual(out[1].live, true);
  // 没有开始时间就只能保持原样，不能瞎算
  const noStart = withLiveDurations(normalizeStages([{ name: 'C', status: 'IN_PROGRESS' }]), 20000);
  assert.strictEqual(noStart[0].durationMs, 0);
});
