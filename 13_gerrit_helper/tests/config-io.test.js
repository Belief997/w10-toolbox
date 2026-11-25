'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sanitizeImport, summarize, toExportable } = require('../src/shared/config-io');
const { normalize } = require('../src/shared/track');

const SAMPLE = {
  server: 'https://gerrit.example.com',
  username: 'alice',
  password: 'HTTP-PASS',
  jenkinsToken: 'API-TOKEN',
  secret: 'ENCRYPTED-BLOB',
  track: [{ kind: 'query', ref: 'owner:self status:open' }],
  jenkins: { url: 'https://jks.example.com', username: 'alice', jobs: ['ReleaseBuild~x'] },
  glassAlpha: 55,
  mode: 'always'
};

test('导出文件里绝不含任何凭据', () => {
  const exported = toExportable(SAMPLE, { now: () => '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(exported.password, undefined);
  assert.strictEqual(exported.jenkinsToken, undefined);
  assert.strictEqual(exported.secret, undefined);
  const text = JSON.stringify(exported);
  assert.ok(!text.includes('HTTP-PASS'));
  assert.ok(!text.includes('API-TOKEN'));
  assert.ok(!text.includes('ENCRYPTED-BLOB'));
});

test('导出文件带版本和来源标记', () => {
  const exported = toExportable(SAMPLE, { now: () => '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(exported._app, 'gerrit-helper');
  assert.strictEqual(exported._version, 1);
  assert.strictEqual(exported._exportedAt, '2026-01-01T00:00:00.000Z');
});

test('导出保留业务配置', () => {
  const exported = toExportable(SAMPLE);
  assert.strictEqual(exported.server, SAMPLE.server);
  assert.strictEqual(exported.glassAlpha, 55);
  assert.deepStrictEqual(exported.jenkins.jobs, ['ReleaseBuild~x']);
});

test('导入时丢弃文件里的凭据与元信息', () => {
  const clean = sanitizeImport(SAMPLE);
  assert.strictEqual(clean.password, undefined);
  assert.strictEqual(clean.jenkinsToken, undefined);
  assert.strictEqual(clean.secret, undefined);
  assert.strictEqual(clean._app, undefined);
  assert.strictEqual(clean.server, SAMPLE.server);
});

test('导入非法内容会报错', () => {
  assert.throws(() => sanitizeImport(null), /不是一个配置对象/);
  assert.throws(() => sanitizeImport([1, 2]), /不是一个配置对象/);
  assert.throws(() => sanitizeImport('x'), /不是一个配置对象/);
});

test('导入的配置能被 normalize 收敛', () => {
  const config = normalize(sanitizeImport({ ...SAMPLE, glassAlpha: 999, mode: '胡说' }));
  assert.strictEqual(config.glassAlpha, 100, '越界值被夹回');
  assert.strictEqual(config.mode, 'always');
  assert.strictEqual(config.password, undefined, '凭据没被带进来');
});

test('导入摘要给人看', () => {
  const summary = summarize(SAMPLE);
  assert.match(summary, /gerrit\.example\.com/);
  assert.match(summary, /1 个跟踪项/);
  assert.match(summary, /1 个构建 job/);
});
