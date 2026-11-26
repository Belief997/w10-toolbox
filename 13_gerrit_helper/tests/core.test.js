'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseGerritTime, toCell, toEvents, webBase } = require('../src/shared/model');
const { diffCells, sortCells, rank } = require('../src/shared/diff');
const { parseTrackLine, normalize } = require('../src/shared/track');

function change(overrides = {}) {
  return {
    _number: 1234,
    project: 'platform/frameworks/base',
    branch: 'main',
    subject: 'Something',
    status: 'NEW',
    owner: { _account_id: 1001, name: 'me' },
    updated: '2026-01-15 10:22:31.000000000',
    created: '2026-01-14 08:00:00.000000000',
    current_revision: 'r2',
    revisions: { r2: { _number: 2 } },
    labels: {},
    messages: [],
    ...overrides
  };
}

test('parseGerritTime 认得 Gerrit 的空格时间戳', () => {
  const time = parseGerritTime('2026-01-15 10:22:31.000000000');
  assert.ok(Number.isFinite(time) && time > 0);
  assert.strictEqual(new Date(time).toISOString(), '2026-01-15T10:22:31.000Z');
  assert.strictEqual(parseGerritTime(''), 0);
});

test('toCell 归一化出环、色、角标', () => {
  const cell = toCell(change({
    labels: { 'Code-Review': { all: [{ _account_id: 1002, value: 2 }] } }
  }), { server: 'https://g.example.com', selfId: 1001 });
  assert.strictEqual(cell.id, 'https://g.example.com|1234');
  assert.strictEqual(cell.patchset, 2);
  assert.strictEqual(cell.progress, 100);
  assert.strictEqual(cell.mark, '+2');
  assert.strictEqual(cell.tone, 'ready');
  // 项目名里的斜杠是路径分隔符：整体 encodeURIComponent 会变成 %2F，那条链接打不开
  assert.ok(cell.url.endsWith('/c/platform/frameworks/base/+/1234'));
});

test('toCell 认得出 CI 失败和待我评审', () => {
  const failed = toCell(change({ labels: { Verified: { all: [{ _account_id: 900, value: -1 }] } } }), { selfId: 1001 });
  assert.strictEqual(failed.tone, 'bad');
  assert.strictEqual(failed.mark, 'CI');

  const review = toCell(change({ owner: { _account_id: 2002, name: 'other' } }), { selfId: 1001 });
  assert.strictEqual(review.needsReview, true);
  assert.strictEqual(review.tone, 'pending');
});

test('toEvents 按时间倒序并截断', () => {
  const events = toEvents(change({
    messages: [
      { date: '2026-01-15 09:00:00.000000000', author: { name: 'a' }, message: 'one' },
      { date: '2026-01-15 11:00:00.000000000', author: { name: 'b' }, message: 'two' },
      { date: '2026-01-15 10:00:00.000000000', author: { name: 'c' }, message: 'three' }
    ]
  }), 2);
  assert.deepStrictEqual(events.map((event) => event.text), ['two', 'three']);
});

test('diff 首轮只建基线，不炸屏', () => {
  const cells = [toCell(change(), { selfId: 1001 })];
  assert.deepStrictEqual(diffCells(null, cells), []);
});

test('diff 认得出提交和新 patch set', () => {
  const context = { server: 'https://g.example.com', selfId: 1001 };
  const before = [toCell(change(), context)];
  const after = [toCell(change({
    status: 'MERGED',
    current_revision: 'r3',
    revisions: { r3: { _number: 3 } }
  }), context)];
  const events = diffCells(before, after);
  const types = events.map((event) => event.type).sort();
  assert.deepStrictEqual(types, ['patchset', 'status']);
  assert.ok(events.every((event) => event.url));
});

