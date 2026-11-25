'use strict';

// 录制：启动后在微信里依次点三下 —— 搜索栏 → 联想结果里那行「文件传输助手」→ 输入栏。
// 点够三次自动结束（或按 Esc）。

const { spawn } = require('node:child_process');
const path = require('node:path');

const out = path.join(__dirname, '..', 'build', 'recorded.json');
const script = path.join(__dirname, '..', 'src', 'record.ps1');

console.log('请在微信里依次点击：');
console.log('  1) 搜索栏');
console.log('  2) 搜索联想结果里的「文件传输助手」那一行');
console.log('  3) 底部的输入栏');
console.log('（点够 3 次自动结束，中途按 Esc 取消）\n');

const child = spawn('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', out, '-MaxClicks', '3'],
  { stdio: 'inherit' });

child.on('exit', (code) => {
  if (code === 0) console.log(`\n已保存到 ${out}，跑 npm run dry-run 验证回放。`);
  else console.log(`\n录制进程退出（code=${code}）`);
});
