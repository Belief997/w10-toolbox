'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { anchorsFromRecording, buildPlan, describe } = require('../src/steps');

const recorded = {
  window: { left: 100, top: 50, width: 1000, height: 700 },
  steps: [
    { type: 'click', index: 1, rel: { x: 400, y: 96 } },
    { type: 'click', index: 2, rel: { x: 300, y: 212 } },
    { type: 'click', index: 3, rel: { x: 700, y: 800 } }
  ]
};

test('按顺序取前三次点击当锚点', () => {
  const anchors = anchorsFromRecording(recorded);
  assert.deepStrictEqual(anchors.search, { x: 400, y: 96 });
  assert.deepStrictEqual(anchors.result, { x: 300, y: 212 });
  assert.deepStrictEqual(anchors.input, { x: 700, y: 800 });
});

test('录不够三次直接报错，不瞎猜', () => {
  assert.throws(() => anchorsFromRecording({ steps: [] }), /至少需要 3 次/);
  assert.throws(() => anchorsFromRecording({ steps: [{ type: 'click', rel: { x: 1, y: 1 } }] }), /只有 1 次/);
});

test('动作序列的顺序就是真实发送流程', () => {
  const plan = buildPlan({
    anchors: { search: { x: 1, y: 1 }, result: { x: 2, y: 2 }, input: { x: 3, y: 3 } },
    query: '文件传输助手',
    body: '构建完成 #262',
    waits: { afterQuery: 2000, afterOpen: 2000 }
  });
  assert.deepStrictEqual(plan.map((s) => s.type), [
    'click', 'wait', 'paste', 'wait', 'click', 'wait', 'click', 'paste', 'wait', 'key', 'key'
  ]);
  assert.strictEqual(plan[0].name, 'search');
  assert.strictEqual(plan[2].text, '文件传输助手');
  assert.strictEqual(plan[4].name, 'result');
  assert.strictEqual(plan[6].name, 'input');
  assert.strictEqual(plan[7].text, '构建完成 #262');
  assert.deepStrictEqual(plan.slice(9).map((s) => s.key), ['enter', '^enter'], '两种发送键都发');
});

test('两次等待确实是 2000ms（用户要求的节奏）', () => {
  const plan = buildPlan({
    anchors: { search: { x: 0, y: 0 }, result: { x: 0, y: 0 }, input: { x: 0, y: 0 } },
    query: '文件传输助手',
    body: 'x'
  });
  const waits = plan.filter((s) => s.type === 'wait').map((s) => s.ms);
  assert.ok(waits.includes(2000), `等待序列 ${waits}`);
  assert.strictEqual(waits.filter((ms) => ms === 2000).length, 2, '贴完关键词、点开对话各等 2 秒');
});

test('缺锚点要报错', () => {
  assert.throws(() => buildPlan({ anchors: { search: { x: 0, y: 0 } }, query: 'q', body: 'b' }), /缺锚点/);
});

test('describe 给人看的', () => {
  const plan = buildPlan({
    anchors: { search: { x: 400, y: 96 }, result: { x: 300, y: 212 }, input: { x: 700, y: 800 } },
    query: '文件传输助手',
    body: '构建完成'
  });
  const text = describe(plan).join(' | ');
  assert.match(text, /点 search \(400,96\)/);
  assert.match(text, /粘贴 "文件传输助手"/);
  assert.match(text, /按键 enter/);
});