test('有新 reviewer 投票就提醒，即使最高分没变', () => {
  const context = { selfId: 1001 };
  const one = change({ labels: { 'Code-Review': { all: [{ _account_id: 7, value: 1, name: 'lin' }] } } });
  const two = change({ labels: { 'Code-Review': { all: [
    { _account_id: 7, value: 1, name: 'lin' },
    { _account_id: 8, value: 1, name: 'wei' }
  ] } } });
  const before = [toCell(one, context)];
  const after = [toCell(two, context)];
  assert.strictEqual(before[0].votes.cr, after[0].votes.cr, '最高分确实没变');
  const events = diffCells(before, after);
  const review = events.find((event) => event.type === 'review');
  assert.ok(review, '应该产生一条 review 事件');
  assert.match(review.text, /wei/);
  assert.doesNotMatch(review.text, /lin/, '只报新加入的人');
});

test('新评论产生 comment 事件并带上作者', () => {
  const context = { selfId: 1001 };
  const before = [toCell(change({ messages: [
    { date: '2026-01-15 09:00:00.000000000', author: { name: 'lin' }, message: '先看这个' }
  ] }), context)];
  const after = [toCell(change({ messages: [
    { date: '2026-01-15 09:00:00.000000000', author: { name: 'lin' }, message: '先看这个' },
    { date: '2026-01-15 11:00:00.000000000', author: { name: 'wei' }, message: '这里有个空指针' }
  ] }), context)];
  const events = diffCells(before, after);
  const comment = events.find((event) => event.type === 'comment');
  assert.ok(comment);
  assert.match(comment.text, /wei/);
  assert.match(comment.text, /空指针/);
  assert.strictEqual(comment.urgent, false, '普通评论不进聚合正文');
});

test('评论数回落（换 patch set）不触发事件', () => {
  const context = { selfId: 1001 };
  const before = [toCell(change({ messages: [
    { date: '2026-01-15 09:00:00.000000000', author: { name: 'a' }, message: 'x' },
    { date: '2026-01-15 10:00:00.000000000', author: { name: 'b' }, message: 'y' }
  ] }), context)];
  const after = [toCell(change({ messages: [] }), context)];
  assert.deepStrictEqual(diffCells(before, after).filter((e) => e.type === 'comment'), []);
});

test('diff 同一条 change 内容不变时零事件', () => {
  const cells = [toCell(change(), { selfId: 1001 })];
  assert.deepStrictEqual(diffCells(cells, cells), []);
});

test('排序把 CI 失败排最前，放弃排最后', () => {
  const failed = toCell(change({ _number: 1, labels: { Verified: { all: [{ _account_id: 9, value: -1 }] } } }), { selfId: 1001 });
  const review = toCell(change({ _number: 2, owner: { _account_id: 2002 } }), { selfId: 1001 });
  const dropped = toCell(change({ _number: 3, status: 'ABANDONED' }), { selfId: 1001 });
  const sorted = sortCells([dropped, review, failed]);
  assert.deepStrictEqual(sorted.map((cell) => cell.number), [1, 2, 3]);
  assert.ok(rank(failed) < rank(review));
});

test('recent 和 urgency 排序结果不同', () => {
  const make = (number, updated, verifiedMin = null) => ({
    id: `s|${number}`, number, updated, status: 'NEW', isMine: true, needsReview: false,
    votes: { cr: null, crMin: null, crMine: null, verified: null, verifiedMin }
  });
  // 第 1 条 CI 失败但最新；第 2 条最旧；第 3 条居中
  const cases = [make(1, 1000, -1), make(2, 3000), make(3, 2000)];
  // urgency：CI 失败的先进，剩下按时间倒序
  assert.deepStrictEqual(sortCells(cases, 'urgency').map((c) => c.number), [1, 2, 3]);
  // recent：纯时间倒序，CI 失败但最旧的那条沉底
  assert.deepStrictEqual(sortCells(cases, 'recent').map((c) => c.number), [2, 3, 1]);
});

