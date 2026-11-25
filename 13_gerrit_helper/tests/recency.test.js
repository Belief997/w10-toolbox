'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { withRecency } = require('../src/shared/recency');
const { normalize } = require('../src/shared/track');

const NOW = new Date('2026-11-24T12:00:00').getTime();

test('默认两周会追加 after:', () => {
  assert.strictEqual(withRecency('owner:self status:open', 14, NOW), 'owner:self status:open after:2026-11-10');
});

test('0 天表示不限，不加任何过滤', () => {
  assert.strictEqual(withRecency('owner:self status:open', 0, NOW), 'owner:self status:open');
  assert.strictEqual(withRecency('owner:self status:open', -1, NOW), 'owner:self status:open');
});

test('用户自己写了日期条件就不覆盖', () => {
  assert.strictEqual(withRecency('project:x after:2020-01-01', 14, NOW), 'project:x after:2020-01-01');
  assert.strictEqual(withRecency('status:open age:3d', 14, NOW), 'status:open age:3d');
});

test('不会把 message:/stage: 里的 age 误当成日期条件', () => {
  assert.strictEqual(withRecency('message:stage:foo', 7, NOW), 'message:stage:foo after:2026-11-17');
});

test('空查询原样返回', () => {
  assert.strictEqual(withRecency('', 14, NOW), '');
  assert.strictEqual(withRecency('   ', 14, NOW), '');
});

test('recentDays 配置会被收敛到 0-365', () => {
  assert.strictEqual(normalize({}).recentDays, 14, '默认两周');
  assert.strictEqual(normalize({ recentDays: 999 }).recentDays, 365);
  assert.strictEqual(normalize({ recentDays: -5 }).recentDays, 0);
  assert.strictEqual(normalize({ recentDays: 3.7 }).recentDays, 4);
  assert.strictEqual(normalize({ recentDays: 'abc' }).recentDays, 14);
});
