'use strict';

// 落盘日志 + 内存环形缓冲。
// 这个工具出问题的时候用户没法复现给我看，只能看日志：
// 每一步点了哪里、闸门为什么拦住、powershell 报了什么。

const fs = require('node:fs');
const path = require('node:path');

const BUFFER = 400;

function createLogger(file) {
  const buffer = [];
  let stream = null;

  function ensure() {
    if (stream) return stream;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
    return stream;
  }

  function write(level, message) {
    const line = `${new Date().toISOString().slice(11, 23)} ${level} ${message}`;
    buffer.push(line);
    if (buffer.length > BUFFER) buffer.shift();
    try { ensure().write(`${line}\n`); } catch (_) { /* 日志写不进去不影响主流程 */ }
    return line;
  }

  return {
    file,
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    // 给 /api/log 用
    tail: (count = 200) => buffer.slice(-count),
    buffer
  };
}

module.exports = { createLogger };