test('跟踪行能区分 change 和查询', () => {
  assert.deepStrictEqual(parseTrackLine('10231'), { kind: 'change', ref: '10231' });
  assert.deepStrictEqual(parseTrackLine('q:reviewer:self is:open'), { kind: 'query', ref: 'reviewer:self is:open' });
  assert.deepStrictEqual(parseTrackLine('reviewer:self is:open'), { kind: 'query', ref: 'reviewer:self is:open' });
  assert.strictEqual(parseTrackLine('   '), null);
  assert.strictEqual(parseTrackLine('# 注释'), null);
});

test('jenkins.autoDownloadLog 默认开，只有显式 false 才算关', () => {
  assert.strictEqual(normalize({}).jenkins.autoDownloadLog, true, '默认开');
  assert.strictEqual(normalize({ jenkins: { url: 'x' } }).jenkins.autoDownloadLog, true, '旧配置也是开');
  assert.strictEqual(normalize({ jenkins: { autoDownloadLog: false } }).jenkins.autoDownloadLog, false);
  assert.strictEqual(normalize({ jenkins: { autoDownloadLog: 'no' } }).jenkins.autoDownloadLog, true,
    '只有布尔 false 才算关，字符串不算');
});

test('jenkins.logDir 默认空串（= 程序目录下的 build_log），原样保留用户填的路径', () => {
  assert.strictEqual(normalize({}).jenkins.logDir, '', '默认留空');
  assert.strictEqual(
    normalize({ jenkins: { url: 'x', logDir: '  D:\\logs  ' } }).jenkins.logDir,
    'D:\\logs', '去掉首尾空白'
  );
  // 旧配置没有这个字段时不能因为 undefined 变成字符串 "undefined"
  assert.strictEqual(normalize({ jenkins: { url: 'x' } }).jenkins.logDir, '');
});

test('mutedItems 去空白、丢空串', () => {
  assert.deepStrictEqual(normalize({}).mutedItems, [], '默认没有');
  assert.deepStrictEqual(
    normalize({ mutedItems: [' https://g/x|10231 ', '', '  ', 'build|Job'] }).mutedItems,
    ['https://g/x|10231', 'build|Job']
  );
  assert.deepStrictEqual(normalize({ mutedItems: 'x' }).mutedItems, [], '不是数组就当没有');
});

test('主界面按"一条 change / 一个构建"列出，不是按仓库', () => {
  const { muteKey, mutedKeySet, toHomeItem, splitItems } = require('../src/shared/home-list');
  const changeCell = {
    id: 'https://g/gerrit|10231', kind: 'change', projectShort: 'base', label: '#10231',
    subject: 'Fix Wi-Fi handover stall', patchset: 6, votes: { cr: 1 }, status: 'NEW',
    tone: 'normal', updated: 200
  };
  const pastCell = { ...changeCell, id: 'https://g/gerrit|263100', label: '#263100', status: 'MERGED', patchset: 3, updated: 100, past: true };
  const buildCell = {
    id: 'build|ReleaseBuild~x', kind: 'build', job: 'ReleaseBuild~x', label: '#268',
    subject: 'ReleaseBuild · FAILURE', state: 'FAILURE', tone: 'bad', updated: 300
  };
  // 名单里存完整 id，比对时看 key —— 服务器地址变了也不会失效
  assert.strictEqual(muteKey('https://h/gerrit|10231'), '10231');
  assert.strictEqual(muteKey('build|ReleaseBuild~x'), 'ReleaseBuild~x');
  const muted = mutedKeySet([buildCell.id]);
  const items = [changeCell, pastCell, buildCell].map((cell) => toHomeItem(cell, muted));

  assert.strictEqual(items[0].title, 'base #10231');
  assert.strictEqual(items[0].meta, 'PS 6 · CR +1 · 进行中');
  assert.strictEqual(items[1].past, true, '历史的 change 标 past，主界面压暗');
  assert.strictEqual(items[2].title, 'ReleaseBuild~x #268');
  assert.strictEqual(items[2].meta, '失败', '构建状态也走中文');
  assert.strictEqual(items[2].tracked, false, '被取消订阅的条目标未订阅');

  const groups = splitItems(items);
  assert.deepStrictEqual(groups.tracked.map((item) => item.id), [changeCell.id, pastCell.id], '历史沉到下面');
  assert.deepStrictEqual(groups.muted.map((item) => item.id), [buildCell.id]);
});

