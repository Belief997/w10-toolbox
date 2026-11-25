'use strict';

// 调 PowerShell 脚本的薄封装：一次动作一个进程（Windows PowerShell 5.1），
// 返回它打印的最后一行 JSON。用 PowerShell 是因为截图/键鼠全是系统自带，
// 不用编译原生模块，也不引第三方依赖。

const { execFile } = require('node:child_process');
const path = require('node:path');

const WIN = path.join(__dirname, 'win.ps1');
const RECORD = path.join(__dirname, 'record.ps1');

function spawnJson(script, params, { timeoutMs = 60000, passFalse = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...params],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
        const lines = text.trim().split(/\r?\n/).filter(Boolean);
        const line = lines[lines.length - 1] || '';
        if (!line) {
          reject(new Error(`powershell 没输出：${error ? error.message : ''} ${String(stderr || '').slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.ok === false && !passFalse) reject(Object.assign(new Error(parsed.error || '未知错误'), { result: parsed }));
          else resolve({ ...parsed, lines });
        } catch (_) {
          reject(new Error(`powershell 输出不是 JSON：${line.slice(0, 200)}`));
        }
      });
    child.on('error', reject);
  });
}

function run(action, args = {}, options = {}) {
  const params = ['-Action', action];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    params.push(`-${key}`, String(value));
  }
  return spawnJson(WIN, params, options);
}

module.exports = {
  run,
  window: () => run('window'),
  // focus 的 ok:false 也是正常结果（前置失败），由调用方给出更好读的提示
  focus: () => run('focus', {}, { passFalse: true }),
  // 屏幕上某点最上面是哪个窗口（防坐标被别的窗口盖住）
  hit: (x, y) => run('hit', { X: Math.round(x), Y: Math.round(y) }),
  // verify 的 ok:false 是正常结果（前台不是微信），不当异常抛
  verify: () => run('verify', {}, { passFalse: true }),
  key: (chord) => run('key', { Text: chord }),
  click: (x, y) => run('click', { X: Math.round(x), Y: Math.round(y) }),
  clip: (text) => run('clip', { Text: text }),
  shot: (file) => run('shot', { Out: file }),
  // 等用户在微信里点一下，返回相对窗口的坐标
  recordOnce: (timeoutSec = 60) => spawnJson(RECORD,
    ['-Mode', 'single', '-MaxClicks', '1', '-TimeoutSec', String(timeoutSec)],
    { timeoutMs: (timeoutSec + 10) * 1000 }),
  // 整段录制：点/粘贴/回车/停顿按顺序记下来，Esc 结束
  recordSession: (out, timeoutSec = 120) => spawnJson(RECORD,
    ['-Mode', 'session', '-Out', out, '-TimeoutSec', String(timeoutSec)],
    { timeoutMs: (timeoutSec + 20) * 1000 })
};
