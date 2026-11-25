'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseGerritTime, toCell, toEvents } = require('../src/shared/model');
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
  assert.ok(cell.url.endsWith('/c/platform%2Fframeworks%2Fbase/+/1234'));
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

test('jenkins.logDir 默认空串（= 程序目录下的 build_log），原样保留用户填的路径', () => {
  assert.strictEqual(normalize({}).jenkins.logDir, '', '默认留空');
  assert.strictEqual(
    normalize({ jenkins: { url: 'x', logDir: '  D:\\logs  ' } }).jenkins.logDir,
    'D:\\logs', '去掉首尾空白'
  );
  // 旧配置没有这个字段时不能因为 undefined 变成字符串 "undefined"
  assert.strictEqual(normalize({ jenkins: { url: 'x' } }).jenkins.logDir, '');
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
