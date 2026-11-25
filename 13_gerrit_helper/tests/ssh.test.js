'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseQueryOutput, shellQuote, sshToRestShaped } = require('../src/main/gerrit/ssh');
const { mergeRole, roleOfQuery } = require('../src/main/poller');
const { toCell } = require('../src/shared/model');

const SAMPLE = [
  {
    project: 'platform/frameworks/base',
    branch: 'main',
    id: 'I1111111111111111111111111111111111111111',
    number: 10231,
    subject: 'Fix Wi-Fi handover stall',
    owner: { name: 'Chen', email: 'chen@corp.com', username: 'chen' },
    url: 'https://gerrit.example.com/10231',
    status: 'NEW',
    lastUpdated: 1769000000,
    open: true,
    currentPatchSet: {
      number: 4,
      revision: 'abc123',
      approvals: [
        { type: 'CR', description: 'Code-Review', value: '+2', by: { name: 'Lin', username: 'lin' } },
        { type: 'VRIF', description: 'Verified', value: '-1', by: { name: 'ci-bot', username: 'ci' } }
      ]
    },
    comments: [
      { timestamp: 1769000100, reviewer: { name: 'Lin' }, message: 'LGTM' },
      { timestamp: 1768999000, reviewer: { name: 'ci-bot' }, message: 'Build failed' }
    ]
  }
].map((entry) => JSON.stringify(entry)).join('\n')
  + '\n{"type":"stats","rowCount":1,"runTimeMilliseconds":18}\n';

test('parseQueryOutput 丢掉 stats 行', () => {
  const { changes, stats } = parseQueryOutput(SAMPLE);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].number, 10231);
  assert.strictEqual(stats.rowCount, 1);
});

test('parseQueryOutput 遇到 error 行直接抛', () => {
  assert.throws(
    () => parseQueryOutput('{"type":"error","message":"not signed in"}\n'),
    /not signed in/
  );
});

test('sshToRestShaped 把 approvals 摊成 labels', () => {
  const shaped = sshToRestShaped(parseQueryOutput(SAMPLE).changes[0]);
  const cr = shaped.labels['Code-Review'].all;
  const vrif = shaped.labels.Verified.all;
  assert.deepStrictEqual(cr.map((vote) => vote.value), [2]);
  assert.deepStrictEqual(vrif.map((vote) => vote.value), [-1]);
  assert.strictEqual(shaped._number, 10231);
  assert.strictEqual(shaped.revisions.abc123._number, 4);
  // 时间线来自 --comments
  assert.strictEqual(shaped.messages.length, 2);
});

test('适配后的 SSH 结果能直接喂给 toCell', () => {
  const shaped = sshToRestShaped(parseQueryOutput(SAMPLE).changes[0]);
  const cell = toCell(shaped, { server: 'ssh://gerrit.example.com:29418', role: 'reviewer' });
  assert.strictEqual(cell.number, 10231);
  assert.strictEqual(cell.patchset, 4);
  assert.strictEqual(cell.mark, 'CI');      // Verified -1 优先
  assert.strictEqual(cell.tone, 'bad');     // CI 失败
  assert.strictEqual(cell.needsReview, false); // CR 已经 +2
  assert.strictEqual(cell.role, 'reviewer');
});

test('role 决定 isMine 和 needsReview', () => {
  const shaped = sshToRestShaped({
    number: 1, project: 'p', branch: 'main', subject: 's', status: 'NEW',
    owner: { username: 'chen' }, lastUpdated: 1769000000,
    currentPatchSet: { number: 1, approvals: [] }
  });
  const asOwner = toCell(shaped, { role: 'owner' });
  assert.strictEqual(asOwner.isMine, true);
  assert.strictEqual(asOwner.needsReview, false);

  const asReviewer = toCell(shaped, { role: 'reviewer' });
  assert.strictEqual(asReviewer.isMine, false);
  assert.strictEqual(asReviewer.needsReview, true);
  assert.strictEqual(asReviewer.tone, 'pending');
});

test('roleOfQuery 认得 owner:self / reviewer:self，不误判排除项', () => {
  assert.strictEqual(roleOfQuery('status:open owner:self limit:50'), 'owner');
  assert.strictEqual(roleOfQuery('reviewer:self is:open'), 'reviewer');
  assert.strictEqual(roleOfQuery('-owner:self'), null);
  assert.strictEqual(roleOfQuery('project:foo status:open'), null);
});

test('mergeRole 让 owner 优先', () => {
  assert.strictEqual(mergeRole(undefined, 'reviewer'), 'reviewer');
  assert.strictEqual(mergeRole('reviewer', 'owner'), 'owner');
  assert.strictEqual(mergeRole('owner', 'reviewer'), 'owner');
  assert.strictEqual(mergeRole('owner', null), 'owner');
});

test('shellQuote 能扛住单引号', () => {
  assert.strictEqual(shellQuote("status:open owner:self"), "'status:open owner:self'");
  assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
});
