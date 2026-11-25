'use strict';

// 读录制文件。PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会带 BOM，
// 直接 JSON.parse 会炸在第一个字符上 —— 这里统一剥掉。

const fs = require('node:fs');

function readRecording(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.steps)) throw new Error('录制文件格式不对（缺 steps）');
  return data;
}

module.exports = { readRecording };