test('keepAwake 默认开（阻止休眠和息屏），只有显式 false 才算关', () => {
  assert.strictEqual(normalize({}).keepAwake, true, '默认阻止');
  assert.strictEqual(normalize({}).keepAwake, true, '旧配置没这个字段也算开');
  assert.strictEqual(normalize({ keepAwake: false }).keepAwake, false, '显式关');
  assert.strictEqual(normalize({ keepAwake: 'no' }).keepAwake, true, '字符串不算关');
});

test('wechat 默认关闭，enabled 只认 true，flow 去空白', () => {
  assert.deepStrictEqual(normalize({}).wechat, { enabled: false, flow: '' }, '默认关闭');
  assert.strictEqual(normalize({ wechat: { enabled: 'true' } }).wechat.enabled, false, '字符串不算开');
  const on = normalize({ wechat: { enabled: true, flow: '  ../14_wechat/build/recorded.json ' } });
  assert.deepStrictEqual(on.wechat, { enabled: true, flow: '../14_wechat/build/recorded.json' });
});

test('卡片链接必须是浏览器打得开的地址（SSH 通道的 base 要转成 https）', () => {
  // 走 SSH 时 client.base 是 ssh://user@host:29418 —— 直接拼链接会被 https 白名单挡掉，
  // 表现就是"在 Gerrit 打开"点了没反应
  assert.strictEqual(webBase('ssh://alice@gerrit.example.com:29418'), 'https://gerrit.example.com');
  assert.strictEqual(webBase('ssh://host:29418'), 'https://host', '没有用户名也要认');
  assert.strictEqual(webBase('https://gerrit.example.com/'), 'https://gerrit.example.com', '去掉尾斜杠');
  assert.strictEqual(webBase(''), '', '空串还是空串');
  assert.strictEqual(webBase('http://10.0.0.5:8080'), 'http://10.0.0.5:8080', 'http 原样保留');

  const cell = toCell(
    { _number: 10231, project: 'platform/frameworks/base', status: 'NEW', labels: {} },
    { server: 'ssh://alice@gerrit.example.com:29418' }
  );
  assert.strictEqual(cell.url, 'https://gerrit.example.com/c/platform/frameworks/base/+/10231');

  // 网页入口在子路径下（这台 Gerrit 是 https://host/gerrit/）时，前缀要跟着走
  const prefixed = toCell(
    { _number: 10231, project: 'platform/frameworks/base', status: 'NEW', labels: {} },
    { server: 'https://host/gerrit' }
  );
  assert.strictEqual(prefixed.url, 'https://host/gerrit/c/platform/frameworks/base/+/10231');
});

test('normalize 收敛非法配置', () => {
  const config = normalize({
    intervalSec: 5, mode: 'nope', track: ['1', 'q:owner:self'],
    position: { x: 10.6, y: 20.4 }, snap: false
  });
  assert.strictEqual(config.intervalSec, 20);
  assert.deepStrictEqual(config.position, { x: 11, y: 20, edge: null }, '坐标取整');
  assert.strictEqual(
    normalize({ position: { x: 1, y: 2, edge: 'top' } }).position.edge, 'top', '记住吸附边'
  );
  assert.strictEqual(
    normalize({ position: { x: 1, y: 2, edge: 'nope' } }).position.edge, null, '非法的边归零'
  );
  assert.strictEqual(config.snap, false);
  assert.strictEqual(normalize({}).position, null, '默认自动定位');
  assert.strictEqual(normalize({}).snap, true, '默认吸附');
  assert.strictEqual(normalize({ position: { x: 'a', y: 1 } }).position, null, '非法坐标回落');
  assert.strictEqual(config.mode, 'always');
  assert.deepStrictEqual(config.track, [
    { kind: 'change', ref: '1' },
    { kind: 'query', ref: 'owner:self' }
  ]);
});
