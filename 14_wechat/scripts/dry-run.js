'use strict';

// 演练：完整走一遍（点搜索栏 → 粘贴关键词 → 点结果 → 点输入栏 → 粘贴正文），
// 但**不回车上发**。用来确认三处坐标是对的。

const fs = require('node:fs');
const path = require('node:path');
const player = require('../src/player');

const recordedPath = path.join(__dirname, '..', 'build', 'recorded.json');
if (!fs.existsSync(recordedPath)) {
  console.log(`没有录制文件：${recordedPath}\n先跑 npm run record`);
  process.exit(1);
}
const recorded = JSON.parse(fs.readFileSync(recordedPath, 'utf8'));

player.send('（演练内容，不会发送）', { recorded, dryRun: true, log: (m) => console.log(`[dry-run] ${m}`) })
  .then(() => console.log('[dry-run] 完成'))
  .catch((error) => {
    console.log(`[dry-run] 失败：${error.message}`);
    process.exitCode = 1;
  });
