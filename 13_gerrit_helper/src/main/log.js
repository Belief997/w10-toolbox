'use strict';

// Windows 上 GUI 进程的 stdout 抓不到（重定向到文件也是空的），
// 所以自己写一份滚动日志到 data/app.log。排查问题只看这一个文件。

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 256 * 1024;

function createLogger(file) {
  let stream = null;
  let size = 0;

  function open() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { size = fs.statSync(file).size; } catch (_) { size = 0; }
      if (size > MAX_BYTES) { fs.renameSync(file, `${file}.1`); size = 0; }
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch (_) { stream = null; }
  }

  function write(level, message) {
    if (!stream) open();
    if (!stream) return;
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    size += line.length;
    try { stream.write(line); } catch (_) { /* 磁盘满了也不该拖死应用 */ }
  }

  return {
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    file
  };
}

module.exports = { createLogger };
