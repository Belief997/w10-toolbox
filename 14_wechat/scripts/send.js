'use strict';

// 真发一条。用法：
//   node scripts/send.js "要发送的内容"
//   node scripts/dry-run.js        （只走到粘贴，不回车上发）

const fs = require('node:fs');
const path = require('node:path');
const player = require('../src/player');

const recordedPath = path.join(__dirname, '..', 'build', 'recorded.json');
const body = process.argv.slice(2).join(' ') || `[测试] 14_wechat 发送于 ${new Date().toLocaleString('zh-CN')}`;

if (!fs.existsSync(recordedPath)) {
  console.log(`没有录制文件：${recordedPath}\n先跑 npm run record`);
  process.exit(1);
}
const recorded = JSON.parse(fs.readFileSync(recordedPath, 'utf8'));

player.send(body, { recorded, log: (m) => console.log(`[send] ${m}`) })
  .then(() => console.log('[send] 完成'))
  .catch((error) => {
    console.log(`[send] 失败：${error.message}`);
    process.exitCode = 1;
  });
