'use strict';

// 演示数据：没配服务器时（或 --demo）用它把界面跑起来。
// 轮询时会轻微扰动几个字段，方便看清数字滚动和通知。

const { parseGerritTime, toCell, toEvents } = require('../shared/model');
const { toBuildCell } = require('../shared/build');
const { sortCells } = require('../shared/diff');

let frame = 0;

function minutesAgo(minutes) {
  return parseGerritTime(new Date(Date.now() - minutes * 60000).toISOString().replace('T', ' ').replace('Z', ''));
}

function build() {
  frame += 1;
  const bump = frame % 4 === 0 ? 1 : 0;
  const base = [
    {
      _number: 10231,
      project: 'platform/frameworks/base',
      branch: 'main',
      subject: 'Fix Wi-Fi handover stall when screen turns off',
      status: 'NEW',
      owner: { _account_id: 1001, name: 'me' },
      updated: minutesAgo(4),
      current_revision: 'r4',
      revisions: { r4: { _number: 4 } },
      labels: { 'Code-Review': { all: [{ _account_id: 1003, value: 2, name: 'lin' }] } },
      messages: [
        { date: new Date(Date.now() - 4 * 60000).toISOString(), author: { name: 'lin' }, message: 'Code-Review+2 这版逻辑没问题了' },
        { date: new Date(Date.now() - 26 * 60000).toISOString(), author: { name: 'ci-bot' }, message: 'CI passed' },
        { date: new Date(Date.now() - 90 * 60000).toISOString(), author: { name: 'me' }, message: 'Uploaded patch set 4.' }
      ]
    },
    {
      _number: 10244,
      project: 'vendor/hal/camera',
      branch: 'main',
      subject: 'Handle V4L2 buffer starvation in streamoff path',
      status: 'NEW',
      owner: { _account_id: 1001, name: 'me' },
      updated: minutesAgo(12),
      current_revision: 'r2',
      revisions: { r2: { _number: 2 } },
      labels: {
        'Code-Review': { all: [{ _account_id: 1004, value: 1, name: 'wei' }] },
        Verified: { all: [{ _account_id: 900, value: -1, name: 'ci-bot' }] }
      },
      messages: [
        { date: new Date(Date.now() - 12 * 60000).toISOString(), author: { name: 'ci-bot' }, message: 'Build failed: camera.v4l2_test timeout' },
        { date: new Date(Date.now() - 55 * 60000).toISOString(), author: { name: 'wei' }, message: 'Code-Review+1 looks fine, CI is red' }
      ]
    },
    {
      _number: 10188,
      project: 'sdk/tools/gerrit-helper',
      branch: 'main',
      subject: 'Add edge dock prototype with shaped window',
      status: 'NEW',
      owner: { _account_id: 1005, name: 'chen' },
      updated: minutesAgo(1 + bump),
      current_revision: 'r1',
      revisions: { r1: { _number: 1 } },
      labels: { 'Code-Review': { all: [] } },
      messages: [
        { date: new Date(Date.now() - (1 + bump) * 60000).toISOString(), author: { name: 'chen' }, message: 'Added you as a reviewer' },
        { date: new Date(Date.now() - 9 * 60000).toISOString(), author: { name: 'chen' }, message: 'Uploaded patch set 1.' }
      ]
    },
    {
      _number: 10102,
      project: 'build/soong',
      branch: 'main',
      subject: 'Cache ninja depfile parsing across modules',
      status: 'MERGED',
      owner: { _account_id: 1001, name: 'me' },
      updated: minutesAgo(120),
      current_revision: 'r3',
      revisions: { r3: { _number: 3 } },
      labels: { 'Code-Review': { all: [{ _account_id: 1006, value: 2, name: 'zhao' }] } },
      messages: [
        { date: new Date(Date.now() - 120 * 60000).toISOString(), author: { name: 'zhao' }, message: 'Submitted, thanks!' }
      ]
    }
  ];
  // 演示用：每 4 轮改一次某条 change 的分值，触发"状态变化主动弹气泡"
  base[2].labels['Code-Review'] = {
    all: [{ _account_id: 1007, value: frame % 2 ? 1 : 2, name: 'zhou' }]
  };
  const selfId = 1001;
  // 一个假的构建格，演示模式下也能看到"SDK 打包进度"长什么样
  const build = toBuildCell({
    job: 'ReleaseBuild~Demo~boardX~Arbitrary',
    url: 'https://jks.example.com/job/ReleaseBuild~Demo~boardX~Arbitrary',
    number: 260 + (frame % 3 === 0 ? 1 : 0),
    state: 'IN_PROGRESS',
    building: true,
    startedAt: Date.now() - 1600000,
    estimated: 3747169,
    progress: Math.min(0.95, 0.35 + (frame % 20) * 0.03),
    current: { name: 'ReleaseBuild', status: 'IN_PROGRESS' },
    stages: [
      { name: 'Release Patch', status: 'SUCCESS', startedAt: 0, durationMs: 1137936, clockSkew: false },
      { name: 'Checkout Code', status: 'SUCCESS', startedAt: 0, durationMs: 117747, clockSkew: false },
      { name: 'ReleaseBuild', status: 'IN_PROGRESS', startedAt: 0, durationMs: 0, clockSkew: false },
      // 还没轮到的阶段：demonstration 用，真实数据靠参照构建补齐
      { name: 'Sign Image', status: 'NOT_EXECUTED', pending: true, startedAt: 0, durationMs: 0, clockSkew: false },
      { name: 'Upload Artifacts', status: 'NOT_EXECUTED', pending: true, startedAt: 0, durationMs: 0, clockSkew: false }
    ]
  }, { base: 'https://jks.example.com' });

  return sortCells([...base.map((change) => {
    const cell = toCell(change, { server: 'https://gerrit.example.com', selfId });
    cell.events = toEvents(change, 8);
    return cell;
  }), build]);
}

module.exports = { build };
